// The daily upload quota of an account: what `signUpload` has signed for it on the current day (UTC),
// in bytes and in files, kept in `users/{uid}.quota` (docs/DATA-MODEL.md §10), which only the functions
// write. Every signature counts, a file signed again included: the quota measures what the account was
// allowed to put into the bucket, not what it did.
import { HttpsError } from 'firebase-functions/https';

/** `users/{uid}.quota`: the day it counts, `YYYY-MM-DD` in UTC, and what was signed on it. */
export interface Quota {
  readonly day: string;
  readonly bytes: number;
  readonly files: number;
}

/** What an account may have signed in one day. */
export interface QuotaLimits {
  readonly bytesPerDay: number;
  readonly filesPerDay: number;
}

/** The UTC day of `ms` (ms since 1970), `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first moment of the UTC day after the one of `ms`, in ms since 1970: when the quota resets. */
export function nextUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/**
 * What was signed on `day` according to `stored` (the document's `quota`): nothing when it counts
 * another day, or is missing or unreadable.
 */
export function usedOn(stored: unknown, day: string): Quota {
  if (
    typeof stored === 'object' &&
    stored !== null &&
    'day' in stored &&
    'bytes' in stored &&
    'files' in stored &&
    stored.day === day &&
    isCount(stored.bytes) &&
    isCount(stored.files)
  ) {
    return { day, bytes: stored.bytes, files: stored.files };
  }
  return { day, bytes: 0, files: 0 };
}

/**
 * The quota after signing `bytes` in `files` files at `nowMs`, from what is `stored`: the day's count
 * plus the request, or, on a new day, the request alone. Throws `resource-exhausted`, with what was
 * used, the limits and when they reset in its details, when the request does not fit in what is left.
 */
export function reserve(
  stored: unknown,
  nowMs: number,
  request: { readonly bytes: number; readonly files: number },
  limits: QuotaLimits,
): Quota {
  const used = usedOn(stored, utcDay(nowMs));
  const after: Quota = {
    day: used.day,
    bytes: used.bytes + request.bytes,
    files: used.files + request.files,
  };
  if (after.bytes > limits.bytesPerDay || after.files > limits.filesPerDay) {
    const resetsAtMs = nextUtcDay(nowMs);
    throw new HttpsError(
      'resource-exhausted',
      `The day's upload quota is used up: ${String(used.bytes)} bytes in ${String(used.files)} files ` +
        `signed on ${used.day} (UTC), ${String(request.bytes)} bytes in ${String(request.files)} files ` +
        `asked, ${String(limits.bytesPerDay)} bytes and ${String(limits.filesPerDay)} files a day ` +
        `allowed. It resets at ${new Date(resetsAtMs).toISOString()}.`,
      { used, requested: request, limits, resetsAtMs },
    );
  }
  return after;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
