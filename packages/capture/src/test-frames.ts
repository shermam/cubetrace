// Synthetic camera frames for the tests of the motion meter and of the capture worker's sync check
// (T2.5, T2.8): frames whose pixels the test draws, which `copyTo` copies out as a `VideoFrame` does,
// the planes packed one after the other, and a seeded random generator for their noise. Not part of
// the package's API.
import type { CopyRect, MotionFrame } from './motion';

/** A square of `size` pixels of `value`, its top-left corner at (`x`, `y`). */
export interface Square {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly value: number;
}

/** A luma plane of `width × height` pixels of `background`, with the squares drawn over it. */
export function lumaPlane(
  width: number,
  height: number,
  background: number,
  squares: readonly Square[] = [],
): Uint8Array {
  const plane = new Uint8Array(width * height).fill(background);
  for (const square of squares) {
    for (let y = square.y; y < Math.min(height, square.y + square.size); y++) {
      plane.fill(
        square.value,
        y * width + square.x,
        y * width + Math.min(width, square.x + square.size),
      );
    }
  }
  return plane;
}

/**
 * A camera frame: an I420 frame whose luma is `pixels` (one byte per pixel; its chroma grey), or,
 * for the RGB formats, one whose `pixels` are four bytes per pixel in the format's order. `format`
 * null plays a frame whose pixels cannot be copied (`copyTo` rejects, as Chrome's does).
 */
export class SyntheticFrame implements MotionFrame {
  readonly duration = null;
  readonly visibleRect: CopyRect;
  closed = false;
  rotation?: number;
  flip?: boolean;

  constructor(
    readonly timestamp: number,
    readonly pixels: Uint8Array,
    readonly displayWidth = 1920,
    readonly displayHeight = 1080,
    readonly format: string | null = 'I420',
  ) {
    this.visibleRect = { x: 0, y: 0, width: displayWidth, height: displayHeight };
  }

  allocationSize(options: { rect?: CopyRect } = {}): number {
    const rect = options.rect ?? this.visibleRect;
    return this.#rgb() ? rect.width * rect.height * 4 : rect.width * rect.height * 1.5;
  }

  copyTo(
    destination: Uint8Array,
    options: { rect?: CopyRect } = {},
  ): Promise<{ offset: number; stride: number }[]> {
    if (this.closed) {
      return Promise.reject(new DOMException('The frame is closed.', 'InvalidStateError'));
    }
    if (this.format === null) {
      return Promise.reject(new DOMException('No pixel format.', 'NotSupportedError'));
    }
    const rect = options.rect ?? this.visibleRect;
    if (destination.byteLength < this.allocationSize(options)) {
      return Promise.reject(new TypeError('The destination is too small.'));
    }
    const bytes = this.#rgb() ? 4 : 1;
    const stride = rect.width * bytes;
    for (let row = 0; row < rect.height; row++) {
      const from = ((rect.y + row) * this.displayWidth + rect.x) * bytes;
      destination.set(this.pixels.subarray(from, from + stride), row * stride);
    }
    if (bytes === 4) {
      return Promise.resolve([{ offset: 0, stride }]);
    }
    // The chroma planes, grey.
    const lumaBytes = rect.width * rect.height;
    const chroma = (rect.width / 2) * (rect.height / 2);
    destination.fill(128, lumaBytes, lumaBytes + 2 * chroma);
    return Promise.resolve([
      { offset: 0, stride: rect.width },
      { offset: lumaBytes, stride: rect.width / 2 },
      { offset: lumaBytes + chroma, stride: rect.width / 2 },
    ]);
  }

  close(): void {
    this.closed = true;
  }

  #rgb(): boolean {
    return this.format !== null && /^(RGB|BGR)/.test(this.format);
  }
}

/**
 * A seeded pseudo-random generator (mulberry32): numbers in [0, 1), the same sequence for the same
 * seed, so that the synthetic pictures and series of the tests never change.
 */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
