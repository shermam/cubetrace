import type { SessionRecord } from '@cubetrace/core';
import { type Locator, type Page, expect, test } from '@playwright/test';

import { fakeAccount, fakeAccountState } from './helpers/account';
import { fakeSignaling } from './helpers/signaling';
import { currentSessionId, demoPath } from './helpers/timer';

// A remote camera (docs/PLAN.md T4.1, docs/RTC.md) with two pages of one browser: the host (the demo
// cube, Chrome's fake camera, signed in to the fake account) adds a camera in Camera settings and
// shows the QR code's URL; a second page opens it as the camera device (the same fake camera), pairs
// through the BroadcastChannel signaling (helpers/signaling.ts) and the real RTCPeerConnection on the
// loopback interface, and the host lists it with a thumbnail within 5 s; the clock sync converges
// (both pages read one browser's clock: the offset is near 0); the camera is in session.json with
// `remote`; Leave removes it. Then a second pairing by the code typed, and Remove from the host.
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

/** The offset of the sync line: "synced · round trip 1.2 ms · offset −0.3 ms · drift 0.0 ppm". */
function offsetOf(text: string): number {
  const match = /offset (−?)([\d,.]+) ms/u.exec(text);
  expect(match, text).not.toBeNull();
  return (match?.[1] === '−' ? -1 : 1) * Number(match?.[2].replace(/,/g, ''));
}

test('a second page joins as a remote camera: listed with a thumbnail, the sync converges, in session.json with remote, Leave removes it; the code typed, Remove', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await fakeAccount(page);
  await fakeSignaling(page);
  await page.goto(demoPath(0, SPEED));
  await expect.poll(() => currentSessionId(page), { timeout: 30_000 }).not.toBeNull();
  const sessionId = (await currentSessionId(page)) ?? '';
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();

  // The host's own camera on, and the Cameras section: Add camera loads it and publishes a pairing.
  const section = page.getByTestId('camera-section');
  await section.locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-toggle')).toHaveText('Turn off');
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
  await phone.goto(path);
  const state = phone.getByTestId('device-state');
  await expect(state).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
  await expect(phone.getByTestId('device-host')).toContainText('Linux laptop (Linux)');
  await expect(phone.getByTestId('device-preview')).toBeVisible();
  await expect(phone.getByTestId('device-picture-line')).toContainText('recording', {
    timeout: 15_000,
  });
  // The pairing is taken: the QR code is down and the camera is listed, with a thumbnail within 5 s.
  await expect(pairing).toHaveCount(0);
  await expect(row(page)).toHaveCount(1);
  await expect(row(page)).toHaveAttribute('data-state', 'connected');
  await expect(row(page).getByTestId('remote-camera-thumbnail')).toHaveAttribute('src', /^blob:/, {
    timeout: 5000,
  });
  await expect(row(page).getByTestId('remote-camera-name')).toHaveText('Linux laptop');
  // The host's own camera is `laptop`; the phone's, the same fake camera on another device, `laptop-2`.
  await expect(row(page).getByTestId('remote-camera-label')).toHaveText('laptop-2');
  await expect(row(page).getByTestId('remote-camera-report')).toContainText('recording', {
    timeout: 15_000,
  });

  // The clock sync converges: ten answers over ten seconds, within 3 ms of spread; both pages read
  // the same browser's clock, so the offset is near 0.
  await expect(row(page)).toHaveAttribute('data-converged', 'true', { timeout: 60_000 });
  const sync = (await row(page).getByTestId('remote-camera-sync').textContent()) ?? '';
  expect(sync).toMatch(/^synced · round trip [\d.]+ ms · offset /u);
  expect(Math.abs(offsetOf(sync))).toBeLessThan(20);
  await expect(phone.getByTestId('device-clock')).toHaveAttribute('data-converged', 'true');
  await expect(phone.getByTestId('device-clock')).toContainText('synced · round trip');

  // session.json: the camera with `remote`, and its clock fit once converged.
  await expect
    .poll(
      async () => (await sessionJson(page, sessionId)).clock.cameras['laptop-2']?.remote?.samples,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(10);
  const session = await sessionJson(page, sessionId);
  const remote = session.cameras.find((camera) => camera.label === 'laptop-2');
  expect(remote).toMatchObject({
    local: false,
    deviceLabel: 'fake_device_0',
    remote: { label: 'Linux laptop', platform: 'Linux' },
  });
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
  await phone.getByTestId('pairing-input').fill('not a code');
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
  await phone.close();
});
