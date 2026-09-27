// Move notation (docs/DATA-MODEL.md §2): face turns `U D R L F B`, each optionally followed by
// `'` (counter-clockwise) or `2` (half turn), written as in WCA notation. Wide moves, rotations and
// slices are not part of v1 and are rejected.

/** A face of the cube, named after the colour of its centre in the cube's own frame. */
export type Face = 'U' | 'D' | 'R' | 'L' | 'F' | 'B';

/** A face turn: `turns` quarter turns clockwise as seen from outside `face`; 3 is `'`. */
export interface Move {
  face: Face;
  turns: 1 | 2 | 3;
}

/** Thrown by the parsers on any token that is not a face turn. */
export class NotationError extends Error {
  override name = 'NotationError';
}

const FACES: ReadonlySet<string> = new Set<Face>(['U', 'D', 'R', 'L', 'F', 'B']);

const SUFFIX: Record<Move['turns'], string> = { 1: '', 2: '2', 3: "'" };

const INVERSE_TURNS = { 1: 3, 2: 2, 3: 1 } as const;

const EXPECTED = "expected a face turn U D R L F B with an optional ' or 2";

function isFace(c: string): c is Face {
  return FACES.has(c);
}

/** The move a token names, or `null` if the token is not exactly one face turn. */
function readMove(token: string): Move | null {
  const face = token.charAt(0);
  if (!isFace(face)) {
    return null;
  }
  switch (token.slice(1)) {
    case '':
      return { face, turns: 1 };
    case '2':
      return { face, turns: 2 };
    case "'":
      return { face, turns: 3 };
    default:
      return null;
  }
}

/** Parses one token such as `R`, `R2` or `R'`; anything else throws a {@link NotationError}. */
export function parseMove(token: string): Move {
  const move = readMove(token);
  if (move === null) {
    throw new NotationError(`Invalid move "${token}": ${EXPECTED}.`);
  }
  return move;
}

/**
 * Parses a sequence such as `"R U2 F'"`. Tokens are separated by any whitespace; leading and
 * trailing whitespace is ignored and an empty text is the empty sequence. Any token that is not a
 * face turn (a wide move, a rotation, a slice, `R2'`, ...) throws a {@link NotationError}.
 */
export function parseMoves(text: string): Move[] {
  const trimmed = text.trim();
  if (trimmed === '') {
    return [];
  }
  return trimmed.split(/\s+/).map((token, i) => {
    const move = readMove(token);
    if (move === null) {
      throw new NotationError(`Invalid move "${token}" (token ${String(i + 1)}): ${EXPECTED}.`);
    }
    return move;
  });
}

/** `"R"`, `"R2"` or `"R'"`. */
export function formatMove(m: Move): string {
  return m.face + SUFFIX[m.turns];
}

/** The moves separated by single spaces; `""` for no moves. */
export function formatMoves(ms: readonly Move[]): string {
  return ms.map(formatMove).join(' ');
}

/** The move that undoes `m`: `R` ↔ `R'`, `R2` stays `R2`. */
export function inverse(m: Move): Move {
  return { face: m.face, turns: INVERSE_TURNS[m.turns] };
}

/** The sequence that undoes `ms`: reversed, each move inverted. */
export function inverseSequence(ms: readonly Move[]): Move[] {
  return ms.map(inverse).reverse();
}

/** Length in the quarter-turn metric: a half turn counts 2, any other move 1. */
export function quarterTurns(ms: readonly Move[]): number {
  return ms.reduce((n, m) => n + (m.turns === 2 ? 2 : 1), 0);
}
