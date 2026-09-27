// The names of a clip's files and folders (docs/DATA-MODEL.md §5):
//
//   sessions/<sessionId>/attempts/<index>/<camera>.<segment>.mp4
//   sessions/<sessionId>/attempts/<index>/<camera>.<segment>.frames.json
//
// and of the temporary files they are written under. The folders and the temporary names are the
// session store's (packages/storage/src/opfs-session-store.ts), repeated here because this file
// runs in the capture worker, which cannot import @cubetrace/storage: its index brings
// @cubetrace/core, and with it cubing.js, into the worker's build (docs/TOOLCHAIN.md).
// clip-files.test.ts checks that both agree. Pure TypeScript.
import type { VideoSegment } from '@cubetrace/core';

/** The folder of every session, at the root of the file system (as the session store's). */
export const SESSIONS_FOLDER = 'sessions';
/** The folder of a session's attempts, inside the session's folder (as the session store's). */
export const ATTEMPTS_FOLDER = 'attempts';

/**
 * A camera's label (docs/DATA-MODEL.md §5 and §6): lowercase letters and digits in words joined by
 * hyphens (`laptop`, `phone-front`, `phone-2`), so that a clip's file names split at their dots.
 */
export const CAMERA_LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The two clips of an attempt (docs/DATA-MODEL.md §7). */
export const VIDEO_SEGMENTS: readonly VideoSegment[] = ['scramble', 'solve'];

/** The MP4 and the frame times of one clip, as named in its `video[]` entry. */
export interface ClipFiles {
  /** `<camera>.<segment>.mp4` */
  readonly file: string;
  /** `<camera>.<segment>.frames.json` */
  readonly framesFile: string;
}

/**
 * The file names of the clip of `camera` for `segment`. Throws a RangeError for a label that is not
 * a camera label or a segment other than `scramble` and `solve`: they name files, and the schemas
 * refuse them.
 */
export function clipFiles(camera: string, segment: VideoSegment): ClipFiles {
  if (!CAMERA_LABEL.test(camera)) {
    throw new RangeError(
      `"${camera}" is not a camera label (lowercase letters and digits in words joined by hyphens).`,
    );
  }
  if (!VIDEO_SEGMENTS.includes(segment)) {
    throw new RangeError(`"${segment}" is not a segment (scramble or solve).`);
  }
  return { file: `${camera}.${segment}.mp4`, framesFile: `${camera}.${segment}.frames.json` };
}

/**
 * The folder of attempt `index`: 1-based, zero-padded to 4 digits (`0001`, `0017`), as the session
 * store names it. Throws a RangeError on anything but a positive integer.
 */
export function attemptFolder(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`An attempt's index is a positive integer, got ${String(index)}.`);
  }
  return String(index).padStart(4, '0');
}

/**
 * The folders from the file system's root to that of attempt `index` of session `sessionId`:
 * `['sessions', sessionId, 'attempts', '0001']`, where the attempt's clips are. Throws a RangeError
 * for an index that is not a positive integer.
 */
export function attemptPath(sessionId: string, index: number): string[] {
  return [SESSIONS_FOLDER, sessionId, ATTEMPTS_FOLDER, attemptFolder(index)];
}

/**
 * A fresh temporary name for a write of the file `name`, `<name>.<8 base-36 digits>.tmp`, as the
 * session store makes them (docs/DATA-MODEL.md §5).
 */
export function temporaryName(name: string): string {
  const random = Math.floor(Math.random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0');
  return `${name}.${random}.tmp`;
}

/** Whether `entry` names a temporary file of `name` (see `temporaryName`). */
export function isTemporaryOf(entry: string, name: string): boolean {
  return entry.startsWith(`${name}.`) && /^[0-9a-z]+\.tmp$/.test(entry.slice(name.length + 1));
}
