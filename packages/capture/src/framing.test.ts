import { describe, expect, it } from 'vitest';

import {
  clampFraming,
  dragFraming,
  framingFor,
  framingPercent,
  fullFrame,
  grabAt,
  isFullFrame,
  minFramingSide,
  previewDeltaToFrame,
  previewToFrame,
} from './index';

const HD = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

describe('the framing rectangle', () => {
  it('is the full frame by default, and at least a tenth of the shorter side', () => {
    expect(fullFrame(HD)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(isFullFrame(fullFrame(PORTRAIT), PORTRAIT)).toBe(true);
    expect(isFullFrame({ x: 0, y: 0, w: 1920, h: 1079 }, HD)).toBe(false);
    expect(minFramingSide(HD)).toBe(108);
    expect(minFramingSide(PORTRAIT)).toBe(108);
    expect(minFramingSide({ width: 4, height: 3 })).toBe(1);
  });

  it('is clamped to whole pixels inside the frame, resized before it is moved in', () => {
    expect(clampFraming({ x: 10.4, y: 20.6, w: 300.5, h: 200.2 }, HD)).toEqual({
      x: 10,
      y: 21,
      w: 301,
      h: 200,
    });
    // Too far right and down: moved back in whole.
    expect(clampFraming({ x: 1800, y: 1000, w: 400, h: 300 }, HD)).toEqual({
      x: 1520,
      y: 780,
      w: 400,
      h: 300,
    });
    // Larger than the frame: the frame. Smaller than the minimum: the minimum.
    expect(clampFraming({ x: -50, y: -50, w: 5000, h: 5000 }, HD)).toEqual(fullFrame(HD));
    expect(clampFraming({ x: 100, y: 100, w: 3, h: 0 }, HD)).toEqual({
      x: 100,
      y: 100,
      w: 108,
      h: 108,
    });
    expect(clampFraming({ x: Number.NaN, y: 0, w: 10, h: 10 }, HD)).toEqual(fullFrame(HD));
    expect(clampFraming({ x: 0, y: 0, w: Infinity, h: 10 }, HD)).toEqual(fullFrame(HD));
  });

  it('is taken hold of by the nearest corner within the radius, else by its inside', () => {
    const rect = { x: 100, y: 100, w: 400, h: 300 };
    expect(grabAt(rect, { x: 103, y: 96 }, 20)).toBe('nw');
    expect(grabAt(rect, { x: 510, y: 90 }, 20)).toBe('ne');
    expect(grabAt(rect, { x: 95, y: 405 }, 20)).toBe('sw');
    expect(grabAt(rect, { x: 500, y: 400 }, 20)).toBe('se');
    expect(grabAt(rect, { x: 300, y: 250 }, 20)).toBe('move');
    expect(grabAt(rect, { x: 100, y: 250 }, 20)).toBe('move');
    expect(grabAt(rect, { x: 60, y: 60 }, 20)).toBeNull();
    expect(grabAt(rect, { x: 700, y: 250 }, 20)).toBeNull();
    // On a rectangle smaller than two radii, the nearest corner wins.
    const small = { x: 100, y: 100, w: 20, h: 20 };
    expect(grabAt(small, { x: 104, y: 103 }, 30)).toBe('nw');
    expect(grabAt(small, { x: 118, y: 119 }, 30)).toBe('se');
  });

  it('moves whole, stopping at the edges of the frame', () => {
    const rect = { x: 100, y: 100, w: 400, h: 300 };
    expect(dragFraming(rect, 'move', { x: 50, y: -20 }, HD)).toEqual({
      x: 150,
      y: 80,
      w: 400,
      h: 300,
    });
    expect(dragFraming(rect, 'move', { x: -500, y: 2000 }, HD)).toEqual({
      x: 0,
      y: 780,
      w: 400,
      h: 300,
    });
  });

  it('resizes from the corner held, the opposite corner staying, down to the minimum size', () => {
    const rect = { x: 100, y: 100, w: 400, h: 300 };
    expect(dragFraming(rect, 'se', { x: 100, y: 50 }, HD)).toEqual({
      x: 100,
      y: 100,
      w: 500,
      h: 350,
    });
    expect(dragFraming(rect, 'nw', { x: -40, y: 30 }, HD)).toEqual({
      x: 60,
      y: 130,
      w: 440,
      h: 270,
    });
    expect(dragFraming(rect, 'ne', { x: 20, y: -150 }, HD)).toEqual({
      x: 100,
      y: 0,
      w: 420,
      h: 400,
    });
    expect(dragFraming(rect, 'sw', { x: 380, y: -290 }, HD)).toEqual({
      x: 392,
      y: 100,
      w: 108,
      h: 108,
    });
    // Past the frame's edges: stops there.
    expect(dragFraming(rect, 'se', { x: 5000, y: 5000 }, HD)).toEqual({
      x: 100,
      y: 100,
      w: 1820,
      h: 980,
    });
    // Across the opposite corner: stops at the minimum size, where it was.
    expect(dragFraming(rect, 'nw', { x: 1000, y: 1000 }, HD)).toEqual({
      x: 392,
      y: 292,
      w: 108,
      h: 108,
    });
  });

  it('maps points and movements on the preview to frame pixels, mirrored or not', () => {
    const box = { width: 480, height: 270, mirrored: false };
    expect(previewToFrame({ x: 120, y: 135 }, box, HD)).toEqual({ x: 480, y: 540 });
    expect(previewToFrame({ x: 0, y: 0 }, box, HD)).toEqual({ x: 0, y: 0 });
    const mirrored = { ...box, mirrored: true };
    // The left edge seen on a mirrored preview is the frame's right edge.
    expect(previewToFrame({ x: 0, y: 0 }, mirrored, HD)).toEqual({ x: 1920, y: 0 });
    expect(previewToFrame({ x: 120, y: 135 }, mirrored, HD)).toEqual({ x: 1440, y: 540 });
    expect(previewDeltaToFrame({ x: 10, y: 5 }, box, HD)).toEqual({ x: 40, y: 20 });
    expect(previewDeltaToFrame({ x: 10, y: 5 }, mirrored, HD)).toEqual({ x: -40, y: 20 });
    // A portrait frame shown 270 wide.
    expect(
      previewToFrame({ x: 135, y: 240 }, { width: 270, height: 480, mirrored: false }, PORTRAIT),
    ).toEqual({ x: 540, y: 960 });
  });

  it('is drawn over the preview in percent of the frame', () => {
    expect(framingPercent({ x: 480, y: 270, w: 960, h: 540 }, HD)).toEqual({
      left: 25,
      top: 25,
      width: 50,
      height: 50,
    });
    expect(framingPercent(fullFrame(PORTRAIT), PORTRAIT)).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });

  it("is found among a camera's stored rectangles by frame size, scaled within an orientation", () => {
    const hd = { width: 1920, height: 1080, rect: { x: 480, y: 270, w: 960, h: 540 } };
    const portrait = { width: 1080, height: 1920, rect: { x: 0, y: 960, w: 1080, h: 960 } };
    expect(framingFor([], HD)).toEqual(fullFrame(HD));
    expect(framingFor([hd, portrait], HD)).toEqual(hd.rect);
    expect(framingFor([hd, portrait], PORTRAIT)).toEqual(portrait.rect);
    // The same camera opened at 1280×720: the 1080p rectangle, scaled.
    expect(framingFor([hd, portrait], { width: 1280, height: 720 })).toEqual({
      x: 320,
      y: 180,
      w: 640,
      h: 360,
    });
    // A phone turned to landscape with only a portrait rectangle stored: the full frame.
    expect(framingFor([portrait], HD)).toEqual(fullFrame(HD));
    // The last one stored for a size wins; a stored rectangle is clamped to the frame.
    const newer = { ...hd, rect: { x: 1800, y: 0, w: 400, h: 300 } };
    expect(framingFor([hd, newer], HD)).toEqual({ x: 1520, y: 0, w: 400, h: 300 });
  });
});
