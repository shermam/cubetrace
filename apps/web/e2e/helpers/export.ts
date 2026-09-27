import { readFile } from 'node:fs/promises';

import { type Page, expect } from '@playwright/test';
import {
  ATTEMPT_SCHEMA,
  SESSION_SCHEMA,
  type AttemptRecord,
  type SessionRecord,
} from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';

// A session's export, downloaded from the Sessions page and validated against the JSON Schemas of
// session.json and attempt.json (packages/core/schema/, docs/DATA-MODEL.md §6 and §7).

/** What the Sessions page exports for a session: one JSON file, `{session, attempts}`. */
export interface SessionExport {
  readonly session: SessionRecord;
  readonly attempts: readonly AttemptRecord[];
}

// Draft 2020-12, with the options packages/core/src/schemas.ts documents; every error, not just the
// first.
const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isSession = ajv.compile<SessionRecord>(SESSION_SCHEMA);
const isAttempt = ajv.compile<AttemptRecord>(ATTEMPT_SCHEMA);

/**
 * `json` as a session export: an object whose `session` is valid against session.schema.json and
 * whose `attempts` are each valid against attempt.schema.json. Throws otherwise, with ajv's errors
 * (such as "attempts[0]/crossFace must be equal to one of the allowed values"), which fails the
 * test.
 */
export function validateExport(json: unknown): SessionExport {
  if (typeof json !== 'object' || json === null) {
    throw new Error('The export is not a JSON object.');
  }
  const session: unknown = Reflect.get(json, 'session');
  if (!isSession(session)) {
    throw new Error(`session.json: ${ajv.errorsText(isSession.errors, { dataVar: 'session' })}`);
  }
  const attempts: unknown = Reflect.get(json, 'attempts');
  if (!Array.isArray(attempts)) {
    throw new Error('The export has no list of attempts.');
  }
  return {
    session,
    attempts: attempts.map((attempt: unknown, i) => {
      if (!isAttempt(attempt)) {
        const dataVar = `attempts[${String(i)}]`;
        throw new Error(`attempt.json: ${ajv.errorsText(isAttempt.errors, { dataVar })}`);
      }
      return attempt;
    }),
  };
}

/**
 * Opens the Sessions page from the top navigation (no reload: the app keeps running), exports the
 * one session of this browser context, and returns the downloaded file, validated by
 * {@link validateExport}.
 */
export async function exportSession(page: Page): Promise<SessionExport> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Sessions' })
    .click();
  const row = page.getByTestId('session-row');
  await expect(row).toHaveCount(1);
  const id = (await row.getAttribute('data-session')) ?? '';

  const downloading = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Export' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`cubetrace-session-${id}.json`);
  const exported = validateExport(JSON.parse(await readFile(await download.path(), 'utf8')));
  expect(exported.session.id).toBe(id);
  return exported;
}
