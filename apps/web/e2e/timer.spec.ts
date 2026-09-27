import { readFile } from 'node:fs/promises';

import { type Page, expect, test } from '@playwright/test';

// The timer (docs/PLAN.md, T1.6b) end to end with the demo cube: an attempt from the scramble to
// solved, its time and breakdown, the solve list, the session kept in the origin private file
// system across reloads, the Sessions page and the export; and a DNF with Esc. The demo cube
// replays public/demo/solves.json (scripts/write-demo-solves.mts).

interface DemoFile {
  solves: { scramble: string; moves: { m: string; ms: number }[]; time_ms: number }[];
}

interface ExportFile {
  session: { id: string; summary: { attempts: number; solved: number; dnf: number } };
  attempts: {
    index: number;
    scramble: string;
    result: { status: string; timeMs: number | null; replayOk: boolean };
    phases: { name: string }[];
  }[];
}

/** A time as the timer writes it ("12.34", "1:02.34"), in ms. */
function parseTime(text: string): number {
  const match = /^(?:(\d+):)?(\d+)\.(\d\d)$/.exec(text.trim());
  if (match === null) {
    throw new Error(`"${text}" is not a time.`);
  }
  const [, minutes = '0', seconds, hundredths] = match;
  return (Number(minutes) * 60 + Number(seconds)) * 1000 + Number(hundredths) * 10;
}

async function text(page: Page, testId: string): Promise<string> {
  return ((await page.getByTestId(testId).first().textContent()) ?? '').trim();
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
  await expect(page.getByTestId('scramble')).toHaveText(solve.scramble);
  const rows = page.getByTestId('solve-row');
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // The time, frozen at the result, within 5% of the recorded duration / 20.
  await expect(page.getByTestId('timer')).toHaveAttribute('data-kind', 'solved');
  const shownMs = parseTime(await text(page, 'timer'));
  test.info().annotations.push({
    type: 'time',
    description: `shown ${String(shownMs)} ms, expected ${expectedMs.toFixed(1)} ms`,
  });
  expect(Math.abs(shownMs - expectedMs)).toBeLessThanOrEqual(0.05 * expectedMs);
  await expect(rows.first().getByTestId('solve-time')).toHaveText(await text(page, 'timer'));
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
  await expect(page.getByTestId('scramble')).toHaveText(/^([UDRLFB][2']? ?){15,30}$/);
  expect(await page.evaluate(() => customElements.get('twisty-player') !== undefined)).toBe(true);

  // A new page load: the session comes back from the store.
  await page.goto('/sessions');
  const session = page.getByTestId('session-row');
  await expect(session).toHaveCount(1);
  await expect(session.getByTestId('session-attempts')).toHaveText('1 attempt');
  const id = (await session.getAttribute('data-session')) ?? '';

  const downloading = page.waitForEvent('download');
  await session.getByRole('button', { name: 'Export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`cubetrace-session-${id}.json`);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8')) as ExportFile;
  expect(exported.session.id).toBe(id);
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

test('Esc marks a DNF during the solve: listed, shown, and the next attempt waits', async ({
  page,
}) => {
  // Slow enough to press Esc while solving.
  await page.goto('/?demo=0&speed=2');
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'solving', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('timer')).toHaveAttribute('data-kind', 'running');
  await page.keyboard.press('Escape');

  const row = page.getByTestId('solve-row').first();
  await expect(row).toHaveAttribute('data-status', 'dnf');
  await expect(row.getByTestId('solve-time')).toHaveText('DNF');
  await expect(page.getByTestId('timer')).toHaveText('DNF');
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
});
