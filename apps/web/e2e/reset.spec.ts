import { expect, test } from '@playwright/test';

import { exportSession } from './helpers/export';
import { fixtureSolve } from './helpers/fixtures';
import { currentSessionId, demoPath, expectSolves, solveRows } from './helpers/timer';
import { recordTimerViews, timerViews } from './helpers/timer-views';

// "Mark as solved" (T1.14) with the demo cube. Pressed during the scramble, it tells the cube that it
// is solved: the attempt under way is dropped without a record and begins again, from its start,
// with the same scramble and number; the demo cube's replay stops there, as a solver's hands would.
// A fresh demo, the page loaded again with ?demo (the session goes on), then scrambles and solves
// that attempt.

const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

test('Mark as solved during the scramble: the attempt begins again with its scramble, and a fresh demo solves it', async ({
  page,
}) => {
  const solve = fixtureSolve(0);
  const total = solve.scramble.split(' ').length;
  // Part-way through the scramble: 1 to 20 of its 21 moves made (the page pads the text).
  const partWay = new RegExp(`^\\s*([1-9]|1\\d|20) / ${String(total)}\\s*$`);
  await recordTimerViews(page);

  // A quarter of the speed: a scramble move every 400 ms, time enough to press the button during it.
  await page.goto(demoPath(0, 0.25));
  const cube = page.getByTestId('cube-section');
  await cube.locator('summary').click();
  const progress = page.getByTestId('scramble-progress');
  await expect(progress).toHaveText(partWay, { timeout: 30_000 });
  await cube.getByTestId('reset-state').click();

  // The demo cube is solved and stays connected; attempt 1 begins again from its first move.
  await expect(cube.getByTestId('cube-net')).toHaveAttribute('data-facelets', SOLVED);
  await expect(cube.getByTestId('cube-solved')).toHaveText('Solved');
  await expect(progress).toHaveText(`0 / ${String(total)}`);
  await expect(page.getByTestId('scramble')).toHaveText(solve.scramble);
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 1');
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling');
  await expect(page.getByTestId('cube-status').first()).toHaveText('Fake cube · 100%');
  await expect(solveRows(page)).toHaveCount(0);

  // The button was pressed during the scramble: the view before the restart was part-way through it.
  const views = await timerViews(page);
  const restarted = views.findIndex(
    (view, i) =>
      i > 0 &&
      view.progress === `0 / ${String(total)}` &&
      partWay.test(views[i - 1].progress ?? ''),
  );
  expect(restarted).toBeGreaterThan(0);
  expect(views[restarted - 1]).toMatchObject({ phase: 'scrambling', attempt: 'Attempt 1' });
  expect(views[restarted]).toMatchObject({ phase: 'scrambling', attempt: 'Attempt 1', rows: [] });
  const session = await currentSessionId(page);
  expect(session).not.toBeNull();

  // A fresh demo of the same solve, faster: it scrambles, arms and solves attempt 1.
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  await expect(solveRows(page).first()).toHaveAttribute('data-index', '1');
  await expect(solveRows(page).first()).toHaveAttribute('data-status', 'solved');
  expect(await currentSessionId(page)).toBe(session);

  // One record: the attempt dropped by the reset left none.
  const exported = await exportSession(page);
  expect(exported.session.summary).toEqual({ attempts: 1, solved: 1, dnf: 0 });
  expect(exported.attempts).toHaveLength(1);
  expect(exported.attempts[0]).toMatchObject({
    index: 1,
    scramble: solve.scramble,
    result: { status: 'solved', replayOk: true, scrambleCorrected: false },
  });
});
