import { describe, expect, it } from 'vitest';

import { RETRY_FIRST_MS, RETRY_MAX_MS, retryDelay } from './backoff';

describe('retryDelay', () => {
  it('doubles from 1 s to 5 min, the most', () => {
    expect([1, 2, 3, 4, 9, 10, 11, 40].map((failures) => retryDelay(failures, 0))).toEqual([
      1000,
      2000,
      4000,
      8000,
      256_000,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
    ]);
    expect(retryDelay(0, 0)).toBe(RETRY_FIRST_MS);
  });

  it('takes off a random share of up to half of the step', () => {
    for (const failures of [1, 5, 12]) {
      const step = retryDelay(failures, 0);
      expect(retryDelay(failures, 0.5)).toBe(Math.round(step * 0.75));
      expect(retryDelay(failures, 0.999_999)).toBe(Math.round(step * (1 - 0.999_999 / 2)));
      for (let k = 0; k < 50; k++) {
        const delay = retryDelay(failures, Math.random());
        expect(delay).toBeGreaterThanOrEqual(step / 2);
        expect(delay).toBeLessThanOrEqual(step);
      }
    }
  });

  it('takes a random value outside [0, 1) as its bound', () => {
    expect(retryDelay(1, -1)).toBe(1000);
    expect(retryDelay(1, 2)).toBe(500);
  });
});
