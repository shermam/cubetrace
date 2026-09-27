import { expect, test } from '@playwright/test';

import { demoPath, expectSolves } from './helpers/timer';

// The video quality (docs/PLAN.md, T2.10) with Chrome's fake camera at 30 fps and its fake
// microphone (the prompts answered "Allow"): High, chosen in Settings, records at 8 Mbps at
// 1920×1080 and 30 fps, which Camera settings say in the recording's counters; Standard, chosen
// there, starts the recording again at 4 Mbps and stays across a reload. The fake camera's test
// pattern takes about 1.2 Mbps whatever the encoder is allowed (docs/TOOLCHAIN.md), so the clips'
// sizes cannot tell the qualities apart here: the owner's round 2 weighs them on the MacBook
// (docs/MANUAL-TESTS.md, T2.10). Launch options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

test('High in Settings records at 8 Mbps; Standard in Camera settings at 4 Mbps, also after a reload', async ({
  page,
}) => {
  test.setTimeout(90_000);

  // Settings: Standard by default, each choice with its bitrate and size at 1920×1080, Best.
  await page.goto('/settings');
  const quality = page.getByLabel('Video quality', { exact: true });
  await expect(quality.locator('option')).toHaveText([
    'Standard (4 Mbps, ≈ 20 MB per attempt)',
    'High (8 Mbps, ≈ 40 MB per attempt)',
    'Maximum (12 Mbps, ≈ 60 MB per attempt)',
  ]);
  await expect(quality).toHaveValue('standard');
  await quality.selectOption('high');

  // A session to record for: one demo solve; then the Timer page without the demo cube, which
  // resumes the session, so that no attempt and no sync check begins while the recording restarts.
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  await page.goto('/');
  await page.getByTestId('camera-section').locator('summary').click();
  const panelQuality = page.getByTestId('camera-panel-video-quality');
  await expect(panelQuality).toHaveValue('high');
  await page.getByTestId('camera-toggle').click();
  const state = page.getByTestId('recording-state');
  await expect(state).toHaveAttribute('data-status', 'recording', { timeout: 15_000 });
  const codecs = page.getByTestId('recording-codecs');
  await expect(codecs).toHaveText(/^vp09\.00\.40\.08 at 8 Mbps, /);
  await expect(page.getByTestId('recording-estimate')).toHaveText(
    '≈ 40 MB per attempt at this quality',
  );

  // Standard, in Camera settings: the recording starts again, at 4 Mbps.
  await panelQuality.selectOption('standard');
  await expect(codecs).toHaveText(/^vp09\.00\.40\.08 at 4 Mbps, /, { timeout: 15_000 });
  await expect(state).toHaveAttribute('data-status', 'recording');
  await expect(page.getByTestId('recording-estimate')).toHaveText(
    '≈ 20 MB per attempt at this quality',
  );

  // A reload: the camera opens by itself and records at Standard, which Settings still says.
  await page.reload();
  await expect(panelQuality).toHaveValue('standard');
  await expect(state).toHaveAttribute('data-status', 'recording', { timeout: 15_000 });
  await expect(codecs).toHaveText(/^vp09\.00\.40\.08 at 4 Mbps, /);

  // On a phone 320 px wide the choices are cut short; the page does not scroll sideways.
  const overflow = (): Promise<number> =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.setViewportSize({ width: 320, height: 720 });
  await expect.poll(overflow).toBeLessThanOrEqual(0);
  await page.goto('/settings');
  await expect(quality).toHaveValue('standard');
  await expect.poll(overflow).toBeLessThanOrEqual(0);
});
