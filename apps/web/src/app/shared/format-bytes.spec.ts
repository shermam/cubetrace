import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('writes bytes in decimal units, as Chrome shows storage', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(12_345)).toBe('12.3 kB');
    expect(formatBytes(5_300_000)).toBe('5.3 MB');
    expect(formatBytes(10_737_418_240)).toBe('10.7 GB');
    expect(formatBytes(3e15)).toBe('3000.0 TB');
  });
});
