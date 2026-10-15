// Fakes of the capture pipeline for the unit tests of the recording (T2.4): a `CaptureHandle` whose
// clips the test saves or fails when it says, and a `CaptureStarter` that hands them out. Nothing in
// the app imports this file, so it is not in the bundle.
import type {
  CaptureConfig,
  CaptureError,
  CaptureHandle,
  CaptureStats,
  CaptureSupport,
  ClipMotion,
  ClipReport,
  Cut,
  DeleteClipParams,
  FramingRect,
  MotionMeterInfo,
  MotionSample,
  SaveClipParams,
  SavedClip,
} from '@cubetrace/capture';
import type { VideoClip } from '@cubetrace/core';

import type { CaptureStarter } from './recording-service';

/** A clip `saveClip` was asked for, waiting for the test to answer it. */
export interface PendingSave {
  readonly params: SaveClipParams;
  resolve(saved: SavedClip): void;
  reject(error: Error): void;
}

/** The report of a clip saved as asked, with its sound, from a buffer of 90 s. */
export const CLIP_AS_ASKED: ClipReport = {
  lateMs: 0,
  bufferSeconds: 90,
  audioMissing: null,
  audioRebasedMs: 0,
  audioConfigMade: false,
  frameIntervalMs: 33.3,
};

/** The counters of a pipeline that has buffered `seconds`. */
export function statsOf(seconds: number, changes: Partial<CaptureStats> = {}): CaptureStats {
  return {
    fps: 30,
    encodedFps: 30,
    dropped: 0,
    queue: 0,
    bufferSeconds: seconds,
    bufferBytes: Math.round(seconds * 1_000_000),
    codec: 'vp09.00.40.08',
    bitrate: 4_000_000,
    audioCodec: 'opus',
    audioChunks: Math.round(seconds * 50),
    audioState: 'encoding',
    latency: null,
    motion: { state: 'off', costMs: null },
    postedHostMs: 0,
    ...changes,
  };
}

/**
 * The clip the pipeline would save for `params`: its first frame at the keyframe at or before the
 * start (a whole second of the capture clock, here), 30 frames per second to the end.
 */
export function clipFor(params: SaveClipParams): VideoClip {
  const firstFrameHostMs = Math.floor(params.startHostMs / 1000) * 1000;
  return {
    camera: params.camera,
    segment: params.segment,
    file: `${params.camera}.${params.segment}.mp4`,
    bytes: 100_000,
    codec: 'vp09.00.40.08',
    audio: 'opus',
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: params.fpsNominal,
    frames: Math.max(1, Math.round(((params.endHostMs - firstFrameHostMs) * 30) / 1000)),
    firstFrameHostMs,
    framesFile: `${params.camera}.${params.segment}.frames.json`,
    syncResidualMs: null,
    truncatedStart: false,
    // T5.3: as the clip writer leaves them, for the capture's latencies and the window's motion.
    captureLatencyMs: null,
    encodeLatencyMs: null,
    motionPeakMs: null,
    motionSpreadMs: null,
    motionLagMs: null,
  };
}

/** The motion watch of a sync check (T2.5): its rectangle, and the samples the test sends it. */
export interface MotionWatchCall {
  readonly rect: FramingRect | null;
  readonly onSample: (sample: MotionSample) => void;
  readonly onError: ((message: string) => void) | undefined;
  /** Where the test says how the frames are read (T2.8). */
  readonly onMeter: ((meter: MotionMeterInfo) => void) | undefined;
  /** Whether its stop was called. */
  stopped: boolean;
}

/** A running pipeline: the test answers its clips and sends its counters and errors. */
export class FakeCapture implements CaptureHandle {
  readonly saves: PendingSave[] = [];
  readonly deletions: DeleteClipParams[] = [];
  /** The motion watches asked for, the last one the one under way. */
  readonly watches: MotionWatchCall[] = [];
  /** The solves' motion meter as it was turned on and off (T5.3), in order. */
  readonly meters: { readonly on: boolean; readonly rect: FramingRect | null }[] = [];
  stopped = false;
  private readonly statsListeners = new Set<(stats: CaptureStats) => void>();
  private readonly errorListeners = new Set<(error: CaptureError) => void>();

  constructor(
    readonly video: MediaStreamTrack,
    readonly audio: MediaStreamTrack | null,
    readonly config: CaptureConfig,
  ) {}

  cut(): Promise<Cut> {
    return Promise.reject(new Error('The recording does not cut.'));
  }

  saveClip(params: SaveClipParams): Promise<SavedClip> {
    if (this.stopped) {
      return Promise.reject(new Error('The capture has stopped.'));
    }
    return new Promise((resolve, reject) => {
      this.saves.push({ params, resolve, reject });
    });
  }

  deleteClip(params: DeleteClipParams): Promise<boolean> {
    this.deletions.push(params);
    return Promise.resolve(true);
  }

  watchMotion(
    rect: FramingRect | null,
    onSample: (sample: MotionSample) => void,
    onError?: (message: string) => void,
    onMeter?: (meter: MotionMeterInfo) => void,
  ): () => void {
    const call: MotionWatchCall = { rect, onSample, onError, onMeter, stopped: false };
    this.watches.push(call);
    return () => {
      call.stopped = true;
    };
  }

  meterMotion(on: boolean, rect: FramingRect | null): void {
    this.meters.push({ on, rect });
  }

  /** Whether the solves' motion meter is on now (T5.3). */
  get metering(): boolean {
    return this.meters.at(-1)?.on ?? false;
  }

  onStats(listener: (stats: CaptureStats) => void): () => void {
    this.statsListeners.add(listener);
    return () => {
      this.statsListeners.delete(listener);
    };
  }

  onError(listener: (error: CaptureError) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  emitStats(stats: CaptureStats): void {
    for (const listener of this.statsListeners) {
      listener(stats);
    }
  }

  emitError(error: CaptureError): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  /**
   * Saves the oldest clip asked for (as `clipFor` says, with `changes`), with its report (as asked,
   * with `report`'s changes) and the motion of its frames (T5.3; none by default); returns the clip.
   */
  saveNext(
    changes: Partial<VideoClip> = {},
    report: Partial<ClipReport> = {},
    motion: ClipMotion | null = null,
  ): VideoClip {
    const pending = this.saves.shift();
    if (pending === undefined) {
      throw new Error('No clip was asked for.');
    }
    const clip = { ...clipFor(pending.params), ...changes };
    pending.resolve({ clip, report: { ...CLIP_AS_ASKED, ...report }, motion });
    return clip;
  }

  /** Fails the oldest clip asked for with `message`. */
  failNext(message: string): void {
    const pending = this.saves.shift();
    if (pending === undefined) {
      throw new Error('No clip was asked for.');
    }
    pending.reject(new Error(message));
  }
}

/** Starts a {@link FakeCapture} each time; `supported` false plays a browser without the APIs. */
export class FakeCaptureStarter implements CaptureStarter {
  supported = true;
  readonly started: FakeCapture[] = [];

  support(): CaptureSupport {
    return this.supported
      ? { supported: true, missing: [] }
      : { supported: false, missing: ['MediaStreamTrackProcessor'] };
  }

  start(
    video: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    config: CaptureConfig,
  ): CaptureHandle {
    const capture = new FakeCapture(video, audio, config);
    this.started.push(capture);
    return capture;
  }

  /** The pipeline started last. */
  get last(): FakeCapture {
    const capture = this.started.at(-1);
    if (capture === undefined) {
      throw new Error('No pipeline was started.');
    }
    return capture;
  }
}
