import { type Page, expect, test } from '@playwright/test';

// The Timer page shows a scramble that cubing.js generated in its module worker (docs/PLAN.md,
// T1.2), which proves that the Angular build bundles the worker and Chromium starts it. Checked on
// the dev server (the default baseURL) and on the production build served under /cubetrace/ as
// GitHub Pages serves it (the second webServer of playwright.config.ts, as in pwa.spec.ts), online
// and offline from the service worker's cache.
const scrambleText = /^([UDRLFB][2']? ?){15,30}$/;
const pagesUrl = 'http://localhost:4300/cubetrace/';

interface ServiceWorkerManifest {
  assetGroups: { name: string; urls: string[] }[];
}

async function expectGeneratedScramble(page: Page): Promise<void> {
  // The first scramble starts the worker and builds cubing.js's search tables: allow for it.
  await expect(page.getByTestId('scramble')).toHaveText(scrambleText, { timeout: 30_000 });
  // cubing.js has no fallback to the page's own thread: a scramble means a worker ran it.
  expect(page.workers().length).toBeGreaterThan(0);
}

function collectUncaught(page: Page): Error[] {
  const uncaught: Error[] = [];
  page.on('pageerror', (error) => {
    uncaught.push(error);
  });
  return uncaught;
}

test('the dev server: the Timer page shows a scramble from cubing.js', async ({ page }) => {
  const uncaught = collectUncaught(page);
  await page.goto('/');
  await expectGeneratedScramble(page);
  expect(uncaught).toEqual([]);
});

test('the production build under /cubetrace/: the Timer page shows a scramble from cubing.js', async ({
  page,
}) => {
  const uncaught = collectUncaught(page);
  await page.goto(pagesUrl);
  await expectGeneratedScramble(page);
  expect(uncaught).toEqual([]);
});

test('the production build offline: the service worker has cached cubing.js and its worker', async ({
  context,
  page,
  request,
}) => {
  const uncaught = collectUncaught(page);
  const ngsw = (await (await request.get(`${pagesUrl}ngsw.json`)).json()) as ServiceWorkerManifest;
  const shell = ngsw.assetGroups.find((group) => group.name === 'app')?.urls ?? [];

  await page.goto(pagesUrl);
  await expectGeneratedScramble(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The service worker downloads the whole shell after it starts; wait until it has.
  await expect
    .poll(() =>
      page.evaluate(async (urls) => {
        const cached = await Promise.all(urls.map((url) => caches.match(url)));
        return cached.every((response) => response !== undefined);
      }, shell),
    )
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expectGeneratedScramble(page);
  expect(uncaught).toEqual([]);
});
