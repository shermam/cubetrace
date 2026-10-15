import { HttpsError } from 'firebase-functions/https';
import { describe, expect, it } from 'vitest';

import { countText, nextUtcDay, reserve, sizeText, usedOn, utcDay } from './quota.js';

const limits = { bytesPerDay: 2_000_000_000, filesPerDay: 400 };
/** 2026-10-01, a minute before midnight UTC, and midnight. */
const lateOnTheFirst = Date.UTC(2026, 9, 1, 23, 59, 0);
const midnight = Date.UTC(2026, 9, 2);

function refusal(run: () => unknown): HttpsError {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error('Nothing was refused.');
}

describe('the quota day', () => {
  it('is the UTC day, and ends at the next UTC midnight', () => {
    expect(utcDay(lateOnTheFirst)).toBe('2026-10-01');
    expect(utcDay(midnight - 1)).toBe('2026-10-01');
    expect(utcDay(midnight)).toBe('2026-10-02');
    expect(nextUtcDay(lateOnTheFirst)).toBe(midnight);
    expect(nextUtcDay(midnight)).toBe(Date.UTC(2026, 9, 3));
    expect(nextUtcDay(Date.UTC(2026, 11, 31, 12))).toBe(Date.UTC(2027, 0, 1));
  });

  it("reads the day's count, and nothing for another day or what cannot be read", () => {
    const stored = { day: '2026-10-01', bytes: 500, files: 2 };
    expect(usedOn(stored, '2026-10-01')).toEqual(stored);
    expect(usedOn(stored, '2026-10-02')).toEqual({ day: '2026-10-02', bytes: 0, files: 0 });
    for (const odd of [undefined, null, 'full', { day: '2026-10-01', bytes: -1, files: 2 }]) {
      expect(usedOn(odd, '2026-10-01')).toEqual({ day: '2026-10-01', bytes: 0, files: 0 });
    }
  });
});

describe('reserve', () => {
  it('adds a request to the day it is made', () => {
    expect(reserve(undefined, lateOnTheFirst, { bytes: 1_000, files: 3 }, limits)).toEqual({
      day: '2026-10-01',
      bytes: 1_000,
      files: 3,
    });
    expect(
      reserve(
        { day: '2026-10-01', bytes: 1_000, files: 3 },
        lateOnTheFirst,
        { bytes: 500, files: 2 },
        limits,
      ),
    ).toEqual({ day: '2026-10-01', bytes: 1_500, files: 5 });
  });

  it('allows a day to be filled exactly', () => {
    const used = { day: '2026-10-01', bytes: 1_999_999_000, files: 399 };
    expect(reserve(used, lateOnTheFirst, { bytes: 1_000, files: 1 }, limits)).toEqual({
      day: '2026-10-01',
      bytes: 2_000_000_000,
      files: 400,
    });
  });

  it.each([
    ['bytes', { day: '2026-10-01', bytes: 1_999_999_001, files: 10 }],
    ['files', { day: '2026-10-01', bytes: 10, files: 400 }],
  ])('refuses a request past the day’s %s, saying when it resets', (_, used) => {
    const error = refusal(() => reserve(used, lateOnTheFirst, { bytes: 1_000, files: 1 }, limits));
    expect(error.code).toBe('resource-exhausted');
    expect(error.message).toContain('2026-10-02T00:00:00.000Z');
    expect(error.details).toEqual({
      used,
      requested: { bytes: 1_000, files: 1 },
      limits,
      resetsAtMs: midnight,
    });
  });

  it('starts again at midnight UTC', () => {
    const full = { day: '2026-10-01', bytes: 2_000_000_000, files: 400 };
    expect(refusal(() => reserve(full, midnight - 1, { bytes: 1, files: 1 }, limits)).code).toBe(
      'resource-exhausted',
    );
    expect(reserve(full, midnight, { bytes: 1, files: 1 }, limits)).toEqual({
      day: '2026-10-02',
      bytes: 1,
      files: 1,
    });
  });

  it('says the counts in its refusal: what was signed, what the day allows, what was asked (T5.5)', () => {
    // The cap of 2026-10-15: 8,000 files and 40 GB a day, an attempt of four cameras 19 files.
    const day = { bytesPerDay: 40_000_000_000, filesPerDay: 8000 };
    const used = { day: '2026-10-01', bytes: 39_980_000_000, files: 7990 };
    const error = refusal(() =>
      reserve(used, lateOnTheFirst, { bytes: 85_200_000, files: 19 }, day),
    );
    expect(error.message).toBe(
      "The day's upload quota is used up: 7,990 files and 39.98 GB signed on 2026-10-01 (UTC) of " +
        'the 8,000 files and 40 GB a day; this call asks 19 files and 85.2 MB more. It resets at ' +
        '2026-10-02T00:00:00.000Z.',
    );
    expect(countText(1, 'file')).toBe('1 file');
    expect([sizeText(512), sizeText(14_000), sizeText(15_000_000_000)]).toEqual([
      '512 bytes',
      '14 kB',
      '15 GB',
    ]);
  });

  it('refuses a request larger than a whole day', () => {
    expect(
      refusal(() => reserve(undefined, midnight, { bytes: 2_000_000_001, files: 1 }, limits)).code,
    ).toBe('resource-exhausted');
  });
});
