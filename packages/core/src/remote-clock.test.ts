import { describe, expect, it } from 'vitest';

import {
  REMOTE_CLOCK_CONVERGED,
  REMOTE_CLOCK_DRIFT_SPAN_MS,
  REMOTE_CLOCK_MIN_KEPT,
  REMOTE_CLOCK_RTT_ALLOWANCE_MS,
  REMOTE_CLOCK_RTT_FACTOR,
  REMOTE_CLOCK_WINDOW,
  REMOTE_CLOCK_WINDOW_MS,
  RemoteClockFit,
} from './index';

/** A seeded pseudo-random generator (mulberry32), so that "random" tests are reproducible. */
function random(seed: number): () => number {
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
const H0 = 1_790_000_000_000;

/** A draw of an exponential distribution of mean `mean`, from a uniform draw in [0, 1). */
function exponential(next: () => number, mean: number): number {
  return mean * -Math.log(1 - next());
}

/**
 * A phone's clock against the host's: `remote = host + offsetMs + drift · (host − H0)`, the drift in
 * parts per million (50 ppm: 3 ms a minute), and a network whose two legs each take half the base
 * round trip plus an exponential jitter of mean `jitterMs / 2` (most trips short, a few long, as
 * queues are), or the two legs `legs` gives (the way there, the way back), the phone answering within
 * `answerMs`. `ping(hostMs)` gives the four times of a round trip begun then.
 */
function simulation(opts: {
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
function homeWifi(next: () => number): [number, number] {
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
function loadedLoopback(next: () => number): [number, number] {
  return [1 + exponential(next, 9), 1 + exponential(next, 9)];
}

type Sample = [number, number, number, number];

/**
 * Pings as `ClockPinger` does (packages/rtc, T4.2b): every 500 ms from `from` until the fit has
 * converged or for the first 60 s, then every 2 s, for `seconds`; calls `each` with each round trip
 * once the fit has it. Returns the host time of the last ping.
 */
function pinged(
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

/**
 * The rule of T4.0 to T4.2, for comparison: of the last 60 samples, those within 1.5 times the
 * least round trip or 3 ms over it, their median (or the line, past a minute), converged with ten of
 * them over ten seconds whose residuals spread by less than 3 ms. Gives how many it kept, and whether
 * it had converged.
 */
function bandRule(samples: readonly Sample[]): { kept: number; converged: boolean } {
  const window = samples.slice(-60).map(([t1, t2, t3, t4]) => ({
    hostMs: (t1 + t4) / 2,
    offsetMs: (t2 - t1 + (t3 - t4)) / 2,
    rttMs: t4 - t1 - (t3 - t2),
  }));
  const least = Math.min(...window.map((s) => s.rttMs));
  const kept = window.filter((s) => s.rttMs <= Math.max(1.5 * least, least + 3));
  const span = kept[kept.length - 1].hostMs - kept[0].hostMs;
  const t0 = kept.reduce((sum, s) => sum + s.hostMs, 0) / kept.length;
  const mean = kept.reduce((sum, s) => sum + s.offsetMs, 0) / kept.length;
  const sorted = kept.map((s) => s.offsetMs).sort((p, q) => p - q);
  const mid = Math.floor(sorted.length / 2);
  let a = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let b = 0;
  if (span > 60_000) {
    const sxx = kept.reduce((sum, s) => sum + (s.hostMs - t0) ** 2, 0);
    b = kept.reduce((sum, s) => sum + (s.hostMs - t0) * (s.offsetMs - mean), 0) / sxx;
    a = mean;
  }
  const residuals = kept.map((s) => s.offsetMs - (a + b * (s.hostMs - t0))).sort((p, q) => p - q);
  const at = (p: number): number => residuals[Math.max(0, Math.ceil(p * residuals.length) - 1)];
  return {
    kept: kept.length,
    converged: kept.length >= 10 && span >= 10_000 && at(0.9) - at(0.1) < 3,
  };
}

/** "after 12.0 s", or "never". */
function seconds(s: number | null): string {
  return s === null ? 'never' : `after ${s.toFixed(1)} s`;
}

/** The median of `values` (at least one). */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((p, q) => p - q);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * What a pairing of `seconds` did on the network `make` simulates, pinged as `ClockPinger` pings:
 * when the fit first converged (null if never), how many times it was withdrawn after, its offset's
 * error while converged (the worst, the 99th percentile) and at the end, and the round trips' least
 * and median; and, for comparison, what {@link bandRule} did on the same network pinged every 2 s,
 * as T4.0 to T4.2 pinged (when it converged, how many times it was withdrawn, how many it kept once
 * the window was full).
 */
function pairing(make: () => ReturnType<typeof simulation>, seconds: number) {
  const sim = make();
  const fit = new RemoteClockFit();
  const samples: Sample[] = [];
  const outcome = { first: null as number | null, withdrawn: 0, worstMs: 0, p99Ms: 0, endMs: 0 };
  const errors: number[] = [];
  let was = false;
  pinged(fit, sim, seconds, (sample) => {
    samples.push(sample);
    const hostMs = (sample[0] + sample[3]) / 2;
    const converged = fit.converged;
    if (converged) {
      outcome.first ??= (sample[3] - H0) / 1000;
      errors.push(Math.abs(fit.offsetMs - sim.offsetAt(hostMs)));
    } else if (was) {
      outcome.withdrawn++;
    }
    was = converged;
  });
  const old = { first: null as number | null, withdrawn: 0, kept: [] as number[] };
  const steady = make();
  const history: Sample[] = [];
  let oldWas = false;
  for (let t = H0; t < H0 + seconds * 1000; t += 2000) {
    const sample = steady.ping(t);
    history.push(sample);
    const band = bandRule(history);
    if (band.converged) {
      old.first ??= (sample[3] - H0) / 1000;
    } else if (oldWas) {
      old.withdrawn++;
    }
    oldWas = band.converged;
    if (history.length >= 60) {
      old.kept.push(band.kept);
    }
  }
  const [t1, , , t4] = samples[samples.length - 1];
  outcome.endMs = fit.offsetMs - sim.offsetAt((t1 + t4) / 2);
  errors.sort((p, q) => p - q);
  outcome.worstMs = errors.at(-1) ?? 0;
  outcome.p99Ms = errors[Math.floor(0.99 * errors.length)] ?? 0;
  const trips = samples.map(([t1, t2, t3, t4]) => t4 - t1 - (t3 - t2));
  return { fit, ...outcome, old, least: Math.min(...trips), median: medianOf(trips) };
}

/** Pings every `cadenceMs` for `seconds`, from H0, fed into `fit`; the host time of the last one. */
function run(
  fit: RemoteClockFit,
  sim: ReturnType<typeof simulation>,
  seconds: number,
  cadenceMs = 2000,
  from = H0,
): number {
  let t = from;
  const until = from + seconds * 1000;
  for (; t < until; t += cadenceMs) {
    fit.addSample(...sim.ping(t));
  }
  return t - cadenceMs;
}

/**
 * One round trip begun at `t1` on the host clock, of `rttMs`, to a phone whose clock is `offsetMs`
 * ahead, which answers at once: the legs symmetric, but for `lateMs` more on the way there.
 */
function trip(
  t1: number,
  offsetMs: number,
  rttMs: number,
  lateMs = 0,
): [number, number, number, number] {
  const t2 = t1 + offsetMs + (rttMs - lateMs) / 2 + lateMs;
  return [t1, t2, t2, t1 + rttMs];
}

describe('RemoteClockFit', () => {
  it('is the identity with no sample, and takes an offset from one sample', () => {
    const fit = new RemoteClockFit();
    expect(fit.samples).toBe(0);
    expect(fit.toHostMs(123.5)).toBe(123.5);
    expect(fit.toRemoteMs(123.5)).toBe(123.5);
    expect(fit.offsetMs).toBe(0);
    expect(fit.converged).toBe(false);
    expect(fit.params).toEqual({
      offsetMs: 0,
      driftPpm: 0,
      rttMs: 0,
      samples: 0,
      residualP95Ms: 0,
      since: 0,
    });
    // The phone's clock is 95 ms ahead: sent at 0, received there at 100 and answered at 100, back
    // at 10. offset = ((100 − 0) + (100 − 10)) / 2 = 95; rtt = (10 − 0) − (100 − 100) = 10.
    fit.addSample(0, 100, 100, 10);
    expect(fit.offsetMs).toBe(95);
    expect(fit.rttMs).toBe(10);
    expect(fit.toHostMs(195)).toBe(100);
    expect(fit.toRemoteMs(100)).toBe(195);
    expect(fit.driftPpm).toBe(0);
    expect(fit.hasDrift).toBe(false);
    expect(fit.params).toEqual({
      offsetMs: 95,
      driftPpm: 0,
      rttMs: 10,
      samples: 1,
      residualP95Ms: 0,
      since: 10,
    });
  });

  it("takes the phone's time to answer out of the round trip", () => {
    const fit = new RemoteClockFit();
    // The same trip, the phone taking 30 ms to answer.
    fit.addSample(0, 100, 130, 40);
    expect(fit.rttMs).toBe(10);
    expect(fit.offsetMs).toBe(95);
  });

  it('refuses times that are not finite or run backwards', () => {
    const fit = new RemoteClockFit();
    expect(() => {
      fit.addSample(0, NaN, 1, 2);
    }).toThrow(RangeError);
    expect(() => {
      fit.addSample(0, 1, 1, Infinity);
    }).toThrow(RangeError);
    expect(() => {
      fit.addSample(10, 100, 100, 9);
    }).toThrow(/runs forward/);
    expect(() => {
      fit.addSample(0, 100, 99, 10);
    }).toThrow(/runs forward/);
    expect(() => new RemoteClockFit({ window: 0 })).toThrow(RangeError);
    expect(() => new RemoteClockFit({ window: 1.5 })).toThrow(RangeError);
    expect(() => new RemoteClockFit({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new RemoteClockFit({ windowMs: NaN })).toThrow(RangeError);
    expect(fit.samples).toBe(0);
  });

  it('takes the offset from the samples of least round trip: the median of those within 1.5× the least', () => {
    const fit = new RemoteClockFit();
    // Five trips of 10 ms with symmetric legs, the phone's clock 95 to 97 ms ahead; one trip of 40 ms
    // whose first leg took the time (an asymmetric trip puts the offset off by half the extra), and
    // one of 14 ms, within 1.5 × 10, 4 ms late on the way there.
    fit.addSample(...trip(0, 95, 10));
    fit.addSample(...trip(2000, 96, 10));
    fit.addSample(...trip(4000, 97, 40, 30)); // offset read as 112: left out
    fit.addSample(...trip(6000, 97, 10));
    fit.addSample(...trip(8000, 98, 14, 4)); // offset read as 100: kept
    fit.addSample(...trip(10_000, 96, 10));
    fit.addSample(...trip(12_000, 95, 10));
    expect(fit.rttMs).toBe(10);
    expect(fit.params.samples).toBe(6);
    // The six kept offsets: 95, 96, 97, 100, 96, 95: the median is 96.
    expect(fit.offsetMs).toBe(96);
    expect(fit.params.since).toBe(10);
    expect(fit.params.residualP95Ms).toBe(4);
    expect(REMOTE_CLOCK_RTT_FACTOR).toBe(1.5);
  });

  it('tells the sample of least round trip and the 95th percentile of the kept trips (T4.2), none with no sample', () => {
    const fit = new RemoteClockFit();
    expect(fit.least).toBeNull();
    expect(fit.rttP95Ms).toBe(0);
    fit.addSample(...trip(0, 95, 30));
    expect(fit.least).toEqual({ offsetMs: 95, rttMs: 30, hostMs: 15 });
    expect(fit.rttP95Ms).toBe(30);
    // A shorter trip, 3 ms late on the way there: the least now, its offset off by 1.5 ms.
    fit.addSample(...trip(2000, 95, 20, 3));
    expect(fit.least).toEqual({ offsetMs: 96.5, rttMs: 20, hostMs: 2010 });
    // Kept: those within 1.5 × 20 = 30 ms; a trip of 31 ms is left out of the percentile too.
    fit.addSample(...trip(4000, 95, 26));
    fit.addSample(...trip(6000, 95, 31));
    expect(fit.params.samples).toBe(3);
    expect(fit.rttP95Ms).toBe(30);
    // Not converged with four samples: the estimate is there all the same (T4.2 cuts on it).
    expect(fit.converged).toBe(false);
    expect(fit.toRemoteMs(1000)).toBeCloseTo(1095, 6);
  });

  it('keeps the trips up to 3 ms over the least when that is more than 1.5× it: a loopback or an Ethernet link', () => {
    const fit = new RemoteClockFit();
    // Trips of 1.2 ms at the least, as two pages of one browser give, and the main threads' work
    // putting 0.5 to 10 ms on top: 1.5 × 1.2 would keep the first alone; 1.2 + 3 keeps those up to
    // 4.2 ms, off by at most 1.5 ms (the extra all on one leg here).
    fit.addSample(...trip(0, 50, 1.2));
    fit.addSample(...trip(2000, 50, 1.7, 0.5)); // read as 50.25: kept
    fit.addSample(...trip(4000, 50, 4.1, 2.9)); // read as 51.45: kept
    fit.addSample(...trip(6000, 50, 4.3, 3.1)); // read as 51.55: left out
    fit.addSample(...trip(8000, 50, 11.2, 10)); // read as 55: left out
    fit.addSample(...trip(10_000, 50, 1.2));
    expect(fit.rttMs).toBe(1.2);
    expect(fit.params.samples).toBe(4);
    // The kept offsets, 50, 50.25, 51.45 and 50: the median is 50.125.
    expect(fit.offsetMs).toBeCloseTo(50.125, 6);
    expect(REMOTE_CLOCK_RTT_ALLOWANCE_MS).toBe(3);
  });

  it('keeps the samples of the last two minutes, at most 240: an outlier is forgotten with the window', () => {
    // A window of four samples at most.
    const fit = new RemoteClockFit({ window: 4 });
    fit.addSample(0, 200, 200, 10); // offset 195
    for (let k = 1; k <= 3; k++) {
      fit.addSample(k * 1000, k * 1000 + 100, k * 1000 + 100, k * 1000 + 10);
    }
    expect(fit.samples).toBe(4);
    expect(fit.offsetMs).toBe(95); // the median of 195, 95, 95, 95
    fit.addSample(4000, 4100, 4100, 4010);
    expect(fit.samples).toBe(4);
    expect(fit.offsetMs).toBe(95);
    expect(fit.params.since).toBe(1010);

    // The window by default: the samples received in the last two minutes, so 60 at 2 s and 240 at
    // 500 ms; a sample received two minutes or more before the newest leaves.
    expect(REMOTE_CLOCK_WINDOW_MS).toBe(120_000);
    expect(REMOTE_CLOCK_WINDOW).toBe(240);
    const steady = new RemoteClockFit();
    for (let k = 0; k < 100; k++) {
      steady.addSample(...trip(H0 + 2000 * k, 50, 10));
    }
    expect(steady.samples).toBe(60);
    expect(steady.params.since).toBe(H0 + 2000 * 40 + 10);
    const fast = new RemoteClockFit();
    for (let k = 0; k < 300; k++) {
      fast.addSample(...trip(H0 + 500 * k, 50, 10));
    }
    expect(fast.samples).toBe(240);
    // At most 240, whatever their times; the last sample stays, however old the others.
    const capped = new RemoteClockFit({ windowMs: 1e9 });
    for (let k = 0; k < 300; k++) {
      capped.addSample(...trip(H0 + 100 * k, 50, 10));
    }
    expect(capped.samples).toBe(240);
    // A phone back after five minutes away: its old samples leave with the first new one.
    steady.addSample(...trip(H0 + 2000 * 99 + 300_000, 50, 10));
    expect(steady.samples).toBe(1);
  });

  it('keeps at least the 10 samples of least round trip, however jittery the link; the lower half of a small window', () => {
    expect(REMOTE_CLOCK_MIN_KEPT).toBe(10);
    // Round trips of 6 ms and then 7, 8, … 39 ms, all symmetric, the phone 50 ms ahead: the band of
    // the least (9 ms) keeps four; the ten least are kept, those up to 15 ms.
    const fit = new RemoteClockFit();
    for (let k = 0; k < 34; k++) {
      fit.addSample(...trip(H0 + 2000 * k, 50, 6 + k));
    }
    expect(fit.rttMs).toBe(6);
    expect(fit.params.samples).toBe(10);
    expect(fit.rttP95Ms).toBe(15);
    expect(fit.offsetMs).toBe(50);
    expect(fit.window).toEqual({ samples: 34, kept: 10, rttP50Ms: 22, rttP95Ms: 38 });
    // A window of three: its lower half is the least alone, which the band widens to 9 ms; a trip
    // of a burst, 200 ms with its legs 150 and 50 (read 50 ms off), is never kept.
    const small = new RemoteClockFit();
    small.addSample(...trip(H0, 50, 6));
    small.addSample(...trip(H0 + 2000, 50, 200, 100));
    expect(small.params.samples).toBe(1);
    expect(small.offsetMs).toBe(50);
    small.addSample(...trip(H0 + 4000, 50, 8));
    expect(small.params.samples).toBe(2);
    expect(small.offsetMs).toBe(50);
    expect(small.window).toEqual({ samples: 3, kept: 2, rttP50Ms: 8, rttP95Ms: 200 });
    expect(new RemoteClockFit().window).toEqual({
      samples: 0,
      kept: 0,
      rttP50Ms: 0,
      rttP95Ms: 0,
    });
  });

  it.each([
    [5, 1],
    [20, 2],
    [40, 3],
  ])(
    'finds the offset within 1 ms over a round trip of %d ms with %d ms of jitter, and converges',
    (rttMs, jitterMs) => {
      for (const seed of [1, 2, 3]) {
        const sim = simulation({ offsetMs: -31_415.9, driftPpm: 0, rttMs, jitterMs, seed });
        const fit = new RemoteClockFit();
        const last = run(fit, sim, 120);
        const error = fit.offsetMs - sim.offsetAt(last);
        console.log(
          `Remote clock, rtt ${String(rttMs)} ms, jitter ${String(jitterMs)} ms, seed ${String(seed)}: offset error ${error.toFixed(3)} ms, rtt measured ${fit.rttMs.toFixed(2)} ms, ${String(fit.params.samples)} of ${String(fit.samples)} samples kept, residual p95 ${fit.params.residualP95Ms.toFixed(3)} ms.`,
        );
        expect(Math.abs(error)).toBeLessThan(1);
        expect(Math.abs(fit.toHostMs(sim.remote(last)) - last)).toBeLessThan(1);
        expect(Math.abs(fit.toRemoteMs(last) - sim.remote(last))).toBeLessThan(1);
        expect(fit.rttMs).toBeGreaterThanOrEqual(rttMs);
        expect(fit.rttMs).toBeLessThan(rttMs + jitterMs);
        expect(fit.converged).toBe(true);
      }
    },
  );

  it('keeps the offset within 2 ms on a busy network, but does not call it converged', () => {
    // Round trips of 40 ms that jitter by tens of ms: the trips kept are within 1.5× the least, so
    // their legs may differ by 10 ms, and the median over the window settles within 2 ms.
    const sim = simulation({ offsetMs: 777, driftPpm: 0, rttMs: 40, jitterMs: 30, seed: 5 });
    const fit = new RemoteClockFit();
    const last = run(fit, sim, 120);
    const error = fit.offsetMs - sim.offsetAt(last);
    console.log(
      `Remote clock on a busy network (rtt 40 ms, jitter 30 ms): offset error ${error.toFixed(3)} ms, residual p95 ${fit.params.residualP95Ms.toFixed(2)} ms, ${String(fit.params.samples)} of ${String(fit.samples)} samples kept.`,
    );
    expect(Math.abs(error)).toBeLessThan(2.5);
    expect(fit.converged).toBe(false);
  });

  it.each([37, -80, 0])(
    'fits a drift of %d ppm within 10 ppm over a simulated hour, and converts with it',
    (driftPpm) => {
      const sim = simulation({ offsetMs: 12_345.678, driftPpm, rttMs: 20, jitterMs: 2, seed: 42 });
      const fit = new RemoteClockFit();
      // The first minute: no fit yet; the offset is the median, within 1 ms still (the drift moves
      // it by at most 5 ms a minute).
      run(fit, sim, 50);
      expect(fit.hasDrift).toBe(false);
      expect(fit.driftPpm).toBe(0);
      const hour = run(fit, sim, 3600, 2000, H0 + 50_000);
      const { params } = fit;
      console.log(
        `Remote clock, drift ${String(driftPpm)} ppm after an hour: fitted ${params.driftPpm.toFixed(2)} ppm, offset error ${(fit.offsetMs - sim.offsetAt(hour)).toFixed(3)} ms, residual p95 ${params.residualP95Ms.toFixed(3)} ms, ${String(params.samples)} samples since ${((hour - params.since) / 1000).toFixed(0)} s ago.`,
      );
      expect(fit.hasDrift).toBe(true);
      expect(Math.abs(params.driftPpm - driftPpm)).toBeLessThan(10);
      expect(Math.abs(fit.offsetMs - sim.offsetAt(hour))).toBeLessThan(1);
      // A frame 30 s ago, and one 30 s ahead of the newest sample: the line, not the median.
      for (const hostMs of [hour - 30_000, hour, hour + 30_000]) {
        expect(Math.abs(fit.toHostMs(sim.remote(hostMs)) - hostMs)).toBeLessThan(1.5);
        expect(Math.abs(fit.toRemoteMs(hostMs) - sim.remote(hostMs))).toBeLessThan(1.5);
        // The two conversions are inverses.
        // The two conversions are inverses (to the precision of a wall-clock float).
        expect(fit.toRemoteMs(fit.toHostMs(sim.remote(hostMs)))).toBeCloseTo(sim.remote(hostMs), 3);
      }
      expect(params.samples).toBeGreaterThanOrEqual(20);
      expect(params.residualP95Ms).toBeLessThan(3);
      expect(hour - params.since).toBeGreaterThan(REMOTE_CLOCK_DRIFT_SPAN_MS);
      expect(fit.converged).toBe(true);
    },
  );

  it('declares convergence after ten kept samples over ten seconds, and withdraws it when the offsets scatter', () => {
    const sim = simulation({ offsetMs: 500, driftPpm: 20, rttMs: 10, jitterMs: 2, seed: 7 });
    const fit = new RemoteClockFit();
    let t = H0;
    // Nine samples over 16 s: not yet.
    for (let k = 0; k < 9; k++, t += 2000) {
      fit.addSample(...sim.ping(t));
      expect(fit.converged).toBe(false);
    }
    fit.addSample(...sim.ping(t));
    t += 2000;
    expect(fit.samples).toBe(10);
    expect(fit.converged).toBe(true);
    // Four samples in 3 s would not have done: ten over ten seconds.
    const quick = new RemoteClockFit();
    for (let k = 0; k < 12; k++) {
      quick.addSample(...sim.ping(H0 + 250 * k));
    }
    expect(quick.converged).toBe(false);
    expect(REMOTE_CLOCK_CONVERGED).toEqual({ samples: 10, spanMs: 10_000, spreadMs: 5 });
    // The phone slept: its clock stopped for 100 ms, and comes back 100 ms behind. Its first sample
    // after is farther from the estimate than its round trip allows: the sync is withdrawn at once...
    const slept = simulation({ offsetMs: 400, driftPpm: 20, rttMs: 10, jitterMs: 2, seed: 8 });
    fit.addSample(...slept.ping(t));
    t += 2000;
    expect(fit.converged).toBe(false);
    // ...stays so while the new samples disagree with the old ones in the window...
    for (let k = 1; k < 10; k++, t += 2000) {
      fit.addSample(...slept.ping(t));
      expect(fit.converged).toBe(false);
    }
    expect(Math.abs(fit.offsetMs - slept.offsetAt(t))).toBeGreaterThan(3);
    // ...until the old samples have left the window, two minutes on.
    for (let k = 0; k < REMOTE_CLOCK_WINDOW_MS / 2000; k++, t += 2000) {
      fit.addSample(...slept.ping(t));
    }
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.offsetMs - slept.offsetAt(t - 2000))).toBeLessThan(1);
  });

  it('withdraws convergence at a sample farther from the estimate than its round trip allows, however few', () => {
    // Twenty symmetric trips of 6 ms, the phone 50 ms ahead: converged.
    const fit = new RemoteClockFit();
    let t = H0;
    for (let k = 0; k < 20; k++, t += 2000) {
      fit.addSample(...trip(t, 50, 6));
    }
    expect(fit.converged).toBe(true);
    // A trip of 40 ms read 19 ms off (its legs 39 and 1, as a burst gives): within half its round
    // trip of the estimate, so possible on any network, and it changes nothing.
    fit.addSample(...trip(t, 50, 40, 38));
    t += 2000;
    expect(fit.converged).toBe(true);
    // A trip of 6 ms read 10 ms off cannot be: half its round trip is 3 ms, and the estimate is off
    // by much less than the 5 ms allowed. One clock moved; the sync is withdrawn.
    fit.addSample(...trip(t, 60, 6));
    expect(fit.converged).toBe(false);
    expect(fit.offsetMs).toBe(50);
  });

  it('converges within a minute on the simulated home Wi-Fi of 2026-10-04, and stays converged for 20 minutes, the offset within 2 ms', () => {
    for (const seed of [1, 2, 3]) {
      // The phone 240 ms behind, drifting by 5 ppm (the owner's: 238 to 245 ms over 20 minutes).
      const run20 = pairing(
        () => simulation({ offsetMs: -240, driftPpm: 5, legs: homeWifi, seed }),
        20 * 60,
      );
      const { window, params } = run20.fit;
      console.log(
        `Remote clock on the home Wi-Fi, seed ${String(seed)}: round trips least ${run20.least.toFixed(1)} ms, median ${run20.median.toFixed(1)} ms; converged ${seconds(run20.first)}, withdrawn ${String(run20.withdrawn)} times in 20 min, the offset's error while converged ${run20.p99Ms.toFixed(2)} ms at the 99th percentile and ${run20.worstMs.toFixed(2)} ms at worst, ${run20.endMs.toFixed(2)} ms at the end; kept ${String(window.kept)} of ${String(window.samples)}, residual p95 ${params.residualP95Ms.toFixed(2)} ms, drift ${params.driftPpm.toFixed(1)} ppm. The band alone (T4.0–T4.2): kept ${String(Math.min(...run20.old.kept))} to ${String(Math.max(...run20.old.kept))} (median ${String(medianOf(run20.old.kept))}) of 60, converged ${seconds(run20.old.first)}, withdrawn ${String(run20.old.withdrawn)} times.`,
      );
      // The simulated network is the owner's: a least of about 6 ms, a median of 12 to 15.
      expect(run20.least).toBeGreaterThan(5.4);
      expect(run20.least).toBeLessThan(8.5);
      expect(run20.median).toBeGreaterThan(12);
      expect(run20.median).toBeLessThan(15);
      expect(run20.first).not.toBeNull();
      expect(run20.first ?? Infinity).toBeLessThan(60);
      expect(run20.withdrawn).toBe(0);
      expect(run20.fit.converged).toBe(true);
      // Within 2 ms of the truth, but for a few seconds in some pairings: the drift fitted through
      // ten samples or so of two minutes can be off by 30 to 50 ppm for a while, a millisecond or two
      // at the window's end (seed 3: 2.3 ms for 4 s).
      expect(run20.p99Ms).toBeLessThan(2);
      expect(run20.worstMs).toBeLessThan(2.5);
      expect(Math.abs(run20.endMs)).toBeLessThan(2);
      // Under the band alone, the same round trips converge late, and flap, as the owner saw.
      expect(run20.old.withdrawn).toBeGreaterThan(5);
    }
  });

  it('converges within 90 s between two loaded pages of one browser, the offset within 3 ms', () => {
    for (const seed of [1, 2, 3]) {
      const run5 = pairing(
        () => simulation({ offsetMs: 5000, driftPpm: 0, legs: loadedLoopback, seed }),
        5 * 60,
      );
      const { window, params } = run5.fit;
      console.log(
        `Remote clock between two loaded pages, seed ${String(seed)}: round trips least ${run5.least.toFixed(1)} ms, median ${run5.median.toFixed(1)} ms; converged ${seconds(run5.first)}, withdrawn ${String(run5.withdrawn)} times in 5 min, the offset's error while converged ${run5.worstMs.toFixed(2)} ms at worst, ${run5.endMs.toFixed(2)} ms at the end; kept ${String(window.kept)} of ${String(window.samples)}, residual p95 ${params.residualP95Ms.toFixed(2)} ms. The band alone (T4.0–T4.2): kept ${String(Math.min(...run5.old.kept))} to ${String(Math.max(...run5.old.kept))} of 60, converged ${seconds(run5.old.first)}, withdrawn ${String(run5.old.withdrawn)} times.`,
      );
      expect(run5.least).toBeLessThan(3.5);
      expect(run5.median).toBeGreaterThan(15);
      expect(run5.median).toBeLessThan(20);
      expect(run5.first ?? Infinity).toBeLessThan(90);
      expect(run5.worstMs).toBeLessThan(3);
      expect(Math.abs(run5.endMs)).toBeLessThan(3);
    }
  });

  it('withdraws convergence while the network is busy, keeping the estimate of the quiet samples meanwhile', () => {
    const quiet = simulation({ offsetMs: -2000, driftPpm: 0, rttMs: 8, jitterMs: 2, seed: 11 });
    const fit = new RemoteClockFit();
    let t = run(fit, quiet, 60) + 2000;
    expect(fit.converged).toBe(true);
    const offset = fit.offsetMs;
    // A minute of a busy network: round trips of 80 ms and more, scattered by 60 ms.
    const busy = simulation({ offsetMs: -2000, driftPpm: 0, rttMs: 80, jitterMs: 60, seed: 12 });
    for (let k = 0; k < 30; k++, t += 2000) {
      fit.addSample(...busy.ping(t));
    }
    // The quiet samples still in the window decide: the busy ones are beyond the band of the least
    // trip, and the ten of least round trip are quiet ones; and none is farther from the estimate
    // than half its round trip.
    expect(fit.offsetMs).toBe(offset);
    expect(fit.converged).toBe(true);
    // Once they are gone, the busy samples are all there is: too scattered to trust.
    for (let k = 0; k < 40; k++, t += 2000) {
      fit.addSample(...busy.ping(t));
    }
    expect(fit.rttMs).toBeGreaterThan(60);
    expect(fit.converged).toBe(false);
    expect(fit.params.residualP95Ms).toBeGreaterThan(3);
  });

  it('returns its parameters as a copy', () => {
    const fit = new RemoteClockFit();
    fit.addSample(0, 100, 100, 10);
    fit.params.offsetMs = 0;
    expect(fit.params.offsetMs).toBe(95);
  });
});
