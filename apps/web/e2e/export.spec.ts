import { expect, test } from '@playwright/test';

import { exportSession, validateExport } from './helpers/export';
import { demoPath, expectSolves, solveRows } from './helpers/timer';

// Flow 5 of docs/PLAN.md, T1.9: an exported session validates against the JSON Schemas of
// session.json and attempt.json (packages/core/schema/) with ajv. Every flow validates its export
// (helpers/export.ts); this one records the variants of an attempt in one session: solved after a
// corrected scramble, and a DNF during the solve, whose time, end and replay are null or false.

test('an exported session validates against the JSON Schemas of session.json and attempt.json', async ({
  page,
}) => {
  await page.goto(demoPath(1, 20, 3));
  await expectSolves(page, 1);
  // The next attempt in the same session: demo solve 13, slow enough to press Esc while solving.
  await page.goto(demoPath(13, 5));
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'solving', {
    timeout: 30_000,
  });
  await page.keyboard.press('Escape');
  await expect(solveRows(page).first()).toHaveAttribute('data-status', 'dnf');
  await expectSolves(page, 2);

  const exported = await exportSession(page);
  expect(exported.session.summary).toEqual({ attempts: 2, solved: 1, dnf: 1 });
  expect(
    exported.attempts.map(({ index, result }) => [index, result.status, result.scrambleCorrected]),
  ).toEqual([
    [1, 'solved', true],
    [2, 'dnf', false],
  ]);

  // The validation has teeth: a copy that breaks either schema fails with ajv's message.
  const [solved] = exported.attempts;
  expect(() => validateExport({ ...exported, attempts: [{ ...solved, crossFace: 'X' }] })).toThrow(
    'attempts[0]/crossFace must be equal to one of the allowed values',
  );
  expect(() =>
    validateExport({ ...exported, session: { ...exported.session, schema: 2 } }),
  ).toThrow('session/schema must be equal to constant');
});
