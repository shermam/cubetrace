/// <reference types="node" />
// Node's types for this file only: it reads the fixtures with node:fs (see cube.test.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { EdgePos, Face, Facelets, Move, PhaseRecord, PhaseReport, TimedMove } from './index';
import {
  CORNER_FACELETS,
  EDGE_FACELETS,
  FACE_ORDER,
  PHASE_NAMES,
  SOLVED,
  applyMove,
  applyMoves,
  crossComplete,
  detectPhases,
  eollComplete,
  f2lSlotsComplete,
  inverseSequence,
  isSolved,
  ocllComplete,
  opposite,
  parseMove,
  parseMoves,
} from './index';

// ---- Fixtures (read-only, docs/DATA-MODEL.md §8) ----

interface Solve {
  scrambled: Facelets;
  moves: TimedMove[];
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

const SOLVES: Solve[] = items(
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
}));

// ---- Helpers ----

/** The state reached from SOLVED by the moves. */
function state(moves: string): Facelets {
  return applyMoves(SOLVED, parseMoves(moves));
}

/** `f` with the stickers at `a` and `b` exchanged: with an edge's two stickers, a flipped edge. */
function swapStickers(f: Facelets, a: number, b: number): Facelets {
  const chars = f.split('');
  [chars[a], chars[b]] = [chars[b], chars[a]];
  return chars.join('');
}

/** `f` with a corner's three stickers cycled: the corner twisted in place. */
function twistCorner(f: Facelets, [a, b, c]: readonly number[]): Facelets {
  const chars = f.split('');
  [chars[a], chars[b], chars[c]] = [chars[c], chars[a], chars[b]];
  return chars.join('');
}

/**
 * A solve made of groups of moves (one group per phase, possibly none for a skip): the moves are
 * 100 ms apart within a group and each group starts 500 ms after the previous one ended; the first
 * move is at 1000 ms. The scrambled state is the one these moves solve.
 */
function handBuilt(groups: readonly string[]): Solve {
  const moves: TimedMove[] = [];
  let ms = 500;
  for (const group of groups) {
    for (const [k, m] of parseMoves(group).entries()) {
      ms += k === 0 ? 500 : 100;
      moves.push({ m, ms });
    }
  }
  return { scrambled: applyMoves(SOLVED, inverseSequence(moves.map(({ m }) => m))), moves };
}

function detect(s: Solve, opts?: Parameters<typeof detectPhases>[2]): PhaseReport {
  return detectPhases(s.scrambled, s.moves, opts);
}

function endIndices(r: PhaseReport): number[] {
  return r.phases.map((p) => p.endMoveIndex);
}

// The last-layer algorithms of the hand-built solves, for a D cross.
const SUNE = "R U R' U R U2 R'"; // orients three corners, keeps the edges oriented
const EOLL_LINE = "F R U R' U' F'"; // orients the edges (and here the corners too)
const T_PERM = "R U R' U' R' F R2 U' R' U' R U R' F'";
// Each inserts one pair from the U layer, touching nothing else below the U layer.
const INSERT_FR = "R U R'";
const INSERT_FL = "L' U' L";
const INSERT_BL = "L U L'";
const INSERT_BR = "R' U' R";

/** Cross by F2, then the four pairs, OCLL by a Sune (EOLL is a skip), PLL by a T-perm. */
const FULL = handBuilt(['F2', INSERT_FR, INSERT_FL, INSERT_BL, INSERT_BR, SUNE, T_PERM]);

const FULL_PHASES: PhaseRecord[] = [
  {
    name: 'cross',
    startMs: 1000,
    endMs: 1000,
    moves: 1,
    recognitionMs: 0,
    executionMs: 0,
    endMoveIndex: 0,
  },
  {
    name: 'f2l1',
    slot: 'FR',
    startMs: 1000,
    endMs: 1700,
    moves: 3,
    recognitionMs: 500,
    executionMs: 200,
    endMoveIndex: 3,
  },
  {
    name: 'f2l2',
    slot: 'FL',
    startMs: 1700,
    endMs: 2400,
    moves: 3,
    recognitionMs: 500,
    executionMs: 200,
    endMoveIndex: 6,
  },
  {
    name: 'f2l3',
    slot: 'BL',
    startMs: 2400,
    endMs: 3100,
    moves: 3,
    recognitionMs: 500,
    executionMs: 200,
    endMoveIndex: 9,
  },
  {
    name: 'f2l4',
    slot: 'BR',
    startMs: 3100,
    endMs: 3800,
    moves: 3,
    recognitionMs: 500,
    executionMs: 200,
    endMoveIndex: 12,
  },
  {
    name: 'eoll',
    startMs: 3800,
    endMs: 3800,
    moves: 0,
    recognitionMs: 0,
    executionMs: 0,
    endMoveIndex: 12,
  },
  {
    name: 'ocll',
    startMs: 3800,
    endMs: 4900,
    moves: 7,
    recognitionMs: 500,
    executionMs: 600,
    endMoveIndex: 19,
  },
  {
    name: 'pll',
    startMs: 4900,
    endMs: 6700,
    moves: 14,
    recognitionMs: 500,
    executionMs: 1300,
    endMoveIndex: 33,
  },
];

// ---- Whole-cube rotations, for colour neutrality ----
// A rotation is the map from each face to the face it carries it to. Rotating a state moves every
// sticker to the same piece and face carried by the rotation, and renames its colour the same way,
// since the centres move too; a turn of face X becomes the same turn of the face X is carried to.

type Rotation = Record<Face, Face>;

const X_ROTATION: Rotation = { U: 'B', B: 'D', D: 'F', F: 'U', R: 'R', L: 'L' }; // x, as R
const Y_ROTATION: Rotation = { U: 'U', D: 'D', F: 'L', L: 'B', B: 'R', R: 'F' }; // y, as U

function then(first: Rotation, second: Rotation): Rotation {
  const out = { ...first };
  for (const face of FACE_ORDER) {
    out[face] = second[first[face]];
  }
  return out;
}

/** The 24 rotations of the cube, generated by x and y. */
const ROTATIONS: Rotation[] = (() => {
  const identity = { U: 'U', R: 'R', F: 'F', D: 'D', L: 'L', B: 'B' } as const;
  const found = new Map<string, Rotation>([[FACE_ORDER.join(''), identity]]);
  for (const rotation of found.values()) {
    for (const next of [then(rotation, X_ROTATION), then(rotation, Y_ROTATION)]) {
      const key = FACE_ORDER.map((face) => next[face]).join('');
      if (!found.has(key)) {
        found.set(key, next);
      }
    }
  }
  return [...found.values()];
})();

const faceOfFacelet = (i: number): Face => FACE_ORDER[Math.floor(i / 9)];

/** Every piece position as its facelet indices: corners, edges and centres. */
const PIECES: readonly (readonly number[])[] = [
  ...Object.values(CORNER_FACELETS),
  ...Object.values(EDGE_FACELETS),
  ...FACE_ORDER.map((_, k) => [9 * k + 4]),
];

const pieceKey = (faces: readonly Face[], on: Face): string =>
  `${[...faces].sort().join('')}:${on}`;

const FACELET_BY_KEY = new Map(
  PIECES.flatMap((piece) =>
    piece.map((i): [string, number] => [pieceKey(piece.map(faceOfFacelet), faceOfFacelet(i)), i]),
  ),
);

function rotateFacelets(f: Facelets, rotation: Rotation): Facelets {
  const out = Array.from({ length: 54 }, () => '');
  for (const piece of PIECES) {
    const faces = piece.map((i) => rotation[faceOfFacelet(i)]);
    for (const i of piece) {
      const target = FACELET_BY_KEY.get(pieceKey(faces, rotation[faceOfFacelet(i)]));
      if (target === undefined) {
        throw new Error(`No facelet for ${String(i)} under the rotation.`);
      }
      out[target] = rotation[f.charAt(i) as Face];
    }
  }
  return out.join('');
}

function rotateMove(m: Move, rotation: Rotation): Move {
  return { face: rotation[m.face], turns: m.turns };
}

function rotateSolve(s: Solve, rotation: Rotation): Solve {
  return {
    scrambled: rotateFacelets(s.scrambled, rotation),
    moves: s.moves.map(({ m, ms }) => ({ m: rotateMove(m, rotation), ms })),
  };
}

const EDGE_BY_FACES = new Map(
  (Object.keys(EDGE_FACELETS) as EdgePos[]).map((pos): [string, EdgePos] => [
    pieceKey(EDGE_FACELETS[pos].map(faceOfFacelet), 'U'),
    pos,
  ]),
);

function rotateEdge(pos: EdgePos, rotation: Rotation): EdgePos {
  const faces = EDGE_FACELETS[pos].map((i) => rotation[faceOfFacelet(i)]);
  const rotated = EDGE_BY_FACES.get(pieceKey(faces, 'U'));
  if (rotated === undefined) {
    throw new Error(`No edge position for ${pos} under the rotation.`);
  }
  return rotated;
}

/** What the report of a rotated solve must be: the same phases, faces and slots carried along. */
function rotateReport(r: PhaseReport, rotation: Rotation): PhaseReport {
  return {
    ...r,
    crossFace: r.crossFace === null ? null : rotation[r.crossFace],
    phases: r.phases.map((p) =>
      p.slot === undefined ? p : { ...p, slot: rotateEdge(p.slot, rotation) },
    ),
  };
}

// ---- Tests ----

describe('crossComplete', () => {
  it('holds on SOLVED for every face', () => {
    for (const face of FACE_ORDER) {
      expect(crossComplete(SOLVED, face)).toBe(true);
    }
  });

  it('keeps the D cross after U, not after D (its side stickers leave their centres)', () => {
    expect(crossComplete(state('U'), 'D')).toBe(true);
    expect(crossComplete(state('D'), 'D')).toBe(false);
  });

  it('breaks with any turn of the face or a neighbour, not of the opposite face', () => {
    for (const face of FACE_ORDER) {
      for (const turned of FACE_ORDER) {
        for (const turns of [1, 2, 3] as const) {
          const f = applyMove(SOLVED, { face: turned, turns });
          expect(crossComplete(f, face), `${turned}${String(turns)} on ${face}`).toBe(
            turned === opposite(face),
          );
        }
      }
    }
  });

  it('needs every cross edge oriented, and ignores corners', () => {
    const [onD, onF] = EDGE_FACELETS.DF;
    expect(crossComplete(swapStickers(SOLVED, onD, onF), 'D')).toBe(false);
    expect(crossComplete(twistCorner(SOLVED, CORNER_FACELETS.DFR), 'D')).toBe(true);
  });
});

describe('f2lSlotsComplete', () => {
  it('lists the four middle-layer slots of each cross face on SOLVED', () => {
    const expected: Record<Face, EdgePos[]> = {
      U: ['FR', 'FL', 'BL', 'BR'],
      D: ['FR', 'FL', 'BL', 'BR'],
      F: ['UR', 'UL', 'DR', 'DL'],
      B: ['UR', 'UL', 'DR', 'DL'],
      R: ['UF', 'UB', 'DF', 'DB'],
      L: ['UF', 'UB', 'DF', 'DB'],
    };
    for (const face of FACE_ORDER) {
      expect(f2lSlotsComplete(SOLVED, face)).toEqual(expected[face]);
    }
  });

  it("misses exactly the pair that R U' R' takes out, the D cross staying complete", () => {
    const f = state("R U' R'");
    expect(crossComplete(f, 'D')).toBe(true);
    expect(f2lSlotsComplete(f, 'D')).toEqual(['FL', 'BL', 'BR']);
  });

  it('needs the corner and the edge both in place and oriented', () => {
    const [onF, onR] = EDGE_FACELETS.FR;
    expect(f2lSlotsComplete(twistCorner(SOLVED, CORNER_FACELETS.DFR), 'D')).toEqual([
      'FL',
      'BL',
      'BR',
    ]);
    expect(f2lSlotsComplete(swapStickers(SOLVED, onF, onR), 'D')).toEqual(['FL', 'BL', 'BR']);
  });

  it('does not look at the cross', () => {
    const [onD, onF] = EDGE_FACELETS.DF;
    const f = swapStickers(SOLVED, onD, onF);
    expect(crossComplete(f, 'D')).toBe(false);
    expect(f2lSlotsComplete(f, 'D')).toEqual(['FR', 'FL', 'BL', 'BR']);
  });
});

describe('eollComplete and ocllComplete', () => {
  it('hold on SOLVED for every cross face', () => {
    for (const face of FACE_ORDER) {
      expect(eollComplete(SOLVED, face)).toBe(true);
      expect(ocllComplete(SOLVED, face)).toBe(true);
    }
  });

  it('read the last layer: a Sune leaves the edges oriented and the corners not', () => {
    const f = state(SUNE);
    expect(eollComplete(f, 'D')).toBe(true);
    expect(ocllComplete(f, 'D')).toBe(false);
    // With a U cross the last layer is D, which the Sune never touches.
    expect(eollComplete(f, 'U')).toBe(true);
    expect(ocllComplete(f, 'U')).toBe(true);
  });

  it("see the flipped edges of F R U R' U' F'", () => {
    expect(eollComplete(state(EOLL_LINE), 'D')).toBe(false);
  });

  it('hold on a PLL case, which is not solved', () => {
    const f = state(T_PERM);
    expect(eollComplete(f, 'D')).toBe(true);
    expect(ocllComplete(f, 'D')).toBe(true);
    expect(isSolved(f)).toBe(false);
  });
});

describe('detectPhases on hand-built solves', () => {
  it('splits a solve into the eight phases, with slots, skips and times', () => {
    expect(detect(FULL)).toEqual({
      crossFace: 'D',
      crossFaceSwitched: false,
      phases: FULL_PHASES,
      solvedAtMove: 33,
      complete: true,
    });
    expect(PHASE_NAMES).toEqual(FULL_PHASES.map((p) => p.name));
  });

  it('gives a pair already in place when the cross completes a skip (an XCross)', () => {
    const r = detect(handBuilt(['F2', INSERT_FL, INSERT_BL, INSERT_BR, SUNE, T_PERM]));
    expect(r.phases[1]).toEqual({
      name: 'f2l1',
      slot: 'FR',
      startMs: 1000,
      endMs: 1000,
      moves: 0,
      recognitionMs: 0,
      executionMs: 0,
      endMoveIndex: 0,
    });
    expect(endIndices(r)).toEqual([0, 0, 3, 6, 9, 9, 16, 30]);
  });

  it('ends two f2l phases on one move when two pairs complete together', () => {
    const r = detect(handBuilt(['F2', INSERT_BL, INSERT_BR, SUNE, T_PERM]));
    expect(r.phases.map((p) => p.slot)).toEqual([
      undefined,
      'FR',
      'FL',
      'BL',
      'BR',
      undefined,
      undefined,
      undefined,
    ]);
    expect(endIndices(r)).toEqual([0, 0, 0, 3, 6, 6, 13, 27]);
  });

  it('ends EOLL and OCLL together for a one-look OLL, and skips a solved PLL', () => {
    const oneLook = detect(
      handBuilt(['F2', INSERT_FR, INSERT_FL, INSERT_BL, INSERT_BR, EOLL_LINE, T_PERM]),
    );
    expect(endIndices(oneLook)).toEqual([0, 3, 6, 9, 12, 18, 18, 32]);
    expect(oneLook.phases[6].moves).toBe(0);
    const noPll = detect(handBuilt(['F2', INSERT_FR, INSERT_FL, INSERT_BL, INSERT_BR, SUNE]));
    expect(endIndices(noPll)).toEqual([0, 3, 6, 9, 12, 12, 19, 19]);
    expect(noPll.complete).toBe(true);
  });

  it('starts the cross at solveStartMs when given', () => {
    const r = detect(FULL, { solveStartMs: 400 });
    expect(r.phases[0]).toEqual({ ...FULL_PHASES[0], startMs: 400, recognitionMs: 600 });
    expect(r.phases.slice(1)).toEqual(FULL_PHASES.slice(1));
  });

  it('uses a forced cross face and never switches', () => {
    const r = detect(FULL, { crossFace: 'F' });
    expect(r.crossFace).toBe('F');
    expect(r.crossFaceSwitched).toBe(false);
    expect(endIndices(r)).toEqual([12, 12, 12, 33, 33, 33, 33, 33]);
    expect(r.phases.map((p) => p.slot).filter((slot) => slot !== undefined)).toEqual([
      'DR',
      'DL',
      'UR',
      'UL',
    ]);
  });

  it('never picks a face whose cross is complete in the scrambled state', () => {
    // After D the U cross is intact, so the U cross is excluded; R is the first of the others.
    const r = detectPhases(state('D'), [{ m: parseMove("D'"), ms: 0 }]);
    expect(r.crossFace).toBe('R');
    expect(endIndices(r)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('prefers, among crosses completed by the same move, the one with more pairs', () => {
    // After F' the cube is a T-perm away: the D cross has four pairs, the F cross two.
    const moves = parseMoves(`F' ${T_PERM}`).map((m, i) => ({ m, ms: 100 * i }));
    const r = detectPhases(state(`${T_PERM} F`), moves);
    expect(r.crossFace).toBe('D');
    expect(endIndices(r)).toEqual([0, 0, 0, 0, 0, 0, 0, 14]);
  });

  it('reports the phases reached when the cube is not solved', () => {
    const r = detectPhases(FULL.scrambled, FULL.moves.slice(0, 20));
    expect(r).toEqual({
      crossFace: 'D',
      crossFaceSwitched: false,
      phases: FULL_PHASES.slice(0, 7),
      solvedAtMove: null,
      complete: false,
    });
  });

  it('reports nothing without moves', () => {
    expect(detectPhases(FULL.scrambled, [])).toEqual({
      crossFace: null,
      crossFaceSwitched: false,
      phases: [],
      solvedAtMove: null,
      complete: false,
    });
  });

  it('ignores the moves after the cube is first solved', () => {
    const extra = parseMoves("U U'").map((m, k) => ({ m, ms: 7000 + 100 * k }));
    expect(detectPhases(FULL.scrambled, [...FULL.moves, ...extra])).toEqual(detect(FULL));
  });
});

describe('colour neutrality', () => {
  it('has 24 rotations that commute with every move (a check of the test helper)', () => {
    expect(ROTATIONS).toHaveLength(24);
    const f = SOLVES[0].scrambled;
    for (const rotation of ROTATIONS) {
      expect(rotateFacelets(SOLVED, rotation)).toBe(SOLVED);
      for (const face of FACE_ORDER) {
        for (const turns of [1, 2, 3] as const) {
          const m: Move = { face, turns };
          expect(rotateFacelets(applyMove(f, m), rotation)).toBe(
            applyMove(rotateFacelets(f, rotation), rotateMove(m, rotation)),
          );
        }
      }
    }
  });

  it('finds the hand-built solve on whichever face it is rotated to', () => {
    const r = detect(FULL);
    const crossFaces = new Set<Face | null>();
    for (const rotation of ROTATIONS) {
      const rotated = detect(rotateSolve(FULL, rotation));
      expect(rotated).toEqual(rotateReport(r, rotation));
      crossFaces.add(rotated.crossFace);
    }
    expect([...crossFaces].sort()).toEqual(['B', 'D', 'F', 'L', 'R', 'U']);
  });

  it('gives the same phases for fixture solves rotated in all 24 ways', () => {
    for (const [i, s] of SOLVES.entries()) {
      if (i % 25 !== 0) {
        continue;
      }
      const r = detect(s);
      expect(r.complete).toBe(true);
      for (const rotation of ROTATIONS) {
        expect(detect(rotateSolve(s, rotation)), `solves[${String(i)}]`).toEqual(
          rotateReport(r, rotation),
        );
      }
    }
  });
});
