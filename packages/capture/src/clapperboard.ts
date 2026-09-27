// The clapperboard (docs/PLAN.md, T2.5; docs/DATA-MODEL.md §6): single turns of the cube with pauses
// between them, seen twice: by the cube, whose moves have their host times, and by a camera, whose
// frames show a jump of motion (motion.ts) at each turn. The median lag of the motion's onsets behind
// the turns is how far the camera's frames lag the cube (`offsetMs`), which the training pipeline
// subtracts; their spread says how far to trust it. Pure TypeScript, tested on synthetic series.
import type { CameraClock, ClapperboardSample } from '@cubetrace/core';

import type { MotionSample } from './protocol';

/** How long a sync check watches, ms. */
export const SYNC_CHECK_MS = 20_000;

/** An onset rises above this many times the baseline, the energy of the still picture. */
export const ONSET_FACTOR = 4;

/** An onset comes after at least this long below the threshold, ms. */
export const ONSET_QUIET_MS = 500;

/** An onset is matched to the nearest move within this, ms, either way. */
export const MATCH_WINDOW_MS = 500;

/** Fewer turns matched to an onset fail the check. */
export const MIN_MATCHES = 4;

/** A wider spread of the lags fails the check: over a frame at 30 fps. */
export const MAX_SPREAD_MS = 40;

/**
 * The threshold is never below this many luma levels, so that a picture that does not change at all
 * (a baseline of 0, which a real camera's noise never gives) does not take any change for a turn.
 */
export const MIN_ONSET_ENERGY = 0.5;

/** Why a check failed. */
export type ClapperboardFailure =
  'no-moves' | 'no-frames' | 'no-motion' | 'few-matches' | 'wide-spread';

/** What the detection saw: the check's live counts and the lab's report. */
export interface ClapperboardAnalysis {
  /** Frames measured. */
  readonly frames: number;
  /** The cube's moves given. */
  readonly moves: number;
  /**
   * The median of arrival minus timestamp over the frames, ms: a frame's host time is its timestamp
   * plus this, as for the clips (docs/DATA-MODEL.md §9); null without frames.
   */
  readonly arrivalOffsetMs: number | null;
  /** The median energy of the still stretches (those of at least `ONSET_QUIET_MS` under the first threshold). */
  readonly baseline: number | null;
  /** `ONSET_FACTOR` times the baseline, at least `MIN_ONSET_ENERGY`. */
  readonly threshold: number | null;
  /** The onsets' host times, ms. */
  readonly onsets: readonly number[];
  /** The onsets matched to moves, one to one, in the order of the moves. */
  readonly pairs: readonly ClapperboardSample[];
  /** The median of onset minus move over the pairs, ms; null without pairs. */
  readonly offsetMs: number | null;
  /** The 95th minus the 5th percentile of those lags (nearest rank), ms; null without pairs. */
  readonly spreadMs: number | null;
}

/** A check's outcome as `session.json` keeps it (`clock.cameras[label]` less the remote fields). */
export type ClapperboardFit = Pick<
  CameraClock,
  'offsetMs' | 'clapperboardResidualMs' | 'clapperboardSamples'
> & { readonly samples: ClapperboardSample[] };

export type ClapperboardResult =
  | ({ readonly ok: true; readonly analysis: ClapperboardAnalysis } & ClapperboardFit)
  | {
      readonly ok: false;
      readonly reason: ClapperboardFailure;
      /** The reason in words, such as "the cube did not move". */
      readonly message: string;
      readonly analysis: ClapperboardAnalysis;
    };

/**
 * The camera's lag behind the cube from a sync check (docs/PLAN.md, T2.5): `frames`, the motion of
 * the camera's frames during the check, and `moves`, the host times of the cube's moves during it.
 * Each frame is placed on the host clock by its timestamp and the median arrival offset (the clips'
 * rule, so without the arrival's jitter); an onset is the first frame of a run above `ONSET_FACTOR`
 * times the baseline after at least `ONSET_QUIET_MS` under it; each onset is matched to the nearest
 * move within `MATCH_WINDOW_MS`, one to one; the offset is the median of onset minus move over the
 * pairs and the residual their spread (95th minus 5th percentile). Fails, saying why, without moves,
 * frames or onsets, with fewer than `MIN_MATCHES` pairs, or a spread over `MAX_SPREAD_MS`.
 */
export function detectClapperboard(
  frames: readonly MotionSample[],
  moves: readonly number[],
): ClapperboardResult {
  const ordered = [...frames].sort((p, q) => p.timestampUs - q.timestampUs);
  const { offsetMs: arrivalOffsetMs, times } = frameHostTimes(ordered);
  const energies = ordered.map((frame) => frame.energy);
  const level = onsetThreshold(times, energies);
  const onsets = level === null ? [] : findOnsets(times, energies, level.threshold);
  const pairs = matchOnsets(onsets, moves);
  const lags = pairs.map((pair) => pair.onsetHostMs - pair.moveHostMs).sort((a, b) => a - b);
  const offset = lags.length === 0 ? null : median(lags);
  const spread = lags.length === 0 ? null : percentile(lags, 0.95) - percentile(lags, 0.05);
  const analysis: ClapperboardAnalysis = {
    frames: ordered.length,
    moves: moves.length,
    arrivalOffsetMs: arrivalOffsetMs === null ? null : round(arrivalOffsetMs, 2),
    baseline: level === null ? null : round(level.baseline, 3),
    threshold: level === null ? null : round(level.threshold, 3),
    onsets: onsets.map((onset) => round(onset, 2)),
    pairs,
    offsetMs: offset === null ? null : round(offset, 1),
    spreadMs: spread === null ? null : round(spread, 1),
  };
  const fail = (reason: ClapperboardFailure, message: string): ClapperboardResult => ({
    ok: false,
    reason,
    message,
    analysis,
  });
  if (moves.length === 0) {
    return fail('no-moves', 'the cube did not move');
  }
  if (ordered.length === 0) {
    return fail('no-frames', "none of the camera's frames reached the check");
  }
  if (onsets.length === 0) {
    return fail('no-motion', 'no motion seen in the framing rectangle');
  }
  if (pairs.length < MIN_MATCHES) {
    return fail(
      'few-matches',
      `fewer than ${String(MIN_MATCHES)} matches (${String(pairs.length)} of ${String(moves.length)} ` +
        `${moves.length === 1 ? 'turn' : 'turns'} matched a motion)`,
    );
  }
  if (offset === null || spread === null || spread > MAX_SPREAD_MS) {
    return fail(
      'wide-spread',
      `spread over ${String(MAX_SPREAD_MS)} ms (${String(analysis.spreadMs)} ms)`,
    );
  }
  return {
    ok: true,
    offsetMs: round(offset, 1),
    clapperboardResidualMs: round(spread, 1),
    clapperboardSamples: pairs.length,
    samples: [...pairs],
    analysis,
  };
}

/**
 * The frames' host times, in their order: each frame's timestamp (ms) plus the median of arrival
 * minus timestamp over all of them (null without frames), as the clips place their frames.
 */
export function frameHostTimes(frames: readonly MotionSample[]): {
  readonly offsetMs: number | null;
  readonly times: number[];
} {
  if (frames.length === 0) {
    return { offsetMs: null, times: [] };
  }
  const offsetMs = median(
    frames.map((frame) => frame.arrivalHostMs - frame.timestampUs / 1000).sort((a, b) => a - b),
  );
  return { offsetMs, times: frames.map((frame) => frame.timestampUs / 1000 + offsetMs) };
}

/**
 * The baseline, the energy of the still picture, and the onset threshold of a series (`times`, host
 * ms, increasing; `energies` the frames'): the median energy of the still stretches, the runs of at
 * least `ONSET_QUIET_MS` under a first threshold drawn from the median of all frames (motion is the
 * exception during a check); the median of all frames when there is no such run. Null without frames.
 */
export function onsetThreshold(
  times: readonly number[],
  energies: readonly number[],
): { readonly baseline: number; readonly threshold: number } | null {
  if (energies.length === 0) {
    return null;
  }
  const first = thresholdOf(median([...energies].sort((a, b) => a - b)));
  const still: number[] = [];
  let runStart = -1;
  const closeRun = (end: number): void => {
    if (runStart >= 0 && times[end] - times[runStart] >= ONSET_QUIET_MS) {
      still.push(...energies.slice(runStart, end + 1));
    }
    runStart = -1;
  };
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] <= first) {
      if (runStart < 0) {
        runStart = i;
      }
    } else {
      closeRun(i - 1);
    }
  }
  closeRun(energies.length - 1);
  const baseline = median((still.length > 0 ? still : [...energies]).sort((a, b) => a - b));
  return { baseline, threshold: thresholdOf(baseline) };
}

/**
 * The onsets of a series: the host time of the first frame of each run above `threshold` that comes
 * after at least `quietMs` under it, counted from the first frame of that still run (the frames
 * before the first one of the series are unknown, so the series' first `quietMs` has no onset).
 */
export function findOnsets(
  times: readonly number[],
  energies: readonly number[],
  threshold: number,
  quietMs = ONSET_QUIET_MS,
): number[] {
  const onsets: number[] = [];
  let stillSince: number | null = null;
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] > threshold) {
      if (stillSince !== null && times[i] - stillSince >= quietMs) {
        onsets.push(times[i]);
      }
      stillSince = null;
    } else {
      stillSince ??= times[i];
    }
  }
  return onsets;
}

/**
 * Onsets matched to moves (host ms), one to one: the pairs within `windowMs` of each other, the
 * closest first, each onset and each move in one pair at most; in the order of the moves.
 */
export function matchOnsets(
  onsets: readonly number[],
  moves: readonly number[],
  windowMs = MATCH_WINDOW_MS,
): ClapperboardSample[] {
  const candidates: { onset: number; move: number; distance: number }[] = [];
  for (let i = 0; i < onsets.length; i++) {
    for (let j = 0; j < moves.length; j++) {
      const distance = Math.abs(onsets[i] - moves[j]);
      if (distance <= windowMs) {
        candidates.push({ onset: i, move: j, distance });
      }
    }
  }
  candidates.sort((p, q) => p.distance - q.distance || p.onset - q.onset || p.move - q.move);
  const onsetTaken = new Set<number>();
  const moveTaken = new Set<number>();
  const pairs: ClapperboardSample[] = [];
  for (const { onset, move } of candidates) {
    if (onsetTaken.has(onset) || moveTaken.has(move)) {
      continue;
    }
    onsetTaken.add(onset);
    moveTaken.add(move);
    pairs.push({ moveHostMs: moves[move], onsetHostMs: round(onsets[onset], 2) });
  }
  return pairs.sort((p, q) => p.moveHostMs - q.moveHostMs);
}

/** The `p` percentile (0 to 1) of sorted values by nearest rank: the smallest value with at least `p` of them at or below it. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new RangeError('No values.');
  }
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

/** The median of sorted values: the middle one, or the mean of the middle two. */
function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function thresholdOf(baseline: number): number {
  return Math.max(ONSET_FACTOR * baseline, MIN_ONSET_ENERGY);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
