import { type Locator, type Page, expect, test } from '@playwright/test';

import {
  currentSessionId,
  demoPath,
  expectSolves,
  replayDemo,
  solveRows,
  textOf,
} from './helpers/timer';

// The Timer page with the camera in view (docs/PLAN.md, T2.7), with Chrome's fake camera at 30 fps
// (the prompt answered "Allow") and the demo cube: the scramble, the time and the camera's preview
// fit the window together on a laptop (the preview beside the time) and on a phone (under it); the
// list shows the last 12 solves and "See all" opens the session's page, which lists them all.
// Recording is off in this file (the page has no MediaStreamTrackProcessor, so the app says it
// cannot record): it encodes no video beside recording.spec.ts and capture.spec.ts, which count the
// frames lost. Launch options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

const SPEED = 20;

/** Attempts of the flow on a laptop: more than the 12 the Timer page lists. */
const ATTEMPTS = 15;

async function withoutRecording(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'MediaStreamTrackProcessor');
  });
}

/** Opens Camera settings (closed until they are first opened) and turns the camera on. */
async function turnCameraOn(page: Page): Promise<void> {
  const settings = page.getByTestId('camera-section');
  await settings.locator('summary').click();
  await expect(settings).toHaveAttribute('open', '');
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  await expect(page.getByTestId('camera-status-fps')).toHaveText(/^\d+\.\d fps$/, {
    timeout: 10_000,
  });
  await expect(page.getByTestId('camera-status-recording')).toHaveText('stopped');
  // Back to the top, as the page loads.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
}

/** The box of `locator`, which must be wholly inside the viewport. */
async function inView(page: Page, locator: Locator, what: string) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) {
    throw new Error(`${what}: not on the page.`);
  }
  const where = `${what}: ${JSON.stringify(box)} in ${JSON.stringify(viewport)}`;
  expect(box.x, where).toBeGreaterThanOrEqual(0);
  expect(box.y, where).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, where).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, where).toBeLessThanOrEqual(viewport.height);
  return box;
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test.describe('on a laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the scramble, the time and the preview are in view together; the last 12 solves, and all 15 on the session page', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await withoutRecording(page);
    await page.goto(demoPath(0, SPEED));
    await expectSolves(page, 1);
    await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
      timeout: 30_000,
    });
    for (let count = 2; count <= ATTEMPTS; count++) {
      await replayDemo(page);
      await expect(page.getByTestId('stat-count')).toHaveText(String(count), { timeout: 30_000 });
    }
    await expect(page.getByTestId('save-status')).toHaveText('Saved');

    // The last 12, newest first, and how many there are.
    await expect(solveRows(page)).toHaveCount(12);
    await expect(solveRows(page).first()).toHaveAttribute('data-index', String(ATTEMPTS));
    await expect(solveRows(page).last()).toHaveAttribute('data-index', String(ATTEMPTS - 11));
    await expect(page.getByTestId('solve-list-footer')).toHaveText(
      `${String(ATTEMPTS)} solves in this session · See all`,
    );
    const ao12 = await textOf(page, 'stat-ao12');
    expect(ao12).toMatch(/^\d+\.\d\d$/);

    // The camera on: the scramble, the time and the preview in view, the preview beside the time.
    await turnCameraOn(page);
    await inView(page, page.getByTestId('scramble'), 'the scramble');
    await inView(page, page.getByTestId('timer'), 'the time');
    const clock = await inView(page, page.getByRole('region', { name: 'Time' }), 'the clock');
    const preview = await inView(page, page.getByTestId('camera-preview'), 'the preview');
    expect(preview.x).toBeGreaterThanOrEqual(clock.x + clock.width);
    expect(Math.abs(preview.y - clock.y)).toBeLessThan(2);
    // About 240 px high, 16:9.
    expect(preview.height).toBeGreaterThan(230);
    expect(preview.height).toBeLessThanOrEqual(241);
    expect(preview.width / preview.height).toBeCloseTo(16 / 9, 1);
    await noHorizontalOverflow(page);

    // "See all": the session's page, with every attempt and the same ao12; also after a reload.
    const id = (await currentSessionId(page)) ?? '';
    await page.getByTestId('solve-list-all').click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Session');
    await expect(solveRows(page)).toHaveCount(ATTEMPTS);
    await expect(page.getByTestId('stat-count')).toHaveText(String(ATTEMPTS));
    await expect(page.getByTestId('stat-ao12')).toHaveText(ao12);
    await expect(page.getByTestId('session-current')).toBeVisible();
    await page.reload();
    await expect(solveRows(page)).toHaveCount(ATTEMPTS);
    await expect(page.getByTestId('stat-ao12')).toHaveText(ao12);

    // The Sessions page links to it.
    await page.getByRole('link', { name: 'Sessions', exact: true }).first().click();
    await expect(page.getByTestId('session-link')).toHaveCount(1);
    await page.getByTestId('session-link').click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
    await expect(solveRows(page)).toHaveCount(ATTEMPTS);
  });
});

test.describe('on a phone in portrait', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the preview under the time, the three in view together, nothing wider than the screen', async ({
    page,
  }) => {
    await withoutRecording(page);
    await page.goto(demoPath(0, SPEED));
    await expectSolves(page, 1);
    // Chrome on the phone has Web Bluetooth: the banner that this browser shows is not there.
    await page.getByTestId('support-banner').getByRole('button', { name: 'Dismiss' }).click();
    await turnCameraOn(page);

    await inView(page, page.getByTestId('scramble'), 'the scramble');
    await inView(page, page.getByTestId('timer'), 'the time');
    const clock = await inView(page, page.getByRole('region', { name: 'Time' }), 'the clock');
    const preview = await inView(page, page.getByTestId('camera-preview'), 'the preview');
    expect(preview.y).toBeGreaterThanOrEqual(clock.y + clock.height);
    // Full width: the page's, less its gutters.
    expect(preview.width).toBeGreaterThan(350);
    await noHorizontalOverflow(page);

    // The narrowest phones.
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(page.getByTestId('camera-preview')).toBeVisible();
    await noHorizontalOverflow(page);
  });
});
