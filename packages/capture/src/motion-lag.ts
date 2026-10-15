// The camera's lag from a solve's own moves (docs/PLAN.md T5.3, issue #67): the sync check measures
// how far a camera's frames lag the cube once, with single turns (clapperboard.ts); during a solve
// the turns come 150 to 300 ms apart, too close for its turn-by-turn windows, but the motion of the
// frames averaged around all of the solve's moves (each frame's motion put in the 10 ms bin of its
// time after each move, from 150 ms before to 300 ms after) peaks where the turns' motion is, a little
// after the camera's lag. Where that peak sits for each solve, against where it sat for the camera's
// sync check, is how far the lag moved since the check: the method the coordinator used on the
// recordings of 2026-10-09 to find the 75 ms of issue #67, done by the app for every clip. Plain
// TypeScript, no browser API: tested in Node on synthetic frames with a known delay.
import type { CubeClockParams } from '@cubetrace/core';

import { ENERGY_FLOOR } from './clapperboard';

/** The profile around a move begins this long before it, ms … */
export const PROFILE_FROM_MS = -150;
/** … and ends this long after it. */
export const PROFILE_TO_MS = 300;
/** The width of its bins, ms. */
export const PROFILE_BIN_MS = 10;

/** Fewer moves with their whole window among the frames give no peak. */
export const MIN_PROFILE_MOVES = 10;

/**
 * A peak is clear when it rises above the profile's median by this many times the profile's spread
 * (its median absolute deviation as a standard deviation, × 1.4826), and by `ENERGY_FLOOR` at least.
 */
export const PROFILE_PEAK_SPREADS = 3;

/**
 * A move's time on the attempt's clock fit is taken (rather than its packet's arrival) when the two
 * are this close, ms: farther apart, the fit is another cube clock's (the cube reconnected within the
 * attempt) and the arrival is the better time.
 */
export const FIT_TOLERANCE_MS = 200;

/** One frame's motion on the host clock: its time and its changed area (motion.ts), 0 to 1. */
export interface MotionPoint {
  readonly hostMs: number;
  readonly changed: number;
}

/** The motion averaged around the moves (`motionProfile`). */
export interface MotionProfile {
  /** The bins' centres, ms after the moves: −150, −140, … 300. */
  readonly offsetsMs: readonly number[];
  /**
   * Per bin, the mean changed area of the frames that fell in it over all the moves, smoothed over
   * three bins (1, 2, 1); a bin without a frame takes its neighbours' line.
   */
  readonly values: readonly number[];
  /** Per bin, the frames that fell in it. */
  readonly counts: readonly number[];
  /** The values' median: the profile's baseline. */
  readonly baseline: number;
  /** The values' median absolute deviation from it, × 1.4826: the profile's spread. */
  readonly spread: number;
  /** The moves whose whole window lies among the frames: those averaged over. */
  readonly moves: number;
}

/** Where the motion peaks around the moves (`motionPeak`). */
export interface MotionPeak {
  /** The peak's time after the moves, ms to 0.1 (a parabola through the top bin and its neighbours). */
  readonly peakMs: number;
  /** Its width at half its rise, ms to 0.1. */
  readonly spreadMs: number;
  /** The moves averaged over. */
  readonly moves: number;
  /** How far the peak rises above the baseline, in changed area. */
  readonly rise: number;
  /** The profile's spread (`MotionProfile.spread`). */
  readonly noise: number;
}

/** The number of bins of a profile: −150 to 300 ms by 10, both ends included. */
const BINS = Math.round((PROFILE_TO_MS - PROFILE_FROM_MS) / PROFILE_BIN_MS) + 1;

/**
 * The motion of `points` averaged around each of `moves` (host ms): every frame within a move's
 * window goes into the 10 ms bin of its time after the move, and each bin is the mean of its frames
 * over all the moves, then smoothed over three bins. Only the moves whose whole window (150 ms before
 * them to 300 ms after) lies among the frames count; null when none does.
 */
export function motionProfile(
  points: readonly MotionPoint[],
  moves: readonly number[],
): MotionProfile | null {
  const frames = [...points]
    .filter((point) => Number.isFinite(point.hostMs) && Number.isFinite(point.changed))
    .sort((p, q) => p.hostMs - q.hostMs);
  if (frames.length < 2) {
    return null;
  }
  const first = frames[0].hostMs;
  const last = frames[frames.length - 1].hostMs;
  const used = moves.filter(
    (move) => move + PROFILE_FROM_MS >= first && move + PROFILE_TO_MS <= last,
  );
  if (used.length === 0) {
    return null;
  }
  const times = frames.map((frame) => frame.hostMs);
  const sums = new Array<number>(BINS).fill(0);
  const counts = new Array<number>(BINS).fill(0);
  const half = PROFILE_BIN_MS / 2;
  for (const move of used) {
    const end = firstAtOrAfter(times, move + PROFILE_TO_MS + half);
    for (let i = firstAtOrAfter(times, move + PROFILE_FROM_MS - half); i < end; i++) {
      const bin = Math.round((frames[i].hostMs - move - PROFILE_FROM_MS) / PROFILE_BIN_MS);
      if (bin >= 0 && bin < BINS) {
        sums[bin] += frames[i].changed;
        counts[bin] += 1;
      }
    }
  }
  const means = fillGaps(sums.map((sum, k) => (counts[k] > 0 ? sum / counts[k] : null)));
  const values = means.map(
    (value, k) => (means[Math.max(0, k - 1)] + 2 * value + means[Math.min(BINS - 1, k + 1)]) / 4,
  );
  const baseline = median(values);
  const spread = 1.4826 * median(values.map((value) => Math.abs(value - baseline)));
  return {
    offsetsMs: values.map((_, k) => PROFILE_FROM_MS + k * PROFILE_BIN_MS),
    values,
    counts,
    baseline,
    spread,
    moves: used.length,
  };
}

/**
 * Where the motion of `points` peaks around `moves` (`motionProfile`): the top bin, refined with a
 * parabola through it and its neighbours, and the peak's width at half its rise above the baseline.
 * Null with fewer than `MIN_PROFILE_MOVES` moves, a top bin at an end of the window, or no clear
 * peak (a rise under `PROFILE_PEAK_SPREADS` times the spread, or under `ENERGY_FLOOR`).
 */
export function motionPeak(
  points: readonly MotionPoint[],
  moves: readonly number[],
): MotionPeak | null {
  const profile = motionProfile(points, moves);
  if (profile === null || profile.moves < MIN_PROFILE_MOVES) {
    return null;
  }
  const { values, baseline, spread } = profile;
  let top = 0;
  for (let k = 1; k < values.length; k++) {
    if (values[k] > values[top]) {
      top = k;
    }
  }
  const rise = values[top] - baseline;
  if (
    top === 0 ||
    top === values.length - 1 ||
    rise < ENERGY_FLOOR ||
    rise < PROFILE_PEAK_SPREADS * spread
  ) {
    return null;
  }
  const [y0, y1, y2] = [values[top - 1], values[top], values[top + 1]];
  const curve = y0 - 2 * y1 + y2;
  const shift = curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / curve)) : 0;
  const halfLevel = baseline + rise / 2;
  let left = 0;
  for (let k = top - 1; k >= 0; k--) {
    if (values[k] <= halfLevel) {
      left = k + (halfLevel - values[k]) / (values[k + 1] - values[k]);
      break;
    }
  }
  let right = values.length - 1;
  for (let k = top + 1; k < values.length; k++) {
    if (values[k] <= halfLevel) {
      right = k - (halfLevel - values[k]) / (values[k - 1] - values[k]);
      break;
    }
  }
  return {
    peakMs: tenth(PROFILE_FROM_MS + (top + shift) * PROFILE_BIN_MS),
    spreadMs: tenth((right - left) * PROFILE_BIN_MS),
    moves: profile.moves,
    rise,
    noise: spread,
  };
}

/** A move as an attempt's record keeps it: its packet's arrival, its cube time and its phase. */
export interface TimedMove {
  readonly hostMs: number;
  readonly cubeMs: number;
  readonly phase: string;
}

/**
 * The host times of the moves of `phase` (the solve's, by default) for the motion's profile: each
 * on the attempt's clock fit (`a · cubeMs + b`), which has none of the Bluetooth packets' jitter and
 * gives each move of a packet its own time, where the fit is within `FIT_TOLERANCE_MS` of the move's
 * arrival; else, and without a fit, its arrival.
 */
export function moveTimes(
  moves: readonly TimedMove[],
  clock: Pick<CubeClockParams, 'a' | 'b'> | null,
  phase = 'solve',
): number[] {
  return moves
    .filter((move) => move.phase === phase)
    .map((move) => {
      if (clock === null) {
        return move.hostMs;
      }
      const fit = clock.a * move.cubeMs + clock.b;
      return Number.isFinite(fit) && Math.abs(fit - move.hostMs) <= FIT_TOLERANCE_MS
        ? fit
        : move.hostMs;
    });
}

/** The motion points of a clip: its first frame's host time plus each measured frame's offset. */
export function clipMotionPoints(
  t0HostMs: number,
  atMs: readonly number[],
  changed: readonly number[],
): MotionPoint[] {
  const points: MotionPoint[] = [];
  for (let k = 0; k < Math.min(atMs.length, changed.length); k++) {
    points.push({ hostMs: t0HostMs + atMs[k], changed: changed[k] });
  }
  return points;
}

/** The bins without a frame take the line between their nearest neighbours with one (or the nearest). */
function fillGaps(values: readonly (number | null)[]): number[] {
  const known = values.flatMap((value, k) => (value === null ? [] : [k]));
  if (known.length === 0) {
    return values.map(() => 0);
  }
  return values.map((value, k) => {
    if (value !== null) {
      return value;
    }
    const after = known.find((at) => at > k);
    const before = [...known].reverse().find((at) => at < k);
    if (before === undefined) {
      return values[after ?? known[0]] ?? 0;
    }
    if (after === undefined) {
      return values[before] ?? 0;
    }
    const low = values[before] ?? 0;
    const high = values[after] ?? 0;
    return low + ((high - low) * (k - before)) / (after - before);
  });
}

/** The median of `values` (at least one). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The index of the first of the increasing `times` at or after `at` (their length if none). */
function firstAtOrAfter(times: readonly number[], at: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < at) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** `value` to 0.1; never −0. */
function tenth(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}
