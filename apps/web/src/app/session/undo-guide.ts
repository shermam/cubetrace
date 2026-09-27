// The undo guidance under the scramble (docs/PLAN.md, T1.6b): the moves that bring the cube back to
// the scramble's path, with those already made greyed out.

/** The moves shown, and how many of them, from the first, are done. */
export interface UndoGuide {
  readonly moves: readonly string[];
  readonly done: number;
}

export const NO_UNDO: UndoGuide = { moves: [], done: 0 };

/**
 * The guide after the tracker's `undo` changed. `ScrambleProgress.undo` loses its first move each
 * time the solver makes it, so while `undo` is the end of the moves shown, the moves before it are
 * done; anything else (a new wrong move, a half turn made halfway) starts a new guide.
 */
export function nextUndoGuide(guide: UndoGuide, undo: readonly string[]): UndoGuide {
  if (undo.length === 0) {
    return NO_UNDO;
  }
  const done = guide.moves.length - undo.length;
  const followed = done >= 0 && undo.every((move, k) => guide.moves[done + k] === move);
  return followed ? { moves: guide.moves, done } : { moves: [...undo], done: 0 };
}
