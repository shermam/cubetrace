// Simulated remote clocks and networks for the tests of the clock sync (remote-clock.test.ts) and of
// the conversion of a remote clip's frame times (remote-frames.test.ts, T4.3): a phone's clock with an
// offset and a drift, round trips over a network of two legs, and pings at the cadence of
// `ClockPinger` (packages/rtc). Nothing in the package's index exports this file.
import type { RemoteClockFit } from './remote-clock';

/** A seeded pseudo-random generator (mulberry32), so that "random" tests are reproducible. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The host clock when the simulations start: a wall clock, as `performance.timeOrigin` is. */
export const H0 = 1_790_000_000_000;

/** A draw of an exponential distribution of mean `mean`, from a uniform draw in [0, 1). */
export function exponential(next: () => number, mean: number): number {
  return mean * -Math.log(1 - next());
}

/**
 * A phone's clock against the host's: `remote = host + offsetMs + drift · (host − H0)`, the drift in
 * parts per million (50 ppm: 3 ms a minute), and a network whose two legs each take half the base
 * round trip plus an exponential jitter of mean `jitterMs / 2` (most trips short, a few long, as
 * queues are), or the two legs `legs` gives (the way there, the way back), the phone answering within
 * `answerMs`. `ping(hostMs)` gives the four times of a round trip begun then.
 */
export function simulation(opts: {
  offsetMs: number;
  driftPpm: number;
  rttMs?: number;
  jitterMs?: number;
  legs?: (next: () => number) => [number, number];
  answerMs?: number;
  seed: number;
}) {
  const next = random(opts.seed);
  const drift = opts.driftPpm * 1e-6;
  const remote = (hostMs: number): number => hostMs + opts.offsetMs + drift * (hostMs - H0);
  const leg = (): number => (opts.rttMs ?? 0) / 2 + exponential(next, (opts.jitterMs ?? 0) / 2);
  return {
    remote,
    /** The true offset at a host time. */
    offsetAt: (hostMs: number): number => remote(hostMs) - hostMs,
    ping: (t1: number): [number, number, number, number] => {
      // The legs of `legs` drawn first; the default ones in the order the simulations always drew.
      const legs = opts.legs?.(next) ?? null;
      const arrived = t1 + (legs?.[0] ?? leg());
      const answered = arrived + (opts.answerMs ?? 1) * next();
      const t4 = answered + (legs?.[1] ?? leg());
      return [t1, remote(arrived), remote(answered), t4];
    },
  };
}

/**
 * The owner's home Wi-Fi as the diagnostics of 2026-10-04 describe it (the ThinkPhone and the
 * MacBook, 20.7 minutes paired): each leg 2.8 ms and a queue's exponential wait of 5 ms on average,
 * so that the least round trip of a window is about 6 ms and the median 13 to 15 ms; one ping in 20
 * held 100 to 300 ms on its way to the phone (Wi-Fi power saving: the access point keeps the frame
 * until the phone wakes), one answer in 100 held 20 to 80 ms on its way back.
 */
export function homeWifi(next: () => number): [number, number] {
  let there = 2.8 + exponential(next, 5);
  let back = 2.8 + exponential(next, 5);
  if (next() < 0.05) {
    there += 100 + 200 * next();
  }
  if (next() < 0.01) {
    back += 20 + 60 * next();
  }
  return [there, back];
}

/**
 * Two pages of one browser that both encode video, as the end-to-end suite pairs them on CI (T4.2's
 * probe: the least round trip 2 to 3 ms, the median 17 to 18): each leg a millisecond and an
 * exponential wait of 9 ms on average for the other page's busy main thread.
 */
export function loadedLoopback(next: () => number): [number, number] {
  return [1 + exponential(next, 9), 1 + exponential(next, 9)];
}

/** A round trip: `t1`, `t2`, `t3`, `t4`. */
export type Sample = [number, number, number, number];

/**
 * Pings as `ClockPinger` does (packages/rtc, T4.2b): every 500 ms from `from` until the fit has
 * converged or for the first 60 s, then every 2 s, for `seconds`; calls `each` with each round trip
 * once the fit has it. Returns the host time of the last ping.
 */
export function pinged(
  fit: RemoteClockFit,
  sim: ReturnType<typeof simulation>,
  seconds: number,
  each: (sample: Sample) => void = () => undefined,
  from = H0,
): number {
  let t = from;
  let fast = true;
  let last = t;
  while (t < from + seconds * 1000) {
    const sample = sim.ping(t);
    fit.addSample(...sample);
    each(sample);
    fast &&= !fit.converged && t - from < 60_000;
    last = t;
    t += fast ? 500 : 2000;
  }
  return last;
}
