import { CLOUD_CUBE_SCHEMA } from '@cubetrace/core';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import {
  type GoogleAccount,
  authAccount,
  firestoreDocument,
  useEmulators,
} from './helpers/emulators';
import { currentSessionId, demoPath, expectSolves } from './helpers/timer';

// Two devices of one account (T3.1, T3.4) with the app's own Firebase SDK, against the emulators
// (npm run e2e:cloud): two browser contexts that sign in the same Google account of the Auth emulator,
// the laptop and the phone. A cube's MAC address typed on the laptop and a session recorded there
// (marked as a real cube's) reach the Firestore emulator; the phone, signed in, lists the laptop's
// session as "cloud", opens it read-only, and has the address in Settings.

const LIN: GoogleAccount = { sub: 'e2e-lin', email: 'lin@example.com', name: 'Lin Qiao' };

const isCubeDocument = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(
  CLOUD_CUBE_SCHEMA,
);

/** A device of Lin's: a browser context of its own, pointed at the emulators. */
async function device(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await useEmulators(page, LIN);
  return page;
}

/** Settings, this device's label, then Sign in in the header; the cube list merged with Lin's. */
async function signIn(page: Page, label: string): Promise<void> {
  await page.goto('/settings');
  const hostLabel = page.getByTestId('host-label');
  await hostLabel.fill(label);
  await hostLabel.blur();
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account: Lin Qiao' }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('cube-macs-sync')).toHaveText(
    /^Synced with your account\. Last merged .+\.$/,
    { timeout: 15_000 },
  );
}

function macRows(page: Page) {
  return page.getByTestId('cube-macs').locator('li');
}

function sessionRow(page: Page, sessionId: string) {
  return page.locator(`[data-testid="session-row"][data-session="${sessionId}"]`);
}

test('a second device signed in to the account lists the first one’s session as "cloud" and knows the cube MAC address typed there', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const laptop = await device(browser, baseURL);
  const phone = await device(browser, baseURL);
  try {
    // The laptop: the address of a cube, typed in Settings, goes to the account.
    await signIn(laptop, 'e2e-laptop');
    const { uid } = (await authAccount(LIN.email)) ?? { uid: '' };
    expect(uid).not.toBe('');
    await laptop.locator('#mac-name').fill('GAN12ui_AB12');
    await laptop.locator('#mac-address').fill('ab-12-cd-34-ef-56');
    await laptop
      .getByRole('region', { name: 'Cube MAC addresses' })
      .getByRole('button', { name: 'Add' })
      .click();
    await expect(macRows(laptop)).toHaveText([/^GAN12ui_AB12\s*AB:12:CD:34:EF:56/]);
    await expect
      .poll(() => firestoreDocument(`users/${uid}/cubes/GAN12ui_AB12`), { timeout: 15_000 })
      .not.toBeNull();
    const cube = (await firestoreDocument(`users/${uid}/cubes/GAN12ui_AB12`)) ?? {};
    expect(isCubeDocument(cube), JSON.stringify(isCubeDocument.errors)).toBe(true);
    expect(cube).toMatchObject({
      name: 'GAN12ui_AB12',
      mac: 'AB:12:CD:34:EF:56',
      device: 'e2e-laptop',
    });

    // A session recorded on the laptop, marked as a real cube's: the next page load indexes it.
    await laptop.goto(demoPath(0, 20));
    await expectSolves(laptop, 1);
    const sessionId = (await currentSessionId(laptop)) ?? '';
    expect(sessionId).not.toBe('');
    await laptop.evaluate(async (id) => {
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
    await laptop.goto('/sessions');
    await expect(sessionRow(laptop, sessionId).getByTestId('session-place')).toHaveText('both', {
      timeout: 15_000,
    });
    await expect
      .poll(() => firestoreDocument(`sessions/${sessionId}/attempts/0001`), { timeout: 15_000 })
      .not.toBeNull();

    // The phone, signed in to the same account: the address is in its Settings at once.
    await signIn(phone, 'e2e-phone');
    expect((await authAccount(LIN.email))?.uid).toBe(uid);
    await expect(macRows(phone)).toHaveText([/^GAN12ui_AB12\s*AB:12:CD:34:EF:56/]);

    // Its Sessions page lists the laptop's session as "cloud", which opens read-only.
    await phone.goto('/sessions');
    const row = sessionRow(phone, sessionId);
    await expect(row.getByTestId('session-place')).toHaveText('cloud', { timeout: 15_000 });
    await expect(row).toContainText('e2e-laptop · GAN 12 ui FreePlay · 1 attempt');
    await expect(phone.getByTestId('device-filter').locator('option')).toContainText([
      'e2e-laptop',
    ]);
    await row.getByTestId('session-link').click();
    await expect(phone).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
    await expect(phone.getByTestId('session-cloud-note')).toContainText(
      'Recorded on e2e-laptop: this session is in your cloud index, not on this device.',
    );
    await expect(phone.getByTestId('solve-row')).toHaveCount(1);

    // The account's record knows both devices.
    await expect
      .poll(async () => {
        const devices = (await firestoreDocument(`users/${uid}`))?.['devices'] ?? {};
        return Object.keys(devices).sort();
      })
      .toEqual(['e2e-laptop', 'e2e-phone']);
  } finally {
    await laptop.context().close();
    await phone.context().close();
  }
});
