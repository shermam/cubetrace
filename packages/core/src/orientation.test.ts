import { describe, expect, it } from 'vitest';

import type { GyroJson } from './gyro';
import {
  CUBE_TO_PLAYER,
  IDENTITY,
  MIRRORS,
  type Mirror,
  type Quat,
  type Vec3,
  angleBetween,
  conjugate,
  cubeStep,
  firstSampleAtOrAfter,
  fromAxisAngle,
  gyroTrack,
  isMirror,
  mirrored,
  multiply,
  normalize,
  orientationAt,
  referenceAt,
  rotate,
  sameOrientation,
  sampleAt,
  shownOrientation,
  slerp,
  toPlayerFrame,
} from './orientation';

/** The cube's axes (docs/DATA-MODEL.md §11) and cubing.js's. */
const RED: Vec3 = [1, 0, 0];
const BLUE: Vec3 = [0, 1, 0];
const WHITE: Vec3 = [0, 0, 1];
const PLAYER_X: Vec3 = [1, 0, 0];
const PLAYER_Y: Vec3 = [0, 1, 0];
const PLAYER_Z: Vec3 = [0, 0, 1];

function expectSame(actual: Quat, expected: Quat, what?: string): void {
  expect(sameOrientation(actual, expected), `${what ?? 'orientation'}: ${String(actual)}`).toBe(
    true,
  );
}

function expectVector(actual: Vec3, expected: Vec3): void {
  for (const k of [0, 1, 2]) {
    expect(actual[k]).toBeCloseTo(expected[k], 9);
  }
}

/** A gyro file with samples at `times` (host ms) and the quaternions given. */
function file(times: readonly number[], q: readonly Quat[], truncatedStart = false): GyroJson {
  return {
    schema: 1,
    session: 'f0d9c4d2-8f3e-4b5d-9d9c-6f7a0a2f1d10',
    index: 1,
    app: { version: '0.4.0', commit: 'abc1234' },
    t0HostMs: times[0],
    dtMs: times.map((t, k) => (k === 0 ? 0 : t - times[k - 1])),
    q: q.flat(),
    v: null,
    truncatedStart,
  };
}

describe('quaternion arithmetic', () => {
  it('rotates vectors: 90° about Z takes X to Y, and the inverse takes it back', () => {
    const q = fromAxisAngle([0, 0, 1], 90);
    expectVector(rotate(q, [1, 0, 0]), [0, 1, 0]);
    expectVector(rotate(conjugate(q), [0, 1, 0]), [1, 0, 0]);
    expectVector(rotate(multiply(q, q), [1, 0, 0]), [-1, 0, 0]);
  });

  it('composes: a · b is b first, then a', () => {
    const aboutZ = fromAxisAngle([0, 0, 1], 90);
    const aboutX = fromAxisAngle([1, 0, 0], 90);
    // X → (about Z) Y → (about X) Z.
    expectVector(rotate(multiply(aboutX, aboutZ), [1, 0, 0]), [0, 0, 1]);
    // X → (about X) X → (about Z) Y.
    expectVector(rotate(multiply(aboutZ, aboutX), [1, 0, 0]), [0, 1, 0]);
    expectSame(multiply(aboutZ, conjugate(aboutZ)), IDENTITY);
  });

  it('measures angles, q and −q being one orientation, and normalizes', () => {
    const q = fromAxisAngle([1, 1, 0], 40);
    const negated: Quat = [-q[0], -q[1], -q[2], -q[3]];
    expect(angleBetween(q, IDENTITY)).toBeCloseTo(40, 9);
    expect(angleBetween(q, negated)).toBeCloseTo(0, 9);
    expect(sameOrientation(q, negated)).toBe(true);
    expect(sameOrientation(q, fromAxisAngle([1, 1, 0], 40.1))).toBe(false);
    expect(sameOrientation(q, fromAxisAngle([1, 1, 0], 40.0001))).toBe(true);
    expect(normalize([0, 0, 0, 2])).toEqual([0, 0, 0, 1]);
    expect(normalize([0, 0, 0, 0])).toEqual(IDENTITY);
  });

  it('slerps along the shorter arc, at the ends and half-way, and between near-equal orientations', () => {
    const a = IDENTITY;
    const b = fromAxisAngle([0, 0, 1], 90);
    expectSame(slerp(a, b, 0), a);
    expectSame(slerp(a, b, 1), b);
    expectSame(slerp(a, b, 0.5), fromAxisAngle([0, 0, 1], 45));
    expectSame(slerp(a, b, 0.25), fromAxisAngle([0, 0, 1], 22.5));
    // 350° about Z is −10°: half-way is 5° back, not 175° forward.
    const back = fromAxisAngle([0, 0, 1], 350);
    expectSame(slerp(a, back, 0.5), fromAxisAngle([0, 0, 1], -5));
    expect(angleBetween(slerp(a, back, 0.5), a)).toBeCloseTo(5, 9);
    // Near-equal: the linear path, normalized.
    const near = fromAxisAngle([0, 0, 1], 0.5);
    const half = slerp(a, near, 0.5);
    expect(Math.hypot(...half)).toBeCloseTo(1, 12);
    expect(angleBetween(half, a)).toBeCloseTo(0.25, 6);
    // Equal orientations stay put, exactly enough to count as unchanged.
    expect(sameOrientation(slerp(b, b, 0.3), b)).toBe(true);
  });
});

describe('the frame mapping', () => {
  it('carries the cube’s axes into cubing.js’s: red → R (+X), white → U (+Y), blue → B (−Z)', () => {
    expectVector(rotate(CUBE_TO_PLAYER, RED), PLAYER_X);
    expectVector(rotate(CUBE_TO_PLAYER, WHITE), PLAYER_Y);
    expectVector(rotate(CUBE_TO_PLAYER, BLUE), [0, 0, -1]);
    // (x, y, z) → (x, z, −y), a proper rotation (the handedness is kept).
    expectVector(rotate(CUBE_TO_PLAYER, [1, 2, 3]), [1, 3, -2]);
    expect(Math.hypot(...CUBE_TO_PLAYER)).toBeCloseTo(1, 12);
  });

  it('turns a 90° turn about the cube’s white axis into one about cubing.js’s Y, and a tilt about red into one about X', () => {
    expectSame(toPlayerFrame(fromAxisAngle(WHITE, 90)), fromAxisAngle(PLAYER_Y, 90), 'white');
    expectSame(toPlayerFrame(fromAxisAngle(RED, 30)), fromAxisAngle(PLAYER_X, 30), 'red');
    expectSame(toPlayerFrame(fromAxisAngle(BLUE, 45)), fromAxisAngle([0, 0, -1], 45), 'blue');
    expectSame(toPlayerFrame(IDENTITY), IDENTITY, 'identity');
    // The same rotation, seen through the mapping: a vector carried over, then rotated in the
    // player's frame, is where the cube's rotation would have carried it.
    const tilt = fromAxisAngle([1, 2, 3], 70);
    const v: Vec3 = [0.3, -0.5, 0.8];
    expectVector(
      rotate(toPlayerFrame(tilt), rotate(CUBE_TO_PLAYER, v)),
      rotate(CUBE_TO_PLAYER, rotate(tilt, v)),
    );
    expectVector(rotate(toPlayerFrame(fromAxisAngle(WHITE, 90)), PLAYER_Z), [1, 0, 0]);
  });

  it('shows the orientation relative to the reference, so that the cube is upright at the reference, or raw', () => {
    const reference = fromAxisAngle([0, 0, 1], 123); // an arbitrary yaw at the clip's first frame
    expectSame(shownOrientation(reference, reference), IDENTITY);
    // A tilt of 30° about the cube's own red axis since the reference: a tilt about X in the player.
    const tilted = multiply(reference, fromAxisAngle(RED, 30));
    expectSame(shownOrientation(tilted, reference), fromAxisAngle(PLAYER_X, 30));
    // Raw: the sample as it is, in the player's frame.
    expectSame(shownOrientation(tilted, null), toPlayerFrame(tilted));
    expect(sameOrientation(shownOrientation(tilted, null), fromAxisAngle(PLAYER_X, 30))).toBe(
      false,
    );
  });
});

describe('the mirrors (T3.10)', () => {
  /** A tilt to the right: the top of the cube leaning towards the viewer's right, about Z. */
  const tiltRight = fromAxisAngle(PLAYER_Z, -30);
  const tiltLeft = fromAxisAngle(PLAYER_Z, 30);
  /** A tilt forward: the top coming towards the viewer, about X. */
  const tiltForward = fromAxisAngle(PLAYER_X, 30);
  /** A turn to the left about the vertical, as seen from above. */
  const turnLeft = fromAxisAngle(PLAYER_Y, 30);

  it('names five, none first', () => {
    expect(MIRRORS).toEqual(['none', 'left-right', 'up-down', 'front-back', 'all']);
    for (const mirror of MIRRORS) {
      expect(isMirror(mirror)).toBe(true);
    }
    for (const value of ['mirror', '', 'LEFT-RIGHT', 1, null, undefined, ['all']]) {
      expect(isMirror(value)).toBe(false);
    }
  });

  it('turns a tilt to the right into one to the left under left–right, and keeps a turn about the vertical', () => {
    expectSame(mirrored(tiltRight, 'left-right'), tiltLeft, 'the tilt');
    expectSame(mirrored(tiltLeft, 'left-right'), tiltRight, 'the other tilt');
    // The turn about the vertical goes the other way too: its axis is in the mirror's plane.
    expectSame(mirrored(turnLeft, 'left-right'), fromAxisAngle(PLAYER_Y, -30), 'the turn');
    // A tilt forward is about X, the plane's normal: it stays as it is.
    expectSame(mirrored(tiltForward, 'left-right'), tiltForward, 'the tilt forward');
  });

  it('reflects across the plane normal to Y under up–down, and to Z under front–back', () => {
    expectSame(mirrored(tiltForward, 'up-down'), fromAxisAngle(PLAYER_X, -30), 'forward, up–down');
    expectSame(mirrored(turnLeft, 'up-down'), turnLeft, 'the turn, up–down');
    expectSame(mirrored(tiltRight, 'up-down'), tiltLeft, 'right, up–down');
    expectSame(
      mirrored(tiltForward, 'front-back'),
      fromAxisAngle(PLAYER_X, -30),
      'forward, front–back',
    );
    expectSame(
      mirrored(turnLeft, 'front-back'),
      fromAxisAngle(PLAYER_Y, -30),
      'the turn, front–back',
    );
    expectSame(mirrored(tiltRight, 'front-back'), tiltRight, 'right, front–back');
  });

  it('is the conjugate under all, the identity under none, and its own inverse', () => {
    const q = normalize([0.1, 0.5, -0.3, 0.8]);
    expect(mirrored(q, 'all')).toEqual(conjugate(q));
    expect(mirrored(q, 'none')).toBe(q);
    for (const mirror of MIRRORS) {
      expectSame(mirrored(mirrored(q, mirror), mirror), q, `${mirror} twice`);
      expect(angleBetween(mirrored(q, mirror), IDENTITY)).toBeCloseTo(angleBetween(q, IDENTITY), 9);
    }
    // The components, as the contract writes them.
    expect(mirrored([1, 2, 3, 4], 'left-right')).toEqual([1, -2, -3, 4]);
    expect(mirrored([1, 2, 3, 4], 'up-down')).toEqual([-1, 2, -3, 4]);
    expect(mirrored([1, 2, 3, 4], 'front-back')).toEqual([-1, -2, 3, 4]);
    expect(mirrored([1, 2, 3, 4], 'all')).toEqual([-1, -2, -3, 4]);
  });

  it('applies to the orientation shown, after the reference and the frame change', () => {
    const reference = fromAxisAngle(WHITE, 123);
    // A tilt about the cube's red axis since the reference, which the player shows about its X:
    // mirrored left–right it stays; up–down it goes the other way.
    const tilted = multiply(reference, fromAxisAngle(RED, 30));
    expectSame(shownOrientation(tilted, reference), fromAxisAngle(PLAYER_X, 30));
    expectSame(shownOrientation(tilted, reference, 'none'), fromAxisAngle(PLAYER_X, 30));
    expectSame(shownOrientation(tilted, reference, 'left-right'), fromAxisAngle(PLAYER_X, 30));
    expectSame(shownOrientation(tilted, reference, 'up-down'), fromAxisAngle(PLAYER_X, -30));
    expectSame(shownOrientation(tilted, reference, 'all'), fromAxisAngle(PLAYER_X, -30));
    // Raw too: the sample in the player's frame, then the mirror.
    for (const mirror of MIRRORS as readonly Mirror[]) {
      expectSame(shownOrientation(tilted, null, mirror), mirrored(toPlayerFrame(tilted), mirror));
    }
    // Reflecting the relative orientation in the cube's frame by the corresponding plane gives the
    // same: the plane normal to the player's Y is the plane normal to the cube's white axis (+Z).
    const relative = fromAxisAngle([1, 2, 3], 40);
    const reflectedInCubeFrame: Quat = [-relative[0], -relative[1], relative[2], relative[3]];
    expectSame(
      shownOrientation(multiply(reference, relative), reference, 'up-down'),
      toPlayerFrame(reflectedInCubeFrame),
    );
  });
});

describe('the orientation over a gyro file', () => {
  const q0 = IDENTITY;
  const q1 = fromAxisAngle(WHITE, 90);
  const q2 = fromAxisAngle(WHITE, 90 + 60);
  const track = gyroTrack(file([1000, 1020, 1040.5], [q0, q1, q2]));

  it('sums the intervals in tenths of a millisecond, as they were written, and normalizes the samples', () => {
    expect(Array.from(track.hostMs)).toEqual([1000, 1020, 1040.5]);
    expect(track.truncatedStart).toBe(false);
    // The file's five decimals: a sample a little short of unit length is unit in the track, and the
    // same orientation as itself, twice over.
    const short: Quat = [0, 0, 0.70709, 0.70709];
    const rounded = gyroTrack(file([0, 20], [short, short]));
    expect(Math.hypot(...sampleAt(rounded, 0))).toBeCloseTo(1, 12);
    expect(sameOrientation(short, short)).toBe(true);
    expect(sameOrientation(orientationAt(rounded, 10) ?? IDENTITY, sampleAt(rounded, 1))).toBe(
      true,
    );
    expect(sameOrientation([0, 0, 0, 0], IDENTITY)).toBe(false);
    expect(sampleAt(gyroTrack(file([0], [[0, 0, 0, 0]])), 0)).toEqual([0, 0, 0, 1]);
    const drift = gyroTrack(
      file(
        Array.from({ length: 1000 }, (_, k) => 5000 + k * 20.1),
        Array.from({ length: 1000 }, () => IDENTITY),
      ),
    );
    expect(drift.hostMs[999]).toBeCloseTo(5000 + 999 * 20.1, 6);
  });

  it('finds the first sample at or after a time', () => {
    expect(
      [999, 1000, 1001, 1020, 1030, 1040.5, 1041].map((t) => firstSampleAtOrAfter(track, t)),
    ).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect(firstSampleAtOrAfter(gyroTrack(file([], [])), 0)).toBe(0);
  });

  it('interpolates inside the span, holds the first and last samples beyond it', () => {
    expectSame(orientationAt(track, 1000) ?? IDENTITY, q0, 'at the first sample');
    expectSame(orientationAt(track, 1020) ?? IDENTITY, q1, 'at the second sample');
    expectSame(orientationAt(track, 1010) ?? IDENTITY, fromAxisAngle(WHITE, 45), 'half-way');
    expectSame(
      orientationAt(track, 1030.25) ?? IDENTITY,
      fromAxisAngle(WHITE, 120),
      'half-way in the second interval',
    );
    expectSame(orientationAt(track, 500) ?? IDENTITY, q0, 'before the span');
    expectSame(orientationAt(track, 9000) ?? IDENTITY, q2, 'after the span');
    expect(orientationAt(gyroTrack(file([], [])), 1000)).toBeNull();
  });

  it('knows nothing before the first sample of a truncated file, and the reference is then that sample', () => {
    const truncated = gyroTrack(file([1000, 1020], [q1, q2], true));
    expect(orientationAt(truncated, 999)).toBeNull();
    expectSame(orientationAt(truncated, 1000) ?? IDENTITY, q1, 'at the first sample');
    expectSame(orientationAt(truncated, 1010) ?? IDENTITY, fromAxisAngle(WHITE, 120), 'inside');
    expectSame(referenceAt(truncated, 500) ?? IDENTITY, q1, 'the reference before the span');
    expectSame(referenceAt(track, 500) ?? IDENTITY, q0, 'the reference of a whole file');
    expectSame(
      referenceAt(track, 1010) ?? IDENTITY,
      fromAxisAngle(WHITE, 45),
      'the reference inside',
    );
    expect(referenceAt(gyroTrack(file([], [])), 1000)).toBeNull();
  });

  it('at two samples of one time shows the first of them, and goes on from the second', () => {
    const twice = gyroTrack(file([1000, 1000, 1020], [q0, q1, q2]));
    expectSame(orientationAt(twice, 1000) ?? IDENTITY, q0, 'at the pair');
    expectSame(orientationAt(twice, 1010) ?? IDENTITY, fromAxisAngle(WHITE, 120), 'after the pair');
  });
});

describe('cubeStep', () => {
  it('keeps the state, animates the next move as the time advances, rebuilds otherwise', () => {
    expect(cubeStep(-1, -1, false)).toBe('keep');
    expect(cubeStep(4, 4, true)).toBe('keep');
    expect(cubeStep(-1, 0, false)).toBe('animate');
    expect(cubeStep(4, 5, false)).toBe('animate');
    // A seek, even to the next move.
    expect(cubeStep(4, 5, true)).toBe('rebuild');
    // More than one move passed since the last frame.
    expect(cubeStep(4, 6, false)).toBe('rebuild');
    // Backwards.
    expect(cubeStep(4, 3, false)).toBe('rebuild');
    expect(cubeStep(4, -1, false)).toBe('rebuild');
  });
});
