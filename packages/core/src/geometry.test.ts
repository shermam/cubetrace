// Checks the cubie tables (pieces.ts) and the move permutations (cube.ts) against an independent
// 3D model of the facelet layout, built from the wording of docs/DATA-MODEL.md §2 alone.
import { describe, expect, it } from 'vitest';

import type { Face } from './index';
import {
  CORNER_FACELETS,
  EDGE_FACELETS,
  FACE_ORDER,
  adjacentFaces,
  applyMove,
  opposite,
} from './index';

type Vec = readonly [number, number, number];

// Axes: x towards R, y towards U, z towards F.
const NORMAL: Record<Face, Vec> = {
  U: [0, 1, 0],
  D: [0, -1, 0],
  R: [1, 0, 0],
  L: [-1, 0, 0],
  F: [0, 0, 1],
  B: [0, 0, -1],
};

// "on U the top row is the one adjacent to B; on D the top row is adjacent to F; on R F L B the
// top row is adjacent to U" (docs/DATA-MODEL.md §2).
const TOP_ROW_NEXT_TO: Record<Face, Face> = { U: 'B', D: 'F', R: 'U', F: 'U', L: 'U', B: 'U' };

// `+ 0` turns -0 into 0, which toEqual would tell apart.
const vec = (x: number, y: number, z: number): Vec => [x + 0, y + 0, z + 0];
const add = (a: Vec, b: Vec): Vec => vec(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
const scale = (k: number, a: Vec): Vec => vec(k * a[0], k * a[1], k * a[2]);
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 0;
const cross = (a: Vec, b: Vec): Vec =>
  vec(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
const key = (a: Vec): string => a.join(',');

interface Sticker {
  face: Face;
  /** The centre of the cubie that carries the sticker, coordinates in {-1, 0, 1}. */
  position: Vec;
  /** The direction the sticker faces. */
  normal: Vec;
}

/**
 * Where facelet `index` sits. Faces come in FACE_ORDER, nine facelets each, in reading order with
 * the face seen from outside: rows advance away from the face named in TOP_ROW_NEXT_TO and, seen
 * from outside, columns advance to the viewer's right, which is normal × down.
 */
function sticker(index: number): Sticker {
  const face = FACE_ORDER[Math.floor(index / 9)];
  const row = Math.floor((index % 9) / 3);
  const column = index % 3;
  const normal = NORMAL[face];
  const down = scale(-1, NORMAL[TOP_ROW_NEXT_TO[face]]);
  const right = cross(normal, down);
  const position = add(normal, add(scale(column - 1, right), scale(row - 1, down)));
  return { face, position, normal };
}

const STICKERS: readonly Sticker[] = Array.from({ length: 54 }, (_, i) => sticker(i));

/** Rotation by a quarter turn clockwise, seen from outside, about the outward axis `axis`. */
function clockwise(axis: Vec, v: Vec): Vec {
  // Rodrigues' formula for an angle of -90°.
  return add(scale(-1, cross(axis, v)), scale(dot(axis, v), axis));
}

/** Where every facelet goes on `turns` clockwise quarter turns of `face`, from the model. */
function geometricTurn(face: Face, turns: number): number[] {
  const axis = NORMAL[face];
  const indexOf = new Map(STICKERS.map((s, i) => [key(s.position) + '|' + key(s.normal), i]));
  return STICKERS.map((s, i) => {
    if (dot(s.position, axis) !== 1) {
      return i;
    }
    let { position, normal } = s;
    for (let t = 0; t < turns; t++) {
      position = clockwise(axis, position);
      normal = clockwise(axis, normal);
    }
    const target = indexOf.get(key(position) + '|' + key(normal));
    if (target === undefined) {
      throw new Error(`The model has no sticker at ${key(position)} facing ${key(normal)}.`);
    }
    return target;
  });
}

// 54 distinct characters, so that a permutation is visible sticker by sticker.
const LABELLED = Array.from({ length: 54 }, (_, i) => String.fromCharCode(48 + i)).join('');

const CENTRES = [4, 13, 22, 31, 40, 49];

describe('the 3D model of the facelet layout', () => {
  it('puts the 54 stickers on the surface of a 3×3×3 cube, one per place', () => {
    const places = new Set(STICKERS.map((s) => key(s.position) + '|' + key(s.normal)));
    expect(places.size).toBe(54);
    for (const s of STICKERS) {
      expect(dot(s.position, s.normal)).toBe(1);
      for (const c of s.position) {
        expect([-1, 0, 1]).toContain(c);
      }
    }
  });

  it('puts every centre (index 4 of a face) in the middle of its face', () => {
    for (const [k, face] of FACE_ORDER.entries()) {
      expect(STICKERS[9 * k + 4].position).toEqual(NORMAL[face]);
    }
  });
});

describe('the cubie tables against the model', () => {
  it('cover the 48 facelets that are not centres, once each', () => {
    const listed = [...Object.values(CORNER_FACELETS), ...Object.values(EDGE_FACELETS)].flat();
    expect([...listed].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 54 }, (_, i) => i).filter((i) => !CENTRES.includes(i)),
    );
  });

  it.each(Object.entries(CORNER_FACELETS))(
    'corner %s: three facelets on three mutually adjacent faces, at their shared corner',
    (name, facelets) => {
      const stickers = facelets.map((i) => STICKERS[i]);
      // On the faces named by the position, in order, the U or D sticker first.
      expect(stickers.map((s) => s.face).join('')).toBe(name);
      expect(['U', 'D']).toContain(stickers[0].face);
      // Mutually adjacent: no two faces equal or opposite.
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        expect(dot(stickers[a].normal, stickers[b].normal)).toBe(0);
      }
      // One cubie, the one at the corner the three faces share.
      const corner = stickers.map((s) => s.normal).reduce(add);
      for (const s of stickers) {
        expect(s.position).toEqual(corner);
      }
      // Clockwise around the corner, seen from outside (the same handedness for every corner).
      expect(dot(cross(stickers[0].normal, stickers[1].normal), stickers[2].normal)).toBe(-1);
    },
  );

  it.each(Object.entries(EDGE_FACELETS))(
    'edge %s: two facelets on adjacent faces, at their shared edge',
    (name, facelets) => {
      const [first, second] = facelets.map((i) => STICKERS[i]);
      expect(first.face + second.face).toBe(name);
      // The U or D sticker first for U and D edges, the F or B sticker for the middle layer.
      expect(/[UD]/.test(name) ? ['U', 'D'] : ['F', 'B']).toContain(first.face);
      expect(dot(first.normal, second.normal)).toBe(0);
      const edge = add(first.normal, second.normal);
      expect(first.position).toEqual(edge);
      expect(second.position).toEqual(edge);
    },
  );
});

describe('adjacentFaces and opposite against the model', () => {
  it.each(FACE_ORDER)(
    'adjacentFaces(%s): the four neighbours, clockwise from outside, first row first',
    (face) => {
      const ring = adjacentFaces(face);
      expect(new Set(ring).size).toBe(4);
      expect(ring[0]).toBe(TOP_ROW_NEXT_TO[face]);
      for (const [k, a] of ring.entries()) {
        const b = ring[(k + 1) % 4];
        expect(dot(NORMAL[face], NORMAL[a])).toBe(0);
        // From a to b is a quarter turn clockwise about the outward normal of `face`.
        expect(clockwise(NORMAL[face], NORMAL[a])).toEqual(NORMAL[b]);
      }
    },
  );

  it.each(FACE_ORDER)('opposite(%s) faces the other way', (face) => {
    expect(NORMAL[opposite(face)]).toEqual(scale(-1, NORMAL[face]));
    expect(adjacentFaces(face)).not.toContain(opposite(face));
  });
});

describe('the move permutations against the model', () => {
  it.each(FACE_ORDER.flatMap((face) => ([1, 2, 3] as const).map((turns) => ({ face, turns }))))(
    'face $face, $turns quarter turn(s) clockwise',
    (move) => {
      const target = geometricTurn(move.face, move.turns);
      const expected: string[] = [];
      for (const [i, j] of target.entries()) {
        expected[j] = LABELLED.charAt(i);
      }
      expect(applyMove(LABELLED, move)).toBe(expected.join(''));
    },
  );

  it('moves the 20 stickers of the turning layer that are not its centre, nothing else', () => {
    for (const face of FACE_ORDER) {
      const after = applyMove(LABELLED, { face, turns: 1 });
      const moved = STICKERS.filter((_, i) => after.charAt(i) !== LABELLED.charAt(i)).length;
      expect(moved).toBe(20);
    }
  });
});
