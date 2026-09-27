import { describe, expect, it } from 'vitest';

import {
  AUDIO_REBASE_MS,
  DEFAULT_BOUNDS,
  RingBuffer,
  type EncodedChunkRecord,
} from './ring-buffer';

/** A frame's timestamp at 30 fps from an arbitrary capture-clock origin, as Chrome's are. */
const T0 = 2_229_524_403;
const FRAME_US = 1e6 / 30;

function timestampOf(index: number): number {
  return T0 + Math.round(index * FRAME_US);
}

/** Frame `index` of a 30 fps camera with a keyframe every `gop` frames. */
function frame(index: number, byteLength = 1000, gop = 30): EncodedChunkRecord {
  const timestampUs = timestampOf(index);
  return {
    kind: 'video',
    type: index % gop === 0 ? 'key' : 'delta',
    timestampUs,
    durationUs: timestampOf(index + 1) - timestampUs,
    byteLength,
    arrivalHostMs: timestampUs / 1000 + 1_790_516_343_600,
    // The buffer counts `byteLength`; the bytes themselves can stay small in these tests.
    data: new ArrayBuffer(8),
  };
}

/**
 * A 20 ms audio chunk starting at `timestampUs`, arriving 10 ms after it; on a clock `clockUs` behind
 * the frames' (its timestamps that much smaller for the same moment).
 */
function audio(timestampUs: number, byteLength = 100, clockUs = 0): EncodedChunkRecord {
  return {
    kind: 'audio',
    type: 'key',
    timestampUs: timestampUs - clockUs,
    durationUs: 20_000,
    byteLength,
    arrivalHostMs: timestampUs / 1000 + 1_790_516_343_610,
    data: new ArrayBuffer(8),
  };
}

function fill(buffer: RingBuffer, frames: number, byteLength?: number, gop?: number): void {
  for (let index = 0; index < frames; index += 1) {
    buffer.push(frame(index, byteLength, gop));
  }
}

describe('RingBuffer', () => {
  it('is bounded by 90 s and 160 MB by default', () => {
    expect(new RingBuffer().bounds).toEqual({ maxSeconds: 90, maxBytes: 160_000_000 });
    expect(DEFAULT_BOUNDS).toEqual({ maxSeconds: 90, maxBytes: 160_000_000 });
  });

  it('counts the seconds of video and the bytes of video and audio it holds', () => {
    const buffer = new RingBuffer();
    expect(buffer.bufferSeconds).toBe(0);
    expect(buffer.bufferBytes).toBe(0);

    fill(buffer, 90, 1000);
    buffer.push(audio(T0, 300));
    buffer.push(audio(T0 + 20_000, 300));

    // 90 frames of 1/30 s: from the first frame's timestamp to the end of the last.
    expect(buffer.bufferSeconds).toBeCloseTo(3, 6);
    expect(buffer.bufferBytes).toBe(90 * 1000 + 600);
    expect(buffer.video).toHaveLength(90);
    expect(buffer.audio).toHaveLength(2);
  });

  it('refuses delta chunks until the first keyframe: they could not be decoded', () => {
    const buffer = new RingBuffer();
    buffer.push(frame(28));
    buffer.push(frame(29));
    buffer.push(frame(30));
    buffer.push(frame(31));

    expect(buffer.discarded).toBe(2);
    expect(buffer.video.map((chunk) => chunk.type)).toEqual(['key', 'delta']);
    expect(buffer.bufferBytes).toBe(2000);
  });

  it('keeps at most 90 s, evicting whole GOPs, so that it always starts at a keyframe', () => {
    const buffer = new RingBuffer();
    // 100 s at 30 fps, a keyframe every second.
    for (let index = 0; index < 3000; index += 1) {
      buffer.push(frame(index));
      expect(buffer.bufferSeconds).toBeLessThanOrEqual(90);
      expect(buffer.video[0].type).toBe('key');
    }

    // Whole GOPs went: the buffer holds between 89 and 90 s and begins on a GOP boundary.
    expect(buffer.bufferSeconds).toBeGreaterThan(89);
    expect(buffer.video).toHaveLength(90 * 30);
    expect(buffer.video[0].timestampUs).toBe(timestampOf(10 * 30));
    expect(buffer.bufferBytes).toBe(buffer.video.length * 1000);
  });

  it('keeps at most 160 MB, evicting whole GOPs', () => {
    const buffer = new RingBuffer();
    // 38.4 Mbps (4.8 MB a second): the byte bound binds after 33 s, long before the time bound.
    for (let index = 0; index < 60 * 30; index += 1) {
      buffer.push(frame(index, 160_000));
      expect(buffer.bufferBytes).toBeLessThanOrEqual(160_000_000);
      expect(buffer.video[0].type).toBe('key');
    }

    // Within one GOP (4.8 MB) of the bound; the last 33 s.
    expect(buffer.bufferBytes).toBe(990 * 160_000);
    expect(buffer.bufferSeconds).toBeCloseTo(33, 6);
    expect(buffer.video[0].timestampUs).toBe(timestampOf(27 * 30));
  });

  it('applies whichever bound is reached first, with bounds of its own', () => {
    const buffer = new RingBuffer({ maxSeconds: 5, maxBytes: 1_000_000 });
    fill(buffer, 300, 1000);
    expect(buffer.bufferSeconds).toBeLessThanOrEqual(5);
    expect(buffer.bufferSeconds).toBeGreaterThan(4);

    const small = new RingBuffer({ maxSeconds: 5, maxBytes: 50_000 });
    fill(small, 300, 1000);
    expect(small.bufferBytes).toBeLessThanOrEqual(50_000);
    expect(small.video).toHaveLength(30);
  });

  it('never evicts the GOP being written, even past a bound', () => {
    const buffer = new RingBuffer({ maxSeconds: 2, maxBytes: 1_000_000 });
    // One keyframe, then 4 s of deltas: nothing else can go.
    fill(buffer, 120, 1000, 1000);

    expect(buffer.video).toHaveLength(120);
    expect(buffer.bufferSeconds).toBeCloseTo(4, 6);
  });

  it('evicts the audio up to the first frame, keeping the chunk that straddles it', () => {
    const buffer = new RingBuffer({ maxSeconds: 3, maxBytes: 1_000_000 });
    // Audio from 95 ms before the first frame, in 20 ms chunks: with no video yet, it all stays.
    let offsetUs = -95_000;
    for (; offsetUs < 1_000_000; offsetUs += 20_000) {
      buffer.push(audio(T0 + offsetUs));
    }
    expect(buffer.audio[0].timestampUs).toBe(T0 - 95_000);

    // 5 s of video (the last 3 s stay: GOPs from frame 60), then the audio up to 5 s.
    fill(buffer, 150);
    for (; offsetUs < 5_000_000; offsetUs += 20_000) {
      buffer.push(audio(T0 + offsetUs));
    }

    const first = buffer.video[0].timestampUs;
    expect(first).toBe(timestampOf(60));
    // The first audio chunk kept starts before the first frame and ends after it.
    expect(buffer.audio[0].timestampUs).toBe(T0 + 1_985_000);
    expect(first).toBe(T0 + 2_000_000);
    expect(buffer.bufferBytes).toBe(buffer.video.length * 1000 + buffer.audio.length * 100);
  });

  it('places audio on a clock of its own by the arrival offsets: kept to the same horizon, not dropped', () => {
    // Audio timestamps 2,000 s smaller than the frames' for the same moment (a clock that started
    // later, issue #33); the audio arrives 10 ms after its first sample, the frames at once.
    const clockUs = 2_000_000_000;
    const buffer = new RingBuffer({ maxSeconds: 3, maxBytes: 1_000_000 });
    let offsetUs = -95_000;
    const pushAudioUntil = (untilUs: number): void => {
      for (; offsetUs < untilUs; offsetUs += 20_000) {
        buffer.push(audio(T0 + offsetUs, 100, clockUs));
      }
    };
    for (let index = 0; index < 150; index += 1) {
      pushAudioUntil(timestampOf(index + 1) - T0);
      buffer.push(frame(index));
    }

    expect(buffer.audioOffsetFromVideoMs).toBeCloseTo(clockUs / 1000 + 10, 6);
    expect(buffer.audioRebaseUs).toBe(clockUs + 10_000);
    // The first frame kept is frame 60; the audio from the chunk that straddles it, as with one
    // clock (placed 10 ms late by the audio's latency, which its arrival offset includes).
    expect(buffer.video[0].timestampUs).toBe(T0 + 2_000_000);
    expect(buffer.audio[0].timestampUs + clockUs).toBe(T0 + 1_985_000);
    expect(buffer.audio.length).toBeGreaterThan(150);
    expect(buffer.bufferBytes).toBe(buffer.video.length * 1000 + buffer.audio.length * 100);

    // Audio on a clock ahead of the frames' goes with them too, rather than piling up.
    const ahead = new RingBuffer({ maxSeconds: 3, maxBytes: 1_000_000 });
    for (let index = 0; index < 150; index += 1) {
      for (let k = 0; k < 2; k += 1) {
        ahead.push(audio(timestampOf(index) + k * 16_667, 100, -clockUs));
      }
      ahead.push(frame(index));
    }
    expect(ahead.audioRebaseUs).toBe(-clockUs + 10_000);
    expect(ahead.audio.length).toBeLessThanOrEqual(2 * 91);
  });

  it('compares the timestamps as they are when both kinds count on one clock', () => {
    const buffer = new RingBuffer();
    fill(buffer, 30);
    buffer.push(audio(T0));
    // The audio's 10 ms of latency: well within one clock.
    expect(buffer.audioOffsetFromVideoMs).toBeCloseTo(10, 6);
    expect(AUDIO_REBASE_MS).toBe(100);
    expect(buffer.audioRebaseUs).toBe(0);
    buffer.clear();
    expect(buffer.audioOffsetFromVideoMs).toBeNull();
  });

  it('bounds the audio on its own before the first keyframe', () => {
    const buffer = new RingBuffer({ maxSeconds: 1, maxBytes: 1_000_000 });
    for (let offsetUs = 0; offsetUs < 3_000_000; offsetUs += 20_000) {
      buffer.push(audio(T0 + offsetUs));
    }

    const newest = buffer.audio[buffer.audio.length - 1];
    expect(
      newest.timestampUs + newest.durationUs - buffer.audio[0].timestampUs,
    ).toBeLessThanOrEqual(1_000_000);
    expect(buffer.audio).toHaveLength(50);
    expect(buffer.bufferBytes).toBe(50 * 100);
  });

  it('keeps the decoder configs after the chunks that carried them are gone', () => {
    const buffer = new RingBuffer({ maxSeconds: 2, maxBytes: 1_000_000 });
    buffer.setVideoTrack({ codec: 'avc1.640028', width: 1920, height: 1080 });
    buffer.setAudioTrack({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });
    const description = new Uint8Array([1, 100, 0, 40]).buffer;
    buffer.setVideoDecoderConfig({ codec: 'avc1.640028', description });
    buffer.setAudioDecoderConfig({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });

    fill(buffer, 300);

    expect(buffer.video[0].timestampUs).toBeGreaterThan(T0);
    expect(buffer.videoTrack).toEqual({
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
      decoderConfig: { codec: 'avc1.640028', description },
    });
    expect(buffer.audioTrack?.decoderConfig?.codec).toBe('opus');
  });

  it('forgets the chunks on clear() and keeps the track descriptions', () => {
    const buffer = new RingBuffer();
    buffer.setVideoTrack({ codec: 'vp09.00.40.08', width: 1280, height: 720 });
    fill(buffer, 40);
    buffer.push(audio(T0));

    buffer.clear();

    expect(buffer.video).toEqual([]);
    expect(buffer.audio).toEqual([]);
    expect(buffer.bufferBytes).toBe(0);
    expect(buffer.bufferSeconds).toBe(0);
    expect(buffer.videoTrack?.codec).toBe('vp09.00.40.08');
  });

  it('ignores a decoder config before its track is described', () => {
    const buffer = new RingBuffer();
    buffer.setVideoDecoderConfig({ codec: 'avc1.640028' });
    buffer.setAudioDecoderConfig({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });

    expect(buffer.videoTrack).toBeNull();
    expect(buffer.audioTrack).toBeNull();
  });
});
