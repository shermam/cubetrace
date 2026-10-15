import { describe, expect, it } from 'vitest';

import type { VideoClip } from './attempt';
import { anchoredMotionLag, clipHostMs, clipLagMs, clipSeconds } from './clip';
import type { CameraClock } from './session';

function clip(firstFrameHostMs: number, syncResidualMs: number | null): VideoClip {
  return {
    camera: 'laptop',
    segment: 'solve',
    file: 'laptop.solve.mp4',
    bytes: 1,
    codec: 'avc1.640028',
    audio: null,
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 1,
    firstFrameHostMs,
    framesFile: 'laptop.solve.frames.json',
    syncResidualMs,
    truncatedStart: false,
  };
}

describe('a clip’s time on the host clock', () => {
  it('maps seconds into the clip to the host time the picture shows, and back, the camera’s lag applied', () => {
    const plain = clip(1000, null);
    expect(clipLagMs(plain)).toBe(0);
    expect(clipHostMs(plain, 2.4)).toBe(3400);
    expect(clipSeconds(plain, 3400)).toBe(2.4);
    // The picture lags the cube by 50 ms: the frame at 2.45 s shows the world at 3400, where a
    // move made at 3400 is in the picture.
    const lagging = clip(1000, 50);
    expect(clipLagMs(lagging)).toBe(50);
    expect(clipHostMs(lagging, 2.45)).toBeCloseTo(3400, 9);
    expect(clipSeconds(lagging, 3400)).toBeCloseTo(2.45, 9);
    expect(clipSeconds(lagging, clipHostMs(lagging, 7.25))).toBeCloseTo(7.25, 9);
  });
});

describe('anchoredMotionLag', () => {
  const check: CameraClock = {
    offsetMs: 58.4,
    rttMs: 0,
    driftPpm: 0,
    clapperboardResidualMs: 31.2,
    clapperboardSamples: 8,
    motionPeakAtCheckMs: 71.3,
    captureLatencyAtCheckMs: 2.1,
  };

  it("is the check's lag plus how far the clip's motion peak moved from the check's (T5.3)", () => {
    // Issue #67's step: the clip's motion peaks 75 ms later than the check's did.
    expect(anchoredMotionLag(146.3, check)).toBe(133.4);
    expect(anchoredMotionLag(71.3, check)).toBe(58.4);
    expect(anchoredMotionLag(60.1, check)).toBe(47.2);
  });

  it('is null without a peak, a check, or the check’s own peak', () => {
    expect(anchoredMotionLag(null, check)).toBeNull();
    expect(anchoredMotionLag(undefined, check)).toBeNull();
    expect(anchoredMotionLag(90, undefined)).toBeNull();
    expect(anchoredMotionLag(90, { ...check, motionPeakAtCheckMs: null })).toBeNull();
    // A check recorded before T5.3 kept none.
    const before: CameraClock = {
      offsetMs: check.offsetMs,
      rttMs: 0,
      driftPpm: 0,
      clapperboardResidualMs: check.clapperboardResidualMs,
      clapperboardSamples: check.clapperboardSamples,
    };
    expect(anchoredMotionLag(90, before)).toBeNull();
    // A remote camera's entry before its check: its clock sync alone.
    expect(anchoredMotionLag(90, { ...check, clapperboardSamples: 0 })).toBeNull();
  });
});
