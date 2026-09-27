// The cube simulator: states are Kociemba facelet strings (docs/DATA-MODEL.md §2) and every move
// is a permutation of the 54 facelet indices, derived once from the cubie tables of pieces.ts.
import type { Face, Move } from './notation';
import { CORNER_FACELETS, EDGE_FACELETS, adjacentFaces } from './pieces';

/**
 * A cube state: 54 characters, nine per face in the order U R F D L B, each the colour of one
 * sticker named after the face whose centre has that colour; positions within a face in reading
 * order with the face seen from outside (docs/DATA-MODEL.md §2).
 */
export type Facelets = string;

/** The solved state. */
export const SOLVED: Facelets = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

/** The order of the faces in a facelet string. */
export const FACE_ORDER: readonly Face[] = Object.freeze(['U', 'R', 'F', 'D', 'L', 'B']);

const FACELET_COUNT = 54;

/** The face a facelet index lies on. */
function faceOf(index: number): Face {
  return FACE_ORDER[Math.floor(index / 9)];
}

/** The 9 characters of one face, in reading order. */
export function faceletsOf(f: Facelets, face: Face): string {
  const start = 9 * FACE_ORDER.indexOf(face);
  return f.slice(start, start + 9);
}

function invalidFacelets(f: string, reason: string): Error {
  const shown = f.length > 60 ? `${f.slice(0, 60)}…` : f;
  return new Error(`Invalid facelets "${shown}": ${reason}.`);
}

/**
 * Throws unless `f` is a plausible cube state: 54 characters, nine of each colour `U R F D L B`,
 * every centre (index 4 of each face) showing its own face's colour.
 */
export function assertFacelets(f: string): asserts f is Facelets {
  if (f.length !== FACELET_COUNT) {
    throw invalidFacelets(
      f,
      `${String(FACELET_COUNT)} characters expected, got ${String(f.length)}`,
    );
  }
  for (const [k, face] of FACE_ORDER.entries()) {
    const count = f.split(face).length - 1;
    if (count !== 9) {
      throw invalidFacelets(f, `9 stickers of colour ${face} expected, got ${String(count)}`);
    }
    const centre = f.charAt(9 * k + 4);
    if (centre !== face) {
      throw invalidFacelets(f, `the centre of ${face} shows ${centre}`);
    }
  }
}

// A permutation is stored as its source table: after the move, facelet i shows what facelet
// source[i] showed before.
type Source = readonly number[];

/**
 * The clockwise quarter turn of `face`, derived from the cubie tables: every corner and edge with
 * a sticker on `face` moves to the position whose faces are its own faces carried one step along
 * adjacentFaces(face), and each of its stickers lands on the carried face. Centres, and the
 * stickers of pieces outside the layer, stay.
 */
function quarterTurnSource(face: Face): Source {
  const ring = adjacentFaces(face);
  const carry = (y: Face): Face => {
    const k = ring.indexOf(y);
    return k < 0 ? y : ring[(k + 1) % 4];
  };
  const source = Array.from({ length: FACELET_COUNT }, (_, i) => i);
  const pieceTables: readonly (readonly (readonly number[])[])[] = [
    Object.values(CORNER_FACELETS),
    Object.values(EDGE_FACELETS),
  ];
  for (const pieces of pieceTables) {
    const byFaces = new Map(
      pieces.map((p): [string, readonly number[]] => [p.map(faceOf).sort().join(''), p]),
    );
    for (const from of pieces) {
      if (!from.some((i) => faceOf(i) === face)) {
        continue;
      }
      const key = from
        .map((i) => carry(faceOf(i)))
        .sort()
        .join('');
      const to = byFaces.get(key);
      if (to === undefined) {
        throw new Error(`No piece position has the faces ${key}.`);
      }
      for (const i of from) {
        const target = to.find((j) => faceOf(j) === carry(faceOf(i)));
        if (target === undefined) {
          throw new Error(`Facelet ${String(i)} has no target for a turn of ${face}.`);
        }
        source[target] = i;
      }
    }
  }
  return source;
}

/** The permutation of doing `first`, then `second`. */
function compose(first: Source, second: Source): Source {
  return second.map((i) => first[i]);
}

function sourcesOf(face: Face): Record<Move['turns'], Source> {
  const quarter = quarterTurnSource(face);
  const half = compose(quarter, quarter);
  return { 1: quarter, 2: half, 3: compose(half, quarter) };
}

const SOURCES: Record<Face, Record<Move['turns'], Source>> = {
  U: sourcesOf('U'),
  D: sourcesOf('D'),
  R: sourcesOf('R'),
  L: sourcesOf('L'),
  F: sourcesOf('F'),
  B: sourcesOf('B'),
};

/** The state after one move. Throws if `f` is not 54 characters long. */
export function applyMove(f: Facelets, m: Move): Facelets {
  if (f.length !== FACELET_COUNT) {
    throw new Error(
      `Facelets must be ${String(FACELET_COUNT)} characters long, got ${String(f.length)}.`,
    );
  }
  let out = '';
  for (const i of SOURCES[m.face][m.turns]) {
    out += f.charAt(i);
  }
  return out;
}

/** The state after the moves, in order. */
export function applyMoves(f: Facelets, ms: readonly Move[]): Facelets {
  return ms.reduce(applyMove, f);
}

/** Every sticker equals its face's centre (index 4 of the face). */
export function isSolved(f: Facelets): boolean {
  if (f.length !== FACELET_COUNT) {
    return false;
  }
  for (let start = 0; start < FACELET_COUNT; start += 9) {
    const centre = f.charAt(start + 4);
    for (let i = start; i < start + 9; i++) {
      if (f.charAt(i) !== centre) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The same test as {@link isSolved}, named for call sites that care about orientation: face turns
 * never move the centres, so a cube solved in any whole-cube orientation already reads as solved
 * in the cube's own frame, and no rotation needs to be tried.
 */
export function isSolvedIgnoringOrientation(f: Facelets): boolean {
  return isSolved(f);
}
