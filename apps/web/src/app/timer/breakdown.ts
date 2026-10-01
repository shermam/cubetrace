// The CFOP breakdown as bars (docs/PLAN.md, T1.6b): each phase a segment whose length is its
// duration, in the order of PHASE_NAMES. Pure geometry, in percent of the bar's width, so that the
// chart and the solve list's mini bars only draw it.
import type { AttemptRecord, PhaseAverage, PhaseName } from '@cubetrace/core';
import { PHASE_NAMES } from '@cubetrace/core';

import { formatAverage, formatTime } from '../shared/format-time';

export const PHASE_LABELS: Readonly<Record<PhaseName, string>> = {
  cross: 'Cross',
  f2l1: 'F2L 1',
  f2l2: 'F2L 2',
  f2l3: 'F2L 3',
  f2l4: 'F2L 4',
  eoll: 'EOLL',
  ocll: 'OCLL',
  pll: 'PLL',
};

/**
 * One fixed colour per phase: the eight categorical hues, in their order, of the data-viz palette
 * stepped for dark surfaces. Validated on the app's surface (#161b22): every colour at 3:1 or more
 * against it, adjacent pairs apart by ΔE 8.4 or more (OKLab ×100) under protanopia and
 * deuteranopia, 19.3 or more for full-colour vision. Adjacent segments also have a gap between them.
 */
export const PHASE_COLOURS: Readonly<Record<PhaseName, string>> = {
  cross: '#3987e5',
  f2l1: '#d95926',
  f2l2: '#199e70',
  f2l3: '#c98500',
  f2l4: '#d55181',
  eoll: '#008300',
  ocll: '#9085e9',
  pll: '#e66767',
};

/** A phase's duration and moves, the input of a bar. */
export interface PhaseAmount {
  readonly name: PhaseName;
  readonly ms: number;
  readonly moves: number;
  /** F2L phases: the slot of the pair (`FR`). */
  readonly slot?: string;
}

export interface BarSegment extends PhaseAmount {
  readonly label: string;
  readonly colour: string;
  /** Where the segment starts and how long it is, in percent of the bar's full width. */
  readonly x: number;
  readonly width: number;
  /** The last segment with a length: the bar's end, which is drawn rounded. */
  readonly end: boolean;
  /** For its tooltip: "F2L 1 (FR): 2345 ms, 9 moves". */
  readonly title: string;
}

/**
 * The segments of `phases`, laid end to end on a scale where `scaleMs` fills 100%. A phase of
 * 0 ms (a skip) has width 0 but is still there. With no scale (0 ms), every width is 0.
 */
export function barSegments(phases: readonly PhaseAmount[], scaleMs: number): BarSegment[] {
  const widths = phases.map((phase) => (scaleMs > 0 ? (Math.max(0, phase.ms) / scaleMs) * 100 : 0));
  const end = widths.findLastIndex((width) => width > 0);
  let x = 0;
  return phases.map((phase, k) => {
    const segment: BarSegment = {
      ...phase,
      label: PHASE_LABELS[phase.name],
      colour: PHASE_COLOURS[phase.name],
      x,
      width: widths[k],
      end: k === end,
      title: segmentTitle(phase),
    };
    x += widths[k];
    return segment;
  });
}

function segmentTitle(phase: PhaseAmount): string {
  const slot = phase.slot === undefined ? '' : ` (${phase.slot})`;
  const moves = Math.round(phase.moves * 10) / 10;
  return `${PHASE_LABELS[phase.name]}${slot}: ${String(Math.round(phase.ms))} ms, ${String(moves)} ${moves === 1 ? 'move' : 'moves'}`;
}

/** The phases of an attempt as bar input: each phase's duration (`endMs − startMs`) and moves. */
export function attemptPhases(attempt: Pick<AttemptRecord, 'phases'>): PhaseAmount[] {
  return attempt.phases.map((p) =>
    p.slot === undefined
      ? { name: p.name, ms: p.endMs - p.startMs, moves: p.moves }
      : { name: p.name, ms: p.endMs - p.startMs, moves: p.moves, slot: p.slot },
  );
}

/** Session averages as bar input, in the order of PHASE_NAMES. */
export function averagePhases(averages: Readonly<Record<PhaseName, PhaseAverage>>): PhaseAmount[] {
  return PHASE_NAMES.map((name) => ({
    name,
    ms: averages[name].meanMs,
    moves: averages[name].meanMoves,
  }));
}

/** One bar of the breakdown chart. */
export interface BreakdownBar {
  readonly key: 'last' | 'average';
  readonly label: string;
  /** The bar's total, as the timer writes it. */
  readonly total: string;
  readonly segments: readonly BarSegment[];
}

/**
 * The chart's bars: the last solve and the session average (the phase means of the solves whose
 * eight phases were all found, `phaseAverages`), on one scale, the longer of the two filling the
 * width, so that they compare.
 */
export function breakdownBars(
  last: AttemptRecord | null,
  averages: Readonly<Record<PhaseName, PhaseAverage>> | null,
  averagedSolves: number,
): BreakdownBar[] {
  const lastPhases = last === null ? null : attemptPhases(last);
  const averagePhaseList = averages === null ? null : averagePhases(averages);
  const total = (phases: readonly PhaseAmount[] | null): number =>
    phases === null ? 0 : phases.reduce((sum, p) => sum + Math.max(0, p.ms), 0);
  const scale = Math.max(total(lastPhases), total(averagePhaseList));
  const bars: BreakdownBar[] = [];
  if (last !== null && lastPhases !== null) {
    bars.push({
      key: 'last',
      label: `Last solve (#${String(last.index)})`,
      total: formatTime(last.result.timeMs ?? total(lastPhases)),
      segments: barSegments(lastPhases, scale),
    });
  }
  if (averagePhaseList !== null) {
    bars.push({
      key: 'average',
      label: `Session average (${String(averagedSolves)} ${averagedSolves === 1 ? 'solve' : 'solves'})`,
      total: formatAverage(total(averagePhaseList)),
      segments: barSegments(averagePhaseList, scale),
    });
  }
  return bars;
}

/** The solves that `phaseAverages` averages: solved, with all eight phases in order. */
export function averagedSolves(attempts: readonly AttemptRecord[]): number {
  return attempts.filter(
    (a) =>
      a.result.status === 'solved' &&
      a.phases.length === PHASE_NAMES.length &&
      a.phases.every((p, k) => p.name === PHASE_NAMES[k]),
  ).length;
}
