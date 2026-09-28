// The clapperboard (docs/PLAN.md, T2.5, T2.8 and T2.11; docs/DATA-MODEL.md §6): single turns of the
// cube with pauses between them, seen twice: by the cube, whose moves have their host times, and by a
// camera, whose frames change where the face turns (motion.ts). Since T2.8 the detection is locked to
// the turns: for each single turn it reads the frames around it against the picture just before it,
// rather than looking for motion anywhere in the check and pairing it with turns afterwards, which on
// a real camera (the whole 1080p frame, a person moving a little all the time) found no quiet stretch
// and no jump high enough, and matched none of the owner's turns. Since T2.11 a turn's time in the
// frames is the middle of its motion, not the first frame of its rise: the cube reports a turn in the
// middle of the face's motion, while the hand gets ready for it (the fingers placed, the cube shifted
// in the hands) a varying time before, which the first rise caught, so that the owner's two checks of
// issue #38 matched every turn and spread their lags over 340 ms. The median lag of those events
// behind the moves is how far the camera's frames lag the cube (`offsetMs`), which the training
// pipeline subtracts; the range of the lags, less the fifth of them farthest from that median, says
// how far to trust it. Pure TypeScript, tested on synthetic series and on the owner's checks
// (fixtures/sync/).
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
 * A turn's motion must rise in its window, from a frame at or under the baseline's median plus this
 * many median absolute deviations (MAD) of the baseline (or plus `ENERGY_FLOOR` when that is more) to
 * one above it: the first such frame is its onset, which T2.8 took for the turn's time and which the
 * diagnostics keep …
 */
export const ONSET_MADS = 3;
/** … in a window whose peak rises above it by this many (or twice the floor): a rise, not noise. */
export const PEAK_MADS = 6;

/**
 * A turn's event, the middle of its motion (T2.11), is the centroid of its motion over the frames
 * within this of the peak it is centred on, ms, before and after: a face's quarter turn takes a few
 * frames. A peak is a frame of the window that no frame this close to it rises above; two peaks this
 * close are the same motion.
 */
export const EVENT_HALF_WINDOW_MS = 150;

/**
 * A turn's event is centred on the highest peak of its window, or on an earlier peak that rises above
 * the baseline by at least this share of the highest's rise: of two motions about as strong, the
 * turn's is the earlier. What follows a turn in its window (the hand letting go, a fidget) can move
 * the picture as much as the turn did (the synthetic scene's fidgets; on the owner's checks of issue
 * #38 a later motion rose 0.95 and 0.98 as high as the turn's), while the hand getting ready before a
 * turn moved it at most 0.68 as much.
 */
export const EARLIER_PEAK_SHARE = 0.8;

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

/** Fewer turns matched to a motion fail the check. */
export const MIN_MATCHES = 4;

/**
 * The spread leaves out this share of the matched turns, in percent, rounded up (`droppedCount`):
 * those whose lags are farthest from the median lag. The range of all the lags hangs on the two most
 * extreme turns, and the median does not: on the owner's checks of issue #38 the two lags farthest
 * from the median were 36 to 94 ms from it.
 */
export const DROPPED_PERCENT = 20;

/**
 * A check allows a spread of the lags of this, ms, plus the median interval of its frames
 * (`spreadLimitMs`): the frames see each turn's motion a frame at a time (an interval is 33 ms at
 * 30 fps), on top of the Bluetooth jitter of the cube's reports (a 95th percentile of 13 to 23 ms on
 * both cubes, docs/DEVICES.md), and the spread is the range of the lags kept.
 */
export const SPREAD_ALLOWANCE_MS = 50;

/**
 * The spread limit is never under this, ms (T2.5's fixed limit), and is this when the frames'
 * interval is unknown (fewer than two frames).
 */
export const MIN_SPREAD_LIMIT_MS = 40;

/**
 * The widest spread of the lags that passes a check whose frames come `frameIntervalMs` apart (their
 * median interval; null when unknown): `SPREAD_ALLOWANCE_MS` plus that interval, 83 ms at 30 fps and
 * 67 at 60, never under `MIN_SPREAD_LIMIT_MS`.
 */
export function spreadLimitMs(frameIntervalMs: number | null): number {
  return frameIntervalMs === null
    ? MIN_SPREAD_LIMIT_MS
    : Math.max(MIN_SPREAD_LIMIT_MS, SPREAD_ALLOWANCE_MS + frameIntervalMs);
}

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
 * Why a single turn is unmatched: no frame in its window (`no-frames`); fewer than
 * `MIN_BASELINE_FRAMES` before it (`no-baseline`); a window whose peak does not rise enough
 * (`no-rise`); a picture already above the onset's level from before the window to its end
 * (`no-onset`); or every peak of its window high enough taken by a turn whose move is nearer it
 * (`taken`).
 */
export type TurnMiss = 'no-frames' | 'no-baseline' | 'no-rise' | 'no-onset' | 'taken';

/**
 * How a turn's time in the frames is found: since T2.11 the middle of its motion
 * (`EVENT_HALF_WINDOW_MS`); T2.8 took the first frame of its rise, the onset.
 */
export type ClapperboardEstimator = 'motion-centre';

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
  /**
   * The energy of the frame its event is centred on, and that frame's host time: the window's peak
   * (its highest, or an earlier peak nearly as high, `EARLIER_PEAK_SHARE`), or, when a turn whose move
   * is nearer took that one, its window's peak more than `EVENT_HALF_WINDOW_MS` from it; the window's
   * highest frame when unmatched; null without frames.
   */
  readonly peak: number | null;
  readonly peakHostMs: number | null;
  /**
   * The motion's onset, the first frame of the window that rises above the onset level (T2.8's time
   * of the turn; since T2.11 a diagnostic): its host time; null when the turn is unmatched.
   */
  readonly onsetHostMs: number | null;
  /**
   * The middle of the turn's motion (T2.11): the centroid of `max(0, energy − baseline)²` over the
   * frames within `EVENT_HALF_WINDOW_MS` of the peak, at their host times; null when unmatched.
   */
  readonly eventHostMs: number | null;
  /** Event minus move, ms; null when unmatched. */
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

/** A matched turn that the spread leaves out (`DROPPED_PERCENT`): its move and event, and its lag. */
export interface DroppedPair extends ClapperboardSample {
  /** Event minus move, ms. */
  readonly lagMs: number;
}

/** What the detection saw: the check's live counts, its diagnostics and the lab's report. */
export interface ClapperboardAnalysis {
  /** How a turn's time in the frames is found: the middle of its motion (T2.11). */
  readonly estimator: ClapperboardEstimator;
  /** Frames measured. */
  readonly frames: number;
  /** The cube's moves given. */
  readonly moves: number;
  /** One per single turn (`SINGLE_TURN_MS`), in time order: the turns the check matches. */
  readonly turns: readonly TurnAnalysis[];
  /** Of those, the turns matched to a motion, and the others. */
  readonly matched: number;
  readonly unmatched: number;
  /** The frames' clock; null without frames. */
  readonly clock: ClapperboardClock | null;
  /**
   * The matched turns' moves and events, in the order of the moves: `onsetHostMs` is the event, the
   * middle of the turn's motion (the name `session.json` keeps, docs/DATA-MODEL.md §6).
   */
  readonly pairs: readonly ClapperboardSample[];
  /**
   * The pairs the spread leaves out, with their lags, in the order of the moves: the
   * `droppedCount(matched)` whose lags are farthest from the median lag of all the pairs.
   */
  readonly dropped: readonly DroppedPair[];
  /** The pairs kept: `matched` less those dropped. */
  readonly kept: number;
  /** The median lag (event minus move) of the kept pairs, ms; null without pairs. */
  readonly offsetMs: number | null;
  /** The range of their lags (the largest less the smallest), ms; null without pairs. */
  readonly spreadMs: number | null;
  /** The median interval of the frames, ms; null with fewer than two frames. */
  readonly frameIntervalMs: number | null;
  /** The widest spread that passes, ms: `spreadLimitMs` of that interval. */
  readonly maxSpreadMs: number;
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
 * The camera's lag behind the cube from a sync check (docs/PLAN.md, T2.5, T2.8 and T2.11): `frames`,
 * the motion of the camera's frames during the check, and `moves`, the host times of the cube's moves
 * during it. Each frame is placed on the host clock by its timestamp and the median arrival offset
 * (the clips' rule, so without the arrival's jitter); its energy is its changed area. For each single
 * turn (`SINGLE_TURN_MS`) at `t`, the baseline is the median and the MAD of the energy from
 * `t − 900` to `t − 300` ms; the turn is matched when its window, from `t − 400` to `t + 700` ms,
 * rises from a frame at or under `baseline + max(3 × MAD, floor)` to one above it (its onset) and
 * peaks above `baseline + max(6 × MAD, 2 × floor)`; its event is the middle of its motion, the
 * centroid of `max(0, energy − baseline)²` over the frames within 150 ms of the window's peak (its
 * highest frame, or an earlier peak that rises at least 0.8 as high, `EARLIER_PEAK_SHARE`), and a
 * peak goes to one turn only, the one whose move is nearer it (the other takes the peak of its window
 * more than 150 ms from it). The offset is the median of event minus move over the matched turns less
 * the fifth whose lags are farthest from the median of all (`droppedCount`), the residual the range
 * of the lags kept. Fails, saying why, without moves or frames; when the frames' host times are more
 * than `CLOCK_TOLERANCE_MS` from the page's clock (`receivedHostMs`); when no single turn's window
 * rises (no motion); with fewer than `MIN_MATCHES` matched turns; or with a spread over
 * `spreadLimitMs` of the frames' median interval.
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
  const matched = turns.flatMap((turn) =>
    turn.eventHostMs === null || turn.lagMs === null
      ? []
      : [{ moveHostMs: turn.moveHostMs, onsetHostMs: turn.eventHostMs, lagMs: turn.lagMs }],
  );
  const left = farthest(matched.map((pair) => pair.lagMs));
  const kept = matched.filter((_, k) => !left.has(k));
  const lags = kept.map((pair) => pair.lagMs).sort((a, b) => a - b);
  const offset = lags.length === 0 ? null : median(lags);
  const spread = lags.length === 0 ? null : lags[lags.length - 1] - lags[0];
  const interval = frameInterval(times);
  const limit = spreadLimitMs(interval);
  const analysis: ClapperboardAnalysis = {
    estimator: 'motion-centre',
    frames: ordered.length,
    moves: moves.length,
    turns,
    matched: matched.length,
    unmatched: turns.length - matched.length,
    clock,
    pairs: matched.map(sampleOf),
    dropped: matched.filter((_, k) => left.has(k)),
    kept: kept.length,
    offsetMs: offset === null ? null : round(offset, 1),
    spreadMs: spread === null ? null : round(spread, 1),
    frameIntervalMs: interval === null ? null : round(interval, 2),
    maxSpreadMs: round(limit, 1),
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
  if (matched.length < MIN_MATCHES) {
    return fail('few-matches', fewMatches(turns, moves.length));
  }
  if (offset === null || spread === null || spread > limit) {
    const rate = interval === null ? '' : ` at ${String(Math.round(1000 / interval))} fps`;
    return fail(
      'wide-spread',
      `spread over ${String(Math.round(limit))} ms${rate} (${String(analysis.spreadMs)} ms over ` +
        `the ${String(kept.length)} turns kept of ${String(matched.length)})`,
    );
  }
  return {
    ok: true,
    offsetMs: round(offset, 1),
    clapperboardResidualMs: round(spread, 1),
    clapperboardSamples: kept.length,
    samples: kept.map(sampleOf),
    analysis,
  };
}

/**
 * How many of `matched` turns' lags a check's spread leaves out (`DROPPED_PERCENT`): a fifth of
 * them, rounded up (1 of 4 or 5, 2 of 6 to 10, 3 of 11 to 15), and none of fewer than `MIN_MATCHES`,
 * a check that fails anyway.
 */
export function droppedCount(matched: number): number {
  return matched < MIN_MATCHES ? 0 : Math.ceil((matched * DROPPED_PERCENT) / 100);
}

/**
 * Which of the matched turns' `lags` (ms, in the order of the moves) the spread leaves out: the
 * `droppedCount` farthest from their median, measured to a hundredth of a ms; of two as far, the
 * later turn's first.
 */
function farthest(lags: readonly number[]): Set<number> {
  const count = droppedCount(lags.length);
  if (count === 0) {
    return new Set();
  }
  const middle = median([...lags].sort((a, b) => a - b));
  const away = lags.map((lag) => Math.round(Math.abs(lag - middle) * 100));
  const order = lags.map((_, k) => k).sort((p, q) => away[q] - away[p] || q - p);
  return new Set(order.slice(0, count));
}

/** The pair `session.json` keeps (its `samples`): the move and the event, without the lag. */
function sampleOf(pair: ClapperboardSample): ClapperboardSample {
  return { moveHostMs: pair.moveHostMs, onsetHostMs: pair.onsetHostMs };
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
 * The median interval between consecutive frames (`times`, increasing), ms; null with fewer than two
 * frames. A dropped frame makes one interval double, which the median passes over.
 */
function frameInterval(times: readonly number[]): number | null {
  const intervals = times
    .slice(1)
    .map((time, k) => time - times[k])
    .filter((interval) => interval > 0)
    .sort((a, b) => a - b);
  return intervals.length === 0 ? null : median(intervals);
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

/** A turn's window and analysis before the peaks are shared out (`detectClapperboard`). */
interface Candidate {
  /** Its analysis without an event: why it cannot be matched, or `miss` null while it can. */
  readonly analysis: TurnAnalysis;
  /** Its window's frames (indices): from `first` to before `end`. */
  readonly first: number;
  readonly end: number;
  /**
   * When it can be matched: its baseline, the level a peak must exceed, and its onset (the first
   * frame of the window that rises above the onset level); null otherwise.
   */
  readonly match: {
    readonly baseline: number;
    readonly peakLevel: number;
    readonly onset: number;
  } | null;
}

/**
 * Every single turn's analysis (`TurnAnalysis`): its window, baseline and onset, then its event, the
 * middle of its motion around the peak it is given (`sharePeaks`).
 */
function analyseTurns(
  turns: readonly number[],
  times: readonly number[],
  energies: readonly number[],
): TurnAnalysis[] {
  const candidates = turns.map((move) => candidateOf(move, times, energies));
  const peaks = sharePeaks(candidates, turns, times, energies);
  return candidates.map((candidate, k) => {
    const { analysis, match } = candidate;
    if (match === null) {
      return analysis;
    }
    const peak = peaks[k];
    if (peak < 0) {
      return { ...analysis, miss: 'taken' };
    }
    const event = round(motionCentre(times, energies, peak, match.baseline), 2);
    return {
      ...analysis,
      peak: energies[peak],
      peakHostMs: round(times[peak], 2),
      onsetHostMs: round(times[match.onset], 2),
      eventHostMs: event,
      lagMs: round(event - turns[k], 2),
      miss: null,
    };
  });
}

/**
 * The frame each turn's event is centred on (an index; -1 for none: the turn is `taken`), one turn
 * per motion. A turn that can be matched takes its window's peak (`peakFrame`); when two turns take
 * peaks within `EVENT_HALF_WINDOW_MS` of each other (the same frame, or the same motion seen through
 * two windows, which overlap for turns 0.5 to 1.1 s apart), the turn whose move is nearer its peak
 * keeps it (the earlier move at the same distance), and the other takes its window's peak more than
 * `EVENT_HALF_WINDOW_MS` from it, or none.
 */
function sharePeaks(
  candidates: readonly Candidate[],
  turns: readonly number[],
  times: readonly number[],
  energies: readonly number[],
): number[] {
  const held = candidates.map(() => -1);
  // The host times of the peaks each turn lost: it keeps away from them.
  const lost: number[][] = candidates.map(() => []);
  const waiting = candidates.flatMap((candidate, k) => (candidate.match === null ? [] : [k]));
  for (let k = waiting.shift(); k !== undefined; k = waiting.shift()) {
    const peak = peakFrame(candidates[k], times, energies, lost[k]);
    if (peak < 0) {
      continue;
    }
    const distance = Math.abs(times[peak] - turns[k]);
    const rivals = held.flatMap((frame, j) =>
      frame >= 0 && Math.abs(times[frame] - times[peak]) <= EVENT_HALF_WINDOW_MS ? [j] : [],
    );
    const keeper = rivals.find((j) => {
      const theirs = Math.abs(times[held[j]] - turns[j]);
      return theirs < distance || (theirs === distance && turns[j] < turns[k]);
    });
    if (keeper !== undefined) {
      lost[k].push(times[held[keeper]]);
      waiting.push(k);
      continue;
    }
    for (const j of rivals) {
      lost[j].push(times[peak]);
      held[j] = -1;
      waiting.push(j);
    }
    held[k] = peak;
  }
  return held;
}

/**
 * The peak a turn's event is centred on, among the frames of its window more than
 * `EVENT_HALF_WINDOW_MS` from each of the peaks it lost (`lost`, host ms): the first frame above its
 * peak level that no frame within `EVENT_HALF_WINDOW_MS` rises above (nor equals before it) and that
 * rises above the baseline by at least `EARLIER_PEAK_SHARE` of the highest frame's rise, which is
 * that frame when no earlier one does; -1 when no frame rises above the peak level.
 */
function peakFrame(
  candidate: Candidate,
  times: readonly number[],
  energies: readonly number[],
  lost: readonly number[],
): number {
  const { match } = candidate;
  if (match === null) {
    return -1;
  }
  const frames: number[] = [];
  for (let i = candidate.first; i < candidate.end; i++) {
    if (lost.every((at) => Math.abs(times[i] - at) > EVENT_HALF_WINDOW_MS)) {
      frames.push(i);
    }
  }
  let top = -1;
  for (const i of frames) {
    if (top < 0 || energies[i] > energies[top]) {
      top = i;
    }
  }
  if (top < 0 || energies[top] <= match.peakLevel) {
    return -1;
  }
  const least = match.baseline + EARLIER_PEAK_SHARE * (energies[top] - match.baseline);
  const isPeak = (i: number): boolean =>
    frames.every(
      (j) =>
        Math.abs(times[j] - times[i]) > EVENT_HALF_WINDOW_MS ||
        energies[j] < energies[i] ||
        (energies[j] === energies[i] && j >= i),
    );
  // The highest frame is a peak itself (the first of equals), so one is always found.
  return (
    frames.find((i) => energies[i] > match.peakLevel && energies[i] >= least && isPeak(i)) ?? top
  );
}

/**
 * The middle of a turn's motion, host ms: the centroid of `max(0, energy − baseline)²` over the frames
 * within `EVENT_HALF_WINDOW_MS` of the frame `peak`, at the frames' own times (nothing interpolated).
 * Squared, so that the frames of the motion's peak weigh most, and its tails, near the baseline, and
 * the frames around it that do not rise above the baseline, little or nothing.
 */
function motionCentre(
  times: readonly number[],
  energies: readonly number[],
  peak: number,
  baseline: number,
): number {
  const from = firstAtOrAfter(times, times[peak] - EVENT_HALF_WINDOW_MS);
  const to = firstAfter(times, times[peak] + EVENT_HALF_WINDOW_MS);
  let weights = 0;
  let moments = 0;
  for (let i = from; i < to; i++) {
    const above = Math.max(0, energies[i] - baseline);
    weights += above * above;
    // From the peak's time, so that the products stay small: host times are about 1.8e12 ms.
    moments += above * above * (times[i] - times[peak]);
  }
  // The peak rises above its peak level, which is above the baseline: the weights are never 0.
  return times[peak] + moments / weights;
}

/** One turn's window, baseline and onset (`detectClapperboard`), before any peak is shared out. */
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
    eventHostMs: null,
    lagMs: null,
    miss,
  });
  const cannot = (miss: TurnMiss): Candidate => ({
    analysis: unmatched(miss),
    first,
    end,
    match: null,
  });
  if (peakAt < 0) {
    return cannot('no-frames');
  }
  if (level === null) {
    return cannot('no-baseline');
  }
  if (energies[peakAt] <= level.peak) {
    return cannot('no-rise');
  }
  let onset = -1;
  for (let i = Math.max(first, 1); i < end && onset < 0; i++) {
    if (energies[i] > level.onset && energies[i - 1] <= level.onset) {
      onset = i;
    }
  }
  if (onset < 0) {
    return cannot('no-onset');
  }
  // Matched once the peaks are shared out, or `taken`.
  return {
    analysis: unmatched(null),
    first,
    end,
    match: { baseline: level.baseline, peakLevel: level.peak, onset },
  };
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
