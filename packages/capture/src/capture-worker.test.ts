import { ATTEMPT_SCHEMA, type VideoClip } from '@cubetrace/core';
import { FakeDirectoryHandle } from '@cubetrace/storage';
import { Ajv2020 } from 'ajv/dist/2020';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CaptureWorker,
  MAX_ENCODE_QUEUE,
  VIDEO_ENCODERS,
  keyframeInterval,
  videoBitrate,
  videoEncoderConfig,
  type AudioLike,
  type ChunkLike,
  type EncoderInit,
  type FrameLike,
  type WorkerEnvironment,
} from './capture-worker';
import {
  resolveCaptureConfig,
  transferList,
  type CaptureStats,
  type MuxAndWriteRequest,
  type WorkerToWindow,
} from './protocol';
import { readMediaSample } from './test-media';

// The worker's loop with fake encoders, fake frames and a fake clock: a 30 fps camera whose
// timestamps are on a capture clock (µs) and whose frames arrive in the worker at a constant offset
// on the host clock (ms). T0 is a whole millisecond so that the warm-up's 500 ms are exact.
const T0 = 2_229_524_000;
const OFFSET_MS = 1_790_516_343_600;

function timestampOf(index: number): number {
  return T0 + Math.round((index * 1e6) / 30);
}

function arrivalOf(index: number): number {
  return timestampOf(index) / 1000 + OFFSET_MS;
}

class FakeFrame implements FrameLike {
  closed = false;
  readonly duration = null;
  constructor(
    readonly timestamp: number,
    readonly displayWidth = 1920,
    readonly displayHeight = 1080,
  ) {}
  close(): void {
    this.closed = true;
  }
}

class FakeAudio implements AudioLike {
  closed = false;
  readonly sampleRate = 48_000;
  readonly numberOfChannels = 1;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closed = true;
  }
}

class FakeChunk implements ChunkLike {
  constructor(
    readonly type: 'key' | 'delta',
    readonly timestamp: number,
    readonly duration: number | null,
    readonly byteLength: number,
  ) {}
  copyTo(destination: ArrayBuffer): void {
    new Uint8Array(destination).fill(this.type === 'key' ? 1 : 2);
  }
}

/** Supports the configs listed in `supported` ("codec acceleration"); outputs one chunk per frame. */
class FakeVideoEncoder {
  static supported = new Set<string>();
  static instances: FakeVideoEncoder[] = [];
  static asked: VideoEncoderConfig[] = [];
  /** The chunks' duration: null, or 0 as Chrome gives chunks of frames without a duration. */
  static chunkDuration: number | null = null;

  static isConfigSupported(config: VideoEncoderConfig): Promise<{ supported: boolean }> {
    FakeVideoEncoder.asked.push(config);
    const key = `${config.codec} ${config.hardwareAcceleration ?? 'no-preference'}`;
    return Promise.resolve({ supported: FakeVideoEncoder.supported.has(key) });
  }

  encodeQueueSize = 0;
  state: CodecState = 'unconfigured';
  /** Outputs wait for `release()` while true, as a slow encoder's do. */
  holdOutput = false;
  readonly configs: VideoEncoderConfig[] = [];
  readonly encoded: { timestamp: number; keyFrame: boolean }[] = [];
  readonly #init: EncoderInit<EncodedVideoChunkMetadata>;
  readonly #held: FakeChunk[] = [];
  #describe = false;

  constructor(init: EncoderInit<EncodedVideoChunkMetadata>) {
    this.#init = init;
    FakeVideoEncoder.instances.push(this);
  }

  configure(config: VideoEncoderConfig): void {
    this.configs.push(config);
    this.state = 'configured';
    this.#describe = true;
  }

  encode(frame: FrameLike, options?: VideoEncoderEncodeOptions): void {
    const keyFrame = options?.keyFrame === true;
    this.encoded.push({ timestamp: frame.timestamp, keyFrame });
    const chunk = new FakeChunk(
      keyFrame ? 'key' : 'delta',
      frame.timestamp,
      FakeVideoEncoder.chunkDuration,
      keyFrame ? 50 : 10,
    );
    if (this.holdOutput) {
      this.#held.push(chunk);
    } else {
      this.#emit(chunk);
    }
  }

  release(): void {
    for (const chunk of this.#held.splice(0)) {
      this.#emit(chunk);
    }
  }

  flush(): Promise<void> {
    this.release();
    return Promise.resolve();
  }

  close(): void {
    this.state = 'closed';
  }

  /** What a platform encoder does when it breaks: closes, then calls `error`. */
  fail(): void {
    this.state = 'closed';
    this.#init.error(new DOMException('the encoder crashed', 'EncodingError'));
  }

  #emit(chunk: FakeChunk): void {
    const config = this.configs[this.configs.length - 1];
    const metadata = this.#describe
      ? { decoderConfig: { codec: config.codec, description: new Uint8Array([1, 2, 3]) } }
      : undefined;
    this.#describe = false;
    this.#init.output(chunk, metadata);
  }
}

/** Takes 10 ms inputs; outputs chunks of `frameUs` (AAC's 1024 samples at 48 kHz by default). */
class FakeAudioEncoder {
  static supported = new Set<string>();
  static instances: FakeAudioEncoder[] = [];
  static frameUs = 21_333;

  static isConfigSupported(config: AudioEncoderConfig): Promise<{ supported: boolean }> {
    return Promise.resolve({ supported: FakeAudioEncoder.supported.has(config.codec) });
  }

  encodeQueueSize = 0;
  state: CodecState = 'unconfigured';
  readonly configs: AudioEncoderConfig[] = [];
  readonly #init: EncoderInit<EncodedAudioChunkMetadata>;
  #firstUs: number | undefined;
  #receivedUs = 0;
  #sent = 0;

  constructor(init: EncoderInit<EncodedAudioChunkMetadata>) {
    this.#init = init;
    FakeAudioEncoder.instances.push(this);
  }

  configure(config: AudioEncoderConfig): void {
    this.configs.push(config);
    this.state = 'configured';
  }

  encode(data: AudioLike): void {
    this.#firstUs ??= data.timestamp;
    this.#receivedUs += 10_000;
    const frameUs = FakeAudioEncoder.frameUs;
    while ((this.#sent + 1) * frameUs <= this.#receivedUs) {
      const chunk = new FakeChunk('key', this.#firstUs + this.#sent * frameUs, frameUs, 6);
      const config = this.configs[0];
      this.#init.output(chunk, this.#sent === 0 ? { decoderConfig: config } : undefined);
      this.#sent += 1;
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.state = 'closed';
  }
}

/** A stream the test feeds item by item. */
class Source<T> {
  readonly stream: ReadableStream<T>;
  cancelled = false;
  #controller: ReadableStreamDefaultController<T> | undefined;

  constructor() {
    this.stream = new ReadableStream<T>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
  }

  /** Queues `item` for the reader; false once the reader has cancelled the stream. */
  push(item: T): boolean {
    if (this.cancelled || this.#controller === undefined) {
      return false;
    }
    this.#controller.enqueue(item);
    return true;
  }

  end(): void {
    this.#controller?.close();
  }
}

/** Lets the worker's promise chains run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Harness {
  readonly worker: CaptureWorker;
  /** The origin private file system the worker writes clips into. */
  readonly root: FakeDirectoryHandle;
  readonly video: Source<FrameLike>;
  readonly audio: Source<AudioLike>;
  readonly posted: WorkerToWindow[];
  readonly frames: FakeFrame[];
  /** Feeds frames `from` to `to` (inclusive), each arriving at its own host time. */
  feed(from: number, to: number, size?: [number, number]): Promise<void>;
  /** The once-a-second stats, sent at host time `atMs`. */
  stats(atMs: number): CaptureStats;
  errors(): WorkerToWindow[];
  encoder(): FakeVideoEncoder;
  now: number;
}

function harness(options: { audio?: boolean; frameRate?: number | null } = {}): Harness {
  const posted: WorkerToWindow[] = [];
  let tick: (() => void) | undefined;
  const state = { now: arrivalOf(0) - 1 };
  const root = new FakeDirectoryHandle('', { syncAccessHandle: true });
  const env: WorkerEnvironment = {
    VideoEncoder: FakeVideoEncoder,
    AudioEncoder: FakeAudioEncoder,
    now: () => state.now,
    post: (message) => {
      transferList(message);
      posted.push(message);
    },
    every: (_ms, callback) => {
      tick = callback;
      return () => {
        tick = undefined;
      };
    },
    opfsRoot: () => Promise.resolve(root),
  };
  const worker = new CaptureWorker(env);
  const video = new Source<FrameLike>();
  const audio = new Source<AudioLike>();
  const frames: FakeFrame[] = [];
  void worker.start(
    video.stream,
    options.audio === true ? audio.stream : null,
    resolveCaptureConfig(),
    options.frameRate ?? 30,
  );
  return {
    worker,
    root,
    video,
    audio,
    posted,
    frames,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    async feed(from, to, size = [1920, 1080]) {
      for (let index = from; index <= to; index += 1) {
        const frame = new FakeFrame(timestampOf(index), size[0], size[1]);
        state.now = arrivalOf(index);
        if (video.push(frame)) {
          frames.push(frame);
        }
        await settle();
      }
    },
    stats(atMs) {
      state.now = atMs;
      tick?.();
      const last = posted[posted.length - 1];
      if (last.type !== 'stats') {
        throw new Error('no stats were sent');
      }
      return last.stats;
    },
    errors() {
      return posted.filter((message) => message.type === 'error');
    },
    encoder() {
      const encoder = FakeVideoEncoder.instances.at(-1);
      if (encoder === undefined) {
        throw new Error('no video encoder yet');
      }
      return encoder;
    },
  };
}

/** Indices (0 = the first encoded frame) of the frames encoded as keyframes. */
function keyIndices(encoder: FakeVideoEncoder): number[] {
  return encoder.encoded.flatMap((call, index) => (call.keyFrame ? [index] : []));
}

beforeEach(() => {
  FakeVideoEncoder.supported = new Set(['vp09.00.40.08 no-preference']);
  FakeVideoEncoder.instances = [];
  FakeVideoEncoder.asked = [];
  FakeVideoEncoder.chunkDuration = null;
  FakeAudioEncoder.supported = new Set(['opus']);
  FakeAudioEncoder.instances = [];
  FakeAudioEncoder.frameUs = 21_333;
});

describe('the encoder settings', () => {
  it('tries H.264 High, then Main, each on the platform encoder first, then VP9', () => {
    expect(
      VIDEO_ENCODERS.map((choice) => `${choice.codec} ${choice.hardwareAcceleration}`),
    ).toEqual([
      'avc1.640028 prefer-hardware',
      'avc1.640028 no-preference',
      'avc1.4d0028 prefer-hardware',
      'avc1.4d0028 no-preference',
      'vp09.00.40.08 no-preference',
    ]);
  });

  it('asks 8 Mbps at 1080p30 and 12 at 1080p60, in the quality latency mode, H.264 as avc', () => {
    expect(videoBitrate(1920, 1080, 30)).toBe(8_000_000);
    expect(videoBitrate(1080, 1920, 30)).toBe(8_000_000);
    expect(videoBitrate(1920, 1080, 60)).toBe(12_000_000);
    expect(videoBitrate(1280, 720, 30)).toBe(3_555_556);
    expect(videoEncoderConfig(VIDEO_ENCODERS[0], 1920, 1080, 29.97)).toEqual({
      codec: 'avc1.640028',
      hardwareAcceleration: 'prefer-hardware',
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      framerate: 30,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    });
    expect(videoEncoderConfig(VIDEO_ENCODERS[4], 1920, 1080, 30)).not.toHaveProperty('avc');
    expect(keyframeInterval(30)).toBe(30);
    expect(keyframeInterval(59.94)).toBe(60);
    expect(keyframeInterval(0.2)).toBe(1);
  });
});

describe('CaptureWorker', () => {
  it.each([
    [
      ['avc1.640028 prefer-hardware', 'vp09.00.40.08 no-preference'],
      'avc1.640028',
      'prefer-hardware',
    ],
    [['avc1.640028 no-preference', 'avc1.4d0028 prefer-hardware'], 'avc1.640028', 'no-preference'],
    [['avc1.4d0028 no-preference', 'vp09.00.40.08 no-preference'], 'avc1.4d0028', 'no-preference'],
    [['vp09.00.40.08 no-preference'], 'vp09.00.40.08', 'no-preference'],
  ])('with %j supported, encodes with %s (%s)', async (supported, codec, acceleration) => {
    FakeVideoEncoder.supported = new Set(supported);
    const capture = harness();

    await capture.feed(0, 20);

    expect(capture.encoder().configs).toEqual([
      expect.objectContaining({ codec, hardwareAcceleration: acceleration }),
    ]);
    expect(capture.worker.buffer.videoTrack?.codec).toBe(codec);
    expect(capture.stats(arrivalOf(21)).codec).toBe(codec);
  });

  it('stops with a fatal error when no encoder takes the frames, and closes them all', async () => {
    FakeVideoEncoder.supported = new Set();
    const capture = harness();

    await capture.feed(0, 20);

    expect(FakeVideoEncoder.asked.map((config) => config.codec)).toEqual(
      VIDEO_ENCODERS.map((choice) => choice.codec),
    );
    expect(capture.errors()).toEqual([
      {
        type: 'error',
        fatal: true,
        message: expect.stringMatching(
          /^No video encoder takes 1920×1080 at 30 fps; tried avc1/,
        ) as unknown,
      },
    ]);
    expect(capture.video.cancelled).toBe(true);
    expect(capture.frames.every((frame) => frame.closed)).toBe(true);
  });

  it('measures the frame rate from the timestamps for half a second, whatever the track says', async () => {
    const capture = harness({ frameRate: 60 });

    await capture.feed(0, 14);
    expect(FakeVideoEncoder.instances).toEqual([]);
    await capture.feed(15, 15);

    // 30 fps from the timestamps, although the track claims 60: 8 Mbps, not 12.
    expect(capture.encoder().configs[0]).toMatchObject({
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 8_000_000,
    });
    // The warm-up's frames are closed without being encoded; the encoding starts with a keyframe.
    expect(capture.encoder().encoded).toEqual([{ timestamp: timestampOf(15), keyFrame: true }]);
    expect(capture.frames.every((frame) => frame.closed)).toBe(true);
  });

  it('forces a keyframe every second of frames', async () => {
    const capture = harness();

    await capture.feed(0, 15 + 99);

    expect(capture.encoder().encoded).toHaveLength(100);
    expect(keyIndices(capture.encoder())).toEqual([0, 30, 60, 90]);
    expect(capture.worker.buffer.video[0].type).toBe('key');
    expect(capture.worker.buffer.bufferSeconds).toBeCloseTo(100 / 30, 3);
  });

  it('drops the frames that find more than 8 in the queue, counts them, and keys the next one due', async () => {
    const capture = harness();
    await capture.feed(0, 15 + 27);
    const encoder = capture.encoder();

    encoder.encodeQueueSize = MAX_ENCODE_QUEUE + 1;
    await capture.feed(15 + 28, 15 + 33);
    encoder.encodeQueueSize = MAX_ENCODE_QUEUE;
    await capture.feed(15 + 34, 15 + 40);

    expect(encoder.encoded).toHaveLength(28 + 7);
    expect(encoder.encoded[28]).toEqual({ timestamp: timestampOf(15 + 34), keyFrame: true });
    expect(keyIndices(encoder)).toEqual([0, 28]);
    expect(capture.stats(arrivalOf(15 + 41)).dropped).toBe(6);
    expect(capture.frames.every((frame) => frame.closed)).toBe(true);
  });

  it("gives each chunk its frame's arrival, even when the encoder answers late", async () => {
    const capture = harness();
    await capture.feed(0, 15);
    const encoder = capture.encoder();
    encoder.holdOutput = true;

    await capture.feed(16, 25);
    expect(capture.worker.buffer.video).toHaveLength(1);
    capture.now = arrivalOf(40);
    encoder.release();

    expect(capture.worker.buffer.video.map((chunk) => chunk.arrivalHostMs)).toEqual(
      Array.from({ length: 11 }, (_, index) => arrivalOf(15 + index)),
    );
    expect(capture.worker.buffer.video.map((chunk) => chunk.timestampUs)).toEqual(
      Array.from({ length: 11 }, (_, index) => timestampOf(15 + index)),
    );
    // No duration on the frames: one frame interval at the measured rate.
    expect(capture.worker.buffer.video[0].durationUs).toBe(33_333);
    // The bytes are the chunk's, copied out once.
    expect([...new Uint8Array(capture.worker.buffer.video[0].data)]).toEqual(Array(50).fill(1));
  });

  it('gives the chunks of frames without a duration one frame interval, where Chrome says 0', async () => {
    FakeVideoEncoder.chunkDuration = 0;
    const capture = harness();
    await capture.feed(0, 20);

    expect(capture.worker.buffer.video.map((chunk) => chunk.durationUs)).toEqual(
      Array(6).fill(33_333),
    );
    expect(capture.worker.buffer.bufferSeconds).toBeCloseTo(6 / 30, 3);
  });

  it("keeps the encoder's decoder config with the buffer, its description copied", async () => {
    const capture = harness();
    await capture.feed(0, 20);

    const config = capture.worker.buffer.videoTrack?.decoderConfig;
    expect(config?.codec).toBe('vp09.00.40.08');
    expect(config?.description).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(config?.description as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it('sends the counters once per second', async () => {
    const capture = harness();
    await capture.feed(0, 29);
    const first = capture.stats(arrivalOf(0) - 1 + 1000);

    // 30 frames in the first second, 15 of them after the warm-up.
    expect(first).toEqual({
      fps: 30,
      encodedFps: 15,
      dropped: 0,
      queue: 0,
      bufferSeconds: 0.5,
      bufferBytes: 50 + 14 * 10,
      codec: 'vp09.00.40.08',
      audioCodec: null,
    });
    await capture.feed(30, 59);
    expect(capture.stats(arrivalOf(0) - 1 + 2000)).toMatchObject({ fps: 30, encodedFps: 30 });
  });

  it('encodes the audio with AAC, else Opus, each chunk arriving with its first sample', async () => {
    FakeAudioEncoder.supported = new Set(['opus']);
    const capture = harness({ audio: true });
    const inputs: FakeAudio[] = [];
    for (let index = 0; index < 20; index += 1) {
      const data = new FakeAudio(T0 + index * 10_000);
      inputs.push(data);
      capture.now = OFFSET_MS + (T0 + index * 10_000) / 1000 + 12 + (index % 3);
      capture.audio.push(data);
      await settle();
    }

    expect(FakeAudioEncoder.instances[0].configs).toEqual([
      { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1, bitrate: 128_000 },
    ]);
    expect(capture.stats(OFFSET_MS + T0 / 1000 + 1000).audioCodec).toBe('opus');
    const chunks = capture.worker.buffer.audio;
    expect(chunks).toHaveLength(9);
    // Chunk 1 starts 21.333 ms in: in input 2, which arrived at +12 + 2 ms, 1.333 ms into it.
    expect(chunks[1].timestampUs).toBe(T0 + 21_333);
    expect(chunks[1].arrivalHostMs).toBeCloseTo(OFFSET_MS + (T0 + 20_000) / 1000 + 14 + 1.333, 6);
    expect(capture.worker.buffer.audioTrack).toMatchObject({ codec: 'opus', sampleRate: 48_000 });
    expect(capture.worker.buffer.audioTrack?.decoderConfig?.codec).toBe('opus');
    expect(inputs.every((data) => data.closed)).toBe(true);
  });

  it('records video only when no audio encoder takes the audio, and says so once', async () => {
    FakeAudioEncoder.supported = new Set();
    const capture = harness({ audio: true });
    const data = new FakeAudio(T0);
    capture.audio.push(data);
    await settle();
    await capture.feed(0, 20);

    expect(capture.errors()).toEqual([
      {
        type: 'error',
        fatal: false,
        message:
          'No audio encoder takes 48000 Hz, 1 channel(s) (tried mp4a.40.2, opus): recording video only.',
      },
    ]);
    expect(data.closed).toBe(true);
    expect(capture.audio.cancelled).toBe(true);
    expect(capture.encoder().encoded.length).toBeGreaterThan(0);
    expect(capture.stats(arrivalOf(21)).audioCodec).toBeNull();
  });

  it('answers a cut with its chunks, and says why when there is nothing to cut', async () => {
    const capture = harness();
    capture.worker.handle({ type: 'cut', id: 1, startHostMs: 0, endHostMs: 1 });
    await capture.feed(0, 15 + 89);

    capture.worker.handle({
      type: 'cut',
      id: 2,
      startHostMs: arrivalOf(15 + 45),
      endHostMs: arrivalOf(15 + 80),
    });

    expect(capture.posted[0]).toEqual({
      type: 'cut-failed',
      id: 1,
      message: 'RangeError: Nothing is buffered yet.',
    });
    const answer = capture.posted[capture.posted.length - 1];
    if (answer.type !== 'cut-done') {
      throw new Error(`expected a cut, got ${answer.type}`);
    }
    expect(answer.id).toBe(2);
    expect(answer.cut.video.chunks[0]).toMatchObject({
      type: 'key',
      timestampUs: timestampOf(15 + 30),
    });
    expect(answer.cut.video.chunks).toHaveLength(51);
    expect(answer.cut.frames.t0HostMs).toBeCloseTo(arrivalOf(15 + 30), 1);
  });

  it('stops: readers cancelled, encoders closed, buffer emptied, then stopped', async () => {
    const capture = harness({ audio: true });
    capture.audio.push(new FakeAudio(T0));
    await capture.feed(0, 40);

    await capture.worker.stop();

    expect(capture.posted[capture.posted.length - 1]).toEqual({ type: 'stopped' });
    expect(capture.video.cancelled).toBe(true);
    expect(capture.audio.cancelled).toBe(true);
    expect(capture.encoder().state).toBe('closed');
    expect(FakeAudioEncoder.instances[0].state).toBe('closed');
    expect(capture.worker.buffer.video).toEqual([]);
    expect(capture.errors()).toEqual([]);
  });

  it("keeps the buffer when the camera's track ends: recording stops, cuts still work", async () => {
    const capture = harness();
    await capture.feed(0, 15 + 59);

    capture.video.end();
    await settle();

    expect(capture.errors()).toEqual([
      {
        type: 'error',
        fatal: true,
        message: 'The camera stopped sending frames (its track ended or the stream was closed).',
      },
    ]);
    expect(capture.worker.buffer.video).toHaveLength(60);
    capture.worker.handle({ type: 'cut', id: 3, startHostMs: 0, endHostMs: arrivalOf(1000) });
    expect(capture.posted[capture.posted.length - 1]).toMatchObject({ type: 'cut-done', id: 3 });
  });

  it("reports the encoder's failure as fatal and keeps the buffer", async () => {
    const capture = harness();
    await capture.feed(0, 40);

    capture.encoder().fail();
    await settle();
    await capture.feed(41, 45);

    expect(capture.errors()).toEqual([
      {
        type: 'error',
        fatal: true,
        message: 'The video encoder failed: EncodingError: the encoder crashed',
      },
    ]);
    expect(capture.worker.buffer.video).toHaveLength(26);
    expect(capture.video.cancelled).toBe(true);
  });

  it('starts the buffer again at the new size when the frames change size', async () => {
    const capture = harness();
    await capture.feed(0, 40);
    const encoder = capture.encoder();

    await capture.feed(41, 50, [1080, 1920]);

    expect(encoder.configs.map((config) => [config.width, config.height])).toEqual([
      [1920, 1080],
      [1080, 1920],
    ]);
    expect(capture.worker.buffer.videoTrack).toMatchObject({ width: 1080, height: 1920 });
    expect(capture.worker.buffer.video).toHaveLength(10);
    expect(capture.worker.buffer.video[0]).toMatchObject({
      type: 'key',
      timestampUs: timestampOf(41),
    });
  });
});

describe('CaptureWorker saving clips', () => {
  const SESSION = '3f1c2b7e-8a4d-4f2e-9b1a-0c5d6e7f8a9b';

  /**
   * A worker whose buffer holds the recorded sample (fixtures/media/), pushed as its encoders would
   * have, and a file system with the session's folder.
   */
  async function sampleWorker() {
    const root = new FakeDirectoryHandle('', { syncAccessHandle: true });
    await root.plant(`sessions/${SESSION}/session.json`, '{}');
    const posted: WorkerToWindow[] = [];
    const worker = new CaptureWorker({
      VideoEncoder: undefined,
      AudioEncoder: undefined,
      now: () => 0,
      post: (message) => {
        transferList(message);
        posted.push(message);
      },
      every: () => () => undefined,
      opfsRoot: () => Promise.resolve(root),
    });
    const sample = readMediaSample();
    const buffer = worker.buffer;
    const { chunks: video, decoderConfig: videoConfig, ...videoTrack } = sample.video;
    buffer.setVideoTrack(videoTrack);
    if (videoConfig !== null) {
      buffer.setVideoDecoderConfig(videoConfig);
    }
    const audio = sample.audio;
    if (audio !== null) {
      const { codec, sampleRate, numberOfChannels, decoderConfig } = audio;
      buffer.setAudioTrack({ codec, sampleRate, numberOfChannels });
      if (decoderConfig !== null) {
        buffer.setAudioDecoderConfig(decoderConfig);
      }
    }
    for (const chunk of [...video, ...(audio?.chunks ?? [])].sort(
      (p, q) => p.timestampUs - q.timestampUs,
    )) {
      buffer.push(chunk);
    }
    const request = (
      id: number,
      changes: Partial<MuxAndWriteRequest> = {},
    ): MuxAndWriteRequest => ({
      type: 'mux-and-write',
      id,
      startHostMs: sample.startHostMs,
      endHostMs: sample.endHostMs,
      sessionId: SESSION,
      index: 3,
      camera: 'laptop',
      segment: 'solve',
      fpsNominal: 30,
      ...changes,
    });
    return { worker, posted, root, sample, request };
  }

  function clipOf(message: WorkerToWindow | undefined): VideoClip {
    if (message?.type !== 'mux-and-write-done') {
      throw new Error(`expected a clip, got ${JSON.stringify(message)}`);
    }
    return message.clip;
  }

  it('cuts, muxes and writes the clip into the attempt folder, and answers with its video[] entry', async () => {
    const { worker, posted, root, sample, request } = await sampleWorker();

    await worker.muxAndWrite(request(1));

    const clip = clipOf(posted.at(-1));
    expect(posted.at(-1)).toMatchObject({ id: 1 });
    const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
    ajv.addSchema(ATTEMPT_SCHEMA);
    const validate = ajv.getSchema(`${String(ATTEMPT_SCHEMA['$id'])}#/$defs/clip`);
    expect(validate?.(clip), JSON.stringify(validate?.errors)).toBe(true);
    expect(clip).toMatchObject({
      camera: 'laptop',
      segment: 'solve',
      file: 'laptop.solve.mp4',
      codec: 'vp09.00.40.08',
      audio: 'opus',
      width: 1920,
      height: 1080,
      fpsNominal: 30,
      frames: sample.video.chunks.length,
      firstFrameHostMs: sample.frames.t0HostMs,
      framesFile: 'laptop.solve.frames.json',
      crop: null,
      syncResidualMs: null,
    });
    const folder = `sessions/${SESSION}/attempts/0003`;
    const mp4 = root.files().get(`${folder}/laptop.solve.mp4`)?.bytes;
    expect(mp4?.length).toBe(clip.bytes);
    const input = new Input({
      source: new BufferSource(mp4 ?? new Uint8Array(0)),
      formats: ALL_FORMATS,
    });
    const videoTrack = await input.getPrimaryVideoTrack();
    expect((await videoTrack?.computePacketStats())?.packetCount).toBe(clip.frames);
    expect(
      JSON.parse(root.files().get(`${folder}/laptop.solve.frames.json`)?.text ?? ''),
    ).toMatchObject({ camera: 'laptop', segment: 'solve', dtMs: sample.frames.dtMs });
    // The buffer's own bytes were muxed, neither copied into the answer nor moved away.
    expect(transferList(posted[0])).toEqual([]);
    expect(worker.buffer.video.every((chunk) => chunk.data.byteLength === chunk.byteLength)).toBe(
      true,
    );
  });

  it('says why when there is no clip: nothing buffered, the start older than the buffer, no session folder', async () => {
    const { worker, posted, sample, request } = await sampleWorker();
    const empty = new CaptureWorker({
      VideoEncoder: undefined,
      AudioEncoder: undefined,
      now: () => 0,
      post: (message) => posted.push(message),
      every: () => () => undefined,
      opfsRoot: () => Promise.reject(new Error('unused')),
    });

    await empty.muxAndWrite(request(1));
    await worker.muxAndWrite(request(2, { startHostMs: sample.startHostMs - 60_000 }));
    await worker.muxAndWrite(request(3, { sessionId: 'gone' }));
    await worker.muxAndWrite(request(4, { camera: 'Laptop' }));

    expect(posted).toEqual([
      { type: 'mux-and-write-failed', id: 1, message: 'RangeError: Nothing is buffered yet.' },
      {
        type: 'mux-and-write-failed',
        id: 2,
        message: expect.stringMatching(
          /^Error: Cannot mux a cut whose start is older than the buffer \(truncatedStart\)/,
        ) as unknown,
      },
      {
        type: 'mux-and-write-failed',
        id: 3,
        message: 'Error: No session gone: its folder is missing.',
      },
      {
        type: 'mux-and-write-failed',
        id: 4,
        message: expect.stringMatching(/^RangeError: "Laptop" is not a camera label/) as unknown,
      },
    ]);
  });

  it('saves the clips one at a time, in the order asked, and stops once they are written', async () => {
    const { worker, posted, root, request } = await sampleWorker();

    worker.handle(request(1, { segment: 'scramble' }));
    worker.handle(request(2));
    await worker.stop();

    // The cuts were taken when asked: the buffer emptied by the stop did not change them.
    expect(worker.buffer.video).toEqual([]);

    expect(posted.map((message) => [message.type, 'id' in message ? message.id : null])).toEqual([
      ['mux-and-write-done', 1],
      ['mux-and-write-done', 2],
      ['stopped', null],
    ]);
    expect([...root.files().keys()].filter((path) => path.endsWith('.mp4')).sort()).toEqual([
      `sessions/${SESSION}/attempts/0003/laptop.scramble.mp4`,
      `sessions/${SESSION}/attempts/0003/laptop.solve.mp4`,
    ]);
  });
});
