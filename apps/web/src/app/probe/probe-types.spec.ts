import { describeAbsent, isAbsent } from './probe-types';

describe('isAbsent', () => {
  it('recognises the three one-key markers', () => {
    expect(isAbsent({ missing: 'navigator.bluetooth' })).toBe(true);
    expect(isAbsent({ error: 'NotAllowedError: denied' })).toBe(true);
    expect(isAbsent({ skipped: 'no camera API' })).toBe(true);
  });

  it('does not mistake readings for markers', () => {
    for (const value of [
      null,
      undefined,
      false,
      0,
      'missing',
      [],
      {},
      { missing: 1 },
      { missing: 'x', usage: 0 },
      { quota: 1 },
    ]) {
      expect(isAbsent(value)).toBe(false);
    }
  });
});

describe('describeAbsent', () => {
  it('writes one line per kind of marker', () => {
    expect(describeAbsent({ missing: 'VideoEncoder' })).toBe('not available: VideoEncoder');
    expect(describeAbsent({ error: 'TypeError: x' })).toBe('error: TypeError: x');
    expect(describeAbsent({ skipped: 'stopped' })).toBe('skipped: stopped');
  });
});
