// Public API of @cubetrace/capture: the host's own camera (docs/PLAN.md, phase 2). Plain
// TypeScript: no Angular, and no browser global is touched at import time.

// T2.1 — camera: constraints, snapshots and controls, the sharpness meter, the framing rectangle.
export * from './camera';
export * from './framing';
export * from './sharpness';

// T2.2 — capture pipeline: encoding in a worker, the ring buffer, cuts. capture-worker.ts is not
// exported: it is the worker's own chunk (docs/TOOLCHAIN.md, "The capture pipeline").
export type {
  CaptureConfig,
  CaptureError,
  CaptureStats,
  DeleteClipParams,
  MotionSample,
  ResolvedCaptureConfig,
  SaveClipParams,
} from './protocol';
export { resolveCaptureConfig } from './protocol';
export type { CaptureHandle, CaptureSupport } from './pipeline';
export {
  AUDIO_PROCESSOR_BUFFER,
  CUT_TIMEOUT_MS,
  SAVE_CLIP_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  VIDEO_PROCESSOR_BUFFER,
  captureSupport,
  createCaptureWorker,
  createClipWorker,
  startCapture,
} from './pipeline';
export type { ArrivalFit, Cut, CutAudio, CutFrames, CutOptions, CutVideo } from './cut';
export { arrivalFit, cut, cutBuffers, frameIntervals } from './cut';
export type {
  AudioTrackInfo,
  EncodedChunkRecord,
  RingBufferBounds,
  VideoTrackInfo,
} from './ring-buffer';
export { DEFAULT_BOUNDS, RingBuffer } from './ring-buffer';

// T2.3 — clips: `CaptureHandle.saveClip` (above) has a cut muxed into an MP4 (mux.ts, with
// mediabunny) and written with its frames.json into the attempt's folder (clip-writer.ts); since
// T2.4 the clip worker (clip-worker.ts) does both, apart from the capture worker. Those files are the
// worker's and are not exported here, so that mediabunny stays in the worker's chunk; where a
// clip's files are is.
export type { ClipFiles } from './clip-files';
export { attemptPath, clipFiles } from './clip-files';

// T2.5 — the clapperboard: the camera's lag behind the cube, from the motion the capture worker
// measures in the framing rectangle during a sync check (`CaptureHandle.watchMotion`). motion.ts,
// which measures it, is the worker's and is not exported, so that it stays in the worker's chunk.
export type {
  ClapperboardAnalysis,
  ClapperboardFailure,
  ClapperboardFit,
  ClapperboardResult,
} from './clapperboard';
export {
  MATCH_WINDOW_MS,
  MAX_SPREAD_MS,
  MIN_MATCHES,
  MIN_ONSET_ENERGY,
  ONSET_FACTOR,
  ONSET_QUIET_MS,
  SINGLE_TURN_MS,
  SYNC_CHECK_MS,
  detectClapperboard,
  findOnsets,
  frameHostTimes,
  matchOnsets,
  onsetThreshold,
  percentile,
  singleTurns,
} from './clapperboard';

// T2.10 — the video quality: the encoder's bitrate, which the app also shows for each quality.
export type { VideoQuality } from './bitrate';
export { BITRATE_AT_1080P30, videoBitrate } from './bitrate';
