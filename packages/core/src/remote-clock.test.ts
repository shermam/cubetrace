import { describe, expect, it } from 'vitest';

import {
  REMOTE_CLOCK_CONVERGED,
  REMOTE_CLOCK_DRIFT_SPAN_MS,
  REMOTE_CLOCK_RTT_FACTOR,
  REMOTE_CLOCK_WINDOW,
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

/**
 * A phone's clock against the host's: `remote = host + offsetMs + drift · (host − H0)`, the drift in
 * parts per million (50 ppm: 3 ms a minute), and a network whose two legs each take half the base
 * round trip plus an exponential jitter of mean `jitterMs / 2` (most trips short, a few long, as
 * queues are), the phone answering within `answerMs`. `ping(hostMs)` gives the four times of a round
 * trip begun then.
 */
function simulation(opts: {
  offsetMs: number;
  driftPpm: number;
  rttMs: number;
  jitterMs: number;
  answerMs?: number;
  seed: number;
}) {
  const next = random(opts.seed);
  const drift = opts.driftPpm * 1e-6;
  const remote = (hostMs: number): number => hostMs + opts.offsetMs + drift * (hostMs - H0);
  const leg = (): number => opts.rttMs / 2 + opts.jitterMs * -Math.log(1 - next()) * 0.5;
  return {
    remote,
    /** The true offset at a host time. */
    offsetAt: (hostMs: number): number => remote(hostMs) - hostMs,
    ping: (t1: number): [number, number, number, number] => {
      const arrived = t1 + leg();
      const answered = arrived + (opts.answerMs ?? 1) * next();
      const t4 = answered + leg();
      return [t1, remote(arrived), remote(answered), t4];
    },
  };
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
    expect(() => fit.addSample(0, NaN, 1, 2)).toThrow(RangeError);
    expect(() => fit.addSample(0, 1, 1, Infinity)).toThrow(RangeError);
    expect(() => fit.addSample(10, 100, 100, 9)).toThrow(/runs forward/);
    expect(() => fit.addSample(0, 100, 99, 10)).toThrow(/runs forward/);
    expect(() => new RemoteClockFit({ window: 0 })).toThrow(RangeError);
    expect(() => new RemoteClockFit({ window: 1.5 })).toThrow(RangeError);
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

  it('keeps the last 60 samples: an outlier is forgotten with the window', () => {
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
    expect(REMOTE_CLOCK_WINDOW).toBe(60);
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
    expect(REMOTE_CLOCK_CONVERGED).toEqual({ samples: 10, spanMs: 10_000, spreadMs: 3 });
    // The phone slept: its clock stopped for 100 ms, and comes back 100 ms behind. The new samples
    // disagree with the old ones in the window, and the sync is withdrawn...
    const slept = simulation({ offsetMs: 400, driftPpm: 20, rttMs: 10, jitterMs: 2, seed: 8 });
    for (let k = 0; k < 10; k++, t += 2000) {
      fit.addSample(...slept.ping(t));
    }
    expect(fit.converged).toBe(false);
    expect(Math.abs(fit.offsetMs - slept.offsetAt(t))).toBeGreaterThan(3);
    // ...until the old samples have left the window.
    for (let k = 0; k < REMOTE_CLOCK_WINDOW; k++, t += 2000) {
      fit.addSample(...slept.ping(t));
    }
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.offsetMs - slept.offsetAt(t - 2000))).toBeLessThan(1);
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
    // The quiet samples still in the window decide: the busy ones are beyond 1.5× the least trip.
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
