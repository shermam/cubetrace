import type { AttemptRecord, SessionStore, VideoClip } from '@cubetrace/core';
import type { ProblemReporter } from '@cubetrace/storage';

import type { AttemptFiles } from './attempt-files';

/** The session store as `SessionService` uses it: the OPFS one also lists what it could not read. */
type TrackedStore = SessionStore & Partial<ProblemReporter>;

/**
 * Which clips' MP4s this device still holds is the device's to know, not the dataset's (T4.2a): the
 * upload queue deletes an uploaded clip's MP4 by policy and keeps that in `uploads.json`, the
 * attempt's record stays as it was uploaded, and the pages learn it from the attempt's folder.
 * `store`, for `SessionService`: an attempt it saves is written without `local` on its clips (the
 * app's copies in memory have it, and the records written before T4.2a may), so that neither the
 * record, nor its document in the index, nor what the upload queue is told, changes when a clip
 * leaves the device; and the attempts it reads have `local: false` on each clip whose MP4 is not in
 * their folder, from one listing of the session's folders (`files.list`). Without a listing (no
 * origin private file system, a test's stand-in), or when it fails, they are as they were written.
 */
export function clipsOnDevice(
  store: TrackedStore,
  files: Pick<AttemptFiles, 'list'>,
): TrackedStore {
  const onDevice = async (
    sessionId: string,
    attempts: AttemptRecord[],
  ): Promise<AttemptRecord[]> => {
    if (files.list === undefined || attempts.every((attempt) => attempt.video.length === 0)) {
      return attempts;
    }
    let folders: ReadonlyMap<number, ReadonlySet<string>>;
    try {
      folders = await files.list(sessionId);
    } catch {
      return attempts;
    }
    return attempts.map((attempt) => withClipsOnDevice(attempt, folders.get(attempt.index)));
  };
  const tracked: TrackedStore = {
    createSession: (session) => store.createSession(session),
    saveSession: (session) => store.saveSession(session),
    saveAttempt: (attempt) => store.saveAttempt(withoutLocal(attempt)),
    deleteAttempt: (sessionId, index) => store.deleteAttempt(sessionId, index),
    deleteSession: (sessionId) => store.deleteSession(sessionId),
    listSessions: () => store.listSessions(),
    loadAttempts: async (sessionId) => onDevice(sessionId, await store.loadAttempts(sessionId)),
    exportSession: async (sessionId) => {
      const { session, attempts } = await store.exportSession(sessionId);
      return { session, attempts: await onDevice(sessionId, attempts) };
    },
  };
  const listProblems = store.listProblems?.bind(store);
  if (listProblems !== undefined) {
    tracked.listProblems = listProblems;
  }
  return tracked;
}

/**
 * `attempt` with `local: false` on each clip whose MP4 is not among `names`, the files of its folder,
 * and no `local` on the others; as it is when its folder is not known (`names` undefined).
 */
export function withClipsOnDevice(
  attempt: AttemptRecord,
  names: ReadonlySet<string> | undefined,
): AttemptRecord {
  if (names === undefined || attempt.video.length === 0) {
    return attempt;
  }
  return {
    ...attempt,
    video: attempt.video.map((clip) =>
      names.has(clip.file) ? clipWithoutLocal(clip) : { ...clip, local: false },
    ),
  };
}

/** `attempt` as the dataset holds it: without `local` on its clips. */
export function withoutLocal(attempt: AttemptRecord): AttemptRecord {
  return attempt.video.some((clip) => clip.local !== undefined)
    ? { ...attempt, video: attempt.video.map(clipWithoutLocal) }
    : attempt;
}

function clipWithoutLocal(clip: VideoClip): VideoClip {
  if (clip.local === undefined) {
    return clip;
  }
  const copy = { ...clip };
  delete copy.local;
  return copy;
}
