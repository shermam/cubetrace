import { type Page, expect, test } from '@playwright/test';
import type { MicrophoneInfo } from '@cubetrace/core';

import { exportSession } from './helpers/export';
import { demoPath, expectSolves } from './helpers/timer';

// The microphone (docs/PLAN.md, T2.12) with Chrome's fake camera at 30 fps and its fake microphone
// (the prompts answered "Allow"): Raw by default, the recording asks for the browser's voice
// processing off, and the session keeps what the browser says it applied (the microphone track's
// getSettings()); Voice, chosen in Camera settings, starts the recording again with the browser's
// defaults, and stays across a reload. Chromium's fake microphone reports every processing as asked
// for: off raw (at 44.1 kHz and two channels, its own format, which the ideals of one channel at
// 48 kHz do not change), on with the defaults (48 kHz, one channel). It starts the encoder, hence
// the `encoding` project. Launch options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

/** The session's camera's microphone, from the Sessions page's export; back to the Timer page. */
async function exportedMicrophone(page: Page): Promise<MicrophoneInfo | null> {
  const exported = await exportSession(page);
  expect(exported.session.cameras).toHaveLength(1);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Timer' }).click();
  return exported.session.cameras[0].microphone;
}

test('the microphone is recorded raw by default, as the session says; Voice restarts the recording and stays across a reload', async ({
  page,
}) => {
  test.setTimeout(90_000);

  // Settings: Raw by default, with its line of help.
  await page.goto('/settings');
  const setting = page.getByLabel('Microphone', { exact: true });
  await expect(setting.locator('option')).toHaveText(['Raw', 'Voice']);
  await expect(setting).toHaveValue('raw');
  await expect(page.getByTestId('microphone-hint')).toContainText(
    "Raw keeps the cube's clicks; Voice lets the browser suppress noise for speech.",
  );

  // A session to record for: one demo solve; then the Timer page without the demo cube, which
  // resumes the session, so that no attempt and no sync check begins while the recording restarts.
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  await page.goto('/');
  await page.getByTestId('camera-section').locator('summary').click();
  const choice = page.getByTestId('camera-panel-microphone');
  await expect(choice).toHaveValue('raw');
  await expect(page.getByTestId('camera-panel-microphone-hint')).toHaveText(
    "Raw keeps the cube's clicks; Voice lets the browser suppress noise for speech.",
  );
  await page.getByTestId('camera-toggle').click();
  const state = page.getByTestId('recording-state');
  await expect(state).toHaveAttribute('data-status', 'recording', { timeout: 15_000 });
  const codecs = page.getByTestId('recording-codecs');
  await expect(codecs).toHaveText(/^vp09\.00\.40\.08 at 4 Mbps, opus, mic raw$/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('recording-notice')).toHaveCount(0);

  // What the browser applied, in the session's camera entry: every processing off, as asked.
  const raw = await exportedMicrophone(page);
  expect(raw).toMatchObject({
    label: 'Fake Default Audio Input',
    processing: 'raw',
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
  });
  expect(raw?.sampleRate).toBeGreaterThan(0);
  expect(raw?.channelCount).toBeGreaterThanOrEqual(1);

  // Voice, in Camera settings: the recording starts again with the browser's defaults.
  await expect(state).toHaveAttribute('data-status', 'recording', { timeout: 15_000 });
  await choice.selectOption('voice');
  await expect(codecs).toHaveText(/^vp09\.00\.40\.08 at 4 Mbps, opus, mic voice$/, {
    timeout: 15_000,
  });
  const voice = await exportedMicrophone(page);
  expect(voice).toMatchObject({
    label: 'Fake Default Audio Input',
    processing: 'voice',
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  expect(voice?.sampleRate).toBeGreaterThan(0);
  console.log(`microphone: ${JSON.stringify({ raw, voice })}`);

  // A reload: Voice still, in Camera settings and in Settings, and the recording says so.
  await page.reload();
  await expect(choice).toHaveValue('voice');
  await expect(state).toHaveAttribute('data-status', 'recording', { timeout: 15_000 });
  await expect(codecs).toHaveText(/, mic voice$/, { timeout: 15_000 });
  await page.goto('/settings');
  await expect(setting).toHaveValue('voice');
});
