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
  AttemptResync,
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
  AppBuild,
  BatteryReading,
  CameraClock,
  CameraIdentity,
  CameraInfo,
  ClapperboardSample,
  CubeInfo,
  HostInfo,
  MicrophoneInfo,
  MicrophoneProcessing,
  RemoteDevice,
  SessionRecord,
  SessionSettings,
  SessionSummary,
} from './session';
export { createSession, labelFor, sameCamera, summarize, withBattery } from './session';
export type { CubeClockParams } from './clock';
export { CLOCK_FIT_WINDOW, CLOCK_RESTART_DRIFT, CLOCK_RESTART_MS, CubeClockFit } from './clock';
// T4.0 — the clock sync of a remote camera: the offset and the drift of the phone's clock from pings
export type { RemoteClockParams, RemoteClockSample } from './remote-clock';
export {
  REMOTE_CLOCK_CONVERGED,
  REMOTE_CLOCK_DRIFT_SPAN_MS,
  REMOTE_CLOCK_RTT_FACTOR,
  REMOTE_CLOCK_WINDOW,
  RemoteClockFit,
} from './remote-clock';
export type { PhaseAverage } from './stats';
export { DNF, aoN, attemptTimes, best, mean, phaseAverages } from './stats';
export type { SessionStore } from './store';
export { MemorySessionStore } from './store';
export type { JsonSchema } from './schemas';
export {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_CANDIDATE_SCHEMA,
  CLOUD_CUBE_SCHEMA,
  CLOUD_EVENT_SCHEMA,
  CLOUD_PEER_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  FRAMES_SCHEMA,
  GYRO_SCHEMA,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  USER_SCHEMA,
} from './schemas';
// T2.0 — reading records of schema versions 1 and 2
export type { RecordFile } from './records';
export {
  RecordError,
  parseAttempt,
  parseCameraInfo,
  parseCloudAttempt,
  parseCloudCandidate,
  parseCloudCube,
  parseCloudEvent,
  parseCloudPeer,
  parseCloudSession,
  parseGyro,
  parseSession,
  parseSessionPairing,
} from './records';
// T3.7 — the cube's gyroscope stream: the ring buffer and the gyro file of an attempt
export type { GyroJson, GyroSummary, GyroWindow } from './gyro';
export {
  GYRO_BUFFER_MS,
  GYRO_BUFFER_RATE_HZ,
  GYRO_FILE,
  GYRO_LEAD_MS,
  GYRO_TAIL_MS,
  GyroBuffer,
  gyroFile,
  gyroIntervals,
  gyroSummary,
} from './gyro';
// T3.8 — the clip viewer's 3D cube: the cube's orientation from a gyro file, and a clip's time on the host clock
export type { CubeStep, GyroTrack, Mirror, Quat, Vec3 } from './orientation';
export {
  CUBE_TO_PLAYER,
  IDENTITY,
  MIRRORS,
  SAME_ORIENTATION,
  angleBetween,
  conjugate,
  cubeStep,
  dot,
  firstSampleAtOrAfter,
  fromAxisAngle,
  gyroTrack,
  isMirror,
  mirrored,
  multiply,
  normalize,
  orientationAt,
  referenceAt,
  rotate,
  sameOrientation,
  sampleAt,
  shownOrientation,
  slerp,
  toPlayerFrame,
} from './orientation';
export { clipHostMs, clipLagMs, clipSeconds } from './clip';
// T3.0 — the account's record in Firestore; T3.10 — the clip viewer's choice per camera in it
export type { UserRecord, UserRecordInput, ViewerChoice, ViewerChoices } from './user';
export {
  MAX_VIEWER_CHOICES,
  VIEWER_DEFAULT,
  changedViewerChoices,
  clampLatitude,
  isViewerChoice,
  mergeViewerChoices,
  normalizeLongitude,
  parseViewerChoices,
  sameViewerChoice,
  userRecord,
  viewerChoice,
} from './user';
// T3.1 — the session index in Firestore
export type {
  CloudAttempt,
  CloudAttemptFields,
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
  cloudAttemptFields,
  cloudSession,
  isSimulated,
  pendingUpload,
  sessionOfDocument,
} from './cloud';
// T3.4 — the account's cubes (their MAC addresses) in Firestore
export type { CloudCube, CloudCubeInput } from './cloud-cube';
export { CUBE_NAME, MAC_ADDRESS, cloudCube, isCubeDocumentName } from './cloud-cube';
// T3.9 — the account's diagnostics events in Firestore
export type {
  CloudEvent,
  CloudEventInput,
  CloudEventWrite,
  EventData,
  EventDevice,
  EventValue,
} from './cloud-event';
export {
  EVENT_DATA_MAX_KEYS,
  EVENT_ID,
  EVENT_KIND,
  EVENT_KIND_MAX_LENGTH,
  EVENT_TEXT_MAX_LENGTH,
  cloudEvent,
  eventId,
  isEventKind,
  sanitizeEventData,
  scrubEventText,
} from './cloud-event';
// T4.0 — the signaling documents of the remote cameras in Firestore, and the session's pairing
export type {
  CandidateSide,
  CloudCandidate,
  CloudPeer,
  CloudPeerInput,
  PeerState,
  SessionDescription,
  SessionPairing,
} from './cloud-peer';
export {
  CANDIDATE_COLLECTIONS,
  CANDIDATE_MAX_LENGTH,
  PEER_STATES,
  SDP_MAX_LENGTH,
  TOKEN_HASH,
  cloudCandidate,
  cloudPeer,
} from './cloud-peer';
