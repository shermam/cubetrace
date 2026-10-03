import jsQR from 'jsqr';

import { qrCode, qrSvgPath, qrVersionFor, type QrCode } from './qr-code';

/** The pairing URL of a session, as the host shows it (docs/RTC.md §5): about 100 characters. */
const PAIRING_URL =
  'https://shermam.github.io/cubetrace/camera?session=3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f&token=7KQM2XAB';

/**
 * The code as a reader sees it: a grey image of `scale` pixels per module with a quiet zone of four
 * modules, and the text the reader finds in it (jsQR, a pure JavaScript reader).
 */
function decode(code: QrCode, scale = 4): string | null {
  const quiet = 4;
  const side = (code.size + 2 * quiet) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const [row, modules] of code.modules.entries()) {
    for (const [col, dark] of modules.entries()) {
      if (!dark) {
        continue;
      }
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = ((row + quiet) * scale + y) * side + (col + quiet) * scale + x;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, side, side)?.data ?? null;
}

describe('qrCode', () => {
  it('encodes the pairing URL in version 6 at level M, and a reader reads it back', () => {
    const code = qrCode(PAIRING_URL);
    expect(code.version).toBe(6);
    expect(code.size).toBe(41);
    expect(code.level).toBe('M');
    expect(code.mask).toBeGreaterThanOrEqual(0);
    expect(code.mask).toBeLessThan(8);
    expect(decode(code)).toBe(PAIRING_URL);
  });

  it.each([
    ['a token alone', '7KQM2XAB', 1],
    [
      'a short URL',
      'http://localhost:4200/camera?session=3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f&token=7KQM2XAB',
      6,
    ],
    ['a URL with UTF-8 in it', 'https://example.com/café?token=ÄÖÜ-1234567890-abc', 4],
    ['a text that needs version 7 (the version information)', 'x'.repeat(120), 7],
    ['a text that needs version 10 (a 16-bit count)', 'y'.repeat(200), 10],
  ])('encodes %s so that a reader reads it back', (_, text, version) => {
    const code = qrCode(text);
    expect(code.version).toBe(version);
    expect(decode(code)).toBe(text);
  });

  it('reads back at level L too, in a smaller version', () => {
    const code = qrCode(PAIRING_URL, 'L');
    expect(code.version).toBe(5);
    expect(decode(code)).toBe(PAIRING_URL);
  });

  it('knows the capacities of byte mode: 14 bytes in version 1, 213 in version 10 (level M)', () => {
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(106)).toBe(6);
    expect(qrVersionFor(107)).toBe(7);
    expect(qrVersionFor(213)).toBe(10);
    expect(qrVersionFor(214)).toBeNull();
    expect(() => qrCode('z'.repeat(214))).toThrow(/does not fit/);
  });

  it('draws the dark modules as one SVG path of unit squares inside the quiet zone', () => {
    const code = qrCode('7KQM2XAB');
    const path = qrSvgPath(code);
    // The finder pattern's top-left module, after the quiet zone of 4.
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true);
    const dark = code.modules.flat().filter((module) => module).length;
    expect(path.match(/M/g)).toHaveLength(dark);
    // Every square lies within the code's area.
    for (const match of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(4);
      expect(Number(match[1])).toBeLessThan(code.size + 4);
      expect(Number(match[2])).toBeGreaterThanOrEqual(4);
      expect(Number(match[2])).toBeLessThan(code.size + 4);
    }
  });
});
