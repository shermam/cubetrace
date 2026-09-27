import type { VideoClip } from '@cubetrace/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Cut } from './cut';
import {
  AUDIO_PROCESSOR_BUFFER,
  CUT_TIMEOUT_MS,
  SAVE_CLIP_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  VIDEO_PROCESSOR_BUFFER,
  captureSupport,
  startCapture,
  type CaptureHandle,
} from './pipeline';
import type {
  CaptureStats,
  ConnectMessage,
  DeleteClipParams,
  SaveClipParams,
  StartMessage,
  WorkerToWindow,
} from './protocol';

/** A worker that records what the window posts and answers when the test says. */
class FakeWorker extends EventTarget {
  readonly posted: { message: unknown; transfer: Transferable[] }[] = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: WorkerToWindow): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }));
  }

  messages(): unknown[] {
    return this.posted.map((entry) => entry.message);
  }
}

/** Chrome's MediaStreamTrackProcessor, with a stream per track. */
class FakeProcessor {
  static tracks: unknown[] = [];
  static instances: FakeProcessor[] = [];
  cancelled = false;
  readonly maxBufferSize: number | undefined;
  readonly readable = new ReadableStream({
    cancel: () => {
      this.cancelled = true;
    },
  });
  constructor(init: { track: unknown; maxBufferSize?: number }) {
    FakeProcessor.tracks.push(init.track);
    FakeProcessor.instances.push(this);
    this.maxBufferSize = init.maxBufferSize;
  }
}

const videoTrack = { kind: 'video', getSettings: () => ({ frameRate: 30, width: 1920 }) };
const audioTrack = { kind: 'audio', getSettings: () => ({ sampleRate: 48_000 }) };

function stream(tracks: { video?: boolean; audio?: boolean } = {}): MediaStream {
  return {
    getVideoTracks: () => (tracks.video === false ? [] : [videoTrack]),
    getAudioTracks: () => (tracks.audio === false ? [] : [audioTrack]),
  } as unknown as MediaStream;
}

let worker: FakeWorker;
let clipWorker: FakeWorker;
const ports: MessagePort[] = [];

function start(options: Parameters<typeof startCapture>[1] = {}, media = stream()): CaptureHandle {
  worker = new FakeWorker();
  clipWorker = new FakeWorker();
  const handle = startCapture(
    media,
    options,
    () => worker as unknown as Worker,
    () => clipWorker as unknown as Worker,
  );
  // The channel's ports, closed after the test.
  ports.push(
    ...[worker, clipWorker].flatMap((fake) =>
      fake.posted.flatMap((entry) => entry.transfer.filter((item) => item instanceof MessagePort)),
    ),
  );
  return handle;
}

const STATS: CaptureStats = {
  fps: 30,
  encodedFps: 30,
  dropped: 0,
  queue: 1,
  bufferSeconds: 12.5,
  bufferBytes: 1_500_000,
  codec: 'vp09.00.40.08',
  audioCodec: 'opus',
};

/** A stand-in for a cut: the pipeline passes it through untouched. */
const A_CUT = { startHostMs: 1, endHostMs: 2 } as unknown as Cut;

const PARAMS: SaveClipParams = {
  startHostMs: 1000,
  endHostMs: 4000,
  sessionId: '3f1c2b7e-8a4d-4f2e-9b1a-0c5d6e7f8a9b',
  index: 2,
  camera: 'laptop',
  segment: 'solve',
  fpsNominal: 30,
};

const A_CLIP: VideoClip = {
  camera: 'laptop',
  segment: 'solve',
  file: 'laptop.solve.mp4',
  bytes: 171_275,
  codec: 'vp09.00.40.08',
  audio: 'opus',
  width: 1920,
  height: 1080,
  crop: null,
  fpsNominal: 30,
  frames: 90,
  firstFrameHostMs: 1000.5,
  framesFile: 'laptop.solve.frames.json',
  syncResidualMs: null,
};

beforeEach(() => {
  FakeProcessor.tracks = [];
  FakeProcessor.instances = [];
  vi.stubGlobal('MediaStreamTrackProcessor', FakeProcessor);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const port of ports.splice(0)) {
    port.close();
  }
});

describe('captureSupport', () => {
  it('names what the browser lacks', () => {
    const fn = (): void => undefined;
    expect(captureSupport({})).toEqual({
      supported: false,
      missing: ['MediaStreamTrackProcessor', 'VideoEncoder', 'Worker'],
    });
    expect(captureSupport({ VideoEncoder: fn, Worker: fn })).toEqual({
      supported: false,
      missing: ['MediaStreamTrackProcessor'],
    });
    expect(captureSupport({ MediaStreamTrackProcessor: fn, VideoEncoder: fn, Worker: fn })).toEqual(
      { supported: true, missing: [] },
    );
  });
});

describe('startCapture', () => {
  it("moves the video and audio tracks' frames to the capture worker, and joins it to the clip worker", () => {
    start();

    expect(FakeProcessor.tracks).toEqual([videoTrack, audioTrack]);
    expect(worker.posted).toHaveLength(1);
    const { message, transfer } = worker.posted[0];
    const startMessage = message as StartMessage;
    expect(startMessage).toMatchObject({
      type: 'start',
      frameRate: 30,
      config: { audio: true, bufferSeconds: 90, bufferBytes: 160_000_000 },
    });
    expect(transfer).toEqual([startMessage.video, startMessage.audio, startMessage.clips]);
    // The other end of the capture worker's channel goes to the clip worker.
    expect(clipWorker.posted).toHaveLength(1);
    const connect = clipWorker.posted[0].message as ConnectMessage;
    expect(connect.type).toBe('connect');
    expect(connect.port).toBeInstanceOf(MessagePort);
    expect(connect.port).not.toBe(startMessage.clips);
    expect(clipWorker.posted[0].transfer).toEqual([connect.port]);
  });

  it('lets the processors keep frames for a worker that is late to read them', () => {
    start();

    expect(FakeProcessor.instances.map((processor) => processor.maxBufferSize)).toEqual([
      VIDEO_PROCESSOR_BUFFER,
      AUDIO_PROCESSOR_BUFFER,
    ]);
    expect(VIDEO_PROCESSOR_BUFFER).toBe(10);
    expect(AUDIO_PROCESSOR_BUFFER).toBe(50);
  });

  it('leaves the audio out when asked to, or when the stream has none', () => {
    start({ audio: false });
    expect((worker.posted[0].message as StartMessage).audio).toBeNull();
    expect(worker.posted[0].transfer).toHaveLength(2);

    start({}, stream({ audio: false }));
    expect((worker.posted[0].message as StartMessage).audio).toBeNull();
    // The audio track was never handed to a processor.
    expect(FakeProcessor.tracks).toEqual([videoTrack, videoTrack]);
  });

  it('lets go of the frames when a worker cannot start, and of the capture worker', () => {
    const failing = (): Worker => {
      throw new Error('blocked by the content security policy');
    };
    expect(() => startCapture(stream(), {}, failing)).toThrow('blocked by the content security');
    expect(FakeProcessor.instances.map((processor) => processor.cancelled)).toEqual([true, true]);

    const started = new FakeWorker();
    expect(() => startCapture(stream(), {}, () => started as unknown as Worker, failing)).toThrow(
      'blocked by the content security',
    );
    expect(started.terminated).toBe(true);
    expect(started.posted).toEqual([]);
  });

  it('refuses a browser without MediaStreamTrackProcessor, or a stream without video', () => {
    expect(() => start({}, stream({ video: false }))).toThrow('The stream has no video track.');
    vi.stubGlobal('MediaStreamTrackProcessor', undefined);
    expect(() => start()).toThrow(/no MediaStreamTrackProcessor/);
  });
});

describe('CaptureHandle', () => {
  it('resolves each cut with the answer to its own request', async () => {
    const capture = start();
    const first = capture.cut(1000, 4000);
    const second = capture.cut(2000, 5000);
    const other = { ...A_CUT, startHostMs: 2000 } as Cut;

    expect(worker.messages().slice(1)).toEqual([
      { type: 'cut', id: 1, startHostMs: 1000, endHostMs: 4000 },
      { type: 'cut', id: 2, startHostMs: 2000, endHostMs: 5000 },
    ]);
    worker.reply({ type: 'cut-done', id: 2, cut: other });
    worker.reply({ type: 'cut-failed', id: 1, message: 'RangeError: Nothing is buffered yet.' });

    await expect(second).resolves.toBe(other);
    await expect(first).rejects.toThrow('RangeError: Nothing is buffered yet.');
  });

  it('gives up on a cut the worker does not answer', async () => {
    vi.useFakeTimers();
    const capture = start();
    const cut = capture.cut(1000, 4000);
    const failure = expect(cut).rejects.toThrow(/did not answer within 10000 ms/);

    vi.advanceTimersByTime(CUT_TIMEOUT_MS);

    await failure;
  });

  it("relays the worker's counters and errors to its listeners until they unsubscribe", () => {
    const capture = start();
    const stats: CaptureStats[] = [];
    const errors: unknown[] = [];
    const stopStats = capture.onStats((value) => stats.push(value));
    capture.onError((error) => errors.push(error));

    worker.reply({ type: 'stats', stats: STATS });
    worker.reply({ type: 'error', message: 'The audio encoder failed.', fatal: false });
    stopStats();
    worker.reply({ type: 'stats', stats: { ...STATS, fps: 29 } });
    worker.dispatchEvent(new MessageEvent('message', { data: { something: 'else' } }));

    expect(stats).toEqual([STATS]);
    expect(errors).toEqual([{ message: 'The audio encoder failed.', fatal: false }]);
  });

  it('reports a worker that fails to load as a fatal error', () => {
    const capture = start();
    const errors: unknown[] = [];
    capture.onError((error) => errors.push(error));
    const event = Object.assign(new Event('error', { cancelable: true }), { message: '' });

    worker.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(errors).toEqual([
      { message: 'The capture worker failed: it could not start', fatal: true },
    ]);
  });

  it('stops once the worker has closed its encoders: terminated, pending cuts rejected', async () => {
    const capture = start();
    const pending = capture.cut(1000, 4000);
    const stopping = capture.stop();

    expect(worker.messages().at(-1)).toEqual({ type: 'stop' });
    expect(capture.stop()).toBe(stopping);
    worker.reply({ type: 'stopped' });
    await stopping;

    expect(worker.terminated).toBe(true);
    expect(clipWorker.terminated).toBe(true);
    await expect(pending).rejects.toThrow('The capture has stopped.');
    await expect(capture.cut(1000, 2000)).rejects.toThrow('The capture has stopped.');
    // start, cut, stop: nothing is posted after the stop.
    expect(worker.messages()).toHaveLength(3);
  });

  it('asks the capture worker to cut a clip and resolves with the answer of either worker', async () => {
    const capture = start();
    const first = capture.saveClip(PARAMS);
    const second = capture.saveClip({ ...PARAMS, segment: 'scramble' });
    const third = capture.saveClip({ ...PARAMS, index: 3 });

    expect(worker.messages().slice(1)).toEqual([
      { type: 'mux-and-write', id: 1, ...PARAMS },
      { type: 'mux-and-write', id: 2, ...PARAMS, segment: 'scramble' },
      { type: 'mux-and-write', id: 3, ...PARAMS, index: 3 },
    ]);
    // Nothing is transferred either way: the MP4 stays in the workers.
    expect(worker.posted.slice(1).map((entry) => entry.transfer)).toEqual([[], [], []]);
    // The clip worker answers the clips it saved or could not write...
    clipWorker.reply({ type: 'mux-and-write-done', id: 1, clip: A_CLIP });
    clipWorker.reply({
      type: 'mux-and-write-failed',
      id: 2,
      message: 'Error: No session gone: its folder is missing.',
    });
    // ...and the capture worker those it could not cut.
    worker.reply({
      type: 'mux-and-write-failed',
      id: 3,
      message: 'RangeError: Nothing is buffered yet.',
    });

    await expect(first).resolves.toBe(A_CLIP);
    await expect(second).rejects.toThrow('Error: No session gone: its folder is missing.');
    await expect(third).rejects.toThrow('RangeError: Nothing is buffered yet.');
  });

  it('asks the clip worker to remove a clip and resolves with whether it did', async () => {
    const capture = start();
    const params: DeleteClipParams = {
      sessionId: PARAMS.sessionId,
      index: 2,
      camera: 'laptop',
      segment: 'solve',
      firstFrameHostMs: 1000.5,
    };
    const removed = capture.deleteClip(params);
    const kept = capture.deleteClip({ ...params, segment: 'scramble' });
    const failed = capture.deleteClip({ ...params, index: 3 });

    expect(clipWorker.messages().slice(1)).toEqual([
      { type: 'delete-clip', id: 1, ...params },
      { type: 'delete-clip', id: 2, ...params, segment: 'scramble' },
      { type: 'delete-clip', id: 3, ...params, index: 3 },
    ]);
    clipWorker.reply({ type: 'delete-clip-done', id: 1, deleted: true });
    clipWorker.reply({ type: 'delete-clip-done', id: 2, deleted: false });
    clipWorker.reply({ type: 'delete-clip-failed', id: 3, message: 'NoModificationAllowedError' });

    await expect(removed).resolves.toBe(true);
    await expect(kept).resolves.toBe(false);
    await expect(failed).rejects.toThrow('NoModificationAllowedError');
  });

  it('refuses clips once the clip worker has failed, while recording goes on', async () => {
    const capture = start();
    const errors: unknown[] = [];
    capture.onError((error) => errors.push(error));
    const waiting = capture.saveClip(PARAMS);
    const event = Object.assign(new Event('error', { cancelable: true }), {
      message: 'Uncaught SyntaxError',
    });

    clipWorker.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(errors).toEqual([
      { message: 'The clip worker failed: Uncaught SyntaxError', fatal: false },
    ]);
    await expect(waiting).rejects.toThrow('The clip worker failed: Uncaught SyntaxError');
    await expect(capture.saveClip(PARAMS)).rejects.toThrow('The clip worker failed');
    await expect(capture.deleteClip({ ...PARAMS, firstFrameHostMs: 0 })).rejects.toThrow(
      'The clip worker failed',
    );
    // Cuts still work: the capture worker is fine.
    const cut = capture.cut(1000, 2000);
    worker.reply({ type: 'cut-done', id: 2, cut: A_CUT });
    await expect(cut).resolves.toBe(A_CUT);
  });

  it('gives up on a clip the worker does not save within 30 s', async () => {
    vi.useFakeTimers();
    const capture = start();
    const clip = capture.saveClip(PARAMS);
    const failure = expect(clip).rejects.toThrow(/did not answer within 30000 ms/);

    vi.advanceTimersByTime(SAVE_CLIP_TIMEOUT_MS - 1);
    worker.reply({ type: 'cut-done', id: 1, cut: A_CUT });
    vi.advanceTimersByTime(1);

    await failure;
  });

  it('stops only once the clips being saved are written, and refuses new ones meanwhile', async () => {
    const capture = start();
    const saving = capture.saveClip(PARAMS);
    const stopping = capture.stop();
    await Promise.resolve();

    // Still saving: no stop yet, and no new clip.
    expect(worker.messages().at(-1)).toMatchObject({ type: 'mux-and-write', id: 1 });
    await expect(capture.saveClip(PARAMS)).rejects.toThrow('The capture has stopped.');
    clipWorker.reply({ type: 'mux-and-write-done', id: 1, clip: A_CLIP });
    await expect(saving).resolves.toBe(A_CLIP);
    await vi.waitFor(() => {
      expect(worker.messages().at(-1)).toEqual({ type: 'stop' });
    });
    worker.reply({ type: 'stopped' });
    await stopping;

    expect(worker.terminated).toBe(true);
    expect(clipWorker.terminated).toBe(true);
  });

  it('terminates a worker that does not answer the stop', async () => {
    vi.useFakeTimers();
    const capture = start();
    const stopping = capture.stop();

    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS - 1);
    expect(worker.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(worker.terminated).toBe(true);
  });
});
