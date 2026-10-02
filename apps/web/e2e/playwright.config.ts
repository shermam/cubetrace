import { defineConfig, devices } from '@playwright/test';

import { SINK_PORT } from './helpers/emulators';

// End-to-end tests of apps/web, run from the repository root with `npm run e2e`.
// Relative paths below are resolved against this directory (apps/web/e2e).
const port = 4200;
// The production build under the GitHub Pages path, for pwa.spec.ts (which has this URL too).
const pagesPort = 4300;
const inCi = Boolean(process.env['CI']);
// The specs that record Chrome's fake camera, encoding 1080p30 in software in the capture worker:
// one at a time, in a project of their own. Two encoders at once on four CPUs cost the camera frames
// and hold back the demo cube's timers, which recording.spec.ts and capture.spec.ts measure (lost
// frames, the timing with the camera on and off). The other specs run beside them.
const encoding =
  /\/(camera-labels|capture|microphone|recording|session-clips|sync-check|uploads|video-quality)\.spec\.ts$/;
// The specs of the cloud project: the app's own Firebase SDK against the Auth, Firestore and Functions
// emulators, the uploads into the bucket sink (helpers/emulators.ts). `npm run e2e:cloud` runs
// Playwright inside `firebase emulators:exec`, which says so in FIREBASE_EMULATOR_HUB: only then is
// there a cloud project, with the sink, and without the production build, which only the other
// projects use. `npm run e2e` runs the others, with the fakes of Firebase.
const cloud = /\.cloud\.spec\.ts$/;
const emulators = process.env['FIREBASE_EMULATOR_HUB'] !== undefined;

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
  projects: [
    // First, so that the next of its specs starts as soon as one ends.
    { name: 'encoding', testMatch: encoding, workers: 1, use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium', testIgnore: [encoding, cloud], use: { ...devices['Desktop Chrome'] } },
    ...(emulators
      ? [{ name: 'cloud', testMatch: cloud, use: { ...devices['Desktop Chrome'] } }]
      : []),
  ],
  webServer: [
    {
      // The Angular dev server; a server already running on the port is reused outside CI.
      command: `npm run start -- --port=${String(port)}`,
      cwd: '..',
      url: `http://localhost:${String(port)}`,
      reuseExistingServer: !inCi,
      timeout: 120_000,
    },
    emulators
      ? {
          // The functions' bucket in the emulators (BUCKET_PROVIDER=local), on this machine
          // (helpers/bucket-sink.mts, on the port of functions/.env.demo-cubetrace).
          command: `node e2e/helpers/bucket-sink.mts ${String(SINK_PORT)}`,
          cwd: '..',
          url: `http://127.0.0.1:${String(SINK_PORT)}/`,
          reuseExistingServer: !inCi,
          timeout: 30_000,
        }
      : {
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
