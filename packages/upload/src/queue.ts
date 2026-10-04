// The upload queue (docs/PLAN.md T3.3, docs/ARCHITECTURE.md "Uploads"): every attempt of the
// device's sessions, once its record is final, goes to the dataset's bucket through signed URLs:
// its attempt.json, each clip's MP4 and frames file, and the session's session.json with the newest
// of the session's attempts in the queue, again whenever it changed since it was last confirmed, once
// it has stayed the same for SESSION_QUIET_MS (every attempt changes its summary: a session being
// recorded sends it in its pauses and at its end, not with every attempt).
//
// - Order: the oldest session first, its attempts by index, each attempt's files in their order
//   (attempt.json, then each clip's MP4 and frames file, then session.json).
// - Two PUTs at a time. A file is signed right before it is sent, with the rest of its attempt's
//   files in one call (signUpload counts every signature against the day's quota), sent as a Blob
//   with exactly the headers the signature asks for, then confirmed (confirmUpload), which makes it
//   done.
// - A try that the network or the server failed (no response, a 5xx, a 408 or a 429, a function's
//   transient code) is tried again after 1 s, 2 s, 4 s, … up to 5 min, with jitter; an attempt the
//   index has not received yet (`not-found`) waits the same way. Any other 4xx is not tried again
//   (the file is failed, until Retry), but for a URL that expired, which is signed again once.
//   `resource-exhausted`, the day's quota, pauses the queue until it resets; offline, or off Wi-Fi
//   with "Wi-Fi only", nothing is sent.
// - The state is uploads.json (state.ts), so that a reload resumes: what is done stays done, a file
//   that was being sent is confirmed first (its PUT may have finished) and sent again otherwise.
//   For an attempt it does not know, or not as all done (a reload right after a file was confirmed,
//   before uploads.json was written), the index's `upload` says what the bucket has (`doneMs` and
//   the same size): a device that uploaded before, or another that rebuilt its file, sends nothing
//   twice.
// - Once uploaded, clips are deleted from the device by policy: all of an attempt's once it is all
//   uploaded, without "Keep local copies"; in any case, from 70% of the storage quota, the oldest
//   uploaded ones first, down to 60%. uploads.json says so (`local` false); the record does not
//   change (T4.2a), so that deleting a clip signs nothing again; its attempt.json and frames files
//   stay.
import { attemptDocumentId, isSimulated } from '@cubetrace/core';
import type { AttemptRecord, CloudUpload, SessionRecord } from '@cubetrace/core';

import { CloudError, TRANSIENT_CODES, cloudErrorOf, resetsAtOf } from './api';
import type { SignedFile } from './api';
import { retryDelay } from './backoff';
import {
  CONTENT_TYPES,
  SESSION_JSON,
  attemptText,
  attemptUploadFiles,
  kindOf,
  sessionText,
  textHash,
  utf8Bytes,
  type UploadFileKind,
} from './files';
import { networkHold, type NetworkHold } from './network';
import type {
  AttemptRef,
  StorageEstimate,
  UploadCloud,
  UploadEnvironment,
  UploadHttp,
  UploadPolicy,
  UploadSource,
} from './ports';
import {
  parseQueueState,
  queueStateText,
  type AccountQueueState,
  type FileState,
  type QueueStateFile,
  type StoredAttempt,
  type StoredFile,
  type StoredSession,
} from './state';

/** At most this many files are sent at once. */
export const PARALLEL_UPLOADS = 2;

/**
 * How long a signed URL accepts its upload, counted on this device's clock from when it was asked
 * for (the functions' URL_LIFETIME_MS): whatever the server's clock says, it lasts at least this.
 */
export const URL_LIFETIME_MS = 15 * 60 * 1000;

/** A URL is signed again rather than used when less than this is left of it. */
export const URL_MARGIN_MS = 60 * 1000;

/** How long the queue waits for the index's writes to reach the server before it signs anyway. */
export const INDEX_WAIT_MS = 30 * 1000;

/**
 * A session.json that changed is sent once it has stayed the same this long: a session being
 * recorded changes it with every attempt (its summary), and each upload of it counts a file against
 * the day's quota.
 */
export const SESSION_QUIET_MS = 2 * 60 * 1000;

/**
 * A quota pause lasts at least this long, whatever the refusal says: a device whose clock runs ahead
 * of the server's would otherwise ask again and again before the server's day resets.
 */
export const QUOTA_PAUSE_MIN_MS = 60 * 1000;

/** The 4xx answers that say to come back later: tried again as a 5xx is. */
const TRANSIENT_STATUSES: readonly number[] = [408, 429];

/** The storage share from which uploaded clips are deleted, and the share it brings it down to. */
export const STORAGE_DELETE_FROM = 0.7;
export const STORAGE_DELETE_TO = 0.6;

/** The device's sessions are read again this often, for what another tab recorded. */
export const RESCAN_MS = 10 * 60 * 1000;

/**
 * uploads.json is written this long after a change, the changes meanwhile with it (and at once by
 * `flush()`): soon, since a page that goes away takes the write under way with it.
 */
export const STATE_WRITE_DELAY_MS = 100;

/** Progress is told at most this often. */
export const PROGRESS_INTERVAL_MS = 200;

/** How many attempts the view keeps among those done in this page load. */
export const RECENT_ATTEMPTS = 5;

/**
 * Where the queue is: `stopped` (before start, after stop), `waiting` (another tab of the app
 * uploads: one at a time), `starting` (reading uploads.json and the device's sessions), `running`.
 */
export type QueueStatus = 'stopped' | 'waiting' | 'starting' | 'running';

/** What holds the queue: the day's quota until a time, or the network. */
export type QueuePause =
  { readonly reason: 'quota'; readonly untilMs: number } | { readonly reason: NetworkHold };

/**
 * An attempt's upload as the pages show it: `waiting` (its record is not final yet, a clip is still
 * to come), `pending`, `uploading`, `done`, `failed` (a file was refused: Retry).
 */
export type AttemptUploadState = 'waiting' | 'pending' | 'uploading' | 'done' | 'failed';

/** A file of an attempt's upload, for the pages. */
export interface FileView {
  readonly path: string;
  readonly bytes: number;
  readonly state: FileState;
  /** The bytes sent of a file being sent; its size once done. */
  readonly sent: number;
  readonly tries: number;
  /** Why its last try failed, if it did. */
  readonly error: string | null;
  /** When it is tried again after a failure, host clock; null when not waiting for that. */
  readonly retryAtMs: number | null;
  /** False for a clip's MP4 deleted from the device after its upload. */
  readonly local: boolean;
}

/** An attempt's upload, for the pages. */
export interface AttemptView {
  readonly sessionId: string;
  readonly index: number;
  /** Its session's `createdMs`, for the pages to name it. */
  readonly sessionCreatedMs: number;
  readonly state: AttemptUploadState;
  readonly files: readonly FileView[];
  /** The bytes of its files, and those sent or done. */
  readonly bytes: number;
  readonly sent: number;
  /** The error of its first file that failed, or that waits to be tried again. */
  readonly error: string | null;
}

/** The queue, for the pages. */
export interface QueueView {
  readonly status: QueueStatus;
  /** What holds it, if anything does. */
  readonly pause: QueuePause | null;
  /** The attempts by state (`waiting`, `pending`, `uploading`, `done`, `failed`). */
  readonly counts: Readonly<Record<AttemptUploadState, number>>;
  /** The bytes still to send, of the attempts not done. */
  readonly bytesLeft: number;
  /** The attempts not done, in the queue's order. */
  readonly active: readonly AttemptView[];
  /** The attempts done in this page load, the last first (at most {@link RECENT_ATTEMPTS}). */
  readonly recent: readonly AttemptView[];
  /** The clips deleted from the device in this page load, by policy, and their bytes. */
  readonly freed: { readonly clips: number; readonly bytes: number };
  /** Why the queue could not read the device's sessions or its state, the last time it tried. */
  readonly error: string | null;
}

/** What the queue is given. */
export interface UploadQueueOptions {
  /** The account signed in: the queue uploads into its prefix, and keeps its state apart. */
  readonly uid: string;
  readonly source: UploadSource;
  readonly cloud: UploadCloud;
  readonly http: UploadHttp;
  readonly env: UploadEnvironment;
  readonly policy: UploadPolicy;
}

/** A file of an attempt's upload in memory: its stored state and what only this page load knows. */
interface FileTask {
  readonly path: string;
  readonly kind: UploadFileKind;
  /** The entry of uploads.json, changed in place. */
  stored: StoredFile;
  sent: number;
  /** Failures in a row in this page load: the backoff's exponent. */
  failures: number;
  retryAtMs: number | null;
  /** The signature, and until when it may be used (this device's clock). */
  signed: SignedFile | null;
  usableUntilMs: number;
  /** The bytes signed, for attempt.json and session.json, made from their records when signed. */
  body: Blob | null;
  /** A URL that expired was signed again: the next 4xx fails the file. */
  resigned: boolean;
  /** It may have been sent before a reload: confirm it before sending it again. */
  confirmFirst: boolean;
  /** In one of the two slots. */
  active: boolean;
  controller: AbortController | null;
}

interface AttemptTask {
  readonly sessionId: string;
  readonly index: number;
  readonly folder: string;
  /** The entry of uploads.json, changed in place. */
  stored: StoredAttempt;
  files: FileTask[];
  /** Its latest record; null for an attempt known only from uploads.json (all of it done). */
  record: AttemptRecord | null;
  signing: Promise<void> | null;
  /** All its files are done. */
  complete: boolean;
}

interface SessionTask {
  readonly id: string;
  createdMs: number;
  simulated: boolean;
  /** Its session.json as it is uploaded, its hash and its size; null before its record is read. */
  text: string | null;
  hash: string | null;
  bytes: number;
  /**
   * When the app last saved a change of it in this page load (host clock): its session.json waits
   * for {@link SESSION_QUIET_MS} after; −∞ for a session read from the device, at rest.
   */
  changedMs: number;
  /** The entry of uploads.json, changed in place. */
  stored: StoredSession;
  /** By index. */
  attempts: Map<number, AttemptTask>;
}

/**
 * The upload queue of one account on this device. `start()` begins it (once this page holds the
 * upload lock), `stop()` ends it (sign-out); the app tells it of every record it saves and deletes,
 * so that it follows the timer without reading the store again, and reads the pages' views from it.
 */
export class UploadQueue {
  readonly #uid: string;
  readonly #source: UploadSource;
  readonly #cloud: UploadCloud;
  readonly #http: UploadHttp;
  readonly #env: UploadEnvironment;
  #policy: UploadPolicy;

  #status: QueueStatus = 'stopped';
  /** Started once: a stopped queue is not started again (the app makes a new one). */
  #started = false;
  #error: string | null = null;
  #file: QueueStateFile | null = null;
  #state: AccountQueueState = { pausedUntilMs: null, sessions: {} };
  readonly #sessions = new Map<string, SessionTask>();
  readonly #slots = new Set<Promise<void>>();
  readonly #recent: AttemptView[] = [];
  #freed = { clips: 0, bytes: 0 };
  /** Opens the queue's operations once uploads.json is read: the events before wait for it. */
  #open: () => void = () => undefined;
  /**
   * The queue's own operations (reading the store, reconciling, deleting clips), one at a time,
   * from when uploads.json is read.
   */
  #serial: Promise<void> = new Promise<void>((resolve) => {
    this.#open = resolve;
  });
  readonly #listeners = new Set<() => void>();
  #notifyQueued = false;
  #progressTimer: unknown = null;
  #wakeTimer: unknown = null;
  #wakeAtMs: number | null = null;
  #quotaTimer: unknown = null;
  #rescanTimer: unknown = null;
  /** Plans the session.json of a session whose quiet time is over; when it is due. */
  #riderTimer: unknown = null;
  #riderAtMs: number | null = null;
  #writeTimer: unknown = null;
  #writing: Promise<void> | null = null;
  #dirty = false;
  #unwatchNetwork: (() => void) | null = null;
  #releaseLock: (() => void) | null = null;
  #stopping: AbortController | null = null;
  #hold: NetworkHold | null = null;
  #policyDue = false;
  /** The files (`<session>/<folder>/<path>`) that were being sent when uploads.json was last written. */
  readonly #confirmFirst = new Set<string>();

  constructor(options: UploadQueueOptions) {
    this.#uid = options.uid;
    this.#source = options.source;
    this.#cloud = options.cloud;
    this.#http = options.http;
    this.#env = options.env;
    this.#policy = options.policy;
  }

  /** Where the queue is. */
  get status(): QueueStatus {
    return this.#status;
  }

  /**
   * Starts the queue: waits for the upload lock (another tab may hold it), reads uploads.json and
   * the device's sessions, then uploads. Resolves once it runs; a queue stopped meanwhile resolves
   * without running. A queue starts once.
   */
  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    const stopping = new AbortController();
    this.#stopping = stopping;
    /** `stop()` was called meanwhile (a function: each await may change it). */
    const stopped = (): boolean => stopping.signal.aborted;
    this.#status = 'waiting';
    this.#notify();
    try {
      this.#releaseLock = (await this.#env.lock?.(stopping.signal)) ?? null;
    } catch {
      return; // Stopped while waiting for the lock.
    }
    if (stopped()) {
      this.#releaseLock?.();
      this.#releaseLock = null;
      return;
    }
    this.#status = 'starting';
    this.#notify();
    await this.#readState();
    this.#open();
    if (stopped()) {
      return;
    }
    this.#unwatchNetwork = this.#env.watchNetwork(() => {
      this.#onNetwork();
    });
    this.#hold = networkHold(this.#env.network(), this.#policy.wifiOnly);
    this.#armQuotaTimer();
    await this.#enqueue(() => this.#scanAll());
    if (stopped()) {
      return;
    }
    this.#status = 'running';
    this.#rescanTimer = this.#env.setTimeout(() => {
      this.#rescanLater();
    }, RESCAN_MS);
    this.#notify();
    this.#pump();
    this.#applyPolicySoon();
  }

  /**
   * Stops the queue (the account signed out, uploads turned off): the files being sent are cut off
   * and stay pending, uploads.json is written, and the lock is let go.
   */
  async stop(): Promise<void> {
    if (this.#status === 'stopped') {
      return;
    }
    this.#status = 'stopped';
    this.#stopping?.abort();
    this.#stopping = null;
    for (const file of this.#allFiles()) {
      file.controller?.abort();
    }
    for (const timer of [
      this.#wakeTimer,
      this.#quotaTimer,
      this.#rescanTimer,
      this.#progressTimer,
      this.#writeTimer,
      this.#riderTimer,
    ]) {
      if (timer !== null) {
        this.#env.clearTimeout(timer);
      }
    }
    this.#wakeTimer = this.#quotaTimer = this.#rescanTimer = this.#progressTimer = null;
    this.#writeTimer = this.#riderTimer = null;
    this.#wakeAtMs = this.#riderAtMs = null;
    this.#unwatchNetwork?.();
    this.#unwatchNetwork = null;
    // The operations still queued are dropped (#enqueue); the one under way ends, then the state is
    // written.
    this.#open();
    await Promise.allSettled([...this.#slots]);
    await this.#serial;
    if (this.#file !== null) {
      this.#dirty = true;
      await this.#flush();
    }
    this.#releaseLock?.();
    this.#releaseLock = null;
    this.#notify();
  }

  /**
   * Writes uploads.json now, if it changed (the page is going away: `pagehide`). Resolves once it is
   * written, or failed.
   */
  flush(): Promise<void> {
    if (this.#writeTimer !== null) {
      this.#env.clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    return this.#flush();
  }

  /** Follows new settings: "Wi-Fi only" now, and "Keep local copies" for every attempt done. */
  setPolicy(policy: UploadPolicy): void {
    const before = this.#policy;
    this.#policy = policy;
    if (before.wifiOnly !== policy.wifiOnly) {
      this.#onNetwork();
    }
    if (before.keepLocalCopies !== policy.keepLocalCopies) {
      this.#applyPolicySoon();
    }
  }

  /**
   * A session's record was saved: its session.json goes again when it changed, once it has stayed
   * the same for {@link SESSION_QUIET_MS}.
   */
  sessionSaved(session: SessionRecord): void {
    void this.#enqueue(() => {
      this.#takeSession(session, true);
      this.#pump();
    });
  }

  /** An attempt's record was saved (it ended, or a clip was added to it). */
  attemptSaved(attempt: AttemptRecord): void {
    void this.#enqueue(async () => {
      const session = this.#sessions.get(attempt.session);
      if (session?.simulated === true) {
        return; // A demo session's: never uploaded.
      }
      if (session === undefined || session.text === null) {
        await this.#loadSession(attempt.session);
      } else {
        await this.#reconcile(session, attempt, null);
        this.#planRider(session);
        this.#persist();
      }
      this.#pump();
    });
  }

  /**
   * An attempt was deleted from the device (Delete last): nothing of it is sent any more (what the
   * bucket has of it stays, as its session's files do when a session is deleted).
   */
  attemptDeleted(sessionId: string, index: number): void {
    void this.#enqueue(() => {
      const session = this.#sessions.get(sessionId);
      const attempt = session?.attempts.get(index);
      if (session === undefined || attempt === undefined) {
        return;
      }
      this.#dropAttempt(session, attempt);
      // The session.json it carried goes with another attempt.
      this.#planRider(session);
      this.#persist();
      this.#pump();
    });
  }

  /** A session was deleted from the device: nothing of it is sent any more. */
  sessionDeleted(sessionId: string): void {
    void this.#enqueue(() => {
      const session = this.#sessions.get(sessionId);
      if (session !== undefined) {
        for (const attempt of session.attempts.values()) {
          this.#abortAttempt(attempt);
        }
        this.#sessions.delete(sessionId);
      }
      Reflect.deleteProperty(this.#state.sessions, sessionId);
      this.#persist();
      this.#notify();
    });
  }

  /** Something the queue waits for may have changed (an attempt's clips settled): it looks again. */
  refresh(): void {
    this.#notify();
    this.#pump();
  }

  /** Reads the device's sessions again (another tab may have recorded). */
  rescan(): void {
    void this.#enqueue(async () => {
      await this.#scanAll();
      this.#pump();
    });
  }

  /**
   * Tries the failed files again, and those waiting after a failure, at once: of attempt `index` of
   * session `sessionId`, of every attempt of the session without `index`, of every attempt without
   * either. A quota pause stays.
   */
  retry(sessionId?: string, index?: number): void {
    for (const session of this.#sessions.values()) {
      if (sessionId !== undefined && session.id !== sessionId) {
        continue;
      }
      for (const attempt of session.attempts.values()) {
        if (index !== undefined && attempt.index !== index) {
          continue;
        }
        for (const file of attempt.files) {
          if (file.stored.state === 'failed' || file.retryAtMs !== null) {
            if (file.stored.state === 'failed') {
              file.stored.state = 'pending';
            }
            file.retryAtMs = null;
            file.failures = 0;
            file.resigned = false;
          }
        }
      }
    }
    this.#persist();
    this.#notify();
    this.#pump();
  }

  /** Calls `listener` after each change of the views; returns what stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The queue now, for the pages. */
  view(): QueueView {
    const counts: Record<AttemptUploadState, number> = {
      waiting: 0,
      pending: 0,
      uploading: 0,
      done: 0,
      failed: 0,
    };
    const active: AttemptView[] = [];
    let bytesLeft = 0;
    for (const session of this.#ordered()) {
      for (const attempt of this.#attemptsOf(session)) {
        if (attempt.complete) {
          counts.done++;
          continue;
        }
        const view = this.#attemptView(session, attempt);
        counts[view.state]++;
        if (view.state !== 'done') {
          active.push(view);
          bytesLeft += view.bytes - view.sent;
        }
      }
    }
    return {
      status: this.#status,
      pause: this.#pause(),
      counts,
      bytesLeft,
      active,
      recent: [...this.#recent],
      freed: { ...this.#freed },
      error: this.#error,
    };
  }

  /** Attempt `index` of session `sessionId`'s upload; null when the queue does not have it. */
  attemptView(sessionId: string, index: number): AttemptView | null {
    const session = this.#sessions.get(sessionId);
    const attempt = session?.attempts.get(index);
    return session === undefined || attempt === undefined
      ? null
      : this.#attemptView(session, attempt);
  }

  // ---- State ----

  async #readState(): Promise<void> {
    let text: string | null = null;
    try {
      text = await this.#source.readState();
    } catch (error: unknown) {
      this.#error = `uploads.json could not be read (${messageOf(error)}): the index says what is uploaded.`;
    }
    const file = parseQueueState(text);
    const state = (file.accounts[this.#uid] ??= { pausedUntilMs: null, sessions: {} });
    // A file that was being sent when the page went: its PUT may have finished; it is confirmed first.
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      for (const [folder, attempt] of Object.entries(session.attempts)) {
        for (const [path, stored] of Object.entries(attempt.files)) {
          if (stored.state === 'uploading') {
            stored.state = 'pending';
            this.#confirmFirst.add(`${sessionId}/${folder}/${path}`);
          }
        }
      }
    }
    this.#file = file;
    this.#state = state;
  }

  /** Writes uploads.json soon: changes in a row are written once. */
  #persist(): void {
    this.#dirty = true;
    if (this.#writeTimer !== null || this.#file === null || this.#status === 'stopped') {
      return;
    }
    this.#writeTimer = this.#env.setTimeout(() => {
      this.#writeTimer = null;
      void this.#flush();
    }, STATE_WRITE_DELAY_MS);
  }

  /** Writes uploads.json now, after a write under way; a failure is said and tried at the next change. */
  async #flush(): Promise<void> {
    while (this.#writing !== null) {
      await this.#writing;
    }
    if (!this.#dirty || this.#file === null) {
      return;
    }
    this.#dirty = false;
    const text = queueStateText(this.#file);
    this.#writing = this.#source.writeState(text).then(
      () => {
        if (this.#error?.startsWith('uploads.json') === true) {
          this.#error = null;
        }
      },
      (error: unknown) => {
        this.#error = `uploads.json could not be written (${messageOf(error)}).`;
        this.#notify();
      },
    );
    await this.#writing;
    this.#writing = null;
  }

  // ---- Reading the device's sessions ----

  /**
   * Reads every session of the device: a session whose session.json is the one confirmed and whose
   * attempts are all done is taken from uploads.json as it is; the others are read whole and their
   * attempts reconciled. Sessions no longer on the device leave uploads.json.
   */
  async #scanAll(): Promise<void> {
    let sessions: SessionRecord[];
    try {
      sessions = await this.#source.listSessions();
    } catch (error: unknown) {
      this.#error = `The sessions of this device could not be read: ${messageOf(error)}`;
      this.#notify();
      return;
    }
    if (this.#error?.startsWith('The sessions') === true) {
      this.#error = null;
    }
    const seen = new Set<string>();
    for (const record of [...sessions].reverse()) {
      seen.add(record.id);
      const session = this.#takeSession(record);
      if (session.simulated) {
        continue;
      }
      const settled =
        session.stored.sessionJson?.hash === session.hash &&
        Object.values(session.stored.attempts).every((attempt) =>
          Object.values(attempt.files).every((file) => file.state === 'done'),
        );
      if (settled) {
        this.#adoptStored(session);
      } else {
        await this.#loadSession(record.id);
      }
    }
    for (const id of [...this.#sessions.keys()]) {
      if (!seen.has(id)) {
        const session = this.#sessions.get(id);
        for (const attempt of session?.attempts.values() ?? []) {
          this.#abortAttempt(attempt);
        }
        this.#sessions.delete(id);
      }
    }
    for (const id of Object.keys(this.#state.sessions)) {
      if (!seen.has(id)) {
        Reflect.deleteProperty(this.#state.sessions, id);
      }
    }
    this.#persist();
    this.#notify();
  }

  /**
   * The task of `record`'s session, made or brought up to date, with its session.json; `live`, a
   * change the app has just saved, after which its session.json waits for {@link SESSION_QUIET_MS}.
   */
  #takeSession(record: SessionRecord, live = false): SessionTask {
    let session = this.#sessions.get(record.id);
    if (session === undefined) {
      session = {
        id: record.id,
        createdMs: record.createdMs,
        simulated: isSimulated(record),
        text: null,
        hash: null,
        bytes: 0,
        changedMs: Number.NEGATIVE_INFINITY,
        stored: this.#storedSession(record.id),
        attempts: new Map(),
      };
      this.#sessions.set(record.id, session);
    }
    session.createdMs = record.createdMs;
    session.simulated = isSimulated(record);
    if (session.simulated) {
      // Demo sessions never go to the cloud.
      for (const attempt of session.attempts.values()) {
        this.#abortAttempt(attempt);
      }
      session.attempts.clear();
      Reflect.deleteProperty(this.#state.sessions, record.id);
      return session;
    }
    const text = sessionText(record);
    const hash = textHash(text);
    if (live && hash !== session.hash) {
      session.changedMs = this.#env.now();
    }
    session.text = text;
    session.hash = hash;
    session.bytes = utf8Bytes(text);
    this.#planRider(session);
    return session;
  }

  #storedSession(id: string): StoredSession {
    return (this.#state.sessions[id] ??= { sessionJson: null, attempts: {} });
  }

  /** The attempts of a session whose uploads are all done, from uploads.json alone. */
  #adoptStored(session: SessionTask): void {
    for (const [folder, stored] of Object.entries(session.stored.attempts)) {
      const index = Number(folder);
      if (session.attempts.has(index)) {
        continue;
      }
      const attempt: AttemptTask = {
        sessionId: session.id,
        index,
        folder,
        stored,
        files: Object.keys(stored.files).map((path) => this.#fileTask(path, stored.files[path])),
        record: null,
        signing: null,
        complete: false,
      };
      this.#updateComplete(attempt);
      session.attempts.set(index, attempt);
    }
  }

  /**
   * Reads a session and its attempts from the device and reconciles them: what uploads.json says of
   * them, what the index says of those it does not know, and their files as they are now.
   */
  async #loadSession(sessionId: string): Promise<void> {
    let loaded: { session: SessionRecord; attempts: AttemptRecord[] } | null;
    try {
      loaded = await this.#source.loadSession(sessionId);
    } catch (error: unknown) {
      this.#error = `Session ${sessionId} could not be read: ${messageOf(error)}`;
      this.#notify();
      return;
    }
    if (loaded === null) {
      return;
    }
    const session = this.#takeSession(loaded.session);
    if (session.simulated) {
      return;
    }
    let cloud: ReadonlyMap<number, CloudUpload> | null = null;
    // What the index says is asked for the attempts uploads.json does not know as all done.
    const unsure = loaded.attempts.some((attempt) => {
      const known = session.stored.attempts[attemptDocumentId(attempt.index)] as
        StoredAttempt | undefined;
      return (
        known === undefined ||
        Object.values(known.files).some(
          (file) => file.state === 'pending' || file.state === 'uploading',
        )
      );
    });
    if (unsure) {
      try {
        cloud = await this.#cloud.uploadsOf(sessionId);
      } catch {
        cloud = null; // Offline: what the index has is not known, so it is sent.
      }
    }
    const indices = new Set(loaded.attempts.map((attempt) => attempt.index));
    for (const attempt of loaded.attempts) {
      await this.#reconcile(session, attempt, cloud?.get(attempt.index) ?? null);
    }
    for (const attempt of [...session.attempts.values()]) {
      if (!indices.has(attempt.index)) {
        this.#dropAttempt(session, attempt);
      }
    }
    for (const folder of Object.keys(session.stored.attempts)) {
      if (!indices.has(Number(folder))) {
        Reflect.deleteProperty(session.stored.attempts, folder);
      }
    }
    this.#planRider(session);
    this.#persist();
    this.#notify();
  }

  /**
   * Brings attempt `record`'s upload up to date: each of its files keeps its stored state while it is
   * the same (attempt.json by the hash of its text, a clip's files by their sizes), is done when the
   * index says the bucket has it with that size (`cloud`), and is pending otherwise. A clip's MP4
   * that is no longer on the device was uploaded before it went, and stays done, when uploads.json
   * has it done (or the index does, when uploads.json does not know it), or when its record says so
   * (`local` false, which the app wrote until T4.2a); any other file that is not on the device is
   * not sent.
   */
  async #reconcile(
    session: SessionTask,
    record: AttemptRecord,
    cloud: CloudUpload | null,
  ): Promise<void> {
    const folder = attemptDocumentId(record.index);
    let stored = session.stored.attempts[folder] as StoredAttempt | undefined;
    let attempt = session.attempts.get(record.index);
    if (stored !== undefined && stored.scrambleShown !== record.events.scrambleShown) {
      // Another attempt with this index (Delete last freed it): its upload starts afresh.
      if (attempt !== undefined) {
        this.#dropAttempt(session, attempt);
        attempt = undefined;
      }
      stored = undefined;
    }
    stored ??= session.stored.attempts[folder] = {
      scrambleShown: record.events.scrambleShown,
      files: {},
    };
    if (attempt === undefined) {
      attempt = {
        sessionId: session.id,
        index: record.index,
        folder,
        stored,
        files: [],
        record,
        signing: null,
        complete: false,
      };
      session.attempts.set(record.index, attempt);
    }
    attempt.record = record;
    const files: Record<string, StoredFile> = {};
    const tasks: FileTask[] = [];
    for (const { path, kind, clip } of attemptUploadFiles(record)) {
      const previous = stored.files[path] as StoredFile | undefined;
      const task = attempt.files.find((file) => file.path === path);
      let entry: StoredFile | null;
      if (kind === 'attempt') {
        const text = attemptText(record);
        const hash = textHash(text);
        const bytes = utf8Bytes(text);
        entry =
          previous === undefined
            ? (fromCloud(cloud, path, bytes, hash) ?? pending(bytes, undefined, hash))
            : previous.hash === hash || task?.active === true
              ? previous
              : pending(bytes, previous, hash);
      } else if (kind === 'clip' && clip?.local === false) {
        // Deleted from the device after its upload was confirmed, which its record says (written so
        // before T4.2a): done, whatever was kept of it.
        entry =
          previous?.state === 'done'
            ? previous
            : { bytes: clip.bytes, state: 'done', tries: 0, error: null, doneMs: null };
        entry.local = false;
      } else {
        const size = await this.#source.fileSize(session.id, record.index, path).catch(() => null);
        if (size === null || size === 0) {
          // Not on the device: a clip's MP4 deleted after its upload stays done, as uploads.json
          // says, or the index when uploads.json does not know it; any other file is not sent.
          entry =
            kind !== 'clip' || clip === null
              ? null
              : previous?.state === 'done'
                ? previous
                : fromCloud(cloud, path, clip.bytes);
          if (entry !== null) {
            entry.local = false;
          }
        } else {
          entry =
            previous === undefined
              ? (fromCloud(cloud, path, size) ?? pending(size, undefined))
              : previous.bytes === size || task?.active === true
                ? previous
                : pending(size, previous);
        }
      }
      if (entry === null) {
        continue;
      }
      if (task?.active !== true && (entry.state === 'pending' || entry.state === 'uploading')) {
        // Confirmed already, as far as the index says (uploads.json did not have it yet).
        entry = fromCloud(cloud, path, entry.bytes, entry.hash) ?? entry;
      }
      files[path] = entry;
      tasks.push(this.#keepTask(task, path, entry));
    }
    // session.json rides along as #planRider says; it is the session's, not the record's.
    let rider = stored.files[SESSION_JSON] as StoredFile | undefined;
    if (rider !== undefined) {
      const task = attempt.files.find((file) => file.path === SESSION_JSON);
      if (
        task?.active !== true &&
        (rider.state === 'pending' || rider.state === 'uploading') &&
        rider.hash !== undefined &&
        rider.hash === session.hash
      ) {
        const confirmed = fromCloud(cloud, SESSION_JSON, rider.bytes, rider.hash);
        if (confirmed !== null) {
          rider = confirmed;
          session.stored.sessionJson = { hash: rider.hash ?? '', bytes: rider.bytes };
        }
      }
      files[SESSION_JSON] = rider;
      tasks.push(this.#keepTask(task, SESSION_JSON, rider));
    }
    for (const task of attempt.files) {
      if (!tasks.includes(task)) {
        task.controller?.abort();
      }
    }
    stored.files = files;
    attempt.stored = stored;
    attempt.files = tasks;
    this.#updateComplete(attempt);
  }

  /** `task` kept for `entry` when it holds it, else a new task. */
  #keepTask(task: FileTask | undefined, path: string, entry: StoredFile): FileTask {
    if (task?.stored === entry) {
      return task;
    }
    task?.controller?.abort();
    return this.#fileTask(path, entry);
  }

  #fileTask(path: string, stored: StoredFile): FileTask {
    return {
      path,
      kind: kindOf(path),
      stored,
      sent: stored.state === 'done' ? stored.bytes : 0,
      failures: 0,
      retryAtMs: null,
      signed: null,
      usableUntilMs: 0,
      body: null,
      resigned: false,
      confirmFirst: false,
      active: false,
      controller: null,
    };
  }

  /**
   * session.json rides with one attempt of its session when it differs from the one confirmed, once
   * it has stayed the same for {@link SESSION_QUIET_MS}: the newest attempt with files still to send
   * (else the newest), so that a session of many attempts waiting sends it once, with the last. A
   * rider not signed yet moves to the newest such attempt, or waits again when the session changed;
   * one signed, or being sent, stays (once it is confirmed, the next plan sends a newer text).
   */
  #planRider(session: SessionTask): void {
    if (session.simulated || session.hash === null) {
      return;
    }
    const attempts = this.#attemptsOf(session).filter((attempt) => attempt.record !== null);
    const riders = attempts.flatMap((attempt) =>
      attempt.files
        .filter((file) => file.path === SESSION_JSON && file.stored.state !== 'done')
        .map((file) => ({ attempt, file })),
    );
    const begun = riders.find(({ file }) => file.active || file.signed !== null);
    const loose = riders.filter((rider) => rider !== begun);
    const quietAtMs = session.changedMs + SESSION_QUIET_MS;
    const waits = this.#env.now() < quietAtMs;
    if (session.stored.sessionJson?.hash === session.hash || begun !== undefined || waits) {
      for (const { attempt } of loose) {
        this.#removeRider(attempt);
      }
      if (waits && session.stored.sessionJson?.hash !== session.hash) {
        this.#armRiderTimer(quietAtMs);
      }
      return;
    }
    const target =
      attempts.filter((attempt) => !attempt.complete).at(-1) ?? attempts.at(-1) ?? null;
    if (target === null) {
      return;
    }
    if (loose.length === 1 && loose[0].attempt === target) {
      return;
    }
    for (const { attempt } of loose) {
      this.#removeRider(attempt);
    }
    const entry: StoredFile = {
      bytes: session.bytes,
      hash: session.hash,
      state: 'pending',
      tries: 0,
      error: null,
      doneMs: null,
    };
    this.#removeRider(target);
    target.stored.files[SESSION_JSON] = entry;
    target.files.push(this.#fileTask(SESSION_JSON, entry));
    this.#updateComplete(target);
    this.#persist();
  }

  #removeRider(attempt: AttemptTask): void {
    attempt.files = attempt.files.filter((file) => file.path !== SESSION_JSON);
    Reflect.deleteProperty(attempt.stored.files, SESSION_JSON);
    this.#updateComplete(attempt);
  }

  /** Plans the session.json riders again at `atMs`, when a session's quiet time is over. */
  #armRiderTimer(atMs: number): void {
    if (this.#riderAtMs !== null && this.#riderAtMs <= atMs) {
      return;
    }
    if (this.#riderTimer !== null) {
      this.#env.clearTimeout(this.#riderTimer);
    }
    this.#riderAtMs = atMs;
    this.#riderTimer = this.#env.setTimeout(
      () => {
        this.#riderTimer = null;
        this.#riderAtMs = null;
        if (this.#status === 'stopped') {
          return;
        }
        void this.#enqueue(() => {
          for (const session of this.#sessions.values()) {
            this.#planRider(session);
          }
          this.#persist();
          this.#notify();
          this.#pump();
        });
      },
      Math.max(0, atMs - this.#env.now()),
    );
  }

  #dropAttempt(session: SessionTask, attempt: AttemptTask): void {
    this.#abortAttempt(attempt);
    session.attempts.delete(attempt.index);
    if (session.stored.attempts[attempt.folder] === attempt.stored) {
      Reflect.deleteProperty(session.stored.attempts, attempt.folder);
    }
  }

  #abortAttempt(attempt: AttemptTask): void {
    for (const file of attempt.files) {
      file.controller?.abort();
    }
  }

  // ---- Sending ----

  /** Starts files while a slot is free and something may go. */
  #pump(): void {
    if (this.#status !== 'running') {
      return;
    }
    while (this.#slots.size < PARALLEL_UPLOADS) {
      const next = this.#next();
      if (next === null) {
        break;
      }
      const [attempt, file] = next;
      file.active = true;
      const run = this.#send(attempt, file).finally(() => {
        file.active = false;
        file.controller = null;
        this.#slots.delete(run);
        this.#notify();
        this.#pump();
      });
      this.#slots.add(run);
    }
    this.#armWake();
    this.#notify();
  }

  /** The next file to send, in the queue's order, or null. */
  #next(): [AttemptTask, FileTask] | null {
    if (this.#hold !== null) {
      return null;
    }
    const now = this.#env.now();
    const quota = this.#quotaPaused(now);
    for (const session of this.#ordered()) {
      for (const attempt of this.#attemptsOf(session)) {
        if (attempt.complete || !this.#settled(attempt)) {
          continue;
        }
        for (const file of attempt.files) {
          if (
            file.stored.state === 'pending' &&
            !file.active &&
            (file.retryAtMs === null || file.retryAtMs <= now) &&
            (!quota || this.#usable(file, now))
          ) {
            return [attempt, file];
          }
        }
      }
    }
    return null;
  }

  #settled(attempt: AttemptTask): boolean {
    return attempt.record === null || this.#source.settled(attempt.sessionId, attempt.index);
  }

  /** Signs if it must, sends, confirms: one file in a slot. */
  async #send(attempt: AttemptTask, file: FileTask): Promise<void> {
    const key = `${attempt.sessionId}/${attempt.folder}/${file.path}`;
    try {
      if (this.#confirmFirst.delete(key) || file.confirmFirst) {
        // It may be in the bucket already (sent before a reload, or its confirmation failed): only
        // a file the bucket does not have goes again.
        file.confirmFirst = false;
        file.stored.tries++;
        if ((await this.#confirm(attempt, file, true)) !== 'absent') {
          return;
        }
      }
      if (!this.#usable(file, this.#env.now())) {
        await this.#sign(attempt);
        if (!this.#usable(file, this.#env.now()) || !this.#mayStart(file)) {
          return;
        }
      }
      const signed = file.signed;
      if (signed === null) {
        return;
      }
      const body =
        file.body ?? (await this.#source.readFile(attempt.sessionId, attempt.index, file.path));
      if (!this.#mayStart(file)) {
        return;
      }
      if (body.size !== file.stored.bytes) {
        // The file changed since it was read: its size is read again, and it is signed again.
        this.#forgetSignature(file);
        void this.#enqueue(() => this.#loadSession(attempt.sessionId));
        return;
      }
      const controller = new AbortController();
      file.controller = controller;
      file.stored.state = 'uploading';
      file.stored.tries++;
      file.sent = 0;
      this.#persist();
      this.#notify();
      const response = await this.#http.put({
        url: signed.url,
        headers: signed.headers,
        body,
        signal: controller.signal,
        progress: (sent) => {
          file.sent = Math.min(sent, file.stored.bytes);
          this.#notifyProgress();
        },
      });
      file.controller = null;
      if (response.status >= 200 && response.status < 300) {
        file.sent = file.stored.bytes;
        await this.#confirm(attempt, file, false);
      } else if (
        response.status === 0 ||
        response.status >= 500 ||
        TRANSIENT_STATUSES.includes(response.status)
      ) {
        this.#failed(
          file,
          'again',
          response.status === 0
            ? 'the upload did not reach the bucket (network error)'
            : `the bucket answered ${String(response.status)}${excerpt(response.body)}`,
        );
      } else if (
        !file.resigned &&
        (this.#env.now() >= file.usableUntilMs || /expired/i.test(response.body))
      ) {
        // The URL expired: signed again, once.
        file.resigned = true;
        this.#forgetSignature(file);
        file.stored.state = 'pending';
        file.stored.error = `the signed URL had expired (${String(response.status)}): signed again`;
      } else {
        this.#failed(
          file,
          'refused',
          `the bucket refused the upload: ${String(response.status)}${excerpt(response.body)}`,
        );
      }
    } catch (error: unknown) {
      file.controller = null;
      if (isAbort(error)) {
        // Cut off (stopped, the network held, or the attempt went): it goes again later, as it is.
        if (file.stored.state === 'uploading') {
          file.stored.state = 'pending';
        }
      } else if (isNotFound(error)) {
        // Its file is not on the device any more: the session is read again.
        this.#forgetSignature(file);
        file.stored.state = 'pending';
        void this.#enqueue(() => this.#loadSession(attempt.sessionId));
      } else {
        this.#failed(file, 'again', `it could not be read or sent: ${messageOf(error)}`);
      }
    } finally {
      this.#persist();
    }
  }

  /** Whether `file` may still start: running, not held, and still pending. */
  #mayStart(file: FileTask): boolean {
    return (
      this.#status === 'running' &&
      this.#hold === null &&
      (file.stored.state === 'pending' || file.stored.state === 'uploading')
    );
  }

  /** Whether `file` has a signature it may still use. */
  #usable(file: FileTask, now: number): boolean {
    return file.signed !== null && now < file.usableUntilMs;
  }

  #forgetSignature(file: FileTask): void {
    file.signed = null;
    file.body = null;
    file.usableUntilMs = 0;
  }

  /**
   * Signs the attempt's files that are to be sent and have no usable signature, in one call (two
   * slots on the same attempt share it). The records' bytes are made now: what is signed is what is
   * sent. A refusal is the files': the quota pauses the queue, a transient one or the attempt not
   * indexed yet is tried again later, any other fails them.
   */
  #sign(attempt: AttemptTask): Promise<void> {
    attempt.signing ??= this.#signNow(attempt).finally(() => {
      attempt.signing = null;
    });
    return attempt.signing;
  }

  async #signNow(attempt: AttemptTask): Promise<void> {
    const session = this.#sessions.get(attempt.sessionId);
    const asked = this.#env.now();
    if (session === undefined) {
      return;
    }
    // The records are made from what is known of them: attempt.json from the attempt's record,
    // session.json from the session's.
    const files = attempt.files.filter(
      (file) =>
        (file.stored.state === 'pending' || file.stored.state === 'uploading') &&
        !this.#usable(file, asked) &&
        (file.retryAtMs === null || file.retryAtMs <= asked) &&
        (file.kind !== 'attempt' || attempt.record !== null) &&
        (file.kind !== 'session' || session.text !== null),
    );
    if (files.length === 0) {
      return;
    }
    for (const file of files) {
      if (file.kind === 'attempt' && attempt.record !== null) {
        const text = attemptText(attempt.record);
        file.body = new Blob([text], { type: CONTENT_TYPES.attempt });
        file.stored.bytes = file.body.size;
        file.stored.hash = textHash(text);
      } else if (file.kind === 'session' && session.text !== null) {
        file.body = new Blob([session.text], { type: CONTENT_TYPES.session });
        file.stored.bytes = file.body.size;
        file.stored.hash = textHash(session.text);
      }
    }
    await this.#indexed();
    if (this.#status !== 'running') {
      return;
    }
    let signed: readonly SignedFile[];
    try {
      signed = await this.#cloud.signUpload({
        sessionId: attempt.sessionId,
        attemptIndex: attempt.index,
        files: files.map((file) => ({
          path: file.path,
          bytes: file.stored.bytes,
          contentType: CONTENT_TYPES[file.kind],
        })),
      });
    } catch (error: unknown) {
      const refusal = cloudErrorOf(error);
      if (refusal.code === 'resource-exhausted') {
        this.#pauseForQuota(resetsAtOf(refusal) ?? nextUtcDay(this.#env.now()));
        return;
      }
      for (const file of files) {
        if (refusal.code === 'not-found') {
          this.#failed(file, 'again', `not in the cloud index yet: ${refusal.message}`);
        } else {
          this.#failed(
            file,
            TRANSIENT_CODES.includes(refusal.code) ? 'again' : 'refused',
            `signUpload: ${refusal.message}`,
          );
        }
      }
      return;
    }
    const usableUntil = asked + URL_LIFETIME_MS - URL_MARGIN_MS;
    for (const file of files) {
      const answer = signed.find((candidate) => candidate.path === file.path);
      if (answer === undefined) {
        // Not in the answer: tried again later, rather than asked for again at once.
        this.#failed(file, 'again', 'signUpload did not sign it');
      } else {
        file.signed = answer;
        file.usableUntilMs = usableUntil;
      }
    }
  }

  /** Waits for the index's writes to reach the server, at most {@link INDEX_WAIT_MS}. */
  async #indexed(): Promise<void> {
    let timer: unknown = null;
    await Promise.race([
      this.#cloud.whenIndexed().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = this.#env.setTimeout(resolve, INDEX_WAIT_MS);
      }),
    ]);
    if (timer !== null) {
      this.#env.clearTimeout(timer);
    }
  }

  /**
   * Confirms `file` in the bucket: `done` once it is; `absent` when the bucket does not have it as
   * signed, which for a file that may not have been sent (`quietly`: before a reload, or after a
   * confirmation that failed) just means sending it; `failed` when the call failed, the file then
   * waiting for its next try (only the confirmation is tried again) or failed until Retry.
   */
  async #confirm(
    attempt: AttemptTask,
    file: FileTask,
    quietly: boolean,
  ): Promise<'done' | 'absent' | 'failed'> {
    let result;
    try {
      result = await this.#cloud.confirmUpload({
        sessionId: attempt.sessionId,
        attemptIndex: attempt.index,
        files: [{ path: file.path }],
      });
    } catch (error: unknown) {
      const refusal = cloudErrorOf(error);
      if (refusal.code === 'not-found' || refusal.code === 'failed-precondition') {
        // Not in the bucket with the size signed (or signed again meanwhile): it is sent again.
        this.#forgetSignature(file);
        if (quietly) {
          file.stored.state = 'pending';
          return 'absent';
        }
        this.#failed(file, 'again', `the bucket did not confirm it: ${refusal.message}`);
      } else if (TRANSIENT_CODES.includes(refusal.code)) {
        // It may be in the bucket: the confirmation is asked again first.
        file.confirmFirst = true;
        this.#failed(file, 'again', `confirmUpload: ${refusal.message}`);
      } else {
        this.#failed(file, 'refused', `confirmUpload: ${refusal.message}`);
      }
      return 'failed';
    }
    const confirmed = result.confirmed.find((entry) => entry.path === file.path);
    if (confirmed === undefined) {
      file.confirmFirst = true;
      this.#failed(file, 'again', 'confirmUpload did not confirm it');
      return 'failed';
    }
    this.#done(attempt, file, confirmed.doneMs);
    return 'done';
  }

  #done(attempt: AttemptTask, file: FileTask, doneMs: number): void {
    file.stored.state = 'done';
    file.stored.error = null;
    file.stored.doneMs = doneMs;
    file.sent = file.stored.bytes;
    file.failures = 0;
    file.retryAtMs = null;
    file.resigned = false;
    this.#forgetSignature(file);
    const session = this.#sessions.get(attempt.sessionId);
    if (file.kind === 'session' && session !== undefined && file.stored.hash !== undefined) {
      session.stored.sessionJson = { hash: file.stored.hash, bytes: file.stored.bytes };
    }
    if (file.kind === 'attempt' && attempt.record !== null) {
      // The record changed while it was being sent (a clip attached meanwhile): the new one goes too.
      const text = attemptText(attempt.record);
      const hash = textHash(text);
      if (hash !== file.stored.hash) {
        const entry = pending(utf8Bytes(text), file.stored, hash);
        attempt.stored.files[file.path] = entry;
        attempt.files = attempt.files.map((task) =>
          task === file ? this.#fileTask(file.path, entry) : task,
        );
      }
    }
    const wasComplete = attempt.complete;
    this.#updateComplete(attempt);
    if (attempt.complete && !wasComplete && session !== undefined) {
      const view = this.#attemptView(session, attempt);
      const again = this.#recent.findIndex(
        (recent) => recent.sessionId === view.sessionId && recent.index === view.index,
      );
      if (again >= 0) {
        this.#recent.splice(again, 1);
      }
      this.#recent.unshift(view);
      this.#recent.splice(RECENT_ATTEMPTS);
      this.#applyPolicySoon();
    }
    if (session !== undefined) {
      this.#planRider(session);
    }
    this.#persist();
    this.#notify();
  }

  /**
   * A try of `file` failed: `again`, it goes again after the backoff; `refused`, it is failed until
   * Retry.
   */
  #failed(file: FileTask, kind: 'again' | 'refused', message: string): void {
    file.stored.error = message;
    if (kind === 'refused') {
      file.stored.state = 'failed';
      file.retryAtMs = null;
      this.#forgetSignature(file);
    } else {
      file.stored.state = 'pending';
      file.failures++;
      file.retryAtMs = this.#env.now() + retryDelay(file.failures, this.#env.random());
    }
    this.#persist();
    this.#notify();
  }

  /**
   * Wakes the queue when the first file waiting after a failure may go again. A file whose time has
   * come already waits for something else (a slot, the network, the quota, its clips), each of which
   * pumps the queue when it frees: it needs no wake.
   */
  #armWake(): void {
    const now = this.#env.now();
    let first: number | null = null;
    for (const file of this.#allFiles()) {
      if (
        file.stored.state === 'pending' &&
        file.retryAtMs !== null &&
        file.retryAtMs > now &&
        !file.active
      ) {
        first = first === null ? file.retryAtMs : Math.min(first, file.retryAtMs);
      }
    }
    if (first === this.#wakeAtMs) {
      return;
    }
    if (this.#wakeTimer !== null) {
      this.#env.clearTimeout(this.#wakeTimer);
      this.#wakeTimer = null;
    }
    this.#wakeAtMs = first;
    if (first !== null && this.#status === 'running') {
      this.#wakeTimer = this.#env.setTimeout(
        () => {
          this.#wakeTimer = null;
          this.#wakeAtMs = null;
          this.#pump();
        },
        Math.max(0, first - this.#env.now()),
      );
    }
  }

  // ---- What holds the queue ----

  /** The day's quota is used up: nothing is signed until `untilMs` (at least a minute from now). */
  #pauseForQuota(untilMs: number): void {
    this.#state.pausedUntilMs = Math.max(untilMs, this.#env.now() + QUOTA_PAUSE_MIN_MS);
    this.#persist();
    this.#armQuotaTimer();
    this.#notify();
  }

  #quotaPaused(now: number): boolean {
    const until = this.#state.pausedUntilMs;
    return until !== null && now < until;
  }

  #armQuotaTimer(): void {
    if (this.#quotaTimer !== null) {
      this.#env.clearTimeout(this.#quotaTimer);
      this.#quotaTimer = null;
    }
    const until = this.#state.pausedUntilMs;
    if (until === null) {
      return;
    }
    this.#quotaTimer = this.#env.setTimeout(
      () => {
        this.#quotaTimer = null;
        if (this.#state.pausedUntilMs === until) {
          this.#state.pausedUntilMs = null;
          this.#persist();
        }
        this.#notify();
        this.#pump();
      },
      Math.max(0, until - this.#env.now()),
    );
  }

  #pause(): QueuePause | null {
    if (this.#hold !== null) {
      return { reason: this.#hold };
    }
    const until = this.#state.pausedUntilMs;
    return until !== null && this.#env.now() < until ? { reason: 'quota', untilMs: until } : null;
  }

  /** The network changed: held, the files being sent are cut off; free again, the queue goes on. */
  #onNetwork(): void {
    const hold = networkHold(this.#env.network(), this.#policy.wifiOnly);
    const was = this.#hold;
    this.#hold = hold;
    if (hold !== null) {
      for (const file of this.#allFiles()) {
        file.controller?.abort();
      }
    } else if (was !== null) {
      // Back online: what waits after a network failure goes now.
      for (const file of this.#allFiles()) {
        if (file.stored.state === 'pending') {
          file.retryAtMs = null;
          file.failures = 0;
        }
      }
    }
    this.#notify();
    this.#pump();
  }

  // ---- Deleting the uploaded clips ----

  #applyPolicySoon(): void {
    if (this.#policyDue || this.#status !== 'running') {
      return;
    }
    this.#policyDue = true;
    void this.#enqueue(async () => {
      this.#policyDue = false;
      await this.#applyPolicy();
    });
  }

  /**
   * Deletes uploaded clips from the device: without "Keep local copies", every clip of an attempt
   * all uploaded; and, from {@link STORAGE_DELETE_FROM} of the storage quota, the oldest uploaded
   * clips first until the use would be under {@link STORAGE_DELETE_TO}. uploads.json says which
   * (`local` false); the attempts' records are not changed (T4.2a).
   */
  async #applyPolicy(): Promise<void> {
    const plan = new Map<AttemptTask, string[]>();
    const add = (attempt: AttemptTask, file: FileTask): void => {
      const files = plan.get(attempt) ?? [];
      if (!files.includes(file.path)) {
        files.push(file.path);
      }
      plan.set(attempt, files);
    };
    const uploadedClips: [AttemptTask, FileTask][] = [];
    for (const session of this.#ordered()) {
      for (const attempt of this.#attemptsOf(session)) {
        for (const file of attempt.files) {
          if (file.kind === 'clip' && file.stored.state === 'done' && file.stored.local !== false) {
            uploadedClips.push([attempt, file]);
            if (!this.#policy.keepLocalCopies && attempt.complete) {
              add(attempt, file);
            }
          }
        }
      }
    }
    let storage: StorageEstimate | null;
    try {
      storage = await this.#env.storage();
    } catch {
      storage = null;
    }
    if (
      storage !== null &&
      storage.quota > 0 &&
      storage.usage > STORAGE_DELETE_FROM * storage.quota
    ) {
      let toFree = storage.usage - STORAGE_DELETE_TO * storage.quota;
      for (const [attempt, files] of plan) {
        for (const path of files) {
          toFree -= attempt.files.find((file) => file.path === path)?.stored.bytes ?? 0;
        }
      }
      for (const [attempt, file] of uploadedClips) {
        if (toFree <= 0) {
          break;
        }
        if (!(plan.get(attempt) ?? []).includes(file.path)) {
          add(attempt, file);
          toFree -= file.stored.bytes;
        }
      }
    }
    for (const [attempt, files] of plan) {
      if (this.#status !== 'running') {
        return;
      }
      const ref: AttemptRef = {
        session: attempt.sessionId,
        index: attempt.index,
        scrambleShown: attempt.stored.scrambleShown,
      };
      let removed: boolean;
      try {
        removed = await this.#source.removeClips(ref, files);
      } catch (error: unknown) {
        this.#error = `The uploaded clips of attempt ${String(attempt.index)} could not be deleted: ${messageOf(error)}`;
        this.#notify();
        continue;
      }
      if (!removed) {
        continue;
      }
      for (const path of files) {
        const file = attempt.files.find((candidate) => candidate.path === path);
        if (file !== undefined) {
          file.stored.local = false;
          this.#freed = {
            clips: this.#freed.clips + 1,
            bytes: this.#freed.bytes + file.stored.bytes,
          };
        }
      }
      this.#persist();
      this.#notify();
    }
  }

  // ---- Reading the queue ----

  /** The sessions that upload, the oldest first. */
  #ordered(): SessionTask[] {
    return [...this.#sessions.values()]
      .filter((session) => !session.simulated)
      .sort((p, q) => p.createdMs - q.createdMs || p.id.localeCompare(q.id));
  }

  #attemptsOf(session: SessionTask): AttemptTask[] {
    return [...session.attempts.values()].sort((p, q) => p.index - q.index);
  }

  *#allFiles(): Generator<FileTask> {
    for (const session of this.#sessions.values()) {
      for (const attempt of session.attempts.values()) {
        yield* attempt.files;
      }
    }
  }

  #updateComplete(attempt: AttemptTask): void {
    attempt.complete =
      attempt.files.length > 0 && attempt.files.every((file) => file.stored.state === 'done');
  }

  #attemptView(session: SessionTask, attempt: AttemptTask): AttemptView {
    const files = attempt.files.map((file): FileView => ({
      path: file.path,
      bytes: file.stored.bytes,
      state: file.stored.state,
      sent: file.stored.state === 'done' ? file.stored.bytes : file.sent,
      tries: file.stored.tries,
      error: file.stored.state === 'done' ? null : file.stored.error,
      retryAtMs: file.stored.state === 'pending' ? file.retryAtMs : null,
      local: file.stored.local !== false,
    }));
    let state: AttemptUploadState;
    if (files.some((file) => file.state === 'failed')) {
      state = 'failed';
    } else if (files.some((file) => file.state === 'uploading')) {
      state = 'uploading';
    } else if (files.some((file) => file.state === 'pending')) {
      state = this.#settled(attempt) ? 'pending' : 'waiting';
    } else {
      state = 'done';
    }
    return {
      sessionId: session.id,
      index: attempt.index,
      sessionCreatedMs: session.createdMs,
      state,
      files,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      sent: files.reduce((sum, file) => sum + file.sent, 0),
      error:
        files.find((file) => file.state === 'failed')?.error ??
        files.find((file) => file.retryAtMs !== null)?.error ??
        null,
    };
  }

  // ---- Plumbing ----

  /** Runs `operation` after the queue's earlier operations; it never rejects. */
  #enqueue(operation: () => void | Promise<void>): Promise<void> {
    // Stopped meanwhile, the operations still queued do nothing (no read, no call to the index).
    const run = this.#serial
      .then(() => (this.#status === 'stopped' ? undefined : operation()))
      .catch((error: unknown) => {
        this.#error = messageOf(error);
        this.#notify();
      });
    this.#serial = run;
    return run;
  }

  #rescanLater(): void {
    this.#rescanTimer = null;
    if (this.#status !== 'running') {
      return;
    }
    this.rescan();
    this.#applyPolicySoon();
    this.#rescanTimer = this.#env.setTimeout(() => {
      this.#rescanLater();
    }, RESCAN_MS);
  }

  /** Tells the listeners, once per turn of the event loop. */
  #notify(): void {
    if (this.#notifyQueued) {
      return;
    }
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const listener of [...this.#listeners]) {
        listener();
      }
    });
  }

  /** Tells the listeners of progress, at most every {@link PROGRESS_INTERVAL_MS}. */
  #notifyProgress(): void {
    if (this.#progressTimer !== null) {
      return;
    }
    this.#progressTimer = this.#env.setTimeout(() => {
      this.#progressTimer = null;
      this.#notify();
    }, PROGRESS_INTERVAL_MS);
  }
}

/** A pending entry for a file of `bytes`, keeping the tries of the entry it replaces. */
function pending(bytes: number, previous: StoredFile | undefined, hash?: string): StoredFile {
  const entry: StoredFile = {
    bytes,
    state: 'pending',
    tries: previous?.tries ?? 0,
    error: null,
    doneMs: null,
  };
  if (hash !== undefined) {
    entry.hash = hash;
  }
  return entry;
}

/** A done entry when the index says the bucket has `path` with `bytes`; else null. */
function fromCloud(
  cloud: CloudUpload | null,
  path: string,
  bytes: number,
  hash?: string,
): StoredFile | null {
  const file = cloud?.files[path];
  if (file?.doneMs === null || file === undefined || file.bytes !== bytes) {
    return null;
  }
  const entry: StoredFile = { bytes, state: 'done', tries: 0, error: null, doneMs: file.doneMs };
  if (hash !== undefined) {
    entry.hash = hash;
  }
  return entry;
}

/** The start of the UTC day after `ms`: when the functions' quota resets. */
function nextUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** ": <the start of `body`>" for an error, or nothing for an empty body. */
function excerpt(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text === '' ? '' : `: ${text.length > 160 ? `${text.slice(0, 157)}…` : text}`;
}

function isAbort(error: unknown): boolean {
  return nameOf(error) === 'AbortError';
}

function isNotFound(error: unknown): boolean {
  return nameOf(error) === 'NotFoundError';
}

function nameOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'name') : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof CloudError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
