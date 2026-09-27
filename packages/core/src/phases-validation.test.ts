/// <reference types="node" />
// The acceptance test of docs/PLAN.md T1.3: detectPhases on the 300 fixture solves, each phase's
// end compared with Cubeast's cumulative step time. Node's types for this file only (node:fs).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { PhaseReport, TimedMove } from './index';
import { PHASE_NAMES, detectPhases, parseMove } from './index';

interface CubeastStep {
  name: string;
  /** Cubeast's end of the step, in ms from the solve's start. */
  cumulativeTime: number;
}

interface Fixture {
  scrambled: string;
  moves: TimedMove[];
  timeMs: number;
  steps: CubeastStep[];
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`An object with "${key}" was expected.`);
  }
  return (value as Record<string, unknown>)[key];
}

function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('An array was expected.');
  }
  return value as unknown[];
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('A string was expected.');
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('An integer was expected.');
  }
  return value;
}

const FIXTURES: Fixture[] = items(
  field(
    JSON.parse(readFileSync(new URL('../../../fixtures/solves.json', import.meta.url), 'utf8')),
    'solves',
  ),
).map((s) => ({
  scrambled: text(field(s, 'scrambled_facelets')),
  moves: items(field(s, 'moves')).map((m) => ({
    m: parseMove(text(field(m, 'm'))),
    ms: integer(field(m, 'ms')),
  })),
  timeMs: integer(field(s, 'time_ms')),
  steps: items(field(s, 'cubeast_steps')).map((step) => ({
    name: text(field(step, 'name')),
    cumulativeTime: integer(field(step, 'cumulative_time')),
  })),
}));

/** Cubeast's step names, in the order of PHASE_NAMES. */
const CUBEAST_STEPS = [
  'Cross',
  'F2L Slot 1',
  'F2L Slot 2',
  'F2L Slot 3',
  'F2L Slot 4',
  'EOLL',
  'OCLL',
  'PLL',
];

const TOLERANCE_MS = 1;
const THRESHOLD = 0.95;

interface Mismatch {
  fixture: number;
  phase: string;
  ours: number | null;
  cubeast: number;
  report: PhaseReport;
}

interface Comparison {
  elapsedMs: number;
  /** Per phase, in PHASE_NAMES order, the fixtures whose boundary agrees. */
  agree: number[];
  mismatches: Mismatch[];
}

/** Runs the detector on every fixture (timed) and compares each boundary with Cubeast's. */
function compare(): Comparison {
  const start = performance.now();
  const reports = FIXTURES.map((s) => detectPhases(s.scrambled, s.moves));
  const elapsedMs = performance.now() - start;
  const agree = PHASE_NAMES.map(() => 0);
  const mismatches: Mismatch[] = [];
  for (const [i, s] of FIXTURES.entries()) {
    const report = reports[i];
    const first = s.moves[0].ms;
    for (const [k, phase] of PHASE_NAMES.entries()) {
      const record = report.phases.at(k);
      const ours = record === undefined ? null : record.endMs - first;
      const cubeast = s.steps[k].cumulativeTime;
      if (ours !== null && Math.abs(ours - cubeast) <= TOLERANCE_MS) {
        agree[k] += 1;
      } else {
        mismatches.push({ fixture: i, phase, ours, cubeast, report });
      }
    }
  }
  return { elapsedMs, agree, mismatches };
}

function table({ elapsedMs, agree, mismatches }: Comparison): string {
  const pairs = FIXTURES.length * PHASE_NAMES.length;
  const total = agree.reduce((a, b) => a + b, 0);
  const percent = (n: number, of: number): string => `${((100 * n) / of).toFixed(1)}%`;
  return [
    `Phase boundaries within ±${String(TOLERANCE_MS)} ms of Cubeast (${String(FIXTURES.length)} solves, ${elapsedMs.toFixed(0)} ms):`,
    '| phase | agree | share |',
    '|---|---|---|',
    ...PHASE_NAMES.map(
      (phase, k) =>
        `| ${phase} | ${String(agree[k])}/${String(FIXTURES.length)} | ${percent(agree[k], FIXTURES.length)} |`,
    ),
    `| all | ${String(total)}/${String(pairs)} | ${percent(total, pairs)} |`,
    ...(mismatches.length === 0 ? [] : ['Mismatches (fixture, phase: ours vs Cubeast, ms):']),
    ...mismatches.map(
      (m) =>
        `  solves[${String(m.fixture)}] ${m.phase}: ${String(m.ours)} vs ${String(m.cubeast)} (cross ${String(m.report.crossFace)})`,
    ),
  ].join('\n');
}

describe('agreement with Cubeast on the 300 fixture solves', () => {
  let comparison: Comparison | undefined;
  const result = (): Comparison => (comparison ??= compare());

  it("measures Cubeast's times from the first move", () => {
    // The last step ends at time_ms, which is the time from the first move to the last one; the
    // cross has no recognition time. So a phase's end compares with its cumulative time as
    // endMs - (first move's ms).
    expect(FIXTURES).toHaveLength(300);
    for (const s of FIXTURES) {
      expect(s.steps.map((step) => step.name)).toEqual(CUBEAST_STEPS);
      const first = s.moves[0].ms;
      const last = s.moves[s.moves.length - 1].ms;
      expect(s.timeMs).toBe(last - first);
      expect(s.steps[7].cumulativeTime).toBe(s.timeMs);
    }
  });

  it('matches every (fixture, phase) boundary within ±1 ms, in under 2 s', () => {
    const r = result();
    console.log(table(r));
    const total = r.agree.reduce((a, b) => a + b, 0);
    expect(r.elapsedMs).toBeLessThan(2000);
    // The acceptance threshold of docs/PLAN.md T1.3, then what the detector actually achieves.
    expect(total / (FIXTURES.length * PHASE_NAMES.length)).toBeGreaterThanOrEqual(THRESHOLD);
    expect(r.mismatches).toEqual([]);
  });
});
