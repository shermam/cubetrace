// Public API of @cubetrace/upload: the upload queue of phase 3 (docs/PLAN.md T3.3), over the device's
// sessions (the session store and the origin private file system), the upload's functions and the
// PUTs to signed URLs. Plain TypeScript: no Angular, and no browser global is touched at import time.
export type { ConfirmRequest, ConfirmResult, FileToSign, SignRequest, SignedFile } from './api';
export { CloudError, JSON_TYPE, MP4_TYPE, TRANSIENT_CODES, cloudErrorOf, resetsAtOf } from './api';
export { RETRY_FIRST_MS, RETRY_MAX_MS, retryDelay } from './backoff';
export type { AttemptFile, UploadFileKind } from './files';
export {
  ATTEMPT_JSON,
  CONTENT_TYPES,
  SESSION_JSON,
  attemptText,
  attemptUploadFiles,
  datasetAttempt,
  sessionText,
  textHash,
} from './files';
export type { ConnectionInfo, NetworkHold } from './network';
export { networkHold } from './network';
export type { OpfsUploadSourceOptions } from './opfs-source';
export { OpfsUploadSource } from './opfs-source';
export type {
  AttemptRef,
  PutRequest,
  PutResponse,
  StorageEstimate,
  UploadCloud,
  UploadEnvironment,
  UploadHttp,
  UploadPolicy,
  UploadSource,
} from './ports';
export type {
  AttemptUploadState,
  AttemptView,
  FileView,
  QueuePause,
  QueueStatus,
  QueueView,
  UploadQueueOptions,
} from './queue';
export {
  INDEX_WAIT_MS,
  PARALLEL_UPLOADS,
  QUOTA_PAUSE_MIN_MS,
  SESSION_QUIET_MS,
  STORAGE_DELETE_FROM,
  STORAGE_DELETE_TO,
  URL_LIFETIME_MS,
  UploadQueue,
} from './queue';
export type {
  AccountQueueState,
  FileState,
  QueueStateFile,
  StoredAttempt,
  StoredFile,
  StoredSession,
} from './state';
export {
  QUEUE_STATE_SCHEMA,
  UPLOADS_FILE,
  emptyState,
  parseQueueState,
  queueStateText,
} from './state';
export type { FakeCall, FakePut, FakeResponse } from './testing';
export { FakeBucket, FakeUploadCloud, FakeUploadEnvironment, FakeUploadHttp } from './testing';
export type { XhrLike } from './xhr';
export { xhrHttp } from './xhr';
