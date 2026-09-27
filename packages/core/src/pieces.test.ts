import { describe, expect, it } from 'vitest';

import type { CornerPos, EdgePos, Facelets, Move } from './index';
import {
  CORNER_FACELETS,
  EDGE_FACELETS,
  FACE_ORDER,
  SOLVED,
  adjacentFaces,
  applyMove,
  applyMoves,
  cornerAt,
  edgeAt,
  opposite,
  parseMove,
  parseMoves,
} from './index';

const CORNERS = Object.keys(CORNER_FACELETS) as CornerPos[];
const EDGES = Object.keys(EDGE_FACELETS) as EdgePos[];

// The tables exactly as docs/PLAN.md (T1.1) lists them, 1-based within each face.
const PLAN_TABLES = `
corners  URF: U9 R1 F3   UFL: U7 F1 L3   ULB: U1 L1 B3   UBR: U3 B1 R3
         DFR: D3 F9 R7   DLF: D1 L9 F7   DBL: D7 B9 L7   DRB: D9 R9 B7
edges    UR: U6 R2   UF: U8 F2   UL: U4 L2   UB: U2 B2   DR: D6 R8   DF: D2 F8   DL: D4 L8   DB: D8 B8
         FR: F6 R4   FL: F4 L6   BL: B6 L4   BR: B4 R6
`;

/** Kociemba's name of a facelet index, e.g. 8 → "U9". */
function faceletName(index: number): string {
  return FACE_ORDER[Math.floor(index / 9)] + String((index % 9) + 1);
}

/** The rotation of `s` that comes first in alphabetical order: "RFU" → "FUR", but "UFR" → "FRU". */
function canonicalRotation(s: string): string {
  const rotations = Array.from({ length: s.length }, (_, k) => s.slice(k) + s.slice(0, k));
  return rotations.sort()[0];
}

/** The letters of `s` in alphabetical order: "UR" → "RU". */
function sortedLetters(s: string): string {
  return Array.from({ length: s.length }, (_, k) => s.charAt(k))
    .sort()
    .join('');
}

describe('CORNER_FACELETS and EDGE_FACELETS', () => {
  it('are the tables of docs/PLAN.md', () => {
    const listed = [...Object.entries(CORNER_FACELETS), ...Object.entries(EDGE_FACELETS)].map(
      ([pos, facelets]) => `${pos}: ${facelets.map(faceletName).join(' ')}`,
    );
    const plan = [...PLAN_TABLES.matchAll(/([UDRLFB]{2,3}): ((?:[UDRLFB][1-9] ?)+)/g)].map(
      (m) => `${m[1]}: ${m[2].trim()}`,
    );
    expect(listed).toEqual(plan);
  });
});

describe('cornerAt and edgeAt', () => {
  it("read ['U','R','F'] at URF on the solved cube, and every position's own name", () => {
    expect(cornerAt(SOLVED, 'URF')).toEqual(['U', 'R', 'F']);
    for (const pos of CORNERS) {
      expect(cornerAt(SOLVED, pos).join('')).toBe(pos);
    }
    for (const pos of EDGES) {
      expect(edgeAt(SOLVED, pos).join('')).toBe(pos);
    }
  });

  it("read ['F','R'] at UR after R, with the DFR corner twisted into URF", () => {
    const f = applyMove(SOLVED, parseMove('R'));
    expect(edgeAt(f, 'UR')).toEqual(['F', 'R']);
    expect(cornerAt(f, 'URF')).toEqual(['F', 'R', 'D']);
  });

  it('read every edge flipped in place and every corner solved after the superflip', () => {
    const f = applyMoves(SOLVED, parseMoves("U R2 F B R B2 R U2 L B2 R U' D' R2 F R' L B2 U2 F2"));
    for (const pos of EDGES) {
      expect(edgeAt(f, pos).join('')).toBe(pos[1] + pos[0]);
    }
    for (const pos of CORNERS) {
      expect(cornerAt(f, pos).join('')).toBe(pos);
    }
  });

  it('find the 8 corners and 12 edges, never mirrored, after every sequence of up to 2 moves', () => {
    const moves: Move[] = FACE_ORDER.flatMap((face) =>
      ([1, 2, 3] as const).map((turns) => ({ face, turns })),
    );
    const states: Facelets[] = [
      ...moves.map((a) => applyMove(SOLVED, a)),
      ...moves.flatMap((a) => moves.map((b) => applyMoves(SOLVED, [a, b]))),
    ];
    expect(states).toHaveLength(18 + 18 * 18);
    const cornerNames = CORNERS.map(canonicalRotation).sort();
    const edgeNames = EDGES.map(sortedLetters).sort();
    for (const f of states) {
      // A corner's colours read clockwise are a rotation of its name, never a reflection.
      expect(CORNERS.map((pos) => canonicalRotation(cornerAt(f, pos).join(''))).sort()).toEqual(
        cornerNames,
      );
      expect(EDGES.map((pos) => sortedLetters(edgeAt(f, pos).join(''))).sort()).toEqual(edgeNames);
    }
  });
});

describe('adjacentFaces and opposite', () => {
  it('list the neighbours of U clockwise from B', () => {
    expect(adjacentFaces('U')).toEqual(['B', 'R', 'F', 'L']);
  });

  it('return a fresh array each time', () => {
    const ring = adjacentFaces('F');
    ring.reverse();
    expect(adjacentFaces('F')).toEqual(['U', 'R', 'D', 'L']);
  });

  it('pair the opposite faces', () => {
    expect(FACE_ORDER.map(opposite)).toEqual(['D', 'L', 'B', 'U', 'R', 'F']);
    for (const face of FACE_ORDER) {
      expect(opposite(opposite(face))).toBe(face);
    }
  });
});
