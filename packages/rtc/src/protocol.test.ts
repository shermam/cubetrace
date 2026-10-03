import type { CameraInfo } from '@cubetrace/core';
import { describe, expect, it } from 'vitest';

import {
  CHUNK_HEADER_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  THUMBNAIL_HEADER_BYTES,
  decode,
  encode,
  type Message,
} from './index';

/** The phone's rear camera as its own session.json would describe it. */
const CAMERA: CameraInfo = {
  label: 'phone-rear',
  local: true,
  facing: 'environment',
  deviceLabel: 'camera2 0, facing back',
  settings: { width: 1920, height: 1080, frameRate: 30 },
  capabilities: { width: { min: 1, max: 4000 } },
  constraints: { facingMode: { ideal: 'environment' } },
  crop: null,
  mode: 'full',
  microphone: null,
};

/** One message of every type, as each side would send it. */
const MESSAGES: Message[] = [
  {
    type: 'hello',
    v: PROTOCOL_VERSION,
    role: 'camera',
    device: { label: 'Android phone', platform: 'Android' },
    app: { version: '0.4.0', commit: 'abc1234' },
    camera: CAMERA,
  },
  {
    type: 'hello',
    v: PROTOCOL_VERSION,
    role: 'host',
    device: { label: 'office-mbp', platform: 'macOS' },
    app: { version: '0.4.0', commit: 'abc1234' },
    camera: null,
  },
  { type: 'ping', t1: 1_790_000_000_123.5 },
  { type: 'pong', t1: 1_790_000_000_123.5, t2: 1_790_000_003_000.25, t3: 1_790_000_003_001 },
  { type: 'clock', converged: true, offsetMs: -3127.4, rttMs: 9.6 },
  { type: 'clock', converged: false, offsetMs: 0, rttMs: 0 },
  {
    type: 'state',
    remoteMs: 1_790_000_003_000,
    recording: true,
    framing: { x: 100, y: 200, w: 800, h: 600 },
    frame: { width: 1920, height: 1080 },
    fps: 29.97,
    sharpness: 41.2,
    battery: { level: 0.83, charging: true },
    thermal: 'ok',
    pendingClips: 2,
  },
  {
    type: 'state',
    remoteMs: 1_790_000_003_000,
    recording: false,
    framing: null,
    frame: null,
    fps: null,
    sharpness: null,
    battery: null,
    thermal: null,
    pendingClips: 0,
  },
  {
    type: 'thumbnail',
    remoteMs: 1_790_000_003_000.75,
    width: 320,
    height: 180,
    jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]),
  },
  {
    type: 'cut',
    attempt: 17,
    segment: 'solve',
    fromRemoteMs: 1_790_000_010_000,
    toRemoteMs: 1_790_000_025_500.5,
    reason: 'ended',
    camera: 'phone-rear',
  },
  {
    type: 'cut-done',
    attempt: 17,
    segment: 'solve',
    files: [
      { name: 'phone-rear.solve.frames.json', bytes: 2_210, kind: 'frames' },
      { name: 'phone-rear.solve.mp4', bytes: 23_734_012, kind: 'mp4' },
    ],
    clip: {
      codec: 'avc1.640028',
      audio: 'mp4a.40.2',
      width: 1080,
      height: 1920,
      fpsNominal: 30,
      frames: 548,
      crop: { x: 120, y: 480, w: 840, h: 960 },
      truncatedStart: false,
      lateMs: 0,
      bufferSeconds: 90,
      audioMissing: null,
    },
  },
  {
    type: 'cut-done',
    attempt: 3,
    segment: 'scramble',
    files: [{ name: 'phone-2-rear.scramble.frames.json', bytes: 940, kind: 'frames' }],
    clip: {
      codec: 'vp09.00.40.08',
      audio: null,
      width: 640,
      height: 480,
      fpsNominal: 29.97,
      frames: 1,
      crop: null,
      truncatedStart: true,
      lateMs: 2100.5,
      bufferSeconds: 12.4,
      audioMissing: 'no audio data from the microphone',
    },
  },
  { type: 'clip-ack', attempt: 17, segment: 'solve', stored: true, reason: '' },
  {
    type: 'clip-ack',
    attempt: 3,
    segment: 'scramble',
    stored: false,
    reason: 'the attempt is gone',
  },
  {
    type: 'cut-failed',
    attempt: 17,
    segment: 'scramble',
    reason: 'the window is older than the buffer',
  },
  {
    type: 'file-begin',
    id: 3,
    name: 'phone-rear.solve.mp4',
    bytes: 23_734_012,
    kind: 'mp4',
    attempt: 17,
    segment: 'solve',
  },
  {
    type: 'file-begin',
    id: 4,
    name: 'notes.txt',
    bytes: 0,
    kind: 'frames',
    attempt: null,
    segment: null,
  },
  { type: 'file-chunk', id: 3, offset: 5 * 2 ** 32 + 65_536, bytes: new Uint8Array([9, 8, 7]) },
  { type: 'file-chunk', id: 0xffffffff, offset: 0, bytes: new Uint8Array(0) },
  { type: 'file-ack', id: 3, offset: 1_048_576, done: false },
  { type: 'file-ack', id: 3, offset: 23_734_012, done: true },
  { type: 'file-done', id: 3, crc32: 0xcbf43926 },
  { type: 'file-resume', id: 3, offset: 12_582_912 },
  { type: 'file-abort', id: 3, reason: 'the checksum did not match 3 times' },
  { type: 'leave', reason: 'Leave pressed' },
];

describe('the protocol', () => {
  it.each(MESSAGES.map((message): [string, Message] => [message.type, message]))(
    'encodes and decodes a %s message both ways',
    (_, message) => {
      const frame = encode(message);
      const decoded = decode(frame);
      expect(decoded).toEqual(message);
      // Once more, from the decoded message: the same frame.
      expect(encode(decoded)).toEqual(frame);
    },
  );

  it('sends control messages as JSON text and chunks and thumbnails as binary frames with a 13-byte header', () => {
    const control = MESSAGES.filter((m) => m.type !== 'file-chunk' && m.type !== 'thumbnail');
    for (const message of control) {
      const frame = encode(message);
      expect(typeof frame).toBe('string');
      expect(JSON.parse(frame as string)).toEqual(message);
    }
    const chunk = encode({
      type: 'file-chunk',
      id: 7,
      offset: 2 ** 40 + 3,
      bytes: new Uint8Array([1, 2]),
    });
    expect(chunk).toBeInstanceOf(Uint8Array);
    expect((chunk as Uint8Array).length).toBe(CHUNK_HEADER_BYTES + 2);
    expect([...(chunk as Uint8Array)]).toEqual([1, 0, 0, 0, 7, 0, 0, 1, 0, 0, 0, 0, 3, 1, 2]);
    const thumbnail = encode({
      type: 'thumbnail',
      remoteMs: 1,
      width: 320,
      height: 180,
      jpeg: new Uint8Array([5]),
    });
    expect((thumbnail as Uint8Array).length).toBe(THUMBNAIL_HEADER_BYTES + 1);
    expect((thumbnail as Uint8Array)[0]).toBe(2);
    expect([...(thumbnail as Uint8Array).subarray(9, 13)]).toEqual([1, 64, 0, 180]);
    expect(CHUNK_HEADER_BYTES).toBe(13);
    expect(THUMBNAIL_HEADER_BYTES).toBe(13);
  });

  it('decodes an ArrayBuffer, a view into a larger buffer, and gives the bytes as a view, not a copy', () => {
    const frame = encode({
      type: 'file-chunk',
      id: 1,
      offset: 10,
      bytes: new Uint8Array([4, 5, 6]),
    }) as Uint8Array;
    const larger = new Uint8Array(frame.length + 8);
    larger.set(frame, 4);
    const view = larger.subarray(4, 4 + frame.length);
    for (const input of [
      frame.slice().buffer,
      view,
      new DataView(view.buffer, view.byteOffset, view.byteLength),
    ]) {
      const decoded = decode(input);
      expect(decoded.type).toBe('file-chunk');
      expect([...(decoded as { bytes: Uint8Array }).bytes]).toEqual([4, 5, 6]);
    }
    const decoded = decode(frame);
    expect((decoded as { bytes: Uint8Array }).bytes.buffer).toBe(frame.buffer);
  });

  it('ignores the fields it does not know, so that a build that adds one still talks to the one before', () => {
    const text = JSON.stringify({ type: 'ping', t1: 5, jitterMs: 2 });
    expect(decode(text)).toEqual({ type: 'ping', t1: 5 });
    const hello = JSON.stringify({
      type: 'hello',
      v: 1,
      role: 'host',
      device: { label: 'x', platform: 'y', isPhone: false },
      app: { version: '1', commit: 'c', date: '2026' },
      camera: null,
      extra: true,
    });
    expect(decode(hello)).toEqual({
      type: 'hello',
      v: 1,
      role: 'host',
      device: { label: 'x', platform: 'y' },
      app: { version: '1', commit: 'c' },
      camera: null,
    });
    // A field left out that may be null reads as null.
    const state = JSON.stringify({ type: 'state', remoteMs: 1, recording: true, pendingClips: 0 });
    expect(decode(state)).toEqual({
      type: 'state',
      remoteMs: 1,
      recording: true,
      framing: null,
      frame: null,
      fps: null,
      sharpness: null,
      battery: null,
      thermal: null,
      pendingClips: 0,
    });
  });

  it.each([
    ['text that is not JSON', 'hello there', /not JSON/],
    ['a JSON array', '[1, 2]', /not an object/],
    ['a message without a type', '{"t1": 1}', /unknown type/],
    ['a message of an unknown type', '{"type": "pause"}', /unknown type, "pause"/],
    ['a chunk as text', '{"type": "file-chunk"}', /binary frame/],
    ['a ping whose time is text', '{"type": "ping", "t1": "now"}', /t1 must be a number/],
    ['a pong without t3', '{"type": "pong", "t1": 1, "t2": 2}', /t3 must be a number/],
    [
      'a clock whose convergence is text',
      '{"type": "clock", "converged": "yes", "offsetMs": 1, "rttMs": 2}',
      /converged must be true or false/,
    ],
    [
      'a clock with a negative round trip',
      '{"type": "clock", "converged": true, "offsetMs": 1, "rttMs": -2}',
      /rttMs must be a number/,
    ],
    ['a hello of another version as text', '{"type": "hello", "v": "1"}', /v must be an integer/],
    [
      'a hello of another role',
      '{"type": "hello", "v": 1, "role": "viewer"}',
      /role must be one of host, camera/,
    ],
    [
      'a hello whose device is text',
      '{"type": "hello", "v": 1, "role": "host", "device": "x"}',
      /device must be an object/,
    ],
    [
      'a hello whose camera is not a camera',
      JSON.stringify({
        type: 'hello',
        v: 1,
        role: 'camera',
        device: { label: 'x', platform: 'y' },
        app: { version: '1', commit: 'c' },
        camera: { label: 'Phone' },
      }),
      /hello.camera is not a camera: camera.label must be a camera label/,
    ],
    ['a cut of attempt 0', '{"type": "cut", "attempt": 0}', /attempt must be an integer ≥ 1/],
    [
      'a cut of another segment',
      '{"type": "cut", "attempt": 1, "segment": "inspection"}',
      /segment must be one of scramble, solve/,
    ],
    [
      'a cut without a window',
      '{"type": "cut", "attempt": 1, "segment": "solve"}',
      /fromRemoteMs must be a number/,
    ],
    [
      'a cut whose camera is not a label',
      JSON.stringify({
        type: 'cut',
        attempt: 1,
        segment: 'solve',
        fromRemoteMs: 1,
        toRemoteMs: 2,
        reason: 'ended',
        camera: '../laptop',
      }),
      /camera must be a camera label/,
    ],
    [
      'a cut-done without what the capture said of its clip',
      '{"type": "cut-done", "attempt": 1, "segment": "solve", "files": []}',
      /clip must be an object/,
    ],
    [
      'a cut-done whose clip has no frame rate',
      JSON.stringify({
        type: 'cut-done',
        attempt: 1,
        segment: 'solve',
        files: [],
        clip: {
          codec: 'avc1.640028',
          audio: null,
          width: 1,
          height: 1,
          fpsNominal: 0,
          frames: 1,
          crop: null,
          truncatedStart: false,
          lateMs: 0,
          bufferSeconds: 90,
          audioMissing: null,
        },
      }),
      /fpsNominal must be a number > 0/,
    ],
    [
      'a clip-ack whose stored is text',
      '{"type": "clip-ack", "attempt": 1, "segment": "solve", "stored": "yes", "reason": ""}',
      /stored must be true or false/,
    ],
    [
      'a cut-done whose files are an object',
      '{"type": "cut-done", "attempt": 1, "segment": "solve", "files": {}}',
      /files must be an array/,
    ],
    [
      'a cut-done with a file that is text',
      '{"type": "cut-done", "attempt": 1, "segment": "solve", "files": ["a.mp4"]}',
      /not an object/,
    ],
    [
      'a file-begin with a path',
      '{"type": "file-begin", "id": 1, "name": "../x.mp4"}',
      /name must be a file name without a path/,
    ],
    [
      'a file-begin with a hidden file',
      '{"type": "file-begin", "id": 1, "name": ".x"}',
      /name must be a file name/,
    ],
    [
      'a file-begin of negative size',
      '{"type": "file-begin", "id": 1, "name": "x.mp4", "bytes": -1}',
      /bytes must be an integer ≥ 0/,
    ],
    [
      'a file-begin of another kind',
      '{"type": "file-begin", "id": 1, "name": "x", "bytes": 1, "kind": "gyro"}',
      /kind must be one of mp4, frames/,
    ],
    [
      'a file-ack whose done is a number',
      '{"type": "file-ack", "id": 1, "offset": 0, "done": 1}',
      /done must be true or false/,
    ],
    [
      'a file-done whose checksum is too large',
      '{"type": "file-done", "id": 1, "crc32": 4294967296}',
      /crc32 must be an integer/,
    ],
    [
      'a file-resume with a fractional offset',
      '{"type": "file-resume", "id": 1, "offset": 1.5}',
      /offset must be an integer/,
    ],
    [
      'a leave whose reason is too long',
      JSON.stringify({ type: 'leave', reason: 'x'.repeat(1001) }),
      /reason must be a string of at most 1000/,
    ],
    [
      'a state whose battery level is over 1',
      JSON.stringify({
        type: 'state',
        remoteMs: 1,
        recording: true,
        pendingClips: 0,
        battery: { level: 1.5, charging: false },
      }),
      /level must be a number/,
    ],
    [
      'a state whose thermal hint is unknown',
      JSON.stringify({
        type: 'state',
        remoteMs: 1,
        recording: true,
        pendingClips: 0,
        thermal: 'melting',
      }),
      /thermal must be one of ok, throttled/,
    ],
    [
      'a state whose framing has no height',
      JSON.stringify({
        type: 'state',
        remoteMs: 1,
        recording: true,
        pendingClips: 0,
        framing: { x: 0, y: 0, w: 1 },
      }),
      /h must be an integer ≥ 1/,
    ],
  ])('refuses %s', (_, text, message) => {
    expect(() => decode(text)).toThrow(ProtocolError);
    expect(() => decode(text)).toThrow(message);
  });

  it('refuses binary frames that are empty, of an unknown kind or too short', () => {
    expect(() => decode(new Uint8Array(0))).toThrow(/empty binary frame/);
    expect(() => decode(new Uint8Array([9, 1, 2]))).toThrow(/unknown kind, 9/);
    expect(() => decode(new Uint8Array([1, 0, 0]))).toThrow(/chunk frame of 3 bytes: too short/);
    expect(() => decode(new Uint8Array([2, 0, 0, 0, 0]))).toThrow(
      /thumbnail frame of 5 bytes: too short/,
    );
    const nan = new Uint8Array(THUMBNAIL_HEADER_BYTES);
    nan[0] = 2;
    new DataView(nan.buffer).setFloat64(1, NaN);
    expect(() => decode(nan)).toThrow(/time is not finite/);
  });
});
