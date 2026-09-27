import { DNF } from '@cubetrace/core';

import { formatAverage, formatTime } from './format-time';

describe('formatTime', () => {
  it('writes s.cc under a minute and m:ss.cc from one minute on', () => {
    expect(formatTime(0)).toBe('0.00');
    expect(formatTime(10)).toBe('0.01');
    expect(formatTime(1074.85)).toBe('1.07');
    expect(formatTime(12_340)).toBe('12.34');
    expect(formatTime(59_999)).toBe('59.99');
    expect(formatTime(60_000)).toBe('1:00.00');
    expect(formatTime(62_345)).toBe('1:02.34');
    expect(formatTime(754_321)).toBe('12:34.32');
  });

  it('truncates to the hundredth, as WCA times are', () => {
    expect(formatTime(9.999)).toBe('0.00');
    expect(formatTime(12_349.9)).toBe('12.34');
  });

  it('writes a negative time as 0.00, a DNF as DNF and anything else as a dash', () => {
    expect(formatTime(-5)).toBe('0.00');
    expect(formatTime(DNF)).toBe('DNF');
    expect(formatTime(Number.NaN)).toBe('–');
  });
});

describe('formatAverage', () => {
  it('rounds to the nearest hundredth, as WCA averages are', () => {
    expect(formatAverage(12_345)).toBe('12.35');
    expect(formatAverage(12_344.9)).toBe('12.34');
    expect(formatAverage(DNF)).toBe('DNF');
  });
});
