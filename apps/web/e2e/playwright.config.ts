import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of apps/web, run from the repository root with `npm run e2e`.
// Relative paths below are resolved against this directory (apps/web/e2e).
const port = 4200;
// The production build under the GitHub Pages path, for pwa.spec.ts (which has this URL too).
const pagesPort = 4300;
const inCi = Boolean(process.env['CI']);

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: inCi,
  // Flaky tests are fixed, not retried into passing (docs/PLAN.md, T1.9).
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${String(port)}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The Angular dev server; a server already running on the port is reused outside CI.
      command: `npm run start -- --port=${String(port)}`,
      cwd: '..',
      url: `http://localhost:${String(port)}`,
      reuseExistingServer: !inCi,
      timeout: 120_000,
    },
    {
      // The production build with the base href of the Pages deploy (service worker on), served
      // under /cubetrace/ as GitHub Pages serves it (serve-pages.mts).
      command: `npm run build -- --base-href /cubetrace/ --output-path dist/pages && node e2e/serve-pages.mts dist/pages/browser ${String(pagesPort)}`,
      cwd: '..',
      url: `http://localhost:${String(pagesPort)}/cubetrace/`,
      reuseExistingServer: !inCi,
      timeout: 120_000,
    },
  ],
});
