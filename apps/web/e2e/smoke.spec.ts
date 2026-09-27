import { expect, test } from '@playwright/test';

test('the app loads and shows its title', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/cubetrace/);
  await expect(page.getByRole('link', { name: 'cubetrace' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Timer' })).toBeVisible();
  // The Timer page calls @cubetrace/core, resolved from packages/core/src by the Angular build.
  await expect(page.getByTestId('core-version')).toHaveText(/^@cubetrace\/core \d+\.\d+\.\d+$/);
});

test('the top navigation reaches the four pages', async ({ page }) => {
  const pages = [
    { link: 'Sessions', path: '/sessions', heading: 'Sessions' },
    { link: 'Settings', path: '/settings', heading: 'Settings' },
    { link: 'Probe', path: '/probe', heading: 'Device probe' },
    { link: 'Timer', path: '/', heading: 'Timer' },
  ];
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });

  for (const { link, path, heading } of pages) {
    await nav.getByRole('link', { name: link }).click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(nav.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
  }
});
