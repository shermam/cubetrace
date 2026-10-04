// What the queue uploads of an attempt (docs/DATA-MODEL.md §5): its attempt.json as the dataset holds
// it, each clip's MP4 and frames file, its gyro file when it has one (T3.7), and session.json, the
// session's, which rides with one of the session's attempts. The JSON records are uploaded as the
// session store writes them (`recordJson`): the bytes the URL is signed for are made from the record
// when it is signed.
import type { AttemptRecord, SessionRecord, VideoClip } from '@cubetrace/core';
import { GYRO_FILE } from '@cubetrace/core';
import { recordJson } from '@cubetrace/storage';

import { JSON_TYPE, MP4_TYPE } from './api';

/** The name of an attempt's record, and of its session's, in their folders. */
export const ATTEMPT_JSON = 'attempt.json';
export const SESSION_JSON = 'session.json';
/** The name of an attempt's gyro file in its folder (T3.7). */
export const GYRO_JSON = GYRO_FILE;

/**
 * The kind of a file of the upload: a record (made from it), a clip's file or the gyro file (read
 * from OPFS as they are).
 */
export type UploadFileKind = 'attempt' | 'session' | 'clip' | 'frames' | 'gyro';

/** The content type of each kind, which the signature binds. */
export const CONTENT_TYPES: Readonly<Record<UploadFileKind, string>> = {
  attempt: JSON_TYPE,
  session: JSON_TYPE,
  clip: MP4_TYPE,
  frames: JSON_TYPE,
  gyro: JSON_TYPE,
};

/**
 * `attempt` as the dataset holds it: without `local` on its clips, which said whether a clip's MP4
 * was still on the device that recorded it (T3.3; the records written before T4.2a may have it, and
 * the app sets it in memory for its pages): in the bucket, every clip is beside its attempt.json.
 */
export function datasetAttempt(attempt: AttemptRecord): AttemptRecord {
  return {
    ...attempt,
    video: attempt.video.map((clip): VideoClip => {
      const copy = { ...clip };
      delete copy.local;
      return copy;
    }),
  };
}

/** The text of `attempt`'s attempt.json as it is uploaded: {@link datasetAttempt}, as the store writes it. */
export function attemptText(attempt: AttemptRecord): string {
  return recordJson(datasetAttempt(attempt));
}

/** The text of `session`'s session.json as it is uploaded: as the store writes it. */
export function sessionText(session: SessionRecord): string {
  return recordJson(session);
}

/** The size of `text` in UTF-8, the bytes it is uploaded as. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * A hash of `text` (two 32-bit FNV-1a passes, in hex): what tells the queue that a record changed
 * since it was uploaded, without keeping the record. Not a cryptographic hash: a change it misses
 * would be one of the same length that collides in 64 bits.
 */
export function textHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** A file of an attempt's folder that its upload sends: its name, its kind, and its clip's. */
export interface AttemptFile {
  readonly path: string;
  readonly kind: UploadFileKind;
  /** The clip the file belongs to (its MP4 or its frames file); null for attempt.json and gyro.json. */
  readonly clip: VideoClip | null;
}

/**
 * The files of `attempt` that its upload sends, in order: attempt.json, then each clip's MP4 and
 * frames file, then its gyro file when the record names one (T3.7: the attempt's sixth file with one
 * camera). A clip's MP4 deleted from the device is still listed: the queue knows it as done.
 */
export function attemptUploadFiles(attempt: Pick<AttemptRecord, 'video' | 'gyro'>): AttemptFile[] {
  return [
    { path: ATTEMPT_JSON, kind: 'attempt', clip: null },
    ...attempt.video.flatMap((clip): AttemptFile[] => [
      { path: clip.file, kind: 'clip', clip },
      { path: clip.framesFile, kind: 'frames', clip },
    ]),
    ...(attempt.gyro === null
      ? []
      : [{ path: attempt.gyro.file, kind: 'gyro' as const, clip: null }]),
  ];
}

/** The kind of the file named `path` in an attempt's upload. */
export function kindOf(path: string): UploadFileKind {
  if (path === ATTEMPT_JSON) {
    return 'attempt';
  }
  if (path === SESSION_JSON) {
    return 'session';
  }
  if (path === GYRO_JSON) {
    return 'gyro';
  }
  return path.endsWith('.mp4') ? 'clip' : 'frames';
}
