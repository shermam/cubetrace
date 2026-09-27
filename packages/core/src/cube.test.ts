/// <reference types="node" />
// Node's types for this file only: it reads the fixtures with node:fs. tsconfig.base.json sets
// "types": [] so that library code cannot lean on Node, and the app build still type-checks src/
// without them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Move } from './index';
import {
  FACE_ORDER,
  SOLVED,
  applyMove,
  applyMoves,
  assertFacelets,
  faceletsOf,
  formatMoves,
  inverseSequence,
  isSolved,
  isSolvedIgnoringOrientation,
  parseMove,
  parseMoves,
} from './index';

// ---- Fixtures (read-only, docs/DATA-MODEL.md §8), read from the repository and type-checked. ----

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8'));
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what}: an object was expected.`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what}: an array was expected.`);
  }
  return value as unknown[];
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${what}: a string was expected.`);
  }
  return value;
}

function integer(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${what}: an integer was expected.`);
  }
  return value;
}

const identities = record(readFixture('identities.json'), 'identities.json');
const SOLVED_FIXTURE = text(identities['solved'], 'solved');
const AFTER_R = text(identities['after_R'], 'after_R');
const AFTER_SCRAMBLES = list(identities['after_scrambles'], 'after_scrambles').map((item, i) => {
  const o = record(item, `after_scrambles[${String(i)}]`);
  return { scramble: text(o['scramble'], 'scramble'), facelets: text(o['facelets'], 'facelets') };
});
const RETURN_TO_SOLVED = list(identities['return_to_solved'], 'return_to_solved').map((s, i) =>
  text(s, `return_to_solved[${String(i)}]`),
);
const NOT_SOLVED = list(identities['not_solved'], 'not_solved').map((s, i) =>
  text(s, `not_solved[${String(i)}]`),
);

interface SolveFixture {
  scramble: string;
  scrambledFacelets: string;
  /** The raw stream, `MOVE[ms]` separated by spaces, cube clock. */
  solution: string;
  /** The same stream, parsed. */
  moves: { m: string; ms: number }[];
}

const SOLVES: SolveFixture[] = list(
  record(readFixture('solves.json'), 'solves.json')['solves'],
  'solves',
).map((item, i) => {
  const what = `solves[${String(i)}]`;
  const o = record(item, what);
  return {
    scramble: text(o['scramble'], `${what}.scramble`),
    scrambledFacelets: text(o['scrambled_facelets'], `${what}.scrambled_facelets`),
    solution: text(o['solution'], `${what}.solution`),
    moves: list(o['moves'], `${what}.moves`).map((move, j) => {
      const mo = record(move, `${what}.moves[${String(j)}]`);
      return { m: text(mo['m'], 'm'), ms: integer(mo['ms'], 'ms') };
    }),
  };
});

// ---- Helpers ----

// 54 distinct characters, so that a permutation is visible sticker by sticker.
const LABELLED = Array.from({ length: 54 }, (_, i) => String.fromCharCode(48 + i)).join('');

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

function randomMoves(next: () => number, length: number): Move[] {
  return Array.from({ length }, () => ({
    face: FACE_ORDER[Math.floor(next() * 6)],
    turns: ([1, 2, 3] as const)[Math.floor(next() * 3)],
  }));
}

// ---- Tests ----

describe('SOLVED, FACE_ORDER and faceletsOf', () => {
  it('match docs/DATA-MODEL.md §2 and fixtures/identities.json', () => {
    expect(SOLVED).toBe(SOLVED_FIXTURE);
    expect(FACE_ORDER).toEqual(['U', 'R', 'F', 'D', 'L', 'B']);
    expect(isSolved(SOLVED)).toBe(true);
    expect(isSolvedIgnoringOrientation(SOLVED)).toBe(true);
  });

  it('reads the nine characters of one face', () => {
    for (const face of FACE_ORDER) {
      expect(faceletsOf(SOLVED, face)).toBe(face.repeat(9));
    }
    expect(FACE_ORDER.map((face) => faceletsOf(AFTER_R, face))).toEqual([
      'UUFUUFUUF',
      'RRRRRRRRR',
      'FFDFFDFFD',
      'DDBDDBDDB',
      'LLLLLLLLL',
      'UBBUBBUBB',
    ]);
  });
});

describe('assertFacelets', () => {
  it('accepts real states', () => {
    for (const f of [SOLVED, AFTER_R, ...SOLVES.map((s) => s.scrambledFacelets)]) {
      expect(() => {
        assertFacelets(f);
      }).not.toThrow();
    }
  });

  it.each([
    ['too short', SOLVED.slice(1)],
    ['too long', SOLVED + 'U'],
    ['empty', ''],
    ['eight U and ten R', 'R' + SOLVED.slice(1)],
    ['a foreign character', 'X' + SOLVED.slice(1)],
    ['lower case', SOLVED.toLowerCase()],
    ['two centres swapped', 'UUUURUUUURRRRURRRR' + SOLVED.slice(18)],
  ])('rejects %s', (_, f) => {
    expect(() => {
      assertFacelets(f);
    }).toThrow(/^Invalid facelets/);
  });
});

describe('applyMove and applyMoves', () => {
  it('gives the after_R state of the fixtures', () => {
    expect(applyMove(SOLVED, parseMove('R'))).toBe(AFTER_R);
  });

  it.each(AFTER_SCRAMBLES)(
    'gives the fixture state after "$scramble"',
    ({ scramble, facelets }) => {
      expect(applyMoves(SOLVED, parseMoves(scramble))).toBe(facelets);
    },
  );

  it.each(FACE_ORDER)('%s: four quarter turns are the identity; X X = X2, X X X = X′', (face) => {
    const x = applyMove(LABELLED, { face, turns: 1 });
    const xx = applyMove(x, { face, turns: 1 });
    const xxx = applyMove(xx, { face, turns: 1 });
    expect(x).not.toBe(LABELLED);
    expect(applyMove(xxx, { face, turns: 1 })).toBe(LABELLED);
    expect(applyMove(LABELLED, { face, turns: 2 })).toBe(xx);
    expect(applyMove(LABELLED, { face, turns: 3 })).toBe(xxx);
  });

  it('is undone by inverseSequence, on random sequences', () => {
    const next = random(20260927);
    for (let k = 0; k < 500; k++) {
      const ms = randomMoves(next, Math.floor(next() * 41));
      for (const start of [SOLVED, LABELLED]) {
        const there = applyMoves(start, ms);
        expect(applyMoves(there, inverseSequence(ms)), formatMoves(ms)).toBe(start);
      }
    }
  });

  it('leaves the state alone for no moves', () => {
    expect(applyMoves(AFTER_R, [])).toBe(AFTER_R);
  });

  it('throws on a state that is not 54 characters long', () => {
    expect(() => applyMove(SOLVED.slice(1), parseMove('R'))).toThrow(/54 characters/);
  });
});

describe('isSolved', () => {
  it.each(RETURN_TO_SOLVED)('return_to_solved: "%s" reaches SOLVED', (sequence) => {
    const f = applyMoves(SOLVED, parseMoves(sequence));
    expect(f).toBe(SOLVED);
    expect(isSolved(f)).toBe(true);
  });

  it.each(NOT_SOLVED)('not_solved: "%s" does not', (sequence) => {
    expect(isSolved(applyMoves(SOLVED, parseMoves(sequence)))).toBe(false);
  });

  it('is false one move away from solved', () => {
    for (const face of FACE_ORDER) {
      for (const turns of [1, 2, 3] as const) {
        expect(isSolved(applyMove(SOLVED, { face, turns }))).toBe(false);
      }
    }
  });

  it('compares each sticker with its own centre, whatever the letters', () => {
    expect(isSolved('abcdef'.replace(/./g, (c) => c.repeat(9)))).toBe(true);
    expect(isSolved(SOLVED.slice(1))).toBe(false);
    expect(isSolved('')).toBe(false);
  });

  it('isSolvedIgnoringOrientation agrees with it', () => {
    for (const f of [SOLVED, AFTER_R, ...SOLVES.map((s) => s.scrambledFacelets)]) {
      expect(isSolvedIgnoringOrientation(f)).toBe(isSolved(f));
    }
  });
});

describe('the 300 fixture solves', () => {
  it('are all there, each solution stream matching its parsed moves', () => {
    expect(SOLVES).toHaveLength(300);
    for (const s of SOLVES) {
      expect(s.moves.map(({ m, ms }) => `${m}[${String(ms)}]`).join(' ')).toBe(s.solution);
    }
  });

  it('replay in under 2 s: each scramble gives scrambled_facelets, each solution solves it', () => {
    const start = performance.now();
    const failures: string[] = [];
    for (const [i, s] of SOLVES.entries()) {
      if (applyMoves(SOLVED, parseMoves(s.scramble)) !== s.scrambledFacelets) {
        failures.push(`solves[${String(i)}]: the scramble does not give scrambled_facelets`);
      }
      const end = applyMoves(
        s.scrambledFacelets,
        s.moves.map(({ m }) => parseMove(m)),
      );
      if (!isSolved(end)) {
        failures.push(`solves[${String(i)}]: the solution ends in ${end}`);
      }
    }
    const elapsedMs = performance.now() - start;
    expect(failures).toEqual([]);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
