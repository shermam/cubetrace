// The queue's state on the device (docs/DATA-MODEL.md §10, "The upload queue"): `uploads.json` at the
// root of the origin private file system, beside `sessions/`, so that a reload, or the next start,
// resumes where the queue was. Per account (its uid), per session and per attempt (by its folder's
// name, `0001`), each file's state with its size, its tries and its last error; per session the
// session.json last confirmed in the bucket; and until when the day's quota holds the queue.

/** The file's name, at the root of the origin private file system. */
export const UPLOADS_FILE = 'uploads.json';

/** The version of uploads.json's own format. */
export const QUEUE_STATE_SCHEMA = 1;

/**
 * Where a file's upload is: `pending` (to sign and to send), `uploading` (signed and being sent, or
 * sent and being confirmed), `done` (confirmed in the bucket), `failed` (refused for good: Retry
 * puts it back).
 */
export type FileState = 'pending' | 'uploading' | 'done' | 'failed';

export const FILE_STATES: readonly FileState[] = ['pending', 'uploading', 'done', 'failed'];

/** A file of an attempt's upload, as uploads.json keeps it. */
export interface StoredFile {
  /** Its size: what it is signed for. */
  bytes: number;
  /** For attempt.json and session.json, made from their records: the hash of the text. */
  hash?: string;
  state: FileState;
  /** The tries of its upload so far (each `PUT` begun, or a confirmation of one sent before a reload). */
  tries: number;
  /** Why its last try failed; null once it is done, and before any failure. */
  error: string | null;
  /** When the bucket confirmed it, ms since 1970 on the server's clock; null until then. */
  doneMs: number | null;
  /** A clip's MP4 deleted from the device after its upload (T3.3); absent while it is there. */
  local?: false;
}

/** An attempt's upload: the attempt it is (its scramble's time tells a begun-again one) and its files. */
export interface StoredAttempt {
  /** `events.scrambleShown` of the attempt, so that another attempt with its index starts afresh. */
  scrambleShown: number;
  /** By name: attempt.json, the clips' MP4s and frames files, and session.json when it rides along. */
  files: Record<string, StoredFile>;
}

/** A session's uploads. */
export interface StoredSession {
  /** The session.json last confirmed in the bucket: the hash of its text and its size; null before. */
  sessionJson: { hash: string; bytes: number } | null;
  /** By the attempt's folder name, `0001`. */
  attempts: Record<string, StoredAttempt>;
}

/** An account's queue on this device. */
export interface AccountQueueState {
  /**
   * The day's upload quota is used up until then (`resetsAtMs` of the refusal, ms since 1970 on the
   * server's clock): nothing is signed before; null when it is not.
   */
  pausedUntilMs: number | null;
  /** By session id. */
  sessions: Record<string, StoredSession>;
}

/** uploads.json. */
export interface QueueStateFile {
  schema: typeof QUEUE_STATE_SCHEMA;
  /** By the account's uid: a device signed in with two accounts uploads each one's sessions apart. */
  accounts: Record<string, AccountQueueState>;
}

/** An empty state. */
export function emptyState(): QueueStateFile {
  return { schema: QUEUE_STATE_SCHEMA, accounts: {} };
}

/**
 * uploads.json's text, read: what it holds that is well formed. A file that is not JSON, or of
 * another version, reads as empty (the cloud's index then says what is uploaded); an entry that is
 * not well formed is left out.
 */
export function parseQueueState(text: string | null): QueueStateFile {
  if (text === null) {
    return emptyState();
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return emptyState();
  }
  if (!isRecord(json) || json['schema'] !== QUEUE_STATE_SCHEMA || !isRecord(json['accounts'])) {
    return emptyState();
  }
  const accounts: Record<string, AccountQueueState> = {};
  for (const [uid, value] of Object.entries(json['accounts'])) {
    const account = readAccount(value);
    if (account !== null) {
      accounts[uid] = account;
    }
  }
  return { schema: QUEUE_STATE_SCHEMA, accounts };
}

/**
 * uploads.json's text for `state`: compact JSON (it is the queue's, rewritten often), the fields
 * that hold their default (no tries, no error, not confirmed, still on the device) left out.
 */
export function queueStateText(state: QueueStateFile): string {
  return JSON.stringify(state, (key, value: unknown) => {
    if (
      (key === 'tries' && value === 0) ||
      ((key === 'error' || key === 'doneMs') && value === null)
    ) {
      return undefined;
    }
    return value;
  });
}

function readAccount(value: unknown): AccountQueueState | null {
  if (!isRecord(value)) {
    return null;
  }
  const paused = value['pausedUntilMs'];
  const sessions: Record<string, StoredSession> = {};
  if (isRecord(value['sessions'])) {
    for (const [id, session] of Object.entries(value['sessions'])) {
      const read = readSession(session);
      if (read !== null) {
        sessions[id] = read;
      }
    }
  }
  return {
    pausedUntilMs: typeof paused === 'number' && Number.isFinite(paused) ? paused : null,
    sessions,
  };
}

function readSession(value: unknown): StoredSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const json = value['sessionJson'];
  const sessionJson =
    isRecord(json) && typeof json['hash'] === 'string' && isCount(json['bytes'])
      ? { hash: json['hash'], bytes: json['bytes'] }
      : null;
  const attempts: Record<string, StoredAttempt> = {};
  if (isRecord(value['attempts'])) {
    for (const [folder, attempt] of Object.entries(value['attempts'])) {
      const read = /^\d{4,}$/.test(folder) ? readAttempt(attempt) : null;
      if (read !== null) {
        attempts[folder] = read;
      }
    }
  }
  return { sessionJson, attempts };
}

function readAttempt(value: unknown): StoredAttempt | null {
  if (!isRecord(value) || typeof value['scrambleShown'] !== 'number') {
    return null;
  }
  const files: Record<string, StoredFile> = {};
  if (isRecord(value['files'])) {
    for (const [path, file] of Object.entries(value['files'])) {
      const read = readFile(file);
      if (read !== null) {
        files[path] = read;
      }
    }
  }
  return { scrambleShown: value['scrambleShown'], files };
}

function readFile(value: unknown): StoredFile | null {
  if (!isRecord(value) || !isCount(value['bytes'])) {
    return null;
  }
  const state = FILE_STATES.find((known) => known === value['state']);
  if (state === undefined) {
    return null;
  }
  const tries = value['tries'];
  const error = value['error'];
  const doneMs = value['doneMs'];
  const file: StoredFile = {
    bytes: value['bytes'],
    state,
    tries: isCount(tries) ? tries : 0,
    error: typeof error === 'string' ? error : null,
    doneMs: typeof doneMs === 'number' && Number.isFinite(doneMs) ? doneMs : null,
  };
  if (typeof value['hash'] === 'string') {
    file.hash = value['hash'];
  }
  if (value['local'] === false) {
    file.local = false;
  }
  return file;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
