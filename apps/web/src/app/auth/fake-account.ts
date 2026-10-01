// A fake of the account's backend for the unit tests (provide `loader` as ACCOUNT_LOADER): the
// Firebase calls of AccountBackend over an in-memory account and Firestore, without Firebase. Nothing
// in the app imports this file, so it is not in the bundle.
import {
  attemptDocumentId,
  type CloudAttempt,
  type CloudAttemptFields,
  type CloudSession,
  type CloudUpload,
  type UserRecord,
} from '@cubetrace/core';

import type {
  AccountBackend,
  AccountLoader,
  BackendUser,
  CloudDocument,
  CloudListing,
} from './account-backend';

/** A session of the fake's index: its document and its attempts' documents, by id (`0001`). */
interface IndexedSession {
  session: CloudSession | null;
  readonly attempts: Map<string, CloudAttempt>;
}

/** The account the tests sign in with. */
export const ADA: BackendUser = {
  uid: 'ada-uid',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  photoURL: 'https://lh3.googleusercontent.com/a/ada=s96-c',
  createdMs: 1_790_000_000_000,
};

/** An error as Firebase Authentication throws them: a message and a code. */
export function authError(code: string): Error {
  return Object.assign(new Error(`Firebase: Error (${code}).`), { code });
}

/**
 * The account's backend in memory. Like Firebase, it keeps the account signed in across page loads
 * (one instance stands for the device: give the same one to each load), reports it to its watchers
 * asynchronously, and reads a redirect's outcome once.
 */
export class FakeAccountBackend implements AccountBackend {
  /** The account signed in on this device, as Firebase keeps it in IndexedDB. */
  user: BackendUser | null = null;
  /** The account that Google's page signs in. */
  account: BackendUser = ADA;
  /** Set: the popup (or the redirect, or reading its outcome) fails with it. */
  popupError: Error | null = null;
  redirectError: Error | null = null;
  /** The outcome waiting for the page that comes back from a redirect. */
  redirectUser: BackendUser | null = null;
  signOutError: Error | null = null;
  /** Set: users/{uid} cannot be saved (Firestore refuses it). */
  saveError: Error | null = null;
  /** Unset: the first report waits for `release()`, as Firebase reads its persistence first. */
  reportAtOnce = true;
  /**
   * Unset: the device is offline. As Firestore's, the index's writes are applied to the documents at
   * once, and their promises wait for `online` to be set again (`goOnline()`); reads say they come
   * from the cache, and the documents written meanwhile that they hold are pending.
   */
  online = true;
  /** Set: the index's writes are refused with it, as the rules refuse a document. */
  indexError: Error | null = null;
  /** Set: the index's reads fail with it. */
  readError: Error | null = null;

  /** The calls made, in order: `watch`, `popup`, `redirect`, `redirect-result`, `sign-out`. */
  readonly calls: string[] = [];
  /** Every users/{uid} written, in order. */
  readonly saved: { uid: string; record: UserRecord }[] = [];
  /** The session index, by session id: the documents as written (the writes merged, as Firestore). */
  readonly index = new Map<string, IndexedSession>();
  /**
   * The index's writes, in order: `sessions/<id>`, `sessions/<id>/attempts/0001`, `delete
   * sessions/<id>/attempts/0001`; the documents of one batch in a row.
   */
  readonly indexWrites: string[] = [];
  /** The attempts' writes that carried `upload` (which create the document), by path, in order. */
  readonly uploadWrites: string[] = [];
  /** How many batches the writes came in (`saveSessionIndex` writes a session with its attempts). */
  batches = 0;
  /** The index's queries, in order: `sessions <uid> <limit>`, `session <id>`, `attempts <id> <uid>`. */
  readonly reads: string[] = [];
  /** How many times the loader loaded this backend. */
  loads = 0;

  private readonly watchers = new Set<(user: BackendUser | null) => void>();
  private held: (() => void)[] = [];
  /** The paths written while offline, and the writes waiting for the network. */
  private readonly unsent = new Set<string>();
  private waiting: (() => void)[] = [];

  readonly loader: AccountLoader = () => {
    this.loads++;
    return Promise.resolve(this);
  };

  watchUser(next: (user: BackendUser | null) => void): () => void {
    this.calls.push('watch');
    this.watchers.add(next);
    const first = (): void => {
      next(this.user);
    };
    if (this.reportAtOnce) {
      queueMicrotask(first);
    } else {
      this.held.push(first);
    }
    return () => {
      this.watchers.delete(next);
    };
  }

  /** A page load: the previous page's watchers are gone (Firebase starts again in the new page). */
  newPage(): void {
    this.watchers.clear();
    this.held = [];
  }

  /** Sends the first reports held back while `reportAtOnce` was unset. */
  release(): void {
    const held = this.held;
    this.held = [];
    for (const report of held) {
      report();
    }
  }

  signInWithPopup(): Promise<void> {
    this.calls.push('popup');
    if (this.popupError !== null) {
      return Promise.reject(this.popupError);
    }
    this.setUser(this.account);
    return Promise.resolve();
  }

  signInWithRedirect(): Promise<void> {
    this.calls.push('redirect');
    if (this.redirectError !== null) {
      return Promise.reject(this.redirectError);
    }
    // The page would leave for Google's here; the test then loads the page again.
    this.redirectUser = this.account;
    return new Promise<void>(() => undefined);
  }

  redirectResult(): Promise<BackendUser | null> {
    this.calls.push('redirect-result');
    const user = this.redirectUser;
    this.redirectUser = null;
    if (user !== null) {
      this.setUser(user);
    }
    return Promise.resolve(user);
  }

  signOut(): Promise<void> {
    this.calls.push('sign-out');
    if (this.signOutError !== null) {
      return Promise.reject(this.signOutError);
    }
    this.setUser(null);
    return Promise.resolve();
  }

  saveUser(uid: string, record: UserRecord): Promise<void> {
    if (this.saveError !== null) {
      return Promise.reject(this.saveError);
    }
    this.saved.push({ uid, record: structuredClone(record) });
    return Promise.resolve();
  }

  saveSessionIndex(
    session: CloudSession,
    attempts: readonly (CloudAttempt | CloudAttemptFields)[] = [],
  ): Promise<void> {
    this.batches++;
    return this.write(
      () => attempts.every((attempt) => this.allowed(attempt)),
      () => {
        this.put(session);
        for (const attempt of attempts) {
          this.putAttempt(attempt);
        }
      },
    );
  }

  saveAttemptIndex(attempt: CloudAttempt | CloudAttemptFields): Promise<void> {
    this.batches++;
    return this.write(
      () => this.allowed(attempt),
      () => {
        this.putAttempt(attempt);
      },
    );
  }

  /**
   * What the upload's functions do to an attempt's `upload` (T3.2), through the Admin SDK, past the
   * rules: `upload` replaced.
   */
  serverSetsUpload(sessionId: string, index: number, upload: CloudUpload): void {
    const attempt = this.index.get(sessionId)?.attempts.get(attemptDocumentId(index));
    if (attempt === undefined) {
      throw new Error(`No attempt ${String(index)} of session ${sessionId} in the index.`);
    }
    attempt.upload = structuredClone(upload);
  }

  deleteAttemptIndex(sessionId: string, index: number): Promise<void> {
    this.batches++;
    return this.write(
      () => this.index.get(sessionId)?.attempts.has(attemptDocumentId(index)) === true,
      () => {
        const path = `sessions/${sessionId}/attempts/${attemptDocumentId(index)}`;
        this.indexWrites.push(`delete ${path}`);
        this.index.get(sessionId)?.attempts.delete(attemptDocumentId(index));
      },
    );
  }

  listSessions(uid: string, limit: number): Promise<CloudListing> {
    this.reads.push(`sessions ${uid} ${String(limit)}`);
    return this.read(() =>
      [...this.index.values()]
        .flatMap(({ session }) => (session?.owner === uid ? [session] : []))
        .sort((p, q) => q.createdMs - p.createdMs)
        .slice(0, limit)
        .map((session) => this.document(session.id, `sessions/${session.id}`, session)),
    );
  }

  getSession(sessionId: string): Promise<CloudDocument | null> {
    this.reads.push(`session ${sessionId}`);
    if (this.readError !== null) {
      return Promise.reject(this.readError);
    }
    const session = this.index.get(sessionId)?.session ?? null;
    return Promise.resolve(
      session === null ? null : this.document(sessionId, `sessions/${sessionId}`, session),
    );
  }

  listAttempts(uid: string, sessionId: string): Promise<CloudListing> {
    this.reads.push(`attempts ${sessionId} ${uid}`);
    return this.read(() =>
      [...(this.index.get(sessionId)?.attempts ?? new Map<string, CloudAttempt>())]
        .filter(([, attempt]) => attempt.owner === uid)
        .sort(([p], [q]) => p.localeCompare(q))
        .map(([id, attempt]) => this.document(id, `sessions/${sessionId}/attempts/${id}`, attempt)),
    );
  }

  /** The network is back: the writes made offline reach the server, and their promises resolve. */
  goOnline(): void {
    this.online = true;
    this.unsent.clear();
    const waiting = this.waiting;
    this.waiting = [];
    for (const send of waiting) {
      send();
    }
  }

  /** The session's document in the index, or undefined. */
  sessionDocument(sessionId: string): CloudSession | undefined {
    return this.index.get(sessionId)?.session ?? undefined;
  }

  /** The documents of the session's attempts in the index, by index. */
  attemptDocuments(sessionId: string): CloudAttempt[] {
    return [...(this.index.get(sessionId)?.attempts.values() ?? [])].sort(
      (p, q) => p.index - q.index,
    );
  }

  /**
   * A write of the index (one batch), applied to the documents at once as Firestore applies it to its
   * cache; it settles when the server would have it (at once online), and rejects with `indexError`,
   * or as the rules refuse it when `allowed` says they would (`permission-denied`), applying nothing.
   */
  private write(allowed: () => boolean, apply: () => void): Promise<void> {
    const refused =
      this.indexError ??
      (allowed()
        ? null
        : Object.assign(new Error('Missing or insufficient permissions.'), {
            code: 'permission-denied',
          }));
    if (refused === null) {
      apply();
    }
    return new Promise<void>((resolve, reject) => {
      const send = (): void => {
        if (refused === null) {
          resolve();
        } else {
          reject(refused);
        }
      };
      if (this.online) {
        queueMicrotask(send);
      } else {
        this.waiting.push(send);
      }
    });
  }

  private put(session: CloudSession): void {
    const path = `sessions/${session.id}`;
    this.indexWrites.push(path);
    this.markUnsent(path);
    const entry = this.entry(session.id);
    entry.session = merged(entry.session, structuredClone(session));
  }

  /**
   * Whether the rules take `attempt` (firebase/firestore.rules): a new document only with its
   * `upload`, and an existing one's `upload` never changed by the app.
   */
  private allowed(attempt: CloudAttempt | CloudAttemptFields): boolean {
    const stored = this.index.get(attempt.session)?.attempts.get(attemptDocumentId(attempt.index));
    if (stored === undefined) {
      return 'upload' in attempt;
    }
    return (
      !('upload' in attempt) || JSON.stringify(attempt.upload) === JSON.stringify(stored.upload)
    );
  }

  private putAttempt(attempt: CloudAttempt | CloudAttemptFields): void {
    const id = attemptDocumentId(attempt.index);
    const path = `sessions/${attempt.session}/attempts/${id}`;
    this.indexWrites.push(path);
    if ('upload' in attempt) {
      this.uploadWrites.push(path);
    }
    this.markUnsent(path);
    const attempts = this.entry(attempt.session).attempts;
    const stored = attempts.get(id) ?? null;
    // Only a new document comes without its stored upload, and the rules take it only with one.
    attempts.set(id, merged(stored, structuredClone(attempt)) as CloudAttempt);
  }

  private entry(sessionId: string): IndexedSession {
    let entry = this.index.get(sessionId);
    if (entry === undefined) {
      entry = { session: null, attempts: new Map() };
      this.index.set(sessionId, entry);
    }
    return entry;
  }

  private markUnsent(path: string): void {
    if (!this.online) {
      this.unsent.add(path);
    }
  }

  private read(documents: () => CloudDocument[]): Promise<CloudListing> {
    if (this.readError !== null) {
      return Promise.reject(this.readError);
    }
    return Promise.resolve({ documents: documents(), fromCache: !this.online });
  }

  private document(id: string, path: string, data: unknown): CloudDocument {
    return { id, data: structuredClone(data), pending: this.unsent.has(path) };
  }

  private setUser(user: BackendUser | null): void {
    this.user = user;
    for (const watcher of this.watchers) {
      queueMicrotask(() => {
        watcher(user);
      });
    }
  }
}

/**
 * `next` merged into `stored`, as Firestore's `set` with `merge` does: maps field by field, anything
 * else (arrays too) replaced.
 */
function merged<T>(stored: T | null, next: T): T {
  return stored === null ? next : (mergeValue(stored, next) as T);
}

function mergeValue(stored: unknown, next: unknown): unknown {
  if (!isMap(stored) || !isMap(next)) {
    return next;
  }
  const out: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(next)) {
    out[key] = mergeValue(stored[key], value);
  }
  return out;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
