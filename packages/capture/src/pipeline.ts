// The window's side of the capture pipeline (docs/PLAN.md, T2.2). Chrome has
// MediaStreamTrackProcessor on the window only (docs/DEVICES.md), so the window turns the camera's
// tracks into streams of frames and audio, moves the streams to the capture worker, and relays
// cuts, clips (T2.3) and counters; it never touches a frame or an MP4. Since T2.4 two workers run:
// the capture worker encodes and cuts, and the clip worker muxes and writes the clips, which reach
// it from the capture worker through a channel of their own (docs/TOOLCHAIN.md, "Two workers").
// Plain TypeScript: no Angular.
import type { VideoClip } from '@cubetrace/core';

import type { Cut } from './cut';
import type { FramingRect } from './framing';
import {
  isWorkerToWindow,
  post,
  resolveCaptureConfig,
  type CaptureConfig,
  type CaptureError,
  type CaptureStats,
  type DeleteClipParams,
  type MotionSample,
  type SaveClipParams,
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
  /**
   * Saves a clip (docs/PLAN.md, T2.3): the worker cuts `[params.startHostMs, params.endHostMs]`
   * (host ms, as `cut` takes them), muxes it into an MP4 and writes it with its frames.json into
   * `sessions/<sessionId>/attempts/<index>/` of the origin private file system, then resolves with
   * the clip's `video[]` entry (docs/DATA-MODEL.md §7; `crop` and `syncResidualMs` null, for the
   * caller to fill). The capture worker only cuts; the clip worker muxes and writes, so the frames
   * keep coming meanwhile (T2.4). Clips are saved one at a time, in the order asked. Rejects with
   * the workers' reason (nothing buffered there, the start older than the buffer, a missing session
   * folder, a full disk, ...), once the capture has stopped, or when no answer comes within
   * `SAVE_CLIP_TIMEOUT_MS`.
   */
  saveClip(params: SaveClipParams): Promise<VideoClip>;
  /**
   * Removes a clip that `saveClip` saved for an attempt that is gone (docs/PLAN.md, T2.4): its MP4,
   * its frames file and their temporary files, only while they are still that clip's (the frames
   * file's `t0HostMs` is `params.firstFrameHostMs`), after the clips being saved. Resolves to
   * whether it removed them; rejects as `saveClip` does.
   */
  deleteClip(params: DeleteClipParams): Promise<boolean>;
  /**
   * Measures, for a sync check (docs/PLAN.md, T2.5), the motion of every frame from the next one on
   * inside `rect` (frame pixels, as the framing rectangle; null for the whole frame): `onSample` gets
   * each frame's motion (`MotionSample`) until the returned function is called; `onError` hears once
   * why the frames cannot be measured, which ends it. One watch at a time: a new one ends the one
   * before, and so does `stop()`.
   */
  watchMotion(
    rect: FramingRect | null,
    onSample: (sample: MotionSample) => void,
    onError?: (message: string) => void,
  ): () => void;
  /** `listener` gets the counters once per second; call the returned function to stop. */
  onStats(listener: (stats: CaptureStats) => void): () => void;
  /**
   * `listener` hears when recording stops by itself (`fatal`: the encoder failed or the camera's
   * track ended; the buffer stays, cuts still work) or loses its audio (not `fatal`).
   */
  onError(listener: (error: CaptureError) => void): () => void;
  /**
   * Stops recording and frees the buffer and the workers, once the clips being saved are written;
   * the stream's tracks keep running.
   */
  stop(): Promise<void>;
}

/** The browser APIs the pipeline needs, and the missing ones by name. */
export interface CaptureSupport {
  readonly supported: boolean;
  readonly missing: readonly string[];
}

/** How long a cut may take before `cut()` gives up on the worker. */
export const CUT_TIMEOUT_MS = 10_000;

/**
 * How long `saveClip()` waits for the worker: muxing and writing take a fraction of a second for
 * a solve's clip, and the clips asked for before it come first.
 */
export const SAVE_CLIP_TIMEOUT_MS = 30_000;

/** How long `stop()` waits for the worker to close its encoders before terminating it. */
export const STOP_TIMEOUT_MS = 2000;

/**
 * How many frames the video's MediaStreamTrackProcessor keeps for a capture worker that is late to
 * read them, before it drops the oldest: a third of a second at 30 fps, for a garbage collection or
 * a busy moment (T2.4; Chrome's default holds fewer). Frames wait there only while the worker is
 * behind.
 */
export const VIDEO_PROCESSOR_BUFFER = 10;

/** The same for the microphone, in its buffers of 10 ms: half a second. */
export const AUDIO_PROCESSOR_BUFFER = 50;

const REQUIRED_APIS = ['MediaStreamTrackProcessor', 'VideoEncoder', 'Worker'];

/** Whether `scope` (the window) has what `startCapture` needs: Chrome does, others lack some. */
export function captureSupport(scope: object = globalThis): CaptureSupport {
  const missing = REQUIRED_APIS.filter((name) => typeof member(scope, name) !== 'function');
  return { supported: missing.length === 0, missing };
}

/**
 * Starts the capture worker on the stream's first video track and, unless `config.audio` is
 * false, its first audio track, and the clip worker, joined to it by a channel. Throws when the
 * browser lacks MediaStreamTrackProcessor or the stream has no video track. The factories are for
 * tests; by default each worker starts from its own chunk.
 */
export function startCapture(
  stream: MediaStream,
  config: CaptureConfig = {},
  workerFactory: () => Worker = createCaptureWorker,
  clipWorkerFactory: () => Worker = createClipWorker,
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
  const video = new TrackProcessor<VideoFrame>({
    track: videoTrack,
    maxBufferSize: VIDEO_PROCESSOR_BUFFER,
  }).readable;
  const audio =
    audioTrack === undefined
      ? null
      : new TrackProcessor<AudioData>({ track: audioTrack, maxBufferSize: AUDIO_PROCESSOR_BUFFER })
          .readable;
  let worker: Worker | undefined;
  let clipWorker: Worker;
  try {
    worker = workerFactory();
    clipWorker = clipWorkerFactory();
  } catch (error: unknown) {
    // The processors would otherwise hold the tracks' frames for a reader that never comes.
    void video.cancel();
    void audio?.cancel();
    worker?.terminate();
    throw error;
  }
  const capture = new Capture(worker, clipWorker);
  // The capture worker sends the clips' cuts straight to the clip worker, not through the window.
  const channel = new MessageChannel();
  post(clipWorker, { type: 'connect', port: channel.port2 });
  post(worker, {
    type: 'start',
    video,
    audio,
    config: resolved,
    frameRate: videoTrack.getSettings().frameRate ?? null,
    clips: channel.port1,
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

/** The clip worker as a module worker, from its own chunk (as `createCaptureWorker`). */
export function createClipWorker(): Worker {
  return new Worker(new URL('./clip-worker.ts', import.meta.url), { type: 'module' });
}

/** A request waiting for the worker's answer. */
interface Pending<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class Capture implements CaptureHandle {
  readonly #worker: Worker;
  readonly #clipWorker: Worker;
  readonly #cuts = new Map<number, Pending<Cut>>();
  readonly #clips = new Map<number, Pending<VideoClip>>();
  readonly #deletions = new Map<number, Pending<boolean>>();
  /** The clips being saved or removed, settled either way: `stop()` waits for them. */
  readonly #saving = new Set<Promise<void>>();
  readonly #statsListeners = new Set<(stats: CaptureStats) => void>();
  readonly #errorListeners = new Set<(error: CaptureError) => void>();
  #nextId = 1;
  #stopping: Promise<void> | undefined;
  #stopped: (() => void) | undefined;
  /** Why the clip worker failed, once it has: clips are refused from then on. */
  #clipWorkerFailure: string | undefined;
  /** The motion watch under way (a sync check's), by its id. */
  #motion:
    | {
        readonly id: number;
        readonly onSample: (sample: MotionSample) => void;
        readonly onError: ((message: string) => void) | undefined;
      }
    | undefined;

  constructor(worker: Worker, clipWorker: Worker) {
    this.#worker = worker;
    this.#clipWorker = clipWorker;
    worker.addEventListener('message', this.#onMessage);
    worker.addEventListener('error', this.#onWorkerError);
    clipWorker.addEventListener('message', this.#onMessage);
    clipWorker.addEventListener('error', this.#onClipWorkerError);
  }

  cut(startHostMs: number, endHostMs: number): Promise<Cut> {
    if (this.#stopping !== undefined) {
      return Promise.reject(new Error('The capture has stopped.'));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return this.#request(this.#cuts, id, CUT_TIMEOUT_MS, () => {
      post(this.#worker, { type: 'cut', id, startHostMs, endHostMs });
    });
  }

  saveClip(params: SaveClipParams): Promise<VideoClip> {
    const refused = this.#refusal();
    if (refused !== undefined) {
      return Promise.reject(refused);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return this.#track(
      this.#request(this.#clips, id, SAVE_CLIP_TIMEOUT_MS, () => {
        post(this.#worker, {
          type: 'mux-and-write',
          id,
          startHostMs: params.startHostMs,
          endHostMs: params.endHostMs,
          sessionId: params.sessionId,
          index: params.index,
          camera: params.camera,
          segment: params.segment,
          fpsNominal: params.fpsNominal,
        });
      }),
    );
  }

  deleteClip(params: DeleteClipParams): Promise<boolean> {
    const refused = this.#refusal();
    if (refused !== undefined) {
      return Promise.reject(refused);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return this.#track(
      this.#request(this.#deletions, id, SAVE_CLIP_TIMEOUT_MS, () => {
        post(this.#clipWorker, {
          type: 'delete-clip',
          id,
          sessionId: params.sessionId,
          index: params.index,
          camera: params.camera,
          segment: params.segment,
          firstFrameHostMs: params.firstFrameHostMs,
        });
      }),
    );
  }

  /** Why a clip cannot be saved or removed now, if it cannot. */
  #refusal(): Error | undefined {
    if (this.#stopping !== undefined) {
      return new Error('The capture has stopped.');
    }
    if (this.#clipWorkerFailure !== undefined) {
      return new Error(this.#clipWorkerFailure);
    }
    return undefined;
  }

  /** Keeps `answer` among the clip requests that `stop()` waits for, until it settles. */
  #track<T>(answer: Promise<T>): Promise<T> {
    const settled = answer.then(
      () => undefined,
      () => undefined,
    );
    this.#saving.add(settled);
    void settled.then(() => this.#saving.delete(settled));
    return answer;
  }

  /** Sends a request with `send` and waits for its answer, at most `timeoutMs`. */
  #request<T>(
    pending: Map<number, Pending<T>>,
    id: number,
    timeoutMs: number,
    send: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The capture worker did not answer within ${String(timeoutMs)} ms.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send();
    });
  }

  watchMotion(
    rect: FramingRect | null,
    onSample: (sample: MotionSample) => void,
    onError?: (message: string) => void,
  ): () => void {
    if (this.#stopping !== undefined) {
      onError?.('The capture has stopped.');
      return () => undefined;
    }
    const id = this.#nextId;
    this.#nextId += 1;
    this.#motion = { id, onSample, onError };
    post(this.#worker, { type: 'sync-start', id, rect });
    return () => {
      if (this.#motion?.id === id) {
        this.#motion = undefined;
        if (this.#stopping === undefined) {
          post(this.#worker, { type: 'sync-stop', id });
        }
      }
    };
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
    // The clips being saved are written first (each within its own timeout).
    if (this.#saving.size > 0) {
      await Promise.all(this.#saving);
    }
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
    this.#clipWorker.removeEventListener('message', this.#onMessage);
    this.#clipWorker.removeEventListener('error', this.#onClipWorkerError);
    this.#worker.terminate();
    this.#clipWorker.terminate();
    this.#rejectAll([this.#cuts, this.#clips, this.#deletions], 'The capture has stopped.');
    this.#statsListeners.clear();
    this.#errorListeners.clear();
    this.#motion = undefined;
  }

  /** Rejects every request of `requests` with `message`. */
  #rejectAll(requests: readonly Map<number, Pending<never>>[], message: string): void {
    for (const pending of requests) {
      for (const [id, request] of pending) {
        pending.delete(id);
        clearTimeout(request.timer);
        request.reject(new Error(message));
      }
    }
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

  /**
   * The clip worker failed: recording goes on, but no clip can be saved or removed. The requests
   * waiting for it are refused at once rather than at their timeouts.
   */
  readonly #onClipWorkerError = (event: ErrorEvent): void => {
    event.preventDefault();
    const reason = event.message === '' ? 'it could not start' : event.message;
    const message = `The clip worker failed: ${reason}`;
    this.#clipWorkerFailure ??= message;
    this.#rejectAll([this.#clips, this.#deletions], message);
    this.#emitError({ message, fatal: false });
  };

  #receive(message: WorkerToWindow): void {
    switch (message.type) {
      case 'stats':
        for (const listener of this.#statsListeners) {
          listener(message.stats);
        }
        break;
      case 'cut-done':
        settle(this.#cuts, message.id)?.resolve(message.cut);
        break;
      case 'cut-failed':
        settle(this.#cuts, message.id)?.reject(new Error(message.message));
        break;
      case 'mux-and-write-done':
        settle(this.#clips, message.id)?.resolve(message.clip);
        break;
      case 'mux-and-write-failed':
        settle(this.#clips, message.id)?.reject(new Error(message.message));
        break;
      case 'delete-clip-done':
        settle(this.#deletions, message.id)?.resolve(message.deleted);
        break;
      case 'delete-clip-failed':
        settle(this.#deletions, message.id)?.reject(new Error(message.message));
        break;
      case 'error':
        this.#emitError({ message: message.message, fatal: message.fatal });
        break;
      case 'sync-sample':
        if (this.#motion?.id === message.id) {
          this.#motion.onSample(message.sample);
        }
        break;
      case 'sync-error': {
        const motion = this.#motion;
        if (motion?.id === message.id) {
          this.#motion = undefined;
          motion.onError?.(message.message);
        }
        break;
      }
      case 'stopped':
        this.#stopped?.();
        break;
    }
  }

  #emitError(error: CaptureError): void {
    for (const listener of this.#errorListeners) {
      listener(error);
    }
  }
}

/**
 * The request `id` of `requests`, forgotten and its timer cleared; undefined if it is not there.
 */
function settle<T>(requests: Map<number, Pending<T>>, id: number): Pending<T> | undefined {
  const pending = requests.get(id);
  if (pending !== undefined) {
    requests.delete(id);
    clearTimeout(pending.timer);
  }
  return pending;
}

function member(target: object, key: string): unknown {
  return (target as Record<string, unknown>)[key];
}
