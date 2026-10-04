import {
  FRAMES_SCHEMA,
  type AttemptRecord,
  type FramesJson,
  type SessionRecord,
} from '@cubetrace/core';
import { type BrowserContext, type Locator, type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import { ADA, type FakeBucket, fakeAccount, fakeAccountState, fakeBucket } from './helpers/account';
import { bend, fileText, pill } from './helpers/remote';
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
// without its clips, and the session's notes say whose are missing. A third pairing presses New
// session right after the solve: the host keeps the phone until its clips are in, in the ended
// session's attempt, then lets it go (T4.2b). Launch options force a browser of their own for this
// file (the encoding project, one at a time: both pages encode).
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

const isFrames = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

/**
 * The files of attempt `index`'s folder, with their sizes, read in the page. The app replaces a
 * file by moving a new one over it (`writeTextFile`), and a read at that instant finds no file:
 * the folder is read again then, a few times, as {@link fileText} does.
 */
async function attemptFiles(
  page: Page,
  sessionId: string,
  index: number,
): Promise<Record<string, number>> {
  return page.evaluate(
    async ({ sessionId, folder }) => {
      for (let tries = 1; ; tries++) {
        try {
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
        } catch (error: unknown) {
          if (!(error instanceof DOMException) || error.name !== 'NotFoundError' || tries === 5) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    { sessionId, folder: String(index).padStart(4, '0') },
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
 * `ready` once the pair can record an attempt: the phone connected, the clock sync with an answer
 * (a cut's estimate: before the fit keeps three samples, the offset of the trip of least round trip,
 * which on loopback places the clock within a few ms), and the phone recording for longer than the
 * next attempt's lead and margin (connected for 6 s); otherwise the lines that say what is missing.
 * Not convergence, nor a number of samples kept: a cut waits for neither (T4.2), and between two
 * pages of one browser that both encode, most round trips are far over the least (a median of 17 to
 * 18 ms against 2 to 3 on CI), so convergence can take a while there.
 */
async function readiness(phone: Page, row: Locator): Promise<string> {
  const state = await pill(phone);
  const host = (await row.getByTestId('remote-camera-state').allTextContents()).join(' ').trim();
  const sync = (await row.getByTestId('remote-camera-sync').allTextContents()).join(' ').trim();
  // "connected for 35 s", "connected for 1 min 05 s".
  const minutes = Number(/(\d+) min/u.exec(host)?.[1] ?? 0);
  const seconds = Number(/(\d+) s$/u.exec(host)?.[1] ?? 0);
  const connectedFor = host.startsWith('connected for ') ? minutes * 60 + seconds : -1;
  return state === 'connected' && sync.includes('round trip') && connectedFor >= 6
    ? 'ready'
    : `phone: ${state}; host: ${host}; sync: ${sync}`;
}

/**
 * The host's page signed in on the demo, its first attempt (recorded before any camera) deleted,
 * its camera on and recording; then a phone (`bent` as the suite asks) paired through the QR's URL,
 * listed as `laptop-2` (the same fake camera on "another device"), recording, and ready for an
 * attempt ({@link readiness}). A precondition that fails says why, in the lines the pages show.
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
  // Connected; a join refused fails with its reason (the pill's problem line).
  await expect.poll(() => pill(phone), { timeout: 45_000 }).toBe('connected');
  await expect(phone.getByTestId('device-picture-line')).toContainText('recording', {
    timeout: 15_000,
  });
  const row = page.getByTestId('remote-camera');
  await expect(row).toHaveAttribute('data-label', 'laptop-2');
  await expect(row.getByTestId('remote-camera-report')).toContainText('recording', {
    timeout: 15_000,
  });
  await expect.poll(() => readiness(phone, row), { timeout: 30_000 }).toBe('ready');
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

test("New session right after a solve: the host keeps the phone until its clips are in the ended session's attempt, four clips and no note, then lets it go", async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  // The host waits for the phone's last clips up to 15 s; longer here, so that a slow runner's
  // transfer is not mistaken for the wait's bound, which the unit tests hold.
  await bend(page, { finishWaitMs: 60_000 });
  const { phone, sessionId } = await pairedPhone(context, page, {});

  await replayDemo(page);
  await expectSolves(page, 1);
  // At once: the phone cuts the solve clip a second and a half after the solve's end at the
  // earliest, then sends it, so its clips are still to come.
  await page.getByTestId('new-session').click();
  const row = page.getByTestId('remote-camera');
  await expect(row).toHaveAttribute('data-state', 'finishing');
  await expect(row.getByTestId('remote-camera-state')).toHaveText(
    /^waiting for the phone's last clips \([12]\)$/u,
  );
  await expect.poll(() => currentSessionId(page)).not.toBe(sessionId);

  // The clips come into the ended session's attempt: four clips, each with its frames file.
  await expect
    .poll(async () => (await attemptRecord(page, sessionId)).video.length, { timeout: 60_000 })
    .toBe(4);
  const record = await attemptRecord(page, sessionId);
  expect(record.video.map((clip) => `${clip.camera} ${clip.segment}`).sort()).toEqual([
    'laptop scramble',
    'laptop solve',
    'laptop-2 scramble',
    'laptop-2 solve',
  ]);
  const files = await attemptFiles(page, sessionId, 1);
  expect(Object.keys(files)).toHaveLength(9);
  for (const clip of record.video) {
    expect(files[clip.file], clip.file).toBe(clip.bytes);
    expect(files[clip.framesFile], clip.framesFile).toBeGreaterThan(0);
  }

  // Then the phone is let go, the session's end the reason, and nothing is noted missing.
  await expect(phone.getByTestId('device-state')).toHaveAttribute('data-state', 'left', {
    timeout: 15_000,
  });
  await expect(phone.getByTestId('device-problem')).toContainText('the session ended');
  await expect(row).toHaveCount(0);
  expect((await sessionJson(page, sessionId)).notes).not.toContain('remote clip missing');
  await expect
    .poll(async () => (await events(page)).filter((e) => e.kind === 'remote.clip').length, {
      timeout: 20_000,
    })
    .toBe(2);
  const all = await events(page);
  expect(all.filter((e) => e.kind === 'remote.clip.missing')).toEqual([]);
  expect(
    all.some((e) => e.kind === 'rtc.disconnected' && e.data['reason'] === 'the session ended'),
  ).toBe(true);
  await phone.close();
});
