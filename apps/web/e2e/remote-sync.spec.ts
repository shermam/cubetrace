import type { AttemptRecord, SessionRecord } from '@cubetrace/core';
import { type Locator, type Page, expect, test } from '@playwright/test';

import { fakeAccount, fakeAccountState } from './helpers/account';
import {
  RECORDING,
  SYNTHETIC_CAMERA,
  bend,
  fileText,
  flipAt,
  flips,
  pill,
  syntheticCamera,
  turnAt,
  turned,
} from './helpers/remote';
import { fakeSignaling } from './helpers/signaling';
import { currentSessionId, demoPath, expectSolves, replayDemo } from './helpers/timer';

// The sync check of a remote camera and the phone's live picture (docs/PLAN.md T4.3, docs/RTC.md
// §10) with two pages of one browser, paired as remote-camera.spec.ts pairs them (the
// BroadcastChannel signaling, the real RTCPeerConnection on the loopback interface). The host's own
// camera stays off; the phone's page films a synthetic camera (helpers/remote.ts: a canvas whose
// square flips at the times the suite gives, and nothing else moves), and its connection's clock is
// 5 s ahead of the page's (`window.cubetraceE2eRemote`), so that its frames' times must go through
// the clock sync. Its live picture is the Timer's main picture (the host has no camera of its own),
// at a fifth of its resolution. The phone's line under it starts a check; the suite turns the demo
// cube ten times, a second and a third apart, and flips the square 120 ms after each turn: the check
// finds that lag, keeps it beside the phone's clock sync in session.json, its event says remote, and
// the next attempt's clips from the phone take it as their syncResidualMs. "Live preview from
// phones" off, the thumbnail is the picture again; on, the live picture is back, and the phone's
// events say what each span of preview cost. Launch options force a browser of their own for this
// file (the encoding project, one at a time: the phone encodes).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});
test.describe.configure({ mode: 'default' });

const SPEED = 20;

/** The phone's clock minus the page's, as the suite sets it. */
const OFFSET_MS = 5000;

/** The synthetic camera's lag: its square flips this long after each of the cube's turns. */
const LAG_MS = 120;

/** The check's turns, how far apart, and how long after the check's start the first comes. */
const TURNS = 10;
const TURN_GAP_MS = 1300;
const FIRST_TURN_MS = 2000;

/**
 * How much later than the lag the pages made the check may find the camera: the frame that first
 * shows a flip is captured at the canvas's next frame (30 fps: up to 33 ms later) and reaches the
 * capture worker a few ms after that; two frame intervals and a few ms.
 */
const LATE_MS = 75;

/**
 * How much earlier it may find it: only by what the clock estimate is off by, which on the loopback
 * interface is a few ms.
 */
const EARLY_MS = 10;

function banner(page: Page): Locator {
  return page.getByRole('banner');
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

/** The diagnostics events in the fake account, both pages', as kind and facts. */
async function events(page: Page): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  return (await fakeAccountState(page)).events.map(
    (entry) => entry.event as { kind: string; data: Record<string, unknown> },
  );
}

/** The size of the frames a video element shows: 0 × 0 before the first. */
async function videoSize(video: Locator): Promise<[number, number]> {
  return video.evaluate((element: HTMLVideoElement) => [element.videoWidth, element.videoHeight]);
}

test("a phone's camera gets a sync check of its own: its lag found through the clock sync, kept beside it, its later clips take it; its live picture over the host's preview, switched off and on", async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  await fakeAccount(page);
  await fakeSignaling(page);
  await page.goto(demoPath(0, SPEED));
  // The demo solve that starts with the page, saved; the next attempt waits for its scramble.
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();

  // The Cameras section, the host's own camera off: Add camera publishes a pairing.
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('add-camera').click();
  await expect(page.getByTestId('pairing')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('live-preview-from-phones')).toBeChecked();
  const url = new URL((await page.getByTestId('pairing-url').textContent()) ?? '');

  // The phone: the synthetic camera, its connection's clock 5 s ahead.
  const phone = await context.newPage();
  await bend(phone, { clockOffsetMs: OFFSET_MS });
  await syntheticCamera(phone);
  await fakeAccount(phone);
  await fakeSignaling(phone);
  await phone.goto(`${url.pathname}${url.search}`);
  await expect.poll(() => pill(phone), { timeout: 45_000 }).toBe('connected');
  await expect(phone.getByTestId('device-picture-line')).toContainText(RECORDING, {
    timeout: 15_000,
  });
  const row = page.getByTestId('remote-camera');
  await expect(row.getByTestId('remote-camera-report')).toContainText(RECORDING, {
    timeout: 15_000,
  });
  await expect(row.getByTestId('remote-camera-sync')).toContainText('round trip', {
    timeout: 15_000,
  });
  // The only camera of the session: `laptop` (the phone's browser says Windows under Playwright).
  const label = (await row.getAttribute('data-label')) ?? '';
  expect(label).toBe('laptop');

  // Its live picture: the main one, the host having no camera of its own; a fifth of 640 × 360.
  const main = page.getByTestId('remote-preview-main');
  await expect(main).toHaveAttribute('data-label', label, { timeout: 15_000 });
  const picture = main.locator('app-remote-picture');
  await expect(picture).toHaveAttribute('data-live', 'true', { timeout: 15_000 });
  const video = picture.getByTestId('remote-picture-video');
  await expect
    .poll(() => videoSize(video), { timeout: 10_000 })
    .toEqual([SYNTHETIC_CAMERA.width / 5, SYNTHETIC_CAMERA.height / 5]);
  // The phone says it sends it.
  await expect(phone.getByTestId('device-live-preview')).toHaveAttribute('data-sending', 'true');

  // The phone's line under the preview: no check yet; Sync check asks for the framing on the phone
  // (its rectangle is the whole frame), and Start anyway starts it.
  const line = page.getByTestId('sync-remote-line');
  await expect(line).toHaveAttribute('data-label', label);
  await expect(line).toContainText(`Sync: ${label} has no check in this session.`);
  await line.getByTestId('sync-remote-start').click();
  const panel = page.getByTestId('sync-check');
  await expect(panel).toHaveAttribute('data-state', 'framing');
  await expect(page.getByTestId('sync-heading')).toHaveText(`Sync check · ${label}`);
  await expect(page.getByTestId('sync-framing')).toContainText('on the phone first');
  await expect(page.getByTestId('sync-edit-framing')).toHaveCount(0);
  await page.getByTestId('sync-anyway').click();
  await expect(panel).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'sync-check');
  // The phone measures, and says so.
  await expect(phone.getByTestId('device-sync-check')).toBeVisible();

  // Ten turns of the demo cube, and the square's flips LAG_MS after each.
  const startMs = await page.evaluate(() => performance.timeOrigin + performance.now());
  const times = Array.from({ length: TURNS }, (_, k) => startMs + FIRST_TURN_MS + k * TURN_GAP_MS);
  await flipAt(
    phone,
    times.map((at) => at + LAG_MS),
  );
  await turnAt(page, times);
  await expect(panel).toHaveAttribute('data-state', 'passed', { timeout: 40_000 });
  await expect(phone.getByTestId('device-sync-check')).toHaveCount(0);
  const turns = await turned(page);
  const flipped = await flips(phone);
  expect(turns).toHaveLength(TURNS);
  expect(flipped).toHaveLength(TURNS);
  // The lag as the two pages made it, each turn's flip minus its turn (their timers' jitter).
  const made = flipped.map((at, k) => at - turns[k]).sort((a, b) => a - b);
  const result = (await page.getByTestId('sync-result').textContent()) ?? '';
  const match = /^\s*laptop lags the cube by (\d+) ms \(±(\d+)\)\.\s*$/u.exec(result);
  expect(match, result).not.toBeNull();
  const offsetMs = Number(match?.[1]);
  const spreadMs = Number(match?.[2]);
  console.info(
    `remote sync check: found ${String(offsetMs)} ms (±${String(spreadMs)}) for a lag of ${String(LAG_MS)} ms ` +
      `(as made: ${made.map((ms) => ms.toFixed(1)).join(', ')} ms)`,
  );
  // Positive, and the lag the pages made (their timers' jitter aside: the median of the ten) and
  // the camera's own delay, the capture's and the delivery's, as a phone's camera has its own.
  const madeMs = (made[4] + made[5]) / 2;
  expect(offsetMs).toBeGreaterThanOrEqual(madeMs - EARLY_MS);
  expect(offsetMs).toBeLessThanOrEqual(madeMs + LATE_MS);

  // Kept beside the phone's clock sync, which placed its frames 5 s back on the host clock.
  const clock = (await sessionJson(page, sessionId)).clock.cameras[label];
  expect(Math.round(clock.offsetMs)).toBe(offsetMs);
  expect(clock.clapperboardSamples).toBeGreaterThanOrEqual(8);
  expect(clock.samples).toHaveLength(clock.clapperboardSamples);
  expect(clock.remote).toMatchObject({ samples: expect.any(Number) });
  expect(Math.abs((clock.remote?.offsetMs ?? 0) - OFFSET_MS)).toBeLessThan(20);
  expect(clock.rttMs).toBe(clock.remote?.rttMs);
  await page.getByTestId('sync-later').click();
  await expect(line).toContainText(`Sync: ${label} lags the cube by ${String(offsetMs)} ms`);

  // Its event: the check's, with the phone and the clock sync that placed its frames.
  await expect
    .poll(
      async () => (await events(page)).filter((e) => e.kind === 'sync.check').map((e) => e.data),
      { timeout: 20_000 },
    )
    .toEqual([
      expect.objectContaining({
        outcome: 'ok',
        camera: label,
        remote: true,
        peer: expect.stringMatching(/ laptop$/u),
        saved: true,
      }),
    ]);
  const check = (await events(page)).find((e) => e.kind === 'sync.check')?.data ?? {};
  expect(Math.round(Number(check['offsetMs']))).toBe(offsetMs);
  expect(Math.abs(Number(check['clockOffsetMs']) - OFFSET_MS)).toBeLessThan(20);
  console.info(`sync.check: ${JSON.stringify(check)}`);

  // The next attempt: the phone's clips take the lag as their syncResidualMs.
  await replayDemo(page);
  await expectSolves(page, 2);
  await expect
    .poll(async () => (await attemptRecord(page, sessionId, 2))?.video.length ?? 0, {
      timeout: 90_000,
    })
    .toBe(2);
  const record = await attemptRecord(page, sessionId, 2);
  expect(record?.video.map((clip) => `${clip.camera} ${clip.segment}`).sort()).toEqual([
    `${label} scramble`,
    `${label} solve`,
  ]);
  for (const clip of record?.video ?? []) {
    expect(clip.syncResidualMs, clip.file).toBe(clock.offsetMs);
    expect([clip.width, clip.height]).toEqual([SYNTHETIC_CAMERA.width, SYNTHETIC_CAMERA.height]);
  }
  // Their events say the lag they took, for the round report.
  await expect
    .poll(
      async () =>
        (await events(page))
          .filter((e) => e.kind === 'remote.clip')
          .map((e) => e.data['syncResidualMs']),
      { timeout: 20_000 },
    )
    .toEqual([Math.round(clock.offsetMs * 10) / 10, Math.round(clock.offsetMs * 10) / 10]);

  // "Live preview from phones" off: the phone stops sending, the thumbnail is the picture again.
  await page.getByTestId('live-preview-from-phones').uncheck();
  await expect(phone.getByTestId('device-live-preview')).toHaveAttribute('data-sending', 'false');
  await expect(picture).toHaveAttribute('data-live', 'false', { timeout: 15_000 });
  await expect(picture.getByTestId('remote-picture-thumbnail')).toHaveAttribute('src', /^blob:/, {
    timeout: 5000,
  });
  // On again: the live picture is back.
  await page.getByTestId('live-preview-from-phones').check();
  await expect(picture).toHaveAttribute('data-live', 'true', { timeout: 15_000 });

  // The phone's events say what the preview cost, span by span: the recording's frame rate
  // before it started and while it was sent, and its encoder's frames and bitrate.
  await expect
    .poll(
      async () =>
        (await events(page))
          .filter((e) => e.kind === 'preview.started' || e.kind === 'preview.stopped')
          .map((e) => e.kind),
      { timeout: 20_000 },
    )
    .toEqual(['preview.started', 'preview.stopped', 'preview.started']);
  const all = await events(page);
  const started = all.find((e) => e.kind === 'preview.started');
  expect(started?.data).toMatchObject({
    width: SYNTHETIC_CAMERA.width,
    height: SYNTHETIC_CAMERA.height,
    scale: 5,
    maxKbps: 300,
    maxFps: 15,
  });
  const stopped = all.find((e) => e.kind === 'preview.stopped');
  expect(stopped?.data).toMatchObject({
    why: 'off',
    sentWidth: SYNTHETIC_CAMERA.width / 5,
    sentHeight: SYNTHETIC_CAMERA.height / 5,
  });
  expect(Number(stopped?.data['frames'])).toBeGreaterThan(0);
  expect(Number(stopped?.data['kbps'])).toBeGreaterThan(0);
  expect(Number(stopped?.data['recordingFps'])).toBeGreaterThan(0);
  console.info(`preview.stopped: ${JSON.stringify(stopped?.data)}`);
  await phone.close();
});
