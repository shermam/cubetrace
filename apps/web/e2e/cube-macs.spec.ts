import { CLOUD_CUBE_SCHEMA } from '@cubetrace/core';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import { ADA, type FakeCloud, fakeAccount, fakeAccountState, fakeCloud } from './helpers/account';
import { exportSession } from './helpers/export';
import { demoPath, expectSolves } from './helpers/timer';

// The cubes' MAC addresses synced per account (docs/PLAN.md T3.4, issue #21) on the dev server, with
// the fake of Firebase (helpers/account.ts): two browser contexts signed in to one account through a
// cloud they share are two devices of that account, the laptop and the phone. A MAC address typed on
// one is on the other after a reload; a removal follows the same way; and no export holds one.

const isCubeDocument = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(
  CLOUD_CUBE_SCHEMA,
);

/** A MAC address in any usual form: six hex bytes with colons or dashes between them. */
const MAC_LIKE = /\b[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}\b/i;

/** A device of Ada's: a browser context of its own, signed in through the shared `cloud`. */
async function device(browser: Browser, baseURL: string | undefined, cloud: FakeCloud) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await fakeAccount(page, { cloud });
  return page;
}

function macSection(page: Page) {
  return page.getByRole('region', { name: 'Cube MAC addresses' });
}

function macRows(page: Page) {
  return page.getByTestId('cube-macs').locator('li');
}

/** Settings, this device's label, then Sign in in the header; the cube list merged with Ada's. */
async function signIn(page: Page, label: string): Promise<void> {
  await page.goto('/settings');
  const hostLabel = page.getByTestId('host-label');
  await hostLabel.fill(label);
  await hostLabel.blur();
  await expect(page.getByTestId('cube-macs-sync')).toHaveCount(0);
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account: Ada Lovelace' }),
  ).toBeVisible();
  await expect(page.getByTestId('cube-macs-sync')).toHaveText(
    /^Synced with your account\. Last merged .+\.$/,
  );
}

async function addMac(page: Page, name: string, mac: string): Promise<void> {
  await page.locator('#mac-name').fill(name);
  await page.locator('#mac-address').fill(mac);
  await macSection(page).getByRole('button', { name: 'Add' }).click();
}

test('a MAC address typed on one device appears on another of the account after a reload, and a removal follows', async ({
  browser,
  baseURL,
}) => {
  const cloud = fakeCloud();
  const laptop = await device(browser, baseURL, cloud);
  const phone = await device(browser, baseURL, cloud);
  try {
    await signIn(laptop, 'e2e-laptop');
    await expect(macRows(laptop)).toHaveText(['None stored.']);

    // On the phone, the address of the cube that Chrome cannot read there.
    await signIn(phone, 'e2e-phone');
    await addMac(phone, 'GAN12ui_AB12', 'ab-12-cd-34-ef-56');
    await expect(macRows(phone)).toHaveText([/^GAN12ui_AB12\s*AB:12:CD:34:EF:56/]);
    await expect.poll(() => cloud.cubeWrites).toEqual([`users/${ADA.uid}/cubes/GAN12ui_AB12`]);
    const written = cloud.cubes[ADA.uid]['GAN12ui_AB12'];
    expect(isCubeDocument(written), JSON.stringify(isCubeDocument.errors)).toBe(true);
    expect(written).toMatchObject({
      schema: 1,
      name: 'GAN12ui_AB12',
      mac: 'AB:12:CD:34:EF:56',
      device: 'e2e-phone',
    });

    // The laptop still shows its list as it loaded; reloaded, the phone's address is in it.
    await expect(macRows(laptop)).toHaveText(['None stored.']);
    await laptop.reload();
    await expect(macRows(laptop)).toHaveText([/^GAN12ui_AB12\s*AB:12:CD:34:EF:56/]);
    await expect(laptop.getByTestId('cube-macs-sync')).toContainText('Synced with your account.');

    // Removed on the laptop: gone from the account, and from the phone at its next start.
    await macSection(laptop).getByRole('button', { name: 'Remove GAN12ui_AB12' }).click();
    await expect(macRows(laptop)).toHaveText(['None stored.']);
    await expect.poll(() => Object.keys(cloud.cubes[ADA.uid])).toEqual([]);
    await phone.reload();
    await expect(macRows(phone)).toHaveText(['None stored.']);
    expect(cloud.cubeWrites).toEqual([
      `users/${ADA.uid}/cubes/GAN12ui_AB12`,
      `delete users/${ADA.uid}/cubes/GAN12ui_AB12`,
    ]);
    await expect(phone.getByTestId('cube-macs-sync-error')).toHaveCount(0);
    await expect(laptop.getByTestId('cube-macs-sync-error')).toHaveCount(0);
  } finally {
    await laptop.context().close();
    await phone.context().close();
  }
});

test("a session's export holds no MAC address, with the cube list kept and synced", async ({
  page,
}) => {
  await fakeAccount(page);
  await signIn(page, 'e2e-laptop');
  await addMac(page, 'GAN12ui_AB12', 'AB:12:CD:34:EF:56');
  await expect(macRows(page)).toHaveText([/^GAN12ui_AB12\s*AB:12:CD:34:EF:56/]);
  await expect
    .poll(async () => (await fakeAccountState(page)).cubeWrites)
    .toEqual([`users/${ADA.uid}/cubes/GAN12ui_AB12`]);

  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  const exported = await exportSession(page);
  const text = JSON.stringify(exported);
  expect(text).not.toMatch(MAC_LIKE);
  expect(text.toUpperCase()).not.toContain('AB12CD34EF56');
  // The pattern has teeth: the account's copy of the list matches it.
  expect(JSON.stringify((await fakeAccountState(page)).cubes)).toMatch(MAC_LIKE);
});
