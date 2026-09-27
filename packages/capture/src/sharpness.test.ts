import { describe, expect, it } from 'vitest';

import type { Canvas2D, FramingRect } from './index';
import { LumaSampler, lumaFromRgba, sampleSize, sharpness } from './index';

const W = 320;
const H = 180;

/** A picture made pixel by pixel. */
function picture(width: number, height: number, at: (x: number, y: number) => number): Uint8Array {
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      luma[y * width + x] = at(x, y);
    }
  }
  return luma;
}

/** A box blur of the given radius, edges clamped: what a lens out of focus roughly does. */
function blur(luma: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return picture(width, height, (x, y) => {
    let sum = 0;
    let count = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = Math.min(width - 1, Math.max(0, x + dx));
        const py = Math.min(height - 1, Math.max(0, y + dy));
        sum += luma[py * width + px];
        count++;
      }
    }
    return Math.round(sum / count);
  });
}

/** Squares of 20 pixels, dark and light: a cube's stickers, roughly. */
const checkers = picture(W, H, (x, y) =>
  (Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? 40 : 220,
);

describe('sharpness', () => {
  it('is 0 on a flat picture, dark or bright, and on one too small to have a Laplacian', () => {
    expect(
      sharpness(
        picture(W, H, () => 0),
        W,
        H,
      ),
    ).toBe(0);
    expect(
      sharpness(
        picture(W, H, () => 128),
        W,
        H,
      ),
    ).toBe(0);
    expect(
      sharpness(
        picture(W, H, () => 255),
        W,
        H,
      ),
    ).toBe(0);
    expect(sharpness(new Uint8Array(4), 2, 2)).toBe(0);
    expect(sharpness(new Uint8Array(3), 3, 3)).toBe(0); // fewer bytes than pixels
  });

  it('is 0 on an even gradient, whose Laplacian is flat', () => {
    expect(
      sharpness(
        picture(256, 100, (x) => x),
        256,
        100,
      ),
    ).toBe(0);
  });

  it('is high on sharp edges and drops as they are blurred', () => {
    const sharp = sharpness(checkers, W, H);
    const soft = sharpness(blur(checkers, W, H, 1), W, H);
    const softer = sharpness(blur(checkers, W, H, 3), W, H);
    expect(sharp).toBeGreaterThan(1000);
    expect(soft).toBeLessThan(sharp / 2);
    expect(softer).toBeLessThan(soft / 2);
    expect(softer).toBeGreaterThan(0);
  });

  it('is the variance of the Laplacian: one bright pixel on black', () => {
    // 5 × 5, a single 100 in the middle: over the 3 × 3 interior the Laplacian is -400 at the
    // centre, 100 at its four neighbours and 0 at the corners: mean 0, variance 200000 / 9.
    const luma = picture(5, 5, (x, y) => (x === 2 && y === 2 ? 100 : 0));
    expect(sharpness(luma, 5, 5)).toBeCloseTo(200_000 / 9, 6);
  });

  it('reads the luma of RGBA pixels with the BT.601 weights', () => {
    const rgba = new Uint8ClampedArray([
      ...[0, 0, 0, 255],
      ...[255, 255, 255, 255],
      ...[255, 0, 0, 255],
      ...[0, 255, 0, 255],
      ...[0, 0, 255, 255],
      ...[0, 138, 0, 255],
    ]);
    expect(Array.from(lumaFromRgba(rgba, 6, 1))).toEqual([0, 255, 77, 149, 29, 81]);
  });
});

/** A canvas that draws a picture given by `paint` and records how it was drawn to. */
class FakeCanvas implements Canvas2D<string> {
  readonly draws: { source: string; args: number[] }[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly paint: (x: number, y: number) => number,
  ) {}

  drawImage(source: string, ...args: number[]): void {
    this.draws.push({ source, args });
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray } {
    const data = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const value = this.paint(sx + x, sy + y);
        data.set([value, value, value, 255], (y * sw + x) * 4);
      }
    }
    return { data };
  }
}

describe('LumaSampler', () => {
  function sampler(paint: (x: number, y: number) => number = () => 0): {
    sampler: LumaSampler<string>;
    canvases: FakeCanvas[];
  } {
    const canvases: FakeCanvas[] = [];
    return {
      canvases,
      sampler: new LumaSampler<string>((width, height) => {
        const canvas = new FakeCanvas(width, height, paint);
        canvases.push(canvas);
        return canvas;
      }),
    };
  }

  it('draws the region 320 pixels wide, its height in proportion, and reads its luma', () => {
    const { sampler: luma, canvases } = sampler((x, y) => (x + y) % 256);
    const region: FramingRect = { x: 480, y: 270, w: 960, h: 540 };

    const image = luma.sample('frame 1', region);

    expect(sampleSize(region)).toEqual({ width: 320, height: 180 });
    expect(canvases.map((canvas) => [canvas.width, canvas.height])).toEqual([[320, 180]]);
    expect(canvases[0].draws).toEqual([
      { source: 'frame 1', args: [480, 270, 960, 540, 0, 0, 320, 180] },
    ]);
    expect(image?.width).toBe(320);
    expect(image?.height).toBe(180);
    expect(image?.luma.length).toBe(320 * 180);
    expect(image?.luma[181]).toBe(181);
  });

  it('keeps its canvas while the proportions stay, and makes a new one when they change', () => {
    const { sampler: luma, canvases } = sampler();
    luma.sample('a', { x: 0, y: 0, w: 1920, h: 1080 });
    luma.sample('b', { x: 100, y: 100, w: 960, h: 540 });
    expect(canvases).toHaveLength(1);
    luma.sample('c', { x: 0, y: 0, w: 1080, h: 1080 });
    expect(canvases.map((canvas) => [canvas.width, canvas.height])).toEqual([
      [320, 180],
      [320, 320],
    ]);
    // A portrait frame, 1080 × 1920.
    expect(sampleSize({ x: 0, y: 0, w: 1080, h: 1920 })).toEqual({ width: 320, height: 569 });
  });

  it('measures the sharpness of what it drew; null without a canvas', () => {
    const { sampler: sharp } = sampler((x, y) =>
      (Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? 40 : 220,
    );
    const { sampler: flat } = sampler(() => 90);
    const region = { x: 0, y: 0, w: 1920, h: 1080 };
    expect(sharp.measure('frame', region)).toBeCloseTo(sharpness(checkers, W, H), 6);
    expect(flat.measure('frame', region)).toBe(0);

    const none = new LumaSampler<string>(() => null);
    expect(none.sample('frame', region)).toBeNull();
    expect(none.measure('frame', region)).toBeNull();
  });
});
