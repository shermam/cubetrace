import { parseMove } from '@cubetrace/core';
import type { CubeMoveEvent } from '@cubetrace/gan';

import { moveLogRows } from './move-log';

function move(m: string, cubeMs: number, hostMs: number, packetLast = true): CubeMoveEvent {
  return { type: 'move', m: parseMove(m), cubeMs, hostMs, packetLast };
}

describe('moveLogRows', () => {
  it('lists the moves newest first, with the gaps on both clocks and the packet ends', () => {
    const moves = [
      move('R', 1000, 5000.2),
      move("U'", 1120, 5140.7, false),
      move('U', 1127, 5140.7),
    ];

    expect(moveLogRows(moves, 3)).toEqual([
      { n: 3, move: 'U', cubeMs: 1127, gapMs: 7, hostGapMs: 0, packetLast: true },
      { n: 2, move: "U'", cubeMs: 1120, gapMs: 120, hostGapMs: 141, packetLast: false },
      { n: 1, move: 'R', cubeMs: 1000, gapMs: null, hostGapMs: null, packetLast: true },
    ]);
  });

  it('shows only the newest rows, numbered among all the moves of the connection', () => {
    const moves = Array.from({ length: 30 }, (_, i) => move('R', i * 10, i * 10));

    const rows = moveLogRows(moves, 250, 20);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ n: 250, cubeMs: 290, gapMs: 10 });
    expect(rows[19]).toMatchObject({ n: 231, cubeMs: 100, gapMs: 10 });
  });

  it('is empty without moves', () => {
    expect(moveLogRows([], 0)).toEqual([]);
  });
});
