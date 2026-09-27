import { expect, test } from '@playwright/test';

// Every page fits a phone in portrait and a laptop: nothing makes the page scroll sideways
// (docs/PLAN.md, T1.7). The banner about missing APIs is part of the check: headless Chromium
// on Linux has no Web Bluetooth, so it shows here.
const viewports = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const paths = ['/', '/sessions', '/settings', '/probe'];

for (const viewport of viewports) {
  test.describe(`at ${String(viewport.width)}×${String(viewport.height)}`, () => {
    test.use({ viewport });

    for (const path of paths) {
      test(`${path} has no horizontal overflow`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByTestId('app-version')).toBeVisible();

        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
      });
    }
  });
}
