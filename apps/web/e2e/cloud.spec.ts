import {
  AttemptMachine,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  cloudAttempt,
  cloudSession,
  createSession,
  parseMoves,
  pendingUpload,
  type AttemptRecord,
  type CloudAttempt,
  type SessionRecord,
} from '@cubetrace/core';
import { type Page, expect, test } from '@playwright/test';
import { Ajv2020 } from 'ajv/dist/2020';

import { ADA, type FakeIndex, fakeAccount, fakeAccountState } from './helpers/account';
import { currentSessionId, demoPath, expectSolves } from './helpers/timer';

// The session index (docs/PLAN.md, T3.1) on the dev server, with the fake of Firebase
// (helpers/account.ts), whose index holds a session of another device, the phone: signed in, a demo
// session stays on this device; marked as a real cube's in the origin private file system, the
// catch-up of the next start writes it, and the Sessions page then says "both" beside the phone's
// "cloud", whose page is read-only, and the QA view counts both devices' attempts. Signed out, the
// Sessions page is as it was.

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isSessionDocument = ajv.compile(CLOUD_SESSION_SCHEMA);
const isAttemptDocument = ajv.compile(CLOUD_ATTEMPT_SCHEMA);

const PHONE = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const DAY_MS = 86_400_000;

/** Attempt `index` of the phone's session, on `R U F`, shown at `shownMs`, with a solve clip. */
function phoneAttempt(index: number, shownMs: number): AttemptRecord {
  const machine = new AttemptMachine({
    session: PHONE,
    index,
    scramble: 'R U F',
    scrambleShownMs: shownMs,
  });
  let t = shownMs + 1_000;
  for (const m of parseMoves("R U F F' U' R'")) {
    machine.onMove({ m, cubeMs: t - shownMs, hostMs: t });
    t += 700;
  }
  return {
    ...machine.toRecord(),
    video: [
      {
        camera: 'phone-front',
        segment: 'solve',
        file: 'phone-front.solve.mp4',
        bytes: 3_000_000,
        codec: 'avc1.640028',
        audio: 'mp4a.40.2',
        width: 1080,
        height: 1920,
        crop: null,
        fpsNominal: 30,
        frames: 200,
        firstFrameHostMs: shownMs + 500,
        framesFile: 'phone-front.solve.frames.json',
        syncResidualMs: 61.5,
        truncatedStart: false,
      },
    ],
  };
}

/** The phone's session of yesterday with its two attempts, as its index would hold them. */
function phoneIndex(): { index: FakeIndex; session: SessionRecord; attempts: CloudAttempt[] } {
  const yesterday = Date.now() - DAY_MS;
  const session: SessionRecord = {
    ...createSession({
      host: { label: 'e2e-phone', userAgent: 'Android', platform: 'Android', isPhone: true },
      cube: { model: 'GAN 12 ui FreePlay', hardware: 'GAN Gen2', firmware: '2.3.1', gyro: true },
      settings: { inspection15s: false, autoAdvance: true },
      appVersion: '0.3.0',
      commit: 'e2e',
      nowMs: yesterday,
      id: PHONE,
    }),
    summary: { attempts: 2, solved: 2, dnf: 0 },
  };
  const attempts = [1, 2].map((index) =>
    cloudAttempt({
      attempt: phoneAttempt(index, yesterday + index * 60_000),
      session,
      owner: ADA.uid,
      upload: pendingUpload({
        'attempt.json': 6_000,
        'phone-front.solve.mp4': 3_000_000,
        'phone-front.solve.frames.json': 1_500,
      }),
    }),
  );
  return {
    session,
    attempts,
    index: {
      sessions: { [PHONE]: { ...cloudSession(session, ADA.uid) } },
      attempts: {
        [PHONE]: Object.fromEntries(
          attempts.map((attempt) => [String(attempt.index).padStart(4, '0'), { ...attempt }]),
        ),
      },
    },
  };
}

/** The local day of host time `ms` as the QA view keys its rows (`2026-10-01`). */
function dayOf(page: Page, ms: number): Promise<string> {
  return page.evaluate((time) => {
    const date = new Date(time);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }, ms);
}

function row(page: Page, sessionId: string) {
  return page.locator(`[data-testid="session-row"][data-session="${sessionId}"]`);
}

test('signed in: a demo session stays on this device; a real one goes to the index, beside the other device’s, and the QA view counts both', async ({
  page,
}) => {
  const phone = phoneIndex();
  await fakeAccount(page, { index: phone.index });
  await page.goto('/settings');
  const label = page.getByTestId('host-label');
  await label.fill('e2e-laptop');
  await label.blur();
  await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account: Ada Lovelace' }),
  ).toBeVisible();

  // Signed in, a demo solve: its session is the fake cube's, which never goes to the cloud.
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  const id = (await currentSessionId(page)) ?? '';

  // A new page load, without the demo: the Sessions page merges this device's session and the
  // phone's, from the index.
  await page.goto('/sessions');
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await expect(row(page, id).getByTestId('session-place')).toHaveText('this device');
  await expect(row(page, id).getByTestId('session-place')).toHaveAttribute(
    'title',
    'A demo session (the fake cube): it stays on this device.',
  );
  await expect(row(page, PHONE).getByTestId('session-place')).toHaveText('cloud');
  await expect(row(page, PHONE)).toContainText('e2e-phone · GAN 12 ui FreePlay · 2 attempts');
  await expect(row(page, PHONE).getByRole('button')).toHaveCount(0);
  expect((await fakeAccountState(page)).indexWrites).toEqual([]);

  // The device filter has both devices' labels.
  const filter = page.getByTestId('device-filter');
  await expect(filter.locator('option')).toHaveText(['All devices', 'e2e-laptop', 'e2e-phone']);
  await filter.selectOption('e2e-phone');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('session-row')).toHaveAttribute('data-session', PHONE);
  await filter.selectOption('');
  await expect(page.getByTestId('session-row')).toHaveCount(2);

  // The phone's session opens read-only, from the index.
  await row(page, PHONE).getByTestId('session-link').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${PHONE}$`));
  await expect(page.getByTestId('session-cloud-note')).toContainText(
    'Recorded on e2e-phone: this session is in your cloud index, not on this device.',
  );
  await expect(page.getByTestId('session-place')).toHaveText('cloud');
  await expect(page.getByTestId('solve-row')).toHaveCount(2);
  await expect(page.getByTestId('stat-count')).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
  await expect(page.getByTestId('clip-badge').first()).toHaveText('1 clip, 3.0 MB');

  // The demo session marked as a real cube's, in its session.json: the next start's catch-up writes
  // it, with its attempt, to the index.
  await page.evaluate(async (sessionId) => {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle('sessions');
    const handle = await (
      await sessions.getDirectoryHandle(sessionId)
    ).getFileHandle('session.json');
    const session = JSON.parse(await (await handle.getFile()).text()) as {
      cube: Record<string, unknown>;
    };
    session.cube = {
      model: 'GAN 12 ui FreePlay',
      hardware: 'e2e-real',
      firmware: '2.3.1',
      gyro: true,
      // As the app writes the cube since T3.7: with its production date (none, a Gen2 cube).
      productDate: null,
    };
    const writable = await handle.createWritable();
    await writable.write(`${JSON.stringify(session, null, 2)}\n`);
    await writable.close();
  }, id);
  await page.goto('/sessions');
  await expect(row(page, id).getByTestId('session-place')).toHaveText('both');
  await expect(row(page, PHONE).getByTestId('session-place')).toHaveText('cloud');
  await expect
    .poll(async () => (await fakeAccountState(page)).indexWrites)
    .toEqual([`sessions/${id}`, `sessions/${id}/attempts/0001`]);

  const { index } = await fakeAccountState(page);
  const sessionDocument = index.sessions[id];
  expect(isSessionDocument(sessionDocument), JSON.stringify(isSessionDocument.errors)).toBe(true);
  expect(sessionDocument).toMatchObject({
    id,
    owner: ADA.uid,
    host: { label: 'e2e-laptop' },
    cube: { hardware: 'e2e-real' },
    summary: { attempts: 1, solved: 1, dnf: 0 },
  });
  const attemptDocument = index.attempts[id]['0001'];
  expect(isAttemptDocument(attemptDocument), JSON.stringify(isAttemptDocument.errors)).toBe(true);
  expect(attemptDocument).not.toHaveProperty('moves');
  expect(attemptDocument).toMatchObject({
    session: id,
    index: 1,
    owner: ADA.uid,
    device: { host: 'e2e-laptop', cameras: [] },
    upload: { state: 'pending', files: { 'attempt.json': { doneMs: null } } },
  });

  // The QA view: the laptop's attempt of today and the phone's two of yesterday.
  await page.getByTestId('qa-link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'QA' })).toBeVisible();
  const rows = page.getByTestId('qa-row');
  await expect(rows).toHaveCount(2);
  const shown = (attemptDocument['events'] as { scrambleShown: number }).scrambleShown;
  await expect(rows.nth(0)).toHaveAttribute('data-day', await dayOf(page, shown));
  await expect(rows.nth(0)).toHaveAttribute('data-device', 'e2e-laptop');
  await expect(rows.nth(0).getByTestId('qa-attempts')).toHaveText('1');
  await expect(rows.nth(0).getByTestId('qa-recorded')).toHaveText('0 B');
  await expect(rows.nth(1)).toHaveAttribute(
    'data-day',
    await dayOf(page, phone.attempts[0].events.scrambleShown),
  );
  await expect(rows.nth(1)).toHaveAttribute('data-device', 'e2e-phone');
  await expect(rows.nth(1).getByTestId('qa-attempts')).toHaveText('2');
  await expect(rows.nth(1).getByTestId('qa-clips')).toHaveText('2');
  await expect(rows.nth(1).getByTestId('qa-recorded')).toHaveText('6.0 MB');
  await expect(rows.nth(1).getByTestId('qa-uploaded')).toHaveText('0 B');
  await expect(rows.nth(1).getByTestId('qa-pending')).toHaveText('6.0 MB');
  const total = page.getByTestId('qa-total');
  await expect(total.getByTestId('qa-attempts')).toHaveText('3');
  await expect(page.getByTestId('qa-sync')).toContainText(
    'This device (e2e-laptop) last synced at',
  );
  await expect(page.getByTestId('qa-read')).toContainText('Read from your cloud index at');
});

test('signed out, the Sessions page has no badge, no device filter and no QA view, and Firebase never loads', async ({
  page,
}) => {
  await fakeAccount(page, { index: phoneIndex().index });
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Sessions' })
    .click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('session-attempts')).toHaveText('1 attempt');
  await expect(page.getByTestId('session-place')).toHaveCount(0);
  await expect(page.getByTestId('device-filter')).toHaveCount(0);
  await expect(page.getByTestId('qa-link')).toHaveCount(0);
  const state = await fakeAccountState(page);
  expect(state.loads).toBe(0);
  expect(state.indexWrites).toEqual([]);

  // The QA view by its address asks to sign in.
  await page.goto('/qa');
  await expect(page.getByTestId('qa-signed-out')).toBeVisible();
  expect((await fakeAccountState(page)).loads).toBe(0);
});
