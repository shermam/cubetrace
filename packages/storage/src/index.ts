// Public API of @cubetrace/storage: where the app keeps sessions, the session store over the origin
// private file system (docs/DATA-MODEL.md §5); the upload queue of phase 3 is @cubetrace/upload,
// which reads the store's files and writes its own state beside them. Plain TypeScript: no Angular,
// and no browser global is touched at import time.
export type {
  OpfsDirectoryHandle,
  OpfsFile,
  OpfsFileHandle,
  OpfsNavigator,
  OpfsSyncAccessHandle,
  OpfsWritable,
} from './opfs';
export { isNotFound, opfsAvailable } from './opfs';
export type { FileContent, ProblemReporter, StorageProblem } from './opfs-session-store';
export {
  ATTEMPTS_FOLDER,
  ATTEMPT_FILE,
  OpfsSessionStore,
  SESSIONS_FOLDER,
  SESSION_FILE,
  attemptFolder,
  describeProblem,
  isTemporaryOf,
  recordJson,
  temporaryName,
  writeAttemptFile,
  writeTextFile,
} from './opfs-session-store';
export type { FakeOpfsOptions } from './fake-opfs';
export { FakeDirectoryHandle, FakeFileHandle } from './fake-opfs';
