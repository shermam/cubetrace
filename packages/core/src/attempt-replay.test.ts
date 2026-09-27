/// <reference types="node" />
// The acceptance test of docs/PLAN.md T1.4: every fixture solve replayed through the attempt
// machine, as the cube would report it, and every record validated against the schema of
// attempt.json (version 2 since T2.0, with the attempt's clock fit). Node's types for this file
// only (node:fs).
import { Ajv2020 } from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { AttemptPhase, AttemptRecord, Move, PhaseRecord, TimedMove } from './index';
import {
  ATTEMPT_SCHEMA,
  AttemptMachine,
  PHASE_NAMES,
  detectPhases,
  parseMove,
  parseMoves,
} from './index';

interface Fixture {
  scramble: string;
  scrambled: string;
  moves: TimedMove[];
  timeMs: number;
  inspectionMs: number;
  quarterTurns: number;
  sliceTurns: number;
  tps: number;
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

function num(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('A number was expected.');
  }
  return value;
}

const FIXTURES: Fixture[] = items(
  field(
    JSON.parse(readFileSync(new URL('../../../fixtures/solves.json', import.meta.url), 'utf8')),
    'solves',
  ),
).map((s) => ({
  scramble: text(field(s, 'scramble')),
  scrambled: text(field(s, 'scrambled_facelets')),
  moves: items(field(s, 'moves')).map((m) => ({
    m: parseMove(text(field(m, 'm'))),
    ms: num(field(m, 'ms')),
  })),
  timeMs: num(field(s, 'time_ms')),
  inspectionMs: num(field(s, 'inspection_ms')),
  quarterTurns: num(field(s, 'quarter_turns')),
  sliceTurns: num(field(s, 'slice_turns')),
  tps: num(field(s, 'tps')),
}));

const SESSION = '0b6f7c1d-2e3a-4f5b-8c9d-a1b2c3d4e5f6';
/** docs/PLAN.md T1.4: the replay of all the fixtures must finish in under 3 s. */
const BUDGET_MS = 3000;

/** A scramble as a smart cube reports it: every half turn as two quarter turns. */
function asQuarterTurns(moves: readonly Move[], clockwise: boolean): Move[] {
  return moves.flatMap((m): Move[] => {
    if (m.turns !== 2) {
      return [m];
    }
    const quarter: Move = { face: m.face, turns: clockwise ? 1 : 3 };
    return [quarter, quarter];
  });
}

interface Replay {
  record: AttemptRecord;
  /** The scramble's quarter turns, as fed. */
  scrambleMoves: number;
  /** The state after each move fed: `armed` exactly at the last scramble move, and so on. */
  states: string[];
}

/**
 * One fixture through the machine: the scramble's quarter turns 100 ms apart, ending the fixture's
 * inspection time before the solve, then the solve's moves with their cube ms as both clocks.
 */
function replay(s: Fixture, i: number): Replay {
  const scrambleMoves = asQuarterTurns(parseMoves(s.scramble), i % 2 === 0);
  const first = s.moves[0].ms;
  const scrambleDoneMs = first - s.inspectionMs;
  const machine = new AttemptMachine({
    session: SESSION,
    index: i + 1,
    scramble: s.scramble,
    scrambleShownMs: scrambleDoneMs - 100 * scrambleMoves.length - 2000,
  });
  const states: string[] = [];
  for (const [k, m] of scrambleMoves.entries()) {
    const ms = scrambleDoneMs - 100 * (scrambleMoves.length - 1 - k);
    states.push(machine.onMove({ m, cubeMs: ms, hostMs: ms, packetLast: true }));
  }
  for (const { m, ms } of s.moves) {
    states.push(machine.onMove({ m, cubeMs: ms, hostMs: ms, packetLast: true }));
  }
  return { record: machine.toRecord(), scrambleMoves: scrambleMoves.length, states };
}

/** Detected phases as attempt.json records them: the same, without their index into the moves. */
function recorded(phases: readonly PhaseRecord[]): AttemptPhase[] {
  return phases.map((p) => {
    const phase: Partial<PhaseRecord> = { ...p };
    delete phase.endMoveIndex;
    return phase as AttemptPhase;
  });
}

interface Run {
  replays: Replay[];
  /** Records that the schema rejects, with ajv's errors. */
  invalid: string[];
  elapsedMs: number;
}

/** Replays every fixture, records it and validates the record, timed. */
function run(): Run {
  const validate = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(ATTEMPT_SCHEMA);
  const started = performance.now();
  const replays = FIXTURES.map(replay);
  const invalid = replays.flatMap(({ record }, i) =>
    validate(record) ? [] : [`solves[${String(i)}]: ${JSON.stringify(validate.errors)}`],
  );
  return { replays, invalid, elapsedMs: performance.now() - started };
}

function roundTo2(x: number): number {
  return Math.round(x * 100) / 100;
}

describe('the 300 fixture solves replayed through the attempt machine', () => {
  let computed: Run | undefined;
  const result = (): Run => (computed ??= run());

  it(`replays, records and validates all of them in under ${String(BUDGET_MS)} ms`, () => {
    const { elapsedMs, invalid } = result();
    expect(FIXTURES).toHaveLength(300);
    console.log(
      `Replayed, recorded and validated ${String(FIXTURES.length)} solves in ${elapsedMs.toFixed(0)} ms.`,
    );
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(invalid).toEqual([]);
  });

  it('arms at the last scramble move and solves at the last solve move', () => {
    for (const [i, { states, scrambleMoves }] of result().replays.entries()) {
      const expected = states.map((_, k) =>
        k < scrambleMoves - 1
          ? 'scrambling'
          : k === scrambleMoves - 1
            ? 'armed'
            : k === states.length - 1
              ? 'solved'
              : 'solving',
      );
      expect(states, `solves[${String(i)}]`).toEqual(expected);
    }
  });

  it('records a solve that replays, with its eight phases, as detectPhases finds them', () => {
    for (const [i, s] of FIXTURES.entries()) {
      const { record, scrambleMoves } = result().replays[i];
      const report = detectPhases(s.scrambled, s.moves);
      const at = `solves[${String(i)}]`;
      expect(record.scrambledFacelets, at).toBe(s.scrambled);
      expect(record.result, at).toMatchObject({
        status: 'solved',
        replayOk: true,
        scrambleCorrected: false,
        scrambleExtraMoves: 0,
      });
      expect(
        record.phases.map((p) => p.name),
        at,
      ).toEqual(PHASE_NAMES);
      expect(record.crossFace, at).toBe(report.crossFace);
      expect(record.phases, at).toEqual(recorded(report.phases));
      expect(record.moves.length, at).toBe(scrambleMoves + s.moves.length);
      expect(record.moves.filter((m) => m.phase === 'solve').length, at).toBe(s.moves.length);
    }
  });

  it('fits the clock of every attempt: cube ms on both clocks give a = 1, b = 0 and no residual', () => {
    for (const [i, { record }] of result().replays.entries()) {
      const at = `solves[${String(i)}]`;
      const clock = record.clock;
      expect(clock, at).not.toBeNull();
      expect(Math.abs((clock?.a ?? 0) - 1), at).toBeLessThan(1e-6);
      expect(Math.abs(clock?.b ?? 1), at).toBeLessThan(1e-6);
      expect(clock?.residualP95Ms, at).toBe(0);
      // Every move is the newest of its packet, scramble and solve alike.
      expect(clock?.samples, at).toBe(record.moves.length);
    }
  });

  it("agrees with Cubeast's time, inspection and quarter turns; tps is ours", () => {
    for (const [i, s] of FIXTURES.entries()) {
      const { result: r, events } = result().replays[i].record;
      const at = `solves[${String(i)}]`;
      const first = s.moves[0].ms;
      const last = s.moves[s.moves.length - 1].ms;
      expect(r.timeMs, at).toBe(last - first);
      expect(r.timeMs, at).toBe(s.timeMs);
      expect(events.solveStart, at).toBe(first);
      expect(r.inspectionMs, at).toBe(s.inspectionMs);
      // Cubeast's quarter_turns counts what we count: the fixtures' moves are all quarter turns.
      expect(r.movesQtm, at).toBe(s.quarterTurns);
      expect(r.tps, at).toBe(roundTo2(s.quarterTurns / (s.timeMs / 1000)));
      // Cubeast's tps is in its own metric: slice_turns, where it merges two turns of a face into
      // one double and two opposite turns into one slice (docs/DATA-MODEL.md §7).
      expect(s.tps, at).toBe(roundTo2(s.sliceTurns / (s.timeMs / 1000)));
    }
  });
});
