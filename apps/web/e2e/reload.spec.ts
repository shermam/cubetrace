import { expect, test } from '@playwright/test';

import { exportSession } from './helpers/export';
import { currentSessionId, demoPath, expectSolves, solveRows } from './helpers/timer';
import { recordTimerViews, timerViews, viewAfter } from './helpers/timer-views';

// Flow 4 of docs/PLAN.md, T1.9: a reload in the middle of a session. The session is read back from
// the origin private file system (its id is in localStorage): its solve is listed at once, and the
// next attempt, here the demo solve replayed again after the reload, is number 2 of the same
// session.

test('a reload mid-session resumes it: the solve from the store, and the next attempt numbered 2', async ({
  page,
}) => {
  await recordTimerViews(page);
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  // Attempt 2 waits for its scramble to be made on the cube when the page reloads.
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 2');
  const id = await currentSessionId(page);
  expect(id).not.toBeNull();

  await page.reload();
  await expectSolves(page, 2);
  await expect(solveRows(page).nth(0)).toHaveAttribute('data-index', '2');
  await expect(solveRows(page).nth(1)).toHaveAttribute('data-index', '1');
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 3');
  await expect(page.getByTestId('storage-warning')).toHaveCount(0);
  expect(await currentSessionId(page)).toBe(id);

  // Before the demo solve ended again, the reloaded page showed the session as it was: solve 1,
  // read from the store, and attempt 2 next.
  const views = await timerViews(page);
  const resumed = viewAfter(
    views,
    -1,
    'the resumed session',
    (view) => view.phase !== null && view.phase !== 'loading',
  );
  expect(views[resumed]).toMatchObject({ rows: ['1 solved'], attempt: 'Attempt 2' });

  const { session, attempts } = await exportSession(page);
  expect(session.id).toBe(id);
  expect(session.summary).toEqual({ attempts: 2, solved: 2, dnf: 0 });
  expect(attempts.map((attempt) => [attempt.index, attempt.result.status])).toEqual([
    [1, 'solved'],
    [2, 'solved'],
  ]);
});
