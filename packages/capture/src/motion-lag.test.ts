import { describe, expect, it } from 'vitest';

import {
  FIT_TOLERANCE_MS,
  MIN_PROFILE_MOVES,
  PROFILE_BIN_MS,
  PROFILE_FROM_MS,
  PROFILE_TO_MS,
  clipMotionPoints,
  motionPeak,
  motionProfile,
  moveTimes,
  type MotionPoint,
} from './motion-lag';
import { MotionMeter } from './motion';
import { SyntheticFrame, lumaPlane, seeded } from './test-frames';

// A synthetic solve filmed at 30 fps: 640 × 360 frames of a grey picture with a little noise, the
// cube a square in the middle whose grey level changes a planted number of frames after each of the
// solve's moves, the moves 150 to 300 ms apart as a solve at 4 to 5 turns a second has them. Every
// frame goes through the capture worker's own meter (motion.ts: the whole frame on a plane 320 pixels
// wide), and the estimator gets each frame's changed area at its host time.
const WIDTH = 640;
const HEIGHT = 360;
const FRAME_MS = 1000 / 30;
const T0_MS = 1_790_000_000_000;
const LEVELS = [40, 200, 90, 230, 20, 160];

interface Scene {
  readonly moves: number[];
  readonly points: MotionPoint[];
}

/**
 * `turns` moves from 1 s into the scene, 150 to 300 ms apart; the square changes `afterFrames`
 * frames after the first frame at or after each move (so its frame comes `afterFrames` to
 * `afterFrames + 1` frame intervals after the move). With `unrelated`, it changes at random frames
 * instead, as often, whatever the moves.
 */
async function scene(
  turns: number,
  afterFrames: number,
  options: { seed?: number; unrelated?: boolean; still?: boolean } = {},
): Promise<Scene> {
  const random = seeded(options.seed ?? 7);
  const moves: number[] = [];
  let at = T0_MS + 1000;
  for (let k = 0; k < turns; k++) {
    moves.push(at);
    at += 150 + random() * 150;
  }
  const frames = Math.ceil((at + 1000 - T0_MS) / FRAME_MS);
  const changes = new Set<number>();
  for (const move of moves) {
    const index = Math.ceil((move - T0_MS) / FRAME_MS) + afterFrames;
    changes.add(options.unrelated === true ? Math.floor(random() * frames) : index);
  }
  const meter = new MotionMeter<SyntheticFrame>(null, { now: () => 0 });
  const points: MotionPoint[] = [];
  let level = 0;
  for (let index = 0; index < frames; index++) {
    if (options.still !== true && changes.has(index)) {
      level = (level + 1) % LEVELS.length;
    }
    const plane = lumaPlane(WIDTH, HEIGHT, 128, [
      { x: 220, y: 80, size: 200, value: LEVELS[level] },
    ]);
    for (let i = 0; i < plane.length; i += 7) {
      plane[i] = Math.max(0, Math.min(255, plane[i] + Math.round((random() - 0.5) * 6)));
    }
    const hostMs = T0_MS + index * FRAME_MS;
    const measured = await meter.measure(
      new SyntheticFrame(Math.round(index * FRAME_MS * 1000), plane, WIDTH, HEIGHT),
    );
    if (measured.changed !== null) {
      points.push({ hostMs, changed: measured.changed });
    }
  }
  return { moves, points };
}

describe('motionPeak, on the frames of a synthetic solve', () => {
  it('finds a motion planted two frames after each move where it is: 67 to 100 ms after the moves', async () => {
    const { moves, points } = await scene(60, 2);
    const peak = motionPeak(points, moves);
    expect(peak).not.toBeNull();
    console.info(
      `motion peak of a synthetic solve, a change 2 to 3 frames after each of 60 moves: ` +
        `${String(peak?.peakMs)} ms (${(2.5 * FRAME_MS).toFixed(1)} planted), spread ` +
        `${String(peak?.spreadMs)} ms, rise ${(peak?.rise ?? 0).toFixed(4)} over a spread of ` +
        (peak?.noise ?? 0).toFixed(4),
    );
    // The square's change falls 2 to 3 frame intervals after each move: their middle, 83.3 ms.
    expect(Math.abs((peak?.peakMs ?? 0) - 2.5 * FRAME_MS)).toBeLessThan(8);
    expect(peak?.moves).toBe(60);
    // A change of one frame, seen through bins of 10 ms smoothed over three: about a frame wide.
    expect(peak?.spreadMs).toBeGreaterThan(25);
    expect(peak?.spreadMs).toBeLessThan(60);
    // Clear: the neighbouring moves' changes, 150 to 300 ms away, are what the rest of it holds.
    expect(peak?.rise).toBeGreaterThan(5 * (peak?.noise ?? 1));
  });

  it('follows a lag that grows by two frames: the peak 67 ms later', async () => {
    const before = motionPeak(...args(await scene(60, 1, { seed: 3 })));
    const after = motionPeak(...args(await scene(60, 3, { seed: 3 })));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    console.info(
      `motion peak with the change 1 then 3 frames after each move: ${String(before?.peakMs)} ` +
        `then ${String(after?.peakMs)} ms (${(2 * FRAME_MS).toFixed(1)} ms apart planted)`,
    );
    expect(Math.abs((after?.peakMs ?? 0) - (before?.peakMs ?? 0) - 2 * FRAME_MS)).toBeLessThan(8);
  });

  it('gives no peak with fewer than ten moves, for a still picture, or for motion unrelated to the moves', async () => {
    expect(motionPeak(...args(await scene(MIN_PROFILE_MOVES - 1, 2)))).toBeNull();
    expect(motionPeak(...args(await scene(MIN_PROFILE_MOVES, 2)))).not.toBeNull();
    expect(motionPeak(...args(await scene(40, 2, { still: true })))).toBeNull();
    expect(motionPeak(...args(await scene(60, 2, { unrelated: true, seed: 11 })))).toBeNull();
  });

  it('gives no peak at an end of the window: a camera later than 300 ms is out of its reach', async () => {
    const late = await scene(40, Math.ceil(PROFILE_TO_MS / FRAME_MS));
    expect(motionPeak(late.points, late.moves)).toBeNull();
  });
});

describe('motionProfile', () => {
  it('averages over the moves whose whole window lies among the frames, in bins of 10 ms', () => {
    const points: MotionPoint[] = Array.from({ length: 200 }, (_, k) => ({
      hostMs: 1000 + k * 10,
      changed: 0,
    }));
    // The frames span 1000 to 2990 ms: a move needs 150 ms of frames before and 300 after.
    const profile = motionProfile(points, [1100, 1150, 2000, 2690, 2700]);
    expect(profile?.moves).toBe(3);
    expect(profile?.offsetsMs[0]).toBe(PROFILE_FROM_MS);
    expect(profile?.offsetsMs.at(-1)).toBe(PROFILE_TO_MS);
    expect((profile?.offsetsMs[1] ?? 0) - (profile?.offsetsMs[0] ?? 0)).toBe(PROFILE_BIN_MS);
    expect(profile?.counts.every((count) => count === 3)).toBe(true);
    expect(motionProfile(points, [500, 3000])).toBeNull();
    expect(motionProfile([], [2000])).toBeNull();
  });
});

describe('moveTimes', () => {
  const clock = { a: 1.007, b: 1_790_000_000_000 };
  const moves = [
    { hostMs: 1_790_000_000_012, cubeMs: 0, phase: 'scramble' },
    { hostMs: 1_790_000_001_031, cubeMs: 1000, phase: 'solve' },
    // An older move of a packet: its packet's arrival, 40 ms after it was turned.
    { hostMs: 1_790_000_001_254, cubeMs: 1200, phase: 'solve' },
    // On another cube clock (the cube reconnected): the fit is seconds off.
    { hostMs: 1_790_000_009_000, cubeMs: 3000, phase: 'solve' },
  ];

  it("places the solve's moves on the attempt's clock fit, where it is close to their arrival", () => {
    expect(moveTimes(moves, clock)).toEqual([
      1_790_000_001_007, 1_790_000_001_208.4, 1_790_000_009_000,
    ]);
    expect(Math.abs(moveTimes(moves, clock)[1] - moves[2].hostMs)).toBeLessThan(FIT_TOLERANCE_MS);
  });

  it('takes the arrivals without a fit, and the phase asked for', () => {
    expect(moveTimes(moves, null)).toEqual([
      1_790_000_001_031, 1_790_000_001_254, 1_790_000_009_000,
    ]);
    expect(moveTimes(moves, clock, 'scramble')).toEqual([1_790_000_000_000]);
  });
});

describe('clipMotionPoints', () => {
  it("puts a clip's measured frames on the host clock from its first frame", () => {
    expect(clipMotionPoints(1000, [0, 33.3, 66.7], [0.1, 0, 0.25])).toEqual([
      { hostMs: 1000, changed: 0.1 },
      { hostMs: 1033.3, changed: 0 },
      { hostMs: 1066.7, changed: 0.25 },
    ]);
  });
});

function args(scene: Scene): [MotionPoint[], number[]] {
  return [scene.points, scene.moves];
}
