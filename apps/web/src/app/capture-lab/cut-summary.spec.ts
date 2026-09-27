import { RingBuffer, cut } from '@cubetrace/capture';

import { summarizeCut } from './cut-summary';

/** Two seconds of 30 fps video (a keyframe a second, 1000 bytes a frame) and 20 ms audio chunks. */
function recording(): RingBuffer {
  const buffer = new RingBuffer();
  buffer.setVideoTrack({ codec: 'vp09.00.40.08', width: 1920, height: 1080 });
  buffer.setVideoDecoderConfig({ codec: 'vp09.00.40.08' });
  buffer.setAudioTrack({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });
  for (let index = 0; index < 100; index += 1) {
    buffer.push({
      kind: 'audio',
      type: 'key',
      timestampUs: 5_000_000 + index * 20_000,
      durationUs: 20_000,
      byteLength: 40,
      arrivalHostMs: 1_000_000 + 5000 + index * 20,
      data: new ArrayBuffer(40),
    });
  }
  for (let index = 0; index < 60; index += 1) {
    const timestampUs = 5_000_000 + Math.round((index * 1e6) / 30);
    buffer.push({
      kind: 'video',
      type: index % 30 === 0 ? 'key' : 'delta',
      timestampUs,
      durationUs: 33_333,
      byteLength: 1000,
      arrivalHostMs: 1_000_000 + timestampUs / 1000 + 4,
      data: new ArrayBuffer(1000),
    });
  }
  return buffer;
}

describe('summarizeCut', () => {
  it('describes a cut without its bytes: sizes, times, bitrate and the raw frame times', () => {
    // Frame 30 (a keyframe) is at host ms 1_006_004, frame 44 at 1_006_470.667.
    const result = cut(recording(), 1_006_004, 1_006_500);
    const summary = summarizeCut(result, {
      startHostMs: 1_006_004,
      endHostMs: 1_006_500,
      latencyMs: 3.14159,
      timeOrigin: 999_000,
    });

    expect(summary).toMatchObject({
      requested: { startHostMs: 1_006_004, endHostMs: 1_006_500, seconds: 0.496 },
      latencyMs: 3.1,
      timeOrigin: 999_000,
      truncatedStart: false,
      truncatedEnd: false,
      video: {
        codec: 'vp09.00.40.08',
        width: 1920,
        height: 1080,
        decoderConfig: { codec: 'vp09.00.40.08', descriptionBytes: null },
        firstType: 'key',
      },
      audio: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 },
    });
    // Frames 30 to 44: 15 frames of 1000 bytes in 500 ms of video.
    expect(summary.video.chunks).toBe(15);
    expect(summary.video.bytes).toBe(15_000);
    expect(summary.video.durationMs).toBe(500);
    expect(summary.video.bitrateKbps).toBe(240);
    expect(summary.video.timestampsUs).toHaveLength(15);
    expect(summary.video.timestampsUs[0]).toBe(6_000_000);
    expect(summary.video.arrivalsHostMs[0]).toBe(1_006_004);
    // The 20 ms audio chunks from 6.00 s to 6.48 s overlap that span.
    expect(summary.audio).toMatchObject({ chunks: 25, bytes: 1000, firstTimestampUs: 6_000_000 });
    expect(summary.frames).toEqual(result.frames);
  });

  it("says what the frames' clock is: its first value, its offset to the page's clock, its drift", () => {
    const summary = summarizeCut(cut(recording(), 0, 1e9), {
      startHostMs: 0,
      endHostMs: 1e9,
      latencyMs: 1,
      timeOrigin: 999_000,
    });

    // Arrivals are 1_000_004 ms after the timestamps: the page's performance.now() at a frame's
    // arrival is its timestamp + 1004 ms, and the offset does not change.
    expect(summary.clock).toEqual({
      firstTimestampUs: 5_000_000,
      timestampMinusPageNowMs: -1004,
      arrivalDriftMsPerMinute: 0,
      audioMinusVideoOffsetMs: -4,
    });
  });
});
