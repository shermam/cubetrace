import { FRAMES_SCHEMA, type FramesJson } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { arrivalFit, cut, cutBuffers, frameIntervals } from './cut';
import { RingBuffer, type EncodedChunkRecord } from './ring-buffer';

// A camera at 30 fps with a keyframe every 30 frames, timestamps on a capture clock that does not
// start at 0 (as Chrome's do, docs/DEVICES.md), and arrivals in the worker at a constant offset on
// the host clock plus up to ±6 ms of jitter.
const T0 = 2_229_524_403;
const OFFSET_MS = 1_790_516_343_600;
const FRAME_US = 1e6 / 30;

function timestampOf(index: number): number {
  return T0 + Math.round(index * FRAME_US);
}

/** A deterministic jitter in [−6, +6] ms, symmetric around 0. */
function jitter(index: number): number {
  return (((index * 7919) % 13) - 6) * 1;
}

function frame(index: number): EncodedChunkRecord {
  const timestampUs = timestampOf(index);
  return {
    kind: 'video',
    type: index % 30 === 0 ? 'key' : 'delta',
    timestampUs,
    durationUs: timestampOf(index + 1) - timestampUs,
    byteLength: 4,
    arrivalHostMs: timestampUs / 1000 + OFFSET_MS + jitter(index),
    data: new Uint32Array([index]).buffer,
  };
}

/** 20 ms of audio from `timestampUs`, arriving 10 ms after its first sample plus jitter. */
function audio(index: number, timestampUs: number): EncodedChunkRecord {
  return {
    kind: 'audio',
    type: 'key',
    timestampUs,
    durationUs: 20_000,
    byteLength: 4,
    arrivalHostMs: timestampUs / 1000 + OFFSET_MS + 10 + jitter(index) / 2,
    data: new Uint32Array([100_000 + index]).buffer,
  };
}

/** `seconds` of video and audio; the audio starts 105 ms before the first frame. */
function recording(seconds: number, bounds?: { maxSeconds: number; maxBytes: number }) {
  const buffer = new RingBuffer(bounds);
  buffer.setVideoTrack({ codec: 'avc1.640028', width: 1920, height: 1080 });
  buffer.setVideoDecoderConfig({
    codec: 'avc1.640028',
    codedWidth: 1920,
    codedHeight: 1080,
    description: new Uint8Array([1, 100, 0, 40]).buffer,
  });
  buffer.setAudioTrack({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 1 });
  let audioIndex = 0;
  const pushAudioUntil = (untilUs: number): void => {
    while (T0 - 105_000 + audioIndex * 20_000 < untilUs) {
      buffer.push(audio(audioIndex, T0 - 105_000 + audioIndex * 20_000));
      audioIndex += 1;
    }
  };
  for (let index = 0; index < seconds * 30; index += 1) {
    pushAudioUntil(timestampOf(index + 1));
    buffer.push(frame(index));
  }
  return buffer;
}

/** Frame `index`'s host time as the cut sees it: its timestamp plus the buffer's arrival offset. */
function hostOf(buffer: RingBuffer, index: number): number {
  return timestampOf(index) / 1000 + arrivalFit(buffer.video).offsetMs;
}

function frameIndex(chunk: EncodedChunkRecord): number {
  return new Uint32Array(chunk.data)[0];
}

describe('cut', () => {
  it('begins at the last keyframe at or before the start', () => {
    const buffer = recording(10);

    // Mid-GOP: back to the GOP's keyframe.
    const middle = cut(buffer, hostOf(buffer, 45), hostOf(buffer, 100));
    expect(frameIndex(middle.video.chunks[0])).toBe(30);
    expect(middle.video.chunks[0].type).toBe('key');
    // On a keyframe: that keyframe.
    expect(frameIndex(cut(buffer, hostOf(buffer, 60), hostOf(buffer, 100)).video.chunks[0])).toBe(
      60,
    );
    // Just before a keyframe: the previous one.
    expect(
      frameIndex(cut(buffer, hostOf(buffer, 60) - 0.01, hostOf(buffer, 100)).video.chunks[0]),
    ).toBe(30);
  });

  it('ends at the last frame at or before the end', () => {
    const buffer = recording(10);
    const lastOf = (endHostMs: number): number => {
      const chunks = cut(buffer, hostOf(buffer, 40), endHostMs).video.chunks;
      return frameIndex(chunks[chunks.length - 1]);
    };

    expect(lastOf(hostOf(buffer, 100))).toBe(100);
    expect(lastOf(hostOf(buffer, 100) + 20)).toBe(100);
    expect(lastOf(hostOf(buffer, 101) - 0.01)).toBe(100);
    // An interval between two frames: the frame on screen at its start, from its keyframe.
    const between = cut(buffer, hostOf(buffer, 100) + 5, hostOf(buffer, 100) + 10).video.chunks;
    expect(between.map(frameIndex)).toEqual(Array.from({ length: 11 }, (_, i) => 90 + i));
  });

  it('takes the audio chunks that overlap the video span, and no others', () => {
    const buffer = recording(10);
    const result = cut(buffer, hostOf(buffer, 45), hostOf(buffer, 100));
    const spanStart = timestampOf(30);
    const spanEnd = timestampOf(101);
    const chunks = result.audio?.chunks ?? [];

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.kind).toBe('audio');
      expect(chunk.timestampUs).toBeLessThan(spanEnd);
      expect(chunk.timestampUs + chunk.durationUs).toBeGreaterThan(spanStart);
    }
    const first = chunks[0];
    const last = chunks[chunks.length - 1];
    // The neighbours outside the span are left out: the first chunk straddles its start, the last
    // its end.
    expect(first.timestampUs).toBeLessThanOrEqual(spanStart);
    expect(first.timestampUs + 20_000).toBeGreaterThan(spanStart);
    expect(last.timestampUs).toBeLessThan(spanEnd);
    expect(last.timestampUs + 20_000).toBeGreaterThanOrEqual(spanEnd);
    expect(chunks).toHaveLength(Math.round((last.timestampUs - first.timestampUs) / 20_000) + 1);
    expect(result.audio).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 48_000 });
  });

  it('gives the frame intervals at 0.1 ms, and the keyframes by index', () => {
    const buffer = recording(10);
    const result = cut(buffer, hostOf(buffer, 30), hostOf(buffer, 119));
    const { dtMs, keyframes } = result.frames;

    expect(dtMs).toHaveLength(90);
    expect(dtMs[0]).toBe(0);
    expect(new Set(dtMs.slice(1))).toEqual(new Set([33.3, 33.4]));
    expect(keyframes).toEqual([0, 30, 60]);
    // The running sum never drifts: every frame's offset from the first to within 0.05 ms.
    let sum = 0;
    dtMs.forEach((dt, index) => {
      sum += dt;
      expect(Math.abs(sum * 1000 - (timestampOf(30 + index) - timestampOf(30)))).toBeLessThan(
        50.001,
      );
    });
  });

  it('puts the first frame on the host clock by the arrival fit, free of the jitter', () => {
    const buffer = recording(10);
    const result = cut(buffer, hostOf(buffer, 45), hostOf(buffer, 100));
    const first = result.video.chunks[0];
    const truth = first.timestampUs / 1000 + OFFSET_MS;

    // The first frame's own arrival is off by its jitter; the fit is not.
    expect(Math.abs(first.arrivalHostMs - truth)).toBeGreaterThan(1);
    expect(Math.abs(result.frames.t0HostMs - truth)).toBeLessThanOrEqual(0.5);
    expect(result.frames.arrival.offsetMs).toBeCloseTo(OFFSET_MS, 0);
    expect(result.frames.arrival.residualP95Ms).toBeGreaterThan(4);
    expect(result.frames.arrival.residualP95Ms).toBeLessThanOrEqual(6);
    // The audio's own fit: 10 ms later than the video's, as built.
    expect((result.audio?.arrival?.offsetMs ?? 0) - OFFSET_MS).toBeCloseTo(10, 0);
  });

  it("gives frames that are frames.json once the clip's camera and segment are added", () => {
    const buffer = recording(10);
    const result = cut(buffer, hostOf(buffer, 45), hostOf(buffer, 250));
    const frames: FramesJson = { schema: 2, camera: 'laptop', segment: 'solve', ...result.frames };
    const validate = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);

    expect(validate(frames), JSON.stringify(validate.errors)).toBe(true);
    expect(frames.dtMs).toHaveLength(result.video.chunks.length);
    expect(frames.keyframes).toEqual([0, 30, 60, 90, 120, 150, 180, 210]);
  });

  it('fits arrivals with the median and the 95th percentile of the residuals', () => {
    const chunks = [0, 1, 2, 3, 4].map((index) => ({
      ...frame(index),
      arrivalHostMs: timestampOf(index) / 1000 + 100 + [0, 3, -1, 40, 1][index],
    }));

    expect(arrivalFit(chunks)).toEqual({ offsetMs: 101, residualP95Ms: 39 });
    expect(arrivalFit(chunks.slice(0, 4))).toEqual({ offsetMs: 101.5, residualP95Ms: 38.5 });
  });

  it('says truncatedStart when the start is older than the buffer, and cuts what exists', () => {
    // 100 s into a 90 s buffer: the first 10 s are gone.
    const buffer = recording(100, { maxSeconds: 90, maxBytes: 160_000_000 });
    expect(frameIndex(buffer.video[0])).toBe(300);

    const result = cut(buffer, hostOf(buffer, 0), hostOf(buffer, 400));

    expect(result.truncatedStart).toBe(true);
    expect(frameIndex(result.video.chunks[0])).toBe(300);
    expect(result.video.chunks).toHaveLength(101);
    expect(cut(buffer, hostOf(buffer, 300), hostOf(buffer, 400)).truncatedStart).toBe(false);
  });

  it('says truncatedEnd when the end is past the newest frame', () => {
    const buffer = recording(10);
    const newest = hostOf(buffer, 299);

    expect(cut(buffer, hostOf(buffer, 200), newest).truncatedEnd).toBe(false);
    expect(cut(buffer, hostOf(buffer, 200), newest + 30).truncatedEnd).toBe(false);
    const late = cut(buffer, hostOf(buffer, 200), newest + 1000);
    expect(late.truncatedEnd).toBe(true);
    expect(frameIndex(late.video.chunks[late.video.chunks.length - 1])).toBe(299);
  });

  it('refuses an empty buffer, an inverted interval and an end before the buffer', () => {
    const buffer = recording(10);

    expect(() => cut(new RingBuffer(), 0, 1)).toThrow(new RangeError('Nothing is buffered yet.'));
    expect(() => cut(buffer, hostOf(buffer, 20), hostOf(buffer, 10))).toThrow(RangeError);
    expect(() => cut(buffer, Number.NaN, hostOf(buffer, 10))).toThrow(/not an interval/);
    expect(() => cut(buffer, hostOf(buffer, -60), hostOf(buffer, 0) - 1)).toThrow(
      /Nothing is buffered at or before/,
    );
  });

  it('copies the bytes once: the buffer keeps its own, and overlapping cuts both work', () => {
    const buffer = recording(10);
    const one = cut(buffer, hostOf(buffer, 45), hostOf(buffer, 100));
    const two = cut(buffer, hostOf(buffer, 80), hostOf(buffer, 150));

    // Moving a cut's bytes away (as postMessage's transfer does) leaves the buffer intact.
    const moved = structuredClone(one, { transfer: cutBuffers(one) });
    expect(one.video.chunks[0].data.byteLength).toBe(0);
    expect(frameIndex(moved.video.chunks[0])).toBe(30);
    expect(frameIndex(buffer.video[30])).toBe(30);
    expect(frameIndex(two.video.chunks[0])).toBe(60);

    const buffers = cutBuffers(two);
    expect(buffers).toHaveLength(two.video.chunks.length + (two.audio?.chunks.length ?? 0));
    expect(new Set(buffers).size).toBe(buffers.length);
    for (const data of buffers) {
      expect(buffer.video.some((chunk) => chunk.data === data)).toBe(false);
      expect(buffer.audio.some((chunk) => chunk.data === data)).toBe(false);
    }
  });

  it("shares the buffer's bytes when asked not to copy them, for a cut used in the worker", () => {
    const buffer = recording(10);
    const shared = cut(buffer, hostOf(buffer, 45), hostOf(buffer, 100), { copy: false });
    const copied = cut(buffer, hostOf(buffer, 45), hostOf(buffer, 100));

    expect(shared).toEqual(copied);
    expect(shared.video.chunks[0]).toBe(buffer.video[30]);
    expect(shared.audio?.chunks.every((chunk) => buffer.audio.includes(chunk))).toBe(true);
    // Evictions let go of the chunks without touching them: the cut keeps its bytes.
    for (let index = 300; index < 3000; index += 1) {
      buffer.push(frame(index));
    }
    expect(buffer.video[0].timestampUs).toBeGreaterThan(timestampOf(100));
    expect(shared.video.chunks.map(frameIndex)).toEqual(copied.video.chunks.map(frameIndex));
  });

  it('carries the video and audio descriptions and decoder configs', () => {
    const result = cut(recording(3), 0, Number.MAX_SAFE_INTEGER);

    expect(result.video).toMatchObject({
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
      decoderConfig: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 },
    });
    expect(result.audio).toMatchObject({ codec: 'mp4a.40.2', numberOfChannels: 1 });
    expect(result.startHostMs).toBe(0);
    expect(result.endHostMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('has no audio part when the buffer has no audio track', () => {
    const buffer = new RingBuffer();
    buffer.setVideoTrack({ codec: 'vp09.00.40.08', width: 1280, height: 720 });
    for (let index = 0; index < 60; index += 1) {
      buffer.push(frame(index));
    }

    const result = cut(buffer, hostOf(buffer, 0), hostOf(buffer, 59));
    expect(result.audio).toBeNull();
    expect(result.video.decoderConfig).toBeNull();
  });
});

describe('frameIntervals', () => {
  it('rounds offsets from the first frame, then differences them', () => {
    const chunks = [0, 33_349, 66_651, 100_050].map((offset) => ({
      ...frame(0),
      timestampUs: T0 + offset,
    }));

    // Offsets 0, 33.3, 66.7, 100.1 ms: intervals 0, 33.3, 33.4, 33.4.
    expect(frameIntervals(chunks)).toEqual([0, 33.3, 33.4, 33.4]);
    expect(frameIntervals([])).toEqual([]);
  });
});
