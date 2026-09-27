import { expect, test } from '@playwright/test';

import { demoPath, expectSolves } from './helpers/timer';
import { recordTimerViews, timerViews } from './helpers/timer-views';

// Flow 6 of docs/PLAN.md, T1.9: the inspection switch in Settings. With it on, the armed attempt
// shows the WCA countdown from 15 on the timer; switched off again, the next armed attempt shows
// 0.00 and no countdown. The demo cube starts its solve as soon as the scramble is done, so the
// armed state lasts one render: the flow reads it from the record of the page's views.

test('Settings: inspection on shows the countdown when the next attempt is armed; off, it does not', async ({
  page,
}) => {
  await recordTimerViews(page);
  const inspection = page.getByLabel('15-second inspection (WCA)');

  await page.goto('/settings');
  await expect(inspection).not.toBeChecked();
  await inspection.check();
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  const on = (await timerViews(page)).filter((view) => view.phase === 'armed');
  expect(on.length).toBeGreaterThan(0);
  expect(on[0]).toMatchObject({
    status: 'Inspection: the timer starts with your first turn.',
    kind: 'inspection',
    time: '15',
  });

  await page.goto('/settings');
  await expect(inspection).toBeChecked();
  await inspection.uncheck();
  await page.goto(demoPath(1, 20));
  await expectSolves(page, 2);
  const views = await timerViews(page);
  const off = views.filter((view) => view.phase === 'armed');
  expect(off.length).toBeGreaterThan(0);
  for (const view of off) {
    expect(view).toMatchObject({
      status: 'Ready: the timer starts with your first turn.',
      kind: 'ready',
      time: '0.00',
    });
  }
  expect(views.filter((view) => view.kind === 'inspection')).toEqual([]);
});
