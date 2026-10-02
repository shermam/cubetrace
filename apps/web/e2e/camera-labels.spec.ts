import { type Page, expect, test } from '@playwright/test';

import { exportSession } from './helpers/export';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// Two cameras of one laptop in one session (docs/PLAN.md, T2.14; issue #40), with two of Chrome's
// fake cameras, its fake microphone (the prompts answered "Allow") and the demo cube: a solve with
// the first camera, one with the second, one with the first again. Both are `laptop` by the host;
// the session gives the second one `laptop-2`, so that session.json has an entry for each, each
// attempt's clips are named after the label of the camera that recorded them, and the first camera
// gets its label back. `device-count=3` gives three fake cameras of the same test pattern at
// 30 fps: "fake_device_0" and "fake_device_2" send I420 frames, while "fake_device_1" sends 16-bit
// depth frames (Y16, a `VideoFrame` without a format), which the video encoder refuses
// ("OperationError: Encoding error"), so the second camera here is "fake_device_2". Launch options
// force a browser of their own for this file.
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream=device-count=3,fps=30',
      '--use-fake-ui-for-media-stream',
    ],
  },
});

const SPEED = 20;

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
        if (handle.kind === 'file') {
          names.push(name);
        }
      }
      return names.sort();
    },
    { sessionId, folder: String(index).padStart(4, '0') },
  );
}

/**
 * Waits until the camera records, with the 4 s in memory that the scramble clip's margin needs.
 * With `checkDue`, the sync check is due for the camera (the session has none of it) and asks for a
 * framing rectangle first (the whole frame is framed): Later sets it aside. Without, none is due.
 */
async function recording(page: Page, checkDue: boolean): Promise<void> {
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  const stats = page.getByTestId('recording-stats');
  await expect
    .poll(async () => Number(await stats.getAttribute('data-buffer-seconds')), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(4);
  const check = page.getByTestId('sync-check');
  if (checkDue) {
    await expect(check).toHaveAttribute('data-state', 'framing');
    await page.getByTestId('sync-later').click();
  }
  await expect(check).toBeHidden();
}

/**
 * Chooses the camera named `name` in Camera settings, and waits until the recording has started
 * again on it: its buffer starts from nothing, where the last camera's held 4 s and more.
 */
async function switchTo(page: Page, name: string): Promise<void> {
  await page.getByTestId('camera-device').selectOption({ label: name });
  const stats = page.getByTestId('recording-stats');
  await expect
    .poll(async () => Number(await stats.getAttribute('data-buffer-seconds')), { timeout: 20_000 })
    .toBeLessThan(2);
}

/** Replays the demo solve as attempt `index`, and waits for its two clips. */
async function solveWithClips(page: Page, index: number): Promise<void> {
  await replayDemo(page);
  await expectSolves(page, index);
  await expect(solveRows(page).first()).toHaveAttribute('data-index', String(index));
  await expect(solveRows(page).first().getByTestId('clip-badge')).toHaveText(
    /^\s*2 clips, [\d.]+ [kM]B\s*$/,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

test('two cameras of the laptop in one session: an entry and a label each, the clips named after them, the first camera its label back', async ({
  page,
}) => {
  test.setTimeout(150_000);

  // The demo solve that starts with the page, recorded before the camera is on, goes (Delete last).
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await page.getByTestId('delete-last').click();
  await expect(solveRows(page)).toHaveCount(0);
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');

  // The first camera, the default one.
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await recording(page, true);
  const picker = page.getByTestId('camera-device');
  await expect(picker.locator('option')).toHaveText([
    'fake_device_0',
    'fake_device_1',
    'fake_device_2',
  ]);
  await expect(picker.locator('option:checked')).toHaveText('fake_device_0');
  await solveWithClips(page, 1);

  // The second camera: a camera of its own in the session, so a check is due for it.
  await switchTo(page, 'fake_device_2');
  await recording(page, true);
  await solveWithClips(page, 2);

  // The first camera again: its label is the session's, whose check was set aside: none is due.
  await switchTo(page, 'fake_device_0');
  await expect(picker.locator('option:checked')).toHaveText('fake_device_0');
  await recording(page, false);
  await solveWithClips(page, 3);

  // The export (valid against schema 2): an entry per camera, each clip named after its camera.
  const exported = await exportSession(page);
  expect(exported.session.id).toBe(sessionId);
  expect(exported.session.cameras.map((camera) => [camera.label, camera.deviceLabel])).toEqual([
    ['laptop', 'fake_device_0'],
    ['laptop-2', 'fake_device_2'],
  ]);
  // Chrome's fake camera gives no sync check (nothing in it turns with the cube): none was kept.
  expect(exported.session.clock.cameras).toEqual({});
  const recordedBy = ['laptop', 'laptop-2', 'laptop'];
  expect(exported.attempts.map((attempt) => attempt.index)).toEqual([1, 2, 3]);
  for (const [k, attempt] of exported.attempts.entries()) {
    const camera = recordedBy[k];
    expect(
      attempt.video.map((clip) => [clip.camera, clip.segment, clip.file, clip.framesFile]),
    ).toEqual([
      [camera, 'scramble', `${camera}.scramble.mp4`, `${camera}.scramble.frames.json`],
      [camera, 'solve', `${camera}.solve.mp4`, `${camera}.solve.frames.json`],
    ]);
    // In the attempt's folder: its record and its clips, by those names.
    expect(await attemptFiles(page, sessionId, attempt.index)).toEqual([
      'attempt.json',
      `${camera}.scramble.frames.json`,
      `${camera}.scramble.mp4`,
      `${camera}.solve.frames.json`,
      `${camera}.solve.mp4`,
    ]);
  }

  // The session's page names both cameras.
  await page.goto(`/sessions/${sessionId}`);
  await expect(page.getByTestId('session-cameras')).toHaveText(
    'laptop (fake_device_0), laptop-2 (fake_device_2)',
  );
});
