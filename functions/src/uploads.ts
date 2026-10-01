// signUpload and confirmUpload, the two callable functions of the upload queue (docs/PLAN.md T3.2,
// T3.3; docs/ARCHITECTURE.md, "Uploads"), as plain functions of their dependencies, so that the tests
// run them against the Firestore emulator and a fake bucket. functions/src/index.ts deploys them.
//
// signUpload: the account's attempt, checked in Firestore; a URL per file that lets the browser PUT
// exactly that file, for 15 minutes; then, in one transaction, the day's quota reserved in users/{uid}
// and the intent recorded in the attempt's `upload`. confirmUpload: each file found in the bucket with
// the size signed; `doneMs` set per file, and the attempt's `upload.state` `done` once every file of
// its upload is there.
import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/https';

import {
  attemptFolder,
  objectKey,
  parseConfirmRequest,
  parseSignRequest,
  type AttemptRef,
} from './files.js';
import type { ObjectStore, SignedPut } from './object-store.js';
import { reserve, type QuotaLimits } from './quota.js';

/** How long a signed URL accepts its upload. */
export const URL_LIFETIME_MS = 15 * 60 * 1000;

export interface UploadLimits extends QuotaLimits {
  /** The largest file `signUpload` signs, in bytes. */
  readonly maxFileBytes: number;
}

/** Structured logs: a message, and fields that Cloud Logging keeps as the entry's JSON payload. */
export interface Log {
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export interface UploadDeps {
  /** Firestore through the Admin SDK: the rules do not apply to it. */
  readonly db: Firestore;
  readonly store: ObjectStore;
  readonly limits: UploadLimits;
  /** The server's clock, in ms since 1970. */
  readonly now: () => number;
  readonly log: Log;
}

/** What the functions read of a callable request: who calls, and with what. */
export interface Call {
  readonly auth?: { readonly uid: string } | null;
  readonly data: unknown;
}

/** One file of `signUpload`'s answer: PUT it to `url` with `headers`, before `expiresAt`. */
export interface SignedFile extends SignedPut {
  readonly path: string;
  /** When the URL stops accepting the upload, in ms since 1970 on the server's clock. */
  readonly expiresAt: number;
}

/** `upload.files[path]` of an attempt document: the size signed, and when its upload was confirmed. */
export interface UploadFile {
  readonly bytes: number;
  readonly doneMs: number | null;
}

/** `confirmUpload`'s answer. */
export interface ConfirmResult {
  /** The attempt's `upload.state`: `done` once every file of its upload is confirmed. */
  readonly state: 'uploading' | 'done';
  /** The files of this call, each with its `doneMs`. */
  readonly confirmed: readonly (UploadFile & { readonly path: string })[];
  /** The files of the attempt's upload (`upload.files`) not confirmed yet. */
  readonly pending: readonly string[];
}

/** A Google account's user id is 28 letters and digits; one that could not name a folder is refused. */
const UID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Signs the upload of the files of an attempt: `{sessionId, attemptIndex, files: [{path, bytes,
 * contentType}]}` → `[{path, url, headers, expiresAt}]`, in the order of `files`.
 */
export function signUpload(deps: UploadDeps, call: Call): Promise<SignedFile[]> {
  return logged(deps.log, 'signUpload', call, async (uid) => {
    const request = parseSignRequest(call.data, deps.limits.maxFileBytes);
    const refs = documents(deps.db, uid, request);
    // The attempt first, so that one that is not there (yet), or not the caller's, is said so before
    // anything is signed; the transaction below reads it again.
    const [session, attempt] = await deps.db.getAll(refs.session, refs.attempt);
    checkOwner(uid, request, session, attempt);
    const nowMs = deps.now();
    // Whole seconds, as the signatures count them, so that `expiresAt` is exactly the URLs' end.
    const signedAtMs = Math.floor(nowMs / 1000) * 1000;
    const expiresAt = signedAtMs + URL_LIFETIME_MS;
    // Signed before the quota is counted: when the bucket cannot sign (a role missing), nothing is
    // recorded or counted.
    const signed = await Promise.all(
      request.files.map(async (file): Promise<SignedFile> => {
        const object = {
          key: objectKey(uid, request, file.path),
          contentType: file.contentType,
          bytes: file.bytes,
        };
        const { url, headers } = await deps.store.signPut(object, signedAtMs, expiresAt);
        return { path: file.path, url, headers, expiresAt };
      }),
    );
    const bytes = request.files.reduce((sum, file) => sum + file.bytes, 0);
    const quota = await deps.db.runTransaction(async (transaction) => {
      const [sessionNow, attemptNow, user] = await transaction.getAll(
        refs.session,
        refs.attempt,
        refs.user,
      );
      checkOwner(uid, request, sessionNow, attemptNow);
      const stored: unknown = user.get('quota');
      const { bytesPerDay, filesPerDay } = deps.limits;
      const after = reserve(
        stored,
        nowMs,
        { bytes, files: request.files.length },
        { bytesPerDay, filesPerDay },
      );
      const upload = readUpload(attemptNow.get('upload'));
      for (const file of request.files) {
        upload.files.set(file.path, { bytes: file.bytes, doneMs: null });
      }
      transaction.set(refs.user, { quota: after }, { merge: true });
      transaction.update(refs.attempt, { upload: writeUpload(upload, 'uploading') });
      return after;
    });
    deps.log.info('signUpload: signed', {
      uid,
      sessionId: request.sessionId,
      attemptIndex: request.attemptIndex,
      provider: deps.store.provider,
      bucket: deps.store.bucket,
      files: request.files.map((file) => file.path),
      bytes,
      expiresAt,
      quota,
    });
    return signed;
  });
}

/**
 * Confirms that files signed for an attempt are in the bucket with the size signed:
 * `{sessionId, attemptIndex, files: [{path}]}` → `{state, confirmed, pending}`.
 */
export function confirmUpload(deps: UploadDeps, call: Call): Promise<ConfirmResult> {
  return logged(deps.log, 'confirmUpload', call, async (uid) => {
    const request = parseConfirmRequest(call.data);
    const refs = documents(deps.db, uid, request);
    const [session, attempt] = await deps.db.getAll(refs.session, refs.attempt);
    checkOwner(uid, request, session, attempt);
    const intent = readUpload(attempt.get('upload')).files;
    const expected = request.paths.map((path) => {
      const file = intent.get(path);
      if (file === undefined) {
        throw new HttpsError(
          'failed-precondition',
          `${path} was not signed for attempt ${attemptFolder(request.attemptIndex)} of session ` +
            `${request.sessionId}: signUpload first.`,
        );
      }
      return { path, bytes: file.bytes };
    });
    const sizes = await Promise.all(
      expected.map(({ path }) => deps.store.sizeOf(objectKey(uid, request, path))),
    );
    expected.forEach(({ path, bytes }, i) => {
      const size = sizes[i];
      if (size === null) {
        throw new HttpsError(
          'not-found',
          `${path} is not in the bucket: its upload has not finished, or did not happen.`,
        );
      }
      if (size !== bytes) {
        throw new HttpsError(
          'failed-precondition',
          `${path} has ${String(size)} bytes in the bucket, not the ${String(bytes)} signed.`,
        );
      }
    });
    const nowMs = deps.now();
    const result = await deps.db.runTransaction(async (transaction) => {
      const upload = readUpload((await transaction.get(refs.attempt)).get('upload'));
      const confirmed = expected.map(({ path, bytes }) => {
        const file = upload.files.get(path);
        if (file?.bytes !== bytes) {
          throw new HttpsError(
            'failed-precondition',
            `${path} was signed again meanwhile: confirm it once its new upload is done.`,
          );
        }
        const done: UploadFile = { bytes, doneMs: file.doneMs ?? nowMs };
        upload.files.set(path, done);
        return { path, ...done };
      });
      const pending = [...upload.files]
        .filter(([, file]) => file.doneMs === null)
        .map(([path]) => path)
        .sort();
      const state = pending.length === 0 ? 'done' : 'uploading';
      transaction.update(refs.attempt, { upload: writeUpload(upload, state) });
      return { state, confirmed, pending } satisfies ConfirmResult;
    });
    deps.log.info('confirmUpload: confirmed', {
      uid,
      sessionId: request.sessionId,
      attemptIndex: request.attemptIndex,
      provider: deps.store.provider,
      files: request.paths,
      state: result.state,
      pending: result.pending.length,
    });
    return result;
  });
}

/**
 * Runs a function's body for the signed-in account, and logs what it refused (an `HttpsError`, sent
 * to the caller as it is) or what failed (anything else, sent as `internal`, its cause in the log).
 */
async function logged<T>(
  log: Log,
  name: string,
  call: Call,
  run: (uid: string) => Promise<T>,
): Promise<T> {
  const target = describeTarget(call.data);
  const uid = call.auth?.uid;
  try {
    if (uid === undefined) {
      throw new HttpsError('unauthenticated', 'Sign in to upload.');
    }
    if (!UID.test(uid)) {
      throw new HttpsError('permission-denied', "This account's id cannot name a folder.");
    }
    return await run(uid);
  } catch (error) {
    if (error instanceof HttpsError) {
      log.warn(`${name}: refused`, {
        uid,
        ...target,
        code: error.code,
        reason: error.message,
      });
      throw error;
    }
    log.error(`${name}: failed`, {
      uid,
      ...target,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    throw new HttpsError('internal', `${name} failed; the function's log says why.`);
  }
}

/** The session and the attempt a call names, as far as they can be read, for the logs. */
function describeTarget(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) {
    return {};
  }
  const { sessionId, attemptIndex } = data as Record<string, unknown>;
  return {
    sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 64) : undefined,
    attemptIndex: typeof attemptIndex === 'number' ? attemptIndex : undefined,
  };
}

function documents(
  db: Firestore,
  uid: string,
  ref: AttemptRef,
): { user: DocumentReference; session: DocumentReference; attempt: DocumentReference } {
  const session = db.collection('sessions').doc(ref.sessionId);
  return {
    user: db.collection('users').doc(uid),
    session,
    attempt: session.collection('attempts').doc(attemptFolder(ref.attemptIndex)),
  };
}

/** Throws `not-found` or `permission-denied` unless the session and the attempt are `uid`'s. */
function checkOwner(
  uid: string,
  ref: AttemptRef,
  session: DocumentSnapshot,
  attempt: DocumentSnapshot,
): void {
  const name = `attempt ${attemptFolder(ref.attemptIndex)} of session ${ref.sessionId}`;
  if (!session.exists) {
    throw new HttpsError('not-found', `Session ${ref.sessionId} is not in the cloud index.`);
  }
  const sessionOwner: unknown = session.get('owner');
  if (sessionOwner !== uid) {
    throw new HttpsError('permission-denied', `Session ${ref.sessionId} is another account's.`);
  }
  if (!attempt.exists) {
    throw new HttpsError('not-found', `The ${name} is not in the cloud index.`);
  }
  const attemptOwner: unknown = attempt.get('owner');
  if (attemptOwner !== uid) {
    throw new HttpsError('permission-denied', `The ${name} is another account's.`);
  }
}

/** An attempt's `upload`, read: its files, and the rest of it, which is written back as it was. */
interface StoredUpload {
  readonly rest: Readonly<Record<string, unknown>>;
  readonly files: Map<string, UploadFile>;
}

/**
 * An attempt's `upload` as stored (T3.1 creates it, the functions keep it): its files with their
 * sizes and `doneMs`; a file without a size is left out.
 */
function readUpload(stored: unknown): StoredUpload {
  const rest: Record<string, unknown> = isRecord(stored) ? { ...stored } : {};
  const files = new Map<string, UploadFile>();
  const storedFiles = rest['files'];
  if (isRecord(storedFiles)) {
    for (const [path, file] of Object.entries(storedFiles)) {
      if (isRecord(file) && typeof file['bytes'] === 'number') {
        const doneMs = file['doneMs'];
        files.set(path, {
          bytes: file['bytes'],
          doneMs: typeof doneMs === 'number' ? doneMs : null,
        });
      }
    }
  }
  return { rest, files };
}

/** `upload` to store: what was read, with `state` and the files as they are now. */
function writeUpload(upload: StoredUpload, state: 'uploading' | 'done'): Record<string, unknown> {
  return { ...upload.rest, state, files: Object.fromEntries(upload.files) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
