import { expect, test } from '@playwright/test';

import { fixtureSolve } from './helpers/fixtures';
import { demoPath, expectSolves } from './helpers/timer';
import { recordTimerViews, timerViews, viewAfter, type TimerView } from './helpers/timer-views';

// T1.13: the moves of the scramble are marked as the cube makes them (src/app/timer/scramble-view.ts):
// `done` (green) once made, `partial` (yellow) while a half turn is half made, `wrong` (red) where
// the cube left the scramble; all `done` while the attempt is armed, none from the solve on. The
// demo cube makes each half turn as two quarter turns and cuts its replay before the second one
// (src/app/cube/demo.ts), so the page renders every half-made turn even at speed 20; the flows read
// the marks from the record of the page's views (helpers/timer-views.ts).

/** `count` times `mark`. */
function marks(count: number, mark: string): string[] {
  return new Array<string>(count).fill(mark);
}

/** How many scramble moves a view's progress ("5 / 21") says are reached. */
function reached(view: TimerView): number {
  return Number((view.progress ?? '').split(' / ')[0]);
}

test('each half turn of the scramble is partial after its first quarter turn, then done; all done once armed', async ({
  page,
}) => {
  // Demo solve 1: 11 of its 21 moves are half turns, its last one (R2) too.
  const solve = fixtureSolve(1);
  const moves = solve.scramble.split(' ');
  const halfTurns = moves.flatMap((move, i) => (move.endsWith('2') ? [i] : []));
  expect(halfTurns).toHaveLength(11);
  await recordTimerViews(page);

  await page.goto(demoPath(1, 20));
  await expectSolves(page, 1);
  const views = await timerViews(page);
  const ours = (view: TimerView): boolean => view.scramble === solve.scramble;
  const armed = viewAfter(views, -1, 'the armed attempt', (view) => view.phase === 'armed');
  const scrambling = views
    .slice(0, armed)
    .filter((view) => view.phase === 'scrambling' && ours(view));
  expect(scrambling.length).toBeGreaterThan(0);

  // While scrambling: the moves reached are done, only the next two can be begun, none is wrong.
  for (const view of scrambling) {
    const k = reached(view);
    expect(view.marks.slice(0, k)).toEqual(marks(k, 'done'));
    expect(view.marks.slice(k + 2)).toEqual(marks(Math.max(0, moves.length - k - 2), 'pending'));
    expect(view.marks).not.toContain('wrong');
  }
  // Each half turn: partial after its first quarter turn, then done.
  for (const i of halfTurns) {
    const move = `move ${String(i + 1)} (${moves[i]})`;
    const partial = viewAfter(
      views,
      -1,
      `${move} half made`,
      (view) => ours(view) && view.marks[i] === 'partial',
    );
    viewAfter(views, partial, `${move} done`, (view) => ours(view) && view.marks[i] === 'done');
  }
  // Just before the move that completes the scramble: every move done but the last, half made.
  expect(scrambling.at(-1)?.marks).toEqual([...marks(moves.length - 1, 'done'), 'partial']);

  // Armed: every move done, until the solve starts; from then on no marks, the next attempt's
  // scramble included.
  const solving = viewAfter(views, armed, 'the solve', (view) => view.phase === 'solving');
  for (const view of views.slice(armed, solving)) {
    expect(view).toMatchObject({ phase: 'armed', marks: marks(moves.length, 'done') });
  }
  for (const view of views.slice(solving)) {
    expect(view.marks).toEqual(marks(view.marks.length, 'pending'));
  }
});

test('?misscramble=5: move 6 is wrong while the undo guidance shows, then done once corrected; all done once armed', async ({
  page,
}) => {
  const solve = fixtureSolve(0);
  const moves = solve.scramble.split(' ');
  await recordTimerViews(page);

  await page.goto(demoPath(0, 20, 5));
  await expectSolves(page, 1);
  const views = await timerViews(page);

  // The wrong turn after move 5: move 6 is red, with the guidance, and only while it is shown.
  const guided = viewAfter(views, -1, 'the undo guidance', (view) => view.undo !== null);
  expect(views[guided].marks).toEqual([
    ...marks(5, 'done'),
    'wrong',
    ...marks(moves.length - 6, 'pending'),
  ]);
  for (const view of views) {
    expect(view.marks.includes('wrong')).toBe(view.undo !== null);
  }
  // Corrected: move 6 made, then the scramble complete, all done.
  const cleared = viewAfter(views, guided, 'the guidance cleared', (view) => view.undo === null);
  const corrected = viewAfter(
    views,
    cleared - 1,
    'move 6 done',
    (view) => view.phase === 'scrambling' && view.marks[5] === 'done',
  );
  const armed = viewAfter(views, corrected, 'the armed attempt', (view) => view.phase === 'armed');
  expect(views[armed].marks).toEqual(marks(moves.length, 'done'));
});
