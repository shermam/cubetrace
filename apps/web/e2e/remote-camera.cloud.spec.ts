import { type Locator, type Page, expect, test } from '@playwright/test';

import {
  type GoogleAccount,
  firestoreCollection,
  firestoreDocument,
  useEmulators,
} from './helpers/emulators';
import { currentSessionId, demoPath } from './helpers/timer';

// A remote camera paired through the Firestore emulator (docs/PLAN.md T4.1, docs/RTC.md §5) with the
// app's own Firebase SDK (npm run e2e:cloud): the host (the demo cube, signed in through the Auth
// emulator) adds a camera: its session's document gets the pairing (its token's hash); a second page
// of the browser opens the QR's URL, writes its peer document with the offer, the host answers in it,
// both sides' candidates appear under it, the data channel opens, and the pairing is closed; Leave
// deletes the peer document with its candidates.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

const ADA: GoogleAccount = {
  sub: 'e2e-ada-rtc',
  email: 'ada-rtc@example.com',
  name: 'Ada Lovelace',
};

function banner(page: Page): Locator {
  return page.getByRole('banner');
}

test('two pages pair through the Firestore emulator: the pairing in the session document, the peer document with the offer, the answer and the candidates, deleted at Leave', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await useEmulators(page, ADA);
  await page.goto(demoPath(0, 20));
  await expect.poll(() => currentSessionId(page), { timeout: 30_000 }).not.toBeNull();
  const sessionId = (await currentSessionId(page)) ?? '';
  await banner(page).getByRole('button', { name: 'Sign in' }).click();
  await expect(banner(page).getByRole('button', { name: 'Account: Ada Lovelace' })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('add-camera').click();
  const pairing = page.getByTestId('pairing');
  await expect(pairing).toBeVisible({ timeout: 30_000 });
  const url = new URL((await page.getByTestId('pairing-url').textContent()) ?? '');
  expect(url.searchParams.get('session')).toBe(sessionId);
  // The demo session's document went to the index for the pairing, which holds the token's hash.
  await expect
    .poll(async () => (await firestoreDocument(`sessions/${sessionId}`))?.['pairing'], {
      timeout: 15_000,
    })
    .toMatchObject({
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresMs: expect.any(Number),
    });
  const tokenHash = (
    (await firestoreDocument(`sessions/${sessionId}`))?.['pairing'] as { tokenHash: string }
  ).tokenHash;

  // The phone: the second page, signed in to the same account through the emulator's persistence.
  const phone = await context.newPage();
  await useEmulators(phone, ADA);
  await phone.goto(`${url.pathname}${url.search}`);
  const state = phone.getByTestId('device-state');
  await expect(state).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
  await expect(page.getByTestId('remote-camera')).toHaveAttribute('data-state', 'connected');

  // The peer document, as the phone created it and the host answered it, with both sides' candidates.
  const peers = await firestoreCollection(`sessions/${sessionId}/peers`);
  const [peerId, peer] = Object.entries(peers)[0] ?? ['', {}];
  expect(Object.keys(peers)).toHaveLength(1);
  expect(peer).toMatchObject({
    schema: 1,
    role: 'camera',
    tokenHash,
    state: 'answered',
    offer: { type: 'offer' },
    answer: { type: 'answer' },
  });
  expect(String((peer['offer'] as { sdp: string }).sdp)).toMatch(/^v=0/);
  expect(String((peer['answer'] as { sdp: string }).sdp)).toMatch(/^v=0/);
  const callers = await firestoreCollection(
    `sessions/${sessionId}/peers/${peerId}/callerCandidates`,
  );
  const callees = await firestoreCollection(
    `sessions/${sessionId}/peers/${peerId}/calleeCandidates`,
  );
  expect(Object.keys(callers).length).toBeGreaterThan(0);
  expect(Object.keys(callees).length).toBeGreaterThan(0);
  for (const candidate of [...Object.values(callers), ...Object.values(callees)]) {
    expect(candidate).toMatchObject({
      candidate: expect.any(String),
      createdMs: expect.any(Number),
    });
  }
  // The pairing is closed: the token is taken.
  expect((await firestoreDocument(`sessions/${sessionId}`))?.['pairing']).toBeNull();

  // Leave: the host deletes the peer document and its candidates.
  await phone.getByTestId('device-leave').click();
  await expect(state).toHaveAttribute('data-state', 'left');
  await expect(page.getByTestId('remote-camera')).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => Object.keys(await firestoreCollection(`sessions/${sessionId}/peers`)), {
      timeout: 15_000,
    })
    .toEqual([]);
  await expect
    .poll(
      async () =>
        Object.keys(
          await firestoreCollection(`sessions/${sessionId}/peers/${peerId}/callerCandidates`),
        ),
      { timeout: 15_000 },
    )
    .toEqual([]);
  await phone.close();
});
