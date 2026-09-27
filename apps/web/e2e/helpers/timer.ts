import { type Locator, type Page, expect } from '@playwright/test';

// The Timer page as the flows read it: its data-testids (src/app/timer/*.ts), and the address that
// connects the demo cube (src/app/cube/demo.ts).

/**
 * The Timer page with the demo cube replaying demo solve `index` at `speed`
 * (`?demo=<index>&speed=<speed>`), and with a wrong turn after scramble move `misscramble` when it
 * is given (`&misscramble=<k>`).
 */
export function demoPath(index: number, speed: number, misscramble?: number): string {
  const query = new URLSearchParams({ demo: String(index), speed: String(speed) });
  if (misscramble !== undefined) {
    query.set('misscramble', String(misscramble));
  }
  return `/?${query.toString()}`;
}

/** A time as the timer writes it ("12.34", "1:02.34"), in ms. */
export function parseTime(text: string): number {
  const match = /^(?:(\d+):)?(\d+)\.(\d\d)$/.exec(text.trim());
  if (match === null) {
    throw new Error(`"${text}" is not a time.`);
  }
  const [, minutes = '0', seconds, hundredths] = match;
  return (Number(minutes) * 60 + Number(seconds)) * 1000 + Number(hundredths) * 10;
}

/** The trimmed text of the first element with `testId`. */
export async function textOf(page: Page, testId: string): Promise<string> {
  return ((await page.getByTestId(testId).first().textContent()) ?? '').trim();
}

/** The solve list's rows, newest first. */
export function solveRows(page: Page): Locator {
  return page.getByTestId('solve-row');
}

/**
 * Waits until the solve list has `count` rows and they are saved in the origin private file
 * system. The first wait allows for a cold dev server and for the demo cube's replay.
 */
export async function expectSolves(page: Page, count: number): Promise<void> {
  await expect(solveRows(page)).toHaveCount(count, { timeout: 30_000 });
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

/** The id of the session the Timer page records, as it keeps it for a reload (`localStorage`). */
export function currentSessionId(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('cubetrace.currentSession'));
}
