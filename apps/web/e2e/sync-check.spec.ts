import { expect, test } from '@playwright/test';

import { exportSession } from './helpers/export';
import { demoPath, expectSolves } from './helpers/timer';

// The sync check (docs/PLAN.md, T2.5) with Chrome's fake camera at 30 fps and the demo cube. Nothing
// in the fake camera's test pattern turns with the cube (its jumps come every half second or so, at
// their own pace), so a check there cannot find the camera's lag. On the Timer the demo cube has
// finished its solve when the check starts, so the check always ends in the same failure, the cube
// did not move, with Retry; meanwhile the timer tracks no attempt, and the attempt it dropped begins
// again afterwards with its scramble and number. The capture lab's check reports what it measured,
// the capture worker's time per frame included. Launch options force a browser of their own for
// this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});
// One after the other: each encodes 1080p30 in software.
test.describe.configure({ mode: 'default' });

/** The capture lab's report of a check (`SyncOutcome`, apps/web/src/app/camera/sync-run.ts). */
interface LabOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly message?: string;
  readonly offsetMs?: number;
  readonly analysis: {
    readonly frames: number;
    readonly moves: number;
    readonly arrivalOffsetMs: number | null;
    readonly baseline: number | null;
    readonly threshold: number | null;
    readonly onsets: readonly number[];
    readonly pairs: readonly unknown[];
    readonly spreadMs: number | null;
  };
  readonly cost: { medianMs: number; p95Ms: number; maxMs: number } | null;
  readonly durationMs: number;
}

test('the Timer: the check starts with a recording session and pauses the timer, fails gracefully on the fake camera with Retry, and Later hides it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The demo solve replays at once; then the next attempt waits for its scramble.
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  const status = page.getByTestId('timer-status');
  const scramble = page.getByTestId('scramble');
  const attempt = page.getByTestId('attempt-index');
  await expect(attempt).toHaveText('Attempt 2');
  const scrambleText = ((await scramble.textContent()) ?? '').trim();
  expect(scrambleText).not.toBe('');
  await page.getByTestId('camera-section').locator('summary').click();
  // The camera off: no check.
  await expect(page.getByTestId('sync-check')).toHaveCount(0);
  await expect(page.getByTestId('sync-line')).toHaveCount(0);

  // The camera on: once it records, the check starts by itself and asks for the turns.
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  const panel = page.getByTestId('sync-check');
  await expect(panel).toHaveAttribute('data-state', 'running');
  await expect(panel).toContainText('Turn one face, pause, turn it back; repeat five times.');
  await expect(page.getByTestId('sync-seconds')).toHaveText(/^\d+ s$/);
  // The timer tracks no attempt meanwhile: attempt 2 was dropped, its scramble and number kept.
  await expect(status).toHaveAttribute('data-phase', 'sync-check');
  await expect(status).toHaveText(
    'Sync check: turn one face, pause, turn it back; repeat five times.',
  );
  await expect(scramble).toHaveText(scrambleText);
  await expect(attempt).toHaveText('Attempt 2');
  // The capture worker measures the motion of the frames and the panel counts them.
  const count = page.getByTestId('sync-count');
  await expect
    .poll(async () => Number(await count.getAttribute('data-frames')), { timeout: 10_000 })
    .toBeGreaterThan(60);

  // After its 20 s: why it failed, and Retry. Attempt 2 begins again with its scramble.
  await expect(panel).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  const failure = page.getByTestId('sync-failure');
  await expect(failure).toHaveText('Sync check failed: the cube did not move.');
  await expect(failure).toHaveAttribute('data-reason', 'no-moves');
  await expect(page.getByTestId('sync-retry')).toBeEnabled();
  await expect(status).toHaveAttribute('data-phase', 'scrambling');
  await expect(scramble).toHaveText(scrambleText);
  await expect(attempt).toHaveText('Attempt 2');

  // Retry starts it again; Later ends it and hides the panel, leaving a line to run it again.
  await page.getByTestId('sync-retry').click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  await expect(status).toHaveAttribute('data-phase', 'sync-check');
  await page.getByTestId('sync-later').click();
  await expect(panel).toBeHidden();
  await expect(status).toHaveAttribute('data-phase', 'scrambling');
  await expect(page.getByTestId('sync-line')).toContainText(
    'Sync: this camera has no check in this session.',
  );
  await expect(page.getByTestId('sync-start')).toBeEnabled();
  await page.getByTestId('sync-start').click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  await page.getByTestId('sync-later').click();
  await expect(panel).toBeHidden();

  await expect(scramble).toHaveText(scrambleText);
  await expect(attempt).toHaveText('Attempt 2');

  // No lag was found, so none is kept: the session has no clock sync of its camera; and the checks
  // made no attempt: the session holds the demo's solve alone.
  const exported = await exportSession(page);
  expect(exported.session.cameras).toHaveLength(1);
  expect(exported.session.clock.cameras).toEqual({});
  expect(exported.attempts.map((record) => record.index)).toEqual([1]);
});

test("the capture lab: the sync check runs on the fake camera with the demo cube's turns and reports", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/capture-lab');
  await expect(page.getByTestId('lab-sync-status')).toHaveText(/^Not run yet/);
  await expect(page.getByRole('button', { name: 'Sync check' })).toBeDisabled();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText(/^Recording /, { timeout: 15_000 });

  // Six seconds, during which the demo cube (at the Settings' speed, 1) turns its scramble.
  await page.getByLabel('Watch for (s)').fill('6');
  await page.getByRole('button', { name: 'Sync check' }).click();
  await expect(page.getByTestId('lab-sync-status')).toHaveText(/^Watching: \d+ s left/);
  await page.getByTestId('cube-status').first().click();
  const dialog = page.getByRole('dialog', { name: 'Cube' });
  await dialog.getByRole('button', { name: 'Demo cube' }).click();
  await expect(dialog).toBeHidden();

  const status = page.getByTestId('lab-sync-status');
  await expect(status).toHaveText(/^(The camera lags the cube by|Sync check failed:) /, {
    timeout: 20_000,
  });
  await expect(status).toContainText('Measuring a frame took the capture worker');
  await page.locator('summary', { hasText: 'What it found (JSON)' }).click();
  const outcome = JSON.parse(
    (await page.getByTestId('lab-sync-json').textContent()) ?? '{}',
  ) as LabOutcome;
  expect(outcome.analysis.frames).toBeGreaterThan(120);
  expect(outcome.analysis.moves).toBeGreaterThan(0);
  expect(outcome.cost).not.toBeNull();
  const report = {
    status: (await status.textContent())?.trim(),
    durationMs: outcome.durationMs,
    frames: outcome.analysis.frames,
    moves: outcome.analysis.moves,
    onsets: outcome.analysis.onsets.length,
    pairs: outcome.analysis.pairs.length,
    baseline: outcome.analysis.baseline,
    threshold: outcome.analysis.threshold,
    spreadMs: outcome.analysis.spreadMs,
    costMs: outcome.cost,
  };
  console.log(`sync check, capture lab: ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'sync-check', description: JSON.stringify(report) });

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Stopped.');
});
