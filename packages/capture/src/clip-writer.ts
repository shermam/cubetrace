// Writing a clip into its attempt's folder (docs/PLAN.md, T2.3; docs/DATA-MODEL.md §5):
//
//   sessions/<sessionId>/attempts/<index>/<camera>.<segment>.mp4
//   sessions/<sessionId>/attempts/<index>/<camera>.<segment>.frames.json
//
// in the origin private file system, each file written whole under a temporary name next to it and
// then moved over its own name, as the session store writes its records (packages/storage, T1.11),
// so that a clip file is never half written. The clip worker writes the files' bytes through
// access handles (`createSyncAccessHandle`, dedicated workers only); where there are none, a
// writable stream does it. Plain TypeScript over the structural OPFS types of @cubetrace/storage
// (types only: see clip-files.ts), so it runs in Node's tests on the in-memory fake.
import type { FramesJson, VideoClip, VideoSegment } from '@cubetrace/core';
import type { OpfsDirectoryHandle, OpfsFileHandle } from '@cubetrace/storage';

import { attemptPath, clipFiles, isTemporaryOf, temporaryName } from './clip-files';

/** What the clip's `video[]` entry says that neither file name nor frames.json does. */
export interface ClipDetails {
  /** The video track's codec string: the muxer's `info.codec`. */
  readonly codec: string;
  /** The audio track's codec string, or null: the muxer's `info.audio`. */
  readonly audio: string | null;
  /** Of the encoded frames. */
  readonly width: number;
  readonly height: number;
  /** The frame rate the camera's track reported. */
  readonly fpsNominal: number;
  /** The clip begins later than asked (its start was older than the buffer): the muxer's `info`. */
  readonly truncatedStart: boolean;
}

/**
 * Writes the clip of `camera` for `segment` into the folder of attempt `index` of session
 * `sessionId` (the folder is made if needed; the session's must exist) and returns its `video[]`
 * entry (docs/DATA-MODEL.md §7), with `crop` and `syncResidualMs` null for the caller to fill.
 * `frames.json` is written as compact JSON. A clip saved again replaces the files as a whole.
 *
 * Both files are first written under temporary names (`<name>.<random>.tmp`), then moved into
 * place, the frames file first, so that an MP4 is never without its frames file and neither is ever
 * half written: a page that goes away in the middle leaves the previous files (or none) and
 * temporary files, which the next write or deletion of the same clip removes. A write that fails
 * removes its temporary files and rejects. Where file handles have no `move()` (Chrome before 111)
 * the files are written in place, as the session store does.
 *
 * Rejects with a RangeError for a camera label or segment that cannot name a clip, an index that is
 * not a positive integer, a session id that cannot name a folder, frames of another clip, an empty
 * MP4 or a frame rate that is not positive; with "No session …" when the session's folder is
 * missing; and with the file system's error otherwise (a full disk: `QuotaExceededError`).
 */
export async function writeClip(
  root: OpfsDirectoryHandle,
  sessionId: string,
  index: number,
  camera: string,
  segment: VideoSegment,
  mp4: ArrayBuffer,
  frames: FramesJson,
  details: ClipDetails,
): Promise<VideoClip> {
  const names = clipFiles(camera, segment);
  const path = attemptPath(sessionId, index);
  checkSessionId(sessionId);
  if (frames.camera !== camera || frames.segment !== segment) {
    throw new RangeError(
      `The frames are those of ${frames.camera}.${frames.segment}, not of ${camera}.${segment}.`,
    );
  }
  if (mp4.byteLength === 0) {
    throw new RangeError('The MP4 is empty.');
  }
  if (!(details.fpsNominal > 0)) {
    throw new RangeError(
      `The nominal frame rate must be positive, got ${String(details.fpsNominal)}.`,
    );
  }
  const json = new TextEncoder().encode(`${JSON.stringify(frames)}\n`);
  const dir = await attemptDir(root, path, true);
  if (dir === null) {
    throw new Error(`No session ${sessionId}: its folder is missing.`);
  }
  await removeTemporaries(dir, names);
  // The frames file first: an MP4 in the folder always has its frames file.
  await writeAll(dir, [
    { name: names.framesFile, bytes: json },
    { name: names.file, bytes: new Uint8Array(mp4) },
  ]);
  return {
    camera,
    segment,
    file: names.file,
    bytes: mp4.byteLength,
    codec: details.codec,
    audio: details.audio,
    width: details.width,
    height: details.height,
    crop: null,
    fpsNominal: details.fpsNominal,
    frames: frames.dtMs.length,
    firstFrameHostMs: frames.t0HostMs,
    framesFile: names.framesFile,
    syncResidualMs: null,
    truncatedStart: details.truncatedStart,
  };
}

/**
 * Removes the clip of `camera` for `segment` from the folder of attempt `index` of session
 * `sessionId`: its MP4, its frames file and their temporary files. Nothing to remove is not an
 * error (the clip, the attempt's folder or the session may be gone); the attempt's folder and its
 * other files stay. Rejects with a RangeError for names that cannot be a clip's (as `writeClip`),
 * and with the file system's error otherwise (a file being written: `NoModificationAllowedError`).
 */
export async function deleteClip(
  root: OpfsDirectoryHandle,
  sessionId: string,
  index: number,
  camera: string,
  segment: VideoSegment,
): Promise<void> {
  const names = clipFiles(camera, segment);
  const path = attemptPath(sessionId, index);
  checkSessionId(sessionId);
  const dir = await attemptDir(root, path, false);
  if (dir === null) {
    return;
  }
  const doomed: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && ownFile(entry.name, names)) {
      doomed.push(entry.name);
    }
  }
  for (const name of doomed) {
    try {
      await dir.removeEntry(name);
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}

/**
 * Removes the clip of `camera` for `segment` from the folder of attempt `index` of session
 * `sessionId`, as `deleteClip` does, only while its frames file says its first frame is at
 * `firstFrameHostMs` (`t0HostMs`): so a clip saved for an attempt that is gone goes, and a newer clip
 * of the same name (the next attempt with that index) stays. Resolves to whether it removed it:
 * false when the frames file is missing, unreadable, or another clip's. Rejects as `deleteClip`.
 */
export async function deleteClipIf(
  root: OpfsDirectoryHandle,
  sessionId: string,
  index: number,
  camera: string,
  segment: VideoSegment,
  firstFrameHostMs: number,
): Promise<boolean> {
  const names = clipFiles(camera, segment);
  const path = attemptPath(sessionId, index);
  checkSessionId(sessionId);
  const dir = await attemptDir(root, path, false);
  if (dir === null) {
    return false;
  }
  let t0HostMs: unknown;
  try {
    const text = await (await (await dir.getFileHandle(names.framesFile)).getFile()).text();
    t0HostMs = (JSON.parse(text) as { t0HostMs?: unknown }).t0HostMs;
  } catch (error: unknown) {
    if (isNotFound(error) || error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
  if (t0HostMs !== firstFrameHostMs) {
    return false;
  }
  await deleteClip(root, sessionId, index, camera, segment);
  return true;
}

/** Whether `error` is the `NotFoundError` DOMException the File System API rejects with. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'NotFoundError'
  );
}

/** A session id names a folder: not empty, not `.` or `..`, without a slash. */
function checkSessionId(sessionId: string): void {
  if (sessionId === '' || sessionId === '.' || sessionId === '..' || /[/\\]/.test(sessionId)) {
    throw new RangeError(`"${sessionId}" cannot name a session folder.`);
  }
}

/**
 * The folder of an attempt at `path` (`attemptPath`): its last two folders made if `create` (the
 * session's must exist), else null when it is missing, as when the session is.
 */
async function attemptDir(
  root: OpfsDirectoryHandle,
  path: readonly string[],
  create: boolean,
): Promise<OpfsDirectoryHandle | null> {
  try {
    let dir = root;
    for (const [depth, name] of path.entries()) {
      // sessions/<sessionId> must exist; attempts/<index> are made.
      dir = await dir.getDirectoryHandle(name, { create: create && depth >= 2 });
    }
    return dir;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/** Whether `name` is one of the clip's files or a temporary file of one of them. */
function ownFile(name: string, names: { file: string; framesFile: string }): boolean {
  return [names.file, names.framesFile].some((own) => name === own || isTemporaryOf(name, own));
}

/**
 * Removes the temporary files of the clip's files that earlier writes cut short left in `dir`:
 * best effort, since another write of the same clip may hold one (Chrome refuses to remove a file
 * being written).
 */
async function removeTemporaries(
  dir: OpfsDirectoryHandle,
  names: { file: string; framesFile: string },
): Promise<void> {
  const leftovers: string[] = [];
  for await (const entry of dir.values()) {
    if (
      entry.kind === 'file' &&
      ownFile(entry.name, names) &&
      entry.name !== names.file &&
      entry.name !== names.framesFile
    ) {
      leftovers.push(entry.name);
    }
  }
  await removeQuietly(dir, leftovers);
}

/** Removes the files `names` from `dir`, ignoring failures. */
async function removeQuietly(dir: OpfsDirectoryHandle, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await dir.removeEntry(name).catch(() => undefined);
  }
}

/** A file's name and its whole content. */
interface FileBytes {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Writes `files` into `dir`, each whole and in one step: all of them under temporary names, then
 * each moved over its own name, in order. A failure removes the temporary files not moved yet.
 * Where file handles have no `move()` (Chrome before 111), the files are written in place, as the
 * session store writes then.
 */
async function writeAll(dir: OpfsDirectoryHandle, files: readonly FileBytes[]): Promise<void> {
  const handles: OpfsFileHandle[] = [];
  const temporaries: string[] = [];
  let moved = 0;
  try {
    for (const { name, bytes } of files) {
      const file = await dir.getFileHandle(temporaryName(name), { create: true });
      handles.push(file);
      temporaries.push(file.name);
      if (file.move === undefined) {
        break;
      }
      await writeBytes(file, bytes);
    }
    if (handles.some((file) => file.move === undefined)) {
      await removeQuietly(dir, temporaries.splice(0));
      for (const { name, bytes } of files) {
        await writeBytes(await dir.getFileHandle(name, { create: true }), bytes);
      }
      return;
    }
    for (const [at, file] of handles.entries()) {
      if (file.move !== undefined) {
        await file.move(files[at].name);
      }
      moved = at + 1;
    }
  } catch (error: unknown) {
    await removeQuietly(dir, temporaries.slice(moved));
    throw error;
  }
}

/**
 * Replaces the content of `file` with `bytes`: through an access handle where the file has one (in
 * a dedicated worker: synchronous writes, no copy into a swap file), else through a writable
 * stream.
 */
async function writeBytes(file: OpfsFileHandle, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  if (file.createSyncAccessHandle !== undefined) {
    const access = await file.createSyncAccessHandle();
    try {
      access.truncate(0);
      let at = 0;
      while (at < bytes.byteLength) {
        const written = access.write(bytes.subarray(at), { at });
        if (written <= 0) {
          throw new Error(
            `Writing ${file.name} stopped at byte ${String(at)} of ${String(bytes.byteLength)}.`,
          );
        }
        at += written;
      }
      access.flush();
    } finally {
      access.close();
    }
    return;
  }
  const writable = await file.createWritable();
  try {
    await writable.write(bytes);
  } catch (error: unknown) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
  await writable.close();
}
