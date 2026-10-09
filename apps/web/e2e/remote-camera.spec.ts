import type { CameraClock, SessionRecord } from '@cubetrace/core';
import { type Locator, type Page, expect, test } from '@playwright/test';

import { fakeAccount, fakeAccountState } from './helpers/account';
import { RECORDING, phoneHealth } from './helpers/remote';
import { fakeSignaling } from './helpers/signaling';
import { currentSessionId, demoPath, expectSolves } from './helpers/timer';

// A remote camera (docs/PLAN.md T4.1, docs/RTC.md) with two pages of one browser: the host (the demo
// cube, Chrome's fake camera, signed in to the fake account) adds a camera in Camera settings and
// shows the QR code's URL; a second page opens it as the camera device (the same fake camera), pairs
// through the BroadcastChannel signaling (helpers/signaling.ts) and the real RTCPeerConnection on the
// loopback interface, and the host lists it with a thumbnail within 5 s; its live picture is as large
// as the host's own, in a cell beside it with its status line (T5.1: under it at 1280 px, side by
// side in a wider window), or, with "Pictures from phones" on small tiles, a tile over the host's
// preview, which a tap swaps with the main picture (T4.3), its frames a fifth of the camera's either
// way; the clock sync converges (both pages read one browser's clock: the offset is near 0); the
// camera is in session.json with `remote`; Leave removes it. Then a second pairing by the code typed,
// and Remove from the host.
// Launch options force a browser of their own for this file (the encoding project, one at a time).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});
test.describe.configure({ mode: 'default' });

const SPEED = 20;

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

/** session.json of the session, as the host wrote it into the origin private file system. */
async function sessionJson(page: Page, sessionId: string): Promise<SessionRecord> {
  return page.evaluate(async (id) => {
    let dir = await navigator.storage.getDirectory();
    for (const name of ['sessions', id]) {
      dir = await dir.getDirectoryHandle(name);
    }
    const file = await (await dir.getFileHandle('session.json')).getFile();
    return JSON.parse(await file.text()) as SessionRecord;
  }, sessionId);
}

/** The pairing URL the host shows, as a path of the dev server. */
async function pairingPath(page: Page): Promise<string> {
  const url = new URL((await page.getByTestId('pairing-url').textContent()) ?? '');
  return `${url.pathname}${url.search}`;
}

/** The host's row of the one remote camera. */
function row(page: Page): Locator {
  return page.getByTestId('remote-camera');
}

/** The size of the frames a video element shows: 0 × 0 before the first. */
async function videoSize(video: Locator): Promise<[number, number]> {
  return video.evaluate((element: HTMLVideoElement) => [element.videoWidth, element.videoHeight]);
}

/** Where `locator` is on the page, and its size. */
async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, 'on the page').not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** The offset of the sync line: "synced · round trip 1.2 ms · offset −0.3 ms · drift 0.0 ppm". */
function offsetOf(text: string): number {
  const match = /offset (−?)([\d,.]+) ms/u.exec(text);
  expect(match, text).not.toBeNull();
  return (match?.[1] === '−' ? -1 : 1) * Number(match?.[2].replace(/,/g, ''));
}

test('a second page joins as a remote camera: listed with a thumbnail, its live picture as large as the host’s with its status line, or a tile over it, the sync converges, in session.json with remote, Leave removes it; the code typed, Remove', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await fakeAccount(page);
  await fakeSignaling(page);
  await page.goto(demoPath(0, SPEED));
  // The demo solve that starts with the page, saved: the page is still from then on.
  await expectSolves(page, 1);
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();

  // The host's own camera on, and the Cameras section: Add camera loads it and publishes a pairing.
  const section = page.getByTestId('camera-section');
  await section.locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-toggle')).toHaveText('Turn off');
  await expect(page.getByTestId('camera-measured')).toHaveText(/fps/, { timeout: 10_000 });
  await page.getByTestId('add-camera').click();
  const pairing = page.getByTestId('pairing');
  await expect(pairing).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('pairing-qr').locator('path')).toHaveAttribute(
    'd',
    /^M4 4h1v1h-1z/,
  );
  const token = (await pairing.getAttribute('data-token')) ?? '';
  expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  await expect(page.getByTestId('pairing-token')).toHaveText(
    `${token.slice(0, 4)} ${token.slice(4)}`,
  );
  const path = await pairingPath(page);
  expect(path).toBe(`/camera?session=${sessionId}&token=${token}`);
  await expect(page.getByTestId('remote-cameras-none')).toHaveCount(0);

  // The phone: a second page of the browser, signed in (the account is the context's), on the QR's URL.
  const phone = await context.newPage();
  await fakeAccount(phone);
  await fakeSignaling(phone);
  // Its battery low and unplugged, its pressure fair: the host's status line reads them (T5.1).
  await phoneHealth(phone, {
    battery: { level: 0.15, charging: false },
    pressure: { source: 'thermals', state: 'fair' },
  });
  await phone.goto(path);
  const state = phone.getByTestId('device-state');
  await expect(state).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
  // The host's label is the browser's default for the machine ("Windows laptop" under Playwright's
  // Desktop Chrome, which says Windows): the two pages share the settings, as one profile does.
  await expect(phone.getByTestId('device-host')).toContainText(/ · \w+ laptop \(\w+\)$/u);
  await expect(phone.getByTestId('device-preview')).toBeVisible();
  await expect(phone.getByTestId('device-picture-line')).toContainText(RECORDING, {
    timeout: 15_000,
  });
  // The pairing is taken: the QR code is down and the camera is listed, with a thumbnail within 5 s.
  await expect(pairing).toHaveCount(0);
  await expect(row(page)).toHaveCount(1);
  await expect(row(page)).toHaveAttribute('data-state', 'connected');
  await expect(row(page).getByTestId('remote-camera-thumbnail')).toHaveAttribute('src', /^blob:/, {
    timeout: 5000,
  });
  await expect(row(page).getByTestId('remote-camera-name')).toHaveText(/^\w+ laptop$/u);
  // The host's own camera is `laptop`; the phone's, the same fake camera on another device, `laptop-2`.
  await expect(row(page).getByTestId('remote-camera-label')).toHaveText('laptop-2');
  await expect(row(page).getByTestId('remote-camera-report')).toContainText(RECORDING, {
    timeout: 15_000,
  });

  // Its live picture (T4.3, issue #60) as large as the host's own (T5.1, "Pictures from phones": the
  // same size by default on a laptop): a cell of its own, its frames a fifth of the camera's (the
  // fake camera's 1920 × 1080: 384 × 216, or fewer pixels while the encoder adapts to the CPU)
  // whatever the size it is shown at, its box the size of the host's (within 2 px), under it at 1280
  // px (the clock beside the two of them, one under the other).
  await expect(page.getByTestId('remote-pictures')).toHaveValue('equal');
  const cell = page.getByTestId('remote-preview-cell');
  await expect(cell).toHaveAttribute('data-label', 'laptop-2');
  await expect(page.getByTestId('remote-preview-tile')).toHaveCount(0);
  await expect(cell.locator('app-remote-picture')).toHaveAttribute('data-live', 'true', {
    timeout: 15_000,
  });
  const cellVideo = cell.getByTestId('remote-picture-video');
  await expect
    .poll(async () => (await videoSize(cellVideo))[0], { timeout: 10_000 })
    .toBeGreaterThan(0);
  const [width, height] = await videoSize(cellVideo);
  expect(width).toBeLessThanOrEqual(384);
  expect(width / height).toBeCloseTo(16 / 9, 1);
  const own = page.getByTestId('camera-preview-box');
  const theirs = page.getByTestId('remote-preview-box');
  const stacked = [await boxOf(own), await boxOf(theirs)];
  console.info(`equal pictures at 1280 px: ${JSON.stringify(stacked)}`);
  expect(Math.abs(stacked[0].width - stacked[1].width)).toBeLessThanOrEqual(2);
  expect(Math.abs(stacked[0].height - stacked[1].height)).toBeLessThanOrEqual(2);
  expect(stacked[0].height).toBeGreaterThan(230);
  expect(Math.abs(stacked[0].x - stacked[1].x)).toBeLessThanOrEqual(2);
  expect(stacked[1].y).toBeGreaterThan(stacked[0].y + stacked[0].height);
  // Under it, its status line from its state: the fake camera's frame rate, the sharpness, the
  // recording, and the battery and pressure the suite gave the phone, amber both; the phone's own
  // page says its pressure too.
  const line = cell.getByTestId('remote-status');
  await expect(line.getByTestId('remote-status-fps')).toHaveText(/^\d+\.\d fps$/);
  await expect(line.getByTestId('remote-status-sharpness')).toHaveText(/^sharpness [\d.]+$/);
  await expect(line.getByTestId('remote-status-recording')).toHaveText('recording');
  const battery = line.getByTestId('remote-status-battery');
  await expect(battery).toHaveText('battery 15%');
  await expect(battery).toHaveAttribute('data-tone', 'warn');
  const pressure = line.getByTestId('remote-status-pressure');
  await expect(pressure).toHaveText('pressure fair');
  await expect(pressure).toHaveAttribute('data-tone', 'warn');
  await expect(phone.getByTestId('device-pressure')).toHaveText('fair (thermals)');
  await expect(phone.getByTestId('device-pressure-warning')).toContainText('fair pressure');

  // A window wide enough for two pictures beside the clock: side by side, still the same size, the
  // page wider; the phone's frames still a fifth of its camera's.
  await page.setViewportSize({ width: 1700, height: 900 });
  await expect
    .poll(async () => Math.abs((await boxOf(theirs)).y - (await boxOf(own)).y))
    .toBeLessThanOrEqual(2);
  const beside = [await boxOf(own), await boxOf(theirs)];
  console.info(`equal pictures at 1700 px: ${JSON.stringify(beside)}`);
  expect(Math.abs(beside[0].width - beside[1].width)).toBeLessThanOrEqual(2);
  expect(Math.abs(beside[0].height - beside[1].height)).toBeLessThanOrEqual(2);
  expect(Math.abs(beside[0].width - stacked[0].width)).toBeLessThanOrEqual(2);
  expect(beside[1].x).toBeGreaterThan(beside[0].x + beside[0].width);
  const time = await boxOf(page.getByRole('region', { name: 'Time' }));
  expect(beside[0].x).toBeGreaterThanOrEqual(time.x + time.width);
  expect((await videoSize(cellVideo))[0]).toBeLessThanOrEqual(384);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Small tiles (Camera settings → Cameras → Pictures from phones): a tile over the host's preview,
  // its caption saying in short what is wrong (the battery); a tap swaps it with the main picture,
  // and a tap on this device's tile swaps back; then the same size again.
  await page.getByTestId('remote-pictures').selectOption('tiles');
  const tile = page.getByTestId('remote-preview-tile');
  await expect(tile).toHaveAttribute('data-label', 'laptop-2');
  await expect(cell).toHaveCount(0);
  await expect(tile.locator('app-remote-picture')).toHaveAttribute('data-live', 'true', {
    timeout: 15_000,
  });
  await expect(tile.getByTestId('remote-caption')).toHaveText(
    /^\s*laptop-2\s*·\s*15%\s*·\s*pressure fair\s*$/u,
  );
  const tileVideo = tile.getByTestId('remote-picture-video');
  await expect
    .poll(async () => (await videoSize(tileVideo))[0], { timeout: 10_000 })
    .toBeGreaterThan(0);
  expect((await videoSize(tileVideo))[0]).toBeLessThanOrEqual(384);
  await tile.click();
  const main = page.getByTestId('remote-preview-main');
  await expect(main).toHaveAttribute('data-label', 'laptop-2');
  await expect(tile).toHaveCount(0);
  await page.getByTestId('remote-preview-local').click();
  await expect(main).toHaveCount(0);
  await expect(tile).toHaveAttribute('data-label', 'laptop-2');
  await page.getByTestId('remote-pictures').selectOption('equal');
  await expect(cell).toHaveAttribute('data-label', 'laptop-2');
  await expect(tile).toHaveCount(0);

  // The clock sync converges: ten kept answers over ten seconds, within 5 ms of spread (the pings
  // come every 500 ms until then, and the fit keeps at least the ten of least round trip of its two
  // minutes, however much the two main threads' video and sharpness work delays the others, T4.2b);
  // both pages read the same browser's clock, so the offset is near 0.
  await expect(row(page)).toHaveAttribute('data-converged', 'true', { timeout: 90_000 });
  const sync = (await row(page).getByTestId('remote-camera-sync').textContent()) ?? '';
  expect(sync).toMatch(/^synced · round trip [\d.]+ ms · offset /u);
  expect(Math.abs(offsetOf(sync))).toBeLessThan(20);
  await expect(phone.getByTestId('device-clock')).toHaveAttribute('data-converged', 'true');
  await expect(phone.getByTestId('device-clock')).toContainText('synced · round trip');

  // session.json: the camera with `remote`, and its clock fit once converged.
  await expect
    .poll(
      async () =>
        ((await sessionJson(page, sessionId)).clock.cameras['laptop-2'] as CameraClock | undefined)
          ?.remote?.samples,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(10);
  const session = await sessionJson(page, sessionId);
  const remote = session.cameras.find((camera) => camera.label === 'laptop-2');
  expect(remote).toMatchObject({
    local: false,
    deviceLabel: 'fake_device_0',
    remote: { label: expect.stringMatching(/ laptop$/u), platform: expect.any(String) },
  });
  expect(remote?.remote?.label).toBe(session.host.label);
  expect(session.cameras.find((camera) => camera.label === 'laptop')).toMatchObject({
    local: true,
  });
  const clock = session.clock.cameras['laptop-2'];
  expect(clock.rttMs).toBeGreaterThanOrEqual(0);
  expect(Math.abs(clock.remote?.offsetMs ?? 99)).toBeLessThan(20);

  // Leave: the host's list is empty at once; the entry stays in the session.
  await phone.getByTestId('device-leave').click();
  await expect(state).toHaveAttribute('data-state', 'left');
  await expect(phone.getByTestId('device-problem')).toContainText('You left the session');
  await expect(row(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('remote-cameras-none')).toBeVisible();
  expect((await sessionJson(page, sessionId)).cameras.map((camera) => camera.label)).toEqual([
    'laptop',
    'laptop-2',
  ]);

  // Again, by the code typed (the link pasted into the field), and Remove from the host.
  await page.getByTestId('add-camera').click();
  await expect(pairing).toBeVisible({ timeout: 15_000 });
  const second = await pairingPath(page);
  expect(second).not.toBe(path);
  await phone.getByTestId('device-again').click();
  await expect(state).toHaveAttribute('data-state', 'idle');
  await phone.getByTestId('pairing-input').fill('this is not a code');
  await phone.getByTestId('pairing-join').click();
  await expect(phone.getByTestId('device-problem')).toContainText('That is not a code');
  await phone.getByTestId('pairing-input').fill(new URL(second, phone.url()).href);
  await phone.getByTestId('pairing-join').click();
  await expect(state).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
  await expect(row(page)).toHaveCount(1);
  await expect(row(page)).toHaveAttribute('data-state', 'connected');
  await page.getByTestId('remove-camera').click();
  await expect(row(page)).toHaveCount(0);
  await expect(state).toHaveAttribute('data-state', 'left', { timeout: 10_000 });
  await expect(phone.getByTestId('device-problem')).toContainText('The host removed this camera');

  // The diagnostics events of both devices went to the account.
  await expect
    .poll(
      async () =>
        (await fakeAccountState(page)).events
          .map((entry) => (entry.event as { kind: string }).kind)
          .filter((kind) => kind.startsWith('rtc.'))
          .sort(),
      { timeout: 20_000 },
    )
    .toEqual(
      expect.arrayContaining(['rtc.paired', 'rtc.connected', 'rtc.clock', 'rtc.disconnected']),
    );
  const events = (await fakeAccountState(page)).events.map(
    (entry) => entry.event as { kind: string; data: Record<string, unknown> },
  );
  // The choice of the pictures, both ways (T5.1), and the preview's caps as T4.3 set them.
  expect(
    events
      .filter(
        (event) => event.kind === 'settings.changed' && event.data['key'] === 'remotePictures',
      )
      .map((event) => event.data['value']),
  ).toEqual(['tiles', 'equal']);
  expect(events.find((event) => event.kind === 'preview.started')?.data).toMatchObject({
    scale: 5,
    maxKbps: 300,
    maxFps: 15,
  });
  await phone.close();
});
