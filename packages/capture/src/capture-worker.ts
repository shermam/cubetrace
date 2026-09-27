// The capture worker (docs/PLAN.md, T2.2): it reads the camera's frames and the microphone's audio
// from the streams the window transfers, encodes them with WebCodecs into the ring buffer, sends
// the counters once per second and answers cuts. For a clip (T2.3) it only cuts: since T2.4 the cut
// moves, with its request, to the clip worker (clip-worker.ts), which muxes and writes it, so that
// saving a clip never holds up the frames here (docs/TOOLCHAIN.md, "Two workers"). While the window
// runs a sync check (T2.5), it also measures the motion of every frame in the framing rectangle
// (motion.ts) and sends it. Since T2.9 it follows its audio closely enough for a clip without sound to
// say why (issue #33). Angular's builder emits it as a chunk of its own (docs/TOOLCHAIN.md, "The
// capture pipeline"); `startCapture` (pipeline.ts) starts it. Plain TypeScript: no Angular. The
// encoders, the clock and the timer come in through `WorkerEnvironment`, so the logic also runs in
// Node's tests with fakes; the last lines wire it to the worker's global scope.
// It encodes the video at the bitrate of the start's quality (bitrate.ts, T2.10).
import { audioDecoderConfigFor, isAudioDecoderConfigComplete } from './audio-config';
import { videoBitrate, type VideoQuality } from './bitrate';
import { cut } from './cut';
import type { FramingRect } from './framing';
import {
  MotionMeter,
  isMotionFrame,
  type MotionFrame,
  type MotionMeasure,
  type PlaneSize,
} from './motion';
import {
  AUDIO_SILENCE_MS,
  NO_AUDIO_DATA,
  describeError,
  isWindowToWorker,
  post,
  type AudioReport,
  type AudioState,
  type CaptureStats,
  type ClipJob,
  type CutRequest,
  type MessageTarget,
  type MotionMeterInfo,
  type MuxAndWriteRequest,
  type ResolvedCaptureConfig,
  type WindowToWorker,
  type WorkerToWindow,
} from './protocol';
import { RingBuffer } from './ring-buffer';
import { LumaSampler, offscreenCanvas, type LumaImage } from './sharpness';

/** Frames the video encoder may hold; beyond that, new frames are dropped and counted. */
export const MAX_ENCODE_QUEUE = 8;

/** The first frames only measure the frame rate for this long; then the encoder is chosen. */
export const WARMUP_MS = 500;

/** Frame intervals the frame rate is measured over (the median of the last ones). */
const RATE_INTERVALS = 30;

/**
 * The video encoders to try, in order: H.264 High, then Main (both level 4.0), each on the
 * platform's encoder, then on any; VP9 last, for browsers without H.264, such as the Chromium that
 * CI runs (docs/TOOLCHAIN.md).
 */
export const VIDEO_ENCODERS: readonly VideoEncoderChoice[] = [
  { codec: 'avc1.640028', hardwareAcceleration: 'prefer-hardware' },
  { codec: 'avc1.640028', hardwareAcceleration: 'no-preference' },
  { codec: 'avc1.4d0028', hardwareAcceleration: 'prefer-hardware' },
  { codec: 'avc1.4d0028', hardwareAcceleration: 'no-preference' },
  { codec: 'vp09.00.40.08', hardwareAcceleration: 'no-preference' },
];

/** AAC-LC, else Opus, else no audio. */
export const AUDIO_CODECS: readonly string[] = ['mp4a.40.2', 'opus'];

export const AUDIO_BITRATE = 128_000;

export interface VideoEncoderChoice {
  readonly codec: string;
  readonly hardwareAcceleration: HardwareAcceleration;
}

/** One keyframe per second's worth of frames. */
export function keyframeInterval(fps: number): number {
  return Math.max(1, Math.round(fps));
}

/**
 * The encoder settings of one rung of `VIDEO_ENCODERS` (docs/PLAN.md, T2.2), at the bitrate of
 * `quality` for this frame size and rate (bitrate.ts, T2.10).
 */
export function videoEncoderConfig(
  choice: VideoEncoderChoice,
  width: number,
  height: number,
  fps: number,
  quality: VideoQuality,
): VideoEncoderConfig {
  const config: VideoEncoderConfig = {
    codec: choice.codec,
    hardwareAcceleration: choice.hardwareAcceleration,
    width,
    height,
    bitrate: videoBitrate(width, height, fps, quality),
    framerate: Math.max(1, Math.round(fps)),
    latencyMode: 'quality',
  };
  return choice.codec.startsWith('avc1.') ? { ...config, avc: { format: 'avc' } } : config;
}

/** The parts of a `VideoFrame` the worker reads. */
export interface FrameLike {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

/** The parts of an `AudioData` the worker reads. */
export interface AudioLike {
  readonly timestamp: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  close(): void;
}

/** The parts of an `EncodedVideoChunk` or `EncodedAudioChunk` the worker reads. */
export interface ChunkLike {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  copyTo(destination: ArrayBuffer): void;
}

export interface EncoderInit<Metadata> {
  output(chunk: ChunkLike, metadata?: Metadata): void;
  error(error: DOMException): void;
}

export interface EncoderLike<Input, Config> {
  readonly encodeQueueSize: number;
  readonly state: CodecState;
  configure(config: Config): void;
  encode(input: Input, options?: VideoEncoderEncodeOptions): void;
  flush(): Promise<void>;
  close(): void;
}

export interface VideoEncoderClass {
  new (init: EncoderInit<EncodedVideoChunkMetadata>): EncoderLike<FrameLike, VideoEncoderConfig>;
  isConfigSupported(config: VideoEncoderConfig): Promise<{ readonly supported?: boolean }>;
}

export interface AudioEncoderClass {
  new (init: EncoderInit<EncodedAudioChunkMetadata>): EncoderLike<AudioLike, AudioEncoderConfig>;
  isConfigSupported(config: AudioEncoderConfig): Promise<{ readonly supported?: boolean }>;
}

/** What the worker takes from its global scope; the tests give it fakes. */
export interface WorkerEnvironment {
  /** Undefined where the browser has none. */
  readonly VideoEncoder: VideoEncoderClass | undefined;
  readonly AudioEncoder: AudioEncoderClass | undefined;
  /** Host ms: `performance.timeOrigin + performance.now()`, the same scale as the window's. */
  now(): number;
  /** Sends a message to the window with its transfer list. */
  post(message: WorkerToWindow): void;
  /** Calls `callback` every `ms` until the returned function is called. */
  every(ms: number, callback: () => void): () => void;
  /**
   * Draws the region of a frame whose pixels the motion meter cannot copy into a luma plane (a
   * canvas); absent where there is none, and in the tests.
   */
  readonly drawLuma?: (frame: FrameLike, region: FramingRect, size: PlaneSize) => LumaImage | null;
}

/**
 * A sync check under way (T2.5): its id, the meter of its frames' motion, and the description of the
 * meter last sent to the window (T2.8).
 */
interface SyncCheck {
  readonly id: number;
  readonly meter: MotionMeter<FrameLike & MotionFrame>;
  sent: MotionMeterInfo | null;
}

/** An audio input's timestamp and arrival, kept until the chunks that start in it are out. */
interface AudioArrival {
  readonly timestampUs: number;
  readonly arrivalHostMs: number;
}

type VideoEncoderLike = EncoderLike<FrameLike, VideoEncoderConfig>;
type AudioEncoderLike = EncoderLike<AudioLike, AudioEncoderConfig>;

/**
 * The encoding loop. For every frame it keeps the frame's own timestamp (µs) and its arrival in
 * the worker (host ms) for the cut's arrival fit; it forces a keyframe every second's worth of
 * frames, at the frame rate measured from the timestamps; it drops (and counts) the frames that
 * find the encoder's queue longer than `MAX_ENCODE_QUEUE`; and it closes every frame and audio
 * buffer it takes, since the camera stalls when they leak. When recording stops by itself (the
 * encoder fails, the camera's track ends), the buffer stays and cuts go on working.
 */
export class CaptureWorker {
  readonly #env: WorkerEnvironment;
  #buffer = new RingBuffer();
  #readers: { cancel(): Promise<void> }[] = [];
  #stopTicker: (() => void) | undefined;
  #started = false;
  #recording = false;
  #stopped = false;

  #videoEncoder: VideoEncoderLike | undefined;
  #videoConfig: VideoEncoderConfig | undefined;
  /** The start's quality: the encoder's bitrate, whatever the frames' size and rate. */
  #quality: VideoQuality = 'standard';
  #trackFrameRate: number | null = null;
  #lastTimestampUs: number | undefined;
  #intervalsUs: number[] = [];
  #warmupStartHostMs: number | undefined;
  #framesSinceKey = Number.POSITIVE_INFINITY;
  #keyInterval = 30;
  /** Frame timestamp → arrival, from `encode` until the frame's chunk comes out. */
  readonly #frameArrivals = new Map<number, number>();

  #audioEncoder: AudioEncoderLike | undefined;
  #audioConfig: AudioEncoderConfig | undefined;
  #audioOff = false;
  #audioCodec: string | null = null;
  #audioArrivals: AudioArrival[] = [];
  /** Whether the window gave an audio stream to record. */
  #audioAsked = false;
  /** `AudioData` read from the microphone, and chunks out of its encoder, since the start. */
  #audioData = 0;
  #audioChunks = 0;
  /** Why the audio stopped, as the window heard it; null while it has not. */
  #audioError: string | null = null;
  /** Whether the audio's decoder config was made or completed here (`AudioReport.configMade`). */
  #audioConfigMade = false;
  /** The first frame's arrival: the microphone has `AUDIO_SILENCE_MS` from there to send audio. */
  #firstFrameHostMs: number | undefined;
  #silenceSaid = false;

  #dropped = 0;
  #arrivedInWindow = 0;
  #encodedInWindow = 0;
  #windowStartHostMs = 0;

  /** The clip worker's end of their channel (the start's `clips`): where the clips' cuts go. */
  #clips: MessageTarget | null = null;

  /** The sync check whose motion is measured, while the window asks for it. */
  #sync: SyncCheck | null = null;

  constructor(env: WorkerEnvironment) {
    this.#env = env;
  }

  /** The ring buffer, for tests. */
  get buffer(): RingBuffer {
    return this.#buffer;
  }

  /** One message from the window. */
  handle(message: WindowToWorker): void {
    switch (message.type) {
      case 'start':
        void this.start(
          message.video,
          message.audio,
          message.config,
          message.frameRate,
          message.clips,
        );
        break;
      case 'cut':
        this.cut(message);
        break;
      case 'mux-and-write':
        this.muxAndWrite(message);
        break;
      case 'stop':
        void this.stop();
        break;
      case 'sync-start':
        this.startSync(message.id, message.rect);
        break;
      case 'sync-stop':
        if (this.#sync?.id === message.id) {
          this.#sync = null;
        }
        break;
    }
  }

  /**
   * Measures the motion of every frame from the next one on inside `rect` (frame pixels; null for
   * the whole frame) and sends it to the window as `sync-sample`s of check `id`, until `sync-stop`
   * (docs/PLAN.md, T2.5). It replaces the check under way, if any.
   */
  startSync(id: number, rect: FramingRect | null): void {
    const draw = this.#env.drawLuma;
    this.#sync = {
      id,
      meter: new MotionMeter<FrameLike & MotionFrame>(rect, draw === undefined ? {} : { draw }),
      sent: null,
    };
  }

  /**
   * Reads and encodes both streams until they end or `stop`; never rejects. `clips` is the channel
   * to the clip worker, where the cuts of the clips to save go (none: clips cannot be saved).
   */
  async start(
    video: ReadableStream<FrameLike>,
    audio: ReadableStream<AudioLike> | null,
    config: ResolvedCaptureConfig,
    frameRate: number | null,
    clips: MessageTarget | null = null,
  ): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#recording = true;
    this.#clips = clips;
    this.#quality = config.quality;
    this.#audioAsked = audio !== null;
    this.#buffer = new RingBuffer({
      maxSeconds: config.bufferSeconds,
      maxBytes: config.bufferBytes,
    });
    this.#trackFrameRate = frameRate;
    this.#windowStartHostMs = this.#env.now();
    this.#stopTicker = this.#env.every(1000, () => {
      this.#postStats();
    });
    await Promise.all([this.#readVideo(video), audio === null ? null : this.#readAudio(audio)]);
  }

  /** Answers a cut request with the cut (its bytes transferred) or the reason there is none. */
  cut(request: CutRequest): void {
    let answer: WorkerToWindow;
    try {
      const result = cut(this.#buffer, request.startHostMs, request.endHostMs);
      answer = { type: 'cut-done', id: request.id, cut: result };
    } catch (error: unknown) {
      answer = { type: 'cut-failed', id: request.id, message: describeError(error) };
    }
    try {
      this.#env.post(answer);
    } catch (error: unknown) {
      this.#env.post({
        type: 'cut-failed',
        id: request.id,
        message: `The cut could not be sent: ${describeError(error)}`,
      });
    }
  }

  /**
   * Saves a clip (docs/PLAN.md, T2.3 and T2.4): cuts `[startHostMs, endHostMs]` now, with copies of
   * the chunks' bytes (a memory copy, the only work done here), and moves the cut with its request to
   * the clip worker, which muxes and writes it and answers the window. When there is nothing to
   * cut, or no clip worker, the window gets the reason from here.
   */
  muxAndWrite(request: MuxAndWriteRequest): void {
    const clips = this.#clips;
    if (clips === null) {
      this.#refuseClip(request, 'This capture has no clip worker to save clips.');
      return;
    }
    let job: ClipJob;
    try {
      job = {
        type: 'clip-job',
        request,
        cut: cut(this.#buffer, request.startHostMs, request.endHostMs),
        bufferSeconds: Math.round(this.#buffer.bufferSeconds * 1000) / 1000,
        audio: this.#audioReport(),
      };
    } catch (error: unknown) {
      this.#refuseClip(request, describeError(error));
      return;
    }
    try {
      post(clips, job);
    } catch (error: unknown) {
      this.#refuseClip(
        request,
        `The cut could not be sent to the clip worker: ${describeError(error)}`,
      );
    }
  }

  /** Stops reading, closes the encoders, empties the buffer, then says `stopped`. */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#recording = false;
    this.#sync = null;
    this.#stopTicker?.();
    await this.#release();
    this.#buffer.clear();
    this.#env.post({ type: 'stopped' });
  }

  /** Answers a clip request that went no further than here. */
  #refuseClip(request: MuxAndWriteRequest, message: string): void {
    this.#env.post({ type: 'mux-and-write-failed', id: request.id, message });
  }

  /**
   * Whether frames are still wanted (false after `stop` or a failure). A method rather than the
   * field, because the answer changes while an `await` is pending.
   */
  #live(): boolean {
    return this.#recording;
  }

  async #readVideo(stream: ReadableStream<FrameLike>): Promise<void> {
    try {
      const reader = stream.getReader();
      this.#readers.push(reader);
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) {
          break;
        }
        const arrivalHostMs = this.#env.now();
        try {
          await this.#onFrame(frame, arrivalHostMs);
          const sync = this.#sync;
          if (sync !== null) {
            // After the encoder has the frame: the motion never holds up the recording.
            await this.#measureMotion(sync, frame, arrivalHostMs);
          }
        } finally {
          frame.close();
        }
      }
    } catch (error: unknown) {
      this.#fail(`Reading the camera's frames failed: ${describeError(error)}`);
      return;
    }
    await this.#videoEnded();
  }

  /**
   * Sends the motion of `frame` for the sync check `sync`, unless it is the check's first frame,
   * after how the frames are read when that is new (the check's first frame, a new size); a frame
   * whose pixels cannot be read ends the check, and the window hears why.
   */
  async #measureMotion(sync: SyncCheck, frame: FrameLike, arrivalHostMs: number): Promise<void> {
    let measured: MotionMeasure;
    try {
      if (!isMotionFrame(frame)) {
        throw new Error("The camera's frames cannot be read here.");
      }
      measured = await sync.meter.measure(frame);
    } catch (error: unknown) {
      if (this.#sync === sync) {
        this.#sync = null;
        this.#env.post({ type: 'sync-error', id: sync.id, message: describeError(error) });
      }
      return;
    }
    if (this.#sync !== sync) {
      return;
    }
    const { mean, changed, costMs, meter } = measured;
    if (meter !== sync.sent) {
      sync.sent = meter;
      this.#env.post({ type: 'sync-meter', id: sync.id, meter });
    }
    if (mean === null || changed === null) {
      return;
    }
    this.#env.post({
      type: 'sync-sample',
      id: sync.id,
      sample: {
        timestampUs: frame.timestamp,
        arrivalHostMs,
        mean: Math.round(mean * 1000) / 1000,
        // A millionth: finer than one pixel of a 320 × 180 plane (1/57,600).
        changed: Math.round(changed * 1e6) / 1e6,
        costMs: Math.round(costMs * 1000) / 1000,
      },
    });
  }

  async #onFrame(frame: FrameLike, arrivalHostMs: number): Promise<void> {
    if (!this.#live()) {
      return;
    }
    this.#arrivedInWindow += 1;
    this.#noteTimestamp(frame.timestamp);
    this.#checkSilence(arrivalHostMs);
    if (this.#videoEncoder === undefined) {
      this.#warmupStartHostMs ??= arrivalHostMs;
      if (arrivalHostMs - this.#warmupStartHostMs < WARMUP_MS) {
        return;
      }
      if (!(await this.#configureVideo(frame)) || !this.#live()) {
        return;
      }
    }
    const encoder = this.#videoEncoder;
    const config = this.#videoConfig;
    if (encoder === undefined || config === undefined || encoder.state !== 'configured') {
      return;
    }
    if (even(frame.displayWidth) !== config.width || even(frame.displayHeight) !== config.height) {
      await this.#resize(encoder, config, frame);
      if (!this.#live()) {
        return;
      }
    }
    this.#encode(encoder, frame, arrivalHostMs);
  }

  #encode(encoder: VideoEncoderLike, frame: FrameLike, arrivalHostMs: number): void {
    this.#framesSinceKey += 1;
    if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      this.#dropped += 1;
      return;
    }
    const keyFrame = this.#framesSinceKey >= this.#keyInterval;
    this.#frameArrivals.set(frame.timestamp, arrivalHostMs);
    try {
      encoder.encode(frame, { keyFrame });
    } catch (error: unknown) {
      this.#fail(`The video encoder refused a frame: ${describeError(error)}`);
      return;
    }
    if (keyFrame) {
      this.#framesSinceKey = 0;
      this.#keyInterval = keyframeInterval(this.#frameRate());
    }
  }

  /** Chooses the first encoder of `VIDEO_ENCODERS` that takes this frame size and frame rate. */
  async #configureVideo(frame: FrameLike): Promise<boolean> {
    const Encoder = this.#env.VideoEncoder;
    if (Encoder === undefined) {
      this.#fail('This browser has no VideoEncoder in workers.');
      return false;
    }
    const width = even(frame.displayWidth);
    const height = even(frame.displayHeight);
    const fps = this.#frameRate();
    for (const choice of VIDEO_ENCODERS) {
      const config = videoEncoderConfig(choice, width, height, fps, this.#quality);
      if (!(await isSupported(Encoder, config))) {
        continue;
      }
      if (!this.#live()) {
        return false;
      }
      const encoder = new Encoder({
        output: (chunk, metadata) => {
          this.#onVideoChunk(chunk, metadata);
        },
        error: (error) => {
          this.#fail(`The video encoder failed: ${describeError(error)}`);
        },
      });
      encoder.configure(config);
      this.#videoEncoder = encoder;
      this.#videoConfig = config;
      this.#keyInterval = keyframeInterval(fps);
      this.#buffer.setVideoTrack({ codec: config.codec, width, height });
      return true;
    }
    const tried = VIDEO_ENCODERS.map(
      (choice) => `${choice.codec} (${choice.hardwareAcceleration})`,
    );
    this.#fail(
      `No video encoder takes ${String(width)}×${String(height)} at ${String(Math.round(fps))} fps; ` +
        `tried ${tried.join(', ')}.`,
    );
    return false;
  }

  /**
   * The frames changed size (a phone turned): the buffer starts again at the new size, so that no
   * cut mixes two decoder configs. The encoder is flushed first, so that no chunk of the old size
   * comes out after the buffer has been emptied.
   */
  async #resize(
    encoder: VideoEncoderLike,
    config: VideoEncoderConfig,
    frame: FrameLike,
  ): Promise<void> {
    try {
      await encoder.flush();
    } catch {
      // The encoder's error callback has reported it.
      return;
    }
    const width = even(frame.displayWidth);
    const height = even(frame.displayHeight);
    const resized: VideoEncoderConfig = {
      ...config,
      width,
      height,
      bitrate: videoBitrate(width, height, config.framerate ?? this.#frameRate(), this.#quality),
    };
    encoder.configure(resized);
    this.#videoConfig = resized;
    this.#buffer.clear();
    this.#buffer.setVideoTrack({ codec: resized.codec, width, height });
    this.#frameArrivals.clear();
    this.#framesSinceKey = Number.POSITIVE_INFINITY;
  }

  #onVideoChunk(chunk: ChunkLike, metadata: EncodedVideoChunkMetadata | undefined): void {
    const decoderConfig = metadata?.decoderConfig;
    if (decoderConfig !== undefined) {
      this.#buffer.setVideoDecoderConfig(copyDecoderConfig(decoderConfig));
    }
    this.#encodedInWindow += 1;
    this.#buffer.push({
      kind: 'video',
      type: chunk.type,
      timestampUs: chunk.timestamp,
      // A frame without a duration (Chrome's fake camera): one frame interval at the measured rate.
      // Chrome gives such chunks a duration of 0 rather than null.
      durationUs:
        chunk.duration !== null && chunk.duration > 0
          ? chunk.duration
          : Math.round(1e6 / this.#frameRate()),
      byteLength: chunk.byteLength,
      arrivalHostMs: this.#frameArrival(chunk.timestamp),
      data: copyOut(chunk),
    });
  }

  /** The arrival of the frame behind a chunk; frames the encoder skipped are forgotten. */
  #frameArrival(timestampUs: number): number {
    const arrival = this.#frameArrivals.get(timestampUs);
    for (const pending of this.#frameArrivals.keys()) {
      if (pending > timestampUs) {
        break;
      }
      this.#frameArrivals.delete(pending);
    }
    return arrival ?? this.#env.now();
  }

  #noteTimestamp(timestampUs: number): void {
    const last = this.#lastTimestampUs;
    if (last !== undefined && timestampUs > last) {
      this.#intervalsUs.push(timestampUs - last);
      if (this.#intervalsUs.length > RATE_INTERVALS) {
        this.#intervalsUs.shift();
      }
    }
    this.#lastTimestampUs = timestampUs;
  }

  /** Frames per second from the median of the last frame intervals, else the track's setting. */
  #frameRate(): number {
    if (this.#intervalsUs.length > 0) {
      const sorted = [...this.#intervalsUs].sort((a, b) => a - b);
      return Math.min(240, Math.max(1, 1e6 / sorted[Math.floor(sorted.length / 2)]));
    }
    return this.#trackFrameRate ?? 30;
  }

  async #videoEnded(): Promise<void> {
    if (!this.#live()) {
      return;
    }
    const encoder = this.#videoEncoder;
    if (encoder?.state === 'configured') {
      try {
        // The frames still in the encoder belong in the buffer.
        await encoder.flush();
      } catch {
        // The encoder's error callback has reported it.
      }
    }
    this.#fail('The camera stopped sending frames (its track ended or the stream was closed).');
  }

  /**
   * Says once, `AUDIO_SILENCE_MS` after the first frame, that the microphone sends nothing, when
   * audio was asked for and none has come (issue #33): a muted track, or one another app holds.
   * Recording goes on; so does the wait for audio, which is encoded if it comes.
   */
  #checkSilence(arrivalHostMs: number): void {
    this.#firstFrameHostMs ??= arrivalHostMs;
    if (
      this.#audioAsked &&
      this.#audioData === 0 &&
      !this.#audioOff &&
      !this.#silenceSaid &&
      arrivalHostMs - this.#firstFrameHostMs >= AUDIO_SILENCE_MS
    ) {
      this.#silenceSaid = true;
      this.#env.post({ type: 'error', message: NO_AUDIO_DATA, fatal: false });
    }
  }

  async #readAudio(stream: ReadableStream<AudioLike>): Promise<void> {
    try {
      const reader = stream.getReader();
      this.#readers.push(reader);
      for (;;) {
        const { value: data, done } = await reader.read();
        if (done) {
          break;
        }
        this.#audioData += 1;
        const arrivalHostMs = this.#env.now();
        try {
          await this.#onAudio(data, arrivalHostMs);
        } finally {
          data.close();
        }
        if (this.#audioOff) {
          await reader.cancel();
          return;
        }
      }
    } catch (error: unknown) {
      this.#stopAudio(`Reading the microphone failed: ${describeError(error)}`);
      return;
    }
    this.#stopAudio('The microphone stopped sending audio (its track ended).');
  }

  async #onAudio(data: AudioLike, arrivalHostMs: number): Promise<void> {
    if (!this.#live() || this.#audioOff) {
      return;
    }
    if (this.#audioEncoder === undefined && !(await this.#configureAudio(data))) {
      return;
    }
    const encoder = this.#audioEncoder;
    if (encoder === undefined || encoder.state !== 'configured' || !this.#live()) {
      return;
    }
    this.#audioArrivals.push({ timestampUs: data.timestamp, arrivalHostMs });
    try {
      encoder.encode(data);
    } catch (error: unknown) {
      this.#stopAudio(`The audio encoder refused audio: ${describeError(error)}`);
    }
  }

  /** AAC-LC at the track's sample rate, else Opus, else no audio. */
  async #configureAudio(data: AudioLike): Promise<boolean> {
    const Encoder = this.#env.AudioEncoder;
    const { sampleRate, numberOfChannels } = data;
    for (const codec of AUDIO_CODECS) {
      const config: AudioEncoderConfig = {
        codec,
        sampleRate,
        numberOfChannels,
        bitrate: AUDIO_BITRATE,
      };
      if (Encoder === undefined) {
        break;
      }
      if (!(await isSupported(Encoder, config))) {
        continue;
      }
      if (!this.#live()) {
        return false;
      }
      const encoder = new Encoder({
        output: (chunk, metadata) => {
          this.#onAudioChunk(chunk, metadata);
        },
        error: (error) => {
          this.#stopAudio(`The audio encoder failed: ${describeError(error)}`);
        },
      });
      encoder.configure(config);
      this.#audioEncoder = encoder;
      this.#audioConfig = config;
      this.#audioCodec = codec;
      this.#buffer.setAudioTrack({ codec, sampleRate, numberOfChannels });
      return true;
    }
    this.#stopAudio(
      `No audio encoder takes ${String(sampleRate)} Hz, ${String(numberOfChannels)} channel(s) ` +
        `(tried ${AUDIO_CODECS.join(', ')}): recording video only.`,
    );
    return false;
  }

  #onAudioChunk(chunk: ChunkLike, metadata: EncodedAudioChunkMetadata | undefined): void {
    this.#describeAudio(metadata?.decoderConfig);
    this.#audioChunks += 1;
    this.#buffer.push({
      kind: 'audio',
      type: chunk.type,
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? 0,
      byteLength: chunk.byteLength,
      arrivalHostMs: this.#audioArrival(chunk.timestamp),
      data: copyOut(chunk),
    });
  }

  /**
   * Keeps the decoder config of the audio's chunks with the buffer: the encoder's, completed from its
   * config where it lacks a field the muxer needs, or, when the encoder gave none with its first
   * chunk, made from its config (T2.9, issue #33: without one the clips would have no audio track).
   */
  #describeAudio(given: AudioDecoderConfig | undefined): void {
    if (given === undefined && this.#buffer.audioTrack?.decoderConfig !== null) {
      // Described by an earlier chunk.
      return;
    }
    const copied = given === undefined ? undefined : copyDecoderConfig(given);
    let described = copied;
    const config = this.#audioConfig;
    if (config !== undefined && !isAudioDecoderConfigComplete(copied)) {
      try {
        described = audioDecoderConfigFor(config, copied);
        this.#audioConfigMade = true;
      } catch {
        // No AudioSpecificConfig for this rate or channel count: the encoder's config as it came, if
        // any; else none, and the clips say so.
      }
    }
    if (described !== undefined) {
      this.#buffer.setAudioDecoderConfig(described);
    }
  }

  /**
   * The arrival of an audio chunk's first sample: the arrival of the input it starts in, plus its
   * offset in that input. Inputs before that one are forgotten; that one is kept, since the next
   * chunk may start in it too.
   */
  #audioArrival(timestampUs: number): number {
    const inputs = this.#audioArrivals;
    let index = -1;
    while (index + 1 < inputs.length && inputs[index + 1].timestampUs <= timestampUs) {
      index += 1;
    }
    if (index < 0) {
      return this.#env.now();
    }
    const input = inputs[index];
    inputs.splice(0, index);
    return input.arrivalHostMs + (timestampUs - input.timestampUs) / 1000;
  }

  /** Audio stops; video goes on. The audio already encoded stays in the buffer. */
  #stopAudio(message: string): void {
    if (this.#audioOff || !this.#live()) {
      return;
    }
    this.#audioOff = true;
    this.#audioCodec = null;
    this.#audioError = message;
    const encoder = this.#audioEncoder;
    if (encoder !== undefined && encoder.state !== 'closed') {
      encoder.close();
    }
    this.#env.post({ type: 'error', message, fatal: false });
  }

  /** Recording stops by itself: readers cancelled, encoders closed, the buffer kept for cuts. */
  #fail(message: string): void {
    if (!this.#live()) {
      return;
    }
    this.#recording = false;
    void this.#release();
    this.#env.post({ type: 'error', message, fatal: true });
  }

  async #release(): Promise<void> {
    const readers = this.#readers.splice(0);
    for (const encoder of [this.#videoEncoder, this.#audioEncoder]) {
      if (encoder !== undefined && encoder.state !== 'closed') {
        encoder.close();
      }
    }
    await Promise.allSettled(readers.map((reader) => reader.cancel()));
  }

  #postStats(): void {
    const now = this.#env.now();
    const seconds = (now - this.#windowStartHostMs) / 1000;
    const stats: CaptureStats = {
      fps: perSecond(this.#arrivedInWindow, seconds),
      encodedFps: perSecond(this.#encodedInWindow, seconds),
      dropped: this.#dropped,
      queue: this.#videoEncoder?.encodeQueueSize ?? 0,
      bufferSeconds: Math.round(this.#buffer.bufferSeconds * 1000) / 1000,
      bufferBytes: this.#buffer.bufferBytes,
      codec: this.#buffer.videoTrack?.codec ?? null,
      bitrate: this.#videoConfig?.bitrate ?? null,
      audioCodec: this.#audioCodec,
      audioChunks: this.#audioChunks,
      audioState: this.#audioState(),
    };
    this.#arrivedInWindow = 0;
    this.#encodedInWindow = 0;
    this.#windowStartHostMs = now;
    this.#env.post({ type: 'stats', stats });
  }

  #audioState(): AudioState {
    if (!this.#audioAsked) {
      return 'off';
    }
    if (this.#audioOff) {
      return 'stopped';
    }
    return this.#audioChunks > 0 ? 'encoding' : 'waiting';
  }

  /** The audio as a clip's report needs it (T2.9). */
  #audioReport(): AudioReport {
    return {
      state: this.#audioState(),
      data: this.#audioData,
      chunks: this.#audioChunks,
      error: this.#audioError,
      configMade: this.#audioConfigMade,
    };
  }
}

async function isSupported<Config>(
  Encoder: { isConfigSupported(config: Config): Promise<{ readonly supported?: boolean }> },
  config: Config,
): Promise<boolean> {
  try {
    return (await Encoder.isConfigSupported(config)).supported === true;
  } catch {
    return false;
  }
}

/** The chunk's bytes in an ArrayBuffer of their own: the one copy out of the encoder. */
function copyOut(chunk: ChunkLike): ArrayBuffer {
  const data = new ArrayBuffer(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

/** A decoder config whose `description` (codec private data) is a copy the buffer owns. */
function copyDecoderConfig<T extends VideoDecoderConfig | AudioDecoderConfig>(config: T): T {
  const { description, ...rest } = config;
  if (description === undefined) {
    return rest as T;
  }
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  return { ...rest, description: bytes.slice().buffer } as T;
}

/** Encoders want even frame sizes (4:2:0 chroma). */
function even(size: number): number {
  return Math.max(2, size - (size % 2));
}

function perSecond(count: number, seconds: number): number {
  return seconds > 0 ? Math.round((count / seconds) * 100) / 100 : 0;
}

/** The worker's global scope, as far as this file uses it. */
interface WorkerScope extends MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

/** A global constructor or function by name, or undefined. */
function globalFunction(name: string): unknown {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'function' ? value : undefined;
}

// Only in a dedicated worker: the package's index never imports this file into the window, and
// Node's tests import `CaptureWorker` without a DedicatedWorkerGlobalScope.
if (globalFunction('DedicatedWorkerGlobalScope') !== undefined) {
  const scope = globalThis as unknown as WorkerScope;
  // For the frames the motion meter cannot copy: drawn into a canvas as wide as the meter's plane,
  // 320 or 160 pixels (T2.5, T2.8), one canvas per width.
  const samplers = new Map<number, LumaSampler<CanvasImageSource>>();
  const samplerFor = (width: number): LumaSampler<CanvasImageSource> => {
    let sampler = samplers.get(width);
    if (sampler === undefined) {
      sampler = new LumaSampler<CanvasImageSource>(offscreenCanvas, width);
      samplers.set(width, sampler);
    }
    return sampler;
  };
  const worker = new CaptureWorker({
    VideoEncoder: globalFunction('VideoEncoder') as VideoEncoderClass | undefined,
    AudioEncoder: globalFunction('AudioEncoder') as AudioEncoderClass | undefined,
    now: () => performance.timeOrigin + performance.now(),
    post: (message) => {
      post(scope, message);
    },
    every: (ms, callback) => {
      const timer = setInterval(callback, ms);
      return () => {
        clearInterval(timer);
      };
    },
    // The frames here are the camera's `VideoFrame`s, which a canvas draws.
    drawLuma: (frame, region, size) =>
      samplerFor(size.width).sample(frame as unknown as VideoFrame, region),
  });
  scope.addEventListener('message', (event) => {
    const data = event.data;
    if (isWindowToWorker(data)) {
      worker.handle(data);
    }
  });
}
