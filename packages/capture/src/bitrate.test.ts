import { describe, expect, it } from 'vitest';

import { BITRATE_AT_1080P30, videoBitrate, type VideoQuality } from './bitrate';

describe('videoBitrate', () => {
  it('asks 4, 8 and 12 Mbps at 1080p30, whichever way up the frames are', () => {
    expect(BITRATE_AT_1080P30).toEqual({
      standard: 4_000_000,
      high: 8_000_000,
      maximum: 12_000_000,
    });
    for (const quality of ['standard', 'high', 'maximum'] as const) {
      expect(videoBitrate(1920, 1080, 30, quality), quality).toBe(BITRATE_AT_1080P30[quality]);
      expect(videoBitrate(1080, 1920, 30, quality), quality).toBe(BITRATE_AT_1080P30[quality]);
      // A camera's 29.97 fps, or the 20 fps of Chrome's fake camera, is not a high frame rate.
      expect(videoBitrate(1920, 1080, 29.97, quality), quality).toBe(BITRATE_AT_1080P30[quality]);
      expect(videoBitrate(1920, 1080, 20, quality), quality).toBe(BITRATE_AT_1080P30[quality]);
    }
  });

  it('scales with the pixels: 1280×720 takes 0.44 times as much', () => {
    expect(videoBitrate(1280, 720, 30, 'standard')).toBe(1_777_778);
    expect(videoBitrate(1280, 720, 30, 'high')).toBe(3_555_556);
    expect(videoBitrate(1280, 720, 30, 'maximum')).toBe(5_333_333);
    expect(videoBitrate(1280, 720, 30, 'standard') / 4_000_000).toBeCloseTo(0.444, 3);
    expect(videoBitrate(640, 480, 30, 'standard')).toBe(592_593);
  });

  it('takes 1.5 times as much above 45 fps', () => {
    expect(videoBitrate(1920, 1080, 60, 'standard')).toBe(6_000_000);
    expect(videoBitrate(1920, 1080, 59.94, 'standard')).toBe(6_000_000);
    expect(videoBitrate(1920, 1080, 60, 'high')).toBe(12_000_000);
    expect(videoBitrate(1920, 1080, 60, 'maximum')).toBe(18_000_000);
    expect(videoBitrate(1280, 720, 60, 'standard')).toBe(2_666_667);
    expect(videoBitrate(1920, 1080, 45, 'standard')).toBe(4_000_000);
    expect(videoBitrate(1920, 1080, 46, 'standard')).toBe(6_000_000);
  });

  it('keeps the rule of the first recordings as High: 8 Mbps at 1080p30, 12 at 1080p60', () => {
    // The rule every recording had before the setting existed, in proportion to the pixels.
    const before = (width: number, height: number, fps: number): number =>
      Math.round(((fps > 45 ? 12_000_000 : 8_000_000) * width * height) / (1920 * 1080));
    const formats: [number, number, number][] = [
      [1920, 1080, 30],
      [1080, 1920, 30],
      [1920, 1080, 60],
      [1280, 720, 30],
      [1280, 720, 60],
      [640, 480, 20],
    ];
    for (const [width, height, fps] of formats) {
      expect(videoBitrate(width, height, fps, 'high'), `${String(width)}×${String(height)}`).toBe(
        before(width, height, fps),
      );
    }
  });

  it('orders the qualities: Standard is half of High, Maximum one and a half times it', () => {
    const at = (quality: VideoQuality): number => videoBitrate(1920, 1080, 30, quality);
    expect(at('standard') * 2).toBe(at('high'));
    expect(at('high') * 1.5).toBe(at('maximum'));
  });
});
