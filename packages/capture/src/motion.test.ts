import { describe, expect, it } from 'vitest';

import {
  LumaDownscaler,
  MOTION_POINTS,
  MOTION_WIDTH,
  MotionMeter,
  codedRect,
  isMotionFrame,
  motionEnergy,
  motionSize,
  regionOf,
  type PlaneRegion,
} from './motion';
import { SyntheticFrame, lumaPlane } from './test-frames';

const WIDTH = 1920;
const HEIGHT = 1080;

/** The still picture: a dark background. */
const STILL = lumaPlane(WIDTH, HEIGHT, 16);

/**
 * The same picture with a bright square of 120 pixels: ten 12-pixel blocks of the 160-pixel plane
 * each way, so exactly 100 of its 160 × 90 pixels change, by 239 levels.
 */
const SQUARE = lumaPlane(WIDTH, HEIGHT, 16, [{ x: 600, y: 360, size: 120, value: 255 }]);
const SQUARE_ENERGY = (100 * 239) / (160 * 90);

function frame(pixels: Uint8Array, timestamp = 0): SyntheticFrame {
  return new SyntheticFrame(timestamp, pixels);
}

describe('motionEnergy', () => {
  it('is the mean absolute difference of two planes, 0 for the same picture', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    expect(motionEnergy(a, a)).toBe(0);
    expect(motionEnergy(a, new Uint8Array([13, 17, 33, 37]))).toBe(3);
    expect(motionEnergy(a, new Uint8Array([50, 20, 30, 40]))).toBe(10);
    expect(motionEnergy(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });

  it('refuses planes of different sizes', () => {
    expect(() => motionEnergy(new Uint8Array(4), new Uint8Array(6))).toThrow(RangeError);
  });
});

describe('motionSize', () => {
  it('is 160 pixels wide, or the region if narrower, the height in proportion', () => {
    expect(MOTION_WIDTH).toBe(160);
    expect(MOTION_POINTS).toBe(2);
    expect(motionSize({ w: 1920, h: 1080 })).toEqual({ width: 160, height: 90 });
    expect(motionSize({ w: 1080, h: 1920 })).toEqual({ width: 160, height: 284 });
    expect(motionSize({ w: 960, h: 840 })).toEqual({ width: 160, height: 140 });
    expect(motionSize({ w: 100, h: 50 })).toEqual({ width: 100, height: 50 });
    expect(motionSize({ w: 1920, h: 2 })).toEqual({ width: 160, height: 1 });
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
    expect((await meter.measure(frame(STILL))).energy).toBeNull();
    expect((await meter.measure(frame(STILL))).energy).toBe(0);
    expect((await meter.measure(frame(SQUARE))).energy).toBeCloseTo(SQUARE_ENERGY, 10);
    expect((await meter.measure(frame(SQUARE))).energy).toBe(0);
    expect((await meter.measure(frame(STILL))).energy).toBeCloseTo(SQUARE_ENERGY, 10);
  });

  it('sees only the framing rectangle', async () => {
    // A 960 × 480 rectangle whose plane is 160 × 80 (6 pixels a block); the square is outside it.
    const inside = new MotionMeter({ x: 960, y: 480, w: 960, h: 480 });
    await inside.measure(frame(STILL));
    expect((await inside.measure(frame(SQUARE))).energy).toBe(0);
    const around = new MotionMeter({ x: 480, y: 240, w: 960, h: 480 });
    await around.measure(frame(STILL));
    // The square covers 20 × 20 of its 160 × 80 pixels.
    expect((await around.measure(frame(SQUARE))).energy).toBeCloseTo((400 * 239) / 12_800, 10);
  });

  it('reads RGB frames by their luma', async () => {
    const rgba = (value: number): Uint8Array =>
      new Uint8Array(64 * 36 * 4).map((_, i) => (i % 4 === 3 ? 255 : value));
    const meter = new MotionMeter();
    const size = [64, 36] as const;
    await meter.measure(new SyntheticFrame(0, rgba(20), ...size, 'RGBA'));
    const energy = (await meter.measure(new SyntheticFrame(1, rgba(120), ...size, 'BGRX'))).energy;
    expect(energy).toBe(100);
  });

  it('starts again when the frames change size', async () => {
    const meter = new MotionMeter();
    await meter.measure(frame(STILL));
    const portrait = new SyntheticFrame(1, lumaPlane(HEIGHT, WIDTH, 16), HEIGHT, WIDTH);
    expect((await meter.measure(portrait)).energy).toBeNull();
    expect((await meter.measure(portrait)).energy).toBe(0);
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
    expect(second.energy).toBe(3);
    expect(drawn[0]).toEqual({
      region: { x: 0, y: 0, w: 960, h: 540 },
      size: { width: 160, height: 90 },
    });
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

  it('measures a 1080p frame in under 2 ms (the median of 60)', async () => {
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
      `motion meter, 1080p I420 in Node: median ${median.toFixed(3)} ms, ` +
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
