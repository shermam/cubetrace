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
  SessionRecord,
  SessionSettings,
  SessionSummary,
} from './session';
export { createSession, summarize } from './session';
export type { CubeClockParams } from './clock';
export { CLOCK_FIT_WINDOW, CubeClockFit } from './clock';
export type { PhaseAverage } from './stats';
export { DNF, aoN, attemptTimes, best, mean, phaseAverages } from './stats';
export type { SessionStore } from './store';
export { MemorySessionStore } from './store';
export type { JsonSchema } from './schemas';
export {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  FRAMES_SCHEMA,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
} from './schemas';
// T2.0 — reading records of schema versions 1 and 2
export type { RecordFile } from './records';
export { RecordError, parseAttempt, parseSession } from './records';
