// Motion energy for the clapperboard (docs/PLAN.md, T2.5): how much the picture inside the framing
// rectangle changed since the previous frame, as the mean absolute difference of the two frames'
// luma, downscaled to 160 pixels wide. A turn of the cube makes it jump above the level of the still
// picture; clapperboard.ts finds those jumps and matches them to the cube's moves. While a sync check
// runs, the capture worker measures every frame with a `MotionMeter`, which reads the frame's own
// luma plane with `VideoFrame.copyTo` (a copy, about half a millisecond at 1080p) rather than drawing
// it into a canvas (10 to 20 ms a frame in Chromium's software canvas, docs/TOOLCHAIN.md). Plain
// TypeScript: the frame is read through the methods a `VideoFrame` has, so the tests give synthetic
// frames, and no browser global is touched.
import type { FramingRect } from './framing';
import type { LumaImage } from './sharpness';

/** Width of the luma plane the motion energy is computed on. */
export const MOTION_WIDTH = 160;

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
  const length = current.length;
  if (previous.length !== length) {
    throw new RangeError(
      `Planes of ${String(previous.length)} and ${String(length)} samples cannot be compared.`,
    );
  }
  if (length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const difference = current[i] - previous[i];
    sum += difference < 0 ? -difference : difference;
  }
  return sum / length;
}

/** A size in pixels. */
export interface PlaneSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size of the luma plane of a region (`w` × `h` pixels): 160 pixels wide, or the region's own
 * width when it is narrower, and the height in proportion (at least 1).
 */
export function motionSize(region: { readonly w: number; readonly h: number }): PlaneSize {
  const width = Math.max(1, Math.min(MOTION_WIDTH, Math.round(region.w)));
  return { width, height: Math.max(1, Math.round((width * region.h) / Math.max(1, region.w))) };
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
   * the first frame, and for the first after the region's size changed.
   */
  readonly energy: number | null;
  /** The time `measure` took, ms: the copy (or the drawing) and the arithmetic. */
  readonly costMs: number;
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
 * Measures the motion energy of a camera's frames in a region (docs/PLAN.md, T2.5): the framing
 * rectangle in the frames' pixels as shown (T2.1), or the whole frame for null, clamped to each
 * frame. For every frame it copies the region's first plane out of the frame (the luma of a YUV
 * frame), downscales it to 160 pixels wide (`LumaDownscaler`) and compares it with the previous
 * frame's (`motionEnergy`). Its buffers are made once and kept while the frames keep their size.
 */
export class MotionMeter<F extends MotionFrame = MotionFrame> {
  readonly #rect: FramingRect | null;
  readonly #now: () => number;
  readonly #draw: MotionMeterOptions<F>['draw'];
  #buffer: Uint8Array | null = null;
  #downscaler: LumaDownscaler | null = null;
  #previous: Uint8Array | null = null;
  #current: Uint8Array | null = null;

  constructor(rect: FramingRect | null = null, options: MotionMeterOptions<F> = {}) {
    this.#rect = rect;
    this.#now = options.now ?? (() => performance.now());
    this.#draw = options.draw;
  }

  /**
   * The motion energy of `frame` against the frame measured before it, and what measuring it cost.
   * Rejects when the frame's pixels cannot be read (no format the meter copies and no `draw`).
   */
  async measure(frame: F): Promise<MotionMeasure> {
    const start = this.#now();
    const region = regionOf(this.#rect, frame);
    const kind = frame.format === null ? undefined : PIXEL_KINDS[frame.format];
    const shown = (frame.rotation ?? 0) % 360 === 0 && frame.flip !== true;
    const luma =
      kind !== undefined && shown
        ? await this.#copy(frame, region, kind)
        : this.#drawn(frame, region);
    const energy = this.#compare(luma);
    return { energy, costMs: this.#now() - start };
  }

  /** The region's luma plane, copied out of the frame and downscaled. */
  async #copy(frame: F, region: FramingRect, kind: PixelKind): Promise<Uint8Array> {
    const rect = codedRect(frame, region);
    const size = frame.allocationSize({ rect });
    if (this.#buffer === null || this.#buffer.byteLength < size) {
      this.#buffer = new Uint8Array(size);
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
    if (downscaler?.fits(plane) !== true) {
      downscaler = new LumaDownscaler(plane, motionSize({ w: region.w, h: region.h }));
      this.#downscaler = downscaler;
    }
    const out = this.#plane(downscaler.width * downscaler.height);
    downscaler.downscale(buffer, out);
    return out;
  }

  /** The region's luma plane, drawn by `draw`. */
  #drawn(frame: F, region: FramingRect): Uint8Array {
    const format = frame.format ?? 'no pixel format';
    const why =
      (frame.rotation ?? 0) % 360 !== 0 || frame.flip === true
        ? `a frame to be shown turned or mirrored (${format})`
        : `frames of ${format}`;
    if (this.#draw === undefined) {
      throw new Error(`The motion meter cannot read ${why}.`);
    }
    const image = this.#draw(frame, region, motionSize({ w: region.w, h: region.h }));
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

  /** The energy of `luma` against the previous plane, which it then becomes. */
  #compare(luma: Uint8Array): number | null {
    const previous = this.#previous;
    const energy =
      previous !== null && previous.length === luma.length ? motionEnergy(previous, luma) : null;
    // The two planes swap: the next frame is written over the older one.
    this.#previous = luma;
    this.#current = previous;
    return energy;
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
