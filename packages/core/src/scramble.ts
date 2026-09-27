// Scrambles (docs/PLAN.md, T1.2): WCA random-state scrambles from cubing.js, the state a scramble
// leads to, and a tracker that follows the cube through a scramble with "you are here" and "undo
// this" guidance (docs/DATA-MODEL.md §3: scramble_start, scramble_done, scramble_extra_moves).
import { randomScrambleForEvent } from 'cubing/scramble';
import { setSearchDebug } from 'cubing/search';

import type { Facelets } from './cube';
import { SOLVED, applyMove, applyMoves, assertFacelets } from './cube';
import type { Move } from './notation';
import { NotationError, formatMoves, inverseSequence, parseMoves, quarterTurns } from './notation';
import { opposite } from './pieces';

/**
 * A WCA random-state 3x3x3 scramble from cubing.js (`randomScrambleForEvent("333")`), in our
 * notation: face turns separated by single spaces (docs/DATA-MODEL.md §2). cubing.js searches in a
 * module worker (a Web Worker in the browser, a worker thread in Node) that it starts on the first
 * call and reuses afterwards. Rejects with a {@link NotationError} if cubing.js ever returns a
 * token outside our notation (see {@link normalizeScramble}).
 */
export async function generateScramble(): Promise<string> {
  configureCubing();
  const alg = await randomScrambleForEvent('333');
  return normalizeScramble(alg.toString());
}

let cubingConfigured = false;

/**
 * Settings of cubing.js's search, applied once before the first scramble (not at import time, so
 * that importing the package has no side effects; docs/TOOLCHAIN.md, "cubing.js"):
 * - Start the worker from the chunk the bundler emitted for its entry ("the esbuild workaround")
 *   before trying `import.meta.resolve("./search-worker-entry.js")`, cubing.js's default first
 *   attempt: Angular's esbuild build and Vite's dependency optimizer (`ng serve`) emit no such
 *   file, so the first scramble of every page began with a failed worker and a 404. In Node, where
 *   nothing is bundled, the workaround finds the same file.
 * - No console warning with the duration of every scramble search.
 */
function configureCubing(): void {
  if (!cubingConfigured) {
    setSearchDebug({ prioritizeEsbuildWorkaroundForWorkerInstantiation: true, logPerf: false });
    cubingConfigured = true;
  }
}

/**
 * A scramble as cubing.js writes it, rewritten in our notation. The only token rewritten is the
 * one with an obvious equivalent: a half turn with a direction, `U2'`, becomes `U2` (the same
 * turn). Any other token that is not a face turn throws a {@link NotationError}.
 *
 * Exported for the tests; not part of the package's API.
 */
export function normalizeScramble(text: string): string {
  const tokens = text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^([UDRLFB])2'$/, '$12'));
  try {
    return formatMoves(parseMoves(tokens.join(' ')));
  } catch (error: unknown) {
    if (error instanceof NotationError) {
      throw new NotationError(`Scramble "${text}" is not in our notation. ${error.message}`);
    }
    throw error;
  }
}

/** The state a scramble leads to from solved: `applyMoves(SOLVED, parseMoves(scramble))`. */
export function scrambleTarget(scramble: string): Facelets {
  return applyMoves(SOLVED, parseMoves(scramble));
}

/** Where the cube is on its way through a scramble, after the moves seen so far. */
export interface ScrambleProgress {
  /** Scramble moves reached so far (0..n). A half turn made halfway is not reached yet. */
  matched: number;
  /** The number of moves in the scramble. */
  total: number;
  /** The current state equals the target. */
  done: boolean;
  /** The cube is off the scramble path. */
  diverged: boolean;
  /**
   * Moves to make, in order, to get back to the last state on the scramble path: the inverse of
   * the moves made since the cube left it, consecutive turns of one face merged, so that it gets
   * shorter as it is followed (making its first move removes it; a half turn made as two quarter
   * turns becomes a quarter turn first). Empty when not diverged.
   */
  undo: Move[];
  /**
   * Moves made that were not part of the scramble path, in quarter turns (a smart cube reports
   * every move as a quarter turn; a half turn counts 2, as in `quarterTurns`). It grows with
   * mistakes and their corrections: one wrong quarter turn undone costs 2.
   */
  extraMoves: number;
}

/**
 * Appends `m` to `moves`, merged with the last move when both turn the same face: `R` then `R'`
 * leaves nothing, `R` then `R` is `R2`. So undoing the last move of a detour shortens it.
 */
function appendMerged(moves: Move[], m: Move): void {
  const last = moves.at(-1);
  if (last?.face !== m.face) {
    moves.push(m);
    return;
  }
  const turns = (last.turns + m.turns) % 4;
  if (turns === 1 || turns === 2 || turns === 3) {
    moves[moves.length - 1] = { face: m.face, turns };
  } else {
    moves.pop();
  }
}

/** A stage of a scramble move made with turns of its own face. */
interface Stage {
  /** The turn that brings the move to this stage, or `null` before it starts. */
  turn: Move | null;
  /** Quarter turns of the move covered. */
  covered: number;
  whole: boolean;
}

const NOT_STARTED: Stage = { turn: null, covered: 0, whole: false };

/** Not started, halfway through a half turn (in either direction), or whole. */
function stagesOf(m: Move): Stage[] {
  const whole: Stage = { turn: m, covered: quarterTurns([m]), whole: true };
  if (m.turns !== 2) {
    return [NOT_STARTED, whole];
  }
  return [
    NOT_STARTED,
    { turn: { face: m.face, turns: 1 }, covered: 1, whole: false },
    { turn: { face: m.face, turns: 3 }, covered: 1, whole: false },
    whole,
  ];
}

/**
 * Follows the cube through a scramble. Every move updates the current state, which is compared
 * with the states the scramble passes through (`expected[k]`, the state after its first `k`
 * moves): the largest `k` in `[matched, min(n, matched + 2)]` whose state equals the current one
 * becomes `matched` (docs/PLAN.md, T1.2). A `U2` may arrive as two quarter turns and two moves on
 * opposite faces may be made in either order, so the states in between two expected states on the
 * way to `expected[matched + 2]` are also on the path ("in flight"): not diverged, `matched`
 * unchanged. Any other state is off the path: `diverged`, and `undo` is the inverse of the moves
 * made since the cube was last on it. The target, once reached by whatever path, is `done`.
 */
export class ScrambleTracker {
  readonly #moves: readonly Move[];
  /** `expected[k]`: the state after the first `k` scramble moves, from the start state. */
  readonly #expected: readonly Facelets[];
  /** `pathQuarters[k]`: the quarter turns of the first `k` scramble moves. */
  readonly #pathQuarters: readonly number[];
  #current: Facelets;
  #matched = 0;
  /** The in-flight states after `expected[#matched]`, with the quarter turns of path they cover. */
  #inFlight: ReadonlyMap<Facelets, number>;
  /**
   * Moves made since the cube was last on the scramble path, same-face neighbours merged (see
   * {@link appendMerged}); empty while on it.
   */
  #sincePath: Move[] = [];
  /** Quarter turns of every move made. */
  #madeQuarters = 0;
  /** Quarter turns of scramble path covered by the last state on the path. */
  #pathCovered = 0;
  #progress: ScrambleProgress;

  /**
   * @param scramble the scramble, in our notation; throws a {@link NotationError} otherwise.
   * @param start the cube's state when the scramble begins. The path, and the target, are the
   *   scramble applied to it: the target is `scrambleTarget(scramble)` for the default, solved.
   */
  constructor(scramble: string, start: Facelets = SOLVED) {
    assertFacelets(start);
    this.#moves = parseMoves(scramble);
    const expected = [start];
    const pathQuarters = [0];
    for (const [k, m] of this.#moves.entries()) {
      expected.push(applyMove(expected[k], m));
      pathQuarters.push(pathQuarters[k] + quarterTurns([m]));
    }
    this.#expected = expected;
    this.#pathQuarters = pathQuarters;
    this.#current = start;
    this.#inFlight = this.#inFlightAfter(0);
    this.#progress = this.#snapshot();
  }

  /** The progress after the last move (or at the start). */
  get progress(): ScrambleProgress {
    return this.#progress;
  }

  /** The cube's current state. */
  get state(): Facelets {
    return this.#current;
  }

  /** Takes one move of the cube and returns the progress after it (also {@link progress}). */
  onMove(m: Move): ScrambleProgress {
    this.#current = applyMove(this.#current, m);
    this.#madeQuarters += quarterTurns([m]);
    const k = this.#matchedIndex();
    if (k !== null) {
      // Back on the path, or further along it: the moves since the last match are discarded.
      if (k !== this.#matched) {
        this.#matched = k;
        this.#inFlight = this.#inFlightAfter(k);
      }
      this.#sincePath = [];
      this.#pathCovered = this.#pathQuarters[k];
    } else {
      const covered = this.#inFlight.get(this.#current);
      if (covered !== undefined) {
        this.#sincePath = [];
        this.#pathCovered = covered;
      } else {
        appendMerged(this.#sincePath, m);
      }
    }
    this.#progress = this.#snapshot();
    return this.#progress;
  }

  /**
   * The largest `k` in `[matched, min(n, matched + 2)]` with `expected[k]` equal to the current
   * state, or `n` if the current state is the target however far along it is: a mis-scramble fixed
   * by another path is done too.
   */
  #matchedIndex(): number | null {
    const n = this.#moves.length;
    if (this.#current === this.#expected[n]) {
      return n;
    }
    for (let k = Math.min(n, this.#matched + 2); k >= this.#matched; k--) {
      if (this.#expected[k] === this.#current) {
        return k;
      }
    }
    return null;
  }

  /**
   * The states strictly between `expected[k]` and the next expected states, keyed to the quarter
   * turns of path they cover: move `k + 1` half made (a half turn done halfway), and, when move
   * `k + 2` is on the opposite face (the two commute), every combination of the stages of both
   * except the expected states themselves.
   */
  #inFlightAfter(k: number): Map<Facelets, number> {
    const states = new Map<Facelets, number>();
    const first = this.#moves.at(k);
    if (first === undefined) {
      return states;
    }
    const second = this.#moves.at(k + 1);
    const secondStages =
      second !== undefined && second.face === opposite(first.face)
        ? stagesOf(second)
        : [NOT_STARTED];
    for (const a of stagesOf(first)) {
      for (const b of secondStages) {
        const expected =
          (a.turn === null && b.turn === null) ||
          (a.whole && b.turn === null) ||
          (a.whole && b.whole);
        if (expected) {
          continue;
        }
        const turns = [a.turn, b.turn].filter((t): t is Move => t !== null);
        states.set(
          applyMoves(this.#expected[k], turns),
          this.#pathQuarters[k] + a.covered + b.covered,
        );
      }
    }
    return states;
  }

  #snapshot(): ScrambleProgress {
    const diverged = this.#sincePath.length > 0;
    return {
      matched: this.#matched,
      total: this.#moves.length,
      done: this.#current === this.#expected[this.#moves.length],
      diverged,
      undo: diverged ? inverseSequence(this.#sincePath) : [],
      extraMoves: Math.max(0, this.#madeQuarters - this.#pathCovered),
    };
  }
}
