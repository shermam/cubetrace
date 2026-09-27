import { sessionMean, sessionStats } from './session-stats';
import { testAttempt } from './session-testing';

describe('sessionStats', () => {
  it('has dashes before the first attempt', () => {
    expect(sessionStats([])).toEqual({
      count: 0,
      dnf: 0,
      mean: '–',
      best: '–',
      ao5: '–',
      ao12: '–',
      ao100: '–',
    });
  });

  it('counts, averages and picks the best, with WCA averages of 5 and 12', () => {
    const times = [10_000, 12_000, 11_000, 13_000, 14_000];
    const attempts = times.map((ms, k) => testAttempt(k + 1, ms));
    expect(sessionStats(attempts)).toEqual({
      count: 5,
      dnf: 0,
      mean: '12.00',
      best: '10.00',
      ao5: '12.00',
      ao12: '–',
      ao100: '–',
    });
  });

  it('counts a DNF as the worst result: the mean is DNF, ao5 drops one, two make it DNF', () => {
    const one = [10_000, 12_000, null, 11_000, 13_000].map((ms, k) => testAttempt(k + 1, ms));
    expect(sessionStats(one)).toMatchObject({ dnf: 1, mean: 'DNF', best: '10.00', ao5: '12.00' });
    const two = [...one.slice(0, 4), testAttempt(5, null)];
    expect(sessionStats(two)).toMatchObject({ dnf: 2, mean: 'DNF', ao5: 'DNF' });
    expect(sessionMean([testAttempt(1, null)])).toBe('DNF');
  });

  it('computes ao12 over the last twelve', () => {
    const attempts = Array.from({ length: 13 }, (_, k) => testAttempt(k + 1, 10_000 + k * 1000));
    // The last twelve: 11..22 s; without the best and the worst, 12..21 s: 16.5 s.
    expect(sessionStats(attempts).ao12).toBe('16.50');
    expect(sessionStats(attempts).ao100).toBe('–');
  });

  it('computes ao100 over the last hundred, one DNF dropped as the worst', () => {
    // 101 attempts: 10.00 s, then 10.01 … 10.99 s, then a DNF. The last hundred are 10.01 … 10.99 s
    // and the DNF; without 10.01 and the DNF, 10.02 … 10.99 s: 10.505 s, 10.51 rounded.
    const attempts = [
      ...Array.from({ length: 100 }, (_, k) => testAttempt(k + 1, 10_000 + k * 10)),
      testAttempt(101, null),
    ];
    expect(sessionStats(attempts)).toMatchObject({ count: 101, dnf: 1, ao100: '10.51' });
  });
});
