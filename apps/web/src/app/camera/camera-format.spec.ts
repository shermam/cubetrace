import {
  exposureText,
  fpsText,
  framingText,
  fromSlider,
  logarithmic,
  modeLabel,
  sharpnessBar,
  sharpnessText,
  temperatureText,
  toSlider,
  trackText,
  zoomText,
} from './camera-format';

describe('camera text', () => {
  it('reads modes as Auto and Manual', () => {
    expect(modeLabel('continuous')).toBe('Auto');
    expect(modeLabel('single-shot')).toBe('Auto (once)');
    expect(modeLabel('manual')).toBe('Manual');
    expect(modeLabel('none')).toBe('Off');
  });

  it('shows exposure times in ms and as a shutter speed, from units of 100 µs', () => {
    expect(exposureText(309.245)).toBe('31 ms (1/32 s)');
    expect(exposureText(20)).toBe('2.0 ms (1/500 s)');
    expect(exposureText(0.832)).toBe('0.1 ms (1/12019 s)');
    expect(exposureText(20_000)).toBe('2000 ms (2.0 s)');
    expect(exposureText(0)).toBe('0.0 ms');
  });

  it('shows temperatures, zoom, rates, the track and the framing', () => {
    expect(temperatureText(4450)).toBe('4450 K');
    expect(temperatureText(0)).toBe('auto');
    expect(zoomText(2)).toBe('2.0×');
    expect(fpsText(29.97)).toBe('30.0 fps');
    expect(trackText({ width: 1920, height: 1080, frameRate: 60 })).toBe('1920×1080 at 60 fps');
    expect(trackText({ width: 1080, height: 1920 })).toBe('1080×1920');
    expect(trackText({ frameRate: 30 })).toBeNull();
    expect(trackText(null)).toBeNull();
    const hd = { width: 1920, height: 1080 };
    expect(framingText({ x: 0, y: 0, w: 1920, h: 1080 }, hd)).toBe('full frame, 1920×1080');
    expect(framingText({ x: 480, y: 270, w: 960, h: 540 }, hd)).toBe('480, 270, 960×540');
    expect(sharpnessText(105.4)).toBe('105');
    expect(sharpnessText(4.71)).toBe('4.7');
  });
});

describe('sliders', () => {
  const exposure = { min: 0.832, max: 2880, step: 0.1 };
  const zoom = { min: 1, max: 8, step: 0.1 };

  it('are logarithmic for the exposure time and ISO, linear for the rest', () => {
    expect(logarithmic(exposure, 'exposureTime')).toBe(true);
    expect(logarithmic({ min: 100, max: 1594 }, 'iso')).toBe(true);
    expect(logarithmic({ min: 0, max: 100 }, 'exposureTime')).toBe(false);
    expect(logarithmic(zoom, 'zoom')).toBe(false);
  });

  it('go from position to value and back, on the range steps', () => {
    expect(toSlider(1, zoom, false)).toBe(0);
    expect(toSlider(8, zoom, false)).toBe(1000);
    expect(toSlider(4.5, zoom, false)).toBe(500);
    expect(fromSlider(500, zoom, false)).toBe(4.5);
    expect(fromSlider(-10, zoom, false)).toBe(1);
    expect(fromSlider(2000, zoom, false)).toBe(8);

    // Logarithmic: the middle of 0.832–2880 is about 49 (4.9 ms), not 1440.
    expect(fromSlider(500, exposure, true)).toBe(48.932);
    expect(toSlider(48.932, exposure, true)).toBe(500);
    expect(toSlider(0.832, exposure, true)).toBe(0);
    expect(fromSlider(1000, exposure, true)).toBe(2880);
  });
});

describe('sharpnessBar', () => {
  it('fills on a log scale up to ten times the threshold', () => {
    expect(sharpnessBar(0, 20)).toBe(0);
    expect(sharpnessBar(200, 20)).toBe(1);
    expect(sharpnessBar(5000, 20)).toBe(1);
    expect(sharpnessBar(20, 20)).toBeCloseTo(Math.log1p(20) / Math.log1p(200), 9);
    expect(sharpnessBar(20, 20)).toBeGreaterThan(0.5);
    expect(sharpnessBar(-3, 20)).toBe(0);
  });
});
