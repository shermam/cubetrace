import {
  ATTEMPT_CLIP_SECONDS,
  attemptBytes,
  attemptSizeText,
  bitrateText,
  expectedBitrate,
  videoQualityOptions,
  type VideoQualityOption,
} from './video-quality';

describe('video quality text', () => {
  const labels = (options: readonly VideoQualityOption[]): string[] =>
    options.map((option) => option.label);

  it('lists Standard, High and Maximum with their bitrate and size per attempt at 1080p30', () => {
    expect(videoQualityOptions('1080p', 'best').map((option) => option.value)).toEqual([
      'standard',
      'high',
      'maximum',
    ]);
    // Best counts 30 fps, as the 30 fps setting does.
    for (const rate of ['best', '30'] as const) {
      expect(labels(videoQualityOptions('1080p', rate))).toEqual([
        'Standard (4 Mbps, ≈ 20 MB per attempt)',
        'High (8 Mbps, ≈ 40 MB per attempt)',
        'Maximum (12 Mbps, ≈ 60 MB per attempt)',
      ]);
    }
  });

  it('follows the resolution and frame rate asked for', () => {
    expect(labels(videoQualityOptions('720p', '30'))).toEqual([
      'Standard (1.8 Mbps, ≈ 9 MB per attempt)',
      'High (3.6 Mbps, ≈ 18 MB per attempt)',
      'Maximum (5.3 Mbps, ≈ 27 MB per attempt)',
    ]);
    expect(labels(videoQualityOptions('1080p', '60'))).toEqual([
      'Standard (6 Mbps, ≈ 30 MB per attempt)',
      'High (12 Mbps, ≈ 60 MB per attempt)',
      'Maximum (18 Mbps, ≈ 90 MB per attempt)',
    ]);
    expect(expectedBitrate('standard', '1080p', 'best')).toBe(4_000_000);
    expect(expectedBitrate('high', '720p', '60')).toBe(5_333_333);
  });

  it('writes bitrates in Mbps to a tenth, and an attempt as 40 s of clips in whole MB', () => {
    expect(bitrateText(4_000_000)).toBe('4 Mbps');
    expect(bitrateText(1_777_778)).toBe('1.8 Mbps');
    expect(bitrateText(12_000_000)).toBe('12 Mbps');
    expect(bitrateText(592_593)).toBe('0.6 Mbps');
    expect(ATTEMPT_CLIP_SECONDS).toBe(40);
    expect(attemptBytes(4_000_000)).toBe(20_000_000);
    expect(attemptBytes(8_000_000)).toBe(40_000_000);
    expect(attemptSizeText(4_000_000)).toBe('≈ 20 MB per attempt');
    expect(attemptSizeText(1_777_778)).toBe('≈ 9 MB per attempt');
  });
});
