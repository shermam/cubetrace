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
  // Every event carries the device's label of its moment, the start's included, so the label is in
  // the settings before the first page loads (and left alone from then on: the page writes them).
  await page.addInitScript((key: string) => {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify({ hostLabel: 'e2e-laptop' }));
    }
  }, 'cubetrace.settings');

  // The start and the sign-in: the events raised before the sign-in wait in memory and go with it,
  // a setting changed among them.
  await page.goto('/settings');
  await expect(page.getByTestId('host-label')).toHaveValue('e2e-laptop');
  const idle = page.getByTestId('idle-minutes');
  await idle.fill('30');
  await idle.blur();
  await expect(idle).toHaveValue('30');
  const platform = await page.evaluate(() => {
    // As hostPlatform (settings-service.ts) reads it: the client hints, which Chromium has.
    const hints: unknown = Reflect.get(navigator, 'userAgentData');
    const hinted: unknown =
      typeof hints === 'object' && hints !== null ? Reflect.get(hints, 'platform') : undefined;
    return typeof hinted === 'string' ? hinted : '';
  });
  expect(platform).not.toBe('');
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
    expect(event.device).toEqual({ label: 'e2e-laptop', platform, installed: false });
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
  // The click signed in; the one page load since (the demo's) resumed the account.
  expect(of('account.signin').map((event) => event.data)).toEqual([
    { outcome: 'ok', installed: false },
    { outcome: 'resumed', installed: false },
  ]);
  expect(of('settings.changed')[0].data).toEqual({ key: 'idleDisconnectMinutes', value: 30 });
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
  // The events in the scope of this first attempt include the camera's and the recording's start,
  // which happened while it was under way. The cost of an attempt (docs/DIAGNOSTICS.md) is measured
  // on a second one, in the steady state: its done and its clips, and nothing else of it in this
  // flow (the uploads' events come with a real cube's session).
  const firstAttempt = events.filter(
    (entry) => entry.event.session === sessionId && entry.event.attempt === 1,
  );
  test.info().annotations.push({
    type: 'events of the first attempt',
    description: `${String(firstAttempt.length)}: ${firstAttempt.map((entry) => entry.event.kind).join(', ')}`,
  });
  await replayDemo(page);
  await expectSolves(page, 2);
  await expect(solveRows(page).getByTestId('clip-badge')).toHaveCount(2, { timeout: 20_000 });
  await expect
    .poll(
      async () =>
        (await kept(page)).some(
          (entry) => entry.event.kind === 'attempt.done' && entry.event.attempt === 2,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  const perAttempt = (await kept(page)).filter(
    (entry) => entry.event.session === sessionId && entry.event.attempt === 2,
  );
  const perAttemptKinds = perAttempt.map((entry) => entry.event.kind);
  test.info().annotations.push({
    type: 'events per attempt',
    description: `${String(perAttempt.length)}: ${perAttemptKinds.join(', ')}`,
  });
  expect(perAttemptKinds.filter((kind) => kind === 'attempt.done')).toHaveLength(1);
  expect(perAttemptKinds.filter((kind) => kind === 'clip.saved')).toHaveLength(2);
  // The rest is the demo's replay, which disconnects and reconnects the demo cube (the wake lock
  // goes and comes with it); a real cube stays connected across attempts.
  expect(
    perAttemptKinds.filter(
      (kind) =>
        ![
          'attempt.done',
          'clip.saved',
          'cube.connected',
          'cube.disconnected',
          'wake.lock',
        ].includes(kind),
    ),
  ).toEqual([]);
  expect(perAttempt.length).toBeLessThanOrEqual(7);
  // Nothing an event must never carry: no address, no email, no user agent.
  const text = JSON.stringify(await kept(page));
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
    '2',
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
