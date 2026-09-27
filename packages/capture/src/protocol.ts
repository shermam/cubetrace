// The messages between the window (pipeline.ts) and the capture worker (capture-worker.ts), and the
// settings and counters both sides share (docs/PLAN.md, T2.2; the clips of T2.3). Plain
// TypeScript: nothing here touches a browser API.
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

/** The window starts the worker with the tracks' frames, which move to it (transferred). */
export interface StartMessage {
  readonly type: 'start';
  readonly video: ReadableStream<VideoFrame>;
  readonly audio: ReadableStream<AudioData> | null;
  readonly config: ResolvedCaptureConfig;
  /** The video track's `frameRate` setting: the frame rate until the frames' timestamps tell. */
  readonly frameRate: number | null;
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
 * The worker cuts `[startHostMs, endHostMs]`, muxes it into an MP4 and writes it with its
 * frames.json into the attempt's folder; the MP4 never crosses to the window.
 */
export interface MuxAndWriteRequest extends SaveClipParams {
  readonly type: 'mux-and-write';
  readonly id: number;
}

export interface StopMessage {
  readonly type: 'stop';
}

export type WindowToWorker = StartMessage | CutRequest | MuxAndWriteRequest | StopMessage;

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
  | ErrorMessage
  | StoppedMessage;

export type CaptureMessage = WindowToWorker | WorkerToWindow;

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

/** What a message moves rather than copies: the start's streams, a cut's chunk bytes. */
export function transferList(message: CaptureMessage): Transferable[] {
  switch (message.type) {
    case 'start':
      return message.audio === null ? [message.video] : [message.video, message.audio];
    case 'cut-done':
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
  'error',
  'stopped',
]);

/** Whether `data` (a `MessageEvent`'s) is a message for the worker. */
export function isWindowToWorker(data: unknown): data is WindowToWorker {
  return WINDOW_TYPES.has(typeOf(data));
}

/** Whether `data` (a `MessageEvent`'s) is a message from the worker. */
export function isWorkerToWindow(data: unknown): data is WorkerToWindow {
  return WORKER_TYPES.has(typeOf(data));
}

function typeOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? (data as { type?: unknown }).type : undefined;
}
