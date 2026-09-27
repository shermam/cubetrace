/// <reference types="node" />
// Node's types for this file only: it reads the fixtures with node:fs (as packages/core does).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SOLVED,
  formatMove,
  isSolved,
  parseMove,
  parseMoves,
  type Facelets,
  type Move,
} from '@cubetrace/core';

import type { CubeEvent, CubeMoveEvent, ScheduledMove } from './index';
import { FAKE_CUBE_BATTERY, FAKE_CUBE_HARDWARE, FakeCube } from './index';

// ---- Fixtures (read-only, docs/DATA-MODEL.md §8) ----

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8'));
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    throw new Error(`A fixture has no "${key}".`);
  }
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('A fixture string was expected.');
  }
  return value;
}

interface SolveFixture {
  scramble: string;
  scrambledFacelets: string;
  /** The solution as the cube reported it, on the cube clock. */
  moves: { m: string; ms: number }[];
}

function solve(i: number): SolveFixture {
  const solves = field(readFixture('solves.json'), 'solves');
  if (!Array.isArray(solves)) {
    throw new Error('solves.json: "solves" is not an array.');
  }
  const raw: unknown = solves[i];
  const moves = field(raw, 'moves');
  if (!Array.isArray(moves)) {
    throw new Error(`solves[${String(i)}].moves is not an array.`);
  }
  return {
    scramble: text(field(raw, 'scramble')),
    scrambledFacelets: text(field(raw, 'scrambled_facelets')),
    moves: moves.map((x: unknown) => {
      const ms = field(x, 'ms');
      if (typeof ms !== 'number') {
        throw new Error(`solves[${String(i)}]: a move without ms.`);
      }
      return { m: text(field(x, 'm')), ms };
    }),
  };
}

const AFTER_R = text(field(readFixture('identities.json'), 'after_R'));

// ---- Helpers ----

/** The scramble as timed moves, 100 ms apart (the fixtures do not time the scramble). */
function scrambleSchedule(s: SolveFixture): ScheduledMove[] {
  return parseMoves(s.scramble).map((m, i) => ({ m, ms: i * 100 }));
}

function solutionSchedule(s: SolveFixture): ScheduledMove[] {
  return s.moves.map((x) => ({ m: parseMove(x.m), ms: x.ms }));
}

/** Every event of `cube` from now on, and whether the stream completed. */
function record(cube: FakeCube): { events: CubeEvent[]; completed: () => boolean } {
  const events: CubeEvent[] = [];
  let completed = false;
  cube.events$.subscribe({
    next: (e) => events.push(e),
    complete: () => {
      completed = true;
    },
  });
  return { events, completed: () => completed };
}

function movesOf(events: readonly CubeEvent[]): CubeMoveEvent[] {
  return events.filter((e): e is CubeMoveEvent => e.type === 'move');
}

const R: Move = { face: 'R', turns: 1 };
const R_PRIME: Move = { face: 'R', turns: 3 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- Tests ----

describe('FakeCube.play', () => {
  it.each([
    [0, 1],
    [1, 4],
    [2, 20],
  ])(
    'replays fixture %i at speed %i: scramble then solution, in order, on schedule, solved at the end',
    async (index, speed) => {
      const s = solve(index);
      const cube = new FakeCube({ speed, now: () => Date.now() });
      const { events } = record(cube);
      const scramble = scrambleSchedule(s);
      const solution = solutionSchedule(s);

      const scrambled = cube.play(scramble);
      await vi.runAllTimersAsync();
      await scrambled;
      expect(cube.facelets).toBe(s.scrambledFacelets);

      const solved = cube.play(solution);
      await vi.runAllTimersAsync();
      await solved;
      expect(isSolved(cube.facelets)).toBe(true);

      const moves = movesOf(events);
      expect(moves.map((e) => formatMove(e.m))).toEqual([
        ...scramble.map((x) => formatMove(x.m)),
        ...s.moves.map((x) => x.m),
      ]);
      // The cube clock never goes back, also from one play to the next.
      for (let i = 1; i < moves.length; i++) {
        expect(moves[i].cubeMs).toBeGreaterThanOrEqual(moves[i - 1].cubeMs);
        expect(moves[i].hostMs).toBeGreaterThanOrEqual(moves[i - 1].hostMs);
        expect(moves[i].serial).toBe(((moves[i - 1].serial ?? 0) + 1) & 0xff);
      }
      // Within a play, the cube keeps the fixture's own timings and the host sees them / speed.
      const played = moves.slice(scramble.length);
      const t0 = solution[0].ms;
      for (const [i, e] of played.entries()) {
        expect(e.cubeMs - played[0].cubeMs).toBe(solution[i].ms - t0);
        expect(Math.abs(e.hostMs - played[0].hostMs - (solution[i].ms - t0) / speed)).toBeLessThan(
          1,
        );
        expect(e.packetLast).toBe(true);
      }
    },
  );

  it('honours the gaps between moves divided by speed', async () => {
    const start = Date.now();
    const cube = new FakeCube({ speed: 2, now: () => Date.now() });
    const { events } = record(cube);
    const done = cube.play([
      { m: R, ms: 1000 },
      { m: { face: 'U', turns: 1 }, ms: 1100 },
      { m: R_PRIME, ms: 1250 },
    ]);
    const emitted = (): number => movesOf(events).length;

    expect(emitted()).toBe(0); // the first move comes on a timer, never inside play()
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted()).toBe(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(emitted()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted()).toBe(2);
    await vi.advanceTimersByTimeAsync(74);
    expect(emitted()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted()).toBe(3);
    await done;

    expect(movesOf(events).map((e) => e.hostMs - start)).toEqual([0, 50, 125]);
    expect(movesOf(events).map((e) => e.cubeMs)).toEqual([0, 100, 250]);
  });

  it('queues plays: a second play starts when the first has finished', async () => {
    const cube = new FakeCube({ speed: 10, now: () => Date.now() });
    const { events } = record(cube);
    const first = cube.play(parseMoves('R U R2').map((m, i) => ({ m, ms: i * 100 })));
    const second = cube.play(parseMoves("F' D").map((m, i) => ({ m, ms: i * 100 })));
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(movesOf(events).map((e) => formatMove(e.m))).toEqual(['R', 'U', 'R2', "F'", 'D']);
  });

  it('resolves an empty play at once and rejects a schedule that goes back in time', async () => {
    const cube = new FakeCube();
    await expect(cube.play([])).resolves.toBeUndefined();
    await expect(
      cube.play([
        { m: R, ms: 10 },
        { m: R, ms: 5 },
      ]),
    ).rejects.toThrow(/move 1 at 5 ms comes before move 0 at 10 ms/);
    await expect(cube.play([{ m: R, ms: Number.NaN }])).rejects.toThrow(/no finite time/);
  });
});

describe('FakeCube.turn and the cube clock', () => {
  it('turn() moves the simulated state at once, before the event is emitted', () => {
    const cube = new FakeCube({ now: () => Date.now() });
    const seen: Facelets[] = [];
    cube.events$.subscribe((e) => {
      if (e.type === 'move') {
        seen.push(cube.facelets);
      }
    });
    cube.turn(R);
    expect(cube.facelets).toBe(AFTER_R);
    cube.turn(R_PRIME);
    expect(cube.facelets).toBe(SOLVED);
    expect(seen).toEqual([AFTER_R, SOLVED]);
  });

  it('stamps turns with a clock that runs speed times the host clock and never goes back', () => {
    let t = 5000;
    const cube = new FakeCube({ speed: 3, now: () => t });
    const { events } = record(cube);
    t = 5010;
    cube.turn(R);
    t = 5010;
    cube.turn(R);
    t = 5100;
    cube.turn(R);
    expect(movesOf(events).map((e) => [e.cubeMs, e.hostMs])).toEqual([
      [30, 5010],
      [30, 5010],
      [300, 5100],
    ]);
  });

  it('starts from the given state', () => {
    const s = solve(3);
    const cube = new FakeCube({ start: s.scrambledFacelets });
    expect(cube.facelets).toBe(s.scrambledFacelets);
    for (const m of solutionSchedule(s)) {
      cube.turn(m.m);
    }
    expect(isSolved(cube.facelets)).toBe(true);
  });

  it('rejects a bad speed or start state', () => {
    expect(() => new FakeCube({ speed: 0 })).toThrow(RangeError);
    expect(() => new FakeCube({ speed: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => new FakeCube({ start: 'UUU' })).toThrow(/Invalid facelets/);
  });
});

describe('FakeCube requests and events$', () => {
  it('replays hardware and battery to every subscriber, then emits live events', async () => {
    const cube = new FakeCube({ now: () => 1234 });
    const early = record(cube);
    cube.turn(R);
    const late = record(cube);
    await cube.requestBattery();
    const hardware = { ...FAKE_CUBE_HARDWARE };
    const battery = { type: 'battery', level: FAKE_CUBE_BATTERY };
    expect(early.events.map((e) => e.type)).toEqual(['hardware', 'battery', 'move', 'battery']);
    expect(early.events[0]).toEqual(hardware);
    expect(late.events).toEqual([hardware, battery, battery]);
  });

  it('requestFacelets() emits the simulated state with the host time', async () => {
    const s = solve(0);
    const cube = new FakeCube({ start: s.scrambledFacelets, now: () => 42 });
    const { events } = record(cube);
    await cube.requestFacelets();
    expect(events.at(-1)).toEqual({ type: 'facelets', facelets: s.scrambledFacelets, hostMs: 42 });
  });

  it('disconnect() stops a play, emits disconnected, completes, and the cube refuses to move', async () => {
    const cube = new FakeCube({ now: () => Date.now() });
    const { events, completed } = record(cube);
    const playing = cube.play(parseMoves("R U R' U'").map((m, i) => ({ m, ms: i * 1000 })));
    await vi.advanceTimersByTimeAsync(1500);
    expect(movesOf(events)).toHaveLength(2);

    await cube.disconnect('The cube was turned off.');
    await playing; // resolves early
    await vi.runAllTimersAsync();
    expect(movesOf(events)).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'disconnected', reason: 'The cube was turned off.' });
    expect(completed()).toBe(true);

    const late = record(cube);
    expect(late.events.map((e) => e.type)).toEqual(['hardware', 'battery', 'disconnected']);
    expect(late.completed()).toBe(true);

    expect(() => {
      cube.turn(R);
    }).toThrow(/disconnected/);
    await expect(cube.play([{ m: R, ms: 0 }])).rejects.toThrow(/disconnected/);
    await expect(cube.requestFacelets()).rejects.toThrow(/disconnected/);
    await expect(cube.requestBattery()).rejects.toThrow(/disconnected/);
    await cube.disconnect();
    expect(events.filter((e) => e.type === 'disconnected')).toHaveLength(1);
    expect(cube.kind).toBe('fake');
  });
});
