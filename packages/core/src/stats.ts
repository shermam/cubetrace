// Session statistics (docs/PLAN.md T1.4): times in ms, a DNF as Number.POSITIVE_INFINITY, so that it
// sorts as the worst result.
import type { AttemptRecord } from './attempt';
import type { PhaseName } from './phases';
import { PHASE_NAMES } from './phases';

/** The DNF in a list of times. */
export const DNF = Number.POSITIVE_INFINITY;

/** The attempts' times in the order given: `timeMs` of a solve, {@link DNF} for a DNF. */
export function attemptTimes(attempts: readonly AttemptRecord[]): number[] {
  return attempts.map(({ result }) =>
    result.status === 'solved' && result.timeMs !== null ? result.timeMs : DNF,
  );
}

/**
 * The mean of all the results. Nothing is dropped, so a DNF has no time to average: null if any
 * result is a DNF, as in a WCA mean of 3, and null when there are none.
 */
export function mean(ms: readonly number[]): number | null {
  if (ms.length === 0 || ms.includes(DNF)) {
    return null;
  }
  return sum(ms) / ms.length;
}

/** The best (smallest) result; DNFs are ignored, and null if nothing else is left. */
export function best(ms: readonly number[]): number | null {
  const times = ms.filter((t) => t !== DNF);
  return times.length === 0 ? null : times.reduce((a, b) => Math.min(a, b));
}

/**
 * The WCA trimmed average of the last `n` results: the best and the worst are dropped and the rest
 * averaged. One DNF counts as the worst result and is dropped; with two or more the average is DNF,
 * returned as null. Null too with fewer than `n` results. Not rounded (the WCA rounds averages to
 * hundredths of a second when displaying them).
 */
export function aoN(ms: readonly number[], n: 5 | 12 | 100): number | null {
  if (ms.length < n) {
    return null;
  }
  const last = ms.slice(-n);
  if (last.filter((t) => t === DNF).length > 1) {
    return null;
  }
  const kept = [...last].sort((a, b) => a - b).slice(1, -1);
  return sum(kept) / kept.length;
}

/** A phase's mean duration (`endMs − startMs`) and mean number of moves. */
export interface PhaseAverage {
  meanMs: number;
  meanMoves: number;
}

/**
 * The mean duration and moves of each phase over the solved attempts whose eight phases were all
 * found (a solve whose moves do not replay can miss some), so that the eight means add up to the
 * mean time of the same solves. Null when there is no such attempt.
 */
export function phaseAverages(
  attempts: readonly AttemptRecord[],
): Record<PhaseName, PhaseAverage> | null {
  const complete = attempts.filter(
    (a) =>
      a.result.status === 'solved' &&
      a.phases.length === PHASE_NAMES.length &&
      a.phases.every((p, k) => p.name === PHASE_NAMES[k]),
  );
  if (complete.length === 0) {
    return null;
  }
  const averages = PHASE_NAMES.map((name, k): [PhaseName, PhaseAverage] => {
    const phases = complete.map((a) => a.phases[k]);
    return [
      name,
      {
        meanMs: sum(phases.map((p) => p.endMs - p.startMs)) / complete.length,
        meanMoves: sum(phases.map((p) => p.moves)) / complete.length,
      },
    ];
  });
  return Object.fromEntries(averages) as Record<PhaseName, PhaseAverage>;
}

function sum(ms: readonly number[]): number {
  return ms.reduce((a, b) => a + b, 0);
}
