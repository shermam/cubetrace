import type { MotionSample } from '@cubetrace/capture';
import { parseMove } from '@cubetrace/core';
import type { CubeEvent } from '@cubetrace/gan';
import { Subject } from 'rxjs';

import { FakePerformance, FakeTimers } from '../device/fake-browser';
import { SYNC_HOLD_MS, SYNC_TICK_MS, SyncRun, type SyncOutcome } from './sync-run';
import { FRAME_MS, STILL, clapperboard } from './sync-testing';

/**
 * A check on a fake clock (T2.11): its frames' motion and the cube's moves are handed to it as the
 * capture worker and the cube would.
 */
function harness(options: { readonly untilDone?: boolean } = {}) {
  const perf = new FakePerformance();
  const timers = new FakeTimers(perf);
  const events$ = new Subject<CubeEvent>();
  let onSample: ((sample: MotionSample) => void) | null = null;
  const ended: (SyncOutcome | null)[] = [];
  const run = new SyncRun({
    watch: (_rect, sample) => {
      onSample = sample;
      return () => {
        onSample = null;
      };
    },
    rect: null,
    events$,
    untilDone: options.untilDone,
    now: () => perf.hostMs,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEnd: (outcome) => ended.push(outcome),
  });
  const start = perf.hostMs;
  let frames = 0;
  /**
   * Films `ms` more of the check: a frame every 33.3 ms from its start, and the cube's turns at those
   * of `turns` (host ms) that come in that time, in their place among the frames, U then U'.
   */
  const film = (ms: number, energy: (hostMs: number) => number, turns: readonly number[] = []) => {
    const end = perf.hostMs + ms;
    const pending = turns.filter((at) => at > perf.hostMs).sort((a, b) => a - b);
    while (start + (frames + 1) * FRAME_MS <= end + 0.001) {
      const next = start + (frames + 1) * FRAME_MS;
      const turnAt = pending.at(0);
      if (turnAt !== undefined && turnAt <= next) {
        timers.advance(turnAt - perf.hostMs);
        const move = run.data().moves.length % 2 === 0 ? 'U' : "U'";
        events$.next({
          type: 'move',
          m: parseMove(move),
          cubeMs: 0,
          hostMs: perf.hostMs,
          packetLast: true,
        });
        pending.shift();
        continue;
      }
      timers.advance(next - perf.hostMs);
      const changed = energy(next);
      onSample?.({ timestampUs: next * 1000, arrivalHostMs: next, mean: 1, changed, costMs: 0.9 });
      frames += 1;
    }
    timers.advance(end - perf.hostMs);
  };
  return { run, film, start: () => start, ended };
}

describe('SyncRun', () => {
  it('asks to hold still for its first second, and counts no turn made then', () => {
    const { run, film, start } = harness();
    expect(SYNC_HOLD_MS).toBe(1000);
    expect(run.holding()).toBe(true);
    expect(run.moves()).toBe(0);
    expect(run.secondsLeft()).toBe(20);

    // A turn half a second in: not counted, but kept for the check's data.
    film(600, STILL, [start() + 500]);
    expect(run.holding()).toBe(true);
    expect(run.moves()).toBe(0);
    expect(run.data().moves).toHaveLength(1);

    // A second in, it waits for the first turn.
    film(SYNC_HOLD_MS - 600 + SYNC_TICK_MS, STILL);
    expect(run.holding()).toBe(false);
    expect(run.moves()).toBe(0);
    expect(run.secondsLeft()).toBe(19);

    // A turn from then on counts.
    film(1000, STILL, [start() + 1800]);
    expect(run.moves()).toBe(1);
    expect(run.data().moves).toHaveLength(2);
    expect(run.secondsLeft()).toBe(0);
    run.cancel();
  });

  it("ends the capture lab's check once its ten turns are matched and it passes, though its spread keeps eight", () => {
    const { run, film, start, ended } = harness({ untilDone: false });
    // Two of the ten lags far off, which the spread leaves out.
    const { turns, energy } = clapperboard(start(), [45, 10, 47, 48, 49, 95, 49, 50, 51, 53]);

    // The tenth turn is 12 s in: a second after it, the check ends, well before its 20 s.
    film(13_500, energy, turns);

    expect(run.state()).toBe('done');
    expect(ended).toHaveLength(1);
    expect(run.outcome()).toMatchObject({
      ok: true,
      offsetMs: 49,
      clapperboardResidualMs: 8,
      clapperboardSamples: 8,
      analysis: { matched: 10, kept: 8 },
    });
    expect(run.outcome()?.durationMs).toBeLessThan(14_000);
  });
});
