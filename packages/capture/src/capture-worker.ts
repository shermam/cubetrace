// The capture worker (docs/PLAN.md, T2.2): it reads the camera's frames and the microphone's audio
// from the streams the window transfers, encodes them with WebCodecs into the ring buffer, sends
// the counters once per second and answers cuts. Angular's builder emits it as a chunk of its own
// (docs/TOOLCHAIN.md, "The capture pipeline"); `startCapture` (pipeline.ts) starts it. Plain
// TypeScript: no Angular. The encoders, the clock and the timer come in through
// `WorkerEnvironment`, so the logic also runs in Node's tests with fakes; the last lines wire it to
// the worker's global scope.
import { cut } from './cut';
import {
  isWindowToWorker,
  post,
  type CaptureStats,
  type CutRequest,
  type MessageTarget,
  type ResolvedCaptureConfig,
  type WindowToWorker,
  type WorkerToWindow,
} from './protocol';
import { RingBuffer } from './ring-buffer';

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

/** 8 Mbps at 1080p30 and 12 at 1080p60 (docs/PLAN.md), in proportion to the pixels for other sizes. */
export function videoBitrate(width: number, height: number, fps: number): number {
  const at1080p = fps > 45 ? 12_000_000 : 8_000_000;
  return Math.round((at1080p * width * height) / (1920 * 1080));
}

/** One keyframe per second's worth of frames. */
export function keyframeInterval(fps: number): number {
  return Math.max(1, Math.round(fps));
}

/** The encoder settings of one rung of `VIDEO_ENCODERS` (docs/PLAN.md, T2.2). */
export function videoEncoderConfig(
  choice: VideoEncoderChoice,
  width: number,
  height: number,
  fps: number,
): VideoEncoderConfig {
  const config: VideoEncoderConfig = {
    codec: choice.codec,
    hardwareAcceleration: choice.hardwareAcceleration,
    width,
    height,
    bitrate: videoBitrate(width, height, fps),
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
  #trackFrameRate: number | null = null;
  #lastTimestampUs: number | undefined;
  #intervalsUs: number[] = [];
  #warmupStartHostMs: number | undefined;
  #framesSinceKey = Number.POSITIVE_INFINITY;
  #keyInterval = 30;
  /** Frame timestamp → arrival, from `encode` until the frame's chunk comes out. */
  readonly #frameArrivals = new Map<number, number>();

  #audioEncoder: AudioEncoderLike | undefined;
  #audioOff = false;
  #audioCodec: string | null = null;
  #audioArrivals: AudioArrival[] = [];

  #dropped = 0;
  #arrivedInWindow = 0;
  #encodedInWindow = 0;
  #windowStartHostMs = 0;

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
        void this.start(message.video, message.audio, message.config, message.frameRate);
        break;
      case 'cut':
        this.cut(message);
        break;
      case 'stop':
        void this.stop();
        break;
    }
  }

  /** Reads and encodes both streams until they end or `stop`; never rejects. */
  async start(
    video: ReadableStream<FrameLike>,
    audio: ReadableStream<AudioLike> | null,
    config: ResolvedCaptureConfig,
    frameRate: number | null,
  ): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#recording = true;
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
      answer = { type: 'cut-failed', id: request.id, message: describe(error) };
    }
    try {
      this.#env.post(answer);
    } catch (error: unknown) {
      this.#env.post({
        type: 'cut-failed',
        id: request.id,
        message: `The cut could not be sent: ${describe(error)}`,
      });
    }
  }

  /** Stops reading, closes the encoders, empties the buffer, then says `stopped`. */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#recording = false;
    this.#stopTicker?.();
    await this.#release();
    this.#buffer.clear();
    this.#env.post({ type: 'stopped' });
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
        } finally {
          frame.close();
        }
      }
    } catch (error: unknown) {
      this.#fail(`Reading the camera's frames failed: ${describe(error)}`);
      return;
    }
    await this.#videoEnded();
  }

  async #onFrame(frame: FrameLike, arrivalHostMs: number): Promise<void> {
    if (!this.#live()) {
      return;
    }
    this.#arrivedInWindow += 1;
    this.#noteTimestamp(frame.timestamp);
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
      this.#fail(`The video encoder refused a frame: ${describe(error)}`);
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
      const config = videoEncoderConfig(choice, width, height, fps);
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
          this.#fail(`The video encoder failed: ${describe(error)}`);
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
      bitrate: videoBitrate(width, height, config.framerate ?? this.#frameRate()),
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

  async #readAudio(stream: ReadableStream<AudioLike>): Promise<void> {
    try {
      const reader = stream.getReader();
      this.#readers.push(reader);
      for (;;) {
        const { value: data, done } = await reader.read();
        if (done) {
          break;
        }
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
      this.#stopAudio(`Reading the microphone failed: ${describe(error)}`);
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
      this.#stopAudio(`The audio encoder refused audio: ${describe(error)}`);
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
          this.#stopAudio(`The audio encoder failed: ${describe(error)}`);
        },
      });
      encoder.configure(config);
      this.#audioEncoder = encoder;
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
    const decoderConfig = metadata?.decoderConfig;
    if (decoderConfig !== undefined) {
      this.#buffer.setAudioDecoderConfig(copyDecoderConfig(decoderConfig));
    }
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
      audioCodec: this.#audioCodec,
    };
    this.#arrivedInWindow = 0;
    this.#encodedInWindow = 0;
    this.#windowStartHostMs = now;
    this.#env.post({ type: 'stats', stats });
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

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message === '' ? error.name : `${error.name}: ${error.message}`;
  }
  return String(error);
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
  });
  scope.addEventListener('message', (event) => {
    const data = event.data;
    if (isWindowToWorker(data)) {
      worker.handle(data);
    }
  });
}
