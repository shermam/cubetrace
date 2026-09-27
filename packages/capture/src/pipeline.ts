// The window's side of the capture pipeline (docs/PLAN.md, T2.2). Chrome has
// MediaStreamTrackProcessor on the window only (docs/DEVICES.md), so the window turns the camera's
// tracks into streams of frames and audio, moves the streams to the capture worker, and relays cuts
// and counters; it never touches a frame. Plain TypeScript: no Angular.
import type { Cut } from './cut';
import {
  isWorkerToWindow,
  post,
  resolveCaptureConfig,
  type CaptureConfig,
  type CaptureError,
  type CaptureStats,
  type WorkerToWindow,
} from './protocol';
import type { MediaStreamTrackProcessorConstructor } from './webcodecs';

/** A running capture: cuts, counters, errors, and the way to stop it. */
export interface CaptureHandle {
  /**
   * The chunks from the last keyframe at or before `startHostMs` to the last frame at or before
   * `endHostMs`, with the audio that overlaps them (host ms, `performance.timeOrigin +
   * performance.now()`). Rejects when nothing is buffered there, once the capture has stopped, or
   * when the worker does not answer within `CUT_TIMEOUT_MS`.
   */
  cut(startHostMs: number, endHostMs: number): Promise<Cut>;
  /** `listener` gets the counters once per second; call the returned function to stop. */
  onStats(listener: (stats: CaptureStats) => void): () => void;
  /**
   * `listener` hears when recording stops by itself (`fatal`: the encoder failed or the camera's
   * track ended; the buffer stays, cuts still work) or loses its audio (not `fatal`).
   */
  onError(listener: (error: CaptureError) => void): () => void;
  /** Stops recording and frees the buffer and the worker; the stream's tracks keep running. */
  stop(): Promise<void>;
}

/** The browser APIs the pipeline needs, and the missing ones by name. */
export interface CaptureSupport {
  readonly supported: boolean;
  readonly missing: readonly string[];
}

/** How long a cut may take before `cut()` gives up on the worker. */
export const CUT_TIMEOUT_MS = 10_000;

/** How long `stop()` waits for the worker to close its encoders before terminating it. */
export const STOP_TIMEOUT_MS = 2000;

const REQUIRED_APIS = ['MediaStreamTrackProcessor', 'VideoEncoder', 'Worker'];

/** Whether `scope` (the window) has what `startCapture` needs: Chrome does, others lack some. */
export function captureSupport(scope: object = globalThis): CaptureSupport {
  const missing = REQUIRED_APIS.filter((name) => typeof member(scope, name) !== 'function');
  return { supported: missing.length === 0, missing };
}

/**
 * Starts the capture worker on the stream's first video track and, unless `config.audio` is
 * false, its first audio track. Throws when the browser lacks MediaStreamTrackProcessor or the
 * stream has no video track. `workerFactory` is for tests; by default the capture worker starts
 * from its own chunk.
 */
export function startCapture(
  stream: MediaStream,
  config: CaptureConfig = {},
  workerFactory: () => Worker = createCaptureWorker,
): CaptureHandle {
  const Processor = member(globalThis, 'MediaStreamTrackProcessor');
  if (typeof Processor !== 'function') {
    throw new Error('This browser has no MediaStreamTrackProcessor: recording video needs Chrome.');
  }
  const TrackProcessor = Processor as MediaStreamTrackProcessorConstructor;
  const videoTrack = stream.getVideoTracks().at(0);
  if (videoTrack === undefined) {
    throw new Error('The stream has no video track.');
  }
  const resolved = resolveCaptureConfig(config);
  const audioTrack = resolved.audio ? stream.getAudioTracks().at(0) : undefined;
  const video = new TrackProcessor<VideoFrame>({ track: videoTrack }).readable;
  const audio =
    audioTrack === undefined ? null : new TrackProcessor<AudioData>({ track: audioTrack }).readable;
  let worker: Worker;
  try {
    worker = workerFactory();
  } catch (error: unknown) {
    // The processors would otherwise hold the tracks' frames for a reader that never comes.
    void video.cancel();
    void audio?.cancel();
    throw error;
  }
  const capture = new Capture(worker);
  post(worker, {
    type: 'start',
    video,
    audio,
    config: resolved,
    frameRate: videoTrack.getSettings().frameRate ?? null,
  });
  return capture;
}

/**
 * The capture worker as a module worker. Angular's application builder recognises exactly this
 * `new Worker(new URL('…', import.meta.url))` form, bundles capture-worker.ts on its own and
 * rewrites the URL to the emitted chunk (docs/TOOLCHAIN.md, "The capture pipeline").
 */
export function createCaptureWorker(): Worker {
  return new Worker(new URL('./capture-worker.ts', import.meta.url), { type: 'module' });
}

interface PendingCut {
  readonly resolve: (cut: Cut) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class Capture implements CaptureHandle {
  readonly #worker: Worker;
  readonly #cuts = new Map<number, PendingCut>();
  readonly #statsListeners = new Set<(stats: CaptureStats) => void>();
  readonly #errorListeners = new Set<(error: CaptureError) => void>();
  #nextId = 1;
  #stopping: Promise<void> | undefined;
  #stopped: (() => void) | undefined;

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener('message', this.#onMessage);
    worker.addEventListener('error', this.#onWorkerError);
  }

  cut(startHostMs: number, endHostMs: number): Promise<Cut> {
    if (this.#stopping !== undefined) {
      return Promise.reject(new Error('The capture has stopped.'));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<Cut>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#cuts.delete(id);
        reject(new Error(`The capture worker did not answer within ${String(CUT_TIMEOUT_MS)} ms.`));
      }, CUT_TIMEOUT_MS);
      this.#cuts.set(id, { resolve, reject, timer });
      post(this.#worker, { type: 'cut', id, startHostMs, endHostMs });
    });
  }

  onStats(listener: (stats: CaptureStats) => void): () => void {
    this.#statsListeners.add(listener);
    return () => {
      this.#statsListeners.delete(listener);
    };
  }

  onError(listener: (error: CaptureError) => void): () => void {
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<void>((resolve) => {
      this.#stopped = resolve;
      timer = setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    post(this.#worker, { type: 'stop' });
    await stopped;
    clearTimeout(timer);
    this.#worker.removeEventListener('message', this.#onMessage);
    this.#worker.removeEventListener('error', this.#onWorkerError);
    this.#worker.terminate();
    for (const [id, pending] of this.#cuts) {
      this.#cuts.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error('The capture has stopped.'));
    }
    this.#statsListeners.clear();
    this.#errorListeners.clear();
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (isWorkerToWindow(message)) {
      this.#receive(message);
    }
  };

  readonly #onWorkerError = (event: ErrorEvent): void => {
    event.preventDefault();
    const reason = event.message === '' ? 'it could not start' : event.message;
    this.#emitError({ message: `The capture worker failed: ${reason}`, fatal: true });
  };

  #receive(message: WorkerToWindow): void {
    switch (message.type) {
      case 'stats':
        for (const listener of this.#statsListeners) {
          listener(message.stats);
        }
        break;
      case 'cut-done':
        this.#settle(message.id)?.resolve(message.cut);
        break;
      case 'cut-failed':
        this.#settle(message.id)?.reject(new Error(message.message));
        break;
      case 'error':
        this.#emitError({ message: message.message, fatal: message.fatal });
        break;
      case 'stopped':
        this.#stopped?.();
        break;
    }
  }

  #settle(id: number): PendingCut | undefined {
    const pending = this.#cuts.get(id);
    if (pending !== undefined) {
      this.#cuts.delete(id);
      clearTimeout(pending.timer);
    }
    return pending;
  }

  #emitError(error: CaptureError): void {
    for (const listener of this.#errorListeners) {
      listener(error);
    }
  }
}

function member(target: object, key: string): unknown {
  return (target as Record<string, unknown>)[key];
}
