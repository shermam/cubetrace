// The pairing token (docs/RTC.md, docs/PLAN.md T4.0): eight characters the host shows in a QR code
// and under it, which a phone scans or types to join the host's session as a camera. The token
// itself is never stored: the host writes its SHA-256 into the session's document (`pairing`), the
// phone presents the same hash in its peer document, and the host answers the first peer whose hash
// is its own, before the pairing expires. The alphabet is Crockford's base32, made for reading
// aloud and typing: no I, L, O or U, and a typed 1, l, i or 0, o is taken for what it looks like.
import { TOKEN_HASH, type SessionPairing } from '@cubetrace/core';

/** Crockford's base32 alphabet: digits and the capitals but I, L, O and U. */
export const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A token's length, in characters: 40 bits. */
export const TOKEN_LENGTH = 8;

/** How long the host takes a token after showing it, by default: 10 minutes. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** The path of the camera page, under the app's base. */
export const CAMERA_PATH = 'camera';

/** A new token, from the platform's random bytes (`crypto.getRandomValues`). */
export function generateToken(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = fillRandom,
): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  random(bytes);
  let token = '';
  for (const byte of bytes) {
    token += TOKEN_ALPHABET[byte % 32];
  }
  return token;
}

function fillRandom(bytes: Uint8Array<ArrayBuffer>): void {
  crypto.getRandomValues(bytes);
}

/**
 * A token as typed or scanned, normalized: upper case, without spaces or hyphens, the lookalikes
 * (I, L → 1, O → 0) corrected; null when it is not eight characters of the alphabet.
 */
export function normalizeToken(text: string): string | null {
  const token = text
    .toUpperCase()
    .replace(/[\s-]/gu, '')
    .replace(/[IL]/gu, '1')
    .replace(/O/gu, '0');
  if (token.length !== TOKEN_LENGTH) {
    return null;
  }
  for (const c of token) {
    if (!TOKEN_ALPHABET.includes(c)) {
      return null;
    }
  }
  return token;
}

/** SHA-256 of a normalized token, as 64 lowercase hex digits: what the documents hold. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether `hash` is a token's hash as the documents hold it. */
export function isTokenHash(hash: string): boolean {
  return TOKEN_HASH.test(hash);
}

/**
 * The URL the QR code carries: the camera page of the app at `appBase` (the app's own URL, such as
 * `https://shermam.github.io/cubetrace/`) with the session's id and the token.
 */
export function pairingUrl(appBase: string | URL, sessionId: string, token: string): string {
  const url = new URL(CAMERA_PATH, appBase);
  url.searchParams.set('session', sessionId);
  url.searchParams.set('token', token);
  return url.toString();
}

/** What a scanned QR code or a typed text says: the session, when it names one, and the token. */
export interface PairingInput {
  sessionId: string | null;
  token: string;
}

/**
 * The session and the token of a pairing URL, or of a token typed by hand (then no session); null
 * when the text is neither.
 */
export function parsePairingInput(text: string): PairingInput | null {
  const trimmed = text.trim();
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  if (url !== null) {
    const token = normalizeToken(url.searchParams.get('token') ?? '');
    const sessionId = url.searchParams.get('session');
    return token === null || sessionId === null || sessionId === '' ? null : { sessionId, token };
  }
  const token = normalizeToken(trimmed);
  return token === null ? null : { sessionId: null, token };
}

/** The pairing the host publishes for a token: its hash, good until `nowMs + ttlMs`. */
export async function pairingOf(
  token: string,
  nowMs: number,
  ttlMs: number = PAIRING_TTL_MS,
): Promise<SessionPairing> {
  return { tokenHash: await hashToken(token), expiresMs: nowMs + ttlMs };
}

/** Why a token is not taken ({@link checkPairing}). */
export type PairingRefusal = 'no-pairing' | 'expired' | 'wrong-token';

/**
 * Whether a session document's `pairing` takes the token whose hash is `tokenHash` at `nowMs`: null
 * when it does, else why not.
 */
export function checkPairing(
  pairing: SessionPairing | null | undefined,
  tokenHash: string,
  nowMs: number,
): PairingRefusal | null {
  if (pairing === null || pairing === undefined) {
    return 'no-pairing';
  }
  if (nowMs >= pairing.expiresMs) {
    return 'expired';
  }
  return pairing.tokenHash === tokenHash ? null : 'wrong-token';
}
