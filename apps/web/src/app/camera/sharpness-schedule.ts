/** The sharpness meter measures at most this often: twice a second (docs/PLAN.md, T2.7). */
export const SHARPNESS_INTERVAL_MS = 500;

/**
 * When the sharpness meter measures a frame of the preview (T2.7). A measurement draws the frame
 * into a canvas on the page's main thread (about 10 ms in headless Chromium, up to 30), and the
 * cube's moves that arrive meanwhile wait for it: T2.4 saw moves held back by tens of milliseconds.
 * So it measures at most once per {@link SHARPNESS_INTERVAL_MS} of the camera's clock, and none
 * while it is held: the Camera preview holds it while an attempt is armed or solving, when the time
 * of a move is the solve's (the first move starts it, the last one stops it).
 */
export class SharpnessSchedule {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs = SHARPNESS_INTERVAL_MS) {}

  /**
   * Whether the frame shown at `timeMs` (the camera's clock, in ms) is measured: never while
   * `held`, else when the last one measured is at least the interval before it. A clock that goes
   * back (a new stream in the same preview) starts the schedule again.
   */
  due(timeMs: number, held: boolean): boolean {
    if (timeMs < this.last) {
      this.last = Number.NEGATIVE_INFINITY;
    }
    if (held || timeMs - this.last < this.intervalMs) {
      return false;
    }
    this.last = timeMs;
    return true;
  }
}
