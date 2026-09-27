import { readFile } from 'node:fs/promises';

import { type Page, expect, test } from '@playwright/test';
import { FRAMES_SCHEMA, type FramesJson } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';

import { validateExport } from './helpers/export';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// A session with clips, end to end (docs/PLAN.md, T2.6), with Chrome's fake camera at 30 fps and its
// fake microphone (the prompts answered "Allow") and the demo cube: two solves recorded with the
// camera on; after a new page load, the session's page lists both with their clip badges and plays a
// clip; its export validates against schema 2, and every clip its attempts list is a file in the
// attempt's folder of the origin private file system, with the size and the frames the record says.
// Launch options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

const SPEED = 20;

/** The files of attempt `index`'s folder, with their sizes, read in the page. */
async function attemptFiles(
  page: Page,
  sessionId: string,
  index: number,
): Promise<Record<string, number>> {
  return page.evaluate(
    async ({ sessionId, folder }) => {
      let dir = await navigator.storage.getDirectory();
      for (const name of ['sessions', sessionId, 'attempts', folder]) {
        dir = await dir.getDirectoryHandle(name);
      }
      const files: Record<string, number> = {};
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
          files[name] = (await handle.getFile()).size;
        }
      }
      return files;
    },
    { sessionId, folder: String(index).padStart(4, '0') },
  );
}

/** A text file of attempt `index`'s folder, read in the page. */
async function attemptText(
  page: Page,
  sessionId: string,
  index: number,
  name: string,
): Promise<string> {
  return page.evaluate(
    async ({ sessionId, folder, name }) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ['sessions', sessionId, 'attempts', folder]) {
        dir = await dir.getDirectoryHandle(part);
      }
      return (await (await dir.getFileHandle(name)).getFile()).text();
    },
    { sessionId, folder: String(index).padStart(4, '0'), name },
  );
}

test('two solves with the camera on: after a page load the session page lists both with their clips, which are in OPFS; the export validates', async ({
  page,
}) => {
  test.setTimeout(120_000);

  // The demo solve that starts with the page is recorded before the camera is on; Delete last
  // removes it, so that the session's attempts are the two recorded with the camera.
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  const status = page.getByTestId('timer-status');
  await expect(status).toHaveAttribute('data-phase', 'scrambling', { timeout: 30_000 });
  await page.getByTestId('delete-last').click();
  await expect(solveRows(page)).toHaveCount(0);
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 1');
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');

  // The camera on: it records, and the sync check is due by itself (the session has none of this
  // camera), asking first for a framing rectangle around the cube (the whole frame is framed); Later
  // hides it, and the timer is on attempt 1's scramble.
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  const check = page.getByTestId('sync-check');
  await expect(check).toHaveAttribute('data-state', 'framing');
  await page.getByTestId('sync-later').click();
  await expect(check).toBeHidden();
  await expect(status).toHaveAttribute('data-phase', 'scrambling');
  // The first scramble clip begins 2 s before the scramble's first turn: that much in memory first.
  const stats = page.getByTestId('recording-stats');
  await expect
    .poll(async () => Number(await stats.getAttribute('data-buffer-seconds')), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(4);

  // Two solves, each with its two clips about a second after it (the next replay waits for them).
  const badges = solveRows(page).getByTestId('clip-badge');
  for (let count = 1; count <= 2; count++) {
    await replayDemo(page);
    await expectSolves(page, count);
    await expect(badges).toHaveCount(count, { timeout: 20_000 });
    await expect(badges.first()).toHaveText(/^\s*2 clips, [\d.]+ [kM]B\s*$/, { timeout: 20_000 });
  }
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // A new page load, straight to the session's page: the session and its clips come back from the
  // origin private file system.
  await page.goto(`/sessions/${sessionId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Session');
  const rows = solveRows(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-index', '2');
  await expect(rows.nth(1)).toHaveAttribute('data-index', '1');
  for (const row of [rows.nth(0), rows.nth(1)]) {
    await expect(row.getByTestId('clip-badge')).toHaveText(/^\s*2 clips, [\d.]+ [kM]B\s*$/);
  }
  await expect(page.getByTestId('stat-count')).toHaveText('2');
  await expect(page.getByTestId('session-clip-bytes')).toHaveText(/^\s*4 clips, [\d.]+ [kM]B\s*$/);
  await expect(page.getByTestId('session-cameras')).toHaveText(/^laptop\b/);

  // The first attempt's clips, read from its folder: the solve clip plays.
  await rows.nth(1).getByTestId('clip-badge').click();
  const viewer = page.getByTestId('clip-viewer');
  await expect(viewer.getByRole('heading', { name: 'Attempt 1' })).toBeVisible();
  await expect(viewer.getByTestId('clip-video')).toHaveAttribute('data-state', 'loaded', {
    timeout: 10_000,
  });
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();

  // Export, from the session's page: valid against schema 2, both attempts with both clips.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`cubetrace-session-${sessionId}.json`);
  const exported = validateExport(JSON.parse(await readFile(await download.path(), 'utf8')));
  expect(exported.session.id).toBe(sessionId);
  expect(exported.session.summary).toEqual({ attempts: 2, solved: 2, dnf: 0 });
  expect(exported.session.notes).toBe('');
  const camera = exported.session.cameras.map((entry) => entry.label);
  expect(camera).toEqual(['laptop']);
  expect(exported.attempts.map((attempt) => attempt.index)).toEqual([1, 2]);

  // Every clip of the records is in its attempt's folder, the MP4 of the size and the frames file of
  // the frames the record says; nothing else is there but attempt.json (no temporary file left).
  const isFrames = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);
  const sizes: Record<string, number>[] = [];
  for (const attempt of exported.attempts) {
    expect(attempt.clock).not.toBeNull();
    expect(attempt.video.map((clip) => [clip.camera, clip.segment])).toEqual([
      ['laptop', 'scramble'],
      ['laptop', 'solve'],
    ]);
    const files = await attemptFiles(page, sessionId, attempt.index);
    const expected: Record<string, unknown> = { 'attempt.json': expect.any(Number) };
    for (const clip of attempt.video) {
      expected[clip.file] = clip.bytes;
      expected[clip.framesFile] = expect.any(Number);
      const frames = JSON.parse(
        await attemptText(page, sessionId, attempt.index, clip.framesFile),
      ) as FramesJson;
      expect(isFrames(frames), JSON.stringify(isFrames.errors)).toBe(true);
      expect(frames).toMatchObject({ camera: clip.camera, segment: clip.segment });
      expect(frames.dtMs).toHaveLength(clip.frames);
      expect(frames.t0HostMs).toBe(clip.firstFrameHostMs);
    }
    expect(files).toEqual(expected);
    sizes.push(files);
  }
  console.log(`session with clips: ${JSON.stringify(sizes)}`);
  test.info().annotations.push({ type: 'session-clips', description: JSON.stringify(sizes) });
});
