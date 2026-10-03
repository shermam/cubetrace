import { describe, expect, it } from 'vitest';

import { Crc32, crc32 } from './index';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32', () => {
  it('gives the known values of the check vectors', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(text('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(text('a'))).toBe(0xe8b7be43);
    // Four zero bytes: 0x2144DF1C, which also shows the value is unsigned.
    expect(crc32(new Uint8Array(4))).toBe(0x2144df1c);
  });

  it('continues over pieces: the checksum of the parts in order is that of the whole', () => {
    const whole = text('The quick brown fox jumps over the lazy dog');
    let rolling = 0;
    let at = 0;
    for (const size of [1, 7, 10, 3, 100]) {
      rolling = crc32(whole.slice(at, at + size), rolling);
      at += size;
    }
    expect(rolling).toBe(0x414fa339);
    const bytes = new Uint8Array(100_000).map((_, k) => (k * 7919) & 0xff);
    const direct = crc32(bytes);
    const stream = new Crc32();
    for (let at = 0; at < bytes.length; at += 4096) {
      stream.update(bytes.subarray(at, Math.min(at + 4096, bytes.length)));
    }
    expect(stream.value).toBe(direct);
    // Another order, or a flipped bit, is another value.
    expect(crc32(bytes.slice(50_000), crc32(bytes.slice(0, 50_000)))).toBe(direct);
    expect(crc32(bytes.slice(0, 50_000), crc32(bytes.slice(50_000)))).not.toBe(direct);
    bytes[31_337] ^= 0x10;
    expect(crc32(bytes)).not.toBe(direct);
  });

  it('starts again when reset', () => {
    const stream = new Crc32();
    expect(stream.value).toBe(0);
    stream.update(text('123456789'));
    expect(stream.value).toBe(0xcbf43926);
    stream.reset();
    expect(stream.value).toBe(0);
    expect(stream.update(text('a')).value).toBe(0xe8b7be43);
  });
});
