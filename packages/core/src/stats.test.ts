import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from './index';
import {
  AttemptMachine,
  DNF,
  PHASE_NAMES,
  aoN,
  attemptTimes,
  best,
  mean,
  parseMoves,
  phaseAverages,
} from './index';

const SESSION = '5a0c7e3b-9d21-4f68-b4e7-1c2d3e4f5a6b';

/**
 * An attempt on the scramble `R U F` solved by `F' U' R'`, the solve moves `stepMs` apart from
 * 10 s; or a DNF after the first solve move.
 */
function attempt(index: number, stepMs: number, dnf = false): AttemptRecord {
  const machine = new AttemptMachine({
    session: SESSION,
    index,
    scramble: 'R U F',
    scrambleShownMs: 0,
  });
  let ms = 1000;
  for (const m of parseMoves('R U F')) {
    ms += 100;
    machine.onMove({ m, cubeMs: ms, hostMs: ms });
  }
  ms = 10_000;
  for (const m of parseMoves("F' U' R'").slice(0, dnf ? 1 : 3)) {
    machine.onMove({ m, cubeMs: ms, hostMs: ms });
    ms += stepMs;
  }
  if (dnf) {
    machine.markDnf(ms);
  }
  return machine.toRecord();
}

describe('mean', () => {
  it('averages every result', () => {
    expect(mean([1000, 2000, 4500])).toBe(2500);
    expect(mean([12_345])).toBe(12_345);
  });

  it('is null without results, and with a DNF, which has no time to average', () => {
    expect(mean([])).toBeNull();
    expect(mean([1000, DNF, 2000])).toBeNull();
  });
});

describe('best', () => {
  it('is the smallest result, DNFs ignored', () => {
    expect(best([12_000, 9_870, DNF, 10_500])).toBe(9_870);
    expect(best([DNF, 15_000])).toBe(15_000);
  });

  it('is null without a result that is not a DNF', () => {
    expect(best([])).toBeNull();
    expect(best([DNF, DNF])).toBeNull();
  });
});

describe('aoN', () => {
  it('drops the best and the worst of five and averages the other three (WCA average of 5)', () => {
    // 12.34 11.22 13.45 10.99 12.78: without 10.99 and 13.45, (12.34 + 11.22 + 12.78) / 3.
    expect(aoN([12_340, 11_220, 13_450, 10_990, 12_780], 5)).toBeCloseTo(12_113.333, 3);
    expect(aoN([10_000, 10_000, 10_000, 10_000, 10_000], 5)).toBe(10_000);
  });

  it('counts one DNF as the worst result, and is DNF (null) with two', () => {
    // 12.34 DNF 13.45 10.99 12.78: without 10.99 and the DNF, (12.34 + 13.45 + 12.78) / 3.
    expect(aoN([12_340, DNF, 13_450, 10_990, 12_780], 5)).toBeCloseTo(12_856.667, 3);
    expect(aoN([12_340, DNF, 13_450, DNF, 12_780], 5)).toBeNull();
  });

  it('takes the last n results, and is null with fewer', () => {
    expect(aoN([1000, 2000, 3000, 4000], 5)).toBeNull();
    expect(aoN([], 12)).toBeNull();
    // Only the last five count: the two DNFs at the start are not among them.
    expect(aoN([DNF, DNF, 9000, 11_000, 10_000, 12_000, 8000], 5)).toBe(10_000);
    // The last five hold one DNF, dropped as the worst with 9.00 as the best.
    expect(aoN([DNF, DNF, 9000, 11_000, 10_000, 12_000], 5)).toBe(11_000);
  });

  it('trims one best and one worst from 12 and from 100 as well', () => {
    const twelve = [15, 11, 12, 13, 14, 10, 16, 17, 18, 19, 20, 21].map((s) => s * 1000);
    // Without 10 and 21: 11 + 12 + ... + 20 = 155 over 10.
    expect(aoN(twelve, 12)).toBe(15_500);
    const hundred = Array.from({ length: 100 }, (_, k) => 10_000 + 10 * k);
    hundred[37] = DNF;
    // Without the DNF and 10000: the mean of the other 98.
    const kept = hundred.filter((t) => t !== DNF && t !== 10_000);
    expect(kept).toHaveLength(98);
    expect(aoN(hundred, 100)).toBeCloseTo(kept.reduce((a, b) => a + b, 0) / 98, 9);
    expect(aoN(hundred.slice(1), 100)).toBeNull();
  });
});

describe('attemptTimes', () => {
  it("gives a solve's time and a DNF as DNF, in the order of the attempts", () => {
    expect(attemptTimes([attempt(1, 300), attempt(2, 100, true), attempt(3, 500)])).toEqual([
      600,
      DNF,
      1000,
    ]);
    expect(attemptTimes([])).toEqual([]);
  });
});

describe('phaseAverages', () => {
  it('averages each phase over the solves, and the eight add up to their mean time', () => {
    const solves = [attempt(1, 300), attempt(2, 500), attempt(4, 700)];
    const averages = phaseAverages([...solves, attempt(3, 100, true)]);
    expect(averages).not.toBeNull();
    if (averages === null) {
      return;
    }
    expect(Object.keys(averages)).toEqual(PHASE_NAMES);
    for (const [k, name] of PHASE_NAMES.entries()) {
      const phases = solves.map((a) => a.phases[k]);
      expect(averages[name].meanMs).toBeCloseTo(
        phases.reduce((t, p) => t + p.endMs - p.startMs, 0) / 3,
        9,
      );
      expect(averages[name].meanMoves).toBeCloseTo(phases.reduce((t, p) => t + p.moves, 0) / 3, 9);
    }
    const total = PHASE_NAMES.reduce((t, name) => t + averages[name].meanMs, 0);
    // The solves took 600, 1000 and 1400 ms.
    expect(total).toBeCloseTo((600 + 1000 + 1400) / 3, 9);
    const moves = PHASE_NAMES.reduce((t, name) => t + averages[name].meanMoves, 0);
    expect(moves).toBe(3);
  });

  it('is null without a solve whose eight phases were found', () => {
    expect(phaseAverages([])).toBeNull();
    expect(phaseAverages([attempt(1, 100, true)])).toBeNull();
    const partial = attempt(2, 100);
    expect(phaseAverages([{ ...partial, phases: partial.phases.slice(0, 7) }])).toBeNull();
  });
});
