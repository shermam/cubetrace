import { type Locator, type Page, expect, test } from '@playwright/test';

import {
  currentSessionId,
  demoPath,
  expectSolves,
  replayDemo,
  solveRows,
  textOf,
} from './helpers/timer';

// The Timer page with the camera in view (docs/PLAN.md, T2.7 and T2.13), with Chrome's fake camera
// at 30 fps (the prompt answered "Allow") and the demo cube: the scramble, the time and the camera's
// preview fit the window together on a laptop (the preview beside the time) and on a phone, where the
// picture and the scramble over it stay pinned at the top while the page scrolls (with Scramble over
// the picture off in Settings, the preview comes under the time, as T2.7 had it); the list shows the
// last 12 solves and "See all" opens the session's page, which lists them all.
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

/** The box of `locator`, which must be on the page. */
async function boxOf(locator: Locator, what: string) {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error(`${what}: not on the page.`);
  }
  return box;
}

/**
 * Scrolls the page as far as a solver does to read the breakdown and the solves: until they come
 * right under the part pinned at the top (T2.13). Returns that part's box once it is pinned.
 */
async function scrollToSolves(page: Page) {
  const stage = page.getByTestId('timer-stage');
  const solves = page.getByRole('region', { name: 'Breakdown and solves' });
  const by = (await boxOf(solves, 'the solves')).y - (await boxOf(stage, 'the pinned part')).height;
  await page.evaluate((y) => {
    window.scrollBy(0, y);
  }, by);
  await expect.poll(async () => (await boxOf(stage, 'the pinned part')).y).toBe(0);
  return boxOf(stage, 'the pinned part');
}

/** A colour's red, green and blue, 0 to 255. */
type Rgb = readonly [number, number, number];

/** The channels and the alpha of a computed CSS colour, `rgb(…)` or `rgba(…)`. */
function channels(colour: string): { rgb: Rgb; alpha: number } {
  const match = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(colour);
  if (match === null) {
    throw new Error(`"${colour}" is not a computed colour.`);
  }
  const [, r = '', g = '', b = '', alpha = '1'] = match;
  return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(alpha) };
}

/** `top` laid over the opaque `under`, with its alpha. */
function over(top: string, [r, g, b]: Rgb): Rgb {
  const {
    rgb: [tr, tg, tb],
    alpha,
  } = channels(top);
  const mix = (t: number, u: number): number => t * alpha + u * (1 - alpha);
  return [mix(tr, r), mix(tg, g), mix(tb, b)];
}

/** WCAG 2's relative luminance of an opaque colour. */
function luminance([r, g, b]: Rgb): number {
  const linear = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2's contrast ratio of two opaque colours. */
function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
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

    // The camera on: the scramble, the time and the preview in view, the preview beside the time,
    // nothing pinned (T2.13 is for phones).
    await turnCameraOn(page);
    await expect(page.getByTestId('timer-layout')).toHaveAttribute('data-layout', 'columns');
    await expect(page.getByTestId('timer-stage')).toHaveCSS('position', 'static');
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

  test('with Scramble over the picture off: the preview under the time, the three in view together, nothing wider than the screen', async ({
    page,
  }) => {
    await withoutRecording(page);
    // T2.7's layout, one switch away in Settings → Timer (T2.13).
    await page.goto('/settings');
    const overPicture = page.getByTestId('scramble-over-picture');
    await expect(overPicture).toBeChecked();
    await overPicture.uncheck();
    await page.goto(demoPath(0, SPEED));
    await expectSolves(page, 1);
    // Chrome on the phone has Web Bluetooth: the banner that this browser shows is not there.
    await page.getByTestId('support-banner').getByRole('button', { name: 'Dismiss' }).click();
    await turnCameraOn(page);
    await expect(page.getByTestId('timer-layout')).toHaveAttribute('data-layout', 'stacked');
    await expect(page.getByTestId('timer-stage')).toHaveCSS('position', 'static');

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

test.describe('on a phone in portrait, the scramble over the pinned picture (T2.13)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the scramble, the picture and the time in view at load; the scramble and the picture still in view at the solves; the strip legible; nothing wider than the screen', async ({
    page,
  }) => {
    await withoutRecording(page);
    await page.goto(demoPath(0, SPEED));
    await expectSolves(page, 1);
    await turnCameraOn(page);
    // The camera stays on across a load: the page opens with the picture pinned.
    await page.goto('/');
    await page.getByTestId('support-banner').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('camera-status-fps')).toHaveText(/^\d+\.\d fps$/, {
      timeout: 10_000,
    });
    await expect(page.getByTestId('timer-layout')).toHaveAttribute('data-layout', 'overlay');
    await expect(page.getByTestId('timer-stage')).toHaveCSS('position', 'sticky');

    // In view together: every move of the scramble, the picture and the time.
    const moves = page.getByTestId('scramble').locator('.move');
    expect(await moves.count()).toBeGreaterThan(15);
    for (const [i, move] of (await moves.all()).entries()) {
      await inView(page, move, `move ${String(i + 1)} of the scramble`);
    }
    const video = await inView(page, page.getByTestId('camera-preview'), 'the picture');
    const clock = await inView(page, page.getByRole('region', { name: 'Time' }), 'the clock');
    // The picture from edge to edge at the frames' 16:9 (Chrome's test camera), the scramble over
    // its lower part, the time right under them.
    expect(Math.abs(video.x)).toBeLessThan(1);
    expect(Math.abs(video.width - 390)).toBeLessThan(1);
    expect(Math.abs(video.height - (390 * 9) / 16)).toBeLessThan(1);
    const strip = await boxOf(page.getByRole('region', { name: 'Scramble' }), 'the strip');
    expect(Math.abs(strip.width - 390)).toBeLessThan(1);
    expect(strip.y).toBeGreaterThan(video.y + 30);
    expect(Math.abs(strip.y + strip.height - (video.y + video.height))).toBeLessThan(1);
    expect(clock.y).toBeGreaterThanOrEqual(video.y + video.height);
    expect(clock.y - (video.y + video.height)).toBeLessThan(20);
    // The heading says the scramble is the next attempt's; the status line sits over the picture.
    await expect(page.getByRole('region', { name: 'Scramble' }).locator('h2')).toHaveText(
      'Next scramble',
    );
    const status = await boxOf(page.getByTestId('camera-status'), 'the status line');
    expect(status.y).toBeGreaterThanOrEqual(video.y);
    expect(status.y + status.height).toBeLessThanOrEqual(strip.y);
    await expect(page.getByTestId('scramble-picture')).toHaveCount(0);

    // Legible over any picture: a dark ground of at least 50%, white moves, and over a mid-grey
    // picture at least 4.5:1 for the moves, the heading and the green of a move made.
    const look = await page.getByRole('region', { name: 'Scramble' }).evaluate((section) => {
      const colour = (selector: string): string =>
        getComputedStyle(section.querySelector(selector) ?? section).color;
      return {
        ground: getComputedStyle(section).backgroundColor,
        move: colour('.move[data-state="pending"]'),
        heading: colour('h2'),
        done: getComputedStyle(document.documentElement).getPropertyValue('--ok').trim(),
      };
    });
    expect(channels(look.ground).alpha).toBeGreaterThanOrEqual(0.5);
    expect(look.move).toBe('rgb(255, 255, 255)');
    const ground = over(look.ground, [128, 128, 128]);
    expect(contrast(over(look.move, ground), ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(look.heading, ground), ground)).toBeGreaterThanOrEqual(4.5);
    expect(look.done).toBe('#3fb950');
    expect(contrast([0x3f, 0xb9, 0x50], ground)).toBeGreaterThanOrEqual(4.5);

    // Scrolled to the breakdown and the solves: the picture and the scramble still at the top of
    // the window, the time gone under them.
    const pinned = await scrollToSolves(page);
    const videoThen = await inView(page, page.getByTestId('camera-preview'), 'the pinned picture');
    expect(Math.abs(videoThen.y)).toBeLessThan(1);
    for (const [i, move] of (await moves.all()).entries()) {
      await inView(page, move, `move ${String(i + 1)} of the pinned scramble`);
    }
    const clockThen = await boxOf(page.getByRole('region', { name: 'Time' }), 'the clock');
    expect(clockThen.y).toBeLessThan(0);
    expect(clockThen.y + clockThen.height).toBeLessThanOrEqual(pinned.y + pinned.height);
    await inView(page, page.getByTestId('solve-row').first(), 'the last solve');
    await noHorizontalOverflow(page);

    // The narrowest phones: the picture as wide as the screen, nothing wider.
    await page.setViewportSize({ width: 320, height: 640 });
    await expect
      .poll(async () =>
        Math.round((await boxOf(page.getByTestId('camera-preview'), 'the picture')).width),
      )
      .toBe(320);
    await noHorizontalOverflow(page);
  });

  test('the camera off: the scramble card pinned at the top, the time gone under it at the solves', async ({
    page,
  }) => {
    await withoutRecording(page);
    await page.goto(demoPath(0, SPEED));
    await expectSolves(page, 1);
    await page.getByTestId('support-banner').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('timer-layout')).toHaveAttribute('data-layout', 'pinned');
    await expect(page.getByTestId('camera-preview')).toHaveCount(0);

    // At the top, the card where T2.7 has it, with its picture of the cube.
    const card = await inView(page, page.getByRole('region', { name: 'Scramble' }), 'the scramble');
    await inView(page, page.getByRole('region', { name: 'Time' }), 'the clock');
    expect(card.x).toBe(16);
    await expect(page.getByTestId('scramble-picture')).toBeVisible();

    // The Cube section open, so that a session of one solve is long enough to scroll the time away.
    await page.getByTestId('cube-section').locator('summary').click();
    const pinned = await scrollToSolves(page);
    const cardThen = await inView(page, page.getByRole('region', { name: 'Scramble' }), 'the card');
    // A band of the page's background above it.
    expect(cardThen.y).toBe(16);
    expect(cardThen.height).toBe(card.height);
    await inView(page, page.getByTestId('scramble'), 'the pinned scramble');
    const clockThen = await boxOf(page.getByRole('region', { name: 'Time' }), 'the clock');
    expect(clockThen.y + clockThen.height).toBeLessThanOrEqual(pinned.y + pinned.height);
    await inView(page, page.getByTestId('solve-row').first(), 'the last solve');
    await noHorizontalOverflow(page);
  });
});
