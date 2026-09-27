import { describe, expect, it } from 'vitest';

import { CLOCK_FIT_WINDOW, CLOCK_RESTART_DRIFT, CLOCK_RESTART_MS, CubeClockFit } from './index';

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

interface Sample {
  cubeMs: number;
  hostMs: number;
  packetLast: boolean;
}

/**
 * Moves as the host receives them (docs/PLAN.md T1.4): Bluetooth packets of 1 to 7 moves 40 to
 * 340 ms apart on the cube clock, with pauses between some packets; every move of a packet gets
 * the packet's arrival time, `hostMs = a·cubeMs + b + noise` of its newest move, the noise uniform
 * in ±`noiseMs`.
 */
function bunchedMoves(
  a: number,
  b: number,
  count: number,
  noiseMs: number,
  seed: number,
): Sample[] {
  const next = random(seed);
  const samples: Sample[] = [];
  let cubeMs = 12_345;
  while (samples.length < count) {
    const size = 1 + Math.floor(next() * 7);
    const cubeTimes: number[] = [];
    for (let k = 0; k < size; k++) {
      cubeMs += 40 + Math.floor(next() * 300);
      cubeTimes.push(cubeMs);
    }
    const hostMs = a * cubeMs + b + (2 * next() - 1) * noiseMs;
    for (const [k, c] of cubeTimes.entries()) {
      samples.push({ cubeMs: c, hostMs, packetLast: k === size - 1 });
    }
    if (next() < 0.1) {
      cubeMs += 5000 + Math.floor(next() * 25_000);
    }
  }
  return samples;
}

function fitOf(samples: readonly Sample[], opts?: { window?: number }): CubeClockFit {
  const fit = new CubeClockFit(opts);
  for (const s of samples) {
    fit.addSample(s.cubeMs, s.hostMs, s.packetLast);
  }
  return fit;
}

describe('CubeClockFit', () => {
  const A = 1.0001;

  it('recovers a within 1e-4 and b within 5 ms from bunched packets', () => {
    const moves = bunchedMoves(A, 5000, 4000, 4, 20260927);
    const fit = fitOf(moves);
    const { a, b, residualP95Ms, samples } = fit.params;
    console.log(
      `Clock fit of ${String(samples)} packets: a − 1.0001 = ${(a - A).toExponential(1)}, b − 5000 = ${(b - 5000).toFixed(2)} ms, residual p95 ${residualP95Ms.toFixed(2)} ms.`,
    );
    expect(Math.abs(a - A)).toBeLessThan(1e-4);
    expect(Math.abs(b - 5000)).toBeLessThan(5);
    expect(samples).toBe(moves.filter((s) => s.packetLast).length);
    expect(residualP95Ms).toBeLessThan(4);
    for (const cubeMs of [moves[0].cubeMs, 600_000, moves[moves.length - 1].cubeMs + 60_000]) {
      expect(Math.abs(fit.toHost(cubeMs) - (A * cubeMs + 5000))).toBeLessThan(5);
    }
    // The packets are bunched indeed: a fit of every move misses by far more.
    const naive = fitOf(moves.map((s) => ({ ...s, packetLast: true })));
    expect(naive.params.residualP95Ms).toBeGreaterThan(100);
  });

  it('keeps its precision with host times on a wall clock (b about 1.7e12 ms)', () => {
    const b = 1_730_639_990_000;
    const fit = fitOf(bunchedMoves(A, b, 4000, 4, 7));
    expect(Math.abs(fit.params.a - A)).toBeLessThan(1e-4);
    expect(Math.abs(fit.params.b - b)).toBeLessThan(5);
    expect(Math.abs(fit.toHost(900_000) - (A * 900_000 + b))).toBeLessThan(5);
    expect(fit.params.residualP95Ms).toBeLessThan(4);
  });

  it('fits only the packetLast samples', () => {
    const moves = bunchedMoves(A, 5000, 500, 4, 99);
    const lastOnly = fitOf(moves.filter((s) => s.packetLast));
    const all = fitOf(moves);
    expect(all.params).toEqual(lastOnly.params);
  });

  it('before two samples: the last sample with a = 1; with none, the identity', () => {
    const fit = new CubeClockFit();
    expect(fit.params).toEqual({ a: 1, b: 0, residualP95Ms: 0, samples: 0 });
    expect(fit.toHost(123)).toBe(123);
    // An older move of a packet, before any packetLast one: better than nothing.
    fit.addSample(1000, 6000, false);
    expect(fit.params).toEqual({ a: 1, b: 5000, residualP95Ms: 0, samples: 0 });
    expect(fit.toHost(1500)).toBe(6500);
    fit.addSample(1200, 6250, true);
    expect(fit.params).toEqual({ a: 1, b: 5050, residualP95Ms: 0, samples: 1 });
    // Once there is a packetLast sample, the others no longer serve.
    fit.addSample(1400, 6400, false);
    expect(fit.toHost(1500)).toBe(6550);
    expect(fit.hasLine).toBe(false);
    fit.addSample(2200, 7300, true);
    expect(fit.hasLine).toBe(true);
    const { a, b, residualP95Ms, samples } = fit.params;
    expect(a).toBeCloseTo(1.05, 12);
    expect(b).toBeCloseTo(4990, 9);
    expect(residualP95Ms).toBeCloseTo(0, 9);
    expect(samples).toBe(2);
    expect(fit.toHost(1700)).toBeCloseTo(6775, 9);
  });

  it('has no line while every sample is at one cube time', () => {
    const fit = new CubeClockFit();
    fit.addSample(1000, 5000, true);
    fit.addSample(1000, 5010, true);
    expect(fit.hasLine).toBe(false);
    expect(fit.params).toEqual({ a: 1, b: 4010, residualP95Ms: 0, samples: 2 });
    expect(fit.toHost(1100)).toBe(5110);
  });

  it('computes the residual percentile over the last `window` samples only', () => {
    // Five pairs at cube 0, 300 ms above and below the line host = cube + 1000, cancel out in the
    // fit; twenty samples on the line follow. The fit is that line exactly.
    const samples: Sample[] = [];
    for (let k = 0; k < 5; k++) {
      samples.push({ cubeMs: 0, hostMs: 1300, packetLast: true });
      samples.push({ cubeMs: 0, hostMs: 700, packetLast: true });
    }
    for (let k = 1; k <= 20; k++) {
      samples.push({ cubeMs: 100 * k, hostMs: 1000 + 100 * k, packetLast: true });
    }
    const recent = fitOf(samples, { window: 20 }).params;
    expect(recent.a).toBeCloseTo(1, 12);
    expect(recent.b).toBeCloseTo(1000, 9);
    expect(recent.residualP95Ms).toBeCloseTo(0, 9);
    // All thirty: the nearest rank of the 95th percentile, the 29th smallest, is a 300 ms one.
    expect(fitOf(samples, { window: 30 }).params.residualP95Ms).toBeCloseTo(300, 9);
    expect(fitOf(samples).params.residualP95Ms).toBeCloseTo(300, 9);
    expect(CLOCK_FIT_WINDOW).toBe(2000);
  });

  it('returns its parameters as a copy', () => {
    const fit = new CubeClockFit();
    fit.params.a = 2;
    expect(fit.params.a).toBe(1);
  });

  describe("when the cube's clock starts again", () => {
    /** `count` moves 300 ms apart on the cube clock from `cubeMs`, on the line host = a·cube + b. */
    function run(a: number, b: number, cubeMs: number, count: number, seed: number): Sample[] {
      const next = random(seed);
      return Array.from({ length: count }, (_, k) => {
        const cube = cubeMs + 300 * k;
        return { cubeMs: cube, hostMs: a * cube + b + (2 * next() - 1) * 15, packetLast: true };
      });
    }

    it('starts again at a reconnection: the fit is that of the moves since, as attempt 6 of the i3 needs', () => {
      // Two moves 9 minutes into a connection, then 434 s later the cube's count restarted (561,080 ms
      // back to 10,977 on the i3): the same cube, 0.1% slow, on a new line.
      const before = run(1.001, 1_790_544_000_000, 559_025, 2, 1);
      const after = run(1.001, 1_790_545_043_814, 10_977, 112, 2);
      const fit = fitOf([...before, ...after]);
      const fresh = fitOf(after);

      expect(fit.restarts).toBe(1);
      expect(fit.params).toEqual(fresh.params);
      expect(fit.params.samples).toBe(112);
      expect(fit.params.a).toBeCloseTo(1.001, 4);
      expect(fit.params.residualP95Ms).toBeLessThan(16);
      expect(fit.toHost(40_000)).toBeCloseTo(fresh.toHost(40_000), 6);
    });

    it("starts again when the cube's time falls behind the host's without going back", () => {
      // A connection 5 s old at its last move; 300 s later the new connection's count is at 20 s.
      const short = fitOf([
        { cubeMs: 4000, hostMs: 1_000_000, packetLast: true },
        { cubeMs: 5000, hostMs: 1_001_000, packetLast: true },
        { cubeMs: 20_000, hostMs: 1_301_000, packetLast: true },
        { cubeMs: 21_000, hostMs: 1_302_000, packetLast: true },
      ]);
      expect(short.restarts).toBe(1);
      expect(short.params.samples).toBe(2);
      expect(short.params.b).toBeCloseTo(1_281_000, 6);
      // The i3's count of a pause of 80.1 s: 65,535 ms, the most its 16 bits hold.
      const capped = fitOf([
        { cubeMs: 100_000, hostMs: 5_000_000, packetLast: true },
        { cubeMs: 101_000, hostMs: 5_001_001, packetLast: true },
        { cubeMs: 101_000 + 65_535, hostMs: 5_001_001 + 80_131, packetLast: true },
      ]);
      expect(capped.restarts).toBe(1);
      expect(capped.params.samples).toBe(1);
      expect(capped.hasLine).toBe(false);
    });

    it('keeps its line through the jitter, a slow cube and pauses where both clocks advance alike', () => {
      const samples: Sample[] = [
        { cubeMs: 1000, hostMs: 50_000, packetLast: true },
        // A cube time a few ms back, as the driver's reconstruction can give.
        { cubeMs: 995, hostMs: 50_040, packetLast: true },
        // A late packet: 300 ms of Bluetooth delay.
        { cubeMs: 1300, hostMs: 50_600, packetLast: true },
        // A pause of 5 minutes, both clocks alike (docs/DEVICES.md).
        { cubeMs: 301_300, hostMs: 350_300, packetLast: true },
      ];
      // Then a cube 0.7% slow for 10 minutes of turns, a move every 300 ms of its clock.
      for (let k = 1; k <= 2000; k++) {
        samples.push({
          cubeMs: 301_300 + 300 * k,
          hostMs: 350_300 + 1.007 * 300 * k,
          packetLast: true,
        });
      }
      const fit = fitOf(samples);
      expect(fit.restarts).toBe(0);
      expect(fit.params.samples).toBe(samples.length);
    });

    it('draws the line between the two clocks at 1 s plus 1% of the host time between the samples', () => {
      expect([CLOCK_RESTART_MS, CLOCK_RESTART_DRIFT]).toEqual([1000, 0.01]);
      const behind = (ms: number): number =>
        fitOf([
          { cubeMs: 10_000, hostMs: 20_000, packetLast: true },
          { cubeMs: 10_000 + 60_000 - ms, hostMs: 20_000 + 60_000, packetLast: true },
        ]).restarts;
      // 60 s of host time: 1000 + 600 ms allowed.
      expect(behind(1600)).toBe(0);
      expect(behind(1600.5)).toBe(1);
      expect(behind(1601)).toBe(1);
    });

    it("waits for a packet's newest move: the older ones of a packet do not start it again", () => {
      const fit = fitOf([
        { cubeMs: 500_000, hostMs: 2_000_000, packetLast: true },
        { cubeMs: 500_300, hostMs: 2_000_300, packetLast: true },
        // After the reconnection, a packet of three moves.
        { cubeMs: 9000, hostMs: 2_400_000, packetLast: false },
        { cubeMs: 9200, hostMs: 2_400_000, packetLast: false },
        { cubeMs: 9400, hostMs: 2_400_000, packetLast: true },
        { cubeMs: 9700, hostMs: 2_400_300, packetLast: true },
      ]);
      expect(fit.restarts).toBe(1);
      expect(fit.params.samples).toBe(2);
      expect(fit.params.a).toBeCloseTo(1, 9);
      expect(fit.toHost(10_000)).toBeCloseTo(2_400_600, 6);
    });
  });

  it('rejects samples that are not finite, and a window that is not a positive integer', () => {
    const fit = new CubeClockFit();
    expect(() => {
      fit.addSample(Number.NaN, 1, true);
    }).toThrow(RangeError);
    expect(() => {
      fit.addSample(1, Number.POSITIVE_INFINITY, false);
    }).toThrow(RangeError);
    expect(fit.params.samples).toBe(0);
    expect(() => new CubeClockFit({ window: 0 })).toThrow(RangeError);
    expect(() => new CubeClockFit({ window: 2.5 })).toThrow(RangeError);
  });
});
