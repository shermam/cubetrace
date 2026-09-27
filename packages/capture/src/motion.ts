// Motion for the clapperboard (docs/PLAN.md, T2.5 and T2.8): how much the picture inside the framing
// rectangle changed since the previous frame, on the two frames' luma downscaled to 320 pixels wide
// for a wide region (the whole frame: more pixels on the cube) or 160 for a tight one, in two
// measures. The changed area, the share of the pixels whose luma moved by more than 12 levels, is the
// clapperboard's energy: a hand turning a face changes a compact area by far more than that, while a
// camera's noise and a flicker of the light change every pixel a little, and count for nothing; the
// mean absolute difference, the measure of T2.5, is kept for the diagnostics. clapperboard.ts reads
// the changed area around each of the cube's turns. While a sync check runs, the capture worker
// measures every frame with a `MotionMeter`, which reads the frame's own luma plane with
// `VideoFrame.copyTo` (a copy, about half a millisecond at 1080p) rather than drawing it into a
// canvas (10 to 20 ms a frame in Chromium's software canvas, docs/TOOLCHAIN.md). Plain TypeScript:
// the frame is read through the methods a `VideoFrame` has, so the tests give synthetic frames, and
// no browser global is touched.
import { isWideFraming, type FramingRect } from './framing';
import type { MotionMeterInfo } from './protocol';
import type { LumaImage } from './sharpness';

/** Width of the luma plane the motion is computed on, for a tight framing rectangle. */
export const MOTION_WIDTH = 160;

/**
 * Width of the luma plane for a wide region (`isWideFraming`: the whole frame, or more than 60% of
 * it), where the cube is small: twice as many pixels across it.
 */
export const MOTION_WIDE_WIDTH = 320;

/** A pixel of the plane has changed when its luma moved by more than this many levels (of 255). */
export const CHANGE_LEVELS = 12;

/**
 * Points averaged per side of each pixel of the luma plane: 2 × 2 of the pixels of its block, spread
 * over it, which halves the noise of a single point at a fraction of the cost of averaging the whole
 * block (a 12 × 12 block at 1080p).
 */
export const MOTION_POINTS = 2;

/**
 * The mean absolute difference of two luma planes of the same size, in luma levels (0 to 255): 0 for
 * the same picture; a turn of the cube in the framing rectangle gives a few levels. Throws a
 * RangeError for planes of different sizes.
 */
export function motionEnergy(previous: ArrayLike<number>, current: ArrayLike<number>): number {
  return compareLuma(previous, current).mean;
}

/**
 * The changed area of two luma planes of the same size: the share of their pixels (0 to 1) whose luma
 * differs by more than `levels`. Noise and a flicker of the light, which move every pixel a little,
 * leave it near 0; a hand and a face turning in a part of the picture raise it by that part. Throws a
 * RangeError for planes of different sizes.
 */
export function changedArea(
  previous: ArrayLike<number>,
  current: ArrayLike<number>,
  levels = CHANGE_LEVELS,
): number {
  return compareLuma(previous, current, levels).changed;
}

/** Two luma planes compared: their mean absolute difference and their changed area. */
export interface LumaDifference {
  /** In luma levels (`motionEnergy`). */
  readonly mean: number;
  /** A share of the pixels, 0 to 1 (`changedArea`). */
  readonly changed: number;
}

/**
 * `motionEnergy` and `changedArea` of two planes in one pass. Throws a RangeError for planes of
 * different sizes; two empty planes differ by nothing.
 */
export function compareLuma(
  previous: ArrayLike<number>,
  current: ArrayLike<number>,
  levels = CHANGE_LEVELS,
): LumaDifference {
  const length = current.length;
  if (previous.length !== length) {
    throw new RangeError(
      `Planes of ${String(previous.length)} and ${String(length)} samples cannot be compared.`,
    );
  }
  if (length === 0) {
    return { mean: 0, changed: 0 };
  }
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < length; i++) {
    const difference = current[i] - previous[i];
    const absolute = difference < 0 ? -difference : difference;
    sum += absolute;
    if (absolute > levels) {
      changed += 1;
    }
  }
  return { mean: sum / length, changed: changed / length };
}

/** A size in pixels. */
export interface PlaneSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size of the luma plane of a region (`w` × `h` pixels): `width` pixels wide (160 by default), or
 * the region's own width when it is narrower, and the height in proportion (at least 1).
 */
export function motionSize(
  region: { readonly w: number; readonly h: number },
  width = MOTION_WIDTH,
): PlaneSize {
  const across = Math.max(1, Math.min(width, Math.round(region.w)));
  return {
    width: across,
    height: Math.max(1, Math.round((across * region.h) / Math.max(1, region.w))),
  };
}

/**
 * The size of the luma plane of `region` of frames of `frame` size: 320 pixels wide when the region
 * is wide (`isWideFraming`: more than 60% of the frame, the whole frame by default), else 160.
 */
export function motionPlaneSize(region: FramingRect, frame: PlaneSize): PlaneSize {
  return motionSize(region, isWideFraming(region, frame) ? MOTION_WIDE_WIDTH : MOTION_WIDTH);
}

/**
 * How a pixel's luma is read: `luma`, one byte (the Y plane of a YUV frame); `rgbx` and `bgrx`, four
 * bytes of red, green and blue (or blue, green and red) and alpha or padding, weighted as BT.601 luma.
 */
export type PixelKind = 'luma' | 'rgbx' | 'bgrx';

/**
 * A region of a plane in a buffer: its size in pixels, where its first row begins (`offset`, bytes),
 * the bytes from a row to the next (`stride`), and how its pixels are read.
 */
export interface PlaneRegion extends PlaneSize {
  readonly offset: number;
  readonly stride: number;
  readonly kind: PixelKind;
}

/**
 * Downscales a region of a plane into a luma plane of the size given, each of its pixels the average
 * of `points × points` pixels spread over its block of the region. The positions are computed once,
 * for one geometry (`fits` says whether another region has it).
 */
export class LumaDownscaler {
  readonly width: number;
  readonly height: number;
  readonly #region: PlaneRegion;
  readonly #points: number;
  /** Per output column, the byte offset in a row of each of its points. */
  readonly #columns: Int32Array;
  /** Per output row, the byte offset of the row of each of its points. */
  readonly #rows: Int32Array;

  constructor(region: PlaneRegion, size: PlaneSize, points = MOTION_POINTS) {
    if (region.width < 1 || region.height < 1 || size.width < 1 || size.height < 1) {
      throw new RangeError('A plane to downscale, and its downscale, need at least one pixel.');
    }
    this.width = size.width;
    this.height = size.height;
    this.#region = region;
    this.#points = Math.max(1, Math.round(points));
    const n = this.#points;
    const bytes = region.kind === 'luma' ? 1 : 4;
    this.#columns = new Int32Array(size.width * n);
    for (let x = 0; x < size.width; x++) {
      for (let k = 0; k < n; k++) {
        const column = spread(x, k, n, region.width, size.width);
        this.#columns[x * n + k] = column * bytes;
      }
    }
    this.#rows = new Int32Array(size.height * n);
    for (let y = 0; y < size.height; y++) {
      for (let j = 0; j < n; j++) {
        const row = spread(y, j, n, region.height, size.height);
        this.#rows[y * n + j] = region.offset + row * region.stride;
      }
    }
  }

  /** Whether `region` has this downscaler's geometry. */
  fits(region: PlaneRegion): boolean {
    const own = this.#region;
    return (
      region.width === own.width &&
      region.height === own.height &&
      region.offset === own.offset &&
      region.stride === own.stride &&
      region.kind === own.kind
    );
  }

  /** The luma plane of the region of `data`, into `out` (`width × height` bytes, row after row). */
  downscale(data: Uint8Array, out: Uint8Array): void {
    const kind = this.#region.kind;
    if (kind === 'luma') {
      this.#downscaleLuma(data, out);
    } else {
      // BT.601 weights of red, green and blue out of 256, in the order of the pixel's bytes.
      this.#downscalePixels(data, out, kind === 'bgrx' ? 29 : 77, kind === 'bgrx' ? 77 : 29);
    }
  }

  #downscaleLuma(data: Uint8Array, out: Uint8Array): void {
    if (this.#points === 2) {
      this.#downscaleLuma2(data, out);
      return;
    }
    const n = this.#points;
    const count = n * n;
    const half = count >> 1;
    const columns = this.#columns;
    const rows = this.#rows;
    const width = this.width;
    for (let y = 0; y < this.height; y++) {
      const rowBase = y * n;
      const outBase = y * width;
      for (let x = 0; x < width; x++) {
        const columnBase = x * n;
        let sum = 0;
        for (let j = 0; j < n; j++) {
          const row = rows[rowBase + j];
          for (let k = 0; k < n; k++) {
            sum += data[row + columns[columnBase + k]];
          }
        }
        out[outBase + x] = Math.floor((sum + half) / count);
      }
    }
  }

  /**
   * `#downscaleLuma` for 2 × 2 points (`MOTION_POINTS`), unrolled: the same sums and rounding, in a
   * third of the time (T2.8 measures a 320-pixel plane for the whole frame: 57,600 pixels).
   */
  #downscaleLuma2(data: Uint8Array, out: Uint8Array): void {
    const columns = this.#columns;
    const rows = this.#rows;
    const width = this.width;
    for (let y = 0; y < this.height; y++) {
      const top = rows[2 * y];
      const bottom = rows[2 * y + 1];
      const outBase = y * width;
      for (let x = 0; x < width; x++) {
        const left = columns[2 * x];
        const right = columns[2 * x + 1];
        out[outBase + x] =
          (data[top + left] + data[top + right] + data[bottom + left] + data[bottom + right] + 2) >>
          2;
      }
    }
  }

  #downscalePixels(data: Uint8Array, out: Uint8Array, first: number, third: number): void {
    const n = this.#points;
    const divisor = n * n * 256;
    const half = divisor >> 1;
    const columns = this.#columns;
    const rows = this.#rows;
    const width = this.width;
    for (let y = 0; y < this.height; y++) {
      const rowBase = y * n;
      const outBase = y * width;
      for (let x = 0; x < width; x++) {
        const columnBase = x * n;
        let sum = 0;
        for (let j = 0; j < n; j++) {
          const row = rows[rowBase + j];
          for (let k = 0; k < n; k++) {
            const at = row + columns[columnBase + k];
            sum += first * data[at] + 150 * data[at + 1] + third * data[at + 2];
          }
        }
        out[outBase + x] = Math.floor((sum + half) / divisor);
      }
    }
  }
}

/** A rectangle as `VideoFrame.copyTo` takes it, in the frame's coded pixels. */
export interface CopyRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The parts of a `VideoFrame` the motion meter reads: its pixel format (null when its pixels cannot
 * be copied out), its size as shown and the visible part of its coded pixels, and the copy.
 */
export interface MotionFrame {
  readonly format: string | null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: CopyRect | null;
  /** Set on a frame to be shown turned (newer browsers); its planes are not turned. */
  readonly rotation?: number;
  /** Set on a frame to be shown mirrored (newer browsers); its planes are not mirrored. */
  readonly flip?: boolean;
  allocationSize(options?: { rect?: CopyRect }): number;
  copyTo(
    destination: Uint8Array,
    options?: { rect?: CopyRect },
  ): Promise<readonly { readonly offset: number; readonly stride: number }[]>;
}

/** Whether `frame` has what the motion meter reads (a `VideoFrame` has). */
export function isMotionFrame<F extends object>(frame: F): frame is F & MotionFrame {
  const value = frame as Partial<Record<keyof MotionFrame, unknown>>;
  return (
    typeof value.copyTo === 'function' &&
    typeof value.allocationSize === 'function' &&
    typeof value.displayWidth === 'number' &&
    typeof value.displayHeight === 'number' &&
    'format' in frame &&
    'visibleRect' in frame
  );
}

/** How each pixel format's first plane is read: the 8-bit YUV formats' luma, the RGB formats' pixels. */
const PIXEL_KINDS: Readonly<Record<string, PixelKind>> = {
  I420: 'luma',
  I420A: 'luma',
  I422: 'luma',
  I422A: 'luma',
  I444: 'luma',
  I444A: 'luma',
  NV12: 'luma',
  RGBA: 'rgbx',
  RGBX: 'rgbx',
  BGRA: 'bgrx',
  BGRX: 'bgrx',
};

/** One frame measured. */
export interface MotionMeasure {
  /**
   * The mean absolute luma difference from the frame measured before it (`motionEnergy`); null for
   * the first frame, and for the first after the plane's size changed.
   */
  readonly mean: number | null;
  /** The changed area against that frame (`changedArea`), 0 to 1; null when `mean` is. */
  readonly changed: number | null;
  /** The time `measure` took, ms: the copy (or the drawing) and the arithmetic. */
  readonly costMs: number;
  /**
   * How the frame was read: the same object from one frame to the next until something in it
   * changes (the frames' size, format or path).
   */
  readonly meter: MotionMeterInfo;
}

export interface MotionMeterOptions<F> {
  /** The clock of `costMs`, in ms; `performance.now()` by default. */
  readonly now?: () => number;
  /**
   * Draws the region of a frame the meter cannot copy (a pixel format it does not read, or a frame
   * to be shown turned or mirrored) into a luma plane of `size`, as a canvas does; null when it
   * cannot. Without it such frames are refused.
   */
  readonly draw?: (frame: F, region: FramingRect, size: PlaneSize) => LumaImage | null;
}

/**
 * Measures the motion of a camera's frames in a region (docs/PLAN.md, T2.5 and T2.8): the framing
 * rectangle in the frames' pixels as shown (T2.1), or the whole frame for null, clamped to each
 * frame. For every frame it copies the region's first plane out of the frame (the luma of a YUV
 * frame), downscales it (`LumaDownscaler`) to 320 pixels wide for a wide region or 160 for a tight
 * one (`motionPlaneSize`), and compares it with the previous frame's (`compareLuma`): the mean
 * absolute difference and the changed area. Its buffers are made once and kept while the frames keep
 * their size.
 */
export class MotionMeter<F extends MotionFrame = MotionFrame> {
  readonly #rect: FramingRect | null;
  readonly #now: () => number;
  readonly #draw: MotionMeterOptions<F>['draw'];
  #buffer: Uint8Array | null = null;
  #downscaler: LumaDownscaler | null = null;
  #previous: Uint8Array | null = null;
  #current: Uint8Array | null = null;
  #info: MotionMeterInfo | null = null;

  constructor(rect: FramingRect | null = null, options: MotionMeterOptions<F> = {}) {
    this.#rect = rect;
    this.#now = options.now ?? (() => performance.now());
    this.#draw = options.draw;
  }

  /**
   * The motion of `frame` against the frame measured before it, what measuring it cost, and how it
   * was read. Rejects when the frame's pixels cannot be read (no format the meter copies and no
   * `draw`).
   */
  async measure(frame: F): Promise<MotionMeasure> {
    const start = this.#now();
    const region = regionOf(this.#rect, frame);
    const size = motionPlaneSize(region, {
      width: frame.displayWidth,
      height: frame.displayHeight,
    });
    const kind = frame.format === null ? undefined : PIXEL_KINDS[frame.format];
    const shown = (frame.rotation ?? 0) % 360 === 0 && frame.flip !== true;
    const copied = kind !== undefined && shown;
    const luma = copied
      ? await this.#copy(frame, region, kind, size)
      : this.#drawn(frame, region, size);
    const difference = this.#compare(luma);
    const costMs = this.#now() - start;
    return {
      mean: difference?.mean ?? null,
      changed: difference?.changed ?? null,
      costMs,
      meter: this.#describe(frame, region, size, copied ? 'copy' : 'draw'),
    };
  }

  /** The region's luma plane, copied out of the frame and downscaled to `size`. */
  async #copy(
    frame: F,
    region: FramingRect,
    kind: PixelKind,
    size: PlaneSize,
  ): Promise<Uint8Array> {
    const rect = codedRect(frame, region);
    const bytes = frame.allocationSize({ rect });
    if (this.#buffer === null || this.#buffer.byteLength < bytes) {
      this.#buffer = new Uint8Array(bytes);
    }
    const buffer = this.#buffer;
    const layout = await frame.copyTo(buffer, { rect });
    const first = layout.at(0);
    if (first === undefined) {
      throw new Error(`The frame's pixels (${String(frame.format)}) came without a plane.`);
    }
    const plane: PlaneRegion = {
      width: rect.width,
      height: rect.height,
      offset: first.offset,
      stride: first.stride,
      kind,
    };
    let downscaler = this.#downscaler;
    if (
      downscaler?.fits(plane) !== true ||
      downscaler.width !== size.width ||
      downscaler.height !== size.height
    ) {
      downscaler = new LumaDownscaler(plane, size);
      this.#downscaler = downscaler;
    }
    const out = this.#plane(downscaler.width * downscaler.height);
    downscaler.downscale(buffer, out);
    return out;
  }

  /** The region's luma plane, drawn by `draw` at `size`. */
  #drawn(frame: F, region: FramingRect, size: PlaneSize): Uint8Array {
    const format = frame.format ?? 'no pixel format';
    const why =
      (frame.rotation ?? 0) % 360 !== 0 || frame.flip === true
        ? `a frame to be shown turned or mirrored (${format})`
        : `frames of ${format}`;
    if (this.#draw === undefined) {
      throw new Error(`The motion meter cannot read ${why}.`);
    }
    const image = this.#draw(frame, region, size);
    if (image === null) {
      throw new Error(`The motion meter cannot read ${why}: this browser draws no frame.`);
    }
    const out = this.#plane(image.luma.length);
    out.set(image.luma);
    return out;
  }

  /** A plane of `length` bytes to fill: the one the previous frame's plane is not. */
  #plane(length: number): Uint8Array {
    if (this.#current?.length !== length) {
      this.#current = new Uint8Array(length);
    }
    return this.#current;
  }

  /** `luma` against the previous plane, which it then becomes; null without one of its size. */
  #compare(luma: Uint8Array): LumaDifference | null {
    const previous = this.#previous;
    const difference =
      previous !== null && previous.length === luma.length ? compareLuma(previous, luma) : null;
    // The two planes swap: the next frame is written over the older one.
    this.#previous = luma;
    this.#current = previous;
    return difference;
  }

  /** How this frame was read: the object of the frame before when nothing changed. */
  #describe(
    frame: F,
    region: FramingRect,
    size: PlaneSize,
    path: MotionMeterInfo['path'],
  ): MotionMeterInfo {
    const info = this.#info;
    if (
      info?.format === frame.format &&
      info.path === path &&
      info.frameWidth === frame.displayWidth &&
      info.frameHeight === frame.displayHeight &&
      info.region.x === region.x &&
      info.region.y === region.y &&
      info.region.w === region.w &&
      info.region.h === region.h &&
      info.planeWidth === size.width &&
      info.planeHeight === size.height
    ) {
      return info;
    }
    const next: MotionMeterInfo = {
      format: frame.format,
      path,
      frameWidth: frame.displayWidth,
      frameHeight: frame.displayHeight,
      region: { x: region.x, y: region.y, w: region.w, h: region.h },
      planeWidth: size.width,
      planeHeight: size.height,
      changeLevels: CHANGE_LEVELS,
    };
    this.#info = next;
    return next;
  }
}

/**
 * The region measured in a frame: the rectangle clamped to the frame as shown, or the whole frame
 * for null or a rectangle outside it (framed on frames of another size, such as a phone turned).
 */
export function regionOf(rect: FramingRect | null, frame: MotionFrame): FramingRect {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const whole = { x: 0, y: 0, w: width, h: height };
  if (rect === null) {
    return whole;
  }
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  const w = Math.min(width, rect.x + rect.w) - x;
  const h = Math.min(height, rect.y + rect.h) - y;
  return w >= 2 && h >= 2 ? { x, y, w, h } : whole;
}

/**
 * A region of the frame as shown, in its coded pixels for `copyTo`: scaled to the visible rectangle
 * (the same size unless the frame is shown stretched) and aligned to even pixels, which the planes
 * of 4:2:0 frames need, inside the visible rectangle.
 */
export function codedRect(frame: MotionFrame, region: FramingRect): CopyRect {
  const visible = frame.visibleRect ?? {
    x: 0,
    y: 0,
    width: frame.displayWidth,
    height: frame.displayHeight,
  };
  const sx = visible.width / Math.max(1, frame.displayWidth);
  const sy = visible.height / Math.max(1, frame.displayHeight);
  const [x, width] = evenSpan(visible.x, visible.width, region.x * sx, region.w * sx);
  const [y, height] = evenSpan(visible.y, visible.height, region.y * sy, region.h * sy);
  return { x, y, width, height };
}

/** `[start, length]` of a span within `[origin, origin + extent]`, on even pixels, at least 2 long. */
function evenSpan(origin: number, extent: number, start: number, length: number): [number, number] {
  const limit = origin + extent;
  const first = Math.max(origin, 2 * Math.floor((origin + start) / 2));
  const last = Math.min(limit, 2 * Math.floor((origin + start + length) / 2));
  return last - first >= 2
    ? [first, last - first]
    : [origin, Math.max(2, 2 * Math.floor(extent / 2))];
}

/** The source index of point `k` (of `n`) of output pixel `index`, spread over its block. */
function spread(index: number, k: number, n: number, source: number, target: number): number {
  const at = Math.floor(((index + (k + 0.5) / n) * source) / target);
  return Math.max(0, Math.min(source - 1, at));
}
