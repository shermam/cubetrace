import { afterEach, describe, expect, it } from 'vitest';

import { cut, type Cut } from './cut';
import {
  isWindowToWorker,
  isWorkerToWindow,
  post,
  resolveCaptureConfig,
  transferList,
  type CaptureMessage,
  type CutDone,
  type StartMessage,
} from './protocol';
import { RingBuffer } from './ring-buffer';

/** A cut of one second of synthetic video and audio, with a decoder config. */
function aCut(): Cut {
  const buffer = new RingBuffer();
  buffer.setVideoTrack({ codec: 'avc1.640028', width: 1920, height: 1080 });
  buffer.setVideoDecoderConfig({
    codec: 'avc1.640028',
    description: new Uint8Array([1, 100, 0, 40]).buffer,
  });
  buffer.setAudioTrack({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });
  for (let index = 0; index < 30; index += 1) {
    const timestampUs = 1_000_000 + index * 33_333;
    buffer.push({
      kind: 'audio',
      type: 'key',
      timestampUs,
      durationUs: 20_000,
      byteLength: 2,
      arrivalHostMs: 5000 + timestampUs / 1000,
      data: new Uint8Array([9, index]).buffer,
    });
    buffer.push({
      kind: 'video',
      type: index === 0 ? 'key' : 'delta',
      timestampUs,
      durationUs: 33_333,
      byteLength: 3,
      arrivalHostMs: 5000 + timestampUs / 1000,
      data: new Uint8Array([1, 2, index]).buffer,
    });
  }
  return cut(buffer, 0, 1e9);
}

const ports: MessagePort[] = [];

/** A message channel whose ports are closed after the test. */
function channel(): MessageChannel {
  const created = new MessageChannel();
  ports.push(created.port1, created.port2);
  return created;
}

/** The next message that arrives on `port`. */
function nextMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.addEventListener(
      'message',
      (event) => {
        resolve(event.data);
      },
      { once: true },
    );
    port.start();
  });
}

afterEach(() => {
  for (const port of ports.splice(0)) {
    port.close();
  }
});

describe('resolveCaptureConfig', () => {
  it('records audio into a 90 s, 160 MB buffer unless told otherwise', () => {
    expect(resolveCaptureConfig()).toEqual({
      audio: true,
      bufferSeconds: 90,
      bufferBytes: 160_000_000,
    });
    expect(resolveCaptureConfig({ audio: false, bufferSeconds: 30 })).toEqual({
      audio: false,
      bufferSeconds: 30,
      bufferBytes: 160_000_000,
    });
  });
});

describe('transferList', () => {
  it("moves the start's streams, video and audio", () => {
    const video = new ReadableStream<VideoFrame>();
    const audio = new ReadableStream<AudioData>();
    const start: StartMessage = {
      type: 'start',
      video,
      audio,
      config: resolveCaptureConfig(),
      frameRate: 30,
    };

    expect(transferList(start)).toEqual([video, audio]);
    expect(transferList({ ...start, audio: null })).toEqual([video]);
  });

  it("moves each of a cut's chunk buffers once, and nothing of other messages", () => {
    const result = aCut();
    const buffers = transferList({ type: 'cut-done', id: 1, cut: result });

    expect(buffers).toHaveLength(60);
    expect(new Set(buffers).size).toBe(60);
    expect(buffers).toEqual([
      ...result.video.chunks.map((chunk) => chunk.data),
      ...(result.audio?.chunks ?? []).map((chunk) => chunk.data),
    ]);
    const others: CaptureMessage[] = [
      { type: 'cut', id: 1, startHostMs: 0, endHostMs: 1 },
      { type: 'cut-failed', id: 1, message: 'Nothing is buffered yet.' },
      { type: 'stop' },
      { type: 'stopped' },
      { type: 'error', message: 'The camera stopped sending frames.', fatal: true },
    ];
    for (const message of others) {
      expect(transferList(message)).toEqual([]);
    }
  });
});

describe('post', () => {
  it("transfers a cut's bytes: gone from the sender, whole at the receiver", async () => {
    const { port1, port2 } = channel();
    const result = aCut();
    const arriving = nextMessage(port2);

    post(port1, { type: 'cut-done', id: 7, cut: result });

    const received = (await arriving) as CutDone;
    expect(received.type).toBe('cut-done');
    expect(received.id).toBe(7);
    // Moved, not copied: the sender's buffers are detached.
    expect(result.video.chunks.every((chunk) => chunk.data.byteLength === 0)).toBe(true);
    expect(result.audio?.chunks.every((chunk) => chunk.data.byteLength === 0)).toBe(true);
    const chunks = received.cut.video.chunks;
    expect(chunks).toHaveLength(30);
    expect([...new Uint8Array(chunks[29].data)]).toEqual([1, 2, 29]);
    expect(received.cut.frames.keyframes).toEqual([0]);
    // The decoder config is small and stays with the sender's buffer: copied, not moved.
    expect(result.video.decoderConfig?.description?.byteLength).toBe(4);
    const description = received.cut.video.decoderConfig?.description as ArrayBuffer;
    expect([...new Uint8Array(description)]).toEqual([1, 100, 0, 40]);
  });

  it('moves the streams of the start message', async () => {
    const { port1, port2 } = channel();
    const video = new ReadableStream<VideoFrame>();
    const arriving = nextMessage(port2);

    post(port1, {
      type: 'start',
      video,
      audio: null,
      config: resolveCaptureConfig({ audio: false }),
      frameRate: null,
    });

    const received = (await arriving) as StartMessage;
    expect(video.locked).toBe(true);
    expect(received.video).toBeInstanceOf(ReadableStream);
    expect(received.video).not.toBe(video);
    expect(received.config.audio).toBe(false);
  });
});

describe('message guards', () => {
  it('tell the messages of each direction apart', () => {
    expect(isWindowToWorker({ type: 'cut', id: 1, startHostMs: 0, endHostMs: 1 })).toBe(true);
    expect(isWindowToWorker({ type: 'stop' })).toBe(true);
    expect(isWindowToWorker({ type: 'stats' })).toBe(false);
    expect(isWorkerToWindow({ type: 'stats' })).toBe(true);
    expect(isWorkerToWindow({ type: 'cut-done' })).toBe(true);
    expect(isWorkerToWindow({ type: 'stopped' })).toBe(true);
    expect(isWorkerToWindow({ type: 'start' })).toBe(false);
    for (const other of [null, undefined, 'stop', 3, {}, { type: 3 }, []]) {
      expect(isWindowToWorker(other)).toBe(false);
      expect(isWorkerToWindow(other)).toBe(false);
    }
  });
});
