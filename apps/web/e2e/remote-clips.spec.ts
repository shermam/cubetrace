import {
  FRAMES_SCHEMA,
  type AttemptRecord,
  type FramesJson,
  type SessionRecord,
} from '@cubetrace/core';
import { type BrowserContext, type Locator, type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import { ADA, type FakeBucket, fakeAccount, fakeAccountState, fakeBucket } from './helpers/account';
import { fakeSignaling } from './helpers/signaling';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// A remote camera's clips (docs/PLAN.md T4.2, docs/RTC.md §9) with two pages of one browser, paired
// as remote-camera.spec.ts pairs them (the BroadcastChannel signaling, the real RTCPeerConnection on
// the loopback interface): the host records a demo attempt with its own camera on, and the phone's
// page, recording the same fake camera, gets the cuts, sends its clips, and the host writes them
// into the attempt's folder beside its own, four clips in all. The suite moves the phone's clock
// 5 s ahead of the page's (`window.cubetraceE2eRemote`, development builds only), so that the
// conversion of its frame times shows, and cuts its connection once in the middle of a file, which
// the reconnection resumes; marked as a real cube's session, the attempt's nine files go to the fake
// bucket. A second phone never answers: the attempt waits for it, a shortened wait, then goes
// without its clips, and the session's notes say whose are missing. Launch options force a browser
// of their own for this file (the encoding project, one at a time: both pages encode).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});
test.describe.configure({ mode: 'default' });

const SPEED = 20;

/** The phone's clock minus the page's, as the suite sets it. */
const OFFSET_MS = 5000;

/** The phone's connection is cut once, at the first chunk of a file past this many bytes. */
const CUT_AFTER_BYTES = 100_000;

/** The host's wait for a phone that never answers, in place of 120 s. */
const SHORT_WAIT_MS = 10_000;

/** The windows of the host's own clips (docs/PLAN.md T2.4) and the least margin of a cut (T4.2). */
const SOLVE_LEAD_MS = 3000;
const TAIL_MS = 1000;
const MARGIN_MS = 500;

/** The window property the app reads in development builds (src/app/rtc/e2e-remote.ts). */
const E2E_REMOTE = 'cubetraceE2eRemote';

const isFrames = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

/** Sets what the suite bends on every load of `page` (src/app/rtc/e2e-remote.ts). */
async function bend(page: Page, settings: Record<string, number | boolean>): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      Reflect.set(window, key, value);
    },
    { key: E2E_REMOTE, value: settings },
  );
}

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
        if (handle.kind === 'file' && !name.endsWith('.tmp')) {
          files[name] = (await handle.getFile()).size;
        }
      }
      return files;
    },
    { sessionId, folder: String(index).padStart(4, '0') },
  );
}

/** A file of the session's folder, as text: `session.json`, or `attempts/0001/<name>`. */
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

async function attemptRecord(page: Page, sessionId: string): Promise<AttemptRecord> {
  return JSON.parse(
    await fileText(page, sessionId, ['attempts', '0001', 'attempt.json']),
  ) as AttemptRecord;
}

async function sessionJson(page: Page, sessionId: string): Promise<SessionRecord> {
  return JSON.parse(await fileText(page, sessionId, ['session.json'])) as SessionRecord;
}

/** The diagnostics events in the fake account, both pages', as kind and facts. */
async function events(page: Page): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  return (await fakeAccountState(page)).events.map(
    (entry) => entry.event as { kind: string; data: Record<string, unknown> },
  );
}

/**
 * The host's page signed in on the demo, its first attempt (recorded before any camera) deleted,
 * its camera on and recording; then a phone (`bent` as the suite asks) paired through the QR's URL,
 * listed as `laptop-2` (the same fake camera on "another device"), recording, and with a few
 * answers of the clock sync, by which time its buffer holds the next attempt's margins.
 */
async function pairedPhone(
  context: BrowserContext,
  page: Page,
  bent: Record<string, number | boolean>,
): Promise<{ phone: Page; sessionId: string; bucket: FakeBucket }> {
  await fakeAccount(page);
  await fakeSignaling(page);
  const bucket = await fakeBucket(page);
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await page.getByTestId('delete-last').click();
  await expect(solveRows(page)).toHaveCount(0);
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();

  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('sync-check')).toHaveAttribute('data-state', 'framing');
  await page.getByTestId('sync-later').click();
  await page.getByTestId('add-camera').click();
  await expect(page.getByTestId('pairing')).toBeVisible({ timeout: 15_000 });
  // Record remote cameras is on by default.
  await expect(page.getByTestId('record-remote-cameras')).toBeChecked();
  const url = new URL((await page.getByTestId('pairing-url').textContent()) ?? '');

  const phone = await context.newPage();
  await bend(phone, bent);
  await fakeAccount(phone);
  await fakeSignaling(phone);
  await phone.goto(`${url.pathname}${url.search}`);
  await expect(phone.getByTestId('device-state')).toHaveAttribute('data-state', 'connected', {
    timeout: 45_000,
  });
  await expect(phone.getByTestId('device-picture-line')).toContainText('recording', {
    timeout: 15_000,
  });
  const row = page.getByTestId('remote-camera');
  await expect(row).toHaveAttribute('data-label', 'laptop-2');
  await expect(row.getByTestId('remote-camera-report')).toContainText('recording', {
    timeout: 15_000,
  });
  // Four answers of the clock sync (a ping every 2 s): the fit's own estimate from then on, and the
  // phone has recorded for longer than the next attempt's lead and margin.
  await expect
    .poll(
      async () => {
        const sync = (await row.getByTestId('remote-camera-sync').textContent()) ?? '';
        return sync.startsWith('synced') ? 99 : Number(/(\d+) samples?/u.exec(sync)?.[1] ?? 0);
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(4);
  return { phone, sessionId, bucket };
}

/**
 * Marks the session a real cube's in its session.json, as uploads.spec.ts does, from a page load of
 * its own (the Timer page's services would write the record again), then loads the Sessions page,
 * whose upload queue sends the attempt; resolves once the queue is done.
 */
async function uploadAsReal(page: Page, sessionId: string): Promise<void> {
  await page.goto('/sessions');
  await expect(page.getByTestId('upload-panel')).toBeVisible({ timeout: 20_000 });
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
      productDate: null,
    };
    const writable = await handle.createWritable();
    await writable.write(`${JSON.stringify(session, null, 2)}\n`);
    await writable.close();
  }, sessionId);
  await page.goto('/sessions');
  await expect(page.getByTestId('upload-panel').getByTestId('upload-status')).toHaveText(
    'Up to date: every attempt of this device is uploaded.',
    { timeout: 30_000 },
  );
}

test("a paired phone's clips come into the attempt's folder: four clips, its times converted from its clock, a transfer cut in the middle resumed, nine files uploaded", async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  const { phone, sessionId, bucket } = await pairedPhone(context, page, {
    clockOffsetMs: OFFSET_MS,
    closeAfterBytes: CUT_AFTER_BYTES,
  });

  // A demo attempt with both cameras recording.
  await replayDemo(page);
  await expectSolves(page, 1);

  // The attempt's folder: its record and four clips, each with its frames file, the phone's
  // named after the label the session gives its camera.
  await expect
    .poll(async () => (await attemptRecord(page, sessionId)).video.length, { timeout: 90_000 })
    .toBe(4);
  const record = await attemptRecord(page, sessionId);
  expect(record.video.map((clip) => `${clip.camera} ${clip.segment}`).sort()).toEqual([
    'laptop scramble',
    'laptop solve',
    'laptop-2 scramble',
    'laptop-2 solve',
  ]);
  const files = await attemptFiles(page, sessionId, 1);
  const expected: Record<string, unknown> = { 'attempt.json': expect.any(Number) };
  for (const clip of record.video) {
    expected[clip.file] = clip.bytes;
    expected[clip.framesFile] = expect.any(Number);
  }
  expect(files).toEqual(expected);

  // The phone's frames files: its own first frame time kept, the host's 5 s earlier (the phone's
  // clock as the suite moved it, measured by the clock sync), with the estimate that converted it.
  for (const clip of record.video.filter((c) => c.camera === 'laptop-2')) {
    const frames = JSON.parse(
      await fileText(page, sessionId, ['attempts', '0001', clip.framesFile]),
    ) as FramesJson;
    expect(isFrames(frames), JSON.stringify(isFrames.errors)).toBe(true);
    expect(frames.camera).toBe('laptop-2');
    expect(frames.t0HostMs).toBe(clip.firstFrameHostMs);
    const shift = (frames.t0RemoteMs ?? 0) - frames.t0HostMs;
    expect(
      Math.abs(shift - OFFSET_MS),
      `${clip.segment}: shifted ${String(shift)} ms`,
    ).toBeLessThan(20);
    expect(frames.remote).toMatchObject({
      converged: expect.any(Boolean),
      samples: expect.any(Number),
      takenMs: expect.any(Number),
    });
    expect(Math.abs((frames.remote?.offsetMs ?? 0) - OFFSET_MS)).toBeLessThan(20);
    expect(clip).toMatchObject({ syncResidualMs: null, frames: frames.dtMs.length });
  }
  // The phone's solve clip covers the host's window and the margin on both sides: the host trims
  // nothing (its first frame at the keyframe at or before the window's start).
  const phoneSolve = record.video.find((c) => c.camera === 'laptop-2' && c.segment === 'solve');
  const solveFrames = JSON.parse(
    await fileText(page, sessionId, ['attempts', '0001', phoneSolve?.framesFile ?? '']),
  ) as FramesJson;
  const lastMs = solveFrames.dtMs.reduce((at, dt) => at + dt, solveFrames.t0HostMs);
  const { solveStart, solveEnd } = record.events;
  expect(solveFrames.t0HostMs).toBeLessThanOrEqual(
    (solveStart ?? 0) - SOLVE_LEAD_MS - MARGIN_MS + 50,
  );
  expect(lastMs).toBeGreaterThanOrEqual((solveEnd ?? 0) + TAIL_MS + MARGIN_MS - 100);

  // The transfer cut in the middle of a file went on from the bytes the host held, over the
  // connection made again; the phone holds nothing more.
  await expect
    .poll(async () => (await events(page)).filter((e) => e.kind === 'remote.clip').length, {
      timeout: 20_000,
    })
    .toBe(2);
  const all = await events(page);
  const clips = all.filter((e) => e.kind === 'remote.clip');
  expect(clips.map((e) => e.data['camera'])).toEqual(['laptop-2', 'laptop-2']);
  expect(Math.max(...clips.map((e) => Number(e.data['resumedBytes'])))).toBeGreaterThan(0);
  expect(all.some((e) => e.kind === 'rtc.connected' && e.data['reconnection'] === true)).toBe(true);
  const sent = all.filter((e) => e.kind === 'remote.cut' && e.data['outcome'] === 'sent');
  expect(sent.map((e) => e.data['segment']).sort()).toEqual(['scramble', 'solve']);
  expect(sent.every((e) => Number(e.data['marginMs']) >= MARGIN_MS)).toBe(true);
  await expect(phone.getByTestId('device-clips')).toHaveAttribute('data-pending', '0', {
    timeout: 15_000,
  });

  // The clip viewer names each clip's camera, and plays the phone's.
  const badge = solveRows(page).getByTestId('clip-badge');
  await expect(badge).toHaveText(/^\s*4 clips, [\d.]+ [kM]B\s*$/, { timeout: 15_000 });
  await badge.click();
  const viewer = page.getByTestId('clip-viewer');
  await expect(viewer.getByTestId('clip-segment')).toHaveCount(4);
  await viewer
    .locator('[data-testid="clip-segment"][data-camera="laptop-2"][data-segment="solve"]')
    .click();
  await expect(viewer.getByTestId('clip-facts')).toContainText('laptop-2.solve.mp4: ');
  await expect(viewer.locator('video')).toHaveAttribute('src', /^blob:/);
  await viewer.getByRole('button', { name: 'Close' }).click();

  // Uploaded with the attempt: its nine files and session.json, each once.
  await phone.close();
  await uploadAsReal(page, sessionId);
  const prefix = `users/${ADA.uid}/sessions/${sessionId}`;
  expect([...bucket.puts].sort()).toEqual(
    [
      ...Object.keys(files).map((name) => `${prefix}/attempts/0001/${name}`),
      `${prefix}/session.json`,
    ].sort(),
  );
  expect(Object.keys(files)).toHaveLength(9);
  for (const [name, bytes] of Object.entries(files)) {
    expect(bucket.objects.get(`${prefix}/attempts/0001/${name}`)?.bytes, name).toBe(bytes);
  }
});

test('a phone that never answers: the attempt waits for it, then goes without its clips, and the notes say whose are missing', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  await bend(page, { clipWaitMs: SHORT_WAIT_MS });
  const { phone, sessionId, bucket } = await pairedPhone(context, page, { ignoreCuts: true });

  await replayDemo(page);
  await expectSolves(page, 1);

  // The wait over, the session's notes name the camera, for each clip.
  const missing = (segment: string): string =>
    `remote clip missing: ${segment} of attempt 1 from laptop-2: no clip within ${String(SHORT_WAIT_MS / 1000)} s of the attempt's end`;
  await expect
    .poll(
      async () =>
        (await sessionJson(page, sessionId)).notes
          .split('\n')
          .filter((line) => line.startsWith('remote clip missing')),
      { timeout: 45_000 },
    )
    .toEqual([missing('scramble'), missing('solve')]);
  const record = await attemptRecord(page, sessionId);
  expect(record.video.map((clip) => clip.camera)).toEqual(['laptop', 'laptop']);

  // The attempt was held for the phone's clips until the wait was over, then let go: its event
  // says nothing was left to come.
  await expect
    .poll(
      async () =>
        (await events(page))
          .filter((e) => e.kind === 'remote.clip.missing')
          .map((e) => e.data['reason']),
      { timeout: 20_000 },
    )
    .toEqual(['wait', 'wait']);
  // The first `attempt.done` is the demo solve's that came with the page, deleted before the camera.
  const done = (await events(page)).filter((e) => e.kind === 'attempt.done').at(-1);
  expect(done?.data).toMatchObject({ clips: 2, settled: true });
  expect(Number(done?.data['settledMs'])).toBeGreaterThanOrEqual(SHORT_WAIT_MS - 1000);
  await expect(phone.getByTestId('device-clips')).toHaveAttribute('data-pending', '0');

  // Uploaded without the phone's clips: the laptop's five files and session.json.
  await phone.close();
  await uploadAsReal(page, sessionId);
  const prefix = `users/${ADA.uid}/sessions/${sessionId}`;
  expect([...bucket.puts].sort()).toEqual(
    [
      'attempt.json',
      'laptop.scramble.frames.json',
      'laptop.scramble.mp4',
      'laptop.solve.frames.json',
      'laptop.solve.mp4',
    ]
      .map((name) => `${prefix}/attempts/0001/${name}`)
      .concat(`${prefix}/session.json`)
      .sort(),
  );
});
