// What the big timer shows (docs/PLAN.md, T1.6b): computed from the current attempt, the last result
// and the time of the latest animation frame, so that it can be tested without a browser.
import type { AttemptEvents, AttemptRecord, AttemptState } from '@cubetrace/core';

import { formatTime } from '../shared/format-time';

/** The WCA inspection: 15 s from the moment the cube is shown (here: armed, or picked up). */
export const INSPECTION_MS = 15_000;

/**
 * `idle`: no attempt timed yet (`0.00`). `ready`: armed, the first turn starts the timer (`0.00`).
 * `inspection`: armed with the inspection setting on, the seconds left. `running`: solving.
 * `paused`: solving, but the cube disconnected. `solved` and `dnf`: the last result, frozen.
 */
export type TimerDisplayKind =
  'idle' | 'ready' | 'inspection' | 'running' | 'paused' | 'solved' | 'dnf';

export interface TimerDisplay {
  readonly text: string;
  readonly kind: TimerDisplayKind;
  /** Inspection only: the 15 s are over (shown, not penalized: no +2 or DNF in v1). */
  readonly overtime: boolean;
}

export interface TimerDisplayInput {
  /** The current attempt, if any: its state and events (host ms). */
  readonly attempt: { readonly state: AttemptState; readonly events: AttemptEvents } | null;
  /** The last attempt that ended while this page was open; its time stays until the next solve. */
  readonly lastResult: AttemptRecord | null;
  /** The host time of the latest animation frame. */
  readonly nowMs: number;
  /** When the cube disconnected during the solve: the running time stops there. */
  readonly pausedAtMs: number | null;
  /** The 15-second inspection setting. */
  readonly inspection: boolean;
}

/** Whole seconds of inspection left after `elapsedMs`, rounded up: 15 at the start, then 0. */
export function inspectionLeft(elapsedMs: number): number {
  return Math.max(0, Math.ceil((INSPECTION_MS - Math.max(0, elapsedMs)) / 1000));
}

/**
 * The timer's text: the running time from `solveStart` while solving (stopped at `pausedAtMs` while
 * the cube is away); while armed, the inspection countdown from `pickup ?? scrambleDone` when
 * inspection is on, else `0.00`; otherwise the last result, `timeMs` frozen (or `DNF`), and `0.00`
 * before the first one.
 */
export function timerDisplay(input: TimerDisplayInput): TimerDisplay {
  const { attempt, lastResult, nowMs, pausedAtMs, inspection } = input;
  if (attempt?.state === 'solving' && attempt.events.solveStart !== null) {
    const end = pausedAtMs ?? nowMs;
    return {
      text: formatTime(end - attempt.events.solveStart),
      kind: pausedAtMs === null ? 'running' : 'paused',
      overtime: false,
    };
  }
  if (attempt?.state === 'armed') {
    const from = attempt.events.pickup ?? attempt.events.scrambleDone;
    if (inspection && from !== null) {
      const elapsed = nowMs - from;
      return {
        text: String(inspectionLeft(elapsed)),
        kind: 'inspection',
        overtime: elapsed >= INSPECTION_MS,
      };
    }
    return { text: formatTime(0), kind: 'ready', overtime: false };
  }
  if (lastResult !== null) {
    const { status, timeMs } = lastResult.result;
    return status === 'solved' && timeMs !== null
      ? { text: formatTime(timeMs), kind: 'solved', overtime: false }
      : { text: 'DNF', kind: 'dnf', overtime: false };
  }
  return { text: formatTime(0), kind: 'idle', overtime: false };
}
