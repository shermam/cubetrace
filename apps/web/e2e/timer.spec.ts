import { expect, test } from '@playwright/test';

import { exportSession } from './helpers/export';
import { fixtureSolve } from './helpers/fixtures';
import { demoPath, parseTime, solveRows, textOf } from './helpers/timer';

// The timer (docs/PLAN.md, T1.6b) end to end with the demo cube: an attempt from the scramble to
// solved, its time and breakdown, the solve list, the session kept in the origin private file
// system across reloads, the Sessions page and the export; and a DNF with Esc (flow 3 of T1.9). The
// demo cube replays public/demo/solves.json (scripts/write-demo-solves.mts).

const SCRAMBLE = /^([UDRLFB][2']? ?){15,30}$/;

interface DemoFile {
  solves: { scramble: string; moves: { m: string; ms: number }[]; time_ms: number }[];
}

test('a demo solve is timed, broken down and listed; the session survives a reload and exports', async ({
  page,
  request,
}) => {
  const file = (await (await request.get('/demo/solves.json')).json()) as DemoFile;
  const solve = file.solves[0];
  const speed = 20;
  // The solve's duration on the cube's clock, divided by the replay speed.
  const expectedMs = ((solve.moves.at(-1)?.ms ?? 0) - (solve.moves[0]?.ms ?? 0)) / speed;

  await page.goto(`/?demo=0&speed=${String(speed)}`);
  const rows = page.getByTestId('solve-row');
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // The time, frozen at the result, within 5% of the recorded duration / 20.
  await expect(page.getByTestId('timer')).toHaveAttribute('data-kind', 'solved');
  const shownMs = parseTime(await textOf(page, 'timer'));
  test.info().annotations.push({
    type: 'time',
    description: `shown ${String(shownMs)} ms, expected ${expectedMs.toFixed(1)} ms`,
  });
  expect(Math.abs(shownMs - expectedMs)).toBeLessThanOrEqual(0.05 * expectedMs);
  await expect(rows.first().getByTestId('solve-time')).toHaveText(await textOf(page, 'timer'));
  await expect(rows.first()).toHaveAttribute('data-index', '1');
  await expect(rows.first()).toHaveAttribute('data-status', 'solved');
  // Eight phases in the chart, each a segment of the last solve's bar.
  await expect(page.getByTestId('breakdown-last').locator('[data-phase]')).toHaveCount(8);
  // Auto-advance: the next attempt, with a scramble from cubing.js (made while the page loaded; its
  // worker's first search builds tables, so allow for it as scramble.spec.ts does).
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 2');
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('scramble')).toHaveText(SCRAMBLE);
  // The scramble's picture: cubing.js's <twisty-player>, defined by its lazy chunk.
  await expect
    .poll(() => page.evaluate(() => customElements.get('twisty-player') !== undefined))
    .toBe(true);

  // A new page load: the session comes back from the store.
  await page.goto('/sessions');
  const session = page.getByTestId('session-row');
  await expect(session).toHaveCount(1);
  await expect(session.getByTestId('session-attempts')).toHaveText('1 attempt');

  // The export: a JSON file named after the session, valid against both schemas.
  const exported = await exportSession(page);
  expect(exported.session.summary).toEqual({ attempts: 1, solved: 1, dnf: 0 });
  expect(exported.attempts).toHaveLength(1);
  expect(exported.attempts[0]).toMatchObject({
    index: 1,
    scramble: solve.scramble,
    result: { status: 'solved', replayOk: true },
  });
  expect(exported.attempts[0].phases).toHaveLength(8);

  // The Timer page continues the session: its solve is listed, and the next attempt is number 2.
  await page.goto('/');
  await expect(page.getByTestId('solve-row')).toHaveCount(1);
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 2');
});

test('Esc marks a DNF during the solve; the next attempt begins, numbered 2, once the cube is solved', async ({
  page,
}) => {
  // Slow enough to press Esc while solving: demo solve 0 takes 4.3 s at speed 5.
  const solve = fixtureSolve(0);
  await page.goto(demoPath(0, 5));
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'solving', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('timer')).toHaveAttribute('data-kind', 'running');
  await page.keyboard.press('Escape');

  const row = solveRows(page).first();
  await expect(row).toHaveAttribute('data-status', 'dnf');
  await expect(row.getByTestId('solve-time')).toHaveText('DNF');
  await expect(page.getByTestId('timer')).toHaveText('DNF');
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // The demo cube goes on and solves the cube; then the next attempt begins, number 2, with a
  // scramble of its own (made by cubing.js while the page loaded, so allow for its first search).
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 2');
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('scramble')).toHaveText(SCRAMBLE);
  await expect(page.getByTestId('scramble')).not.toHaveText(solve.scramble);
  await expect(solveRows(page)).toHaveCount(1);

  // The record of a DNF: no time, no end, no replay; valid against the schema all the same.
  const { session, attempts } = await exportSession(page);
  expect(session.summary).toEqual({ attempts: 1, solved: 0, dnf: 1 });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    index: 1,
    scramble: solve.scramble,
    result: { status: 'dnf', timeMs: null, tps: null, replayOk: false },
    events: { solveEnd: null },
  });
  expect(attempts[0].events.solveStart).not.toBeNull();
});
