import { analyzeFrames, percentile, summarize, type FrameSample } from './frame-timing';

const INTERVAL = 1000 / 30;

/** A 30 fps camera whose frames reach the callback 5 ms after they reach Chrome. */
function steady(count: number): FrameSample[] {
  return Array.from({ length: count }, (_, index) => ({
    at: 1000 + index * INTERVAL + 5,
    captureTime: 1000 + index * INTERVAL,
    mediaTime: (index * INTERVAL) / 1000,
    presentedFrames: index + 1,
    width: 1920,
    height: 1080,
  }));
}

describe('percentile', () => {
  it('interpolates between ranks', () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('summarize', () => {
  it('gives count, extremes, percentiles and mean', () => {
    expect(summarize([3, 1, 2])).toEqual({
      count: 3,
      min: 1,
      p5: 1.1,
      p50: 2,
      p95: 2.9,
      max: 3,
      mean: 2,
    });
  });

  it('says so when there is nothing to summarise', () => {
    expect(summarize([])).toEqual({ skipped: 'no values' });
  });
});

describe('analyzeFrames', () => {
  it('measures a steady 30 fps camera', () => {
    const timing = analyzeFrames(steady(31));

    expect(timing).toMatchObject({
      frames: 31,
      durationMs: 1000,
      achievedFps: 30,
      presentedFps: 30,
      intervalMs: { count: 30, min: 33.333, p50: 33.333, max: 33.333 },
      captureMinusNowMs: { count: 31, p5: -5, p50: -5, p95: -5 },
      mediaTimeDeltaMs: { count: 30, p50: 33.333 },
      captureMinusMediaMs: { count: 31, p5: 1000, p95: 1000 },
      callbackMissedFrames: 0,
      droppedFramesEstimate: 0,
      frameSizes: ['1920x1080'],
    });
  });

  it('counts a frame the camera never delivered as dropped', () => {
    const samples = steady(31)
      .filter((_, index) => index !== 10)
      .map((sample, index) => ({ ...sample, presentedFrames: index + 1 }));

    expect(analyzeFrames(samples)).toMatchObject({
      frames: 30,
      achievedFps: 29,
      presentedFps: 29,
      callbackMissedFrames: 0,
      droppedFramesEstimate: 1,
    });
  });

  it('counts a frame that was presented but seen by no callback as missed, not dropped', () => {
    const samples = steady(31).filter((_, index) => index !== 10);

    expect(analyzeFrames(samples)).toMatchObject({
      frames: 30,
      achievedFps: 29,
      presentedFps: 30,
      callbackMissedFrames: 1,
      droppedFramesEstimate: 0,
    });
  });

  it('marks what a browser without captureTime and presentedFrames cannot tell', () => {
    const samples = steady(31).map(({ at, mediaTime, width, height }) => ({
      at,
      mediaTime,
      width,
      height,
    }));

    expect(analyzeFrames(samples)).toMatchObject({
      achievedFps: 30,
      presentedFps: { missing: 'presentedFrames' },
      captureMinusNowMs: { missing: 'captureTime' },
      captureMinusMediaMs: { missing: 'captureTime' },
      callbackMissedFrames: { missing: 'presentedFrames' },
      droppedFramesEstimate: 0,
    });
  });

  it('lists every frame size seen', () => {
    const samples = steady(4).map((sample, index) =>
      index < 2 ? sample : { ...sample, width: 1280, height: 720 },
    );

    expect(analyzeFrames(samples)).toMatchObject({ frameSizes: ['1920x1080', '1280x720'] });
  });

  it('needs two frames', () => {
    expect(analyzeFrames(steady(1))).toEqual({
      skipped: '1 frame(s) in the window, at least 2 are needed',
    });
  });
});
