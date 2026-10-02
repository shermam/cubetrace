// The cube's orientation for the clip viewer's 3D cube (docs/PLAN.md T3.8): the quaternions of an
// attempt's gyro file (docs/DATA-MODEL.md §11) interpolated at a host time, taken relative to a
// reference sample, and carried from the cube's own frame into cubing.js's. Pure arithmetic on
// `[x, y, z, w]` tuples, so that the tests run it on known rotations, the end-to-end suite computes
// what the viewer must show from the file the app wrote, and the viewer's follow loop pays one
// binary search and one slerp per frame.
import type { GyroJson } from './gyro';

/** A unit quaternion as the gyro file keeps it: `x, y, z, w`, the scalar last. */
export type Quat = readonly [number, number, number, number];

/** A vector of the cube's or cubing.js's frame. */
export type Vec3 = readonly [number, number, number];

/** No rotation: the cube as the player shows it by default, white up and green in front. */
export const IDENTITY: Quat = [0, 0, 0, 1];

/**
 * The basis change from the cube's frame to cubing.js's. The cube reports its orientation in its own
 * right-handed frame, +X through the red face, +Y through the blue face, +Z through the white face
 * (docs/DATA-MODEL.md §11, as the driver documents it); cubing.js's 3D puzzle has +X through R (red),
 * +Y through U (white) and +Z through F (green). A vector `(x, y, z)` of the cube's frame is
 * `(x, z, −y)` in cubing.js's: a rotation of −90° about X, and an orientation `q` of the cube is
 * `r · q · r⁻¹` with `r` that rotation ({@link toPlayerFrame}). The mapping comes from the driver's
 * documentation and not yet from a real recording ("After T3.8" in docs/MANUAL-TESTS.md): a correction
 * from the first real file changes this constant alone.
 */
export const CUBE_TO_PLAYER: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/**
 * Two orientations closer than this are shown alike: `1 − |a · b|`, which is about an eighth of the
 * angle between them squared, in radians; 1e-9 is a hundredth of a degree, far under what a frame
 * can show, and far over the noise of the arithmetic.
 */
export const SAME_ORIENTATION = 1e-9;

/** The product `a · b`: the rotation `b` followed by `a`. */
export function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** The inverse rotation of a unit quaternion. */
export function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** `q` scaled to unit length; the identity for a zero quaternion. */
export function normalize(q: Quat): Quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return length === 0 ? IDENTITY : [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** The dot product of two quaternions: the cosine of half the angle between the orientations. */
export function dot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** The rotation of `degrees` about `axis` (normalized here), as a quaternion. */
export function fromAxisAngle(axis: Vec3, degrees: number): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  const half = (degrees * Math.PI) / 360;
  const s = Math.sin(half) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/** `v` rotated by `q`: `q · v · q⁻¹`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 · (q.xyz × v); v' = v + w · t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** The angle between two orientations, in degrees: 0 for `q` and `−q`, which are one orientation. */
export function angleBetween(a: Quat, b: Quat): number {
  const cosine = Math.min(1, Math.abs(dot(a, b)));
  return (2 * Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Whether `a` and `b` are the same orientation to {@link SAME_ORIENTATION} (`q` and `−q` are). The
 * dot product is taken over the lengths, so that a quaternion a little off unit length (the file's
 * five decimals) is the same orientation as itself.
 */
export function sameOrientation(a: Quat, b: Quat): boolean {
  const lengths = Math.hypot(a[0], a[1], a[2], a[3]) * Math.hypot(b[0], b[1], b[2], b[3]);
  return lengths > 0 && 1 - Math.abs(dot(a, b)) / lengths < SAME_ORIENTATION;
}

/**
 * Spherical linear interpolation from `a` (`t` = 0) to `b` (`t` = 1) along the shorter arc: `q` and
 * `−q` are one orientation, so `b` is negated when it is nearer that way. Nearly equal orientations
 * are interpolated linearly, where the arc's formula divides by a vanishing sine.
 */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cosine = dot(a, b);
  let to: Quat = b;
  if (cosine < 0) {
    cosine = -cosine;
    to = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (cosine > 0.9995) {
    return normalize([
      a[0] + (to[0] - a[0]) * t,
      a[1] + (to[1] - a[1]) * t,
      a[2] + (to[2] - a[2]) * t,
      a[3] + (to[3] - a[3]) * t,
    ]);
  }
  const theta = Math.acos(cosine);
  const sine = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sine;
  const wb = Math.sin(t * theta) / sine;
  return [
    a[0] * wa + to[0] * wb,
    a[1] * wa + to[1] * wb,
    a[2] * wa + to[2] * wb,
    a[3] * wa + to[3] * wb,
  ];
}

/** An orientation of the cube's frame as cubing.js's puzzle object must be rotated to show it. */
export function toPlayerFrame(q: Quat): Quat {
  return multiply(multiply(CUBE_TO_PLAYER, q), conjugate(CUBE_TO_PLAYER));
}

/**
 * A reflection of the orientation shown (docs/PLAN.md T3.10), named by the viewer's own axes, which
 * are cubing.js's: `left-right` reflects across the plane normal to X (a tilt to the right shows as
 * one to the left), `up-down` across the plane normal to Y, `front-back` across the plane normal to
 * Z, and `all` across all three; `none` shows the orientation as it is. A camera behind the cube, or
 * a cube whose gyroscope's axes differ from the documented ones, needs one.
 */
export type Mirror = 'none' | 'left-right' | 'up-down' | 'front-back' | 'all';

/** The mirrors, in the order the viewer's select lists them. */
export const MIRRORS: readonly Mirror[] = ['none', 'left-right', 'up-down', 'front-back', 'all'];

/** Whether `value` names a mirror. */
export function isMirror(value: unknown): value is Mirror {
  return typeof value === 'string' && (MIRRORS as readonly string[]).includes(value);
}

/**
 * The rotation `q` seen in a mirror: a reflection across a plane turns a rotation about an axis `n`
 * by `θ` into one about the reflected axis by `−θ`, so that across the plane normal to X the
 * quaternion `(x, y, z, w)` becomes `(x, −y, −z, w)`, across the plane normal to Y `(−x, y, −z, w)`,
 * across the plane normal to Z `(−x, −y, z, w)`, and across all three the conjugate, `(−x, −y, −z,
 * w)`. A mirror applied twice gives `q` back.
 */
export function mirrored(q: Quat, mirror: Mirror): Quat {
  switch (mirror) {
    case 'none':
      return q;
    case 'left-right':
      return [q[0], -q[1], -q[2], q[3]];
    case 'up-down':
      return [-q[0], q[1], -q[2], q[3]];
    case 'front-back':
      return [-q[0], -q[1], q[2], q[3]];
    case 'all':
      return conjugate(q);
  }
}

/**
 * The orientation shown for the cube's `q`: relative to `reference`, the sample the cube is upright
 * at in the player (`reference⁻¹ · q`, the rotation since then in the cube's own frame, so that it
 * tilts and turns as the hands did whatever the gyro's yaw reference), or raw without one; either in
 * cubing.js's frame ({@link toPlayerFrame}), and seen in `mirror` ({@link mirrored}, in those axes:
 * reflecting the relative orientation before the frame change by the corresponding plane of the
 * cube's frame would give the same).
 */
export function shownOrientation(q: Quat, reference: Quat | null, mirror: Mirror = 'none'): Quat {
  return mirrored(
    toPlayerFrame(reference === null ? q : multiply(conjugate(reference), q)),
    mirror,
  );
}

/**
 * The samples of a gyro file as the viewer reads them: the host time of each (`t0HostMs` plus the
 * intervals), the quaternions flat as in the file but of unit length, and whether the file begins
 * later than the attempt's window.
 */
export interface GyroTrack {
  readonly hostMs: Float64Array;
  readonly q: Float64Array;
  readonly truncatedStart: boolean;
}

/**
 * The track of `file`: the sample times summed in tenths of a millisecond, as they were written,
 * and the quaternions normalized, since the file keeps five decimals (a length off by up to 4e-5,
 * which would make a sample differ from itself in {@link sameOrientation} and make the rotations
 * drift from unit length); a zero quaternion reads as the identity.
 */
export function gyroTrack(file: GyroJson): GyroTrack {
  const count = file.dtMs.length;
  const hostMs = new Float64Array(count);
  const q = new Float64Array(count * 4);
  let tenths = 0;
  for (let k = 0; k < count; k++) {
    tenths += Math.round(file.dtMs[k] * 10);
    hostMs[k] = file.t0HostMs + tenths / 10;
    const at = k * 4;
    const unit = normalize([file.q[at], file.q[at + 1], file.q[at + 2], file.q[at + 3]]);
    q[at] = unit[0];
    q[at + 1] = unit[1];
    q[at + 2] = unit[2];
    q[at + 3] = unit[3];
  }
  return { hostMs, q, truncatedStart: file.truncatedStart };
}

/** Sample `k` of the track. */
export function sampleAt(track: GyroTrack, k: number): Quat {
  const at = k * 4;
  return [track.q[at], track.q[at + 1], track.q[at + 2], track.q[at + 3]];
}

/** The index of the first sample at or after `hostMs` (binary search); the count when none is. */
export function firstSampleAtOrAfter(track: GyroTrack, hostMs: number): number {
  let low = 0;
  let high = track.hostMs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (track.hostMs[middle] < hostMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * The cube's orientation at `hostMs`: the sample there, or the slerp between the two samples around
 * it; the last sample after the file's span; the first sample before it, unless the file begins
 * later than the attempt's window (`truncatedStart`), when nothing is known before its first sample:
 * null, as for an empty track.
 */
export function orientationAt(track: GyroTrack, hostMs: number): Quat | null {
  const count = track.hostMs.length;
  if (count === 0) {
    return null;
  }
  const next = firstSampleAtOrAfter(track, hostMs);
  if (next === 0) {
    return track.truncatedStart && hostMs < track.hostMs[0] ? null : sampleAt(track, 0);
  }
  if (next === count) {
    return sampleAt(track, count - 1);
  }
  const before = track.hostMs[next - 1];
  const after = track.hostMs[next];
  const t = after === before ? 1 : (hostMs - before) / (after - before);
  return slerp(sampleAt(track, next - 1), sampleAt(track, next), t);
}

/**
 * The reference the orientation is shown against from `hostMs` on: the orientation there, or the
 * file's first sample when nothing is known there (a truncated file before its first sample); null
 * for an empty track.
 */
export function referenceAt(track: GyroTrack, hostMs: number): Quat | null {
  return orientationAt(track, hostMs) ?? (track.hostMs.length === 0 ? null : sampleAt(track, 0));
}

/** What the 3D cube does to show the state after move `at` ({@link cubeStep}). */
export type CubeStep = 'keep' | 'animate' | 'rebuild';

/**
 * How the 3D cube, showing the state after move `shown` (−1 before the first), gets to the state
 * after move `at`: nothing when it is there; the next move alone, animated, when exactly one move
 * passed and the time advanced on its own; else, after a seek or when the time passed more than one
 * move (or went back), the state rebuilt without animation.
 */
export function cubeStep(shown: number, at: number, seek: boolean): CubeStep {
  if (at === shown) {
    return 'keep';
  }
  return !seek && at === shown + 1 ? 'animate' : 'rebuild';
}
