import { describe, expect, it } from 'vitest';

import { CLOCK_FIT_WINDOW, CubeClockFit } from './index';

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
