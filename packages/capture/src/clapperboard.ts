// The clapperboard (docs/PLAN.md, T2.5 and T2.8; docs/DATA-MODEL.md §6): single turns of the cube
// with pauses between them, seen twice: by the cube, whose moves have their host times, and by a
// camera, whose frames change where the face turns (motion.ts). Since T2.8 the detection is locked to
// the turns: for each single turn it reads the frames around it against the picture just before it,
// rather than looking for motion anywhere in the check and pairing it with turns afterwards, which on
// a real camera (the whole 1080p frame, a person moving a little all the time) found no quiet stretch
// and no jump high enough, and matched none of the owner's turns. The median lag of the motion's
// onsets behind the turns is how far the camera's frames lag the cube (`offsetMs`), which the
// training pipeline subtracts; their spread says how far to trust it. Pure TypeScript, tested on
// synthetic series.
import type { CameraClock, ClapperboardSample } from '@cubetrace/core';

import type { MotionSample } from './protocol';

/** How long a sync check watches, ms. */
export const SYNC_CHECK_MS = 20_000;

/** A turn's motion is looked for from this long before its move … */
export const WINDOW_BEFORE_MS = 400;
/** … to this long after it, ms. */
export const WINDOW_AFTER_MS = 700;

/** A turn's baseline, the picture before it, is that of the frames from this long before its move … */
export const BASELINE_FROM_MS = 900;
/** … to this long before it, ms. */
export const BASELINE_TO_MS = 300;

/** Fewer frames than this give no baseline (a turn that came too soon after the check began). */
export const MIN_BASELINE_FRAMES = 5;

/**
 * The onset is the first frame that rises above the baseline's median by this many median absolute
 * deviations (MAD) of the baseline, or by `ENERGY_FLOOR` when that is more …
 */
export const ONSET_MADS = 3;
/** … in a window whose peak rises above it by this many (or twice the floor): a rise, not noise. */
export const PEAK_MADS = 6;

/**
 * The least rise that counts, in the energy's units: 0.1% of the region's pixels changed
 * (`MotionSample.changed`). A picture whose baseline does not vary at all (a MAD of 0) would otherwise
 * take a few changed pixels for a turn; a face turning in the framing rectangle changes hundreds.
 */
export const ENERGY_FLOOR = 0.001;

/**
 * A move counts as one of the check's turns only when no other move comes within this, ms, before or
 * after it: a single turn with a pause, as the check asks for. The moves of a scramble or a solve
 * come closer, and so densely that any motion is near one of them: matched, they would give a lag and
 * a narrow spread out of nothing.
 */
export const SINGLE_TURN_MS = 500;

/** Fewer turns matched to an onset fail the check. */
export const MIN_MATCHES = 4;

/** A wider spread of the lags fails the check: over a frame at 30 fps. */
export const MAX_SPREAD_MS = 40;

/**
 * The frames' host times and the page's clock when their motion reached it differ by the delivery
 * (a few ms). Farther apart than this, ms, the frames' clock is wrong: no turn's motion can be where
 * the check looks for it (its window reaches 700 ms after the turn), and the check says so.
 */
export const CLOCK_TOLERANCE_MS = 1000;

/**
 * A frame of a check: its motion (`MotionSample`), and when the page received it, on the page's
 * clock (host ms, the clock of the cube's moves), for the check of the frames' clock.
 */
export interface ClapperboardFrame extends MotionSample {
  readonly receivedHostMs?: number;
}

/** Why a check failed. */
export type ClapperboardFailure =
  'no-moves' | 'no-frames' | 'clock' | 'no-motion' | 'few-matches' | 'wide-spread';

/**
 * Why a single turn has no onset: no frame in its window (`no-frames`); fewer than
 * `MIN_BASELINE_FRAMES` before it (`no-baseline`); a window whose peak does not rise enough
 * (`no-rise`); a picture already above the onset's level from before the window to its end
 * (`no-onset`); or every rise in its window nearer another turn's move, which took it (`taken`).
 */
export type TurnMiss = 'no-frames' | 'no-baseline' | 'no-rise' | 'no-onset' | 'taken';

/** What the detection saw around one single turn (host ms; the energy as a share of pixels). */
export interface TurnAnalysis {
  /** The turn's move. */
  readonly moveHostMs: number;
  /** Where its motion was looked for: `WINDOW_BEFORE_MS` before the move to `WINDOW_AFTER_MS` after. */
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** Frames in that window. */
  readonly frames: number;
  /** The median energy of the frames from 900 to 300 ms before the move; null with too few. */
  readonly baseline: number | null;
  /** Their median absolute deviation from it; null with too few. */
  readonly mad: number | null;
  /** What the onset exceeds, and what the window's peak must exceed; null without a baseline. */
  readonly onsetLevel: number | null;
  readonly peakLevel: number | null;
  /** The window's highest energy, and its frame's host time; null without frames. */
  readonly peak: number | null;
  readonly peakHostMs: number | null;
  /** The motion's onset: its first frame's host time; null when the turn is unmatched. */
  readonly onsetHostMs: number | null;
  /** Onset minus move, ms; null when unmatched. */
  readonly lagMs: number | null;
  /** Why it is unmatched; null when matched. */
  readonly miss: TurnMiss | null;
}

/** Where the frames are on the host clock, and how well that agrees with the page's clock. */
export interface ClapperboardClock {
  /**
   * The median of arrival minus timestamp over the frames, ms: a frame's host time is its timestamp
   * plus this, as for the clips (docs/DATA-MODEL.md §9).
   */
  readonly arrivalOffsetMs: number;
  /** The 95th percentile of the arrivals' distance from that (nearest rank), ms: their jitter. */
  readonly arrivalResidualP95Ms: number;
  /**
   * The median of the frames' host times minus the page's clock when their motion reached it, ms: a
   * few ms below 0 (the delivery); null when no frame says when it was received.
   */
  readonly frameMinusPageMs: number | null;
}

/** What the detection saw: the check's live counts, its diagnostics and the lab's report. */
export interface ClapperboardAnalysis {
  /** Frames measured. */
  readonly frames: number;
  /** The cube's moves given. */
  readonly moves: number;
  /** One per single turn (`SINGLE_TURN_MS`), in time order: the turns the check matches. */
  readonly turns: readonly TurnAnalysis[];
  /** Of those, the turns matched to an onset, and the others. */
  readonly matched: number;
  readonly unmatched: number;
  /** The frames' clock; null without frames. */
  readonly clock: ClapperboardClock | null;
  /** The matched turns' moves and onsets, in the order of the moves. */
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

/** The unmatched turns' reasons as the failure's message counts them. */
const MISS_WORDS: Readonly<Record<TurnMiss, string>> = {
  'no-rise': 'without a clear change in the rectangle',
  'no-onset': 'while the picture was still changing',
  'no-baseline': 'too soon after the start',
  'no-frames': 'without frames',
  taken: "nearer another turn's change",
};

/**
 * The camera's lag behind the cube from a sync check (docs/PLAN.md, T2.5 and T2.8): `frames`, the
 * motion of the camera's frames during the check, and `moves`, the host times of the cube's moves
 * during it. Each frame is placed on the host clock by its timestamp and the median arrival offset
 * (the clips' rule, so without the arrival's jitter); its energy is its changed area. For each single
 * turn (`SINGLE_TURN_MS`) at `t`, the baseline is the median and the MAD of the energy from
 * `t − 900` to `t − 300` ms, and the onset is the first frame from `t − 400` to `t + 700` ms that
 * rises above `baseline + max(3 × MAD, floor)` from a frame that did not, provided the window's peak
 * exceeds `baseline + max(6 × MAD, 2 × floor)`; an onset goes to one turn only, the one whose move is
 * nearer (the other takes its next rise). The offset is the median of onset minus move over the
 * matched turns, the residual their spread (95th minus 5th percentile). Fails, saying why, without
 * moves or frames; when the frames' host times are more than `CLOCK_TOLERANCE_MS` from the page's
 * clock (`receivedHostMs`); when no single turn's window rises (no motion); with fewer than
 * `MIN_MATCHES` matched turns; or with a spread over `MAX_SPREAD_MS`.
 */
export function detectClapperboard(
  frames: readonly ClapperboardFrame[],
  moves: readonly number[],
): ClapperboardResult {
  const ordered = [...frames].sort((p, q) => p.timestampUs - q.timestampUs);
  const { offsetMs: arrivalOffsetMs, times } = frameHostTimes(ordered);
  const clock = arrivalOffsetMs === null ? null : frameClock(ordered, times, arrivalOffsetMs);
  const energies = ordered.map((frame) => frame.changed);
  const turns = analyseTurns(singleTurns(moves), times, energies);
  const pairs = turns.flatMap((turn) =>
    turn.onsetHostMs === null
      ? []
      : [{ moveHostMs: turn.moveHostMs, onsetHostMs: turn.onsetHostMs }],
  );
  const lags = pairs.map((pair) => pair.onsetHostMs - pair.moveHostMs).sort((a, b) => a - b);
  const offset = lags.length === 0 ? null : median(lags);
  const spread = lags.length === 0 ? null : percentile(lags, 0.95) - percentile(lags, 0.05);
  const analysis: ClapperboardAnalysis = {
    frames: ordered.length,
    moves: moves.length,
    turns,
    matched: pairs.length,
    unmatched: turns.length - pairs.length,
    clock,
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
  const skew = clock?.frameMinusPageMs ?? null;
  if (skew !== null && Math.abs(skew) > CLOCK_TOLERANCE_MS) {
    return fail(
      'clock',
      `frame times are off by ${(Math.abs(skew) / 1000).toFixed(1)} s: the frame clock is wrong`,
    );
  }
  if (turns.length > 0 && turns.every((turn) => turn.miss === 'no-rise')) {
    return fail('no-motion', 'no motion seen in the framing rectangle');
  }
  if (pairs.length < MIN_MATCHES) {
    return fail('few-matches', fewMatches(turns, moves.length));
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
 * The frames' clock (`ClapperboardClock`): the arrival offset, the arrivals' jitter around it, and the
 * median of the frames' host times (`times`) minus the page's clock when their motion reached it.
 */
function frameClock(
  frames: readonly ClapperboardFrame[],
  times: readonly number[],
  arrivalOffsetMs: number,
): ClapperboardClock {
  const residuals = frames
    .map((frame, k) => Math.abs(frame.arrivalHostMs - times[k]))
    .sort((a, b) => a - b);
  const skews = frames
    .flatMap((frame, k) =>
      frame.receivedHostMs === undefined ? [] : [times[k] - frame.receivedHostMs],
    )
    .sort((a, b) => a - b);
  return {
    arrivalOffsetMs: round(arrivalOffsetMs, 2),
    arrivalResidualP95Ms: round(percentile(residuals, 0.95), 2),
    frameMinusPageMs: skews.length === 0 ? null : round(median(skews), 1),
  };
}

/** A turn's analysis before the onsets are shared out, with the rises of its window. */
interface Candidate {
  readonly analysis: TurnAnalysis;
  /** The frames (indices) that rise above its onset level, in time order. */
  readonly rises: readonly number[];
}

/**
 * Every single turn's analysis (`TurnAnalysis`), each onset given to one turn at most: a turn takes
 * the first rise of its window, unless the move of another turn that takes it too is nearer to it,
 * in which case it takes its next rise (the earlier move keeps a rise at the same distance).
 */
function analyseTurns(
  turns: readonly number[],
  times: readonly number[],
  energies: readonly number[],
): TurnAnalysis[] {
  const candidates = turns.map((move) => candidateOf(move, times, energies));
  const next = candidates.map(() => 0);
  const holders = new Map<number, number>();
  const waiting = candidates.flatMap((candidate, k) => (candidate.rises.length > 0 ? [k] : []));
  for (let k = waiting.shift(); k !== undefined; k = waiting.shift()) {
    const { rises } = candidates[k];
    while (next[k] < rises.length) {
      const frame = rises[next[k]];
      const holder = holders.get(frame);
      if (holder === undefined) {
        holders.set(frame, k);
        break;
      }
      const mine = Math.abs(times[frame] - turns[k]);
      const theirs = Math.abs(times[frame] - turns[holder]);
      if (mine < theirs || (mine === theirs && turns[k] < turns[holder])) {
        holders.set(frame, k);
        next[holder] += 1;
        waiting.push(holder);
        break;
      }
      next[k] += 1;
    }
  }
  const onsets = new Map<number, number>();
  for (const [frame, k] of holders) {
    onsets.set(k, frame);
  }
  return candidates.map((candidate, k) => {
    const frame = onsets.get(k);
    if (candidate.rises.length === 0) {
      return candidate.analysis;
    }
    if (frame === undefined) {
      return { ...candidate.analysis, miss: 'taken' };
    }
    const onset = round(times[frame], 2);
    return {
      ...candidate.analysis,
      onsetHostMs: onset,
      lagMs: round(onset - turns[k], 2),
      miss: null,
    };
  });
}

/** One turn's window, baseline and rises (`detectClapperboard`), before any onset is shared out. */
function candidateOf(
  move: number,
  times: readonly number[],
  energies: readonly number[],
): Candidate {
  const windowStartMs = move - WINDOW_BEFORE_MS;
  const windowEndMs = move + WINDOW_AFTER_MS;
  const first = firstAtOrAfter(times, windowStartMs);
  const end = firstAfter(times, windowEndMs);
  let peakAt = -1;
  for (let i = first; i < end; i++) {
    if (peakAt < 0 || energies[i] > energies[peakAt]) {
      peakAt = i;
    }
  }
  const before = energies.slice(
    firstAtOrAfter(times, move - BASELINE_FROM_MS),
    firstAfter(times, move - BASELINE_TO_MS),
  );
  const level = before.length >= MIN_BASELINE_FRAMES ? levelsOf(before) : null;
  const unmatched = (miss: TurnMiss | null): TurnAnalysis => ({
    moveHostMs: move,
    windowStartMs: round(windowStartMs, 2),
    windowEndMs: round(windowEndMs, 2),
    frames: end - first,
    baseline: level === null ? null : round(level.baseline, 6),
    mad: level === null ? null : round(level.mad, 6),
    onsetLevel: level === null ? null : round(level.onset, 6),
    peakLevel: level === null ? null : round(level.peak, 6),
    peak: peakAt < 0 ? null : energies[peakAt],
    peakHostMs: peakAt < 0 ? null : round(times[peakAt], 2),
    onsetHostMs: null,
    lagMs: null,
    miss,
  });
  if (peakAt < 0) {
    return { analysis: unmatched('no-frames'), rises: [] };
  }
  if (level === null) {
    return { analysis: unmatched('no-baseline'), rises: [] };
  }
  if (energies[peakAt] <= level.peak) {
    return { analysis: unmatched('no-rise'), rises: [] };
  }
  const rises: number[] = [];
  for (let i = Math.max(first, 1); i < end; i++) {
    if (energies[i] > level.onset && energies[i - 1] <= level.onset) {
      rises.push(i);
    }
  }
  // A candidate with rises is matched or `taken` once the onsets are shared out.
  return { analysis: unmatched(rises.length === 0 ? 'no-onset' : null), rises };
}

/** A baseline's median and MAD, and the levels the onset and the window's peak must exceed. */
function levelsOf(values: readonly number[]): {
  readonly baseline: number;
  readonly mad: number;
  readonly onset: number;
  readonly peak: number;
} {
  const baseline = median([...values].sort((a, b) => a - b));
  const mad = median(values.map((value) => Math.abs(value - baseline)).sort((a, b) => a - b));
  return {
    baseline,
    mad,
    onset: baseline + Math.max(ONSET_MADS * mad, ENERGY_FLOOR),
    peak: baseline + Math.max(PEAK_MADS * mad, 2 * ENERGY_FLOOR),
  };
}

/**
 * "fewer than 4 matches (2 of 8 single turns matched a motion; 5 without a clear change in the
 * rectangle, 1 too soon after the start; 3 turns came within half a second of another)".
 */
function fewMatches(turns: readonly TurnAnalysis[], moves: number): string {
  const matched = turns.filter((turn) => turn.miss === null).length;
  const counts = new Map<TurnMiss, number>();
  for (const turn of turns) {
    if (turn.miss !== null) {
      counts.set(turn.miss, (counts.get(turn.miss) ?? 0) + 1);
    }
  }
  const misses = [...counts]
    .sort((p, q) => q[1] - p[1])
    .map(([miss, count]) => `${String(count)} ${MISS_WORDS[miss]}`);
  const others = moves - turns.length;
  const close =
    others === 0
      ? []
      : [`${String(others)} ${plural(others, 'turn')} came within half a second of another`];
  const details = [misses.join(', '), ...close].filter((part) => part !== '');
  return (
    `fewer than ${String(MIN_MATCHES)} matches (${String(matched)} of ${String(turns.length)} ` +
    `single ${plural(turns.length, 'turn')} matched a motion` +
    `${details.map((part) => `; ${part}`).join('')})`
  );
}

/**
 * The single turns among `moves` (host ms): those with no other move within `gapMs` before or after
 * them, in time order.
 */
export function singleTurns(moves: readonly number[], gapMs = SINGLE_TURN_MS): number[] {
  const sorted = [...moves].sort((a, b) => a - b);
  return sorted.filter(
    (move, k) =>
      (k === 0 || move - sorted[k - 1] >= gapMs) &&
      (k === sorted.length - 1 || sorted[k + 1] - move >= gapMs),
  );
}

/** The `p` percentile (0 to 1) of sorted values by nearest rank: the smallest value with at least `p` of them at or below it. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new RangeError('No values.');
  }
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
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

/** The index of the first of the increasing `times` after `at` (their length if none). */
function firstAfter(times: readonly number[], at: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= at) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The median of sorted values: the middle one, or the mean of the middle two. */
function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** "turn" or "turns". */
function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** `value` to `digits` decimals; never -0. */
function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale + 0;
}
