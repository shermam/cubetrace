/// <reference types="node" />
// Node's types for this file only: it reads a fixture with node:fs (see cube.test.ts).
import { Ajv2020 } from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type {
  AttemptMachine as Machine,
  AttemptPhase,
  AttemptRecord,
  Facelets,
  PhaseRecord,
  TimedMove,
} from './index';
import {
  ATTEMPT_SCHEMA,
  AttemptMachine,
  CubeClockFit,
  NotationError,
  SOLVED,
  applyMoves,
  detectPhases,
  inverseSequence,
  parseMove,
  parseMoves,
  quarterTurns,
  scrambleTarget,
} from './index';

// ---- One fixture solve (read-only, docs/DATA-MODEL.md §8), for the DNF and cross-face cases ----

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`An object with "${key}" was expected.`);
  }
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('A string was expected.');
  }
  return value;
}

const FIRST: unknown = (() => {
  const solves = field(
    JSON.parse(readFileSync(new URL('../../../fixtures/solves.json', import.meta.url), 'utf8')),
    'solves',
  );
  if (!Array.isArray(solves)) {
    throw new Error('solves.json: an array "solves" was expected.');
  }
  return (solves as unknown[])[0];
})();
/** Fixture 0: its scramble and its solve's moves on the cube clock (a D cross). */
const FIXTURE = {
  scramble: text(field(FIRST, 'scramble')),
  moves: (field(FIRST, 'moves') as unknown[]).map((m) => ({
    m: parseMove(text(field(m, 'm'))),
    ms: Number(field(m, 'ms')),
  })),
};

// ---- Helpers ----

const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const SCRAMBLE = 'R U F';
const SOLUTION = "F' U' R'";

const validate = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile<AttemptRecord>(
  ATTEMPT_SCHEMA,
);

/** The record, after checking it against the schema of attempt.json. */
function validRecord(machine: Machine): AttemptRecord {
  const record = machine.toRecord();
  const valid = validate(record);
  expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
  expect(valid).toBe(true);
  return record;
}

function machine(
  scramble = SCRAMBLE,
  extra: Partial<ConstructorParameters<typeof Machine>[0]> = {},
) {
  return new AttemptMachine({
    session: SESSION,
    index: 1,
    scramble,
    scrambleShownMs: 1000,
    ...extra,
  });
}

/** Feeds the moves `stepMs` apart from `startMs`, with the same time on both clocks. */
function feed(m: Machine, moves: string, startMs: number, stepMs = 100): void {
  for (const [i, move] of parseMoves(moves).entries()) {
    const ms = startMs + i * stepMs;
    m.onMove({ m: move, cubeMs: ms, hostMs: ms });
  }
}

/** Detected phases as attempt.json records them: the same, without their index into the moves. */
function recorded(phases: readonly PhaseRecord[]): AttemptPhase[] {
  return phases.map((p) => {
    const phase: Partial<PhaseRecord> = { ...p };
    delete phase.endMoveIndex;
    return phase as AttemptPhase;
  });
}

/** A machine armed on SCRAMBLE: its moves at 1100, 1200 and 1300. */
function armed(): Machine {
  const m = machine();
  feed(m, SCRAMBLE, 1100);
  return m;
}

// ---- Tests ----

describe('AttemptMachine', () => {
  it('goes from scrambling to armed to solving to solved, and records the events and the result', () => {
    const m = machine();
    expect(m.state).toBe('scrambling');
    expect(m.facelets).toBe(SOLVED);
    expect(m.scrambleProgress).toMatchObject({ matched: 0, total: 3, done: false });

    expect(m.onMove({ m: parseMove('R'), cubeMs: 50, hostMs: 1100 })).toBe('scrambling');
    expect(m.events.scrambleStart).toBe(1100);
    expect(m.onMove({ m: parseMove('U'), cubeMs: 150, hostMs: 1200 })).toBe('scrambling');
    expect(m.onMove({ m: parseMove('F'), cubeMs: 250, hostMs: 1300 })).toBe('armed');
    expect(m.facelets).toBe(scrambleTarget(SCRAMBLE));
    expect(m.scrambleProgress).toMatchObject({ matched: 3, done: true });
    expect(m.events).toMatchObject({ scrambleDone: 1300, solveStart: null });

    m.onPickup(1500);
    expect(m.onMove({ m: parseMove("F'"), cubeMs: 1050, hostMs: 2000 })).toBe('solving');
    expect(m.onMove({ m: parseMove("U'"), cubeMs: 1150, hostMs: 2100 })).toBe('solving');
    expect(m.onMove({ m: parseMove("R'"), cubeMs: 1300, hostMs: 2250 })).toBe('solved');
    expect(m.facelets).toBe(SOLVED);

    const record = validRecord(m);
    expect(record).toMatchObject({
      schema: 2,
      session: SESSION,
      index: 1,
      scramble: SCRAMBLE,
      scrambledFacelets: scrambleTarget(SCRAMBLE),
      events: {
        scrambleShown: 1000,
        scrambleStart: 1100,
        scrambleDone: 1300,
        pickup: 1500,
        solveStart: 2000,
        solveEnd: 2250,
      },
      result: {
        timeMs: 250,
        inspectionMs: 500,
        movesQtm: 3,
        tps: 12,
        status: 'solved',
        replayOk: true,
        scrambleCorrected: false,
        scrambleExtraMoves: 0,
      },
      video: [],
    });
    // The clock fit of the six moves, each the newest of its packet (the default).
    expect(record.clock).toMatchObject({ samples: 6 });
    expect(record.moves).toEqual([
      { m: 'R', hostMs: 1100, cubeMs: 50, phase: 'scramble' },
      { m: 'U', hostMs: 1200, cubeMs: 150, phase: 'scramble' },
      { m: 'F', hostMs: 1300, cubeMs: 250, phase: 'scramble' },
      { m: "F'", hostMs: 2000, cubeMs: 1050, phase: 'solve' },
      { m: "U'", hostMs: 2100, cubeMs: 1150, phase: 'solve' },
      { m: "R'", hostMs: 2250, cubeMs: 1300, phase: 'solve' },
    ]);
  });

  it('takes the phases from detectPhases on the solve moves in host time, from the first solve move', () => {
    const m = machine(FIXTURE.scramble);
    feed(m, FIXTURE.scramble, 1000);
    const offset = 20_000;
    for (const { m: move, ms } of FIXTURE.moves) {
      m.onMove({ m: move, cubeMs: ms, hostMs: ms + offset });
    }
    const record = validRecord(m);
    const hostMoves: TimedMove[] = FIXTURE.moves.map(({ m: move, ms }) => ({
      m: move,
      ms: ms + offset,
    }));
    const report = detectPhases(scrambleTarget(FIXTURE.scramble), hostMoves);
    expect(report.complete).toBe(true);
    expect(record.crossFace).toBe(report.crossFace);
    expect(record.phases).toEqual(recorded(report.phases));
    expect(record.phases[0]).toMatchObject({ startMs: record.events.solveStart, recognitionMs: 0 });
    expect(record.phases[7].endMs).toBe(record.events.solveEnd);
    // f2l phases name their slot; the others have none.
    expect(record.phases.map((p) => p.slot !== undefined)).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('passes the cross face to the detector only when it is forced', () => {
    const forced = machine(FIXTURE.scramble, { crossFace: 'U' });
    feed(forced, FIXTURE.scramble, 1000);
    for (const { m: move, ms } of FIXTURE.moves) {
      forced.onMove({ m: move, cubeMs: ms, hostMs: 10_000 + ms });
    }
    const record = validRecord(forced);
    const report = detectPhases(
      scrambleTarget(FIXTURE.scramble),
      FIXTURE.moves.map(({ m: move, ms }) => ({ m: move, ms: 10_000 + ms })),
      { crossFace: 'U' },
    );
    expect(record.crossFace).toBe('U');
    expect(record.phases).toEqual(recorded(report.phases));
    expect(record.result.status).toBe('solved');
  });

  it('follows a half turn of the scramble made as two quarter turns (U2 as U U)', () => {
    const m = machine("R U2 F'");
    feed(m, "R U U F'", 1100);
    expect(m.state).toBe('armed');
    feed(m, "F U2 R'", 3000);
    const record = validRecord(m);
    expect(record.moves.filter((x) => x.phase === 'scramble').map((x) => x.m)).toEqual([
      'R',
      'U',
      'U',
      "F'",
    ]);
    expect(record.result).toMatchObject({
      scrambleCorrected: false,
      scrambleExtraMoves: 0,
      movesQtm: 4,
      replayOk: true,
    });
  });

  it('guides a mis-scramble back with undo, and records the correction', () => {
    const m = machine();
    feed(m, 'R B', 1100);
    expect(m.scrambleProgress).toMatchObject({
      matched: 1,
      diverged: true,
      undo: [parseMove("B'")],
    });
    feed(m, "B' U F", 1300);
    expect(m.state).toBe('armed');
    feed(m, SOLUTION, 3000);
    const record = validRecord(m);
    expect(record.moves.map((x) => `${x.m}:${x.phase}`)).toEqual([
      'R:scramble',
      'B:scramble',
      "B':scramble",
      'U:scramble',
      'F:scramble',
      "F':solve",
      "U':solve",
      "R':solve",
    ]);
    expect(record.result).toMatchObject({ scrambleCorrected: true, scrambleExtraMoves: 2 });
    expect(record.events).toMatchObject({ scrambleStart: 1100, scrambleDone: 1500 });
  });

  it('measures inspection from scrambleDone without a pickup, and keeps only the first pickup', () => {
    const noPickup = armed();
    feed(noPickup, SOLUTION, 4300);
    expect(validRecord(noPickup).result.inspectionMs).toBe(3000);

    const m = machine();
    m.onPickup(1050); // Before armed: ignored.
    feed(m, SCRAMBLE, 1100);
    m.onPickup(2000);
    m.onPickup(2500);
    feed(m, SOLUTION, 4300);
    m.onPickup(5000); // After: ignored.
    expect(validRecord(m)).toMatchObject({
      events: { pickup: 2000 },
      result: { inspectionMs: 2300 },
    });
  });

  it('ignores moves once solved, and a DNF too', () => {
    const m = armed();
    feed(m, SOLUTION, 2000);
    expect(m.onMove({ m: parseMove('R'), cubeMs: 9000, hostMs: 9000 })).toBe('solved');
    m.markDnf(9100);
    expect(m.state).toBe('solved');
    expect(m.dnfMs).toBeNull();
    expect(m.facelets).toBe(SOLVED);
    expect(validRecord(m).moves).toHaveLength(6);
  });

  it('refuses a record before the attempt is over', () => {
    const m = machine();
    expect(() => m.toRecord()).toThrow(/scrambling/);
    feed(m, SCRAMBLE, 1100);
    expect(() => m.toRecord()).toThrow(/armed/);
    feed(m, "F'", 2000);
    expect(() => m.toRecord()).toThrow(/solving/);
  });

  it('normalizes the scramble text and rejects bad options', () => {
    const m = machine('  R   U\tF ');
    feed(m, SCRAMBLE, 1100);
    feed(m, SOLUTION, 2000);
    expect(validRecord(m).scramble).toBe(SCRAMBLE);

    expect(() => machine(SCRAMBLE, { session: 'not-a-uuid' })).toThrow(/UUID/);
    expect(() => machine(SCRAMBLE, { session: SESSION.toUpperCase() })).toThrow(/UUID/);
    expect(() => machine(SCRAMBLE, { index: 0 })).toThrow(RangeError);
    expect(() => machine(SCRAMBLE, { index: 1.5 })).toThrow(RangeError);
    expect(() => machine('R Rw')).toThrow(NotationError);
    expect(() => machine("R R'")).toThrow(/leaves the cube solved/);
    expect(() => machine(SCRAMBLE, { start: scrambleTarget('U') })).toThrow(/solved/);
    expect(() => machine(SCRAMBLE, { start: SOLVED.slice(1) })).toThrow(/^Invalid facelets/);
    expect(machine(SCRAMBLE, { start: SOLVED }).state).toBe('scrambling');
  });
});

describe('AttemptMachine: DNF', () => {
  it('during the solve: no time, the phases reached, the moves so far', () => {
    const m = machine(FIXTURE.scramble);
    feed(m, FIXTURE.scramble, 1000);
    const offset = 20_000;
    const made = FIXTURE.moves.slice(0, 30);
    for (const { m: move, ms } of made) {
      m.onMove({ m: move, cubeMs: ms, hostMs: ms + offset });
    }
    m.markDnf(offset + 15_000);
    expect(m.state).toBe('dnf');
    expect(m.dnfMs).toBe(offset + 15_000);
    // Moves after the DNF are ignored.
    expect(m.onMove({ m: parseMove('R'), cubeMs: 1, hostMs: offset + 16_000 })).toBe('dnf');

    const record = validRecord(m);
    const scrambleDone = 1000 + 100 * (parseMoves(FIXTURE.scramble).length - 1);
    expect(record.events.scrambleDone).toBe(scrambleDone);
    const report = detectPhases(
      scrambleTarget(FIXTURE.scramble),
      made.map(({ m: move, ms }) => ({ m: move, ms: ms + offset })),
    );
    expect(report.complete).toBe(false);
    expect(report.phases.length).toBeGreaterThan(0);
    expect(record.crossFace).toBe(report.crossFace);
    expect(record.phases).toEqual(recorded(report.phases));
    expect(record.events).toMatchObject({ solveStart: offset + made[0].ms, solveEnd: null });
    expect(record.result).toEqual({
      timeMs: null,
      inspectionMs: offset + made[0].ms - scrambleDone,
      movesQtm: quarterTurns(made.map(({ m: move }) => move)),
      tps: null,
      status: 'dnf',
      replayOk: false,
      scrambleCorrected: false,
      scrambleExtraMoves: 0,
    });
    expect(record.moves).toHaveLength(parseMoves(FIXTURE.scramble).length + made.length);
  });

  it('while scrambling: no cross, no phases, no solve, the extra moves so far', () => {
    const m = machine();
    feed(m, 'R B', 1100);
    m.markDnf(1500);
    expect(validRecord(m)).toMatchObject({
      crossFace: null,
      phases: [],
      events: { scrambleStart: 1100, scrambleDone: null, solveStart: null, solveEnd: null },
      result: {
        timeMs: null,
        inspectionMs: null,
        movesQtm: 0,
        tps: null,
        status: 'dnf',
        replayOk: false,
        scrambleCorrected: true,
        scrambleExtraMoves: 1,
      },
    });
  });

  it('while armed, before any move, or twice: the first DNF counts', () => {
    const whileArmed = armed();
    whileArmed.markDnf(2000);
    expect(validRecord(whileArmed)).toMatchObject({
      events: { scrambleDone: 1300, solveStart: null },
      result: { inspectionMs: null, timeMs: null, status: 'dnf' },
    });

    const untouched = machine();
    untouched.markDnf(1200);
    untouched.markDnf(1300);
    expect(untouched.dnfMs).toBe(1200);
    expect(validRecord(untouched)).toMatchObject({
      events: { scrambleStart: null },
      moves: [],
      result: { status: 'dnf', scrambleExtraMoves: 0, scrambleCorrected: false },
    });
  });
});

describe('AttemptMachine: desync and resync', () => {
  it('onFacelets compares the reported state with the one the machine knows', () => {
    const m = machine();
    feed(m, 'R U', 1100);
    expect(m.onFacelets(applyMoves(SOLVED, parseMoves('R U')))).toEqual({ consistent: true });
    // The cube made F too, but its move was lost.
    expect(m.onFacelets(scrambleTarget(SCRAMBLE))).toEqual({ consistent: false });
    expect(m.state).toBe('scrambling');
  });

  it('while scrambling: the reported target arms the attempt at the time of the report', () => {
    const m = machine();
    feed(m, 'R U', 1100);
    m.resync(scrambleTarget(SCRAMBLE), 1450);
    expect(m.state).toBe('armed');
    expect(m.facelets).toBe(scrambleTarget(SCRAMBLE));
    expect(m.events.scrambleDone).toBe(1450);
    feed(m, SOLUTION, 3000);
    // The lost move was a scramble move: the solve's moves still replay.
    expect(validRecord(m)).toMatchObject({
      events: { scrambleDone: 1450, solveStart: 3000, solveEnd: 3200 },
      result: { status: 'solved', replayOk: true, scrambleCorrected: false, timeMs: 200 },
    });
  });

  it('while scrambling: an off-path state is a divergence with no undo; without a time, the last move', () => {
    const m = machine();
    feed(m, 'R', 1100);
    const reported = applyMoves(SOLVED, parseMoves('R L'));
    expect(m.onFacelets(reported).consistent).toBe(false);
    m.resync(reported);
    expect(m.state).toBe('scrambling');
    expect(m.facelets).toBe(reported);
    expect(m.scrambleProgress).toMatchObject({ matched: 1, diverged: true, undo: [] });
    feed(m, "L' U F", 1300);
    expect(m.state).toBe('armed');
    feed(m, SOLUTION, 3000);
    expect(validRecord(m).result).toMatchObject({ scrambleCorrected: true, replayOk: true });

    const noTime = machine();
    feed(noTime, 'R U', 1100);
    noTime.resync(scrambleTarget(SCRAMBLE));
    expect(noTime.events.scrambleDone).toBe(1200);
  });

  it('while armed: another state means the solve started unseen', () => {
    const m = armed();
    const reported = applyMoves(scrambleTarget(SCRAMBLE), parseMoves("F'"));
    m.resync(reported, 2100);
    expect(m.state).toBe('solving');
    expect(m.events.solveStart).toBe(2100);
    feed(m, "U' R'", 2200);
    expect(m.state).toBe('solved');
    // F' was never seen: the solve's moves do not replay, and its phases are what they show.
    const record = validRecord(m);
    expect(record.result).toMatchObject({ status: 'solved', timeMs: 200, replayOk: false });
    expect(record.phases.length).toBeLessThan(8);
  });

  it('while solving: a reported solved state ends the solve', () => {
    const m = armed();
    feed(m, "F' U'", 2000);
    m.resync(SOLVED, 2400);
    expect(m.state).toBe('solved');
    const record = validRecord(m);
    expect(record.events).toMatchObject({ solveStart: 2000, solveEnd: 2400 });
    expect(record.result).toMatchObject({ timeMs: 400, movesQtm: 2, replayOk: false });
  });

  it('adopts nothing when the reported state is the known one, and nothing once over', () => {
    const m = machine();
    feed(m, 'R B', 1100);
    const { undo } = m.scrambleProgress;
    m.resync(m.facelets, 1250);
    expect(m.scrambleProgress.undo).toEqual(undo);

    const over = armed();
    feed(over, SOLUTION, 2000);
    over.resync(scrambleTarget(SCRAMBLE), 3000);
    expect(over.state).toBe('solved');
    expect(over.facelets).toBe(SOLVED);
    expect(() => {
      over.resync('not a cube');
    }).toThrow(/^Invalid facelets/);
  });
});

describe('AttemptMachine: records', () => {
  it('returns a new record each time, which the machine does not share', () => {
    const m = armed();
    feed(m, SOLUTION, 2000);
    const first = m.toRecord();
    first.moves[0].m = 'D';
    first.events.solveEnd = 0;
    expect(m.toRecord()).toEqual({
      ...first,
      moves: m.toRecord().moves,
      events: { ...first.events, solveEnd: 2200 },
    });
    expect(m.toRecord().moves[0].m).toBe('R');
  });

  it('replays a solve given as the inverse of its scramble', () => {
    const scramble = "D2 F' L U2 R' B";
    const m = machine(scramble);
    feed(m, scramble, 1100);
    const solution = inverseSequence(parseMoves(scramble));
    for (const [i, move] of solution.entries()) {
      m.onMove({ m: move, cubeMs: 5000 + 100 * i, hostMs: 5000 + 100 * i });
    }
    const record = validRecord(m);
    expect(record.result).toMatchObject({ status: 'solved', replayOk: true, movesQtm: 8 });
    expect(record.scrambledFacelets satisfies Facelets).toBe(scrambleTarget(scramble));
  });
});

describe('AttemptMachine: the clock fit', () => {
  /** The cube's clock 0.7% slow, as on the owner's cube (docs/DEVICES.md). */
  const host = (cubeMs: number): number => 1.007 * cubeMs + 1_790_000_000_000;

  /** Feeds `moves` 150 ms apart on the cube clock from `startCubeMs`, on the line `host`. */
  function feedOnLine(m: Machine, moves: string, startCubeMs: number, packetLast?: boolean): void {
    for (const [i, move] of parseMoves(moves).entries()) {
      const cubeMs = startCubeMs + 150 * i;
      m.onMove({ m: move, cubeMs, hostMs: host(cubeMs), packetLast });
    }
  }

  it("fits the host time on the cube time of the attempt's moves, scramble and solve", () => {
    const m = machine();
    feedOnLine(m, SCRAMBLE, 10_000);
    feedOnLine(m, SOLUTION, 14_000);
    const { clock } = validRecord(m);
    // Host times of 1.79e12 ms are exact to 0.25 µs, hence the tolerances.
    expect(clock?.samples).toBe(6);
    expect(clock?.a).toBeCloseTo(1.007, 7);
    expect(clock?.b).toBeCloseTo(1_790_000_000_000, 2);
    expect(clock?.residualP95Ms).toBeLessThan(0.001);
  });

  it('takes only the moves that ended their Bluetooth packet as samples; packetLast defaults to true', () => {
    const m = machine();
    feedOnLine(m, 'R U', 10_000);
    // F and F' came in one packet with U': they carry its arrival time, off the line.
    m.onMove({ m: parseMove('F'), cubeMs: 10_300, hostMs: host(14_300), packetLast: false });
    m.onMove({ m: parseMove("F'"), cubeMs: 14_000, hostMs: host(14_300), packetLast: false });
    m.onMove({ m: parseMove("U'"), cubeMs: 14_300, hostMs: host(14_300), packetLast: true });
    feedOnLine(m, "R'", 14_600);
    const record = validRecord(m);
    expect(record.moves).toHaveLength(6);
    expect(record.clock?.samples).toBe(4);
    expect(record.clock?.a).toBeCloseTo(1.007, 7);
    expect(record.clock?.residualP95Ms).toBeLessThan(0.001);
    // What a CubeClockFit makes of the same moves.
    const fit = new CubeClockFit();
    for (const [i, move] of record.moves.entries()) {
      fit.addSample(move.cubeMs, move.hostMs, i < 2 || i >= 4);
    }
    expect(record.clock).toEqual(fit.params);
  });

  it('stops at the end: moves after solved, or after a DNF, are not samples', () => {
    const solved = machine();
    feedOnLine(solved, `${SCRAMBLE} ${SOLUTION}`, 10_000);
    const before = solved.toRecord().clock;
    feedOnLine(solved, 'R R', 20_000);
    expect(solved.toRecord().clock).toEqual(before);

    const dnf = machine();
    feedOnLine(dnf, `${SCRAMBLE} F'`, 10_000);
    dnf.markDnf(host(11_000));
    feedOnLine(dnf, 'R R', 20_000);
    expect(validRecord(dnf).clock?.samples).toBe(4);
  });

  it('has no clock without two samples at different cube times', () => {
    const untouched = machine();
    untouched.markDnf(2000);
    expect(validRecord(untouched).clock).toBeNull();

    const one = machine();
    feedOnLine(one, 'R', 10_000);
    one.markDnf(host(11_000));
    expect(validRecord(one).clock).toBeNull();

    const packet = machine();
    feedOnLine(packet, 'R U', 10_000, false);
    feedOnLine(packet, 'F', 10_300);
    packet.markDnf(host(11_000));
    expect(validRecord(packet).clock).toBeNull();

    const sameTime = machine();
    sameTime.onMove({ m: parseMove('R'), cubeMs: 10_000, hostMs: host(10_000) });
    sameTime.onMove({ m: parseMove('U'), cubeMs: 10_000, hostMs: host(10_000) + 3 });
    sameTime.markDnf(host(11_000));
    expect(validRecord(sameTime).clock).toBeNull();
  });

  it('rejects a move whose time is not finite, and takes nothing from it', () => {
    const m = machine();
    feedOnLine(m, 'R U', 10_000);
    expect(() => m.onMove({ m: parseMove('F'), cubeMs: Number.NaN, hostMs: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      m.onMove({ m: parseMove('F'), cubeMs: 1, hostMs: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
    expect(m.state).toBe('scrambling');
    expect(m.scrambleProgress.matched).toBe(2);
    m.markDnf(host(11_000));
    expect(validRecord(m)).toMatchObject({
      moves: [{ m: 'R' }, { m: 'U' }],
      clock: { samples: 2 },
    });
  });
});
