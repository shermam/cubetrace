import { type Locator, type Page, expect, test } from '@playwright/test';

// The Camera section of the Timer page (docs/PLAN.md, T2.1) with Chrome's fake camera: a green test
// pattern with a moving disc at 20 fps ("fake_device_0"), which has manual exposure and focus, and
// an automatic "Allow" on the camera prompt. Launch options force a browser of their own for this
// file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

/** The framing rectangle as the panel writes it: x, y, width and height in frame pixels. */
async function framing(page: Page): Promise<number[]> {
  const text = (await page.getByTestId('camera-framing-rect').textContent()) ?? '';
  const numbers = /^(\d+), (\d+), (\d+)×(\d+)$/.exec(text.trim());
  expect(numbers, `framing "${text}"`).not.toBeNull();
  return (numbers ?? []).slice(1).map(Number);
}

/** How many times the sharpness meter has measured. */
async function samples(meter: Locator): Promise<number> {
  return Number(await meter.getAttribute('data-samples'));
}

/** Drags with the mouse from (x, y) by (dx, dy), in steps, as a person does. */
async function drag(page: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test('the fake camera: listed, turned on, measured, adjusted and framed; the framing survives a reload; off stays off', async ({
  page,
}) => {
  await page.goto('/');
  const section = page.getByTestId('camera-section');
  await section.locator('summary').click();
  await expect(page.getByTestId('camera-state')).toHaveText('Off');
  await expect(page.getByTestId('camera-device').locator('option')).toHaveText(['fake_device_0']);

  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-toggle')).toHaveText('Turn off');
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  await expect(page.getByTestId('camera-track')).toHaveText('1920×1080 at 20 fps');
  // Measured over a second of the camera's own clock.
  const measured = page.getByTestId('camera-measured');
  await expect(measured).toHaveText(/^\d+\.\d fps, frames 1920×1080$/, { timeout: 10_000 });
  const fps = Number.parseFloat((await measured.textContent()) ?? '');
  expect(fps).toBeGreaterThan(15);
  expect(fps).toBeLessThan(25);
  await expect(page.getByTestId('camera-state')).toHaveText(/^1920×1080 · \d+\.\d fps$/);

  // The meter measures every 10th frame (twice a second at 20 fps); the pattern is sharp.
  const meter = page.getByTestId('camera-sharpness');
  await expect.poll(() => samples(meter), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const before = await samples(meter);
  await expect.poll(() => samples(meter), { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId('camera-sharpness-verdict')).toHaveText('good');
  expect(Number(await page.getByTestId('camera-sharpness-value').textContent())).toBeGreaterThan(
    20,
  );

  // The fake camera has manual exposure and focus, and nothing else.
  await expect(section.locator('legend')).toHaveText(['Exposure', 'Focus']);
  await expect(page.getByTestId('control-exposureTime-value')).toHaveText('5.0 ms (1/200 s)');
  await page.getByTestId('control-exposureTime').fill('1000');
  await expect(page.getByTestId('control-exposureTime-value')).toHaveText('10 ms (1/100 s)');
  await expect(page.getByTestId('camera-track')).toHaveText('1920×1080 at 20 fps');
  await page.getByTestId('camera-reset').click();
  await expect(page.getByTestId('control-exposureTime-value')).toHaveText('5.0 ms (1/200 s)');
  await expect(page.getByTestId('camera-state')).toHaveText(/^1920×1080/, { timeout: 10_000 });

  // The framing rectangle: the full frame, then resized from its bottom-right corner and moved.
  const text = page.getByTestId('camera-framing-rect');
  await expect(text).toHaveText('full frame, 1920×1080');
  const preview = page.getByTestId('camera-frame');
  await preview.scrollIntoViewIfNeeded();
  const box = await preview.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  await drag(page, box.x + box.width - 4, box.y + box.height - 4, -box.width / 4, -box.height / 4);
  await expect(text).toHaveText(/^0, 0, \d+×\d+$/);
  const resized = await framing(page);
  expect(resized[2]).toBeGreaterThan(1300);
  expect(resized[2]).toBeLessThan(1580);
  expect(resized[3]).toBeGreaterThan(700);
  expect(resized[3]).toBeLessThan(900);
  await drag(page, box.x + box.width / 3, box.y + box.height / 3, box.width / 8, box.height / 8);
  await expect(text).not.toHaveText(/^0, 0, /);
  const moved = await framing(page);
  expect(moved[0]).toBeGreaterThan(150);
  expect(moved[1]).toBeGreaterThan(80);
  expect(moved.slice(2)).toEqual(resized.slice(2));

  // A reload: the camera turns on by itself, the section open, the rectangle where it was left.
  await page.reload();
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  await expect(page.getByTestId('camera-section')).toHaveAttribute('open', '');
  expect(await framing(page)).toEqual(moved);

  // Off stays off across a reload; on again, the same rectangle.
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-state')).toHaveText('Off');
  await expect(page.getByTestId('camera-preview')).toHaveCount(0);
  await page.reload();
  await page.getByTestId('camera-section').locator('summary').click();
  await expect(page.getByTestId('camera-state')).toHaveText('Off');
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  expect(await framing(page)).toEqual(moved);
});

test('exactly 60 fps from Settings: the 20 fps fake camera opens at its best rate and says so', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByLabel('Frame rate', { exact: true }).selectOption('60');
  await page.getByLabel('Resolution', { exact: true }).selectOption('720p');

  await page.getByRole('link', { name: 'Timer' }).click();
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-notice')).toHaveText(
    'This camera has no mode at exactly 60 fps at 1280×720: it opened at its best rate.',
  );
  await expect(page.getByTestId('camera-track')).toHaveText('1280×720 at 20 fps');
});

test.describe('on a phone in portrait', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the Camera section, on, fits the screen without scrolling sideways', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('camera-section').locator('summary').click();
    await page.getByTestId('camera-toggle').click();
    await expect(page.getByTestId('camera-measured')).toHaveText(/fps, frames 1920×1080$/, {
      timeout: 10_000,
    });
    await expect(page.getByTestId('camera-reset')).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});
