import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

// The production build with the base href of the GitHub Pages deploy, served under /cubetrace/
// by the second webServer of playwright.config.ts. The service worker only runs in production
// builds, so it is tested here and not on the dev server.
const pagesUrl = 'http://localhost:4300/cubetrace/';
test.use({ baseURL: pagesUrl });

interface WebManifest {
  name: string;
  display: string;
  orientation: string;
  icons: { src: string; sizes: string; purpose: string }[];
}

interface ServiceWorkerManifest {
  index: string;
  assetGroups: { name: string; urls: string[] }[];
}

test('the manifest link resolves to the manifest, and its icons are served', async ({
  page,
  request,
}) => {
  await page.goto('./');
  const href = await page.evaluate(
    () => document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href,
  );
  expect(href).toBe(`${pagesUrl}manifest.webmanifest`);

  const response = await request.get(href ?? '');
  expect(response.status()).toBe(200);
  const manifest = (await response.json()) as WebManifest;
  expect(manifest).toMatchObject({
    name: 'cubetrace',
    display: 'standalone',
    orientation: 'any',
  });
  // Chrome installs an app whose manifest has 192 and 512 pixel icons.
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(new URL(icon.src, href).href);
    expect(iconResponse.status(), icon.src).toBe(200);
  }
});

test('ngsw-worker.js is served, and the service worker controls /cubetrace/', async ({
  page,
  request,
}) => {
  const worker = await request.get('ngsw-worker.js');
  expect(worker.status()).toBe(200);
  expect(worker.headers()['content-type']).toContain('javascript');
  const ngsw = (await (await request.get('ngsw.json')).json()) as ServiceWorkerManifest;
  expect(ngsw.index).toBe('/cubetrace/index.html');

  await page.goto('./');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(pagesUrl);
});

test('the app shell opens offline once the service worker has cached it', async ({
  context,
  page,
  request,
}) => {
  const ngsw = (await (await request.get('ngsw.json')).json()) as ServiceWorkerManifest;
  const shell = ngsw.assetGroups.find((group) => group.name === 'app')?.urls ?? [];
  expect(shell).toContain('/cubetrace/index.html');

  await page.goto('./');
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
  await page.goto('./settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('the footer shows the version and the commit the build was made from', async ({ page }) => {
  const repository = resolve(test.info().project.testDir, '../../..');
  const packageJson = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8')) as {
    version: string;
  };
  const commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();

  await page.goto('./');
  await expect(page.getByTestId('app-version')).toHaveText(
    `cubetrace ${packageJson.version} · ${commit}`,
  );
});
