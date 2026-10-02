import { CLOUD_EVENT_SCHEMA } from '@cubetrace/core';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import { ADA, fakeAccount, fakeAccountState } from './helpers/account';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// The diagnostics events (docs/PLAN.md T3.9, docs/DIAGNOSTICS.md) on the dev server, with the fake
// of Firebase (helpers/account.ts): signed in, a demo attempt recorded with Chrome's fake camera
// leaves the events of the app's start, the sign-in, the session, the cube, the camera, the
// recording, the attempt and its clips in the account, each valid against the schema, with the
// session and attempt they belong to, and nothing an event must never carry; the QA view aggregates
// them; the switch in Settings → Account stops them after one last event. Signed out, nothing goes.
// Launch options force a browser of their own for this file (the encoding project, one at a time).
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

const SPEED = 20;

const isEvent = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(CLOUD_EVENT_SCHEMA);

/** An event as the fake keeps it. */
interface Kept {
  readonly uid: string;
  readonly id: string;
  readonly event: {
    readonly kind: string;
    readonly tsMs: number;
    readonly session?: string;
    readonly attempt?: number;
    readonly app: { readonly version: string; readonly commit: string };
    readonly device: {
      readonly label: string;
      readonly platform: string;
      readonly installed: boolean;
    };
    readonly data: Record<string, unknown>;
  };
}

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

async function kept(page: Page): Promise<Kept[]> {
  return (await fakeAccountState(page)).events as unknown as Kept[];
}

/** Waits until an event of `kind` is in the account (the batches go within 5 s, or on pagehide). */
async function expectEvent(page: Page, kind: string): Promise<void> {
  await expect
    .poll(async () => (await kept(page)).some((entry) => entry.event.kind === kind), {
      timeout: 20_000,
    })
    .toBe(true);
}

test('signed in, a demo attempt with the camera on leaves its events in the account, with the right session and attempt; the QA view sums them; the switch stops them', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await fakeAccount(page);

  // The start and the sign-in: the events raised before the sign-in wait in memory and go with it.
  await page.goto('/settings');
  const label = page.getByTestId('host-label');
  await label.fill('e2e-laptop');
  await label.blur();
  const account = page.getByRole('region', { name: 'Account' });
  await expect(account.getByTestId('diagnostics')).toBeChecked();
  await expect(account.getByTestId('diagnostics-hint')).toContainText(
    'Nothing is kept while you are signed out, and nothing while this is off.',
  );
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible();

  // One attempt recorded with the camera on (the demo solve that starts with the page is recorded
  // before the camera is on, and Delete last removes it), with the demo cube's gyroscope, as
  // uploads.spec.ts records it.
  await page.goto(demoPath(0, SPEED, undefined, true));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await page.getByTestId('delete-last').click();
  await expect(solveRows(page)).toHaveCount(0);
  const sessionId = (await currentSessionId(page)) ?? '';
  expect(sessionId).not.toBe('');
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('sync-check')).toHaveAttribute('data-state', 'framing');
  await page.getByTestId('sync-later').click();
  const stats = page.getByTestId('recording-stats');
  await expect
    .poll(async () => Number(await stats.getAttribute('data-buffer-seconds')), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(4);
  await replayDemo(page);
  await expectSolves(page, 1);
  await expect(solveRows(page).getByTestId('clip-badge')).toHaveText(
    /^\s*2 clips, [\d.]+ [kM]B\s*$/,
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // The attempt's event waits for its clips and its gyro file, then the batch goes within 5 s.
  await expectEvent(page, 'attempt.done');
  const events = await kept(page);
  const build = ((await page.getByTestId('app-version').textContent()) ?? '')
    .replace('cubetrace ', '')
    .split(' · ');
  for (const { uid, id, event } of events) {
    expect(uid).toBe(ADA.uid);
    expect(id).toMatch(/^\d{13}-[0-9a-f]{8}$/);
    expect(id.slice(0, 13)).toBe(String(Math.floor(event.tsMs)));
    expect(isEvent(event), `${event.kind}: ${JSON.stringify(isEvent.errors)}`).toBe(true);
    expect(event.device).toEqual({ label: 'e2e-laptop', platform: 'Linux', installed: false });
    expect(event.app).toEqual({ version: build[0], commit: build[1] });
  }
  const kinds = events.map((entry) => entry.event.kind);
  expect(kinds[0]).toBe('app.start');
  expect(kinds).toEqual(
    expect.arrayContaining([
      'app.start',
      'page.viewed',
      'settings.changed',
      'account.signin',
      'session.started',
      'cube.connected',
      'camera.on',
      'recording.started',
      'attempt.deleted',
      'attempt.done',
      'clip.saved',
    ]),
  );
  const of = (kind: string): Kept['event'][] =>
    events.filter((entry) => entry.event.kind === kind).map((entry) => entry.event);
  expect(of('account.signin')).toEqual([
    expect.objectContaining({ data: { outcome: 'ok', installed: false } }),
  ]);
  expect(of('settings.changed')[0].data).toEqual({ key: 'hostLabel', value: 'e2e-laptop' });
  expect(of('session.started').at(-1)).toMatchObject({
    session: sessionId,
    data: { host: 'e2e-laptop', hardware: 'simulated', gyro: true, storage: 'opfs' },
  });
  expect(of('cube.connected').at(-1)).toMatchObject({
    session: sessionId,
    data: { kind: 'fake', model: 'Fake cube', mac: 'none', gyro: true },
  });
  expect(of('camera.on')).toHaveLength(1);
  expect(of('camera.on')[0]).toMatchObject({
    session: sessionId,
    data: { width: 1920, height: 1080, fps: 30 },
  });
  expect(typeof of('camera.on')[0].data['label']).toBe('string');
  expect(of('recording.started').at(-1)).toMatchObject({
    session: sessionId,
    data: { camera: 'laptop', quality: 'standard', audio: true, processing: 'raw' },
  });
  expect(typeof of('recording.started').at(-1)?.data['codec']).toBe('string');
  expect(of('attempt.deleted')).toEqual([
    expect.objectContaining({
      session: sessionId,
      attempt: 1,
      data: expect.objectContaining({ status: 'solved' }),
    }),
  ]);
  const done = of('attempt.done');
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({
    session: sessionId,
    attempt: 1,
    data: {
      status: 'solved',
      replayOk: true,
      scrambleCorrected: false,
      phases: 8,
      clips: 2,
      clipsLate: 0,
      resyncs: 0,
      settled: true,
    },
  });
  expect(done[0].data['timeMs']).toEqual(expect.any(Number));
  expect(done[0].data['gyroSamples']).toEqual(expect.any(Number));
  expect(done[0].data['gyroRateHz']).toEqual(expect.any(Number));
  expect(done[0].data['clockSamples']).toEqual(expect.any(Number));
  const clips = of('clip.saved').filter(
    (event) => event.session === sessionId && event.attempt === 1,
  );
  expect(clips.map((event) => event.data['segment']).sort()).toEqual(['scramble', 'solve']);
  for (const clip of clips) {
    expect(clip.data).toMatchObject({ camera: 'laptop', truncatedStart: false, audio: true });
    expect(clip.data['bytes']).toEqual(expect.any(Number));
    expect(clip.data['frames']).toEqual(expect.any(Number));
  }
  // The events of this one attempt, for the costs (docs/DIAGNOSTICS.md): the done, its clips, and
  // nothing else of it in this flow (the uploads' events come with a real cube's session).
  const perAttempt = events.filter(
    (entry) => entry.event.session === sessionId && entry.event.attempt === 1,
  );
  test.info().annotations.push({
    type: 'events per attempt',
    description: `${String(perAttempt.length)}: ${perAttempt.map((entry) => entry.event.kind).join(', ')}`,
  });
  expect(perAttempt.length).toBeLessThanOrEqual(8);
  // Nothing an event must never carry: no address, no email, no user agent.
  const text = JSON.stringify(events);
  expect(text).not.toMatch(/[0-9a-f]{2}(:[0-9a-f]{2}){5}/iu);
  expect(text).not.toContain('@example.com');
  expect(text).not.toContain('Mozilla/');
  expect(text).not.toContain('HeadlessChrome');

  // The QA view: the device, its start's build, the kinds, no failure.
  await page.goto('/qa');
  const device = page.getByTestId('diag-device');
  await expect(device).toHaveCount(1);
  await expect(device).toHaveAttribute('data-device', 'e2e-laptop');
  await expect(device.getByTestId('diag-build')).toHaveText(`${build[0]} · ${build[1]}`);
  await expect(page.locator('[data-testid="diag-kind"][data-kind="attempt.done"]')).toContainText(
    '1',
  );
  await expect(page.locator('[data-testid="diag-kind"][data-kind="app.start"]')).toBeVisible();
  await expect(page.getByTestId('diag-no-failures')).toHaveText('No failure among them.');
  await expect(page.getByTestId('diag-read')).toContainText('Read from your account at');

  // The switch: one last event, then nothing, not even the pages viewed.
  await page.goto('/settings');
  await page.getByRole('region', { name: 'Account' }).getByTestId('diagnostics').uncheck();
  await page.goto('/sessions');
  await expect
    .poll(async () => (await kept(page)).at(-1)?.event.data, { timeout: 10_000 })
    .toEqual({ key: 'diagnostics', value: false });
  const written = (await kept(page)).length;
  await page.goto('/settings');
  await page.goto('/qa');
  expect((await kept(page)).length).toBe(written);
  await page.goto('/settings');
  await page.getByRole('region', { name: 'Account' }).getByTestId('diagnostics').check();
  await page.goto('/sessions');
  await expect
    .poll(async () => (await kept(page)).at(-1)?.event.data, { timeout: 10_000 })
    .toEqual({ key: 'diagnostics', value: true });
});

test('signed out, a demo attempt with the camera on leaves nothing in the account, and the account never loads', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await fakeAccount(page);
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  await page.getByTestId('sync-later').click();
  await replayDemo(page);
  await expectSolves(page, 2);
  await page.goto('/settings');
  const state = await fakeAccountState(page);
  expect(state.loads).toBe(0);
  expect(state.events).toEqual([]);
  expect(state.eventBatches).toBe(0);
});
