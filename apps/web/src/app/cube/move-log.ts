import { formatMove } from '@cubetrace/core';
import type { CubeMoveEvent } from '@cubetrace/gan';

/** How many moves the live cube panel lists. */
export const MOVE_LOG_ROWS = 20;

/** One line of the move log (docs/MANUAL-TESTS.md, T1.5, reads it). */
export interface MoveLogRow {
  /** 1 for the first move since the cube connected. */
  readonly n: number;
  readonly move: string;
  readonly cubeMs: number;
  /** Cube-clock ms since the previous move; null for the first one. */
  readonly gapMs: number | null;
  /**
   * Host-clock ms since the previous move, rounded: 0 between the moves of one Bluetooth packet,
   * which share its arrival time. Null for the first move.
   */
  readonly hostGapMs: number | null;
  /** The newest move of its Bluetooth packet. */
  readonly packetLast: boolean;
}

/**
 * The newest `rows` of `moves` (the latest moves, oldest first, as `CubeService.moves` keeps
 * them), newest first. `total` is how many moves the connection has reported, which numbers them.
 */
export function moveLogRows(
  moves: readonly CubeMoveEvent[],
  total: number,
  rows = MOVE_LOG_ROWS,
): MoveLogRow[] {
  const first = Math.max(0, moves.length - rows);
  const result: MoveLogRow[] = [];
  for (let i = moves.length - 1; i >= first; i--) {
    const move = moves[i];
    const previous = i > 0 ? moves[i - 1] : undefined;
    result.push({
      n: total - (moves.length - 1 - i),
      move: formatMove(move.m),
      cubeMs: move.cubeMs,
      gapMs: previous === undefined ? null : move.cubeMs - previous.cubeMs,
      hostGapMs: previous === undefined ? null : Math.round(move.hostMs - previous.hostMs),
      packetLast: move.packetLast,
    });
  }
  return result;
}
