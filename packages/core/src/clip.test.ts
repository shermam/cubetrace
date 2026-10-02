import { describe, expect, it } from 'vitest';

import type { VideoClip } from './attempt';
import { clipHostMs, clipLagMs, clipSeconds } from './clip';

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
