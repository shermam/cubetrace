// Public API of @cubetrace/storage: where the app keeps sessions. Phase 1 has the session store over
// the origin private file system (docs/DATA-MODEL.md §5); phase 3 adds the upload queue. Plain
// TypeScript: no Angular, and no browser global is touched at import time.
export type {
  OpfsDirectoryHandle,
  OpfsFileHandle,
  OpfsNavigator,
  OpfsSyncAccessHandle,
  OpfsWritable,
} from './opfs';
export { isNotFound, opfsAvailable } from './opfs';
export type { ProblemReporter, StorageProblem } from './opfs-session-store';
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
} from './opfs-session-store';
export type { FakeOpfsOptions } from './fake-opfs';
export { FakeDirectoryHandle, FakeFileHandle } from './fake-opfs';
