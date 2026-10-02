import { USER_SCHEMA } from '@cubetrace/core';
import { type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import {
  type GoogleAccount,
  authAccount,
  firestoreDocument,
  useEmulators,
} from './helpers/emulators';

// The account (docs/PLAN.md T3.0) with the app's own Firebase SDK, against the emulators
// (npm run e2e:cloud): Sign in signs in a Google account of the Auth emulator, users/{uid} reaches the
// Firestore emulator through the project's rules as the app writes it, the account stays across a
// reload and its device is seen again, Sign out forgets it; and no request reaches Google's services.

const ADA: GoogleAccount = { sub: 'e2e-ada', email: 'ada@example.com', name: 'Ada Lovelace' };

const isUserRecord = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(USER_SCHEMA);

function banner(page: Page) {
  return page.getByRole('banner');
}

test('Sign in through the Auth emulator writes users/{uid} through the rules; the account stays across a reload and Sign out forgets it; nothing reaches Google’s services', async ({
  context,
  page,
}) => {
  const remote: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      remote.push(url.href);
    }
  });
  await useEmulators(page, ADA);
  await page.goto('/settings');
  const label = page.getByTestId('host-label');
  await label.fill('e2e-laptop');
  await label.blur();

  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  const account = banner(page).getByRole('button', { name: 'Account: Ada Lovelace' });
  await expect(account).toBeVisible({ timeout: 30_000 });
  await expect(account).toHaveAttribute('title', 'ada@example.com');
  await expect(
    page.getByRole('region', { name: 'Account' }).getByTestId('account-email'),
  ).toHaveText('ada@example.com');

  // users/{uid} as the rules let the app write it: the record, created when the Auth emulator says the
  // account was, to the second.
  const { uid, createdMs } = (await authAccount(ADA.email)) ?? { uid: '', createdMs: 0 };
  expect(uid).not.toBe('');
  await expect.poll(() => firestoreDocument(`users/${uid}`), { timeout: 15_000 }).not.toBeNull();
  const record = (await firestoreDocument(`users/${uid}`)) ?? {};
  expect(isUserRecord(record), JSON.stringify(isUserRecord.errors)).toBe(true);
  expect(record).toEqual({
    schema: 1,
    createdMs: Math.floor(createdMs / 1000) * 1000,
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    devices: { 'e2e-laptop': expect.any(Number) },
  });
  const firstSeen = (record['devices'] as Record<string, number>)['e2e-laptop'];

  // A remembered sign-in: the next start loads the account from IndexedDB and sees the device again.
  await page.reload();
  await expect(account).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        ((await firestoreDocument(`users/${uid}`))?.['devices'] as Record<string, number>)[
          'e2e-laptop'
        ],
      { timeout: 15_000 },
    )
    .toBeGreaterThan(firstSeen);

  await account.click();
  await banner(page).getByTestId('account-menu').getByRole('button', { name: 'Sign out' }).click();
  await expect(banner(page).getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cubetrace.account'))).toBeNull();
  await page.reload();
  await expect(banner(page).getByRole('button', { name: 'Sign in' })).toBeVisible();

  // The dev server and the emulators had every request, but for the image that Firestore's transport
  // loads from www.google.com to test the network after a connection error (its WebChannel's), which
  // reaches no service.
  expect(
    remote.filter((url) => !url.startsWith('https://www.google.com/images/cleardot.gif?')),
  ).toEqual([]);
});
