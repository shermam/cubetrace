import { USER_SCHEMA } from '@cubetrace/core';
import { type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import { ADA, fakeAccount, fakeAccountState } from './helpers/account';
import { demoPath, expectSolves } from './helpers/timer';

// The account (docs/PLAN.md, T3.0). On the dev server the app takes a fake of Firebase
// (helpers/account.ts), so that no test opens Google's page; on the production build, signed out,
// the app must never download Firebase, and its service worker must leave it out.

const isUserRecord = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(USER_SCHEMA);

function banner(page: Page) {
  return page.getByRole('banner');
}

function accountSection(page: Page) {
  return page.getByRole('region', { name: 'Account' });
}

async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
}

test.describe('on the dev server, with a fake of Firebase', () => {
  test('signed out, the timer works, Sign in is in the header and in Settings, and the account never loads', async ({
    page,
  }) => {
    await fakeAccount(page);
    await page.goto(demoPath(0, 20));
    await expectSolves(page, 1);
    await expect(banner(page).getByRole('button', { name: 'Sign in' })).toBeVisible();

    await openSettings(page);
    await expect(
      accountSection(page).getByRole('button', { name: 'Sign in with Google' }),
    ).toBeVisible();
    await expect(accountSection(page).getByTestId('account-hint')).toContainText(
      'Their files are uploaded as Uploads, below, says.',
    );
    expect((await fakeAccountState(page)).loads).toBe(0);
  });

  test('Sign in shows the account and writes users/{uid}; the account stays across a reload; Sign out forgets it', async ({
    page,
  }) => {
    await fakeAccount(page);
    await page.goto('/settings');
    const label = page.getByTestId('host-label');
    await label.fill('e2e-laptop');
    await label.blur();

    await banner(page).getByRole('button', { name: 'Sign in' }).click();
    const account = banner(page).getByRole('button', { name: 'Account: Ada Lovelace' });
    await expect(account).toBeVisible();
    await expect(account).toHaveAttribute('title', 'ada@example.com');
    await expect(accountSection(page).getByTestId('account-email')).toHaveText('ada@example.com');
    // The header's menu: the account, and Sign out.
    await account.click();
    const menu = banner(page).getByTestId('account-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('ada@example.com');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    const signedIn = await fakeAccountState(page);
    expect(signedIn.loads).toBe(1);
    expect(signedIn.calls).toEqual(['popup']);
    expect(signedIn.saved).toHaveLength(1);
    const { uid, record } = signedIn.saved[0];
    expect(uid).toBe(ADA.uid);
    expect(isUserRecord(record), JSON.stringify(isUserRecord.errors)).toBe(true);
    expect(record).toMatchObject({
      schema: 1,
      createdMs: ADA.createdMs,
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      devices: { 'e2e-laptop': expect.any(Number) },
    });
    expect(await page.evaluate(() => localStorage.getItem('cubetrace.account'))).toBe('signed-in');

    // A remembered sign-in: the account loads as the app starts, and the device is seen again.
    await page.reload();
    await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();
    const reloaded = await fakeAccountState(page);
    expect(reloaded.loads).toBe(2);
    expect(reloaded.saved).toHaveLength(2);

    await banner(page).getByRole('button', { name: 'Account: Ada Lovelace' }).click();
    await banner(page)
      .getByTestId('account-menu')
      .getByRole('button', { name: 'Sign out' })
      .click();
    await expect(banner(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(
      accountSection(page).getByRole('button', { name: 'Sign in with Google' }),
    ).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('cubetrace.account'))).toBeNull();

    // Signed out, the next start does not load the account.
    await page.reload();
    await expect(banner(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
    const signedOut = await fakeAccountState(page);
    expect(signedOut.loads).toBe(2);
    expect(signedOut.calls).toEqual(['popup', 'sign-out']);
  });

  test('a sign-in that fails says why, in Settings and on the header, and remembers nothing', async ({
    page,
  }) => {
    await fakeAccount(page, { popupError: 'auth/popup-closed-by-user' });
    await page.goto('/settings');

    await accountSection(page).getByRole('button', { name: 'Sign in with Google' }).click();
    const message = 'Signing in was cancelled: the Google window was closed first.';
    await expect(accountSection(page).getByRole('alert')).toHaveText(message);
    await expect(banner(page).getByRole('button', { name: 'Sign in' })).toHaveAttribute(
      'title',
      message,
    );
    expect(await page.evaluate(() => localStorage.getItem('cubetrace.account'))).toBeNull();
    expect((await fakeAccountState(page)).saved).toEqual([]);
  });
});

test.describe('the production build under /cubetrace/, signed out', () => {
  const pagesUrl = 'http://localhost:4300/cubetrace/';

  interface ServiceWorkerManifest {
    assetGroups: { name: string; installMode: string; urls: string[] }[];
  }

  test('never downloads Firebase: the timer works, nothing reaches Google, and the service worker installs without it', async ({
    context,
    page,
    request,
  }) => {
    const ngsw = (await (
      await request.get(`${pagesUrl}ngsw.json`)
    ).json()) as ServiceWorkerManifest;
    const shell = ngsw.assetGroups.find((group) => group.name === 'app')?.urls ?? [];
    const account = ngsw.assetGroups.find((group) => group.name === 'account');
    // The Firebase SDK is one lazy chunk, which the service worker caches only once it is used.
    expect(account?.installMode).toBe('lazy');
    expect(account?.urls).toEqual([
      expect.stringMatching(/^\/cubetrace\/firebase-sdk-[\w-]+\.js$/),
    ]);
    const firebaseChunks = account?.urls ?? [];
    expect(shell.filter((url) => firebaseChunks.includes(url))).toEqual([]);

    // Every request the page makes, whether the service worker answers it or not. The service
    // worker's own downloads (Playwright does not report them) all go into its caches, checked below.
    const requests: string[] = [];
    context.on('request', (r) => {
      requests.push(r.url());
    });
    await page.goto(`${pagesUrl}?demo=0&speed=20`);
    await expectSolves(page, 1);
    await expect(banner(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // The service worker downloads the whole shell after it starts; wait until it has.
    await expect
      .poll(() =>
        page.evaluate(async (urls) => {
          const cached = await Promise.all(urls.map((url) => caches.match(url)));
          return cached.every((response) => response !== undefined);
        }, shell),
      )
      .toBe(true);
    await openSettings(page);
    await expect(
      accountSection(page).getByRole('button', { name: 'Sign in with Google' }),
    ).toBeVisible();

    const cachedFirebase = await page.evaluate(
      async (urls) => Promise.all(urls.map(async (url) => (await caches.match(url)) !== undefined)),
      firebaseChunks,
    );
    expect(cachedFirebase).toEqual(firebaseChunks.map(() => false));
    const toFirebase = requests.filter(
      (url) =>
        /^https:\/\/([\w-]+\.)*(googleapis|firebaseapp|firebaseio|gstatic|google)\.com\//.test(
          url,
        ) || firebaseChunks.some((chunk) => url.endsWith(chunk)),
    );
    expect(toFirebase).toEqual([]);
    // The listener heard the page: its address and the demo solves it fetched.
    expect(requests).toEqual(
      expect.arrayContaining([`${pagesUrl}?demo=0&speed=20`, `${pagesUrl}demo/solves.json`]),
    );
  });
});
