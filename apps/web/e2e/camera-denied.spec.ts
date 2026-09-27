import { expect, test } from '@playwright/test';

// The Camera section when Chrome refuses the camera: the fake camera and a prompt answered "Block"
// (`--use-fake-ui-for-media-stream=deny`). Launch options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream=deny'],
  },
});

test('a denied camera permission is said in plain words', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-error')).toHaveText(
    /^The camera permission was denied: allow the camera for this site/,
  );
  await expect(page.getByTestId('camera-state')).toHaveText('Not working');
  await expect(page.getByTestId('camera-preview')).toHaveCount(0);
});
