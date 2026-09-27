// The statistics above the solve list (docs/PLAN.md, T1.6b) and in a session page's header (T2.7),
// from @cubetrace/core's stats.ts, with a DNF counted as that module documents it: the worst result
// (Infinity).
import type { AttemptRecord } from '@cubetrace/core';
import { DNF, aoN, attemptTimes, best, mean } from '@cubetrace/core';

import { formatAverage, formatTime } from '../shared/format-time';

/** The session's statistics, written as the page shows them (`–` when there is nothing yet). */
export interface SessionStats {
  readonly count: number;
  /** How many of them are DNFs. */
  readonly dnf: number;
  /** The mean of every attempt: `DNF` as soon as one is a DNF (stats.ts `mean`). */
  readonly mean: string;
  /** The best time; DNFs are ignored. */
  readonly best: string;
  /**
   * The WCA average of the last 5, of the last 12 and of the last 100: `DNF` with two DNFs among
   * them (stats.ts `aoN`).
   */
  readonly ao5: string;
  readonly ao12: string;
  readonly ao100: string;
}

export function sessionStats(attempts: readonly AttemptRecord[]): SessionStats {
  const times = attemptTimes(attempts);
  const average = mean(times);
  const fastest = best(times);
  return {
    count: attempts.length,
    dnf: times.filter((ms) => ms === DNF).length,
    mean: average !== null ? formatAverage(average) : times.length > 0 ? 'DNF' : '–',
    best: fastest === null ? '–' : formatTime(fastest),
    ao5: averageOf(times, 5),
    ao12: averageOf(times, 12),
    ao100: averageOf(times, 100),
  };
}

function averageOf(times: readonly number[], n: 5 | 12 | 100): string {
  if (times.length < n) {
    return '–';
  }
  const average = aoN(times, n);
  return average === null ? 'DNF' : formatAverage(average);
}

/** The mean shown for a session on the Sessions page: as {@link SessionStats.mean}. */
export function sessionMean(attempts: readonly AttemptRecord[]): string {
  return sessionStats(attempts).mean;
}
