import { type Page, expect, test } from '@playwright/test';

import { expectSolves, solveRows } from './helpers/timer';

// The Timer page's first render waits for neither the camera nor the solve list (docs/PLAN.md, T2.7
// and T2.6): the camera's preview and settings are chunks of their own that load once the page has
// rendered, and the session's solves are read from the origin private file system afterwards. On the
// production build served like GitHub Pages (playwright.config.ts), in a session with a stored solve,
// the time from DOMContentLoaded to the first frame that shows the clock, with the camera setting off
// and on; then, with the camera and the storage each held back 3 s, the clock comes as soon, and the
// preview and the solve list after them. Recording is off in this file (the page has no
// MediaStreamTrackProcessor, so the app says it cannot record): it encodes no video beside
// recording.spec.ts and capture.spec.ts, which count the frames lost. Launch options force a browser
// of their own for this file.
test.use({
  baseURL: 'http://localhost:4300/cubetrace/',
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

/** The most the clock may take to be on screen after DOMContentLoaded. */
const LIMIT_MS = 2000;

/** How long the held-back camera and storage take to answer. */
const HELD_MS = 3000;

/** When the Timer page first showed each of its parts on this page load, in ms after DOMContentLoaded. */
interface FirstRender {
  readonly clockMs: number;
  readonly listMs: number;
  readonly previewMs: number | null;
}

const KEY = '__cubetraceFirstRender';

/**
 * On every page load from now on, records the first animation frame at which the clock (the time,
 * with its text), the first row of the solve list and the camera's preview are on the page with a
 * size, on the clock of `performance.now()`.
 */
async function stampFirstRender(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    Reflect.deleteProperty(window, 'MediaStreamTrackProcessor');
    const stamps: Record<string, number> = {};
    Reflect.set(window, key, stamps);
    const parts: Record<string, string> = {
      clock: '[data-testid="timer"]',
      list: '[data-testid="solve-row"]',
      preview: '[data-testid="camera-preview"]',
    };
    const frame = (at: number): void => {
      for (const [name, selector] of Object.entries(parts)) {
        const element = name in stamps ? null : document.querySelector(selector);
        const box = element?.getBoundingClientRect();
        const text = name === 'clock' ? (element?.textContent.trim() ?? '') : '-';
        if (box !== undefined && box.width > 0 && box.height > 0 && text !== '') {
          stamps[name] = at;
        }
      }
      if (Object.keys(stamps).length < Object.keys(parts).length && at < 30_000) {
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
  }, KEY);
}

/** Holds back, on every page load from now on, the camera and the origin private file system. */
async function holdBack(page: Page): Promise<void> {
  await page.addInitScript((ms: number) => {
    const later = <T>(answer: () => Promise<T>): Promise<T> =>
      new Promise((resolve) => setTimeout(resolve, ms)).then(answer);
    const media = navigator.mediaDevices;
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => later(() => getUserMedia(constraints));
    const storage = navigator.storage;
    const getDirectory = storage.getDirectory.bind(storage);
    storage.getDirectory = () => later(getDirectory);
  }, HELD_MS);
}

/** Loads the Timer page and reads when its parts were first on screen. */
async function loadTimer(page: Page, camera: boolean): Promise<FirstRender> {
  await page.goto('./');
  await expect(solveRows(page)).toHaveCount(1, { timeout: 15_000 });
  if (camera) {
    await expect(page.getByTestId('camera-preview')).toBeVisible({ timeout: 15_000 });
  }
  const { dcl, stamps } = await page.evaluate(async (key) => {
    // The frame after the last part appeared has stamped it.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const [navigation] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[];
    return {
      dcl: navigation.domContentLoadedEventStart,
      stamps: Reflect.get(window, key) as Partial<Record<string, number>>,
    };
  }, KEY);
  const since = (at: number | undefined): number | null =>
    at === undefined ? null : Math.round((at - dcl) * 10) / 10;
  const clockMs = since(stamps['clock']);
  const listMs = since(stamps['list']);
  if (clockMs === null || listMs === null) {
    throw new Error(`The clock or the list was never stamped: ${JSON.stringify({ dcl, stamps })}`);
  }
  return { clockMs, listMs, previewMs: since(stamps['preview']) };
}

test('the clock is on screen within 2 s of DOMContentLoaded, with the camera off and on, and waits for neither the camera nor the solves', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // A session with one solve, stored in the origin private file system.
  await page.goto('./?demo=0&speed=20');
  await expectSolves(page, 1);
  await stampFirstRender(page);

  // The camera setting off.
  const off = await loadTimer(page, false);
  expect(off.previewMs).toBeNull();

  // The camera setting on (Camera settings, Turn on): the next page load opens the camera.
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('camera-preview')).toBeVisible();
  const on = await loadTimer(page, true);

  // The camera and the storage slow to answer: the clock does not wait for them.
  await holdBack(page);
  const held = await loadTimer(page, true);

  const report = { cameraOff: off, cameraOn: on, heldBack3s: held };
  console.log(`first render: ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'first-render', description: JSON.stringify(report) });
  for (const [what, render] of Object.entries(report)) {
    expect(render.clockMs, `${what}: the clock after DOMContentLoaded`).toBeLessThan(LIMIT_MS);
  }
  expect(on.previewMs).not.toBeNull();
  // Held back, the solves and the camera's picture come seconds later, the clock within the limit.
  expect(held.listMs).toBeGreaterThan(LIMIT_MS);
  expect(held.previewMs).toBeGreaterThan(LIMIT_MS);
});
