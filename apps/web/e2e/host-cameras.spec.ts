import type { AttemptRecord, SessionRecord } from '@cubetrace/core';
import { type Locator, type Page, expect, test } from '@playwright/test';

import { exportSession } from './helpers/export';
import { fileText, syntheticCamera, turnAt, turned } from './helpers/remote';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// Two cameras of the laptop recording at once (docs/PLAN.md T5.5): the browser lists two synthetic
// cameras (helpers/remote.ts: each a canvas of its own whose square steps to another grey at the times
// the suite gives, and nothing else moves; Chrome's fake cameras cannot serve, their test pattern
// jumps at its own pace and the second one's frames are Y16, which the encoder refuses), each turned
// on with its own switch in Camera settings. Each records its own clips of every attempt, under the
// label the session gives it (laptop, laptop-2), the first one's with the microphone's sound (Chrome's
// fake microphone), the second's without; each has its own sync check, the first one's due by itself,
// the second's from its line under the pictures, each finding the lag the suite planted for its own
// picture; each has its own cell on the Timer page. The second camera turned off mid-session: the
// next attempt has the first one's clips only, and the records say so. Launch options force a
// browser of their own for this file (the encoding project: two encoders at once).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});
test.describe.configure({ mode: 'default' });

const SPEED = 20;

/** The two cameras the browser lists, in its order. */
const CAMERAS = ['Synthetic camera A', 'Synthetic camera B'] as const;

/** Each camera's lag, planted: its square steps that long after each of the cube's moves. */
const LAGS_MS = [60, 150] as const;

/**
 * The second check's lag less the first's: about the planted difference (90 ms), each check finding
 * its own camera's; within these bounds, wide for the load of two encoders at once (the second
 * camera's frames came 11 to 23 ms later than the first's in the runs measured, beside the planted
 * difference), and far from 0, which two checks of one camera would give.
 */
const DIFFERENCE_MS = { min: 45, max: 160 } as const;

/** A check's turns, how far apart, and how long after its start the first comes. */
const TURNS = 10;
const TURN_GAP_MS = 1300;
const FIRST_TURN_MS = 2000;

/**
 * From now on each camera's square steps its own lag after each of the cube's moves (the demo cube's,
 * the turns of `turnAt`), as two cameras with those lags would show them: through the Timer page's
 * cube service (a development build's `ng`), its moves' host times plus each lag.
 */
async function lagMoves(page: Page, lags: readonly number[]): Promise<void> {
  await page.evaluate((lags) => {
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
        if (typeof flipAt === 'function' && typeof hostMs === 'number') {
          lags.forEach((lag, device) => {
            (flipAt as (times: number[], device: number) => void)([hostMs + lag], device);
          });
        }
      },
    );
  }, lags);
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

/** The names of the files in attempt `index`'s folder, sorted, read in the page. */
async function attemptFiles(page: Page, sessionId: string, index: number): Promise<string[]> {
  return page.evaluate(
    async ({ sessionId, folder }) => {
      let dir = await navigator.storage.getDirectory();
      for (const name of ['sessions', sessionId, 'attempts', folder]) {
        dir = await dir.getDirectoryHandle(name);
      }
      const names: string[] = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && !name.endsWith('.tmp')) {
          names.push(name);
        }
      }
      return names.sort();
    },
    { sessionId, folder: String(index).padStart(4, '0') },
  );
}

/** The switch of the camera named `name` in Camera settings. */
function cameraSwitch(page: Page, name: string): Locator {
  return page
    .getByTestId('camera-device-row')
    .filter({ has: page.getByTestId('camera-device-name').getByText(name, { exact: true }) })
    .getByTestId('camera-switch');
}

/** The recording panel's block of the camera labelled `label`. */
function recordingBlock(page: Page, label: string): Locator {
  return page.locator(`[data-testid="recording-camera"][data-label="${label}"]`);
}

/** Waits until the camera labelled `label` records, with the 4 s in memory a scramble clip needs. */
async function recording(page: Page, label: string): Promise<void> {
  const block = recordingBlock(page, label);
  await expect(block.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 20_000,
  });
  const stats = block.getByTestId('recording-stats');
  await expect
    .poll(async () => Number(await stats.getAttribute('data-buffer-seconds')), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(4);
}

/**
 * Runs the sync check the panel shows, which asks for a framing rectangle first (the whole frame is
 * framed): Check anyway, ten turns of the demo cube, passed; then Later closes the panel, and the
 * attempt begins again once the cube has been still for a second (`SYNC_GRACE_MS`): a scramble
 * turned before goes to no attempt.
 */
async function check(page: Page): Promise<void> {
  const panel = page.getByTestId('sync-check');
  await expect(panel).toHaveAttribute('data-state', 'framing', { timeout: 15_000 });
  await page.getByTestId('sync-anyway').click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  const before = (await turned(page)).length;
  const startMs = await page.evaluate(() => performance.timeOrigin + performance.now());
  await turnAt(
    page,
    Array.from({ length: TURNS }, (_, k) => startMs + FIRST_TURN_MS + k * TURN_GAP_MS),
  );
  await expect(panel).toHaveAttribute('data-state', 'passed', { timeout: 45_000 });
  expect((await turned(page)).length - before).toBeLessThanOrEqual(TURNS);
  await page.getByTestId('sync-later').click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 10_000,
  });
}

/** Replays the demo solve as attempt `index`, and waits until its record has `clips` clips. */
async function solve(
  page: Page,
  sessionId: string,
  index: number,
  clips: number,
): Promise<AttemptRecord> {
  await replayDemo(page);
  await expectSolves(page, index);
  await expect(solveRows(page).first()).toHaveAttribute('data-index', String(index));
  await expect(solveRows(page).first().getByTestId('clip-badge')).toHaveText(
    new RegExp(`^\\s*${String(clips)} clips, [\\d.]+ [kM]B\\s*$`, 'u'),
    { timeout: 30_000 },
  );
  await expect
    .poll(async () => (await attemptRecord(page, sessionId, index))?.video.length ?? 0, {
      timeout: 20_000,
    })
    .toBe(clips);
  const record = await attemptRecord(page, sessionId, index);
  if (record === null) {
    throw new Error(`attempt ${String(index)} has no record`);
  }
  return record;
}

test('two cameras of the laptop at once: a switch, a recording, a sync check and a cell each; four clips an attempt, the sound with the first; the second turned off mid-session', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await syntheticCamera(page, { devices: CAMERAS });

  // The demo solve that starts with the page, recorded before the cameras are on, goes.
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await page.getByTestId('delete-last').click();
  await expect(solveRows(page)).toHaveCount(0);
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');
  await lagMoves(page, LAGS_MS);

  // Turn on: the first camera of the list, its switch on, the other's off.
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await recording(page, 'laptop');
  await expect(page.getByTestId('camera-device-name')).toHaveText([...CAMERAS]);
  await expect(cameraSwitch(page, CAMERAS[0])).toBeChecked();
  await expect(cameraSwitch(page, CAMERAS[1])).not.toBeChecked();
  // Its sync check is due by itself before the first scramble.
  await check(page);

  // The second camera's switch: it records beside the first, without the sound, said once.
  await cameraSwitch(page, CAMERAS[1]).check();
  await recording(page, 'laptop-2');
  await expect(page.getByTestId('host-camera')).toHaveCount(2);
  await expect(page.getByTestId('host-camera-name')).toHaveText([
    `laptop · ${CAMERAS[0]}`,
    `laptop-2 · ${CAMERAS[1]}`,
  ]);
  await expect(page.getByTestId('camera-state')).toHaveText(/^\s*2 of 2 cameras on/u);
  await expect(recordingBlock(page, 'laptop-2').getByTestId('recording-codecs')).toContainText(
    'no sound (the microphone records with laptop)',
  );
  await expect(recordingBlock(page, 'laptop').getByTestId('recording-codecs')).not.toContainText(
    'no sound',
  );
  // Two cells on the Timer page, each with its caption and its status line.
  const cells = page.getByTestId('camera-cell');
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(0)).toHaveAttribute('data-label', 'laptop');
  await expect(cells.nth(1)).toHaveAttribute('data-label', 'laptop-2');
  await expect(page.getByTestId('camera-preview-name')).toHaveText([
    `laptop · ${CAMERAS[0]}`,
    `laptop-2 · ${CAMERAS[1]}`,
  ]);
  await expect(page.getByTestId('camera-status')).toHaveCount(2);
  await expect(page.locator('[data-testid="camera-status"][data-label="laptop-2"]')).toContainText(
    /recording/u,
  );

  // Its own sync check, from its line under the pictures: none is due by itself for it.
  const lines = page.getByTestId('sync-line');
  await expect(lines).toHaveCount(2);
  const second = page.locator('[data-testid="sync-line"][data-label="laptop-2"]');
  await expect(second).toContainText('Sync: laptop-2 has no check in this session.');
  await second.getByTestId('sync-start').click();
  await check(page);
  await expect(page.locator('[data-testid="sync-line"][data-label="laptop"]')).toContainText(
    /^\s*Sync: laptop lags the cube by \d+ ms/u,
  );
  await expect(second).toContainText(/^\s*Sync: laptop-2 lags the cube by \d+ ms/u);

  // Each check found its own camera's lag: in session.json, an entry each.
  const checked = (await sessionJson(page, sessionId)).clock.cameras;
  expect(Object.keys(checked).sort()).toEqual(['laptop', 'laptop-2']);
  const firstLag = checked['laptop'].offsetMs;
  const secondLag = checked['laptop-2'].offsetMs;
  console.info(
    `sync checks: laptop ${String(firstLag)} ms, laptop-2 ${String(secondLag)} ms, for planted lags of ${LAGS_MS.join(' and ')} ms`,
  );
  const difference = secondLag - firstLag;
  expect(difference, `${String(secondLag)} − ${String(firstLag)}`).toBeGreaterThan(
    DIFFERENCE_MS.min,
  );
  expect(difference, `${String(secondLag)} − ${String(firstLag)}`).toBeLessThan(DIFFERENCE_MS.max);

  // An attempt with both: four clips, two per camera, each named after its camera and taking its
  // camera's lag; the sound with the first camera's only.
  const both = await solve(page, sessionId, 1, 4);
  expect(
    both.video
      .map((clip) => [clip.camera, clip.segment, clip.file, clip.syncResidualMs])
      .sort(
        (p, q) =>
          String(p[0]).localeCompare(String(q[0])) || String(p[1]).localeCompare(String(q[1])),
      ),
  ).toEqual([
    ['laptop', 'scramble', 'laptop.scramble.mp4', firstLag],
    ['laptop', 'solve', 'laptop.solve.mp4', firstLag],
    ['laptop-2', 'scramble', 'laptop-2.scramble.mp4', secondLag],
    ['laptop-2', 'solve', 'laptop-2.solve.mp4', secondLag],
  ]);
  for (const clip of both.video) {
    if (clip.camera === 'laptop') {
      expect(clip.audio, `${clip.camera} ${clip.segment}`).not.toBeNull();
    } else {
      expect(clip.audio, `${clip.camera} ${clip.segment}`).toBeNull();
    }
  }
  expect(await attemptFiles(page, sessionId, 1)).toEqual([
    'attempt.json',
    'laptop-2.scramble.frames.json',
    'laptop-2.scramble.mp4',
    'laptop-2.solve.frames.json',
    'laptop-2.solve.mp4',
    'laptop.scramble.frames.json',
    'laptop.scramble.mp4',
    'laptop.solve.frames.json',
    'laptop.solve.mp4',
  ]);

  // The second camera turned off mid-session: its cell, its block and its line go; the next attempt
  // has the first camera's clips only, and nothing is noted missing.
  await cameraSwitch(page, CAMERAS[1]).uncheck();
  await expect(recordingBlock(page, 'laptop-2')).toHaveCount(0);
  await expect(cells).toHaveCount(1);
  await expect(page.getByTestId('host-camera')).toHaveCount(1);
  await expect(page.getByTestId('camera-state')).not.toContainText('cameras on');
  await expect(lines).toHaveCount(1);
  await recording(page, 'laptop');
  const one = await solve(page, sessionId, 2, 2);
  expect(one.video.map((clip) => [clip.camera, clip.segment])).toEqual([
    ['laptop', 'scramble'],
    ['laptop', 'solve'],
  ]);
  expect(await attemptFiles(page, sessionId, 2)).toEqual([
    'attempt.json',
    'laptop.scramble.frames.json',
    'laptop.scramble.mp4',
    'laptop.solve.frames.json',
    'laptop.solve.mp4',
  ]);

  // The export (valid against the schemas): an entry per camera, the second one's kept with its
  // check; the first camera's microphone, none for the second.
  const exported = await exportSession(page);
  expect(exported.session.id).toBe(sessionId);
  expect(
    exported.session.cameras.map((camera) => [
      camera.label,
      camera.deviceLabel,
      camera.microphone === null,
    ]),
  ).toEqual([
    ['laptop', CAMERAS[0], false],
    ['laptop-2', CAMERAS[1], true],
  ]);
  expect(Object.keys(exported.session.clock.cameras).sort()).toEqual(['laptop', 'laptop-2']);
  expect(exported.session.notes).not.toMatch(/clip failed|clip without audio/u);
  expect(exported.attempts.map((attempt) => attempt.video.length)).toEqual([4, 2]);
});
