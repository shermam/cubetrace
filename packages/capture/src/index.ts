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
