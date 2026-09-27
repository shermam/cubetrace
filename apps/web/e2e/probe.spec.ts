import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Chrome's fake camera (a moving test pattern, "fake_device_0") and an automatic "Allow" on
// the camera prompt. Launch options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

const REPORT_KEYS = [
  'generatedAt',
  'label',
  'device',
  'camera',
  'capabilities',
  'settings',
  'timing',
  'encoders',
  'worker',
  'storage',
  'bluetooth',
  'hints',
];

/** `value[key]` of a parsed JSON object, failing the test when it is not an object. */
function field(value: unknown, key: string): unknown {
  expect(value).toEqual(expect.any(Object));
  return (value as Record<string, unknown>)[key];
}

test('the probe measures the fake camera and downloads a report with every section', async ({
  page,
}) => {
  // A 2 s measurement window instead of 10 s.
  await page.goto('/probe?seconds=2');
  await expect(page.getByRole('heading', { level: 1, name: 'Device probe' })).toBeVisible();

  await page.getByLabel('Device label').fill('CI fake camera');
  await page.getByRole('button', { name: 'Allow camera' }).click();
  const camera = page.getByLabel('Camera', { exact: true });
  await expect(camera.locator('option')).toHaveText(['fake_device_0']);

  await page.getByRole('button', { name: 'Run probe' }).click();
  await expect(page.getByTestId('probe-status')).toHaveText(/^Done/, { timeout: 30_000 });
  for (const heading of ['Device', 'Camera', 'Frame timing', 'H.264 encoders', 'Bluetooth']) {
    await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible();
  }

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^probe-ci-fake-camera-\d{4}-\d{2}-\d{2}\.json$/);
  const report: unknown = JSON.parse(await readFile(await download.path(), 'utf8'));

  expect(Object.keys(report as object)).toEqual(REPORT_KEYS);
  expect(field(report, 'label')).toBe('CI fake camera');
  expect(Date.parse(field(report, 'generatedAt') as string)).not.toBeNaN();

  const cameraSection = field(report, 'camera');
  expect(field(field(cameraSection, 'selected'), 'label')).toBe('fake_device_0');
  expect(field(cameraSection, 'failedAttempts')).toEqual([]);
  // The fake camera offers 1920x1080, so the first rung of the ladder gets it.
  expect(field(report, 'settings')).toMatchObject({ width: 1920, height: 1080 });
  expect(field(report, 'capabilities')).toMatchObject({ width: expect.any(Object) });

  const timing = field(report, 'timing');
  expect(field(timing, 'windowMs')).toBe(2000);
  expect(field(timing, 'completed')).toBe(true);
  expect(field(timing, 'achievedFps')).toBeGreaterThan(0);
  expect(field(timing, 'frames')).toBeGreaterThanOrEqual(2);
  expect(field(timing, 'frameSizes')).toEqual(['1920x1080']);
  for (const series of ['intervalMs', 'mediaTimeDeltaMs', 'captureMinusNowMs']) {
    const summary = field(timing, series);
    expect(field(summary, 'count')).toBeGreaterThan(0);
    expect(field(summary, 'p50')).toEqual(expect.any(Number));
  }
  // A frame reaches Chrome before the callback that reports it runs.
  expect(field(field(timing, 'captureMinusNowMs'), 'p50')).toBeLessThanOrEqual(0);

  const results = field(field(report, 'encoders'), 'results');
  expect(Array.isArray(results)).toBe(true);
  expect((results as unknown[]).length).toBeGreaterThanOrEqual(1);
  for (const result of results as unknown[]) {
    expect(field(result, 'supported')).toEqual(expect.any(Boolean));
  }

  const worker = field(report, 'worker');
  for (const where of ['inWorker', 'onMainThread']) {
    expect(field(worker, where)).toEqual({
      MediaStreamTrackProcessor: expect.any(Boolean),
      VideoEncoder: expect.any(Boolean),
    });
  }
  expect(field(field(field(report, 'storage'), 'estimate'), 'quota')).toBeGreaterThan(0);
  expect(field(field(report, 'storage'), 'persisted')).toEqual(expect.any(Boolean));
  expect(field(field(report, 'bluetooth'), 'navigatorBluetooth')).toEqual(expect.any(Boolean));
  expect(field(field(report, 'hints'), 'userAgent')).toContain('Chrome');
  expect(field(field(field(report, 'hints'), 'userAgentData'), 'bitness')).toEqual(
    expect.any(String),
  );
  expect(field(field(report, 'device'), 'devicePixelRatio')).toBeGreaterThan(0);

  // The JSON shown on the page is the downloaded report.
  expect(JSON.parse((await page.getByTestId('report-json').textContent()) ?? '')).toEqual(report);
});
