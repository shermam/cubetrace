import { describe, expect, it } from 'vitest';

import {
  CHANGE_LEVELS,
  LumaDownscaler,
  MOTION_POINTS,
  MOTION_WIDE_WIDTH,
  MOTION_WIDTH,
  MotionMeter,
  changedArea,
  codedRect,
  compareLuma,
  isMotionFrame,
  motionEnergy,
  motionPlaneSize,
  motionSize,
  regionOf,
  type PlaneRegion,
} from './motion';
import { SyntheticFrame, lumaPlane, seeded } from './test-frames';

const WIDTH = 1920;
const HEIGHT = 1080;

/** The still picture: a dark background. */
const STILL = lumaPlane(WIDTH, HEIGHT, 16);

/**
 * The same picture with a bright square of 120 pixels: over the whole frame, twenty 6-pixel blocks of
 * the 320-pixel plane each way, so exactly 400 of its 320 × 180 pixels change, by 239 levels.
 */
const SQUARE = lumaPlane(WIDTH, HEIGHT, 16, [{ x: 600, y: 360, size: 120, value: 255 }]);
const WHOLE_PIXELS = 320 * 180;
const SQUARE_MEAN = (400 * 239) / WHOLE_PIXELS;
const SQUARE_CHANGED = 400 / WHOLE_PIXELS;

function frame(pixels: Uint8Array, timestamp = 0): SyntheticFrame {
  return new SyntheticFrame(timestamp, pixels);
}

/** A plane of `length` pixels of `value` plus noise drawn evenly from ±`noise` levels. */
function noisy(length: number, value: number, noise: number, random: () => number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.round(value + (2 * random() - 1) * noise));
}

describe('motionEnergy, changedArea and compareLuma', () => {
  it('the mean absolute difference of two planes, 0 for the same picture', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    expect(motionEnergy(a, a)).toBe(0);
    expect(motionEnergy(a, new Uint8Array([13, 17, 33, 37]))).toBe(3);
    expect(motionEnergy(a, new Uint8Array([50, 20, 30, 40]))).toBe(10);
    expect(motionEnergy(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });

  it('the changed area: the share of the pixels that moved by more than 12 levels', () => {
    expect(CHANGE_LEVELS).toBe(12);
    const a = new Uint8Array([100, 100, 100, 100]);
    expect(changedArea(a, new Uint8Array([112, 88, 100, 100]))).toBe(0);
    expect(changedArea(a, new Uint8Array([113, 87, 100, 100]))).toBe(0.5);
    expect(changedArea(a, new Uint8Array([255, 0, 200, 113]))).toBe(1);
    expect(changedArea(a, new Uint8Array([120, 100, 100, 100]), 30)).toBe(0);
    expect(compareLuma(a, new Uint8Array([113, 87, 104, 100]))).toEqual({
      mean: 7.5,
      changed: 0.5,
    });
    expect(compareLuma(new Uint8Array(0), new Uint8Array(0))).toEqual({ mean: 0, changed: 0 });
  });

  it("counts none of a camera's noise, which the mean does", () => {
    // Two pictures of the same grey, each with noise of up to ±5 levels a pixel.
    const random = seeded(1);
    const a = noisy(WHOLE_PIXELS, 120, 5, random);
    const b = noisy(WHOLE_PIXELS, 120, 5, random);
    const { mean, changed } = compareLuma(a, b);
    expect(mean).toBeGreaterThan(2.5);
    expect(changed).toBe(0);
  });

  it('counts none of a flicker of the light that brightens every pixel by up to 12 levels', () => {
    const random = seeded(2);
    const a = noisy(WHOLE_PIXELS, 120, 2, random);
    const brighter = a.map((value) => value + 8);
    expect(compareLuma(a, brighter)).toEqual({ mean: 8, changed: 0 });
    // Brighter by 20 levels, every pixel changed: a lamp switched on, not a turn.
    expect(
      changedArea(
        a,
        a.map((value) => value + 20),
      ),
    ).toBe(1);
  });

  it('counts a compact change in full, where the mean barely moves', () => {
    // Noise of up to ±5 levels everywhere; a 20 × 20 square (the cube's turning face, 0.7% of the
    // plane) 60 levels brighter in the second picture.
    const random = seeded(3);
    const a = noisy(WHOLE_PIXELS, 90, 5, random);
    const b = noisy(WHOLE_PIXELS, 90, 5, random);
    for (let y = 60; y < 80; y++) {
      for (let x = 100; x < 120; x++) {
        b[y * 320 + x] += 60;
      }
    }
    const { mean, changed } = compareLuma(a, b);
    expect(changed).toBe(400 / WHOLE_PIXELS);
    // The mean: the noise's 3.3 levels, and 0.4 more for the square.
    expect(mean).toBeGreaterThan(3);
    expect(mean).toBeLessThan(4.2);
  });

  it('refuses planes of different sizes', () => {
    expect(() => motionEnergy(new Uint8Array(4), new Uint8Array(6))).toThrow(RangeError);
    expect(() => changedArea(new Uint8Array(4), new Uint8Array(6))).toThrow(RangeError);
  });
});

describe('motionSize and motionPlaneSize', () => {
  it('is 160 pixels wide by default, or the region if narrower, the height in proportion', () => {
    expect([MOTION_WIDTH, MOTION_WIDE_WIDTH, MOTION_POINTS]).toEqual([160, 320, 2]);
    expect(motionSize({ w: 1920, h: 1080 })).toEqual({ width: 160, height: 90 });
    expect(motionSize({ w: 1080, h: 1920 })).toEqual({ width: 160, height: 284 });
    expect(motionSize({ w: 960, h: 840 })).toEqual({ width: 160, height: 140 });
    expect(motionSize({ w: 100, h: 50 })).toEqual({ width: 100, height: 50 });
    expect(motionSize({ w: 1920, h: 2 })).toEqual({ width: 160, height: 1 });
    expect(motionSize({ w: 1920, h: 1080 }, 320)).toEqual({ width: 320, height: 180 });
  });

  it('is 320 pixels wide for the whole frame or more than 60% of it, 160 for a tighter region', () => {
    const size = { width: WIDTH, height: HEIGHT };
    expect(motionPlaneSize({ x: 0, y: 0, w: WIDTH, h: HEIGHT }, size)).toEqual({
      width: 320,
      height: 180,
    });
    // 1600 × 900: 69% of the frame.
    expect(motionPlaneSize({ x: 160, y: 90, w: 1600, h: 900 }, size)).toEqual({
      width: 320,
      height: 180,
    });
    // 960 × 840: 39%.
    expect(motionPlaneSize({ x: 480, y: 120, w: 960, h: 840 }, size)).toEqual({
      width: 160,
      height: 140,
    });
    // A phone's upright frames.
    expect(
      motionPlaneSize({ x: 0, y: 0, w: 1080, h: 1920 }, { width: 1080, height: 1920 }),
    ).toEqual({ width: 320, height: 569 });
  });
});

describe('LumaDownscaler', () => {
  const luma = (width: number, height: number, stride = width, offset = 0): PlaneRegion => ({
    width,
    height,
    offset,
    stride,
    kind: 'luma',
  });

  it('averages the points of each block: a flat plane stays flat, halves stay halves', () => {
    const flat = new LumaDownscaler(luma(16, 8), { width: 4, height: 2 });
    const out = new Uint8Array(8);
    flat.downscale(new Uint8Array(16 * 8).fill(77), out);
    expect([...out]).toEqual(Array<number>(8).fill(77));

    // Left half 0, right half 200.
    const halves = new Uint8Array(16 * 8);
    for (let y = 0; y < 8; y++) {
      halves.fill(200, y * 16 + 8, y * 16 + 16);
    }
    flat.downscale(halves, out);
    expect([...out]).toEqual([0, 0, 200, 200, 0, 0, 200, 200]);
  });

  it("reads a region's rows at their offset and stride, never the padding", () => {
    // A 4 × 2 region at byte 3 of rows of 10 bytes, the rest 255.
    const data = new Uint8Array(3 + 10 * 2).fill(255);
    data.set([10, 10, 30, 30], 3);
    data.set([10, 10, 30, 30], 13);
    const downscaler = new LumaDownscaler(luma(4, 2, 10, 3), { width: 2, height: 1 });
    const out = new Uint8Array(2);
    downscaler.downscale(data, out);
    expect([...out]).toEqual([10, 30]);
    expect(downscaler.fits(luma(4, 2, 10, 3))).toBe(true);
    expect(downscaler.fits(luma(4, 2, 12, 3))).toBe(false);
  });

  it('gives the same plane on its fast path for 2 × 2 points as the general one', () => {
    // A random grey picture, read as luma (the fast path) and as grey RGBX pixels (the general
    // path, whose weights add up to 256): the same averages, the same rounding.
    const random = seeded(4);
    const [width, height] = [331, 187];
    const grey = Uint8Array.from({ length: width * height }, () => Math.floor(random() * 256));
    const rgbx = new Uint8Array(width * height * 4);
    grey.forEach((value, i) => rgbx.set([value, value, value, 255], i * 4));
    const size = { width: 97, height: 55 };
    const fast = new Uint8Array(size.width * size.height);
    const general = new Uint8Array(size.width * size.height);
    new LumaDownscaler(luma(width, height), size).downscale(grey, fast);
    new LumaDownscaler(
      { width, height, offset: 0, stride: width * 4, kind: 'rgbx' },
      size,
    ).downscale(rgbx, general);
    expect([...fast]).toEqual([...general]);
  });

  it('weighs red, green and blue as BT.601 luma, in RGB or BGR order', () => {
    const red = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]);
    const out = new Uint8Array(1);
    const region = (kind: 'rgbx' | 'bgrx'): PlaneRegion => ({
      width: 2,
      height: 1,
      offset: 0,
      stride: 8,
      kind,
    });
    new LumaDownscaler(region('rgbx'), { width: 1, height: 1 }).downscale(red, out);
    expect(out[0]).toBe(77);
    // The same bytes read as blue, green, red: blue.
    new LumaDownscaler(region('bgrx'), { width: 1, height: 1 }).downscale(red, out);
    expect(out[0]).toBe(29);
    const white = new Uint8Array(8).fill(255);
    new LumaDownscaler(region('rgbx'), { width: 1, height: 1 }).downscale(white, out);
    expect(out[0]).toBe(255);
  });
});

describe('regionOf and codedRect', () => {
  it('clamps the framing rectangle to the frame, or takes the whole frame', () => {
    const f = frame(STILL);
    expect(regionOf(null, f)).toEqual({ x: 0, y: 0, w: WIDTH, h: HEIGHT });
    expect(regionOf({ x: 480, y: 120, w: 960, h: 840 }, f)).toEqual({
      x: 480,
      y: 120,
      w: 960,
      h: 840,
    });
    expect(regionOf({ x: 1800, y: 1000, w: 400, h: 400 }, f)).toEqual({
      x: 1800,
      y: 1000,
      w: 120,
      h: 80,
    });
    // Framed on portrait frames: outside these.
    expect(regionOf({ x: 0, y: 1500, w: 1080, h: 400 }, f)).toEqual({
      x: 0,
      y: 0,
      w: WIDTH,
      h: HEIGHT,
    });
  });

  it('copies the region on even pixels, scaled to the coded pixels of a stretched frame', () => {
    expect(codedRect(frame(STILL), { x: 481, y: 121, w: 959, h: 839 })).toEqual({
      x: 480,
      y: 120,
      width: 960,
      height: 840,
    });
    // 1440 coded pixels shown 1920 wide.
    const stretched = new SyntheticFrame(0, new Uint8Array(1440 * 1080), WIDTH, HEIGHT);
    Object.assign(stretched, { visibleRect: { x: 0, y: 0, width: 1440, height: 1080 } });
    expect(codedRect(stretched, { x: 960, y: 0, w: 960, h: 1080 })).toEqual({
      x: 720,
      y: 0,
      width: 720,
      height: 1080,
    });
  });
});

describe('MotionMeter', () => {
  it('measures nothing on the first frame, 0 on the same picture, and the change on another', async () => {
    const meter = new MotionMeter();
    expect(await meter.measure(frame(STILL))).toMatchObject({ mean: null, changed: null });
    expect(await meter.measure(frame(STILL))).toMatchObject({ mean: 0, changed: 0 });
    const square = await meter.measure(frame(SQUARE));
    expect(square.mean).toBeCloseTo(SQUARE_MEAN, 10);
    expect(square.changed).toBeCloseTo(SQUARE_CHANGED, 10);
    expect(await meter.measure(frame(SQUARE))).toMatchObject({ mean: 0, changed: 0 });
    expect((await meter.measure(frame(STILL))).changed).toBeCloseTo(SQUARE_CHANGED, 10);
  });

  it('says how it reads the frames: the same description while nothing changes', async () => {
    const meter = new MotionMeter();
    const first = await meter.measure(frame(STILL));
    expect(first.meter).toEqual({
      format: 'I420',
      path: 'copy',
      frameWidth: WIDTH,
      frameHeight: HEIGHT,
      region: { x: 0, y: 0, w: WIDTH, h: HEIGHT },
      planeWidth: 320,
      planeHeight: 180,
      changeLevels: 12,
    });
    expect((await meter.measure(frame(SQUARE))).meter).toBe(first.meter);
    const nv12 = new SyntheticFrame(2, STILL, WIDTH, HEIGHT, 'NV12');
    expect((await meter.measure(nv12)).meter).toEqual({ ...first.meter, format: 'NV12' });

    const tight = new MotionMeter({ x: 480, y: 120, w: 960, h: 840 });
    expect((await tight.measure(frame(STILL))).meter).toMatchObject({
      region: { x: 480, y: 120, w: 960, h: 840 },
      planeWidth: 160,
      planeHeight: 140,
    });
  });

  it('sees only the framing rectangle', async () => {
    // A 960 × 480 rectangle (22% of the frame) whose plane is 160 × 80 (6 pixels a block); the square
    // is outside it.
    const inside = new MotionMeter({ x: 960, y: 480, w: 960, h: 480 });
    await inside.measure(frame(STILL));
    expect(await inside.measure(frame(SQUARE))).toMatchObject({ mean: 0, changed: 0 });
    const around = new MotionMeter({ x: 480, y: 240, w: 960, h: 480 });
    await around.measure(frame(STILL));
    // The square covers 20 × 20 of its 160 × 80 pixels.
    const measured = await around.measure(frame(SQUARE));
    expect(measured.mean).toBeCloseTo((400 * 239) / 12_800, 10);
    expect(measured.changed).toBeCloseTo(400 / 12_800, 10);
  });

  it('reads RGB frames by their luma', async () => {
    const rgba = (value: number): Uint8Array =>
      new Uint8Array(64 * 36 * 4).map((_, i) => (i % 4 === 3 ? 255 : value));
    const meter = new MotionMeter();
    const size = [64, 36] as const;
    await meter.measure(new SyntheticFrame(0, rgba(20), ...size, 'RGBA'));
    const measured = await meter.measure(new SyntheticFrame(1, rgba(120), ...size, 'BGRX'));
    expect(measured).toMatchObject({ mean: 100, changed: 1 });
    expect(measured.meter).toMatchObject({ format: 'BGRX', planeWidth: 64, planeHeight: 36 });
  });

  it('starts again when the frames change size', async () => {
    const meter = new MotionMeter();
    await meter.measure(frame(STILL));
    const portrait = new SyntheticFrame(1, lumaPlane(HEIGHT, WIDTH, 16), HEIGHT, WIDTH);
    const turned = await meter.measure(portrait);
    expect(turned).toMatchObject({ mean: null, changed: null });
    expect(turned.meter).toMatchObject({ frameWidth: HEIGHT, frameHeight: WIDTH, planeWidth: 320 });
    expect(await meter.measure(portrait)).toMatchObject({ mean: 0, changed: 0 });
  });

  it('draws the frames it cannot copy, and refuses them without a way to draw', async () => {
    const opaque = new SyntheticFrame(0, STILL, WIDTH, HEIGHT, null);
    await expect(new MotionMeter().measure(opaque)).rejects.toThrow(
      'The motion meter cannot read frames of no pixel format.',
    );
    const turned = frame(STILL);
    turned.rotation = 90;
    await expect(new MotionMeter().measure(turned)).rejects.toThrow(
      'The motion meter cannot read a frame to be shown turned or mirrored (I420).',
    );

    const drawn: { region: unknown; size: unknown }[] = [];
    const meter = new MotionMeter<SyntheticFrame>(
      { x: 0, y: 0, w: 960, h: 540 },
      {
        draw: (source, region, size) => {
          drawn.push({ region, size });
          return { luma: new Uint8Array(size.width * size.height).fill(source.timestamp), ...size };
        },
      },
    );
    await meter.measure(new SyntheticFrame(10, STILL, WIDTH, HEIGHT, null));
    const second = await meter.measure(new SyntheticFrame(13, STILL, WIDTH, HEIGHT, null));
    expect(second).toMatchObject({ mean: 3, changed: 0 });
    expect(second.meter).toMatchObject({ format: null, path: 'draw', planeWidth: 160 });
    expect(drawn[0]).toEqual({
      region: { x: 0, y: 0, w: 960, h: 540 },
      size: { width: 160, height: 90 },
    });
    // The whole frame is drawn 320 pixels wide.
    const whole: unknown[] = [];
    const wide = new MotionMeter<SyntheticFrame>(null, {
      draw: (_source, _region, size) => {
        whole.push(size);
        return { luma: new Uint8Array(size.width * size.height), ...size };
      },
    });
    await wide.measure(opaque);
    expect(whole).toEqual([{ width: 320, height: 180 }]);
    const refusing = new MotionMeter<SyntheticFrame>(null, { draw: () => null });
    await expect(refusing.measure(opaque)).rejects.toThrow('this browser draws no frame');
  });

  it('says what measuring a frame cost, on its clock', async () => {
    let clock = 100;
    const meter = new MotionMeter(null, {
      now: () => {
        clock += 0.25;
        return clock;
      },
    });
    expect((await meter.measure(frame(STILL))).costMs).toBe(0.25);
  });

  it('measures a whole 1080p frame on its 320-pixel plane in under 2 ms (the median of 60)', async () => {
    const meter = new MotionMeter();
    const costs: number[] = [];
    for (let k = 0; k < 61; k++) {
      const measured = await meter.measure(frame(k % 2 === 0 ? STILL : SQUARE, k));
      if (k > 0) {
        costs.push(measured.costMs);
      }
    }
    costs.sort((a, b) => a - b);
    const median = costs[Math.floor(costs.length / 2)];
    console.log(
      `motion meter, whole 1080p I420 frames on 320 × 180 in Node: median ${median.toFixed(3)} ms, ` +
        `95th percentile ${costs[Math.ceil(0.95 * costs.length) - 1].toFixed(3)} ms`,
    );
    expect(median).toBeLessThan(2);
  });
});

describe('isMotionFrame', () => {
  it('tells a frame whose pixels can be copied from one that cannot', () => {
    expect(isMotionFrame(frame(STILL))).toBe(true);
    expect(isMotionFrame({ timestamp: 0, displayWidth: 1, displayHeight: 1 })).toBe(false);
  });
});
