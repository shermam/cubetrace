import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { exportSession } from './helpers/export';
import { demoPath, expectSolves } from './helpers/timer';

// The sync check (docs/PLAN.md, T2.5, T2.8 and T2.11) with Chrome's fake camera at 30 fps and the
// demo cube. Nothing in the fake camera's test pattern turns with the cube (its jumps come every half
// second or so, at their own pace), so a check there cannot find the camera's lag. On the Timer the
// camera's framing rectangle is the whole frame at first, so the check that is due asks for one around
// the cube before it starts; started anyway, it asks to hold still for a second, and, the demo cube
// having finished its solve when it starts, it always ends in the same failure, the cube did not move,
// with Retry and its data to download; meanwhile the timer tracks no attempt, and the attempt it
// dropped begins again afterwards with its scramble and number. The capture lab's check reports what
// it measured, the capture worker's time per frame included, and shows the latest frame's motion as it
// comes. Launch options force a browser of their own for this file.
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
    readonly turns: readonly unknown[];
    readonly matched: number;
    readonly clock: {
      readonly arrivalOffsetMs: number;
      readonly arrivalResidualP95Ms: number;
      readonly frameMinusPageMs: number | null;
    } | null;
    readonly pairs: readonly unknown[];
    readonly spreadMs: number | null;
  };
  readonly cost: { medianMs: number; p95Ms: number; maxMs: number } | null;
  readonly durationMs: number;
}

/** The check's diagnostics, as "Download check data" saves them (apps/web/src/app/camera/sync-report.ts). */
interface SyncReportFile {
  readonly report: string;
  readonly camera: { readonly label: string; readonly frameWidth: number | null };
  readonly framing: { readonly wide: boolean };
  readonly meter: {
    readonly format: string | null;
    readonly path: string;
    readonly planeWidth: number;
  } | null;
  readonly result: {
    readonly ok: boolean;
    readonly reason: string | null;
    readonly frames: number;
  };
  readonly clock: { readonly frameMinusPageMs: number | null } | null;
  readonly moves: readonly unknown[];
  readonly series: readonly {
    readonly hostMs: number;
    readonly mean: number;
    readonly changed: number;
  }[];
}

/** Clicks `testId` and reads the check's diagnostics it downloads, with the file's name. */
async function downloadReport(
  page: Page,
  testId: string,
): Promise<{ name: string; json: SyncReportFile }> {
  const downloading = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const download = await downloading;
  const json = JSON.parse(await readFile(await download.path(), 'utf8')) as SyncReportFile;
  return { name: download.suggestedFilename(), json };
}

/** The Timer with the demo's solve recorded and the camera recording: the check is due. */
async function recordingTimer(page: Page): Promise<{ scrambleText: string }> {
  // The demo solve replays at once; then the next attempt waits for its scramble.
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 2');
  const scrambleText = ((await page.getByTestId('scramble').textContent()) ?? '').trim();
  expect(scrambleText).not.toBe('');
  await page.getByTestId('camera-section').locator('summary').click();
  // The camera off: no check.
  await expect(page.getByTestId('sync-check')).toHaveCount(0);
  await expect(page.getByTestId('sync-line')).toHaveCount(0);
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  return { scrambleText };
}

test('the Timer: the check asks for the framing first, pauses the timer once started, fails gracefully on the fake camera with Retry and its data, and Later hides it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { scrambleText } = await recordingTimer(page);
  const status = page.getByTestId('timer-status');
  const scramble = page.getByTestId('scramble');
  const attempt = page.getByTestId('attempt-index');

  // Once it records, the check is due; the whole frame is framed, so it asks for a rectangle first.
  const panel = page.getByTestId('sync-check');
  await expect(panel).toHaveAttribute('data-state', 'framing');
  await expect(page.getByTestId('sync-framing')).toHaveText(
    'Draw the framing rectangle around the cube first (Camera settings → Framing → Edit): the check looks for motion inside it.',
  );
  await expect(page.getByTestId('sync-edit-framing')).toBeVisible();
  await expect(status).toHaveAttribute('data-phase', 'scrambling');

  // Started anyway: it asks for the turns and the timer tracks no attempt meanwhile (attempt 2 was
  // dropped, its scramble and number kept).
  await page.getByTestId('sync-anyway').click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  await expect(panel).toContainText(
    'Hold the cube still inside the rectangle. With one finger, flick one face; keep your other hand and the cube still; after a second, flick it back. Five times.',
  );
  // "Hold still…" for its first second, then the countdown for the first turn.
  await expect(page.getByTestId('sync-count')).toHaveText(
    /^\s*(Hold still… wait a second before the first turn|\d+ s for the first turn)\s*$/,
  );
  await expect(page.getByTestId('sync-seconds')).toHaveText(/^\d+ s$/);
  await expect(status).toHaveAttribute('data-phase', 'sync-check');
  await expect(status).toHaveText(
    'Sync check: hold the cube still and flick one face, then back after a second; five times.',
  );
  await expect(scramble).toHaveText(scrambleText);
  await expect(attempt).toHaveText('Attempt 2');
  // Under the camera's preview, beside the time, where the solver looks while turning; on a phone
  // too, within the screen's width.
  const previewBox = await page.getByTestId('camera-preview').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  if (previewBox !== null && panelBox !== null) {
    expect(panelBox.y).toBeGreaterThanOrEqual(previewBox.y + previewBox.height);
    expect(Math.abs(panelBox.x - previewBox.x)).toBeLessThan(2);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.innerWidth);
  await page.setViewportSize({ width: 1280, height: 720 });
  // The capture worker measures the motion of the frames and the panel counts them.
  const count = page.getByTestId('sync-count');
  await expect
    .poll(async () => Number(await count.getAttribute('data-frames')), { timeout: 10_000 })
    .toBeGreaterThan(60);

  // After its 20 s without a turn: why it failed, Retry, and its data. Attempt 2 begins again with
  // its scramble.
  await expect(panel).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  const failure = page.getByTestId('sync-failure');
  await expect(failure).toHaveText('Sync check failed: the cube did not move.');
  await expect(failure).toHaveAttribute('data-reason', 'no-moves');
  await expect(page.getByTestId('sync-retry')).toBeEnabled();
  await expect(status).toHaveAttribute('data-phase', 'scrambling');
  await expect(scramble).toHaveText(scrambleText);
  await expect(attempt).toHaveText('Attempt 2');

  // "Download check data": the whole motion series, the camera, how its frames were read.
  const { name, json } = await downloadReport(page, 'sync-download');
  expect(name).toMatch(/^cubetrace-sync-check-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  expect(json).toMatchObject({
    report: 'cubetrace sync check',
    camera: { label: 'laptop', frameWidth: 1920 },
    framing: { wide: true },
    meter: { path: 'copy', planeWidth: 320 },
    result: { ok: false, reason: 'no-moves' },
  });
  expect(json.series.length).toBe(json.result.frames);
  expect(json.series.length).toBeGreaterThan(400);
  expect(json.series.every((frame) => frame.mean >= 0 && frame.changed >= 0)).toBe(true);
  expect(json.series.some((frame) => frame.mean > 0)).toBe(true);
  // The frames' clock is the page's: their times within a fraction of a second of its own.
  expect(Math.abs(json.clock?.frameMinusPageMs ?? Number.NaN)).toBeLessThan(1000);
  const facts = {
    format: json.meter?.format,
    frameMinusPageMs: json.clock?.frameMinusPageMs,
    frames: json.series.length,
  };
  console.log(`sync check, Timer, fake camera: ${JSON.stringify(facts)}`);

  // Retry starts it again, without asking again for the framing (it was started anyway); Later ends
  // it and hides the panel, leaving a line to run it again.
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

test('the Timer: the framing hint goes once the rectangle is drawn around the cube, and Start starts the check', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await recordingTimer(page);
  const panel = page.getByTestId('sync-check');
  await expect(panel).toHaveAttribute('data-state', 'framing');

  // "Edit the framing" opens Camera settings to the editor; the rectangle made smaller from its
  // corner with Shift and the arrows, to under 60% of the frame.
  await page.getByTestId('camera-section').locator('summary').click();
  await expect(page.getByTestId('camera-section')).not.toHaveAttribute('open', '');
  await page.getByTestId('sync-edit-framing').click();
  await expect(page.getByTestId('camera-section')).toHaveAttribute('open', '');
  const rectangle = page.getByTestId('camera-framing');
  await expect(rectangle).toBeVisible();
  await expect(page.getByTestId('camera-framing-edit')).toHaveText('Done');
  await rectangle.focus();
  for (let k = 0; k < 30; k++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  for (let k = 0; k < 10; k++) {
    await page.keyboard.press('Shift+ArrowUp');
  }
  await expect(page.getByTestId('camera-framing-rect')).toHaveText(/^0, 0, 1260×860$/);
  await expect(panel).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('sync-framing')).toHaveCount(0);
  await page.getByTestId('camera-framing-edit').click();

  await page.getByTestId('sync-go').click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'sync-check');
  await page.getByTestId('sync-later').click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling');

  // The whole frame again: the hint is back at the next start.
  await page.getByTestId('camera-full-frame').click();
  await page.getByTestId('sync-start').click();
  await expect(panel).toHaveAttribute('data-state', 'framing');
  await page.getByTestId('sync-later').click();
  await expect(panel).toBeHidden();
});

test("the capture lab: the sync check runs on the fake camera with the demo cube's turns, shows the frames' motion as it comes, and reports", async ({
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
  // The live bars: the test pattern moves, so the mean difference is above 0; the frames' format and
  // how they are read.
  const motion = page.getByTestId('lab-motion');
  await expect
    .poll(async () => Number(await motion.getAttribute('data-mean')), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId('lab-motion-mean')).toHaveText(/^\d+\.\d levels$/);
  await expect(page.getByTestId('lab-motion-changed')).toHaveText(/^\d+\.\d{2}% of the pixels$/);
  const meterLine = page.getByTestId('lab-meter');
  await expect(meterLine).toContainText('copied out (VideoFrame.copyTo)');
  await expect(meterLine).toContainText('measured on 320×180 pixels');
  const meterText = (await meterLine.textContent())?.trim();
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
  const { json } = await downloadReport(page, 'lab-sync-download');
  expect(json).toMatchObject({ report: 'cubetrace sync check', camera: { label: 'lab' } });
  expect(json.series.length).toBe(outcome.analysis.frames);
  const report = {
    status: (await status.textContent())?.trim(),
    meter: meterText,
    durationMs: outcome.durationMs,
    frames: outcome.analysis.frames,
    moves: outcome.analysis.moves,
    turns: outcome.analysis.turns.length,
    matched: outcome.analysis.matched,
    spreadMs: outcome.analysis.spreadMs,
    clock: outcome.analysis.clock,
    costMs: outcome.cost,
    meanMedian: median(json.series.map((frame) => frame.mean)),
    changedMedian: median(json.series.map((frame) => frame.changed)),
    changedMax: Math.max(...json.series.map((frame) => frame.changed)),
  };
  console.log(`sync check, capture lab: ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'sync-check', description: JSON.stringify(report) });

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Stopped.');
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
