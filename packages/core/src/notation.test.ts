import { describe, expect, it } from 'vitest';

import type { Face, Move } from './index';
import {
  NotationError,
  formatMove,
  formatMoves,
  inverse,
  inverseSequence,
  parseMove,
  parseMoves,
  quarterTurns,
} from './index';

const FACES: readonly Face[] = ['U', 'D', 'R', 'L', 'F', 'B'];
const ALL_MOVES: readonly Move[] = FACES.flatMap((face) =>
  ([1, 2, 3] as const).map((turns) => ({ face, turns })),
);

// Tokens that are not face turns (none contains whitespace).
const NOT_MOVES = [
  // Wide moves, rotations and slices are not part of v1.
  'r',
  'Rw',
  'Rw2',
  "Rw'",
  'x',
  "y'",
  'z2',
  'M',
  "E'",
  'S2',
  // Not a face, or a malformed suffix.
  'u',
  'X',
  '2',
  "'",
  'R3',
  'R1',
  "R2'",
  "R'2",
  "R''",
  'R22',
  'RU',
  '2R',
  "'R",
  'R’',
  'R+',
  '(R)',
];

describe('parseMove and formatMove', () => {
  it('reads the three forms of a face turn', () => {
    expect(parseMove('R')).toEqual({ face: 'R', turns: 1 });
    expect(parseMove('R2')).toEqual({ face: 'R', turns: 2 });
    expect(parseMove("R'")).toEqual({ face: 'R', turns: 3 });
  });

  it('round-trips all 18 moves', () => {
    const tokens = ALL_MOVES.map(formatMove);
    expect(new Set(tokens).size).toBe(18);
    for (const token of tokens) {
      expect(token).toMatch(/^[UDRLFB][2']?$/);
      expect(formatMove(parseMove(token))).toBe(token);
    }
    for (const m of ALL_MOVES) {
      expect(parseMove(formatMove(m))).toEqual(m);
    }
  });

  it.each(NOT_MOVES)('rejects %j with a NotationError, alone and in a sequence', (token) => {
    expect(() => parseMove(token)).toThrow(NotationError);
    expect(() => parseMoves(`R ${token} U`)).toThrow(NotationError);
  });

  it.each(['', ' ', 'R ', ' R', 'R U'])('rejects %j as a single token', (token) => {
    expect(() => parseMove(token)).toThrow(NotationError);
  });

  it('names the offending token', () => {
    expect(() => parseMove('Rw')).toThrow(/"Rw"/);
    expect(() => parseMoves("R U Rw U'")).toThrow(/"Rw" \(token 3\)/);
  });

  it('throws errors that are also Errors, named NotationError', () => {
    let caught: unknown;
    try {
      parseMove('x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotationError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toHaveProperty('name', 'NotationError');
  });
});

describe('parseMoves and formatMoves', () => {
  it('reads a sequence', () => {
    expect(parseMoves("R U2 F'")).toEqual([
      { face: 'R', turns: 1 },
      { face: 'U', turns: 2 },
      { face: 'F', turns: 3 },
    ]);
  });

  it('accepts any whitespace between tokens and around them', () => {
    expect(formatMoves(parseMoves("  R\tU2\n F'   D "))).toBe("R U2 F' D");
  });

  it('reads an empty or blank text as no moves', () => {
    expect(parseMoves('')).toEqual([]);
    expect(parseMoves(' \t\n')).toEqual([]);
    expect(formatMoves([])).toBe('');
  });

  it('round-trips a sequence written with single spaces', () => {
    const text = "F2 U2 R B2 D' L B' L' B U2 L2 F2 U F2 U R2 D2 B2 U' L2 D'";
    expect(formatMoves(parseMoves(text))).toBe(text);
  });

  it('rejects a sequence that contains anything but face turns', () => {
    for (const text of ['R,U', "R U'2", 'R U x', 'R (U)', "R U R' U' M2"]) {
      expect(() => parseMoves(text)).toThrow(NotationError);
    }
  });
});

describe('inverse, inverseSequence and quarterTurns', () => {
  it('inverts a single move', () => {
    expect(formatMove(inverse(parseMove('R')))).toBe("R'");
    expect(formatMove(inverse(parseMove("R'")))).toBe('R');
    expect(formatMove(inverse(parseMove('R2')))).toBe('R2');
    for (const m of ALL_MOVES) {
      expect(inverse(inverse(m))).toEqual(m);
    }
  });

  it('reverses and inverts a sequence without touching its input', () => {
    const ms = parseMoves("R U2 F' D");
    expect(formatMoves(inverseSequence(ms))).toBe("D' F U2 R'");
    expect(formatMoves(ms)).toBe("R U2 F' D");
    expect(inverseSequence([])).toEqual([]);
  });

  it('counts quarter turns, a half turn counting two', () => {
    expect(quarterTurns(parseMoves("R U2 F'"))).toBe(4);
    expect(quarterTurns(parseMoves("R R' R2 R2"))).toBe(6);
    expect(quarterTurns([])).toBe(0);
  });
});
