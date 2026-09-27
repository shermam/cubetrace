import { expect, test } from '@playwright/test';

import { exportSession } from './helpers/export';
import { currentSessionId, demoPath, expectSolves, solveRows } from './helpers/timer';

// Issue #12 (docs/PLAN.md, T1.11) end to end, in Chromium's origin private file system: the files
// that a write cut short by a page load used to leave, an empty session.json and an empty
// attempt.json, no longer stop the Timer page from resuming the session, nor the Sessions page from
// listing, exporting and deleting; the broken session is listed apart and can be deleted.

/** The folder of a session whose session.json is empty. */
const BROKEN = '0badc0de-0000-4000-8000-000000000012';

test('an empty session.json or attempt.json is set aside: the session resumes, lists and exports, and the broken one is deleted', async ({
  page,
}) => {
  // One demo solve, saved.
  await page.goto(demoPath(0, 20));
  await expectSolves(page, 1);
  const id = (await currentSessionId(page)) ?? '';
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // What a write cut short leaves: an empty session.json in a session's folder, and an empty
  // attempt.json where the next attempt of the saved session goes.
  await page.evaluate(
    async ({ real, broken }) => {
      const root = await navigator.storage.getDirectory();
      const sessions = await root.getDirectoryHandle('sessions');
      const other = await sessions.getDirectoryHandle(broken, { create: true });
      await other.getFileHandle('session.json', { create: true });
      const saved = await sessions.getDirectoryHandle(real);
      const attempts = await saved.getDirectoryHandle('attempts');
      const next = await attempts.getDirectoryHandle('0002', { create: true });
      await next.getFileHandle('attempt.json', { create: true });
    },
    { real: id, broken: BROKEN },
  );

  // A new page load (without the demo): the Timer page resumes the session, without the empty
  // attempt, and has nothing to say about it.
  await page.goto('/');
  await expect(solveRows(page)).toHaveCount(1);
  await expect(page.getByTestId('attempt-index')).toHaveText('Attempt 2');
  await expect(page.getByText('could not be resumed')).toHaveCount(0);

  // The Sessions page lists the session, with the attempt it left out, and the broken one apart.
  await page.goto('/sessions');
  const row = page.getByTestId('session-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-session', id);
  await expect(row.getByTestId('session-attempts')).toHaveText('1 attempt');
  await expect(row.getByTestId('session-left-out')).toHaveText(
    `Left out: sessions/${id}/attempts/0002/attempt.json is empty.`,
  );
  const broken = page.getByTestId('unreadable-row');
  await expect(broken).toHaveCount(1);
  await expect(broken).toHaveAttribute('data-session', BROKEN);
  await expect(broken.getByTestId('unreadable-reason')).toHaveText(
    `sessions/${BROKEN}/session.json is empty.`,
  );
  await expect(page.getByTestId('sessions-error')).toHaveCount(0);

  // Export works, valid against the schemas, and leaves the empty attempt out.
  const exported = await exportSession(page);
  expect(exported.session.id).toBe(id);
  expect(exported.attempts.map((attempt) => attempt.index)).toEqual([1]);

  // Delete the broken session, after the confirmation: it is gone, from the page and the disk.
  await broken.getByRole('button', { name: 'Delete…' }).click();
  await broken.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('sessions-notice')).toHaveText(
    `Deleted the unreadable session ${BROKEN}.`,
  );
  await expect(page.getByTestId('unreadable-row')).toHaveCount(0);
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  const gone = await page.evaluate(async (folder) => {
    const sessions = await (await navigator.storage.getDirectory()).getDirectoryHandle('sessions');
    try {
      await sessions.getDirectoryHandle(folder);
      return false;
    } catch (error: unknown) {
      return error instanceof DOMException && error.name === 'NotFoundError';
    }
  }, BROKEN);
  expect(gone).toBe(true);
});
