/// <reference types="node" />
// Node's types for this file only: it reads the fixtures with node:fs (see cube.test.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Move, ScrambleMoveState, ScrambleProgress } from './index';
import {
  FACE_ORDER,
  NotationError,
  SOLVED,
  ScrambleTracker,
  adjacentFaces,
  applyMoves,
  formatMoves,
  generateScramble,
  inverse,
  isSolved,
  opposite,
  parseMove,
  parseMoves,
  quarterTurns,
  scrambleTarget,
} from './index';
import { normalizeScramble } from './scramble';

// ---- Fixtures (read-only, docs/DATA-MODEL.md §8): the scrambles and the states they lead to. ----

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`An object with "${key}" was expected.`);
  }
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${what}: a string was expected.`);
  }
  return value;
}

const solves: unknown = field(
  JSON.parse(readFileSync(new URL('../../../fixtures/solves.json', import.meta.url), 'utf8')),
  'solves',
);
if (!Array.isArray(solves)) {
  throw new Error('solves.json: an array "solves" was expected.');
}
const SCRAMBLES = (solves as unknown[]).map((s, i) => ({
  scramble: text(field(s, 'scramble'), `solves[${String(i)}].scramble`),
  scrambledFacelets: text(
    field(s, 'scrambled_facelets'),
    `solves[${String(i)}].scrambled_facelets`,
  ),
}));

// ---- Helpers ----

/** The scramble text of the Timer page's end-to-end check (docs/PLAN.md, T1.2). */
const SCRAMBLE_TEXT = /^([UDRLFB][2']? ?){15,30}$/;

const NOTHING_YET: Omit<ScrambleProgress, 'total' | 'moves'> = {
  matched: 0,
  done: false,
  diverged: false,
  undo: [],
  extraMoves: 0,
};

/** `ScrambleProgress.moves` written one letter per scramble move: `d` done, `p` partial, `.` pending. */
function states(letters: string): ScrambleMoveState[] {
  return Array.from(letters, (letter): ScrambleMoveState => {
    switch (letter) {
      case 'd':
        return 'done';
      case 'p':
        return 'partial';
      case '.':
        return 'pending';
      default:
        throw new Error(`"${letter}" is not a move state: d, p or .`);
    }
  });
}

/** The first `done` of `total` moves done and the rest pending. */
function doneUpTo(done: number, total: number): ScrambleMoveState[] {
  return states('d'.repeat(done).padEnd(total, '.'));
}

/** A seeded pseudo-random generator (mulberry32), so that "random" tests are reproducible. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function track(scramble: string, moves: string): ScrambleTracker {
  const tracker = new ScrambleTracker(scramble);
  for (const m of parseMoves(moves)) {
    tracker.onMove(m);
  }
  return tracker;
}

/** A quarter turn on a face that none of `avoid` turns, so that it cannot be a scramble move. */
function wrongMove(avoid: readonly Move[]): Move {
  const face = FACE_ORDER.find((f) => !avoid.some((m) => m.face === f || opposite(m.face) === f));
  if (face === undefined) {
    throw new Error('No free face.');
  }
  return { face, turns: 1 };
}

/** A move as a smart cube reports it: quarter turns, a half turn as two in the given direction. */
function asQuarterTurns(m: Move, clockwise: boolean): Move[] {
  if (m.turns !== 2) {
    return [m];
  }
  const quarter: Move = { face: m.face, turns: clockwise ? 1 : 3 };
  return [quarter, quarter];
}

// ---- generateScramble and normalizeScramble ----

describe('generateScramble (cubing.js, in a Node worker thread)', () => {
  it('returns 20 random-state scrambles of 15 to 30 face turns in our notation, none solved', async () => {
    const scrambles: string[] = [];
    for (let i = 0; i < 20; i++) {
      scrambles.push(await generateScramble());
    }
    for (const s of scrambles) {
      const moves = parseMoves(s);
      expect(moves.length, s).toBeGreaterThanOrEqual(15);
      expect(moves.length, s).toBeLessThanOrEqual(30);
      expect(formatMoves(moves), 'single spaces, nothing around').toBe(s);
      expect(s).not.toContain("2'");
      expect(s).toMatch(SCRAMBLE_TEXT);
      expect(isSolved(scrambleTarget(s)), s).toBe(false);
    }
    // Random states: two equal scrambles among twenty would mean a broken generator.
    expect(new Set(scrambles).size).toBe(20);
  });
});

describe('normalizeScramble', () => {
  it('keeps a scramble in our notation, with single spaces and nothing around', () => {
    expect(normalizeScramble("F2 U2 R B2 D' L")).toBe("F2 U2 R B2 D' L");
    expect(normalizeScramble("  R\tU2  F'\n")).toBe("R U2 F'");
  });

  it("writes a half turn with a direction, U2', as U2", () => {
    expect(normalizeScramble("R2' U F2' B2")).toBe('R2 U F2 B2');
  });

  it.each(['R Rw U', "R x' U", 'R (U F) B', 'R [U, F]', 'R U3', "R U2'2", 'R M', 'R 2R', 'r U'])(
    'throws a NotationError on "%s"',
    (s) => {
      expect(() => normalizeScramble(s)).toThrow(NotationError);
    },
  );
});

// ---- scrambleTarget ----

describe('scrambleTarget', () => {
  it('gives the scrambled state of all 300 fixture solves', () => {
    expect(SCRAMBLES).toHaveLength(300);
    for (const { scramble, scrambledFacelets } of SCRAMBLES) {
      expect(scrambleTarget(scramble), scramble).toBe(scrambledFacelets);
    }
  });

  it('is SOLVED for no moves and throws on a token outside the notation', () => {
    expect(scrambleTarget('')).toBe(SOLVED);
    expect(() => scrambleTarget('R Rw')).toThrow(NotationError);
  });
});

// ---- ScrambleTracker ----

describe('ScrambleTracker', () => {
  const scramble = "F2 U2 R B2 D' L B' L' B U2 L2 F2 U F2 U R2 D2 B2 U' L2 D'";
  const moves = parseMoves(scramble);
  const total = moves.length;

  it('starts at the start state with nothing matched', () => {
    const tracker = new ScrambleTracker(scramble);
    expect(tracker.state).toBe(SOLVED);
    expect(tracker.progress).toEqual({ ...NOTHING_YET, total, moves: doneUpTo(0, total) });
  });

  it('follows every fixture scramble executed exactly to done, without divergence', () => {
    for (const s of SCRAMBLES) {
      const scrambleMoves = parseMoves(s.scramble);
      const tracker = new ScrambleTracker(s.scramble);
      for (const [i, m] of scrambleMoves.entries()) {
        const progress = tracker.onMove(m);
        expect(progress, `${s.scramble}, move ${String(i + 1)}`).toEqual({
          matched: i + 1,
          total: scrambleMoves.length,
          done: i + 1 === scrambleMoves.length,
          diverged: false,
          undo: [],
          extraMoves: 0,
          moves: doneUpTo(i + 1, scrambleMoves.length),
        });
      }
      expect(tracker.progress.matched).toBe(tracker.progress.total);
      expect(tracker.progress.done).toBe(true);
      expect(tracker.state).toBe(s.scrambledFacelets);
    }
  });

  it('tracks a scramble with U2 executed as U U to done', () => {
    const tracker = new ScrambleTracker("R U2 F'");
    expect(tracker.onMove(parseMove('R')).matched).toBe(1);
    // Halfway through U2: on the path, not diverged, U2 not reached yet.
    expect(tracker.onMove(parseMove('U'))).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 3,
      moves: states('dp.'),
    });
    expect(tracker.onMove(parseMove('U'))).toEqual({
      ...NOTHING_YET,
      matched: 2,
      total: 3,
      moves: states('dd.'),
    });
    expect(tracker.onMove(parseMove("F'"))).toEqual({
      ...NOTHING_YET,
      matched: 3,
      total: 3,
      done: true,
      moves: states('ddd'),
    });
  });

  it('follows every fixture scramble as a smart cube reports it (half turns as two quarter turns)', () => {
    for (const [i, s] of SCRAMBLES.entries()) {
      const tracker = new ScrambleTracker(s.scramble);
      let matched = 0;
      for (const m of parseMoves(s.scramble)) {
        const quarters = asQuarterTurns(m, i % 2 === 0);
        for (const [j, q] of quarters.entries()) {
          const progress = tracker.onMove(q);
          if (j === quarters.length - 1) {
            matched += 1;
          }
          expect(progress.matched, s.scramble).toBe(matched);
          expect(progress.diverged, s.scramble).toBe(false);
          expect(progress.extraMoves, s.scramble).toBe(0);
        }
      }
      expect(tracker.progress.done).toBe(true);
      expect(tracker.state).toBe(s.scrambledFacelets);
    }
  });

  it('accepts two moves on opposite faces in either order', () => {
    // D' then U for "U D'": the first is in flight, the second reaches both.
    const tracker = new ScrambleTracker("R U D' F");
    tracker.onMove(parseMove('R'));
    expect(tracker.onMove(parseMove("D'"))).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 4,
      moves: states('d.d.'),
    });
    expect(tracker.onMove(parseMove('U'))).toEqual({
      ...NOTHING_YET,
      matched: 3,
      total: 4,
      moves: states('ddd.'),
    });
    expect(tracker.onMove(parseMove('F')).done).toBe(true);
    // The same with half turns made as quarter turns: "U2 D2" as D U' D U'.
    const halves = track('R U2 D2 F', "R D U' D U' F");
    expect(halves.progress).toEqual({
      ...NOTHING_YET,
      matched: 4,
      total: 4,
      done: true,
      moves: states('dddd'),
    });
  });

  it('wrong move then its inverse: diverged, undo is the inverse, matched again, 2 extra moves', () => {
    const tracker = new ScrambleTracker(scramble);
    for (const m of moves.slice(0, 3)) {
      tracker.onMove(m);
    }
    const wrong = wrongMove(moves.slice(3, 5));
    expect(tracker.onMove(wrong)).toEqual({
      matched: 3,
      total,
      done: false,
      diverged: true,
      undo: [inverse(wrong)],
      extraMoves: 1,
      moves: doneUpTo(3, total),
    });
    expect(tracker.onMove(inverse(wrong))).toEqual({
      ...NOTHING_YET,
      matched: 3,
      total,
      extraMoves: 2,
      moves: doneUpTo(3, total),
    });
    for (const m of moves.slice(3)) {
      tracker.onMove(m);
    }
    expect(tracker.progress).toEqual({
      ...NOTHING_YET,
      matched: total,
      total,
      done: true,
      extraMoves: 2,
      moves: doneUpTo(total, total),
    });
  });

  it('two wrong moves: undo has two entries in the right order, and shrinks as they are made', () => {
    const tracker = new ScrambleTracker(scramble);
    for (const m of moves.slice(0, 5)) {
      tracker.onMove(m);
    }
    const first = wrongMove(moves.slice(5, 7));
    // On a face next to the first one's, so that the two do not commute and the order matters.
    const second: Move = { face: adjacentFaces(first.face)[0], turns: 3 };
    tracker.onMove(first);
    expect(tracker.onMove(second)).toMatchObject({
      matched: 5,
      diverged: true,
      undo: [inverse(second), inverse(first)],
      extraMoves: 2,
    });
    expect(tracker.onMove(inverse(second))).toMatchObject({
      diverged: true,
      undo: [inverse(first)],
      extraMoves: 3,
    });
    expect(tracker.onMove(inverse(first))).toEqual({
      ...NOTHING_YET,
      matched: 5,
      total,
      extraMoves: 4,
      moves: doneUpTo(5, total),
    });
    for (const m of moves.slice(5)) {
      tracker.onMove(m);
    }
    expect(tracker.progress).toMatchObject({ done: true, diverged: false, extraMoves: 4 });
  });

  it('merges turns of one face in undo: a wrong half turn made as two quarter turns', () => {
    const tracker = track('R U F', 'R');
    expect(tracker.onMove(parseMove('B')).undo).toEqual([parseMove("B'")]);
    expect(tracker.onMove(parseMove('B')).undo).toEqual([parseMove('B2')]);
    expect(tracker.onMove(parseMove('B')).undo).toEqual([parseMove('B')]);
    expect(tracker.onMove(parseMove('B'))).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 3,
      extraMoves: 4,
      moves: states('d..'),
    });
  });

  it('a half turn begun, then a mistake: undo leads back to the half-made turn', () => {
    const tracker = track("R U2 F'", 'R U');
    expect(tracker.onMove(parseMove('L'))).toMatchObject({
      matched: 1,
      diverged: true,
      undo: [parseMove("L'")],
      moves: states('d..'),
    });
    expect(tracker.onMove(parseMove("L'"))).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 3,
      extraMoves: 2,
      moves: states('dp.'),
    });
    tracker.onMove(parseMove('U'));
    expect(tracker.onMove(parseMove("F'"))).toEqual({
      ...NOTHING_YET,
      matched: 3,
      total: 3,
      done: true,
      extraMoves: 2,
      moves: states('ddd'),
    });
  });

  it('a half turn begun, then turned back: 2 extra moves', () => {
    expect(track('R U2 F', "R U U'").progress).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 3,
      extraMoves: 2,
      moves: states('d..'),
    });
  });

  it('a mis-scramble fixed by another path is caught by the state check', () => {
    // U' instead of U, then U2 rather than U U: the state after U is reached again.
    const tracker = track('R U F', "R U'");
    expect(tracker.progress).toMatchObject({ matched: 1, diverged: true, undo: [parseMove('U')] });
    expect(tracker.onMove(parseMove('U2'))).toEqual({
      ...NOTHING_YET,
      matched: 2,
      total: 3,
      extraMoves: 2,
      moves: states('dd.'),
    });
    expect(tracker.onMove(parseMove('F')).done).toBe(true);
  });

  it('the target reached by a path far from the scramble is done', () => {
    // (R U R' U')⁶ is the identity, so (U R U' R')⁵ reaches the state of R U R' U'.
    const tracker = track("R U R' U'", "U R U' R' ".repeat(5));
    expect(tracker.state).toBe(scrambleTarget("R U R' U'"));
    expect(tracker.progress).toEqual({
      ...NOTHING_YET,
      matched: 4,
      total: 4,
      done: true,
      extraMoves: 16,
      moves: states('dddd'),
    });
  });

  it('starts from any state: the path and the target are the scramble applied to it', () => {
    const start = scrambleTarget("L F'");
    const tracker = new ScrambleTracker("R U'", start);
    expect(tracker.state).toBe(start);
    expect(tracker.progress).toEqual({ ...NOTHING_YET, total: 2, moves: states('..') });
    tracker.onMove(parseMove('R'));
    expect(tracker.onMove(parseMove("U'"))).toEqual({
      ...NOTHING_YET,
      matched: 2,
      total: 2,
      done: true,
      moves: states('dd'),
    });
    expect(tracker.state).toBe(applyMoves(start, parseMoves("R U'")));
  });

  it('keeps each progress as it was when later moves arrive', () => {
    const tracker = new ScrambleTracker('R U F');
    const afterR = tracker.onMove(parseMove('R'));
    expect(tracker.progress).toBe(afterR);
    tracker.onMove(parseMove('B'));
    expect(afterR).toEqual({ ...NOTHING_YET, matched: 1, total: 3, moves: states('d..') });
  });

  it('rejects a scramble outside the notation and a start that is not a cube state', () => {
    expect(() => new ScrambleTracker('R Rw')).toThrow(NotationError);
    expect(() => new ScrambleTracker('R', SOLVED.slice(1))).toThrow(/^Invalid facelets/);
  });

  it('always reaches the target when a scrambler errs at random and follows the undo guidance', () => {
    const next = random(20260927);
    const randomMove = (): Move => ({
      face: FACE_ORDER[Math.floor(next() * 6)],
      turns: ([1, 2, 3] as const)[Math.floor(next() * 3)],
    });
    let detours = 0;
    for (const s of SCRAMBLES) {
      const scrambleMoves = parseMoves(s.scramble);
      const tracker = new ScrambleTracker(s.scramble);
      let madeQuarters = 0;
      let before = tracker.progress;
      const make = (m: Move): void => {
        madeQuarters += quarterTurns([m]);
        const progress = tracker.onMove(m);
        expect(progress.matched).toBeGreaterThanOrEqual(before.matched);
        expect(progress.extraMoves).toBeGreaterThanOrEqual(before.extraMoves);
        expect(progress.undo.length > 0).toBe(progress.diverged);
        // The moves before matched are done; only the next two can be begun, and none off the path.
        const { matched, diverged } = progress;
        const consistent =
          progress.moves.length === scrambleMoves.length &&
          progress.moves.every((state, i) => {
            if (i < matched) {
              return state === 'done';
            }
            return diverged || i > matched + 1 ? state === 'pending' : true;
          });
        expect(consistent || `${s.scramble}: ${progress.moves.join(' ')}`).toBe(true);
        before = progress;
      };
      for (let step = 0; !tracker.progress.done; step++) {
        expect(step, s.scramble).toBeLessThan(2000);
        const { diverged, undo, matched } = tracker.progress;
        if (diverged && next() < 0.8) {
          // Follows the guidance to the end: back on the path.
          detours += 1;
          for (const m of undo) {
            make(m);
          }
          expect(tracker.progress.diverged).toBe(false);
        } else if (next() < 0.15) {
          make(randomMove());
        } else if (!diverged) {
          // The next scramble move, as quarter turns in a random direction.
          for (const q of asQuarterTurns(scrambleMoves[matched], next() < 0.5)) {
            make(q);
          }
        }
      }
      expect(tracker.state).toBe(s.scrambledFacelets);
      expect(tracker.progress.matched).toBe(scrambleMoves.length);
      expect(tracker.progress.extraMoves).toBe(madeQuarters - quarterTurns(scrambleMoves));
    }
    // The walk did go astray, often.
    expect(detours).toBeGreaterThan(300);
  });
});

describe('ScrambleTracker.setState (resync with the state the cube reports)', () => {
  const scramble = "F2 U2 R B2 D' L B' L' B U2 L2 F2 U F2 U R2 D2 B2 U' L2 D'";
  const moves = parseMoves(scramble);
  const total = moves.length;
  /** The state after the first `k` moves of the scramble. */
  const after = (k: number): string => applyMoves(SOLVED, moves.slice(0, k));

  it('jumps ahead to a later state on the path, and the scramble goes on from there', () => {
    const tracker = new ScrambleTracker(scramble);
    for (const m of moves.slice(0, 3)) {
      tracker.onMove(m);
    }
    expect(tracker.setState(after(7))).toEqual({
      ...NOTHING_YET,
      matched: 7,
      total,
      moves: doneUpTo(7, total),
    });
    expect(tracker.state).toBe(after(7));
    for (const m of moves.slice(7)) {
      tracker.onMove(m);
    }
    expect(tracker.progress).toEqual({
      ...NOTHING_YET,
      matched: total,
      total,
      done: true,
      moves: doneUpTo(total, total),
    });
  });

  it('is done when the reported state is the target', () => {
    const tracker = track(scramble, 'F2');
    const progress = tracker.setState(scrambleTarget(scramble));
    expect(progress).toEqual({
      ...NOTHING_YET,
      matched: total,
      total,
      done: true,
      moves: doneUpTo(total, total),
    });
    expect(tracker.progress).toBe(progress);
  });

  it('off the path: diverged with an empty undo and extraMoves unchanged, until a move brings it back', () => {
    const tracker = track('R U F', 'R');
    const off = applyMoves(SOLVED, parseMoves('R B'));
    expect(tracker.setState(off)).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 3,
      diverged: true,
      moves: states('d..'),
    });
    // Moves made while the way back is unknown build no undo either.
    expect(tracker.onMove(parseMove('L'))).toMatchObject({ diverged: true, undo: [] });
    expect(tracker.onMove(parseMove("L'"))).toMatchObject({ diverged: true, undo: [] });
    // B' leads back to the state after R: on the path again; only the seen moves are counted.
    expect(tracker.onMove(parseMove("B'"))).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 3,
      extraMoves: 3,
      moves: states('d..'),
    });
    tracker.onMove(parseMove('U'));
    expect(tracker.onMove(parseMove('F')).done).toBe(true);
  });

  it('keeps extraMoves when the reported state puts a diverged cube back on the path', () => {
    const tracker = track('R U F', 'R B');
    expect(tracker.progress).toMatchObject({ diverged: true, extraMoves: 1 });
    expect(tracker.setState(applyMoves(SOLVED, parseMoves('R U')))).toEqual({
      ...NOTHING_YET,
      matched: 2,
      total: 3,
      extraMoves: 1,
      moves: states('dd.'),
    });
  });

  it('treats a state halfway through a half turn as on the path, as onMove does', () => {
    const tracker = track("R U2 F'", 'R');
    expect(tracker.setState(applyMoves(SOLVED, parseMoves('R U')))).toEqual({
      ...NOTHING_YET,
      matched: 1,
      total: 3,
      moves: states('dp.'),
    });
    expect(tracker.onMove(parseMove('U'))).toMatchObject({ matched: 2, moves: states('dd.') });
  });

  it('searches from the last matched state on: an earlier state of the path is off it', () => {
    const tracker = new ScrambleTracker(scramble);
    for (const m of moves.slice(0, 5)) {
      tracker.onMove(m);
    }
    expect(tracker.setState(after(2))).toEqual({
      ...NOTHING_YET,
      matched: 5,
      total,
      diverged: true,
      moves: doneUpTo(5, total),
    });
  });

  it('rejects a state that is not a cube state', () => {
    expect(() => new ScrambleTracker('R U').setState(SOLVED.slice(1))).toThrow(/^Invalid facelets/);
  });
});

describe('ScrambleProgress.moves (how far each scramble move is)', () => {
  it('a half turn made as two quarter turns, either way: partial after the first, done after the second', () => {
    for (const quarter of ['U', "U'"]) {
      const tracker = track("R U2 F'", 'R');
      expect(tracker.progress.moves).toEqual(states('d..'));
      expect(tracker.onMove(parseMove(quarter)).moves, quarter).toEqual(states('dp.'));
      expect(tracker.onMove(parseMove(quarter)).moves, quarter).toEqual(states('dd.'));
      expect(tracker.onMove(parseMove("F'")).moves, quarter).toEqual(states('ddd'));
    }
    // Made at once, as the scramble writes it: done.
    expect(track("R U2 F'", 'R U2').progress.moves).toEqual(states('dd.'));
  });

  it('moves of opposite faces made in the other order: the second is done, or half made, first', () => {
    // "U D'" made as D' U.
    const tracker = track("R U D' F", 'R');
    expect(tracker.onMove(parseMove("D'")).moves).toEqual(states('d.d.'));
    expect(tracker.onMove(parseMove('U')).moves).toEqual(states('ddd.'));
    // "U2 D2" made as D U' D U', then as D U' U' D.
    const halves = track('R U2 D2 F', 'R');
    expect(halves.onMove(parseMove('D')).moves).toEqual(states('d.p.'));
    expect(halves.onMove(parseMove("U'")).moves).toEqual(states('dpp.'));
    expect(halves.onMove(parseMove('D')).moves).toEqual(states('dpd.'));
    expect(halves.onMove(parseMove("U'")).moves).toEqual(states('ddd.'));
    const firstWhole = track('R U2 D2 F', "R D U'");
    expect(firstWhole.onMove(parseMove("U'")).moves).toEqual(states('ddp.'));
    expect(firstWhole.onMove(parseMove('D')).moves).toEqual(states('ddd.'));
  });

  it('a wrong turn: every move from matched on is pending, what was begun too; its undo brings the states back', () => {
    // From a half-made U2.
    const halfway = track("R U2 F'", 'R U');
    expect(halfway.progress.moves).toEqual(states('dp.'));
    expect(halfway.onMove(parseMove('L'))).toMatchObject({
      matched: 1,
      diverged: true,
      moves: states('d..'),
    });
    expect(halfway.onMove(parseMove("L'"))).toMatchObject({
      diverged: false,
      moves: states('dp.'),
    });
    // After the second move of an opposite pair made first.
    const pair = track("R U D' F", "R D'");
    expect(pair.onMove(parseMove('B'))).toMatchObject({ diverged: true, moves: states('d...') });
    expect(pair.onMove(parseMove("B'"))).toMatchObject({ diverged: false, moves: states('d.d.') });
    // From a matched state, with two wrong turns.
    const matched = track('R U F', 'R');
    expect(matched.onMove(parseMove('B')).moves).toEqual(states('d..'));
    expect(matched.onMove(parseMove('L')).moves).toEqual(states('d..'));
    expect(matched.onMove(parseMove("L'")).moves).toEqual(states('d..'));
    expect(matched.onMove(parseMove("B'"))).toMatchObject({
      diverged: false,
      extraMoves: 4,
      moves: states('d..'),
    });
    expect(matched.onMove(parseMove('U')).moves).toEqual(states('dd.'));
  });

  it('setState: onto an in-flight state, off the path and back, onto the target', () => {
    const tracker = track("R U2 D' F", 'R');
    // U2 halfway (as U') and D' made first.
    expect(tracker.setState(applyMoves(SOLVED, parseMoves("R U' D'")))).toMatchObject({
      matched: 1,
      diverged: false,
      moves: states('dpd.'),
    });
    expect(tracker.setState(applyMoves(SOLVED, parseMoves("R U' D' B")))).toMatchObject({
      matched: 1,
      diverged: true,
      moves: states('d...'),
    });
    // A move back to the in-flight state: as it was.
    expect(tracker.onMove(parseMove("B'"))).toMatchObject({
      diverged: false,
      moves: states('dpd.'),
    });
    expect(tracker.setState(scrambleTarget("R U2 D' F"))).toMatchObject({
      done: true,
      moves: states('dddd'),
    });
  });

  it('follows every fixture scramble made one quarter turn at a time, either way', () => {
    for (const s of SCRAMBLES) {
      const scrambleMoves = parseMoves(s.scramble);
      const total = scrambleMoves.length;
      for (const clockwise of [true, false]) {
        const tracker = new ScrambleTracker(s.scramble);
        for (const [i, m] of scrambleMoves.entries()) {
          const quarters = asQuarterTurns(m, clockwise);
          for (const [j, q] of quarters.entries()) {
            const whole = j === quarters.length - 1;
            expect(tracker.onMove(q).moves, `${s.scramble}, move ${String(i + 1)}`).toEqual(
              states(('d'.repeat(i) + (whole ? 'd' : 'p')).padEnd(total, '.')),
            );
          }
        }
        expect(tracker.progress.done).toBe(true);
      }
    }
  });
});
