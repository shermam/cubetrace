import { type Locator, type Page, expect, test } from '@playwright/test';

import { fakeAccount, fakeAccountState } from './helpers/account';
import {
  RECORDING,
  SYNTHETIC_CAMERA,
  driftCamera,
  pill,
  syntheticCamera,
  syntheticControls,
} from './helpers/remote';
import { fakeSignaling } from './helpers/signaling';
import { demoPath, expectSolves } from './helpers/timer';

// The phone's camera controls from the host (docs/PLAN.md T5.2, docs/RTC.md §11) with two pages of one
// browser, paired as remote-camera.spec.ts pairs them (the BroadcastChannel signaling, the real
// RTCPeerConnection on the loopback interface). The phone's page films the synthetic camera of T4.3,
// whose tracks have a focus as a phone's camera has (continuous or manual, a distance from 0.1 to
// 8.1 m), applied by `applyConstraints` and changed by the suite behind the app's back. The host,
// its own camera off, sets the phone's focus to manual and a distance from the phone's panel in its
// Cameras section, and the phone's own panel shows them; Reset to auto puts them back. A drift
// injected on the phone (its focus gone manual by itself): with "Keep the camera's modes" on, the
// phone sets it back within two readings and says so; off, it says so and leaves it, the host's
// Timer page says "focus went manual on the phone" in red under the phone's picture, and the Reset
// beside it sets the automatic focus again. Since T5.2a the camera reads a focus distance as the
// reciprocal of the one applied (the Moto g60's quirk, which the watchdog of T5.2 called a drift
// after every change): both panels show the distance set with the camera's reading beside it, no
// drift comes in 10 s, and the distance moving by itself is still caught and set back. Launch
// options force a browser of their own for this file (the encoding project, one at a time: the
// phone encodes).
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

/** The diagnostics events in the fake account, both pages', as kind and facts. */
async function events(page: Page): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  return (await fakeAccountState(page)).events.map(
    (entry) => entry.event as { kind: string; data: Record<string, unknown> },
  );
}

/** A slider of a controls panel held, moved to `position` (of 1000) and let go, as a hand does. */
async function slide(slider: Locator, position: number): Promise<void> {
  await slider.evaluate((input: HTMLInputElement, value) => {
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, position);
}

test("the phone's camera controls from the host: manual focus and a distance shown on the phone, Reset to auto; a drift set back on the phone, and one left shown on the host with Reset", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await fakeAccount(page);
  await fakeSignaling(page);
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();

  // The Cameras section, the host's own camera off: Add camera publishes a pairing.
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('add-camera').click();
  await expect(page.getByTestId('pairing')).toBeVisible({ timeout: 15_000 });
  const url = new URL((await page.getByTestId('pairing-url').textContent()) ?? '');

  // The phone: the synthetic camera, with its focus, which reads a distance as its reciprocal.
  const phone = await context.newPage();
  await syntheticCamera(phone, { reciprocalFocus: true });
  await fakeAccount(phone);
  await fakeSignaling(phone);
  await phone.goto(`${url.pathname}${url.search}`);
  await expect.poll(() => pill(phone), { timeout: 45_000 }).toBe('connected');
  await expect(phone.getByTestId('device-picture-line')).toContainText(RECORDING, {
    timeout: 15_000,
  });
  expect((await syntheticControls(phone))?.settings).toEqual(SYNTHETIC_CAMERA.focus.opening);

  // The host's panel of the phone's controls, under it in the Cameras list: its focus, automatic.
  const row = page.getByTestId('remote-camera');
  const controls = row.getByTestId('remote-camera-controls');
  await controls.locator('summary').click();
  const hostFocus = controls.getByTestId('control-focusMode');
  await expect(hostFocus).toHaveValue('continuous', { timeout: 15_000 });
  await expect(controls.locator('legend')).toHaveText(['Focus']);
  // The phone's own panel, in its Camera settings.
  await phone.getByTestId('device-camera-settings').locator('summary').click();
  const phoneFocus = phone.getByTestId('control-focusMode');
  await expect(phoneFocus).toHaveValue('continuous');

  // Manual focus from the host: applied on the phone, whose own panel shows it.
  await hostFocus.selectOption('manual');
  await expect(phoneFocus).toHaveValue('manual', { timeout: 10_000 });
  await expect(hostFocus).toHaveValue('manual');
  // A distance: the host's slider let go at 600 of 1000, 0.1 + 0.6 × 8 = 4.90 m, which the camera
  // reads as 1 / 4.9: both panels show the distance set, with the camera's reading beside it.
  await expect(controls.getByTestId('control-focusDistance')).toBeEnabled();
  await slide(controls.getByTestId('control-focusDistance'), 600);
  await expect(phone.getByTestId('control-focusDistance-value')).toHaveText('4.90', {
    timeout: 10_000,
  });
  await expect(phone.getByTestId('control-focusDistance-reported')).toHaveText(
    'the camera reports 0.20',
  );
  await expect(controls.getByTestId('control-focusDistance-value')).toHaveText('4.90');
  await expect(controls.getByTestId('control-focusDistance-reported')).toHaveText(
    'the camera reports 0.20',
    { timeout: 10_000 },
  );
  const manual = await syntheticControls(phone);
  expect(manual?.settings).toEqual({ focusMode: 'manual', focusDistance: 1 / 4.9 });
  const applied = [
    { advanced: [{ focusMode: 'manual' }] },
    { advanced: [{ focusMode: 'manual', focusDistance: 4.9 }] },
  ];
  expect(manual?.applied).toEqual(applied);

  // Held for 10 s, five readings of the phone's watchdog: no drift, nothing applied again (T5.2's
  // called it one after two readings and re-applied it three times before giving it up).
  await phone.waitForTimeout(10_000);
  await expect(phone.getByTestId('device-drift')).toHaveCount(0);
  await expect(page.getByTestId('remote-status-drift-focusDistance')).toHaveCount(0);
  expect((await syntheticControls(phone))?.applied).toEqual(applied);

  // The camera's distance moving by itself is a drift from its reading: set back with the 4.90 set.
  await driftCamera(phone, { focusDistance: 1 });
  await expect(phone.getByTestId('device-drift')).toHaveText(
    'The camera set the focus distance to 1.00 by itself: set back to 0.20.',
    { timeout: 10_000 },
  );
  const back = await syntheticControls(phone);
  expect(back?.settings).toEqual({ focusMode: 'manual', focusDistance: 1 / 4.9 });
  expect(back?.applied).toEqual([...applied, applied[1]]);

  // Reset to auto from the host: the phone's camera opened again, its focus automatic.
  await controls.getByTestId('camera-reset').click();
  await expect(phoneFocus).toHaveValue('continuous', { timeout: 15_000 });
  await expect(hostFocus).toHaveValue('continuous', { timeout: 10_000 });
  expect((await syntheticControls(phone))?.settings).toEqual(SYNTHETIC_CAMERA.focus.opening);

  // The focus goes manual by itself, Keep the camera's modes on (the default): the phone sets it
  // back within two readings (2 s apart) and says so.
  await driftCamera(phone, { focusMode: 'manual' });
  await expect(phone.getByTestId('device-drift')).toHaveText(
    'The camera set the focus to manual by itself: set back to continuous.',
    { timeout: 10_000 },
  );
  expect((await syntheticControls(phone))?.settings.focusMode).toBe('continuous');
  await expect(phoneFocus).toHaveValue('continuous');

  // Off, on the phone's own switch: said and left. The host's Timer page says it in red under the
  // phone's picture, and so does its Cameras list; the Reset beside the line sets the focus back.
  await phone.getByTestId('device-keep-camera-modes').uncheck();
  await driftCamera(phone, { focusMode: 'manual' });
  await expect(phone.getByTestId('device-drift')).toHaveText(
    "The camera set the focus to manual by itself: left so (Keep the camera's modes is off).",
    { timeout: 10_000 },
  );
  const drift = page.getByTestId('remote-status-drift-focusMode');
  await expect(drift).toHaveText('focus went manual on the phone', { timeout: 10_000 });
  await expect(drift).toHaveAttribute('data-tone', 'bad');
  await expect(row.getByTestId('remote-camera-report')).toContainText(
    'focus went manual on the phone',
  );
  // The phone took the mode the camera is in into its controls: the host's panel shows it.
  await expect(hostFocus).toHaveValue('manual', { timeout: 10_000 });
  await page.getByTestId('remote-drift-reset').click();
  await expect(drift).toHaveCount(0, { timeout: 10_000 });
  await expect(hostFocus).toHaveValue('continuous');
  expect((await syntheticControls(phone))?.settings.focusMode).toBe('continuous');
  await expect(phone.getByTestId('device-drift')).toHaveCount(0, { timeout: 10_000 });

  // The diagnostics: each change from the host and its outcome, each drift on the phone, the switch.
  await expect
    .poll(
      async () =>
        (await events(page))
          .filter((event) => event.kind === 'remote.controls')
          .map((event) => [event.data['set'], event.data['outcome']]),
      { timeout: 20_000 },
    )
    .toEqual([
      ['focusMode', 'ok'],
      ['focusDistance', 'ok'],
      ['reset', 'ok'],
      ['focusMode', 'ok'],
    ]);
  // The distance's (held to the camera's reading of it), then the focus's twice (to the mode it
  // opened in after Reset to auto); no other: the distance set from the host was none.
  await expect
    .poll(
      async () =>
        (await events(page))
          .filter((event) => event.kind === 'controls.drift')
          .map((event) => [
            event.data['reapplied'],
            event.data['keep'],
            event.data['role'],
            event.data['baseline'],
          ]),
      { timeout: 20_000 },
    )
    .toEqual([
      [true, true, 'camera-device', 'reading'],
      [true, true, 'camera-device', 'applied'],
      [false, false, 'camera-device', 'applied'],
    ]);
  const all = await events(page);
  expect(
    all.filter((event) => event.kind === 'controls.drift').map((event) => event.data['drift']),
  ).toEqual([
    { focusDistance: `${String(1 / 4.9)} → 1` },
    { focusMode: 'continuous → manual' },
    { focusMode: 'continuous → manual' },
  ]);
  expect(
    all.some(
      (event) =>
        event.kind === 'settings.changed' &&
        event.data['key'] === 'keepCameraModes' &&
        event.data['value'] === false,
    ),
  ).toBe(true);
  await phone.close();
});
