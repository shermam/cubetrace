import { describe, expect, it } from 'vitest';

import {
  CAMERA_PATH,
  PAIRING_TTL_MS,
  TOKEN_ALPHABET,
  TOKEN_LENGTH,
  checkPairing,
  generateToken,
  hashToken,
  isTokenHash,
  normalizeToken,
  pairingOf,
  pairingUrl,
  parsePairingInput,
} from './index';

const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
/** SHA-256 of "ABCDEFGH", computed apart. */
const HASH_ABCDEFGH = '9ac2197d9258257b1ae8463e4214e4cd0a578bc1517f2415928b91be4283fc48';

describe('the pairing token', () => {
  it("is eight characters of Crockford's alphabet, from the platform's random bytes", () => {
    expect(TOKEN_ALPHABET).toHaveLength(32);
    expect(TOKEN_ALPHABET).not.toMatch(/[ILOU]/);
    expect(TOKEN_LENGTH).toBe(8);
    const tokens = new Set<string>();
    for (let k = 0; k < 100; k++) {
      const token = generateToken();
      expect(token).toMatch(new RegExp(`^[${TOKEN_ALPHABET}]{8}$`));
      tokens.add(token);
    }
    expect(tokens.size).toBeGreaterThan(95);
    // The bytes given decide the characters: one per byte, modulo 32.
    expect(
      generateToken((bytes) => {
        bytes.set([0, 1, 31, 32, 33, 255, 10, 20]);
      }),
    ).toBe('01Z01ZAM');
  });

  it('normalizes what is typed: case, spaces and hyphens, and the lookalikes I, L and O', () => {
    expect(normalizeToken('7r2k-q9wx')).toBe('7R2KQ9WX');
    expect(normalizeToken(' 7R2K Q9WX ')).toBe('7R2KQ9WX');
    expect(normalizeToken('ilo0-ILO1')).toBe('11001101');
    for (const bad of ['', '7R2KQ9W', '7R2KQ9WXA', '7R2KQ9W!', 'UUUUUUUU', '7R2K Q9W']) {
      expect(normalizeToken(bad), bad).toBeNull();
    }
  });

  it('hashes a token with SHA-256 as 64 lowercase hex digits', async () => {
    const hash = await hashToken('ABCDEFGH');
    expect(hash).toBe(HASH_ABCDEFGH);
    expect(isTokenHash(hash)).toBe(true);
    expect(isTokenHash(hash.toUpperCase())).toBe(false);
    expect(isTokenHash('ABCDEFGH')).toBe(false);
    expect(await hashToken('ABCDEFGI')).not.toBe(hash);
  });

  it('makes the QR code URL under the app and reads it back, or a token typed by hand', () => {
    const url = pairingUrl('https://shermam.github.io/cubetrace/', SESSION, '7R2KQ9WX');
    expect(url).toBe(
      `https://shermam.github.io/cubetrace/camera?session=${SESSION}&token=7R2KQ9WX`,
    );
    expect(CAMERA_PATH).toBe('camera');
    expect(parsePairingInput(url)).toEqual({ sessionId: SESSION, token: '7R2KQ9WX' });
    // The app served at the root, and a URL typed with another case.
    expect(pairingUrl(new URL('http://localhost:4200/'), SESSION, 'A1B2C3D4')).toBe(
      `http://localhost:4200/camera?session=${SESSION}&token=A1B2C3D4`,
    );
    expect(
      parsePairingInput(`http://localhost:4200/camera?session=${SESSION}&token=a1b2-c3d4`),
    ).toEqual({
      sessionId: SESSION,
      token: 'A1B2C3D4',
    });
    expect(parsePairingInput(' 7r2k q9wx ')).toEqual({ sessionId: null, token: '7R2KQ9WX' });
    for (const bad of [
      '',
      'hello',
      `http://localhost:4200/camera?session=${SESSION}`,
      'http://localhost:4200/camera?token=7R2KQ9WX',
      `http://x/camera?session=${SESSION}&token=bad`,
    ]) {
      expect(parsePairingInput(bad), bad).toBeNull();
    }
  });

  it('publishes a hash good for ten minutes, and takes a token only within them and with the same hash', async () => {
    const now = 1_790_000_000_000;
    const pairing = await pairingOf('ABCDEFGH', now);
    expect(pairing).toEqual({ tokenHash: HASH_ABCDEFGH, expiresMs: now + PAIRING_TTL_MS });
    expect(PAIRING_TTL_MS).toBe(600_000);
    expect((await pairingOf('ABCDEFGH', now, 1000)).expiresMs).toBe(now + 1000);
    expect(checkPairing(pairing, HASH_ABCDEFGH, now)).toBeNull();
    expect(checkPairing(pairing, HASH_ABCDEFGH, now + PAIRING_TTL_MS - 1)).toBeNull();
    expect(checkPairing(pairing, HASH_ABCDEFGH, now + PAIRING_TTL_MS)).toBe('expired');
    expect(checkPairing(pairing, await hashToken('ABCDEFGI'), now)).toBe('wrong-token');
    expect(checkPairing(null, HASH_ABCDEFGH, now)).toBe('no-pairing');
    expect(checkPairing(undefined, HASH_ABCDEFGH, now)).toBe('no-pairing');
  });
});
