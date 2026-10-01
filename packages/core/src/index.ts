// Public API of @cubetrace/core. Plain TypeScript: no Angular, no browser-only globals at import time.
export type { Face, Move } from './notation';
export {
  NotationError,
  formatMove,
  formatMoves,
  inverse,
  inverseSequence,
  parseMove,
  parseMoves,
  quarterTurns,
} from './notation';
export type { Facelets } from './cube';
export {
  FACE_ORDER,
  SOLVED,
  applyMove,
  applyMoves,
  assertFacelets,
  faceletsOf,
  isSolved,
  isSolvedIgnoringOrientation,
} from './cube';
export type { CornerPos, EdgePos } from './pieces';
export {
  CORNER_FACELETS,
  EDGE_FACELETS,
  adjacentFaces,
  cornerAt,
  edgeAt,
  opposite,
} from './pieces';
// T1.2 — scrambles
export type { ScrambleMoveState, ScrambleProgress } from './scramble';
export { ScrambleTracker, generateScramble, scrambleTarget } from './scramble';
// T1.3 — CFOP phases
export type { DetectPhasesOptions, PhaseName, PhaseRecord, PhaseReport, TimedMove } from './phases';
export {
  PHASE_NAMES,
  crossComplete,
  detectPhases,
  eollComplete,
  f2lSlotsComplete,
  ocllComplete,
} from './phases';
// T1.4 — attempts, sessions, clock, stats, store
export type {
  AttemptEvents,
  AttemptMove,
  AttemptOptions,
  AttemptPhase,
  AttemptRecord,
  AttemptResult,
  AttemptState,
  CropRect,
  CubeMoveInput,
  FramesJson,
  MovePhase,
  VideoClip,
  VideoSegment,
} from './attempt';
export { AttemptMachine } from './attempt';
export type {
  CameraClock,
  CameraInfo,
  ClapperboardSample,
  CubeInfo,
  HostInfo,
  MicrophoneInfo,
  MicrophoneProcessing,
  SessionRecord,
  SessionSettings,
  SessionSummary,
} from './session';
export { createSession, summarize } from './session';
export type { CubeClockParams } from './clock';
export { CLOCK_FIT_WINDOW, CLOCK_RESTART_DRIFT, CLOCK_RESTART_MS, CubeClockFit } from './clock';
export type { PhaseAverage } from './stats';
export { DNF, aoN, attemptTimes, best, mean, phaseAverages } from './stats';
export type { SessionStore } from './store';
export { MemorySessionStore } from './store';
export type { JsonSchema } from './schemas';
export {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  FRAMES_SCHEMA,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  USER_SCHEMA,
} from './schemas';
// T2.0 — reading records of schema versions 1 and 2
export type { RecordFile } from './records';
export {
  RecordError,
  parseAttempt,
  parseCloudAttempt,
  parseCloudSession,
  parseSession,
} from './records';
// T3.0 — the account's record in Firestore
export type { UserRecord, UserRecordInput } from './user';
export { userRecord } from './user';
// T3.1 — the session index in Firestore
export type {
  CloudAttempt,
  CloudDevice,
  CloudSession,
  CloudUpload,
  CloudUploadFile,
  CloudUploadState,
} from './cloud';
export {
  CLOUD_UPLOAD_STATES,
  attemptDocumentId,
  attemptFiles,
  cloudAttempt,
  cloudSession,
  isSimulated,
  pendingUpload,
  sessionOfDocument,
} from './cloud';
