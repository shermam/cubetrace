import type { FramingRect } from './framing';

/**
 * The sharpness meter (docs/PLAN.md, T2.1; the design's §5): the variance of the Laplacian of the
 * luma of the framing rectangle, downscaled to 160 pixels wide. A sharp picture has strong edges,
 * so its Laplacian (the second derivative) swings widely; blur, a covered lens or darkness flatten
 * it towards 0. The number depends on the scene as much as on the camera, so the threshold between
 * "good" and "soft" is a setting.
 *
 * The metric is plain arithmetic, tested in Node; drawing a frame into a canvas goes through
 * `Canvas2D`, which an `OffscreenCanvas` implements in the browser and a fake in the tests.
 */

/**
 * Width of the downscaled picture the metric is computed on: 160 pixels since T2.7 (320 before),
 * which keeps the page's main thread busy for less time while it draws (the app measures on the
 * main thread, docs/TOOLCHAIN.md, "Timer layout").
 */
export const SHARPNESS_WIDTH = 160;

/**
 * The default threshold between "good" and "soft". Calibrated on Chrome's fake camera (a green
 * test pattern with a moving disc and a clock, `--use-fake-device-for-media-stream`): drawn 160
 * pixels wide, over four runs of 12 to 15 s it measures 78–198 on the whole frame, 88–279 on a
 * centred half and 48–183 on a centred square, and 2.5–17 once blurred by 1 pixel at 160 pixels
 * wide (about 12 at 1080p); black frames measure 0. 20 lies between the two, as it did at 320 pixels
 * wide; the owner sets it per camera in Settings (docs/TOOLCHAIN.md, "packages/capture").
 */
export const SHARPNESS_THRESHOLD_DEFAULT = 20;

/** An 8-bit luma picture, one byte per pixel, row after row. */
export interface LumaImage {
  readonly luma: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * The variance of the 4-neighbour Laplacian (`up + down + left + right − 4 × centre`) over the
 * pixels that have four neighbours; 0 for a picture narrower or lower than 3 pixels.
 */
export function sharpness(luma: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3 || luma.length < width * height) {
    return 0;
  }
  let sum = 0;
  let sumOfSquares = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const laplacian = luma[i - width] + luma[i + width] + luma[i - 1] + luma[i + 1] - 4 * luma[i];
      sum += laplacian;
      sumOfSquares += laplacian * laplacian;
    }
  }
  const count = (width - 2) * (height - 2);
  const mean = sum / count;
  return Math.max(0, sumOfSquares / count - mean * mean);
}

/** The luma of RGBA pixels (canvas `ImageData`), with the BT.601 weights in integer arithmetic. */
export function lumaFromRgba(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const luma = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2] + 128) >> 8;
  }
  return luma;
}

/** The size a region is drawn at for the metric: `width` wide, its height in proportion. */
export function sampleSize(
  region: FramingRect,
  width = SHARPNESS_WIDTH,
): { readonly width: number; readonly height: number } {
  return { width, height: Math.max(1, Math.round((width * region.h) / region.w)) };
}

/** The part of a 2D canvas context that the sampler uses; `Source` is what it draws from. */
export interface Canvas2D<Source> {
  drawImage(
    source: Source,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): { readonly data: ArrayLike<number> };
}

/** Makes a canvas of `width` × `height`; null where the browser has none. */
export type CanvasFactory<Source> = (width: number, height: number) => Canvas2D<Source> | null;

/**
 * Draws a region of a frame (a playing `<video>`, a `VideoFrame`) into a small canvas,
 * {@link SHARPNESS_WIDTH} pixels wide (or `width`), and reads its luma. The canvas is made once and
 * made again only when the region's proportions change.
 */
export class LumaSampler<Source> {
  private canvas: {
    readonly width: number;
    readonly height: number;
    readonly context: Canvas2D<Source>;
  } | null = null;

  constructor(
    private readonly createCanvas: CanvasFactory<Source>,
    private readonly width = SHARPNESS_WIDTH,
  ) {}

  /** The luma of `region` (source pixels) of `source`, downscaled; null without a canvas. */
  sample(source: Source, region: FramingRect): LumaImage | null {
    const { width, height } = sampleSize(region, this.width);
    let canvas = this.canvas;
    if (canvas === null || canvas.width !== width || canvas.height !== height) {
      const context = this.createCanvas(width, height);
      if (context === null) {
        return null;
      }
      canvas = { width, height, context };
      this.canvas = canvas;
    }
    canvas.context.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, width, height);
    const pixels = canvas.context.getImageData(0, 0, width, height).data;
    return { luma: lumaFromRgba(pixels, width, height), width, height };
  }

  /** The sharpness of `region` of `source`; null without a canvas. */
  measure(source: Source, region: FramingRect): number | null {
    const image = this.sample(source, region);
    return image === null ? null : sharpness(image.luma, image.width, image.height);
  }
}

/**
 * The browser's canvas for the sampler: an `OffscreenCanvas` whose pixels stay in memory for
 * reading (`willReadFrequently`); null where there is none. Touches the browser only when called.
 */
export function offscreenCanvas(width: number, height: number): Canvas2D<CanvasImageSource> | null {
  if (typeof OffscreenCanvas !== 'function') {
    return null;
  }
  return new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
}

/** A sampler that draws `<video>` elements and `VideoFrame`s into an `OffscreenCanvas`. */
export function browserLumaSampler(): LumaSampler<CanvasImageSource> {
  return new LumaSampler(offscreenCanvas);
}
