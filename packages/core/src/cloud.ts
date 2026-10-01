// The session index in Firestore (docs/DATA-MODEL.md §10, docs/PLAN.md T3.1): `sessions/{id}`, a
// session's session.json with the account that owns it, and `sessions/{id}/attempts/{index}`, an
// attempt's attempt.json without its moves, with its owner, the device that recorded it and the state
// of its upload. Through them the Sessions page of every device of an account lists the sessions of
// the others, and the QA view counts what was recorded and what is uploaded; the files of §5 stay the
// records. A document has the schema version of the record it copies (2), and is JSON, as Firestore
// stores it: the builders here make JSON copies of the records.
import type { AttemptRecord } from './attempt';
import type { SessionRecord } from './session';

/**
 * Where an attempt's upload is (the upload queue, T3.3): `pending`, nothing sent yet, which the index
 * writes; `uploading`; `done`, every file confirmed by the upload's function (T3.2); `failed`.
 */
export type CloudUploadState = 'pending' | 'uploading' | 'done' | 'failed';

/** Every {@link CloudUploadState}, in the order an upload goes through them. */
export const CLOUD_UPLOAD_STATES: readonly CloudUploadState[] = [
  'pending',
  'uploading',
  'done',
  'failed',
];

/** One file of an attempt's upload: an entry of `upload.files`. */
export interface CloudUploadFile {
  /** The file's size, in bytes, as the device that recorded it has it. */
  bytes: number;
  /** When its upload was confirmed, in ms (T3.3); null until then. */
  doneMs: number | null;
}

/** `upload` of an attempt's document. */
export interface CloudUpload {
  state: CloudUploadState;
  /**
   * The files of the attempt's folder (docs/DATA-MODEL.md §5) by their name: `attempt.json`, and each
   * clip's `<camera>.<segment>.mp4` and `<camera>.<segment>.frames.json`.
   */
  files: Record<string, CloudUploadFile>;
}

/** `device` of an attempt's document: what recorded it, by which the QA view groups the attempts. */
export interface CloudDevice {
  /** The host label of its session (Settings → This device; `host.label` in session.json). */
  host: string;
  /** The labels of its session's cameras (`cameras` in session.json), in their order. */
  cameras: string[];
}

/** `sessions/{id}`: a session's session.json with its owner (schema version 2, the record's). */
export interface CloudSession extends SessionRecord {
  /** The Firebase Authentication uid of the account that wrote it, which the rules require. */
  owner: string;
}

/**
 * `sessions/{id}/attempts/{index}`: an attempt's attempt.json without `moves` (they stay on the device
 * and in the uploaded attempt.json), with its owner, its device and the state of its upload.
 */
export interface CloudAttempt extends Omit<AttemptRecord, 'moves'> {
  /** The uid of the account that wrote it, as its session's (the rules require it on both). */
  owner: string;
  device: CloudDevice;
  upload: CloudUpload;
}

/** The name of an attempt's record in its folder (docs/DATA-MODEL.md §5). */
const ATTEMPT_FILE_NAME = 'attempt.json';

/**
 * The id of an attempt's document: its index zero-padded to 4 digits, as its folder's name
 * (docs/DATA-MODEL.md §5), so that the documents of a session sort by index. Throws on anything but a
 * positive integer.
 */
export function attemptDocumentId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`An attempt's index is a positive integer, got ${String(index)}.`);
  }
  return String(index).padStart(4, '0');
}

/**
 * A demo session: its cube is the fake cube, whose hardware is `simulated` (`@cubetrace/gan`'s
 * `FAKE_CUBE_HARDWARE`). Its attempts are replays of recorded solves, so it never goes to the cloud.
 */
export function isSimulated(session: Pick<SessionRecord, 'cube'>): boolean {
  return session.cube.hardware === 'simulated';
}

/**
 * The files of an attempt's folder that its upload sends, in order: `attempt.json`, then each clip's
 * MP4 and frames file.
 */
export function attemptFiles(attempt: Pick<AttemptRecord, 'video'>): string[] {
  return [ATTEMPT_FILE_NAME, ...attempt.video.flatMap((clip) => [clip.file, clip.framesFile])];
}

/** An upload that has not begun: each file of `bytes` (sizes by file name) pending. */
export function pendingUpload(bytes: Readonly<Record<string, number>>): CloudUpload {
  return {
    state: 'pending',
    files: Object.fromEntries(
      Object.entries(bytes).map(([file, size]) => [file, { bytes: size, doneMs: null }]),
    ),
  };
}

/** `sessions/{id}` of `session`, owned by the account `owner`: a JSON copy of the record. */
export function cloudSession(session: SessionRecord, owner: string): CloudSession {
  return { ...jsonCopy(session), owner };
}

/**
 * `sessions/{id}/attempts/{index}` of `attempt`, owned by the account `owner`: a JSON copy of the
 * record without its moves, the device of `session` (its host label and its cameras' labels) and
 * `upload`.
 */
export function cloudAttempt(input: {
  attempt: AttemptRecord;
  session: SessionRecord;
  owner: string;
  upload: CloudUpload;
}): CloudAttempt {
  const { attempt, session, owner, upload } = input;
  const copy: Partial<AttemptRecord> = jsonCopy(attempt);
  delete copy.moves;
  return {
    ...(copy as Omit<AttemptRecord, 'moves'>),
    owner,
    device: { host: session.host.label, cameras: session.cameras.map((camera) => camera.label) },
    upload: jsonCopy(upload),
  };
}

/** The session.json that a session's document copies: the document without its owner. */
export function sessionOfDocument(document: CloudSession): SessionRecord {
  const copy: Partial<CloudSession> = jsonCopy(document);
  delete copy.owner;
  return copy as SessionRecord;
}

/**
 * A copy of `value` as JSON has it: what Firestore stores (no `undefined`, no shared objects), so
 * that a document never carries what the record's file would not.
 */
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
