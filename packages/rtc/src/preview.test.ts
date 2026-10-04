import { describe, expect, it } from 'vitest';

import { PREVIEW_ENCODING, previewStats } from './index';

// The live preview's statistics (T4.3), read out of an RTCStatsReport's values as Chrome gives them
// (the outbound stream of the phone's preview, the inbound one of the host's).

/** The values of a phone's report: the codec, the transport, the preview's outbound stream. */
const PHONE = [
  { type: 'codec', id: 'COT01_96', mimeType: 'video/VP8' },
  { type: 'transport', id: 'T01', bytesSent: 120_000 },
  { type: 'outbound-rtp', kind: 'audio', framesEncoded: 999, bytesSent: 1 },
  {
    type: 'outbound-rtp',
    kind: 'video',
    framesEncoded: 91,
    framesSent: 91,
    framesPerSecond: 15,
    frameWidth: 216,
    frameHeight: 384,
    bytesSent: 86_034,
    totalEncodeTime: 0.224,
    encoderImplementation: 'libvpx',
    qualityLimitationReason: 'none',
    qualityLimitationDurations: { bandwidth: 0, cpu: 1.25, none: 7.857, other: 0 },
  },
];

describe('previewStats', () => {
  it("reads the phone's outbound video stream: frames, rate, size, bytes, encoder time and implementation, its limits", () => {
    expect(previewStats(PHONE, 'outbound')).toEqual({
      frames: 91,
      fps: 15,
      width: 216,
      height: 384,
      bytes: 86_034,
      encodeMs: 224,
      implementation: 'libvpx',
      qualityLimitation: 'none',
      cpuLimitedSeconds: 1.25,
    });
  });

  it("reads the host's inbound video stream, without the encoder's facts", () => {
    const host = [
      {
        type: 'inbound-rtp',
        kind: 'video',
        framesDecoded: 90,
        framesPerSecond: 14,
        frameWidth: 216,
        frameHeight: 384,
        bytesReceived: 86_034,
        decoderImplementation: 'libvpx',
        totalEncodeTime: 3,
      },
    ];
    expect(previewStats(host, 'inbound')).toEqual({
      frames: 90,
      fps: 14,
      width: 216,
      height: 384,
      bytes: 86_034,
      encodeMs: null,
      implementation: 'libvpx',
      qualityLimitation: null,
      cpuLimitedSeconds: null,
    });
  });

  it('says nothing of a report without a video stream of the direction, and tolerates missing facts', () => {
    expect(previewStats(PHONE, 'inbound')).toBeNull();
    expect(previewStats([], 'outbound')).toBeNull();
    expect(previewStats([null, 3, 'x', { type: 'outbound-rtp' }], 'outbound')).toBeNull();
    expect(previewStats([{ type: 'outbound-rtp', kind: 'video' }], 'outbound')).toEqual({
      frames: 0,
      fps: null,
      width: null,
      height: null,
      bytes: 0,
      encodeMs: null,
      implementation: null,
      qualityLimitation: null,
      cpuLimitedSeconds: null,
    });
  });

  it('caps the preview at a fifth of the resolution, 300 kbps and 15 fps', () => {
    expect(PREVIEW_ENCODING).toEqual({
      scaleResolutionDownBy: 5,
      maxBitrate: 300_000,
      maxFramerate: 15,
    });
  });
});
