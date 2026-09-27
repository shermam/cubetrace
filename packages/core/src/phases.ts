// The colour-neutral CFOP phase detector (docs/DATA-MODEL.md §4, docs/PLAN.md T1.3): from the
// scrambled state and the timed solve moves, the eight phase boundaries with their recognition
// and execution times. Every predicate reads pieces through pieces.ts in the cube's own frame, so
// the cross may be on any of the six faces.
import type { Facelets } from './cube';
import { FACE_ORDER, applyMove, isSolved } from './cube';
import type { Face, Move } from './notation';
import type { CornerPos, EdgePos } from './pieces';
import { CORNER_FACELETS, EDGE_FACELETS, cornerAt, edgeAt, opposite } from './pieces';

/** A move with its time, in any single clock (cube ms in the tests, host ms in the app). */
export interface TimedMove {
  m: Move;
  ms: number;
}

export type PhaseName = 'cross' | 'f2l1' | 'f2l2' | 'f2l3' | 'f2l4' | 'eoll' | 'ocll' | 'pll';

/** The eight phases, in the order a solve goes through them. */
export const PHASE_NAMES: readonly PhaseName[] = Object.freeze([
  'cross',
  'f2l1',
  'f2l2',
  'f2l3',
  'f2l4',
  'eoll',
  'ocll',
  'pll',
]);

export interface PhaseRecord {
  name: PhaseName;
  /** f2l phases only: the slot of the pair, named by its middle-layer edge position (`'FR'`). */
  slot?: EdgePos;
  /** The previous phase's `endMs`; for the cross, the first move's `ms` (or `solveStartMs`). */
  startMs: number;
  /** The `ms` of the move that completed the phase. */
  endMs: number;
  /** Face turns in the phase; 0 for a phase already satisfied when the previous one ended. */
  moves: number;
  /** From `startMs` to the phase's first move. */
  recognitionMs: number;
  /** From the phase's first move to `endMs`. */
  executionMs: number;
  /** Index into the input moves of the move that completed the phase. */
  endMoveIndex: number;
}

export interface PhaseReport {
  /** The face the cross was built on; `null` if no cross was completed. */
  crossFace: Face | null;
  /**
   * True when the first cross found was abandoned: a pair completed on another face with a
   * complete cross before any pair completed on the first one, and the phases were recomputed
   * with that other face as the cross face.
   */
  crossFaceSwitched: boolean;
  /** The phases completed, in order; all eight when `complete`. */
  phases: PhaseRecord[];
  /** Index into the input moves of the first move after which the cube is solved. */
  solvedAtMove: number | null;
  /** All eight phases were found, i.e. the cube was solved. */
  complete: boolean;
}

export interface DetectPhasesOptions {
  /** Forces the cross face: no detection, no switching. */
  crossFace?: Face;
  /**
   * When the solve started, in the clock of the moves, if that was before the first move (a timer
   * started by a pickup, say): the cross then starts here and its recognition is the time from here
   * to the first move. Without it the cross starts at the first move and its recognition is 0.
   */
  solveStartMs?: number;
}

// ---- Piece tables, derived once from pieces.ts ----

const EDGES = Object.keys(EDGE_FACELETS) as EdgePos[];
const CORNERS = Object.keys(CORNER_FACELETS) as CornerPos[];

/** The face a facelet index lies on: faces come in FACE_ORDER, nine facelets each. */
function faceOfFacelet(index: number): Face {
  return FACE_ORDER[Math.floor(index / 9)];
}

/** The index of the centre facelet of `face`. */
function centreIndex(face: Face): number {
  return 9 * FACE_ORDER.indexOf(face) + 4;
}

/** The faces of each edge position's stickers, in the order edgeAt returns their colours. */
const EDGE_FACES = Object.fromEntries(
  EDGES.map((pos) => [pos, EDGE_FACELETS[pos].map(faceOfFacelet)]),
) as Record<EdgePos, Face[]>;

/** The faces of each corner position's stickers, in the order cornerAt returns their colours. */
const CORNER_FACES = Object.fromEntries(
  CORNERS.map((pos) => [pos, CORNER_FACELETS[pos].map(faceOfFacelet)]),
) as Record<CornerPos, Face[]>;

/** Each sticker of the edge at `pos` shows the colour of the centre of the face it lies on. */
function edgeSolved(f: Facelets, pos: EdgePos): boolean {
  const faces = EDGE_FACES[pos];
  return edgeAt(f, pos).every((colour, k) => colour === f.charAt(centreIndex(faces[k])));
}

/** Each sticker of the corner at `pos` shows the colour of the centre of the face it lies on. */
function cornerSolved(f: Facelets, pos: CornerPos): boolean {
  const faces = CORNER_FACES[pos];
  return cornerAt(f, pos).every((colour, k) => colour === f.charAt(centreIndex(faces[k])));
}

interface Slot {
  /** The slot's middle-layer edge position, which names it. */
  edge: EdgePos;
  /** The corner position between the cross face and that edge. */
  corner: CornerPos;
}

interface FaceTables {
  /** The four edge positions with a sticker on the face. */
  edges: EdgePos[];
  /** The four corner positions with a sticker on the face. */
  corners: CornerPos[];
  /** With this face as the cross face, its four F2L slots, in EDGE_FACELETS order. */
  slots: Slot[];
}

function faceTables(face: Face): FaceTables {
  const far = opposite(face);
  const slots = EDGES.filter((edge) => !EDGE_FACES[edge].some((x) => x === face || x === far)).map(
    (edge): Slot => {
      const faces = [face, ...EDGE_FACES[edge]];
      const corner = CORNERS.find((pos) => faces.every((x) => CORNER_FACES[pos].includes(x)));
      if (corner === undefined) {
        throw new Error(`No corner position between ${face} and ${edge}.`);
      }
      return { edge, corner };
    },
  );
  return {
    edges: EDGES.filter((pos) => EDGE_FACES[pos].includes(face)),
    corners: CORNERS.filter((pos) => CORNER_FACES[pos].includes(face)),
    slots,
  };
}

const TABLES = Object.fromEntries(FACE_ORDER.map((face) => [face, faceTables(face)])) as Record<
  Face,
  FaceTables
>;

// ---- Predicates (docs/DATA-MODEL.md §4) ----

/**
 * The cross of `face` is complete: its four edges are in place and oriented, i.e. each one's
 * sticker on `face` shows `face`'s colour and its other sticker matches the adjacent centre.
 */
export function crossComplete(f: Facelets, face: Face): boolean {
  return TABLES[face].edges.every((pos) => edgeSolved(f, pos));
}

/**
 * The F2L slots (relative to `crossFace`) whose corner–edge pair is fully in place: the corner
 * between the cross face and the slot, and the slot's middle-layer edge, both solved. Slots are
 * named by their middle-layer edge position (`'FR'`, `'FL'`, `'BL'`, `'BR'` for a U or D cross)
 * and listed in EDGE_FACELETS order. The cross itself is not checked here; detectPhases counts
 * these pairs only while the cross is complete.
 */
export function f2lSlotsComplete(f: Facelets, crossFace: Face): EdgePos[] {
  return TABLES[crossFace].slots
    .filter(({ edge, corner }) => edgeSolved(f, edge) && cornerSolved(f, corner))
    .map(({ edge }) => edge);
}

/**
 * All four last-layer edges show the last-layer colour on the last-layer face, the face opposite
 * `crossFace`.
 */
export function eollComplete(f: Facelets, crossFace: Face): boolean {
  const last = opposite(crossFace);
  const colour = f.charAt(centreIndex(last));
  return TABLES[last].edges.every(
    (pos) => edgeAt(f, pos)[EDGE_FACES[pos].indexOf(last)] === colour,
  );
}

/** All four last-layer corners show the last-layer colour on the last-layer face. */
export function ocllComplete(f: Facelets, crossFace: Face): boolean {
  const last = opposite(crossFace);
  const colour = f.charAt(centreIndex(last));
  return TABLES[last].corners.every(
    (pos) => cornerAt(f, pos)[CORNER_FACES[pos].indexOf(last)] === colour,
  );
}

// ---- The detector ----

/**
 * The pairs that count towards the f2l phases on `crossFace`: none while its cross is broken.
 * During an insertion that takes a cross edge out, another pair can sit in place for a move or
 * two; counting it would end the phase mid-insertion with the wrong slot (docs/DATA-MODEL.md §4).
 */
function countedSlots(f: Facelets, crossFace: Face): EdgePos[] {
  return crossComplete(f, crossFace) ? f2lSlotsComplete(f, crossFace) : [];
}

/**
 * Of `faces`, the one with the most pairs counting on it, the first of them on a tie: the choice
 * when one move completes several crosses, or when the cross face switches. Preferring progress
 * over the order of the faces keeps the choice colour-neutral unless the counts tie.
 */
function mostPairs(f: Facelets, faces: readonly Face[]): Face | undefined {
  let best: Face | undefined;
  let bestCount = -1;
  for (const face of faces) {
    const count = countedSlots(f, face).length;
    if (count > bestCount) {
      best = face;
      bestCount = count;
    }
  }
  return best;
}

/** Where a phase ended: the index of the move that completed it, and an f2l phase's slot. */
interface PhaseEnd {
  index: number;
  slot?: EdgePos;
}

interface Scan {
  crossFace: Face | null;
  ends: PhaseEnd[];
  solvedAt: number | null;
  /** Set when the cross face has to switch to this face (see `scan`). */
  switchTo: Face | null;
}

/**
 * Walks the moves once, ending each phase at the first move after which its predicate holds; one
 * move may end several phases. With `forced`, the cross face is that face. Otherwise it is the
 * first face whose cross completes (faces whose cross is complete in `scrambled` excluded), and the
 * walk stops with `switchTo` if, before any pair counts on it, a pair counts on another face whose
 * cross is complete.
 */
function scan(scrambled: Facelets, moves: readonly TimedMove[], forced: Face | undefined): Scan {
  const candidates =
    forced === undefined ? FACE_ORDER.filter((x) => !crossComplete(scrambled, x)) : [forced];
  const ends: PhaseEnd[] = [];
  const slotsDone: EdgePos[] = [];
  let crossFace: Face | null = null;
  let f = scrambled;
  for (const [i, { m }] of moves.entries()) {
    f = applyMove(f, m);
    if (crossFace === null) {
      const first = mostPairs(
        f,
        candidates.filter((x) => crossComplete(f, x)),
      );
      if (first === undefined) {
        if (isSolved(f)) {
          return { crossFace, ends, solvedAt: i, switchTo: null };
        }
        continue;
      }
      crossFace = first;
      ends.push({ index: i });
    }
    if (ends.length <= 4) {
      const slots = countedSlots(f, crossFace);
      if (forced === undefined && ends.length === 1 && slots.length === 0) {
        const current = crossFace;
        const other = mostPairs(
          f,
          FACE_ORDER.filter((x) => x !== current && countedSlots(f, x).length > 0),
        );
        if (other !== undefined) {
          return { crossFace, ends, solvedAt: null, switchTo: other };
        }
      }
      // f2lK ends when K pairs count; its slot is one that no earlier f2l phase took (pairs
      // completed by the same move are taken in EDGE_FACELETS order).
      while (ends.length <= 4 && slots.length >= ends.length) {
        const slot = slots.find((s) => !slotsDone.includes(s));
        if (slot === undefined) {
          break;
        }
        slotsDone.push(slot);
        ends.push({ index: i, slot });
      }
    }
    if (ends.length === 5 && eollComplete(f, crossFace)) {
      ends.push({ index: i });
    }
    if (ends.length === 6 && ocllComplete(f, crossFace)) {
      ends.push({ index: i });
    }
    if (isSolved(f)) {
      if (ends.length === 7) {
        ends.push({ index: i });
      }
      return { crossFace, ends, solvedAt: i, switchTo: null };
    }
  }
  return { crossFace, ends, solvedAt: null, switchTo: null };
}

/**
 * The CFOP phases of a solve (docs/DATA-MODEL.md §4). `scrambled` is the state before the first
 * move and `moves` are the solve's face turns with their times. Each phase ends at the first move
 * after which its predicate holds; a phase already satisfied when the previous one ends is a skip
 * (no moves, zero durations, the previous phase's `endMoveIndex`). Moves after the cube is first
 * solved are ignored.
 */
export function detectPhases(
  scrambled: Facelets,
  moves: readonly TimedMove[],
  opts: DetectPhasesOptions = {},
): PhaseReport {
  let result = scan(scrambled, moves, opts.crossFace);
  const crossFaceSwitched = result.switchTo !== null;
  if (result.switchTo !== null) {
    result = scan(scrambled, moves, result.switchTo);
  }
  const phases: PhaseRecord[] = [];
  let startMs = moves.length > 0 ? (opts.solveStartMs ?? moves[0].ms) : 0;
  let previousEnd = -1;
  for (const [k, end] of result.ends.entries()) {
    const count = end.index - previousEnd;
    const endMs = moves[end.index].ms;
    const firstMoveMs = count > 0 ? moves[previousEnd + 1].ms : endMs;
    const record: PhaseRecord = {
      name: PHASE_NAMES[k],
      startMs,
      endMs,
      moves: count,
      recognitionMs: count > 0 ? firstMoveMs - startMs : 0,
      executionMs: count > 0 ? endMs - firstMoveMs : 0,
      endMoveIndex: end.index,
    };
    if (end.slot !== undefined) {
      record.slot = end.slot;
    }
    phases.push(record);
    startMs = endMs;
    previousEnd = end.index;
  }
  return {
    crossFace: result.crossFace,
    crossFaceSwitched,
    phases,
    solvedAtMove: result.solvedAt,
    complete: phases.length === PHASE_NAMES.length,
  };
}
