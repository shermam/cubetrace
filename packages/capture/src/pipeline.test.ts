import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Cut } from './cut';
import {
  CUT_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  captureSupport,
  startCapture,
  type CaptureHandle,
} from './pipeline';
import type { CaptureStats, StartMessage, WorkerToWindow } from './protocol';

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
  readonly readable = new ReadableStream({
    cancel: () => {
      this.cancelled = true;
    },
  });
  constructor(init: { track: unknown }) {
    FakeProcessor.tracks.push(init.track);
    FakeProcessor.instances.push(this);
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

function start(options: Parameters<typeof startCapture>[1] = {}, media = stream()): CaptureHandle {
  worker = new FakeWorker();
  return startCapture(media, options, () => worker as unknown as Worker);
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

beforeEach(() => {
  FakeProcessor.tracks = [];
  FakeProcessor.instances = [];
  vi.stubGlobal('MediaStreamTrackProcessor', FakeProcessor);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  it("moves the video and audio tracks' frames to the worker", () => {
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
    expect(transfer).toEqual([startMessage.video, startMessage.audio]);
  });

  it('leaves the audio out when asked to, or when the stream has none', () => {
    start({ audio: false });
    expect((worker.posted[0].message as StartMessage).audio).toBeNull();
    expect(worker.posted[0].transfer).toHaveLength(1);

    start({}, stream({ audio: false }));
    expect((worker.posted[0].message as StartMessage).audio).toBeNull();
    // The audio track was never handed to a processor.
    expect(FakeProcessor.tracks).toEqual([videoTrack, videoTrack]);
  });

  it('lets go of the frames when the worker cannot start', () => {
    const failing = (): Worker => {
      throw new Error('blocked by the content security policy');
    };
    expect(() => startCapture(stream(), {}, failing)).toThrow('blocked by the content security');
    expect(FakeProcessor.instances.map((processor) => processor.cancelled)).toEqual([true, true]);
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
    await expect(pending).rejects.toThrow('The capture has stopped.');
    await expect(capture.cut(1000, 2000)).rejects.toThrow('The capture has stopped.');
    // start, cut, stop: nothing is posted after the stop.
    expect(worker.messages()).toHaveLength(3);
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
