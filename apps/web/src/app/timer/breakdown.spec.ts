import { PHASE_NAMES, type PhaseName } from '@cubetrace/core';

import { testAttempt } from '../session/session-testing';
import {
  PHASE_COLOURS,
  PHASE_LABELS,
  attemptPhases,
  barSegments,
  breakdownBars,
  type PhaseAmount,
} from './breakdown';

function phases(ms: readonly number[]): PhaseAmount[] {
  return ms.map((duration, k) => ({ name: PHASE_NAMES[k], ms: duration, moves: k + 1 }));
}

describe('barSegments', () => {
  it('lays the phases end to end, each as long as its share of the scale', () => {
    const segments = barSegments(phases([1000, 500, 500, 1000, 0, 250, 250, 500]), 4000);
    expect(segments.map((s) => s.width)).toEqual([25, 12.5, 12.5, 25, 0, 6.25, 6.25, 12.5]);
    expect(segments.map((s) => s.x)).toEqual([0, 25, 37.5, 50, 75, 75, 81.25, 87.5]);
    expect(segments.map((s) => s.name)).toEqual(PHASE_NAMES);
    expect(segments.map((s) => s.colour)).toEqual(PHASE_NAMES.map((n) => PHASE_COLOURS[n]));
    expect(segments.map((s) => s.end)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('fills part of the bar on a longer scale, and rounds the last segment with a length', () => {
    const segments = barSegments(phases([1000, 1000, 0]), 4000);
    expect(segments.map((s) => s.x + s.width)).toEqual([25, 50, 50]);
    expect(segments.map((s) => s.end)).toEqual([false, true, false]);
    expect(barSegments(phases([0, 0]), 0).map((s) => s.width)).toEqual([0, 0]);
  });

  it('says the duration and the moves in each tooltip', () => {
    const [cross, pair] = barSegments(
      [
        { name: 'cross', ms: 1234.4, moves: 8 },
        { name: 'f2l1', ms: 2000, moves: 1, slot: 'FR' },
      ],
      3234.4,
    );
    expect(cross.title).toBe('Cross: 1234 ms, 8 moves');
    expect(pair.title).toBe('F2L 1 (FR): 2000 ms, 1 move');
  });
});

describe('breakdownBars', () => {
  const averages = Object.fromEntries(
    PHASE_NAMES.map((name) => [name, { meanMs: 500, meanMoves: 7.25 }]),
  ) as Record<PhaseName, { meanMs: number; meanMoves: number }>;

  it('draws the last solve and the session average on one scale', () => {
    const last = testAttempt(3, 2000);
    const bars = breakdownBars(last, averages, 2);
    expect(bars.map((bar) => [bar.key, bar.label, bar.total])).toEqual([
      ['last', 'Last solve (#3)', '2.00'],
      ['average', 'Session average (2 solves)', '4.00'],
    ]);
    // The average (8 × 500 ms) is the longer: it fills the width, the last solve half of it.
    expect(bars[1].segments.map((s) => s.width)).toEqual(PHASE_NAMES.map(() => 12.5));
    const lastEnd = bars[0].segments.reduce((end, s) => Math.max(end, s.x + s.width), 0);
    expect(lastEnd).toBeCloseTo(50, 9);
    expect(bars[1].segments[0].title).toBe('Cross: 500 ms, 7.3 moves');
  });

  it('has no bars without a solve', () => {
    expect(breakdownBars(null, null, 0)).toEqual([]);
  });

  it("reads an attempt's phases as durations and moves", () => {
    const attempt = testAttempt(1, 3000);
    const amounts = attemptPhases(attempt);
    expect(amounts.map((p) => p.name)).toEqual(PHASE_NAMES);
    expect(amounts.reduce((sum, p) => sum + p.ms, 0)).toBe(3000);
    expect(amounts.reduce((sum, p) => sum + p.moves, 0)).toBe(3);
    expect(Object.keys(PHASE_LABELS)).toEqual(PHASE_NAMES);
  });
});
