import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

// The cube connection (docs/PLAN.md, T1.6a and T1.12) end to end. Headless Chromium has no Web
// Bluetooth, so the cube is the demo cube: the fake cube replaying public/demo/solves.json, which
// scripts/write-demo-solves.mts writes before the dev server and the build start. For the same
// reason, "Connect a cube" opens the dialog that says so instead of Chrome's device picker.
const pagesUrl = 'http://localhost:4300/cubetrace/';
const SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

interface DemoFile {
  solves: {
    scramble: string;
    scrambled_facelets: string;
    moves: { m: string; ms: number }[];
    time_ms: number;
  }[];
}

interface ServiceWorkerManifest {
  assetGroups: { name: string; urls: string[] }[];
}

async function demoFile(request: APIRequestContext, base: string): Promise<DemoFile> {
  const response = await request.get(`${base}demo/solves.json`);
  expect(response.status()).toBe(200);
  return (await response.json()) as DemoFile;
}

/** The move log's cells, row by row (newest move first). */
function logRows(page: Page): Promise<string[][]> {
  return page
    .getByTestId('move-log')
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => Array.from(row.querySelectorAll('td'), (td) => td.textContent.trim())),
    );
}

/** Waits for demo solve `index` to be replayed completely at `speed`, then checks the panel. */
async function expectReplayed(page: Page, file: DemoFile, index: number): Promise<void> {
  const solve = file.solves[index];
  const total =
    solve.scramble.split(' ').reduce((n, move) => n + (move.endsWith('2') ? 2 : 1), 0) +
    solve.moves.length;
  await expect(page.getByTestId('cube-status')).toHaveText('Fake cube · 100%');
  await expect(page.getByTestId('move-log')).toHaveAttribute('data-move-count', String(total), {
    timeout: 15_000,
  });
  await expect(page.getByTestId('cube-solved')).toHaveText('Solved');
  await expect(page.getByTestId('cube-net')).toHaveAttribute('data-facelets', SOLVED);

  // The last 20 moves, newest first: the solution's, numbered, in the order the cube reported
  // them, with cube times that never go back and gaps equal to the recorded ones.
  const rows = await logRows(page);
  const expected = solve.moves.slice(-20).reverse();
  expect(rows.map((row) => row[1])).toEqual(expected.map((move) => move.m));
  expect(rows.map((row) => Number(row[0]))).toEqual(expected.map((_, i) => total - i));
  const cubeMs = rows.map((row) => Number(row[2]));
  for (let i = 1; i < cubeMs.length; i++) {
    expect(cubeMs[i - 1]).toBeGreaterThanOrEqual(cubeMs[i]);
  }
  expect(rows.slice(0, -1).map((row) => Number(row[3]))).toEqual(
    expected.slice(0, -1).map((move, i) => move.ms - expected[i + 1].ms),
  );
}

test('?demo=0&speed=20 replays demo solve 0: the pill, the move log in cube order, then Solved', async ({
  page,
  request,
}) => {
  const file = await demoFile(request, '/');
  expect(file.solves).toHaveLength(30);

  await page.goto('/?demo=0&speed=20');
  await expectReplayed(page, file, 0);
});

test('the production build under /cubetrace/: the demo solves load only when a demo starts', async ({
  page,
  request,
}) => {
  // Not prefetched by the service worker, and small.
  const ngsw = (await (await request.get(`${pagesUrl}ngsw.json`)).json()) as ServiceWorkerManifest;
  const cached = ngsw.assetGroups.flatMap((group) => group.urls);
  expect(cached.filter((url) => url.includes('/demo/'))).toEqual([]);
  const response = await request.get(`${pagesUrl}demo/solves.json`);
  expect((await response.body()).byteLength).toBeLessThan(100_000);
  const file = (await response.json()) as DemoFile;

  const demoRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/demo/')) {
      demoRequests.push(r.url());
    }
  });
  await page.goto(pagesUrl);
  await expect(page.getByTestId('scramble')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('cube-status')).toHaveText('Connect cube');
  expect(demoRequests).toEqual([]);

  await page.goto(`${pagesUrl}?demo=0&speed=20`);
  await expectReplayed(page, file, 0);
  expect(demoRequests).toEqual([`${pagesUrl}demo/solves.json`]);
});

test('no Web Bluetooth here: "Connect a cube" opens the dialog that says so; Demo cube connects and closes it', async ({
  page,
}) => {
  await page.goto('/');
  const pill = page.getByTestId('cube-status');
  await expect(pill).toHaveText('Connect cube');

  await page.getByTestId('timer-connect').click();
  const dialog = page.getByRole('dialog', { name: 'Cube' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-reason', 'support');
  await expect(dialog.getByTestId('bluetooth-hint')).toContainText(
    'This browser cannot connect to a Bluetooth cube.',
  );
  await expect(dialog.getByRole('button', { name: 'Connect cube' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'Demo cube' }).click();
  await expect(pill).toHaveText('Fake cube · 100%');
  // Connected: back on the page.
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('timer-connect')).toBeHidden();
  await expect(page.getByTestId('move-log')).not.toHaveAttribute('data-move-count', '0');

  // The pill opens the cube's details, which stay open.
  await pill.click();
  await expect(dialog).toHaveAttribute('data-reason', 'details');
  await expect(dialog.getByTestId('connect-state')).toHaveText('Connected to the demo cube.');
  await expect(dialog.getByTestId('cube-details')).toContainText('Fake cube');

  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(pill).toHaveText('Connect cube');
  await expect(dialog.getByTestId('connect-state')).toHaveText(
    'Last connection: Disconnected on request.',
  );
});

test('"Try the demo" on the Timer page connects the demo cube in one click, at the address\'s ?speed', async ({
  page,
}) => {
  await page.goto('/?speed=20');
  const pill = page.getByTestId('cube-status');
  await expect(pill).toHaveText('Connect cube');

  await page
    .getByRole('region', { name: 'Time' })
    .getByRole('button', { name: 'Try the demo' })
    .click();
  await expect(pill).toHaveText('Fake cube · 100%');
  await expect(page.getByRole('dialog', { name: 'Cube' })).toBeHidden();
  await expect(page.getByTestId('timer-connect')).toBeHidden();
  await expect(page.getByTestId('move-log')).not.toHaveAttribute('data-move-count', '0');

  await pill.click();
  await expect(page.getByRole('dialog', { name: 'Cube' })).toContainText(/at 20× speed/);
});

test('the connect dialog works from the keyboard', async ({ page }) => {
  await page.goto('/');
  const pill = page.locator('app-cube-status-pill').getByTestId('cube-status');
  await expect(pill).toHaveText('Connect cube');

  await pill.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Cube' });
  await expect(dialog).toBeVisible();
  // A modal dialog keeps the focus inside it.
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(pill).toBeFocused();
});

test('Settings: a MAC address survives a reload; an invalid one is refused', async ({ page }) => {
  await page.goto('/settings');
  const list = page.getByTestId('cube-macs');
  await expect(list).toHaveText('None stored.');

  await page.getByLabel('Cube name', { exact: true }).fill('GAN12ui_E2E1');
  await page.getByLabel('MAC address', { exact: true }).fill('ab-12-cd-34-ef-56');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(list).toContainText('GAN12ui_E2E1');
  await expect(list).toContainText('AB:12:CD:34:EF:56');

  await page.getByLabel('Cube name', { exact: true }).fill('GAN356i3_E2E2');
  await page.getByLabel('MAC address', { exact: true }).fill('AB:12:CD:34:EF');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('mac-error')).toContainText(
    '"AB:12:CD:34:EF" is not a MAC address',
  );
  await expect(list).not.toContainText('GAN356i3_E2E2');

  await page.reload();
  await expect(list).toContainText('GAN12ui_E2E1');
  await expect(list).toContainText('AB:12:CD:34:EF:56');
  await expect(list).not.toContainText('GAN356i3_E2E2');
});

test('Settings: the idle disconnection is 5 minutes by default, and a new value survives a reload', async ({
  page,
}) => {
  await page.goto('/settings');
  const idle = page.getByLabel('Disconnect the cube after this many minutes without a turn');
  await expect(idle).toHaveValue('5');

  await idle.fill('1');
  await idle.blur();
  await page.reload();
  await expect(idle).toHaveValue('1');

  await idle.fill('61');
  await idle.blur();
  await expect(page.getByTestId('idle-error')).toHaveText(
    'The minutes must be a whole number from 0 to 60.',
  );
  await page.reload();
  await expect(idle).toHaveValue('1');
});
