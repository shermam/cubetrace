/**
 * The framing rectangle (docs/PLAN.md, T2.1): the part of the camera's picture where the solve
 * happens, which the model is trained on. It is kept in source pixels, the pixels of the frames as
 * the camera delivers them (a phone held upright delivers portrait frames, 1080×1920, whatever its
 * track settings say), drawn over the preview, moved and resized by dragging, and stored per camera.
 * In phase 2 it is metadata (`mode: 'full'` in session.json): the video keeps the whole frame.
 * Plain arithmetic: no DOM.
 */

/** A rectangle in the frames' pixels: its top-left corner `x`, `y`, `w` wide and `h` high. */
export interface FramingRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The size of the frames, in pixels. */
export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A corner of the rectangle, in the frame: north-west is its top-left corner. */
export type FramingHandle = 'nw' | 'ne' | 'sw' | 'se';

/** What a pointer took hold of: a corner, to resize, or the inside, to move. */
export type FramingGrab = FramingHandle | 'move';

/** The rectangle is never narrower or lower than this fraction of the frame's shorter side. */
export const FRAMING_MIN_FRACTION = 0.1;

/** The default framing: the whole frame. */
export function fullFrame(size: FrameSize): FramingRect {
  return { x: 0, y: 0, w: size.width, h: size.height };
}

export function isFullFrame(rect: FramingRect, size: FrameSize): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === size.width && rect.h === size.height;
}

/** The smallest width and height of the rectangle in frames of `size`: at least 1 pixel. */
export function minFramingSide(size: FrameSize): number {
  const side = Math.round(Math.min(size.width, size.height) * FRAMING_MIN_FRACTION);
  return Math.max(1, Math.min(side, size.width, size.height));
}

/**
 * `rect` in whole pixels, at least the smallest size, and inside the frame: its size is limited
 * first, then it is moved in. A rectangle with a coordinate that is not a finite number becomes
 * the full frame.
 */
export function clampFraming(rect: FramingRect, size: FrameSize): FramingRect {
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) {
    return fullFrame(size);
  }
  const min = minFramingSide(size);
  const w = clamp(Math.round(rect.w), min, size.width);
  const h = clamp(Math.round(rect.h), min, size.height);
  return {
    x: clamp(Math.round(rect.x), 0, size.width - w),
    y: clamp(Math.round(rect.y), 0, size.height - h),
    w,
    h,
  };
}

/**
 * What a pointer at `point` (frame pixels) takes hold of: the nearest corner within `radius`
 * (frame pixels), else the inside of the rectangle, else nothing.
 */
export function grabAt(rect: FramingRect, point: Point, radius: number): FramingGrab | null {
  const corners: readonly (readonly [FramingHandle, number, number])[] = [
    ['nw', rect.x, rect.y],
    ['ne', rect.x + rect.w, rect.y],
    ['sw', rect.x, rect.y + rect.h],
    ['se', rect.x + rect.w, rect.y + rect.h],
  ];
  let nearest: FramingHandle | null = null;
  let nearestDistance = radius;
  for (const [handle, x, y] of corners) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= nearestDistance) {
      nearest = handle;
      nearestDistance = distance;
    }
  }
  if (nearest !== null) {
    return nearest;
  }
  const inside =
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h;
  return inside ? 'move' : null;
}

/**
 * `start` after a pointer that took hold of `grab` moved by `delta` (frame pixels): moved whole
 * (stopping at the frame's edges), or resized from the corner it holds, the opposite corner
 * staying where it is (stopping at the edges and at the smallest size).
 */
export function dragFraming(
  start: FramingRect,
  grab: FramingGrab,
  delta: Point,
  size: FrameSize,
): FramingRect {
  const from = clampFraming(start, size);
  if (grab === 'move') {
    return clampFraming({ ...from, x: from.x + delta.x, y: from.y + delta.y }, size);
  }
  const min = minFramingSide(size);
  let left = from.x;
  let top = from.y;
  let right = from.x + from.w;
  let bottom = from.y + from.h;
  if (grab === 'nw' || grab === 'sw') {
    left = clamp(left + delta.x, 0, right - min);
  } else {
    right = clamp(right + delta.x, left + min, size.width);
  }
  if (grab === 'nw' || grab === 'ne') {
    top = clamp(top + delta.y, 0, bottom - min);
  } else {
    bottom = clamp(bottom + delta.y, top + min, size.height);
  }
  return clampFraming({ x: left, y: top, w: right - left, h: bottom - top }, size);
}

/**
 * The preview as it is drawn: its box in CSS pixels, which shows the whole frame, and whether it is
 * mirrored (a front camera's preview is, like a mirror; the frames themselves never are).
 */
export interface PreviewBox {
  readonly width: number;
  readonly height: number;
  readonly mirrored: boolean;
}

/**
 * A point of the preview, in CSS pixels from the top-left corner of its box as seen, in frame
 * pixels. On a mirrored preview the left edge seen is the frame's right edge.
 */
export function previewToFrame(point: Point, box: PreviewBox, size: FrameSize): Point {
  const x = (point.x / box.width) * size.width;
  return { x: box.mirrored ? size.width - x : x, y: (point.y / box.height) * size.height };
}

/** A movement on the preview, in CSS pixels, in frame pixels. */
export function previewDeltaToFrame(delta: Point, box: PreviewBox, size: FrameSize): Point {
  const x = (delta.x / box.width) * size.width;
  return { x: box.mirrored ? -x : x, y: (delta.y / box.height) * size.height };
}

/**
 * Where `rect` lies over the preview, in percent of the frame: CSS `left`, `top`, `width` and
 * `height` inside a box that shows the whole frame (a mirrored preview mirrors the box, so the
 * percentages are the same).
 */
export function framingPercent(
  rect: FramingRect,
  size: FrameSize,
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  return {
    left: (rect.x / size.width) * 100,
    top: (rect.y / size.height) * 100,
    width: (rect.w / size.width) * 100,
    height: (rect.h / size.height) * 100,
  };
}

/** A framing rectangle stored for a camera, with the size of the frames it was drawn on. */
export interface StoredFraming {
  readonly width: number;
  readonly height: number;
  readonly rect: FramingRect;
}

/**
 * The framing for frames of `size`, from the rectangles stored for a camera: the one stored for
 * that size; else the last one stored for frames of the same orientation, scaled (a camera opened at
 * 1280×720 after being framed at 1920×1080); else the full frame (a phone turned from portrait to
 * landscape: the picture turned, so the rectangle means nothing there).
 */
export function framingFor(stored: readonly StoredFraming[], size: FrameSize): FramingRect {
  const exact = stored.findLast(
    (entry) => entry.width === size.width && entry.height === size.height,
  );
  if (exact !== undefined) {
    return clampFraming(exact.rect, size);
  }
  const turned = stored.findLast((entry) => landscape(entry) === landscape(size));
  if (turned === undefined) {
    return fullFrame(size);
  }
  const sx = size.width / turned.width;
  const sy = size.height / turned.height;
  return clampFraming(
    { x: turned.rect.x * sx, y: turned.rect.y * sy, w: turned.rect.w * sx, h: turned.rect.h * sy },
    size,
  );
}

function landscape(size: FrameSize): boolean {
  return size.width >= size.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
