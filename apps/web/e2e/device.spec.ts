import { expect, test } from '@playwright/test';

// The wake lock and storage persistence against Chromium's real APIs, from the Settings page.

test('the Settings switch keeps the screen on, and the header shows it', async ({
  browser,
  context,
  page,
}) => {
  // Headless Chromium refuses the screen wake lock unless the permission is granted, which
  // Playwright has no name for: grant it to this test's browser context over CDP. The grant
  // lasts while the CDP session is attached.
  const pageSession = await context.newCDPSession(page);
  const { targetInfo } = await pageSession.send('Target.getTargetInfo');
  const browserSession = await browser.newBrowserCDPSession();
  await browserSession.send('Browser.grantPermissions', {
    permissions: ['wakeLockScreen'],
    browserContextId: targetInfo.browserContextId,
  });

  await page.goto('/settings');
  const status = page.getByTestId('wake-lock-status');
  const toggle = page.getByLabel('Keep the screen on');
  await expect(status).toHaveText('Screen may sleep');

  await toggle.check();
  await expect(status).toHaveText('Screen on');
  await expect(page.getByTestId('wake-lock-detail')).toHaveText(
    'The screen stays on while cubetrace is visible.',
  );

  await toggle.uncheck();
  await expect(status).toHaveText('Screen may sleep');
  await browserSession.detach();
});

test('Keep my data asks the browser to persist storage and shows its answer', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('storage-usage')).toHaveText(
    /Using \d+(\.\d)? [kMGT]?B of the \d+(\.\d)? [kMGT]?B this browser allows\./,
  );

  await page.getByRole('button', { name: 'Keep my data' }).click();

  // Chrome decides from how the site is used (a fresh test profile is usually refused);
  // either way the page must say what the browser answered.
  const persistence = page.getByTestId('storage-persistence');
  await expect(
    page.getByTestId('storage-refused').or(persistence.getByText(/Persistent:/)),
  ).toBeVisible();
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  await expect(persistence).toHaveText(persisted ? /Persistent:/ : /Best effort:/);
});
