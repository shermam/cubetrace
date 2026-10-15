import type { AttemptRecord, SessionRecord, VideoClip } from '@cubetrace/core';
import { type Locator, type Page, expect, test } from '@playwright/test';

import { fakeAccount, fakeAccountState } from './helpers/account';
import { bend, fileText, syntheticCamera, turnAt, turned } from './helpers/remote';
import { currentSessionId, demoPath, replayDemo, solveRows } from './helpers/timer';

// The capture latency and the camera's lag from each solve's own moves (docs/PLAN.md T5.3, issue
// #67), with the laptop's own camera a synthetic one (helpers/remote.ts: a canvas whose square steps
// to another grey at the times the suite gives, and nothing else moves) and the demo cube replaying
// a real solve at real time (demo solve 1: 70 moves in 15 s, 116 ms apart at the median). The suite
// steps the square a planted lag after each of the cube's moves, as a camera with that lag would
// show them. The sync check finds the lag and keeps what anchors the later clips' (its own motion's
// peak, the capture latency then); then the planted lag grows by 75 ms, the step of 2026-10-09, and
// the next solve's clip says where its motion peaked and the camera's lag from it, 75 ms more than the
// check's, which the line under the preview says in amber; back to the check's lag, the next one says
// the check's lag again and the line says nothing. Every clip says its frames' capture and encode
// latencies. Launch options force a browser of their own for this file (the encoding project).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});
test.describe.configure({ mode: 'default' });

/** Demo solve 1 at real time. */
const DEMO = 1;
const SPEED = 1;

/** The synthetic camera's lag at the check, and its growth after it (issue #67's step). */
const LAG_MS = 120;
const STEP_MS = 75;

/** The check's turns, how far apart, and how long after the check's start the first comes. */
const TURNS = 10;
const TURN_GAP_MS = 1300;
const FIRST_TURN_MS = 2000;

/**
 * How far the two solves' motion lags may sit from 75 ms apart: the frames see each step a frame at
 * a time (33 ms at 30 fps), on the pages' timers' jitter, and the estimator's bins are 10 ms wide.
 * Each solve's own lag sits further from the check's (by up to 20 ms in the runs measured): the
 * synthetic square shows two turns within one frame as one step, which a solve's half turns (two
 * quarter turns 60 ms apart) make often and the check's single turns never do; the bias is the same
 * in both solves, and cancels in their difference.
 */
const TOLERANCE_MS = 15;

/**
 * The motion meter's cost limit for this suite (`E2eRemote.motionCostLimitMs`): on this suite's
 * loaded machines a frame's measure took 3.1 ms in a run, over the 3 ms that turns it off on a device.
 */
const COST_LIMIT_MS = 50;

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

/**
 * From now on the synthetic camera's square steps `lagMs` after each of the cube's moves (the demo
 * cube's, the turns of `turnAt`), as a camera with that lag shows them: through the Timer page's
 * cube service (a development build's `ng`), its moves' host times plus the lag.
 */
async function lagMoves(page: Page, lagMs: number): Promise<void> {
  await page.evaluate((lag) => {
    Reflect.set(window, '__cubetraceTestLagMs', lag);
    if (Reflect.get(window, '__cubetraceTestLagged') === true) {
      return;
    }
    const ng: unknown = Reflect.get(window, 'ng');
    const getComponent: unknown =
      typeof ng === 'object' && ng !== null ? Reflect.get(ng, 'getComponent') : undefined;
    if (typeof getComponent !== 'function') {
      throw new Error('no ng.getComponent: the page is not a development build');
    }
    const timer: unknown = (getComponent as (element: Element | null) => unknown)(
      document.querySelector('app-timer-page'),
    );
    const cube: unknown =
      typeof timer === 'object' && timer !== null ? Reflect.get(timer, 'cube') : undefined;
    const events: unknown =
      typeof cube === 'object' && cube !== null ? Reflect.get(cube, 'events$') : undefined;
    const subscribe: unknown =
      typeof events === 'object' && events !== null ? Reflect.get(events, 'subscribe') : undefined;
    if (typeof subscribe !== 'function') {
      throw new Error("the Timer page's cube has no events");
    }
    (subscribe as (this: unknown, next: (event: unknown) => void) => unknown).call(
      events,
      (event: unknown) => {
        if (typeof event !== 'object' || event === null || Reflect.get(event, 'type') !== 'move') {
          return;
        }
        const camera: unknown = Reflect.get(window, '__cubetraceTestCamera');
        const flipAt: unknown =
          typeof camera === 'object' && camera !== null ? Reflect.get(camera, 'flipAt') : undefined;
        const hostMs: unknown = Reflect.get(event, 'hostMs');
        const delay: unknown = Reflect.get(window, '__cubetraceTestLagMs');
        if (
          typeof flipAt === 'function' &&
          typeof hostMs === 'number' &&
          typeof delay === 'number'
        ) {
          (flipAt as (times: number[]) => void)([hostMs + delay]);
        }
      },
    );
    Reflect.set(window, '__cubetraceTestLagged', true);
  }, lagMs);
}

async function sessionJson(page: Page, sessionId: string): Promise<SessionRecord> {
  return JSON.parse(await fileText(page, sessionId, ['session.json'])) as SessionRecord;
}

async function attemptRecord(
  page: Page,
  sessionId: string,
  index: number,
): Promise<AttemptRecord | null> {
  try {
    return JSON.parse(
      await fileText(page, sessionId, ['attempts', String(index).padStart(4, '0'), 'attempt.json']),
    ) as AttemptRecord;
  } catch {
    return null;
  }
}

/** The diagnostics events in the fake account, as kind and facts. */
async function events(page: Page): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  return (await fakeAccountState(page)).events.map(
    (entry) => entry.event as { kind: string; data: Record<string, unknown> },
  );
}

/** The demo solve replayed as attempt `index`, its two clips in its record; its solve clip. */
async function solveClip(page: Page, sessionId: string, index: number): Promise<VideoClip> {
  await replayDemo(page);
  await expect(solveRows(page)).toHaveCount(index, { timeout: 60_000 });
  await expect
    .poll(async () => (await attemptRecord(page, sessionId, index))?.video.length ?? 0, {
      timeout: 30_000,
    })
    .toBe(2);
  const record = await attemptRecord(page, sessionId, index);
  const clip = record?.video.find((c) => c.segment === 'solve');
  if (clip === undefined) {
    throw new Error(`attempt ${String(index)} has no solve clip`);
  }
  const scramble = record?.video.find((c) => c.segment === 'scramble');
  // A scramble clip has its latencies but no motion.
  expect(scramble).toMatchObject({ motionPeakMs: null, motionSpreadMs: null, motionLagMs: null });
  expect(scramble?.captureLatencyMs).not.toBeNull();
  return clip;
}

test("the capture latency of every clip, and each solve's lag from its own moves: the check's planted lag, then 75 ms more, said on the line, then the check's again", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await bend(page, { motionCostLimitMs: COST_LIMIT_MS });
  await syntheticCamera(page);
  await fakeAccount(page);
  await page.goto(demoPath(DEMO, SPEED));
  // The demo solve that starts with the page, at real time, the camera off.
  await expect(solveRows(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();

  // The laptop's camera on: the synthetic one; its check is due, asking for the framing first.
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  const panel = page.getByTestId('sync-check');
  await expect(panel).toHaveAttribute('data-state', 'framing', { timeout: 15_000 });
  await lagMoves(page, LAG_MS);
  await page.getByTestId('sync-anyway').click();
  await expect(panel).toHaveAttribute('data-state', 'running');

  // Ten turns of the demo cube, the square stepping LAG_MS after each.
  const startMs = await page.evaluate(() => performance.timeOrigin + performance.now());
  await turnAt(
    page,
    Array.from({ length: TURNS }, (_, k) => startMs + FIRST_TURN_MS + k * TURN_GAP_MS),
  );
  await expect(panel).toHaveAttribute('data-state', 'passed', { timeout: 40_000 });
  expect(await turned(page)).toHaveLength(TURNS);
  const check = (await sessionJson(page, sessionId)).clock.cameras['laptop'];
  // Its anchors: where its own motion peaked around its turns, and the capture latency then.
  expect(typeof check.motionPeakAtCheckMs).toBe('number');
  expect(typeof check.captureLatencyAtCheckMs).toBe('number');
  console.info(
    `sync check: offsetMs ${String(check.offsetMs)} for a planted lag of ${String(LAG_MS)} ms; ` +
      `its motion peaked ${String(check.motionPeakAtCheckMs)} ms after its turns; ` +
      `the capture latency then ${String(check.captureLatencyAtCheckMs)} ms`,
  );
  // Its event says them (the events go to the account in batches).
  await expect
    .poll(
      async () => (await events(page)).filter((e) => e.kind === 'sync.check').map((e) => e.data),
      { timeout: 20_000 },
    )
    .toEqual([
      expect.objectContaining({
        outcome: 'ok',
        motionPeakMs: check.motionPeakAtCheckMs,
        captureLatencyMs: check.captureLatencyAtCheckMs,
      }),
    ]);
  await page.getByTestId('sync-later').click();

  // The step of 2026-10-09: the camera's lag grows by 75 ms. The next solve says so.
  await lagMoves(page, LAG_MS + STEP_MS);
  const grown = await solveClip(page, sessionId, 2);
  console.info(
    `solve with the lag grown by ${String(STEP_MS)} ms: motionPeakMs ${String(grown.motionPeakMs)} ` +
      `(the check's ${String(check.motionPeakAtCheckMs)}), motionLagMs ${String(grown.motionLagMs)} ` +
      `(the check's offset ${String(check.offsetMs)}), spread ${String(grown.motionSpreadMs)} ms; ` +
      `capture ${JSON.stringify(grown.captureLatencyMs)}, encode ${JSON.stringify(grown.encodeLatencyMs)}`,
  );
  expect(grown.syncResidualMs).toBe(check.offsetMs);
  expect(grown.motionPeakMs).not.toBeNull();
  expect(grown.motionSpreadMs).toBeGreaterThan(0);
  // More than 30 ms from the check's, which the line says; about 75 ms more (see the third solve).
  expect((grown.motionLagMs ?? 0) - check.offsetMs).toBeGreaterThan(30);
  expect(grown.captureLatencyMs).toMatchObject({
    basis: expect.stringMatching(/^(capture-time|timestamp)$/),
  });
  expect(grown.encodeLatencyMs?.p50).toBeGreaterThanOrEqual(0);
  // The line under the preview says it in amber.
  const word = page.getByTestId('camera-status-motion-lag');
  await expect(word).toHaveText(
    `motion lag ${String(Math.round(grown.motionLagMs ?? 0))} ms (check ${String(Math.round(check.offsetMs))})`,
  );
  await expect(word).toHaveClass(/warn/);
  // clip.saved says the same, with the pipeline's counters over the clip.
  await expect
    .poll(
      async () =>
        (await events(page))
          .filter((e) => e.kind === 'clip.saved' && e.data['segment'] === 'solve')
          .map((e) => e.data['motionLagMs']),
      { timeout: 20_000 },
    )
    .toEqual([grown.motionLagMs]);
  const saved = (await events(page)).find(
    (e) => e.kind === 'clip.saved' && e.data['segment'] === 'solve',
  )?.data;
  expect(saved).toMatchObject({
    syncResidualMs: check.offsetMs,
    motionPeakMs: grown.motionPeakMs,
    captureLatencyMs: grown.captureLatencyMs,
    encodeLatencyMs: grown.encodeLatencyMs,
  });
  expect(saved?.['frameIntervalMs']).toBeGreaterThan(25);
  console.info(`clip.saved: ${JSON.stringify(saved)}`);

  // Back to the check's lag: the next solve's lag is the check's, and the line says nothing.
  await lagMoves(page, LAG_MS);
  const back = await solveClip(page, sessionId, 3);
  console.info(
    `solve at the check's lag: motionPeakMs ${String(back.motionPeakMs)}, motionLagMs ${String(back.motionLagMs)}`,
  );
  expect(Math.abs((back.motionLagMs ?? 0) - check.offsetMs)).toBeLessThanOrEqual(30);
  await expect(page.getByTestId('camera-status-motion-lag')).toHaveCount(0);
  // The two solves, one at the check's lag and one 75 ms later: their lags 75 ms apart.
  expect(
    Math.abs((grown.motionLagMs ?? 0) - (back.motionLagMs ?? 0) - STEP_MS),
    `${String(grown.motionLagMs)} − ${String(back.motionLagMs)}`,
  ).toBeLessThan(TOLERANCE_MS);
});
