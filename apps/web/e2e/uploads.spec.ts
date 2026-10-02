import { CLOUD_ATTEMPT_SCHEMA, type AttemptRecord } from '@cubetrace/core';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import { ADA, fakeAccount, fakeAccountState, fakeBucket } from './helpers/account';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// The upload queue (docs/PLAN.md, T3.3) on the dev server, with the fake of Firebase
// (helpers/account.ts), whose upload functions sign URLs into a bucket this test runs (a route on
// the app's origin that keeps every PUT's bytes): an attempt recorded with Chrome's fake camera is a
// demo session's, which never goes; marked as a real cube's in its session.json, the next page load
// uploads its attempt.json, both clips, their frame times and session.json, the indicator and the
// Sessions page's panel following it, its row on the session's page saying "uploaded", and the QA
// view counting it; with Keep local copies off, its clips leave the device and say "in the cloud".
// Launch options force a browser of their own for this file (the encoding project, one at a time).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

const SPEED = 20;

const isAttemptDocument = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(
  CLOUD_ATTEMPT_SCHEMA,
);

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

/**
 * The files of attempt `index`'s folder in the origin private file system, with their sizes; a file
 * deleted while the folder is listed (the queue deleting a clip) is left out.
 */
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
          try {
            files[name] = (await handle.getFile()).size;
          } catch {
            // Deleted meanwhile.
          }
        }
      }
      return files;
    },
    { sessionId, folder: String(index).padStart(4, '0') },
  );
}

/** A file of the session's folder (`session.json`) or of an attempt's, as text. */
async function fileText(page: Page, sessionId: string, path: string[]): Promise<string> {
  return page.evaluate(
    async ({ sessionId, path }) => {
      let dir = await navigator.storage.getDirectory();
      for (const name of ['sessions', sessionId, ...path.slice(0, -1)]) {
        dir = await dir.getDirectoryHandle(name);
      }
      return (await (await dir.getFileHandle(path[path.length - 1])).getFile()).text();
    },
    { sessionId, path },
  );
}

test('signed in, a real session recorded with the camera on is uploaded, followed on every page; without local copies its clips are in the cloud', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await fakeAccount(page);
  const bucket = await fakeBucket(page);

  // Signed in on a laptop: uploads on, local copies kept, no Wi-Fi only (Chrome on a laptop does
  // not say the network's type).
  await page.goto('/settings');
  const label = page.getByTestId('host-label');
  await label.fill('e2e-laptop');
  await label.blur();
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();
  const uploads = page.getByRole('region', { name: 'Uploads' });
  await expect(uploads.getByTestId('upload-sessions')).toBeChecked();
  await expect(uploads.getByTestId('keep-local-copies')).toBeChecked();
  await expect(uploads.getByTestId('upload-wifi-only')).toHaveCount(0);

  // One attempt recorded with the camera on (the demo solve that starts with the page is recorded
  // before the camera is on, and Delete last removes it), as session-clips.spec.ts does.
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  const status = page.getByTestId('timer-status');
  await expect(status).toHaveAttribute('data-phase', 'scrambling', { timeout: 30_000 });
  await page.getByTestId('delete-last').click();
  await expect(solveRows(page)).toHaveCount(0);
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('sync-check')).toHaveAttribute('data-state', 'framing');
  await page.getByTestId('sync-later').click();
  const stats = page.getByTestId('recording-stats');
  await expect
    .poll(async () => Number(await stats.getAttribute('data-buffer-seconds')), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(4);
  await replayDemo(page);
  await expectSolves(page, 1);
  const badge = solveRows(page).getByTestId('clip-badge');
  await expect(badge).toHaveText(/^\s*2 clips, [\d.]+ [kM]B\s*$/, { timeout: 20_000 });
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // A demo session (the fake cube): nothing of it goes, and the header has nothing to say.
  await expect(banner(page).getByTestId('upload-indicator')).toHaveCount(0);
  expect(bucket.puts).toEqual([]);
  expect((await fakeAccountState(page)).uploadCalls).toEqual([]);

  // Marked as a real cube's session in its session.json, as cloud.spec.ts does; the next page load
  // indexes it (the catch-up) and uploads it. The bucket holds the first PUTs a moment, so that the
  // indicator and the panel show the upload under way.
  await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle('sessions');
    const handle = await (await sessions.getDirectoryHandle(id)).getFileHandle('session.json');
    const session = JSON.parse(await (await handle.getFile()).text()) as {
      cube: Record<string, unknown>;
    };
    session.cube = {
      model: 'GAN 12 ui FreePlay',
      hardware: 'e2e-real',
      firmware: '2.3.1',
      gyro: true,
      // As the app writes the cube since T3.7: with its production date (none, a Gen2 cube).
      productDate: null,
    };
    const writable = await handle.createWritable();
    await writable.write(`${JSON.stringify(session, null, 2)}\n`);
    await writable.close();
  }, sessionId);
  bucket.hold();
  await page.goto('/sessions');
  const panel = page.getByTestId('upload-panel');
  const row = panel.getByTestId('upload-row');
  await expect(row).toHaveAttribute('data-state', 'uploading', { timeout: 20_000 });
  await expect(row).toHaveAttribute('data-session', sessionId);
  await expect(row).toHaveAttribute('data-index', '1');
  await expect(panel.getByTestId('upload-status')).toContainText('Uploading: 1 attempt to upload');
  const indicator = banner(page).getByTestId('upload-indicator');
  await expect(indicator).toHaveAttribute('data-state', 'uploading');
  await expect(indicator.getByTestId('upload-count')).toHaveText('1');
  await expect(indicator).toHaveAttribute(
    'title',
    /^Uploading: 1 attempt to upload, [\d.]+ [kM]B\.$/,
  );
  expect(bucket.held).toBe(2);
  bucket.release();
  await expect(panel.getByTestId('upload-status')).toHaveText(
    'Up to date: every attempt of this device is uploaded.',
    { timeout: 20_000 },
  );
  await expect(row).toHaveCount(0);
  await expect(panel.getByTestId('upload-recent')).toContainText('attempt 1 of');
  await expect(indicator).toHaveCount(0);
  // The queue's state, in uploads.json at the root of the origin private file system, says so too:
  // the next page loads find it all done.
  await expect
    .poll(async () => {
      const text = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        return (await (await root.getFileHandle('uploads.json')).getFile()).text();
      });
      const state = JSON.parse(text) as {
        accounts: Record<
          string,
          {
            sessions: Record<
              string,
              {
                sessionJson: unknown;
                attempts: Record<string, { files: Record<string, { state: string }> }>;
              }
            >;
          }
        >;
      };
      const session = state.accounts[ADA.uid].sessions[sessionId] as
        (typeof state.accounts)[string]['sessions'][string] | undefined;
      return session === undefined || session.sessionJson === null
        ? []
        : Object.entries(session.attempts['0001'].files).map(
            ([path, file]) => `${path} ${file.state}`,
          );
    })
    .toEqual([
      'attempt.json done',
      'laptop.scramble.mp4 done',
      'laptop.scramble.frames.json done',
      'laptop.solve.mp4 done',
      'laptop.solve.frames.json done',
      'session.json done',
    ]);

  // The bucket has the attempt's files and session.json, each once, with the device's bytes.
  const prefix = `users/${ADA.uid}/sessions/${sessionId}`;
  const files = await attemptFiles(page, sessionId, 1);
  expect(Object.keys(files).sort()).toEqual([
    'attempt.json',
    'laptop.scramble.frames.json',
    'laptop.scramble.mp4',
    'laptop.solve.frames.json',
    'laptop.solve.mp4',
  ]);
  const expected = [
    ...Object.keys(files).map((name) => `${prefix}/attempts/0001/${name}`),
    `${prefix}/session.json`,
  ].sort();
  expect([...bucket.puts].sort()).toEqual(expected);
  for (const [name, bytes] of Object.entries(files)) {
    const object = bucket.objects.get(`${prefix}/attempts/0001/${name}`);
    expect(object?.bytes, name).toBe(bytes);
    expect(object?.contentType, name).toBe(
      name.endsWith('.mp4') ? 'video/mp4' : 'application/json',
    );
  }
  const attemptJson = await fileText(page, sessionId, ['attempts', '0001', 'attempt.json']);
  expect(bucket.objects.get(`${prefix}/attempts/0001/attempt.json`)?.body.toString('utf8')).toBe(
    attemptJson,
  );
  const sessionJson = await fileText(page, sessionId, ['session.json']);
  expect(bucket.objects.get(`${prefix}/session.json`)?.body.toString('utf8')).toBe(sessionJson);

  // The index says so: one signature for the six files, each confirmed, the attempt done.
  const state = await fakeAccountState(page);
  expect(state.uploadCalls.filter((call) => call.startsWith('sign'))).toHaveLength(1);
  expect(state.uploadCalls.filter((call) => call.startsWith('confirm'))).toHaveLength(6);
  const document = state.index.attempts[sessionId]['0001'];
  expect(isAttemptDocument(document), JSON.stringify(isAttemptDocument.errors)).toBe(true);
  const upload = document['upload'] as {
    state: string;
    files: Record<string, { bytes: number; doneMs: number | null }>;
  };
  expect(upload.state).toBe('done');
  expect(Object.keys(upload.files).sort()).toEqual([...Object.keys(files), 'session.json'].sort());
  expect(Object.values(upload.files).every((file) => file.doneMs !== null)).toBe(true);

  // The session's page: its attempt's row says it is uploaded.
  await page.goto(`/sessions/${sessionId}`);
  await expect(solveRows(page)).toHaveCount(1);
  await expect(solveRows(page).getByTestId('upload-badge')).toHaveText('uploaded');
  await expect(solveRows(page).getByTestId('upload-badge')).toHaveAttribute('data-state', 'done');

  // The QA view counts the uploaded bytes, nothing pending.
  await page.goto('/qa');
  const qaRow = page.locator('[data-testid="qa-row"][data-device="e2e-laptop"]');
  await expect(qaRow.getByTestId('qa-attempts')).toHaveText('1');
  await expect(qaRow.getByTestId('qa-clips')).toHaveText('2');
  await expect(qaRow.getByTestId('qa-pending')).toHaveText('0 B');
  await expect(qaRow.getByTestId('qa-uploaded')).not.toHaveText('0 B');

  // Keep local copies off: the clips of the attempt, all uploaded, leave the device; attempt.json and
  // the frame times stay, and the record says where the clips are.
  await page.goto('/settings');
  await page.getByTestId('keep-local-copies').uncheck();
  await expect
    .poll(async () => Object.keys(await attemptFiles(page, sessionId, 1)).sort(), {
      timeout: 15_000,
    })
    .toEqual(['attempt.json', 'laptop.scramble.frames.json', 'laptop.solve.frames.json']);
  const record = JSON.parse(
    await fileText(page, sessionId, ['attempts', '0001', 'attempt.json']),
  ) as AttemptRecord;
  expect(record.video.map((clip) => clip.local)).toEqual([false, false]);
  // Its document in the index too (the app's write of the record), and nothing more went up.
  await expect
    .poll(async () => {
      const video = (await fakeAccountState(page)).index.attempts[sessionId]['0001']['video'];
      return (video as { local?: boolean }[]).map((clip) => clip.local);
    })
    .toEqual([false, false]);
  expect(bucket.puts).toHaveLength(6);

  // The session's page and the Sessions page say the clips are in the cloud; the viewer says so in
  // place of the video.
  await page.goto(`/sessions/${sessionId}`);
  const clips = solveRows(page).getByTestId('clip-badge');
  await expect(clips).toHaveText('2 clips in the cloud');
  await expect(page.getByTestId('session-clip-bytes')).toHaveText('2 clips in the cloud');
  await clips.click();
  const viewer = page.getByTestId('clip-viewer');
  await expect(viewer.getByTestId('clip-cloud')).toContainText('In the cloud');
  await expect(viewer.getByTestId('clip-video')).toHaveCount(0);
  await expect(viewer.getByTestId('clip-cube')).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await page.goto('/sessions');
  await expect(
    page
      .locator(`[data-testid="session-row"][data-session="${sessionId}"]`)
      .getByTestId('session-clips'),
  ).toHaveText('2 clips in the cloud');
  await expect(page.getByTestId('upload-panel').getByTestId('upload-status')).toHaveText(
    'Up to date: every attempt of this device is uploaded.',
  );
});
