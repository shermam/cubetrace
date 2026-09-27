// Piece-level reads of a facelet string, for the phase detector. The cubie tables are Kociemba's
// (docs/PLAN.md, T1.1); geometry.test.ts checks them against the facelet layout of
// docs/DATA-MODEL.md §2 instead of trusting them. cube.ts derives the move permutations from them.
import type { Facelets } from './cube';
import type { Face } from './notation';

export type CornerPos = 'URF' | 'UFL' | 'ULB' | 'UBR' | 'DFR' | 'DLF' | 'DBL' | 'DRB';
export type EdgePos =
  'UR' | 'UF' | 'UL' | 'UB' | 'DR' | 'DF' | 'DL' | 'DB' | 'FR' | 'FL' | 'BL' | 'BR';

// Kociemba's facelet names, 1-based within each face (U1..U9, R1..R9, ...), as 0-based indices
// into the facelet string, whose faces come in the order U R F D L B.
const U = (n: number): number => n - 1;
const R = (n: number): number => 8 + n;
const F = (n: number): number => 17 + n;
const D = (n: number): number => 26 + n;
const L = (n: number): number => 35 + n;
const B = (n: number): number => 44 + n;

/**
 * The facelet indices (0-based, into the 54-character string) of each corner position. The first
 * is the U or D sticker; the other two follow clockwise around the corner, seen from outside.
 */
export const CORNER_FACELETS: Record<CornerPos, [number, number, number]> = {
  URF: [U(9), R(1), F(3)],
  UFL: [U(7), F(1), L(3)],
  ULB: [U(1), L(1), B(3)],
  UBR: [U(3), B(1), R(3)],
  DFR: [D(3), F(9), R(7)],
  DLF: [D(1), L(9), F(7)],
  DBL: [D(7), B(9), L(7)],
  DRB: [D(9), R(9), B(7)],
};

/**
 * The facelet indices (0-based) of each edge position. The first is the U or D sticker for the
 * U and D edges, the F or B sticker for FR, FL, BL and BR.
 */
export const EDGE_FACELETS: Record<EdgePos, [number, number]> = {
  UR: [U(6), R(2)],
  UF: [U(8), F(2)],
  UL: [U(4), L(2)],
  UB: [U(2), B(2)],
  DR: [D(6), R(8)],
  DF: [D(2), F(8)],
  DL: [D(4), L(8)],
  DB: [D(8), B(8)],
  FR: [F(6), R(4)],
  FL: [F(4), L(6)],
  BL: [B(6), L(4)],
  BR: [B(4), R(6)],
};

// Clockwise as seen from outside each face, starting with the face next to its first row (the row
// that docs/DATA-MODEL.md §2 puts on top when that face is read).
const ADJACENT: Record<Face, readonly [Face, Face, Face, Face]> = {
  U: ['B', 'R', 'F', 'L'],
  R: ['U', 'B', 'D', 'F'],
  F: ['U', 'R', 'D', 'L'],
  D: ['F', 'R', 'B', 'L'],
  L: ['U', 'F', 'D', 'B'],
  B: ['U', 'L', 'D', 'R'],
};

const OPPOSITE: Record<Face, Face> = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };

/** The colours at a corner position, in the order of {@link CORNER_FACELETS} (U/D sticker first). */
export function cornerAt(f: Facelets, pos: CornerPos): [string, string, string] {
  const [a, b, c] = CORNER_FACELETS[pos];
  return [f.charAt(a), f.charAt(b), f.charAt(c)];
}

/** The colours at an edge position, in the order of {@link EDGE_FACELETS}. */
export function edgeAt(f: Facelets, pos: EdgePos): [string, string] {
  const [a, b] = EDGE_FACELETS[pos];
  return [f.charAt(a), f.charAt(b)];
}

/**
 * The four faces around `face`, clockwise as seen from outside it, starting with the face next to
 * its first row: `U` → `['B', 'R', 'F', 'L']`. A clockwise turn of `face` carries the stickers on
 * each of them to the next one in this list.
 */
export function adjacentFaces(face: Face): Face[] {
  return [...ADJACENT[face]];
}

/** The face across the cube: `U` ↔ `D`, `R` ↔ `L`, `F` ↔ `B`. */
export function opposite(face: Face): Face {
  return OPPOSITE[face];
}
