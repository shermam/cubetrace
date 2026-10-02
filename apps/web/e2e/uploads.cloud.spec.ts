import {
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  USER_SCHEMA,
  type CloudUpload,
} from '@cubetrace/core';
import { type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import {
  type GoogleAccount,
  authAccount,
  firestoreCollection,
  firestoreDocument,
  sinkObjects,
  sinkText,
  useEmulators,
} from './helpers/emulators';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// The session index (T3.1), the signed uploads (T3.2) and the upload queue (T3.3) with the app's own
// Firebase SDK, against the emulators (npm run e2e:cloud): a session recorded with Chrome's fake camera,
// marked as a real cube's, goes to the Firestore emulator through the project's rules, its attempt's
// files and session.json through the Functions emulator's signUpload (BUCKET_PROVIDER=local) into the
// bucket sink, and confirmUpload marks the attempt done; the Sessions page, the session's page and the
// QA view then say so. Launch options force a browser of its own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

const GRACE: GoogleAccount = { sub: 'e2e-grace', email: 'grace@example.com', name: 'Grace Hopper' };

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isSessionDocument = ajv.compile(CLOUD_SESSION_SCHEMA);
const isAttemptDocument = ajv.compile(CLOUD_ATTEMPT_SCHEMA);
const isUserRecord = ajv.compile(USER_SCHEMA);

/** The files of the session's folder (`session.json`) or of attempt `folder`'s, with their sizes. */
async function folderFiles(
  page: Page,
  sessionId: string,
  folder: string[],
): Promise<Record<string, number>> {
  return page.evaluate(
    async ({ sessionId, folder }) => {
      let dir = await navigator.storage.getDirectory();
      for (const name of ['sessions', sessionId, ...folder]) {
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
    { sessionId, folder },
  );
}

/** A file of the session's folder or of an attempt's, as text. */
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

/** Marks the session as a real cube's in its session.json, as cloud.spec.ts and uploads.spec.ts do. */
async function markReal(page: Page, sessionId: string): Promise<void> {
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
    };
    const writable = await handle.createWritable();
    await writable.write(`${JSON.stringify(session, null, 2)}\n`);
    await writable.close();
  }, sessionId);
}

test('a real session recorded with the camera on reaches the Firestore emulator and the bucket through the functions, confirmed; the Sessions page, its page and the QA view say so', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await useEmulators(page, GRACE);

  // Signed in on a laptop: uploads on, local copies kept.
  await page.goto('/settings');
  const label = page.getByTestId('host-label');
  await label.fill('e2e-laptop');
  await label.blur();
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account: Grace Hopper' }),
  ).toBeVisible({ timeout: 30_000 });
  const uploads = page.getByRole('region', { name: 'Uploads' });
  await expect(uploads.getByTestId('upload-sessions')).toBeChecked();
  await expect(uploads.getByTestId('keep-local-copies')).toBeChecked();

  // One attempt recorded with the camera on (the demo solve that starts with the page is recorded
  // before the camera is on, and Delete last removes it), as uploads.spec.ts records it, with the
  // demo cube's gyroscope on, so that the attempt has its gyro file (T3.7: its sixth file).
  await page.goto(demoPath(0, 20, undefined, true));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
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
  await expect(solveRows(page).getByTestId('clip-badge')).toHaveText(
    /^\s*2 clips, [\d.]+ [kM]B\s*$/,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // Marked as a real cube's session, the next page load indexes it (the catch-up) and uploads it.
  await markReal(page, sessionId);
  await page.goto('/sessions');
  const panel = page.getByTestId('upload-panel');
  await expect(panel.getByTestId('upload-status')).toHaveText(
    'Up to date: every attempt of this device is uploaded.',
    { timeout: 60_000 },
  );
  await expect(panel.getByTestId('upload-recent')).toContainText('attempt 1 of');
  await expect(
    page
      .locator(`[data-testid="session-row"][data-session="${sessionId}"]`)
      .getByTestId('session-place'),
  ).toHaveText('both');

  // The index, as the rules let the app write it and the functions completed it.
  const { uid } = (await authAccount(GRACE.email)) ?? { uid: '' };
  expect(uid).not.toBe('');
  const session = (await firestoreDocument(`sessions/${sessionId}`)) ?? {};
  expect(isSessionDocument(session), JSON.stringify(isSessionDocument.errors)).toBe(true);
  expect(session).toMatchObject({
    id: sessionId,
    owner: uid,
    host: { label: 'e2e-laptop' },
    cube: { hardware: 'e2e-real' },
    summary: { attempts: 1, solved: 1, dnf: 0 },
  });
  const attempts = await firestoreCollection(`sessions/${sessionId}/attempts`);
  expect(Object.keys(attempts)).toEqual(['0001']);
  const attempt = attempts['0001'];
  expect(isAttemptDocument(attempt), JSON.stringify(isAttemptDocument.errors)).toBe(true);
  expect(attempt).not.toHaveProperty('moves');
  expect(attempt).toMatchObject({
    session: sessionId,
    index: 1,
    owner: uid,
    device: { host: 'e2e-laptop', cameras: ['laptop'] },
  });

  // The attempt's six files and session.json, each in the bucket under the account's prefix with the
  // size and type the device has, each confirmed in the attempt's upload, which is done.
  const files = await folderFiles(page, sessionId, ['attempts', '0001']);
  expect(Object.keys(files).sort()).toEqual([
    'attempt.json',
    'gyro.json',
    'laptop.scramble.frames.json',
    'laptop.scramble.mp4',
    'laptop.solve.frames.json',
    'laptop.solve.mp4',
  ]);
  expect(attempt).toMatchObject({
    gyro: { file: 'gyro.json', truncatedStart: false },
    app: { version: expect.any(String) as unknown, commit: expect.any(String) as unknown },
    resyncs: [],
  });
  expect(session).toMatchObject({ cube: { gyro: true, productDate: null } });
  expect(Array.isArray(session['battery'])).toBe(true);
  const sessionBytes = (await folderFiles(page, sessionId, []))['session.json'];
  const sizes: Record<string, number> = { ...files, 'session.json': sessionBytes };
  const prefix = `users/${uid}/sessions/${sessionId}`;
  const keyOf = (path: string): string =>
    path === 'session.json' ? `${prefix}/session.json` : `${prefix}/attempts/0001/${path}`;
  expect(await sinkObjects(`users/${uid}/`)).toEqual(
    Object.entries(sizes)
      .map(([path, bytes]) => ({
        key: keyOf(path),
        bytes,
        contentType: path.endsWith('.mp4') ? 'video/mp4' : 'application/json',
      }))
      .sort((p, q) => p.key.localeCompare(q.key)),
  );
  expect(await sinkText(keyOf('attempt.json'))).toBe(
    await fileText(page, sessionId, ['attempts', '0001', 'attempt.json']),
  );
  expect(await sinkText(keyOf('session.json'))).toBe(
    await fileText(page, sessionId, ['session.json']),
  );
  const upload = attempt['upload'] as CloudUpload;
  expect(upload.state).toBe('done');
  expect(Object.keys(upload.files).sort()).toEqual(Object.keys(sizes).sort());
  for (const [path, file] of Object.entries(upload.files)) {
    expect(file.bytes, path).toBe(sizes[path]);
    expect(file.doneMs, path).toEqual(expect.any(Number));
  }

  // The account's record: the device, and the day's quota as signUpload counted it, one signature per
  // file.
  const user = (await firestoreDocument(`users/${uid}`)) ?? {};
  const { quota, ...record } = user;
  expect(isUserRecord(record), JSON.stringify(isUserRecord.errors)).toBe(true);
  expect(quota).toEqual({
    day: new Date().toISOString().slice(0, 10),
    bytes: Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0),
    files: 7,
  });

  // The session's page: its attempt's row says it is uploaded.
  await page.goto(`/sessions/${sessionId}`);
  await expect(solveRows(page)).toHaveCount(1);
  await expect(solveRows(page).getByTestId('upload-badge')).toHaveText('uploaded');
  await expect(solveRows(page).getByTestId('upload-badge')).toHaveAttribute('data-state', 'done');

  // The QA view counts what confirmUpload confirmed, nothing pending.
  await page.goto('/qa');
  const qaRow = page.locator('[data-testid="qa-row"][data-device="e2e-laptop"]');
  await expect(qaRow.getByTestId('qa-attempts')).toHaveText('1');
  await expect(qaRow.getByTestId('qa-clips')).toHaveText('2');
  await expect(qaRow.getByTestId('qa-pending')).toHaveText('0 B');
  await expect(qaRow.getByTestId('qa-uploaded')).not.toHaveText('0 B');
});
