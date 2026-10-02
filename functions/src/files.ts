// What the upload functions accept: the files of the dataset (docs/DATA-MODEL.md §5), named as in an
// attempt's folder, and where each one goes in the bucket. The functions are deployed on their own, so
// the names' rules are restated here rather than imported from packages/core.
import { HttpsError } from 'firebase-functions/https';

/** The content type that each kind of file is uploaded with; the signed URL binds it. */
export const JSON_TYPE = 'application/json';
export const MP4_TYPE = 'video/mp4';

/**
 * At most this many files in one call: an attempt has 2 (`attempt.json` and `gyro.json`, T3.7) plus
 * 4 per camera, plus `session.json`.
 */
export const MAX_FILES_PER_CALL = 33;

/** At most this many characters in a file's name (a camera's label is a word or two). */
export const MAX_PATH_LENGTH = 128;

// A camera's label is lowercase letters and digits in words joined by hyphens; a segment is the
// scramble or the solve (§5). The session's id is a lowercase UUID v4 (§6).
const CAMERA = '[a-z0-9]+(?:-[a-z0-9]+)*';
const SEGMENT = '(?:scramble|solve)';
const CLIP = new RegExp(`^${CAMERA}\\.${SEGMENT}\\.mp4$`);
const FRAMES = new RegExp(`^${CAMERA}\\.${SEGMENT}\\.frames\\.json$`);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `session.json` is the session's, uploaded with one of its attempts; every other file is the attempt's. */
export const SESSION_FILE = 'session.json';

/** The attempt's gyroscope file (docs/DATA-MODEL.md §11, T3.7), JSON like its record. */
export const GYRO_FILE = 'gyro.json';

/** A file to upload, as `signUpload` receives it. */
export interface FileToSign {
  /** Its name in the attempt's folder: `attempt.json`, `laptop.solve.mp4`, …, or `session.json`. */
  readonly path: string;
  /** Its size: the upload must be exactly this long. */
  readonly bytes: number;
  /** `application/json` or `video/mp4`, as its name says. */
  readonly contentType: string;
}

/** The attempt a call is about. */
export interface AttemptRef {
  readonly sessionId: string;
  /** 1-based, as in `attempt.json`. */
  readonly attemptIndex: number;
}

export interface SignRequest extends AttemptRef {
  readonly files: readonly FileToSign[];
}

export interface ConfirmRequest extends AttemptRef {
  readonly paths: readonly string[];
}

/**
 * The content type of the file named `path`, or null when the dataset has no such file:
 * `attempt.json`, `session.json`, `gyro.json` and `<camera>.<segment>.frames.json` are JSON,
 * `<camera>.<segment>.mp4` is MP4.
 */
export function contentTypeOf(path: string): string | null {
  if (path.length > MAX_PATH_LENGTH) {
    return null;
  }
  if (path === 'attempt.json' || path === SESSION_FILE || path === GYRO_FILE || FRAMES.test(path)) {
    return JSON_TYPE;
  }
  return CLIP.test(path) ? MP4_TYPE : null;
}

/**
 * The folder, and the attempt document's id, of attempt `index`: 1-based, zero-padded to 4 digits
 * (`0001`, `0017`; `12345` from ten thousand on), as the session store names it (§5).
 */
export function attemptFolder(index: number): string {
  return String(index).padStart(4, '0');
}

/**
 * Where the file `path` of attempt `attemptIndex` of session `sessionId` goes in the bucket, under
 * the account's own prefix: `users/{uid}/sessions/{sessionId}/attempts/{index}/{path}`, and
 * `users/{uid}/sessions/{sessionId}/session.json` for the session's file.
 */
export function objectKey(uid: string, ref: AttemptRef, path: string): string {
  const session = `users/${uid}/sessions/${ref.sessionId}`;
  return path === SESSION_FILE
    ? `${session}/${SESSION_FILE}`
    : `${session}/attempts/${attemptFolder(ref.attemptIndex)}/${path}`;
}

/** Reads `signUpload`'s argument, or throws `invalid-argument` saying what is wrong with it. */
export function parseSignRequest(data: unknown, maxFileBytes: number): SignRequest {
  const record = parseRecord(data);
  const files = parseList(record['files']).map((value, i): FileToSign => {
    const file = isRecord(value) ? value : refuse(`files[${String(i)}] is not an object.`);
    const { path, contentType } = parsePath(file['path'], i);
    const bytes = file['bytes'];
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) {
      refuse(`files[${String(i)}].bytes is not a whole number of bytes above zero.`);
    }
    if (bytes > maxFileBytes) {
      refuse(
        `files[${String(i)}] (${path}) has ${String(bytes)} bytes, more than the ${String(maxFileBytes)} a file may have.`,
      );
    }
    if (file['contentType'] !== contentType) {
      refuse(`files[${String(i)}].contentType is not ${contentType}, the type of ${path}.`);
    }
    return { path, bytes, contentType };
  });
  refuseDuplicates(files.map((file) => file.path));
  return { ...parseAttemptRef(record), files };
}

/** Reads `confirmUpload`'s argument, or throws `invalid-argument` saying what is wrong with it. */
export function parseConfirmRequest(data: unknown): ConfirmRequest {
  const record = parseRecord(data);
  const paths = parseList(record['files']).map(
    (value, i) => parsePath(isRecord(value) ? value['path'] : undefined, i).path,
  );
  refuseDuplicates(paths);
  return { ...parseAttemptRef(record), paths };
}

function parseRecord(data: unknown): Record<string, unknown> {
  return isRecord(data) ? data : refuse('The argument is not an object.');
}

function parseAttemptRef(record: Record<string, unknown>): AttemptRef {
  const sessionId = record['sessionId'];
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    refuse('sessionId is not a session id (a lowercase UUID v4).');
  }
  const attemptIndex = record['attemptIndex'];
  if (typeof attemptIndex !== 'number' || !Number.isSafeInteger(attemptIndex) || attemptIndex < 1) {
    refuse("attemptIndex is not an attempt's index (a whole number from 1).");
  }
  return { sessionId, attemptIndex };
}

function parseList(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    refuse('files is not a list of files.');
  }
  if (value.length > MAX_FILES_PER_CALL) {
    refuse(`files has ${String(value.length)} files, more than ${String(MAX_FILES_PER_CALL)}.`);
  }
  return value as unknown[];
}

function parsePath(value: unknown, i: number): { path: string; contentType: string } {
  const contentType = typeof value === 'string' ? contentTypeOf(value) : null;
  if (typeof value !== 'string' || contentType === null) {
    refuse(
      `files[${String(i)}].path is not a file of the dataset (attempt.json, session.json, ` +
        'gyro.json, <camera>.<segment>.mp4 or <camera>.<segment>.frames.json).',
    );
  }
  return { path: value, contentType };
}

function refuseDuplicates(paths: readonly string[]): void {
  const twice = paths.find((path, i) => paths.indexOf(path) !== i);
  if (twice !== undefined) {
    refuse(`files names ${twice} twice.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(message: string): never {
  throw new HttpsError('invalid-argument', message);
}
