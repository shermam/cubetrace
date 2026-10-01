// When the queue tries a file again after a failure that a later try may not meet (the network, a
// server error): exponential backoff with jitter, so that a device that lost the network does not
// hammer it, and two devices that lost it together do not come back in step.

/** The first retry waits about this long. */
export const RETRY_FIRST_MS = 1000;

/** No retry waits longer. */
export const RETRY_MAX_MS = 5 * 60 * 1000;

/**
 * How long to wait before the next try of a file that failed `failures` times in a row (1 for the
 * first failure): 1 s, 2 s, 4 s, … doubling up to 5 min, each less a random share of up to half of
 * it (`random` in [0, 1), Math.random's), so between half the step and the step.
 */
export function retryDelay(failures: number, random: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 30));
  const step = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** exponent);
  const jitter = Math.min(Math.max(random, 0), 1);
  return Math.round(step * (1 - jitter / 2));
}
