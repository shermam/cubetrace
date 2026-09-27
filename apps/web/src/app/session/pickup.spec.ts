import { PICKUP_THRESHOLD_DEG, rotationDeg, type Quaternion } from './pickup';

/** A rotation of `deg` degrees about the axis (x, y, z), as a unit quaternion [x, y, z, w]. */
function about(deg: number, x: number, y: number, z: number): Quaternion {
  const half = (deg * Math.PI) / 360;
  const n = Math.hypot(x, y, z);
  return [
    (x / n) * Math.sin(half),
    (y / n) * Math.sin(half),
    (z / n) * Math.sin(half),
    Math.cos(half),
  ];
}

describe('rotationDeg', () => {
  it('is the angle between two orientations, whatever the axis', () => {
    const still: Quaternion = [0, 0, 0, 1];
    expect(rotationDeg(still, still)).toBe(0);
    expect(rotationDeg(still, about(90, 0, 0, 1))).toBeCloseTo(90, 6);
    expect(rotationDeg(about(10, 1, 0, 0), about(40, 1, 0, 0))).toBeCloseTo(30, 6);
    expect(rotationDeg(about(20, 1, 1, 0), about(20, 1, 1, 0))).toBeCloseTo(0, 6);
  });

  it('treats q and −q as the same orientation, and normalizes', () => {
    const q = about(30, 0, 1, 0);
    const minus: Quaternion = [-q[0], -q[1], -q[2], -q[3]];
    expect(rotationDeg(q, minus)).toBeCloseTo(0, 6);
    const doubled: Quaternion = [q[0] * 2, q[1] * 2, q[2] * 2, q[3] * 2];
    expect(rotationDeg([0, 0, 0, 1], doubled)).toBeCloseTo(30, 6);
    expect(rotationDeg([0, 0, 0, 0], q)).toBe(0);
  });

  it('puts the pickup threshold between a cube at rest and a real pickup', () => {
    const rest: Quaternion = [0, 0, 0, 1];
    expect(rotationDeg(rest, about(0.5, 1, 2, 3))).toBeLessThan(PICKUP_THRESHOLD_DEG);
    expect(rotationDeg(rest, about(25, 1, 0, 0))).toBeGreaterThan(PICKUP_THRESHOLD_DEG);
  });
});
