import type { AttemptEvents, AttemptRecord, AttemptState } from '@cubetrace/core';

import {
  INSPECTION_MS,
  inspectionLeft,
  timerDisplay,
  type TimerDisplayInput,
} from './timer-display';

const EVENTS: AttemptEvents = {
  scrambleShown: 1000,
  scrambleStart: 2000,
  scrambleDone: 5000,
  pickup: null,
  solveStart: null,
  solveEnd: null,
};

function input(
  state: AttemptState | null,
  events: Partial<AttemptEvents> = {},
  rest: Partial<TimerDisplayInput> = {},
): TimerDisplayInput {
  return {
    attempt: state === null ? null : { state, events: { ...EVENTS, ...events } },
    lastResult: null,
    nowMs: 0,
    pausedAtMs: null,
    inspection: false,
    ...rest,
  };
}

function result(status: 'solved' | 'dnf', timeMs: number | null): AttemptRecord {
  return { result: { status, timeMs } } as unknown as AttemptRecord;
}

describe('timerDisplay', () => {
  it('shows 0.00 before the first result', () => {
    expect(timerDisplay(input(null))).toEqual({ text: '0.00', kind: 'idle', overtime: false });
    expect(timerDisplay(input('scrambling'))).toEqual({
      text: '0.00',
      kind: 'idle',
      overtime: false,
    });
  });

  it('runs from solveStart, frame by frame, and stops where the cube disconnected', () => {
    const solving = { solveStart: 10_000 };
    expect(timerDisplay(input('solving', solving, { nowMs: 9_990 })).text).toBe('0.00');
    expect(timerDisplay(input('solving', solving, { nowMs: 22_345 }))).toEqual({
      text: '12.34',
      kind: 'running',
      overtime: false,
    });
    expect(timerDisplay(input('solving', solving, { nowMs: 99_000, pausedAtMs: 15_000 }))).toEqual({
      text: '5.00',
      kind: 'paused',
      overtime: false,
    });
  });

  it('is ready at 0.00 when armed, or counts the inspection down from the pickup or the arming', () => {
    expect(timerDisplay(input('armed', {}, { nowMs: 9_000 })).kind).toBe('ready');
    const inspecting = { inspection: true, nowMs: 5_000 };
    expect(timerDisplay(input('armed', {}, inspecting)).text).toBe('15');
    expect(timerDisplay(input('armed', {}, { ...inspecting, nowMs: 5_001 })).text).toBe('15');
    expect(timerDisplay(input('armed', {}, { ...inspecting, nowMs: 6_000 })).text).toBe('14');
    expect(
      timerDisplay(input('armed', { pickup: 8_000 }, { ...inspecting, nowMs: 9_500 })).text,
    ).toBe('14');
    expect(
      timerDisplay(input('armed', {}, { ...inspecting, nowMs: 5_000 + INSPECTION_MS })),
    ).toEqual({ text: '0', kind: 'inspection', overtime: true });
  });

  it('freezes at the last result: its time, or DNF', () => {
    expect(timerDisplay(input('scrambling', {}, { lastResult: result('solved', 12_345) }))).toEqual(
      { text: '12.34', kind: 'solved', overtime: false },
    );
    expect(timerDisplay(input('dnf', {}, { lastResult: result('dnf', null) }))).toEqual({
      text: 'DNF',
      kind: 'dnf',
      overtime: false,
    });
  });
});

describe('inspectionLeft', () => {
  it('rounds the seconds left up, down to 0', () => {
    expect([0, 1, 999, 1000, 14_001, 15_000, 20_000, -5].map(inspectionLeft)).toEqual([
      15, 15, 15, 14, 1, 0, 0, 15,
    ]);
  });
});
