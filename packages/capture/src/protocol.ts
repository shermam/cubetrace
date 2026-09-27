// The messages between the window (pipeline.ts), the capture worker (capture-worker.ts) and the clip
// worker (clip-worker.ts), and the settings and counters they share (docs/PLAN.md, T2.2; the clips
// of T2.3; the clip worker of T2.4). The window starts both workers and gives each an end of a
// channel between them: the capture worker cuts a clip and moves the cut through it to the clip
// worker, which muxes and writes it and answers the window. Plain TypeScript: nothing here touches a
// browser API.
import type { VideoClip, VideoSegment } from '@cubetrace/core';

import { cutBuffers, type Cut } from './cut';
import { DEFAULT_BOUNDS } from './ring-buffer';

/** What `startCapture` is asked for; every field has a default. */
export interface CaptureConfig {
  /** Record the stream's audio track too, when it has one. Default true. */
  readonly audio?: boolean;
  /** How far back a cut can reach, in seconds of video. Default 90. */
  readonly bufferSeconds?: number;
  /** The most encoded bytes (video and audio) kept in memory. Default 160 MB (10^6 bytes). */
  readonly bufferBytes?: number;
}

/** A `CaptureConfig` with the defaults filled in: what the worker receives. */
export type ResolvedCaptureConfig = Required<CaptureConfig>;

export function resolveCaptureConfig(config: CaptureConfig = {}): ResolvedCaptureConfig {
  return {
    audio: config.audio ?? true,
    bufferSeconds: config.bufferSeconds ?? DEFAULT_BOUNDS.maxSeconds,
    bufferBytes: config.bufferBytes ?? DEFAULT_BOUNDS.maxBytes,
  };
}

/** The pipeline's counters, once per second. */
export interface CaptureStats {
  /** Frames that reached the worker per second, over the last second. */
  readonly fps: number;
  /** Video chunks out of the encoder per second, over the last second. */
  readonly encodedFps: number;
  /** Frames dropped since the start because the encoder's queue held more than 8. */
  readonly dropped: number;
  /** The video encoder's queue (`encodeQueueSize`) now. */
  readonly queue: number;
  /** Seconds of video in the ring buffer. */
  readonly bufferSeconds: number;
  /** Bytes of video and audio in the ring buffer. */
  readonly bufferBytes: number;
  /** The video codec in use (`avc1.640028`, `avc1.4d0028` or `vp09.00.40.08`); null before it is chosen. */
  readonly codec: string | null;
  /** `mp4a.40.2`, `opus`, or null: no audio (none asked for, none in the stream, or no encoder). */
  readonly audioCodec: string | null;
}

/** Recording stopped by itself (`fatal`: the buffer stays, so cuts still work), or only its audio. */
export interface CaptureError {
  readonly message: string;
  readonly fatal: boolean;
}

/**
 * The window starts the capture worker with the tracks' frames and its end of the channel to the
 * clip worker, which all move to it (transferred).
 */
export interface StartMessage {
  readonly type: 'start';
  readonly video: ReadableStream<VideoFrame>;
  readonly audio: ReadableStream<AudioData> | null;
  readonly config: ResolvedCaptureConfig;
  /** The video track's `frameRate` setting: the frame rate until the frames' timestamps tell. */
  readonly frameRate: number | null;
  /** Where the capture worker sends the cuts of the clips to save: the clip worker's channel. */
  readonly clips: MessagePort | null;
}

export interface CutRequest {
  readonly type: 'cut';
  readonly id: number;
  readonly startHostMs: number;
  readonly endHostMs: number;
}

/**
 * A clip to save (docs/PLAN.md, T2.3): the interval to cut, host ms (as `cut` takes it), and where
 * the clip goes and what its `video[]` entry says (docs/DATA-MODEL.md §5 and §7).
 */
export interface SaveClipParams {
  readonly startHostMs: number;
  readonly endHostMs: number;
  /** The session's id: its folder, which must exist (`createSession`). */
  readonly sessionId: string;
  /** The attempt's 1-based index: its folder, `0001`, made if needed. */
  readonly index: number;
  /** The camera's label in the session (`laptop`, `phone-front`): the files' first name. */
  readonly camera: string;
  readonly segment: VideoSegment;
  /** The frame rate the camera's track reports, for the entry's `fpsNominal`. */
  readonly fpsNominal: number;
}

/**
 * The capture worker cuts `[startHostMs, endHostMs]` and moves the cut to the clip worker, which
 * muxes it into an MP4, writes it with its frames.json into the attempt's folder and answers the
 * window; the MP4 never crosses to the window.
 */
export interface MuxAndWriteRequest extends SaveClipParams {
  readonly type: 'mux-and-write';
  readonly id: number;
}

/**
 * A clip to remove (docs/PLAN.md, T2.4): that of an attempt that is gone, saved after it went. Its
 * files are removed only while they are still that clip's, the one whose first frame is at
 * `firstFrameHostMs` (its `video[]` entry's), and not a newer clip of the same name.
 */
export interface DeleteClipParams {
  readonly sessionId: string;
  readonly index: number;
  readonly camera: string;
  readonly segment: VideoSegment;
  readonly firstFrameHostMs: number;
}

/** The window asks the clip worker to remove a clip (see `DeleteClipParams`). */
export interface DeleteClipRequest extends DeleteClipParams {
  readonly type: 'delete-clip';
  readonly id: number;
}

export interface StopMessage {
  readonly type: 'stop';
}

export type WindowToWorker = StartMessage | CutRequest | MuxAndWriteRequest | StopMessage;

/** The window gives the clip worker its end of the channel from the capture worker. */
export interface ConnectMessage {
  readonly type: 'connect';
  readonly port: MessagePort;
}

export type WindowToClipWorker = ConnectMessage | DeleteClipRequest;

/**
 * From the capture worker to the clip worker: a clip's request and its cut, whose chunk bytes are
 * copies that move with it (transferred), so that the capture worker only cuts.
 */
export interface ClipJob {
  readonly type: 'clip-job';
  readonly request: MuxAndWriteRequest;
  readonly cut: Cut;
}

export interface StatsMessage {
  readonly type: 'stats';
  readonly stats: CaptureStats;
}

/** The answer to the `cut` request with the same id; its chunks' bytes are transferred. */
export interface CutDone {
  readonly type: 'cut-done';
  readonly id: number;
  readonly cut: Cut;
}

export interface CutFailed {
  readonly type: 'cut-failed';
  readonly id: number;
  readonly message: string;
}

/** The answer to the `mux-and-write` request with the same id: the clip's `video[]` entry. */
export interface MuxAndWriteDone {
  readonly type: 'mux-and-write-done';
  readonly id: number;
  readonly clip: VideoClip;
}

export interface MuxAndWriteFailed {
  readonly type: 'mux-and-write-failed';
  readonly id: number;
  readonly message: string;
}

/** The answer to the `delete-clip` request with the same id: whether the files were removed. */
export interface DeleteClipDone {
  readonly type: 'delete-clip-done';
  readonly id: number;
  /** False when there was nothing to remove, or the files were another clip's. */
  readonly deleted: boolean;
}

export interface DeleteClipFailed {
  readonly type: 'delete-clip-failed';
  readonly id: number;
  readonly message: string;
}

export interface ErrorMessage extends CaptureError {
  readonly type: 'error';
}

/** The worker has closed its encoders and readers after `stop`. */
export interface StoppedMessage {
  readonly type: 'stopped';
}

export type WorkerToWindow =
  | StatsMessage
  | CutDone
  | CutFailed
  | MuxAndWriteDone
  | MuxAndWriteFailed
  | DeleteClipDone
  | DeleteClipFailed
  | ErrorMessage
  | StoppedMessage;

export type CaptureMessage = WindowToWorker | WindowToClipWorker | ClipJob | WorkerToWindow;

/** `postMessage` with a transfer list: a `Worker`, a worker's global scope or a `MessagePort`. */
export interface MessageTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/**
 * Posts `message` with its transfer list (`transferList`), so that the streams and a cut's bytes
 * move to the other side instead of being copied, and cannot be forgotten.
 */
export function post(target: MessageTarget, message: CaptureMessage): void {
  target.postMessage(message, transferList(message));
}

/**
 * What a message moves rather than copies: the start's streams and port, the connect's port, a
 * cut's chunk bytes (of a cut answered to the window, or of a clip's job).
 */
export function transferList(message: CaptureMessage): Transferable[] {
  switch (message.type) {
    case 'start':
      return [
        message.video,
        ...(message.audio === null ? [] : [message.audio]),
        ...(message.clips === null ? [] : [message.clips]),
      ];
    case 'connect':
      return [message.port];
    case 'cut-done':
    case 'clip-job':
      return cutBuffers(message.cut);
    default:
      return [];
  }
}

const WINDOW_TYPES: ReadonlySet<unknown> = new Set<WindowToWorker['type']>([
  'start',
  'cut',
  'mux-and-write',
  'stop',
]);
const WORKER_TYPES: ReadonlySet<unknown> = new Set<WorkerToWindow['type']>([
  'stats',
  'cut-done',
  'cut-failed',
  'mux-and-write-done',
  'mux-and-write-failed',
  'delete-clip-done',
  'delete-clip-failed',
  'error',
  'stopped',
]);
const CLIP_WORKER_TYPES: ReadonlySet<unknown> = new Set<WindowToClipWorker['type']>([
  'connect',
  'delete-clip',
]);

/** Whether `data` (a `MessageEvent`'s) is a message for the worker. */
export function isWindowToWorker(data: unknown): data is WindowToWorker {
  return WINDOW_TYPES.has(typeOf(data));
}

/** Whether `data` (a `MessageEvent`'s) is a message from a worker to the window. */
export function isWorkerToWindow(data: unknown): data is WorkerToWindow {
  return WORKER_TYPES.has(typeOf(data));
}

/** Whether `data` is a message from the window to the clip worker. */
export function isWindowToClipWorker(data: unknown): data is WindowToClipWorker {
  return CLIP_WORKER_TYPES.has(typeOf(data));
}

/** Whether `data` is a clip's job, from the capture worker to the clip worker. */
export function isClipJob(data: unknown): data is ClipJob {
  return typeOf(data) === 'clip-job';
}

/** An error as the answers give it: `RangeError: Nothing is buffered yet.` */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === '' ? error.name : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function typeOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? (data as { type?: unknown }).type : undefined;
}
