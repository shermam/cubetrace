/// <reference types="node" />
// The owner's two sync checks of 2026-09-27 (issue #38, fixtures/sync/): the MacBook Pro 2021's
// FaceTime HD camera at 1080p30 and the GAN 356 i3, app 0.2.0 with T2.8's detection; the cube held in
// the air close to the camera with both hands, U and U' turned with the fingers, the framing
// rectangle around the cube and the hands. Both failed on the day, every turn found but their lags
// spread over 341 and 343 ms: T2.8 took a turn's time at the first frame of its motion's rise, which
// caught the hand getting ready (from 381 ms before the move to 8 ms after it), while the peak of each
// turn's motion was within −90 to +130 ms of its move. Their data files hold every frame's motion
// (`series`) and the cube's moves, which this test replays: through a copy of T2.8's estimator, which
// must fail as it did, and through the detection since T2.11 (the middle of each turn's motion, the
// spread without the fifth of the lags farthest from their median), which must pass both and give
// offsets that agree. Node's types for this file only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BASELINE_FROM_MS,
  BASELINE_TO_MS,
  ENERGY_FLOOR,
  MIN_BASELINE_FRAMES,
  ONSET_MADS,
  PEAK_MADS,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  detectClapperboard,
  frameHostTimes,
  percentile,
  singleTurns,
  spreadLimitMs,
  type ClapperboardFrame,
} from './clapperboard';

const FOLDER = new URL('../../../fixtures/sync/', import.meta.url);

/** What this test reads of a check's data file (apps/web/src/app/camera/sync-report.ts). */
interface CheckData {
  readonly result: { readonly spreadMs: number; readonly matched: number; readonly frames: number };
  readonly clock: { readonly arrivalOffsetMs: number; readonly frameMinusPageMs: number };
  readonly turns: readonly {
    readonly moveHostMs: number;
    readonly onsetHostMs: number | null;
    readonly lagMs: number | null;
  }[];
  readonly moves: readonly { readonly hostMs: number }[];
  readonly series: readonly {
    readonly hostMs: number;
    readonly mean: number;
    readonly changed: number;
  }[];
}

interface Check {
  readonly data: CheckData;
  /** The frames as the check had them from the capture worker (sync-run.ts). */
  readonly frames: ClapperboardFrame[];
  /** The cube's moves, host ms. */
  readonly moves: number[];
}

/**
 * A check's frames and moves from its data file. The file keeps each frame at its host time, its
 * timestamp plus the arrival offset of the day, so the frame's timestamp is its host time less that
 * offset and its arrival that host time (their median distance is the offset); the page received each
 * frame `frameMinusPageMs` after its host time (1.1 and 1.4 ms).
 */
function load(file: string): Check {
  const data = JSON.parse(readFileSync(new URL(file, FOLDER), 'utf8')) as CheckData;
  const { arrivalOffsetMs, frameMinusPageMs } = data.clock;
  const frames = data.series.map((frame) => ({
    timestampUs: Math.round((frame.hostMs - arrivalOffsetMs) * 1000),
    arrivalHostMs: frame.hostMs,
    receivedHostMs: frame.hostMs - frameMinusPageMs,
    mean: frame.mean,
    changed: frame.changed,
    costMs: 0.8,
  }));
  return { data, frames, moves: data.moves.map((move) => move.hostMs) };
}

const CHECK_1 = load('2026-09-27-macbook-pro-2021-facetime-check-1.json');
const CHECK_2 = load('2026-09-27-macbook-pro-2021-facetime-check-2.json');

/** What T2.8's estimator gives: each matched turn's lag, in the order of the moves, and the result. */
interface FirstRise {
  readonly lags: (number | null)[];
  readonly offsetMs: number;
  readonly spreadMs: number;
  readonly limitMs: number;
  readonly ok: boolean;
}

/**
 * T2.8's estimator, as it was until T2.11 (a copy, to show what it gave): a single turn's time is the
 * first frame of its window (t − 400 to t + 700 ms) that rises above baseline + max(3 MAD, 0.1%) from a
 * frame that did not, provided the window's peak exceeds baseline + max(6 MAD, 0.2%), the baseline
 * being the median and MAD of the changed area from t − 900 to t − 300 ms; a rise goes to one turn
 * only (the nearer move keeps it, the other takes its next rise); the offset is the median lag and
 * the spread the 95th minus the 5th percentile (nearest rank) of all the lags, against the same
 * limit, 50 ms plus the frames' median interval.
 */
function firstRiseOfT28(frames: readonly ClapperboardFrame[], moves: readonly number[]): FirstRise {
  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const ordered = [...frames].sort((p, q) => p.timestampUs - q.timestampUs);
  const { times } = frameHostTimes(ordered);
  const energies = ordered.map((frame) => frame.changed);
  const from = (at: number): number => times.filter((time) => time < at).length;
  const through = (at: number): number => times.filter((time) => time <= at).length;
  const turns = singleTurns(moves);
  const rises = turns.map((move) => {
    const first = from(move - WINDOW_BEFORE_MS);
    const end = through(move + WINDOW_AFTER_MS);
    const before = energies.slice(from(move - BASELINE_FROM_MS), through(move - BASELINE_TO_MS));
    if (first >= end || before.length < MIN_BASELINE_FRAMES) {
      return [];
    }
    const baseline = median(before);
    const mad = median(before.map((value) => Math.abs(value - baseline)));
    const onset = baseline + Math.max(ONSET_MADS * mad, ENERGY_FLOOR);
    if (Math.max(...energies.slice(first, end)) <= baseline + Math.max(PEAK_MADS * mad, 0.002)) {
      return [];
    }
    const found: number[] = [];
    for (let i = Math.max(first, 1); i < end; i++) {
      if (energies[i] > onset && energies[i - 1] <= onset) {
        found.push(i);
      }
    }
    return found;
  });
  const next = turns.map(() => 0);
  const holders = new Map<number, number>();
  const waiting = turns.flatMap((_, k) => (rises[k].length > 0 ? [k] : []));
  for (let k = waiting.shift(); k !== undefined; k = waiting.shift()) {
    while (next[k] < rises[k].length) {
      const frame = rises[k][next[k]];
      const holder = holders.get(frame);
      if (holder === undefined) {
        holders.set(frame, k);
        break;
      }
      const mine = Math.abs(times[frame] - turns[k]);
      const theirs = Math.abs(times[frame] - turns[holder]);
      if (mine < theirs || (mine === theirs && turns[k] < turns[holder])) {
        holders.set(frame, k);
        next[holder] += 1;
        waiting.push(holder);
        break;
      }
      next[k] += 1;
    }
  }
  const lags: (number | null)[] = turns.map(() => null);
  for (const [frame, k] of holders) {
    lags[k] = Math.round(times[frame] * 100) / 100 - turns[k];
  }
  const matched = lags.filter((lag) => lag !== null).sort((a, b) => a - b);
  const intervals = times.slice(1).map((time, k) => time - times[k]);
  const spreadMs = percentile(matched, 0.95) - percentile(matched, 0.05);
  const limitMs = spreadLimitMs(median(intervals));
  return { lags, offsetMs: median(matched), spreadMs, limitMs, ok: spreadMs <= limitMs };
}

describe("the owner's sync checks on the MacBook's FaceTime camera (issue #38)", () => {
  it("fail with T2.8's first rise, as they did on the day: the lags spread over 341 and 343 ms", () => {
    const old = [CHECK_1, CHECK_2].map(({ data, frames, moves }) => {
      const result = firstRiseOfT28(frames, moves);
      // The copy is T2.8's: it gives the lags the app gave on the day, turn by turn.
      expect(result.lags.map((lag) => (lag === null ? null : Math.round(lag * 10) / 10))).toEqual(
        data.turns.map((turn) => turn.lagMs),
      );
      expect(result.spreadMs).toBeCloseTo(data.result.spreadMs, 1);
      return result;
    });
    const tenth = (value: number): number => Math.round(value * 10) / 10;
    console.log(
      `T2.8's first rise: ${JSON.stringify(old.map(({ offsetMs, spreadMs, limitMs }) => ({ offsetMs: tenth(offsetMs), spreadMs: tenth(spreadMs), limitMs: tenth(limitMs) })))}`,
    );

    expect(old.map((result) => result.ok)).toEqual([false, false]);
    expect(Math.abs(old[0].spreadMs - 341)).toBeLessThanOrEqual(5);
    expect(Math.abs(old[1].spreadMs - 343)).toBeLessThanOrEqual(5);
    // Against a limit of 83 ms at 30 fps.
    for (const result of old) {
      expect(result.limitMs).toBeCloseTo(83, 0);
    }
  });

  it('pass with the middle of each turn’s motion and a trimmed spread, and agree within 25 ms', () => {
    const [first, second] = [CHECK_1, CHECK_2].map(({ data, frames, moves }) => {
      const result = detectClapperboard(frames, moves);
      const { analysis } = result;
      // Every turn T2.8 matched is matched, and its first rise is still in the diagnostics.
      expect(analysis.matched).toBe(data.result.matched);
      expect(analysis.turns.map((turn) => turn.onsetHostMs)).toEqual(
        data.turns.map((turn) => turn.onsetHostMs),
      );
      expect(analysis.estimator).toBe('motion-centre');
      expect(analysis.kept + analysis.dropped.length).toBe(analysis.matched);
      console.log(
        `${String(data.result.frames)} frames: lags ${JSON.stringify(analysis.turns.map((turn) => turn.lagMs))}; ` +
          `dropped ${JSON.stringify(analysis.dropped.map((pair) => pair.lagMs))}; ` +
          (result.ok
            ? `lag ${String(result.offsetMs)} ms, spread ${String(result.clapperboardResidualMs)} ms ` +
              `over ${String(result.clapperboardSamples)} turns of ${String(analysis.matched)}`
            : result.message),
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) {
        throw new Error(result.message);
      }
      expect(result.clapperboardResidualMs).toBeLessThanOrEqual(analysis.maxSpreadMs);
      expect(result.clapperboardSamples).toBeGreaterThanOrEqual(7);
      expect(result.samples).toHaveLength(result.clapperboardSamples);
      return result;
    });

    // Ten turns matched, two left out; nine matched (the first turn came before a baseline), two left
    // out.
    expect([first.analysis.matched, first.clapperboardSamples]).toEqual([10, 8]);
    expect([second.analysis.matched, second.clapperboardSamples]).toEqual([9, 7]);
    expect(Math.abs(first.offsetMs - 38)).toBeLessThanOrEqual(10);
    expect(Math.abs(second.offsetMs - 19)).toBeLessThanOrEqual(10);
    expect(Math.abs(first.offsetMs - second.offsetMs)).toBeLessThanOrEqual(25);
  });
});
