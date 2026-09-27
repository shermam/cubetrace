// Pickup detection from the cube's gyroscope (docs/DATA-MODEL.md §3, `pickup`): the orientation
// changed beyond a threshold after the attempt was armed.

/** A unit quaternion `[x, y, z, w]`, as the cube's `gyro` events carry it. */
export type Quaternion = readonly [number, number, number, number];

/**
 * How far the cube must turn, from its orientation when the attempt was armed, to count as picked
 * up. 15° is well above the jitter of a cube lying still (a few tenths of a degree) and below the
 * tilt of any real pickup.
 */
export const PICKUP_THRESHOLD_DEG = 15;

/**
 * The angle, in degrees (0 to 180), of the rotation that takes orientation `a` to orientation `b`:
 * `2·acos(|a·b|)` for unit quaternions (both are normalized first; `q` and `−q` are the same
 * orientation). 0 when either has no length.
 */
export function rotationDeg(a: Quaternion, b: Quaternion): number {
  const norms = Math.hypot(...a) * Math.hypot(...b);
  if (norms === 0 || !Number.isFinite(norms)) {
    return 0;
  }
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / norms;
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}
