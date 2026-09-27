// The messages between the window (pipeline.ts), the capture worker (capture-worker.ts) and the clip
// worker (clip-worker.ts), and the settings and counters they share (docs/PLAN.md, T2.2; the clips
// of T2.3; the clip worker of T2.4; the sync check's motion of T2.5; the video quality of T2.10).
// The window starts both workers and gives each an end of a channel between them: the capture
// worker cuts a clip and moves the cut through it to the clip worker, which muxes and writes it and
// answers the window. Plain TypeScript: nothing here touches a browser API.
import type { VideoClip, VideoSegment } from '@cubetrace/core';

import type { VideoQuality } from './bitrate';
import { cutBuffers, type Cut } from './cut';
import type { FramingRect } from './framing';
import { DEFAULT_BOUNDS } from './ring-buffer';

/** What `startCapture` is asked for; every field has a default. */
export interface CaptureConfig {
  /** Record the stream's audio track too, when it has one. Default true. */
  readonly audio?: boolean;
  /** The video encoder's bitrate (bitrate.ts). Default `standard`: 4 Mbps at 1080p30. */
  readonly quality?: VideoQuality;
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
    quality: config.quality ?? 'standard',
    bufferSeconds: config.bufferSeconds ?? DEFAULT_BOUNDS.maxSeconds,
    bufferBytes: config.bufferBytes ?? DEFAULT_BOUNDS.maxBytes,
  };
}

/**
 * How long after the first frame the capture worker waits for the microphone's first audio before
 * it says, once, that none comes (T2.9, issue #33): a muted track, or one another app holds, sends
 * nothing, and the clips would otherwise lack their sound without a word.
 */
export const AUDIO_SILENCE_MS = 3000;

/** The capture worker's non-fatal `error` when no audio came within {@link AUDIO_SILENCE_MS}. */
export const NO_AUDIO_DATA =
  'Recording without audio: the microphone sends no audio (muted, or held by another app).';

/**
 * Where the recording's audio is (docs/PLAN.md, T2.9): `off`, none asked for (Record audio off, or
 * no microphone); `waiting`, asked for, but nothing encoded yet (no sound has come from the
 * microphone, or the encoder has not answered); `encoding`, its chunks go into the buffer; `stopped`,
 * it ended (the encoder failed, no encoder takes it, or the microphone's track ended), and the window
 * heard why in a non-fatal `error`.
 */
export type AudioState = 'off' | 'waiting' | 'encoding' | 'stopped';

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
  /**
   * The bitrate the video encoder is configured with, bits per second (`videoBitrate` at the
   * frames' size and rate and the config's quality); null before the encoder is chosen.
   */
  readonly bitrate: number | null;
  /** `mp4a.40.2`, `opus`, or null: no audio (none asked for, none in the stream, or no encoder). */
  readonly audioCodec: string | null;
  /** Audio chunks out of the encoder since the start. */
  readonly audioChunks: number;
  /** See {@link AudioState}. */
  readonly audioState: AudioState;
}

/**
 * The capture's audio when it cut a clip (T2.9), for the clip to say why it has no sound: its state,
 * how much came from the microphone and out of the encoder, and why it stopped, if it did.
 */
export interface AudioReport {
  readonly state: AudioState;
  /** `AudioData` received from the microphone since the start. */
  readonly data: number;
  /** Chunks out of the encoder since the start. */
  readonly chunks: number;
  /** Why the audio stopped (the window's non-fatal `error` said it); null if it did not. */
  readonly error: string | null;
  /**
   * The audio's decoder config was made, or completed, from the encoder's settings: the encoder gave
   * none with its first chunk, or one without a field the muxer needs (issue #33).
   */
  readonly configMade: boolean;
}

/**
 * What a saved clip lacks of what was asked for, for the window to say and to note in the session
 * (T2.9); none of it goes into attempt.json but the clip's `truncatedStart`.
 */
export interface ClipReport {
  /**
   * How much later than asked the clip begins, ms: its start was older than the buffer, so it begins
   * at the buffer's first keyframe (`truncatedStart`); 0 when it begins where asked.
   */
  readonly lateMs: number;
  /** Seconds of video the buffer held when the clip was cut. */
  readonly bufferSeconds: number;
  /**
   * Why the clip has no audio track although the capture records audio (no audio data, no decoder
   * config, no chunk in the clip's span, the encoder's error); null when it has one, or none was
   * asked for.
   */
  readonly audioMissing: string | null;
  /**
   * How far the clip's audio was moved to line up with its video, ms: the audio's timestamps were on
   * another clock than the frames', so the arrival offsets placed it (issue #33); 0 when they share
   * one.
   */
  readonly audioRebasedMs: number;
  /**
   * The clip's audio track has a decoder config that the capture made, or completed, from the
   * encoder's settings (`AudioReport.configMade`); false otherwise, and without an audio track.
   */
  readonly audioConfigMade: boolean;
}

/** A clip saved: its `video[]` entry, and its report. */
export interface SavedClip {
  readonly clip: VideoClip;
  readonly report: ClipReport;
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

/**
 * The window asks the capture worker for the motion of every frame inside `rect` (frame pixels, as
 * the framing rectangle is kept; null for the whole frame), for a sync check (docs/PLAN.md, T2.5),
 * until `sync-stop` with the same id. A new `sync-start` ends the one before.
 */
export interface SyncStart {
  readonly type: 'sync-start';
  readonly id: number;
  readonly rect: FramingRect | null;
}

export interface SyncStop {
  readonly type: 'sync-stop';
  readonly id: number;
}

export type WindowToWorker =
  StartMessage | CutRequest | MuxAndWriteRequest | StopMessage | SyncStart | SyncStop;

/** The window gives the clip worker its end of the channel from the capture worker. */
export interface ConnectMessage {
  readonly type: 'connect';
  readonly port: MessagePort;
}

export type WindowToClipWorker = ConnectMessage | DeleteClipRequest;

/**
 * From the capture worker to the clip worker: a clip's request and its cut, whose chunk bytes are
 * copies that move with it (transferred), so that the capture worker only cuts; with what the clip's
 * report needs from the capture: the seconds in its buffer and its audio when it cut.
 */
export interface ClipJob {
  readonly type: 'clip-job';
  readonly request: MuxAndWriteRequest;
  readonly cut: Cut;
  readonly bufferSeconds: number;
  readonly audio: AudioReport;
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

/** The answer to the `mux-and-write` request with the same id: the clip's entry and its report. */
export interface MuxAndWriteDone extends SavedClip {
  readonly type: 'mux-and-write-done';
  readonly id: number;
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

/**
 * One frame's motion during a sync check (docs/PLAN.md, T2.5 and T2.8): its own timestamp and its
 * arrival in the capture worker, which place it on the host clock as the clips' frames are placed
 * (docs/DATA-MODEL.md §9), and how much the picture in the rectangle changed since the frame before
 * (motion.ts), in two measures.
 */
export interface MotionSample {
  /** The frame's `VideoFrame.timestamp`, µs. */
  readonly timestampUs: number;
  /** Host ms when the frame reached the capture worker. */
  readonly arrivalHostMs: number;
  /** The mean absolute difference of its luma from the previous frame's, in luma levels. */
  readonly mean: number;
  /**
   * The share of the region's pixels (of its downscale) whose luma changed by more than 12 levels
   * since the previous frame, 0 to 1: the clapperboard's energy (T2.8).
   */
  readonly changed: number;
  /** The capture worker's time on it, ms: the copy of the frame's pixels and the arithmetic. */
  readonly costMs: number;
}

/** A frame's motion, for the sync check of the same id; the first frame of a check has none. */
export interface SyncSampleMessage {
  readonly type: 'sync-sample';
  readonly id: number;
  readonly sample: MotionSample;
}

/**
 * How the capture worker measures a sync check's frames (motion.ts): what it reads of them and where
 * (docs/PLAN.md, T2.8), for the check's diagnostics and the capture lab.
 */
export interface MotionMeterInfo {
  /** The frames' pixel format, `VideoFrame.format`; null when the browser gives none. */
  readonly format: string | null;
  /**
   * How the region's luma is read: `copy`, out of the frame's own planes with `VideoFrame.copyTo`;
   * `draw`, drawn into a canvas (a pixel format the meter does not read, or a frame to be shown
   * turned or mirrored).
   */
  readonly path: 'copy' | 'draw';
  /** The frames' size as shown, pixels. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** The region measured, in those pixels: the framing rectangle clamped to the frame. */
  readonly region: FramingRect;
  /** The luma plane the region is downscaled to: 320 pixels wide for a wide region, else 160. */
  readonly planeWidth: number;
  readonly planeHeight: number;
  /** A pixel of that plane counts as changed when its luma moved by more than this. */
  readonly changeLevels: number;
}

/** How the frames of the sync check of the same id are measured: sent first, and when it changes. */
export interface SyncMeterMessage {
  readonly type: 'sync-meter';
  readonly id: number;
  readonly meter: MotionMeterInfo;
}

/** The frames' motion cannot be measured (their pixels cannot be read): the check ends. */
export interface SyncErrorMessage {
  readonly type: 'sync-error';
  readonly id: number;
  readonly message: string;
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
  | SyncSampleMessage
  | SyncMeterMessage
  | SyncErrorMessage
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
  'sync-start',
  'sync-stop',
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
  'sync-sample',
  'sync-meter',
  'sync-error',
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
