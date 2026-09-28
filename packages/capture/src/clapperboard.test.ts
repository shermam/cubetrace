import { describe, expect, it } from 'vitest';

import {
  BASELINE_FROM_MS,
  BASELINE_TO_MS,
  CLOCK_TOLERANCE_MS,
  DROPPED_PERCENT,
  EARLIER_PEAK_SHARE,
  ENERGY_FLOOR,
  EVENT_HALF_WINDOW_MS,
  MIN_BASELINE_FRAMES,
  MIN_MATCHES,
  MIN_SPREAD_LIMIT_MS,
  ONSET_MADS,
  PEAK_MADS,
  SINGLE_TURN_MS,
  SPREAD_ALLOWANCE_MS,
  SYNC_CHECK_MS,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  detectClapperboard,
  droppedCount,
  frameHostTimes,
  percentile,
  singleTurns,
  spreadLimitMs,
  type ClapperboardFrame,
} from './clapperboard';

// Synthetic sync checks: 20 s of a 30 fps camera whose frames have a timestamp on their own clock
// (µs) and arrive in the worker at a constant offset on the host clock (ms) plus a jitter whose
// median is 0, and reach the page 2 ms later; a still picture where a few pixels in ten thousand
// change from one frame to the next; a turn's motion over five frames, 1.2 to 3.5% of the pixels,
// rising to its middle frame and falling as it rose, so that its middle, the check's event (T2.11),
// is that frame.
const FPS = 30;
const FRAMES = (SYNC_CHECK_MS / 1000) * FPS;
const T0_US = 5_305_665_091;
const OFFSET_MS = 1_790_511_037_934.5;
const JITTER_MS = [0, 3, -3, 0, 8, -8, 0];

function timestampUs(frame: number): number {
  return T0_US + Math.round((frame * 1e6) / FPS);
}

/** The frame's host time: its timestamp on the host clock, without the arrival's jitter. */
function hostMs(frame: number): number {
  return timestampUs(frame) / 1000 + OFFSET_MS;
}

/** A still picture's changed area: 1 to 5 pixels in 10,000. */
function still(frame: number): number {
  return 0.0003 + 0.0002 * Math.sin(frame * 1.7);
}

/**
 * A turn's motion, frame by frame from two frames before its middle to two after: the changed area,
 * and the mean difference.
 */
const TURN = [0.012, 0.028, 0.035, 0.028, 0.012];
const TURN_MEAN = [6, 11, 14, 11, 6];

interface Turn {
  /** The frame at the middle of its motion in the camera's picture. */
  readonly frame: number;
  /** How far the camera lags the cube's report of it, ms; null: motion without a turn (a hand). */
  readonly lagMs: number | null;
  /** False: the camera did not see it (the cube's report is there). */
  readonly seen?: boolean;
  /** How strong its motion is, against a turn's (1 by default). */
  readonly scale?: number;
}

/**
 * Five turns two seconds apart, from 2 s, lagged by 38 to 45 ms: median 41; the one farthest from it
 * (45) is left out of the spread, and the other four have a median of 40.5 and a spread of 6.
 */
const FIVE: readonly Turn[] = [38, 41, 45, 40, 44].map((lagMs, k) => ({
  frame: 60 * (k + 1),
  lagMs,
}));

/**
 * The frames' motion and the moves' host times of a check with `turns`. `frameClockMs` puts the
 * frames' timestamps and arrivals that far ahead of the page's clock, as a worker's clock that is
 * wrong would; the page receives each frame 2 ms after it arrived, on its own clock.
 */
function check(
  turns: readonly Turn[],
  energy: (frame: number) => number = still,
  frameClockMs = 0,
): { frames: ClapperboardFrame[]; moves: number[] } {
  const motion = new Map<number, { readonly changed: number; readonly mean: number }>();
  for (const turn of turns) {
    if (turn.seen !== false) {
      const scale = turn.scale ?? 1;
      TURN.forEach((changed, k) =>
        motion.set(turn.frame - 2 + k, { changed: changed * scale, mean: TURN_MEAN[k] * scale }),
      );
    }
  }
  const frames = Array.from({ length: FRAMES }, (_, frame) => {
    const at = motion.get(frame);
    return {
      timestampUs: timestampUs(frame) + frameClockMs * 1000,
      arrivalHostMs: hostMs(frame) + frameClockMs + JITTER_MS[frame % JITTER_MS.length],
      receivedHostMs: hostMs(frame) + JITTER_MS[frame % JITTER_MS.length] + 2,
      mean: at === undefined ? 1 + 0.3 * Math.sin(frame * 1.7) : at.mean,
      changed: at === undefined ? energy(frame) : at.changed,
      costMs: 0.8,
    };
  });
  const moves = turns.flatMap((turn) =>
    turn.lagMs === null ? [] : [hostMs(turn.frame) - turn.lagMs],
  );
  return { frames, moves };
}

/**
 * A check filmed at `fps` frames a second for 20 s: five turns, the middles of their motion on the
 * frames nearest 2, 4, 6, 8 and 10 s, each reported by the cube its lag (ms) before that frame.
 */
function atRate(
  fps: number,
  lags: readonly number[],
): { frames: ClapperboardFrame[]; moves: number[] } {
  const stamp = (frame: number): number => T0_US + Math.round((frame * 1e6) / fps);
  const host = (frame: number): number => stamp(frame) / 1000 + OFFSET_MS;
  const middles = lags.map((_, k) => Math.round(2 * (k + 1) * fps));
  const motion = new Map<number, number>();
  for (const middle of middles) {
    TURN.forEach((_, k) => motion.set(middle - 2 + k, k));
  }
  const frames = Array.from({ length: 20 * fps }, (_, frame) => {
    const at = motion.get(frame);
    return {
      timestampUs: stamp(frame),
      arrivalHostMs: host(frame),
      receivedHostMs: host(frame) + 2,
      mean: at === undefined ? 1 : TURN_MEAN[at],
      changed: at === undefined ? still(frame) : TURN[at],
      costMs: 0.8,
    };
  });
  return { frames, moves: middles.map((middle, k) => host(middle) - lags[k]) };
}

/** Whether `times` are the host times of the frames `frames`, to a tenth of a ms. */
function expectTimes(times: readonly (number | null)[], frames: readonly number[]): void {
  expect(times).toHaveLength(frames.length);
  times.forEach((time, k) => {
    expect(time).toBeCloseTo(hostMs(frames[k]), 1);
  });
}

/** Whether `values` are `expected`, each to a tenth. */
function expectClose(values: readonly (number | null)[], expected: readonly number[]): void {
  expect(values).toHaveLength(expected.length);
  values.forEach((value, k) => {
    expect(value).toBeCloseTo(expected[k], 1);
  });
}

describe('the thresholds', () => {
  it("are the plan's", () => {
    expect([SYNC_CHECK_MS, WINDOW_BEFORE_MS, WINDOW_AFTER_MS]).toEqual([20_000, 400, 700]);
    expect([BASELINE_FROM_MS, BASELINE_TO_MS, MIN_BASELINE_FRAMES]).toEqual([900, 300, 5]);
    expect([ONSET_MADS, PEAK_MADS, ENERGY_FLOOR]).toEqual([3, 6, 0.001]);
    expect([EVENT_HALF_WINDOW_MS, EARLIER_PEAK_SHARE, DROPPED_PERCENT]).toEqual([150, 0.8, 20]);
    expect([MIN_MATCHES, SINGLE_TURN_MS, CLOCK_TOLERANCE_MS]).toEqual([4, 500, 1000]);
    expect([SPREAD_ALLOWANCE_MS, MIN_SPREAD_LIMIT_MS]).toEqual([50, 40]);
  });

  it('allow a spread of 50 ms plus the frames’ interval, and never under 40', () => {
    expect(spreadLimitMs(1000 / 30)).toBeCloseTo(83.33, 2);
    expect(spreadLimitMs(1000 / 60)).toBeCloseTo(66.67, 2);
    expect(spreadLimitMs(1000 / 120)).toBeCloseTo(58.33, 2);
    expect(spreadLimitMs(0)).toBe(50);
    // Without an interval (fewer than two frames): the floor.
    expect(spreadLimitMs(null)).toBe(40);
  });

  it('leave a fifth of the matched turns out of the spread, rounded up, and none of fewer than four', () => {
    expect([0, 1, 2, 3].map(droppedCount)).toEqual([0, 0, 0, 0]);
    expect([4, 5, 6, 7, 8, 9, 10].map(droppedCount)).toEqual([1, 1, 2, 2, 2, 2, 2]);
    expect([11, 15, 16, 20].map(droppedCount)).toEqual([3, 3, 4, 4]);
  });
});

describe('detectClapperboard', () => {
  it("finds the middle of each turn's motion in the frames around it, and gives the median lag and the spread of all but the farthest", () => {
    const { frames, moves } = check(FIVE);

    const result = detectClapperboard(frames, moves);

    // Lags 38, 41, 45, 40 and 44: 45 is the farthest from their median, 41; the other four have a
    // median of 40.5 and a spread of 6.
    expect(result).toMatchObject({
      ok: true,
      offsetMs: 40.5,
      clapperboardResidualMs: 6,
      clapperboardSamples: 4,
    });
    const samples = result.ok ? result.samples : [];
    expect(samples.map((sample) => sample.moveHostMs)).toEqual([0, 1, 3, 4].map((k) => moves[k]));
    // `onsetHostMs` is the event, the name session.json keeps.
    expectTimes(
      samples.map((sample) => sample.onsetHostMs),
      [0, 1, 3, 4].map((k) => FIVE[k].frame),
    );
    expect(result.analysis).toMatchObject({
      estimator: 'motion-centre',
      frames: FRAMES,
      moves: 5,
      matched: 5,
      unmatched: 0,
      kept: 4,
      offsetMs: 40.5,
      spreadMs: 6,
      // The arrivals' jitter does not move the frames: their median offset is the true one; the page
      // got them 2 ms after they arrived.
      clock: { arrivalOffsetMs: OFFSET_MS, arrivalResidualP95Ms: 8, frameMinusPageMs: -2 },
      // Frames at 30 fps: a spread of up to 50 ms plus a frame passes.
      frameIntervalMs: 33.33,
      maxSpreadMs: 83.3,
    });
    expect(result.analysis.pairs.map((pair) => pair.moveHostMs)).toEqual(moves);
    expect(result.analysis.dropped).toHaveLength(1);
    expect(result.analysis.dropped[0]).toMatchObject({ moveHostMs: moves[2] });
    expect(result.analysis.dropped[0].lagMs).toBeCloseTo(45, 1);
    expect(result.analysis.dropped[0].onsetHostMs).toBeCloseTo(hostMs(FIVE[2].frame), 1);
    expect(result.analysis.turns.map((turn) => turn.miss)).toEqual(Array(5).fill(null));
    expectClose(
      result.analysis.turns.map((turn) => turn.lagMs),
      [38, 41, 45, 40, 44],
    );
  });

  it('says, for each turn, where it looked, the baseline, its deviation, the peak, the onset and the event', () => {
    const { frames, moves } = check(FIVE);

    const [first] = detectClapperboard(frames, moves).analysis.turns;

    const move = moves[0];
    expect(first.moveHostMs).toBe(move);
    expect(first.windowStartMs).toBeCloseTo(move - 400, 2);
    expect(first.windowEndMs).toBeCloseTo(move + 700, 2);
    // 1.1 s of frames at 30 fps.
    expect(first.frames).toBeGreaterThanOrEqual(32);
    expect(first.frames).toBeLessThanOrEqual(34);
    expect(first.baseline).toBeCloseTo(0.0003, 4);
    expect(first.mad).toBeGreaterThan(0);
    expect(first.mad).toBeLessThan(0.0002);
    // The floor decides both levels here: the still picture varies by less.
    expect(first.onsetLevel).toBeCloseTo((first.baseline ?? 0) + ENERGY_FLOOR, 6);
    expect(first.peakLevel).toBeCloseTo((first.baseline ?? 0) + 2 * ENERGY_FLOOR, 6);
    // The peak in the middle of the motion; the onset, its first frame, two before; the event, the
    // middle of the motion, on the peak (the motion falls as it rose).
    expect(first.peak).toBe(0.035);
    expect(first.peakHostMs).toBeCloseTo(hostMs(FIVE[0].frame), 1);
    expect(first.onsetHostMs).toBeCloseTo(hostMs(FIVE[0].frame - 2), 1);
    expect(first.eventHostMs).toBeCloseTo(hostMs(FIVE[0].frame), 1);
    expect(first.lagMs).toBeCloseTo(38, 1);
    expect(first.miss).toBeNull();
  });

  it("takes the middle of a turn's motion, weighing its frames by the square of their rise", () => {
    // A motion that rises over two frames and falls over one: 1%, 2%, 3.5%, then 0.5%; its middle is
    // before the peak, where the frames that changed most are.
    const shape = [0.01, 0.02, 0.035, 0.005];
    const { frames, moves } = check(FIVE);
    const peaks = FIVE.map((turn) => turn.frame);
    const skewed = frames.map((frame, k) => {
      const at = peaks.findIndex((peak) => k >= peak - 2 && k <= peak + 2);
      return at < 0 ? frame : { ...frame, changed: shape[k - peaks[at] + 2] ?? still(k) };
    });

    const [first] = detectClapperboard(skewed, moves).analysis.turns;

    const excess = shape.map((changed) => Math.max(0, changed - (first.baseline ?? 0)) ** 2);
    const middle =
      excess.reduce((sum, weight, k) => sum + weight * (k - 2), 0) /
      excess.reduce((sum, weight) => sum + weight, 0);
    // A third of a frame before the peak.
    expect(middle).toBeGreaterThan(-0.4);
    expect(middle).toBeLessThan(-0.25);
    expect(first.peakHostMs).toBeCloseTo(hostMs(FIVE[0].frame), 1);
    expect(first.eventHostMs).toBeCloseTo(hostMs(FIVE[0].frame) + (middle * 1000) / FPS, 0);
  });

  it('takes no noise under the onset level for a turn', () => {
    // Noise three times the still picture's level, on every seventh frame.
    const { frames, moves } = check(FIVE, (frame) => (frame % 7 === 3 ? 0.0009 : still(frame)));

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, offsetMs: 40.5, clapperboardSamples: 4 });
  });

  it('passes with four turns when the camera missed one, which it says had no clear change', () => {
    const turns = FIVE.map((turn, k) => (k === 2 ? { ...turn, seen: false } : turn));
    const { frames, moves } = check(turns);
    // The move is there, but no motion.
    expect(moves).toHaveLength(5);

    const result = detectClapperboard(frames, moves);

    // Lags 38, 41, 40, 44: the median is 40.5; 44 is the farthest from it, and the other three have
    // a median of 40 and a spread of 3.
    expect(result).toMatchObject({
      ok: true,
      offsetMs: 40,
      clapperboardResidualMs: 3,
      clapperboardSamples: 3,
    });
    expect(result.analysis).toMatchObject({ matched: 4, unmatched: 1, kept: 3 });
    expect(result.analysis.turns[2]).toMatchObject({
      onsetHostMs: null,
      eventHostMs: null,
      miss: 'no-rise',
    });
  });

  it('leaves the two lags farthest from the median of ten out of the spread, and passes with the other eight', () => {
    // Ten turns 1.5 s apart, two of them 60 ms before and 150 ms after the others' 38 to 43 ms: the
    // spread of all ten would be 210 ms.
    const lags = [40, 42, 38, 41, 150, 39, 43, -60, 40, 41];
    const turns = lags.map((lagMs, k) => ({ frame: 45 * (k + 1), lagMs }));
    const { frames, moves } = check(turns);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({
      ok: true,
      offsetMs: 40.5,
      clapperboardResidualMs: 5,
      clapperboardSamples: 8,
      analysis: { matched: 10, kept: 8, spreadMs: 5 },
    });
    // In the order of the moves, with their lags.
    expect(result.analysis.dropped.map((pair) => pair.moveHostMs)).toEqual([moves[4], moves[7]]);
    expectClose(
      result.analysis.dropped.map((pair) => pair.lagMs),
      [150, -60],
    );
    expect(result.ok ? result.samples.map((sample) => sample.moveHostMs) : []).toEqual(
      moves.filter((_, k) => k !== 4 && k !== 7),
    );
  });

  it('leaves the later turn out of the spread when two lags are as far from the median', () => {
    // A still picture that does not vary, so that the lags are exact: 38, 43, 40, 41; the median is
    // 40.5, from which 38 and 43 are 2.5 ms: 43 is left out.
    const turns = [38, 43, 40, 41].map((lagMs, k) => ({ frame: 60 * (k + 1), lagMs }));
    const { frames, moves } = check(turns, () => 0.0003);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, offsetMs: 40, clapperboardResidualMs: 3 });
    expect(result.analysis.dropped).toEqual([
      { moveHostMs: moves[1], onsetHostMs: expect.any(Number) as number, lagMs: 43 },
    ]);
  });

  it('ignores motion far from any turn', () => {
    // A hand moving at 13 s (and at 14.1 s), more than half a second from every turn.
    const { frames, moves } = check([
      ...FIVE,
      { frame: 390, lagMs: null },
      { frame: 423, lagMs: null },
    ]);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, offsetMs: 40.5, clapperboardSamples: 4 });
  });

  it('keeps a turn on its own motion when a later one in its window is as strong, or an earlier one weaker', () => {
    // After each turn, a hand moving 500 ms later, 10% more than the turn's; before it, the hand
    // getting ready, 300 ms earlier, 60% as much as the turn's.
    const { frames, moves } = check([
      ...FIVE,
      ...FIVE.map((turn) => ({ frame: turn.frame + 15, lagMs: null, scale: 1.1 })),
      ...FIVE.map((turn) => ({ frame: turn.frame - 9, lagMs: null, scale: 0.6 })),
    ]);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, offsetMs: 40.5, clapperboardSamples: 4 });
    expectClose(
      result.analysis.turns.map((turn) => turn.lagMs),
      [38, 41, 45, 40, 44],
    );
    // Its onset, the first rise of its window, is the hand getting ready.
    expect(result.analysis.turns[0].onsetHostMs).toBeCloseTo(hostMs(FIVE[0].frame - 11), 1);

    // A later motion more than 1 / EARLIER_PEAK_SHARE times as strong (1.5) takes the turn's place:
    // the lag is to it.
    const stronger = check([FIVE[0], { frame: FIVE[0].frame + 15, lagMs: null, scale: 1.5 }]);
    const [turn] = detectClapperboard(stronger.frames, stronger.moves).analysis.turns;
    expect(turn.lagMs).toBeCloseTo(538, 1);
  });

  it('finds the turns in a picture that changes everywhere a little all the time', () => {
    // 1 to 2% of the pixels change on every frame (a person moving, in dim light): the turns rise
    // above that by more than its deviation, which the detection measures around each turn.
    const busy = (frame: number): number => 0.012 + 0.003 * Math.sin(frame * 2.3);
    const { frames, moves } = check(FIVE, busy);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, clapperboardSamples: 4 });
    // The picture's changes around each turn that rise above its baseline weigh a little in the
    // middle of its motion: the lags are within a ms of the turns' (41 against 40.5).
    const offset = result.ok ? result.offsetMs : Number.NaN;
    expect(Math.abs(offset - 40.5)).toBeLessThan(1);
  });

  it('fails with fewer than four matches, saying how many turns matched and why the others did not', () => {
    const three = check(FIVE.slice(0, 3));
    expect(detectClapperboard(three.frames, three.moves)).toMatchObject({
      ok: false,
      reason: 'few-matches',
      message: 'fewer than 4 matches (3 of 3 single turns matched a motion)',
      // None is left out of the spread of fewer than four.
      analysis: { matched: 3, kept: 3, dropped: [] },
    });

    const unseen = FIVE.map((turn, k) => (k >= 2 ? { ...turn, seen: false } : turn));
    // A sixth turn in the check's first half second, before any baseline.
    const { frames, moves } = check([{ frame: 14, lagMs: 40 }, ...unseen]);
    const result = detectClapperboard(frames, moves);
    expect(result).toMatchObject({
      ok: false,
      reason: 'few-matches',
      message:
        'fewer than 4 matches (2 of 6 single turns matched a motion; 3 without a clear change ' +
        'in the rectangle, 1 too soon after the start)',
    });
    expect(result.analysis.pairs).toHaveLength(2);
    expect(result.analysis.turns.map((turn) => turn.miss)).toEqual([
      'no-baseline',
      null,
      null,
      'no-rise',
      'no-rise',
      'no-rise',
    ]);
  });

  it("matches only single turns: a scramble's turns, close together, match no motion", () => {
    // A scramble's twenty turns 60 ms apart from 13 s, with its motion from their start; the five
    // single turns as before.
    const scramble = Array.from({ length: 20 }, (_, k) => hostMs(390) - 40 + 60 * k);
    const { frames, moves } = check([...FIVE, { frame: 390, lagMs: null }]);

    const result = detectClapperboard(frames, [...moves, ...scramble]);

    expect(result).toMatchObject({ ok: true, offsetMs: 40.5, clapperboardSamples: 4 });
    expect(result.analysis.moves).toBe(25);
    expect(result.analysis.turns).toHaveLength(5);

    // Only the scramble: its motion is near its turns, but none of them is single.
    const alone = check([{ frame: 390, lagMs: null }]).frames;
    expect(detectClapperboard(alone, scramble)).toMatchObject({
      ok: false,
      reason: 'few-matches',
      message:
        'fewer than 4 matches (0 of 0 single turns matched a motion; 20 turns came within half ' +
        'a second of another)',
    });
  });

  it('gives a motion to one turn only: the nearer move keeps its peak, the other takes the next peak of its window', () => {
    // Two single turns 600 ms apart, one motion whose middle is 20 ms after the second (frame 168):
    // it lies in both turns' windows, and the second keeps it; the first has nothing else.
    const second = hostMs(168) - 20;
    const first = second - 600;
    const one = check([{ frame: 168, lagMs: null }]).frames;
    const shared = detectClapperboard(one, [first, second]).analysis.turns;
    expect(shared.map((turn) => turn.miss)).toEqual(['taken', null]);
    expect(shared[1].lagMs).toBeCloseTo(20, 1);
    expect(shared[0]).toMatchObject({ onsetHostMs: null, eventHostMs: null, lagMs: null });

    // Motion 250 ms after the first turn (frame 150) and 50 ms after the second, 600 ms later (frame
    // 162), as strong: the first motion lies in both windows, where it comes first, but is nearer the
    // first turn, which keeps it; the second turn takes the next peak of its window.
    const a = hostMs(150) - 250;
    const b = a + 600;
    expect(hostMs(162) - b).toBeCloseTo(50, 1);
    const two = check([
      { frame: 150, lagMs: null },
      { frame: 162, lagMs: null },
    ]).frames;
    const both = detectClapperboard(two, [a, b]).analysis.turns;
    expect(both.map((turn) => turn.miss)).toEqual([null, null]);
    expect(both[0].lagMs).toBeCloseTo(250, 1);
    expect(both[1].lagMs).toBeCloseTo(50, 1);

    // A turn the camera missed, 650 ms before another whose motion's middle is 720 ms after the first:
    // the first turn's window ends 20 ms before that middle, so its peak is the motion's rising frame
    // before it, another frame than the second turn's peak but the same motion, which the second keeps.
    const c = hostMs(300) - 720;
    const d = c + 650;
    const edge = check([{ frame: 300, lagMs: null }]).frames;
    const cut = detectClapperboard(edge, [c, d]).analysis.turns;
    expect(cut.map((turn) => turn.miss)).toEqual(['taken', null]);
    expect(cut[1].lagMs).toBeCloseTo(70, 1);
  });

  it('says the picture was already changing when it never rises in the window from below', () => {
    // Motion from 450 ms before the second turn to 800 ms after it: above the onset level from before
    // its window to its end, and far above the baseline, which is mostly from before it.
    const { moves } = check(FIVE);
    const move = moves[1];
    const turns = FIVE.map((turn, k) => (k === 1 ? { ...turn, seen: false } : turn));
    const { frames } = check(turns, (frame) => {
      const time = hostMs(frame);
      return time >= move - 450 && time <= move + 800 ? 0.03 : still(frame);
    });

    const result = detectClapperboard(frames, moves);

    expect(result.analysis.turns[1]).toMatchObject({
      miss: 'no-onset',
      onsetHostMs: null,
      eventHostMs: null,
    });
    // The other four: 38, 45, 40, 44, of which 38 is left out.
    expect(result).toMatchObject({ ok: true, clapperboardSamples: 3 });
  });

  it('fails when the lags kept spread wider than 50 ms plus a frame, saying the spread, the limit and the turns kept', () => {
    // Lags 10, 41, 45, 110, 120: 120 is the farthest from the median, 45; the other four spread over
    // 100 ms.
    const turns = [10, 41, 45, 110, 120].map((lagMs, k) => ({ frame: 60 * (k + 1), lagMs }));
    const { frames, moves } = check(turns);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({
      ok: false,
      reason: 'wide-spread',
      message: 'spread over 83 ms at 30 fps (100 ms over the 4 turns kept of 5)',
    });
    expect(result.analysis).toMatchObject({
      offsetMs: 43,
      spreadMs: 100,
      maxSpreadMs: 83.3,
      matched: 5,
      kept: 4,
    });
    expectClose(
      result.analysis.dropped.map((pair) => pair.lagMs),
      [120],
    );
  });

  it('lets a spread of 60 ms pass at 30 fps and fails it at 120 fps', () => {
    // The frames place the motion to about one interval: at 30 fps the limit is 83 ms, at 120 fps 58
    // ms. Lags 30, 90, 50, 60 and 200, the last left out: the others spread over 60 ms.
    const lags = [30, 90, 50, 60, 200];

    const slow = atRate(30, lags);
    expect(detectClapperboard(slow.frames, slow.moves)).toMatchObject({
      ok: true,
      offsetMs: 55,
      clapperboardResidualMs: 60,
      clapperboardSamples: 4,
      analysis: { frameIntervalMs: 33.33, maxSpreadMs: 83.3 },
    });

    const fast = atRate(120, lags);
    expect(detectClapperboard(fast.frames, fast.moves)).toMatchObject({
      ok: false,
      reason: 'wide-spread',
      message: 'spread over 58 ms at 120 fps (60 ms over the 4 turns kept of 5)',
      analysis: { offsetMs: 55, spreadMs: 60, frameIntervalMs: 8.33, maxSpreadMs: 58.3 },
    });
  });

  it("fails with the clock's reason when the frames' times are 3 s off the page's clock", () => {
    // The worker's clock 3 s ahead: every frame, and every turn's motion, 3 s later than the turns.
    const { frames, moves } = check(FIVE, still, 3000);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({
      ok: false,
      reason: 'clock',
      message: 'frame times are off by 3.0 s: the frame clock is wrong',
    });
    expect(result.analysis.clock?.frameMinusPageMs).toBe(2998);
    expect(result.analysis.matched).toBe(0);
    // Behind by as much: the same.
    const behind = check(FIVE, still, -3000);
    expect(detectClapperboard(behind.frames, behind.moves)).toMatchObject({ reason: 'clock' });
    // Without the page's receipt times there is no telling: the turns just find no motion (and the
    // first turn, at 2 s, no frames: they begin 3 s late).
    const unknown = frames.map((frame) => ({ ...frame, receivedHostMs: undefined }));
    expect(detectClapperboard(unknown, moves)).toMatchObject({
      reason: 'few-matches',
      message:
        'fewer than 4 matches (0 of 5 single turns matched a motion; 4 without a clear change in ' +
        'the rectangle, 1 without frames)',
      analysis: { matched: 0, clock: { frameMinusPageMs: null } },
    });
  });

  it('fails when the cube did not move, or no frame came, or nothing moved in the picture', () => {
    const { frames, moves } = check(FIVE);
    expect(detectClapperboard(frames, [])).toMatchObject({
      ok: false,
      reason: 'no-moves',
      message: 'the cube did not move',
    });
    expect(detectClapperboard([], moves)).toMatchObject({
      ok: false,
      reason: 'no-frames',
      message: "none of the camera's frames reached the check",
      analysis: { clock: null },
    });
    const stillFrames = check([]).frames;
    expect(detectClapperboard(stillFrames, moves)).toMatchObject({
      ok: false,
      reason: 'no-motion',
      message: 'no motion seen in the framing rectangle',
    });
  });

  it('finds no rise in motion that never stops, such as a test pattern that keeps moving', () => {
    // Every frame changes 5 to 8% of the pixels; the turns' motion is lost in it.
    const unseen = FIVE.map((turn) => ({ ...turn, seen: false }));
    const { frames, moves } = check(unseen, (frame) => 0.05 + (frame % 4) * 0.01);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: false, reason: 'no-motion' });
    expect(result.analysis.turns[0].peakLevel).toBeGreaterThan(0.1);
  });

  it('works on frames that reach it out of order', () => {
    const { frames, moves } = check(FIVE);
    const shuffled = [...frames.slice(300), ...frames.slice(0, 300)];

    expect(detectClapperboard(shuffled, moves)).toMatchObject({ ok: true, offsetMs: 40.5 });
  });
});

describe('frameHostTimes', () => {
  it('places each frame at its timestamp plus the median arrival offset, not at its own arrival', () => {
    const frames = [0, 1, 2, 3, 4].map((frame) => ({
      timestampUs: timestampUs(frame),
      arrivalHostMs: hostMs(frame) + [0, 12, -2, 1, 30][frame],
      mean: 0,
      changed: 0,
      costMs: 0,
    }));

    const { offsetMs, times } = frameHostTimes(frames);

    expect(offsetMs).toBeCloseTo(OFFSET_MS + 1, 2);
    times.forEach((time, frame) => {
      expect(time).toBeCloseTo(hostMs(frame) + 1, 2);
    });
    expect(frameHostTimes([])).toEqual({ offsetMs: null, times: [] });
  });
});

describe('singleTurns', () => {
  it('keeps the turns with no other within half a second either way', () => {
    expect(singleTurns([3000, 1000, 1400, 5000, 5499, 7000])).toEqual([3000, 7000]);
    expect(singleTurns([1000, 1500, 2000])).toEqual([1000, 1500, 2000]);
    expect(singleTurns([])).toEqual([]);
  });
});

describe('percentile', () => {
  it('is the nearest rank', () => {
    const five = [1, 2, 3, 4, 5];
    expect([percentile(five, 0.05), percentile(five, 0.5), percentile(five, 0.95)]).toEqual([
      1, 3, 5,
    ]);
    const twenty = Array.from({ length: 20 }, (_, k) => k + 1);
    expect([percentile(twenty, 0.05), percentile(twenty, 0.95)]).toEqual([1, 19]);
    expect(() => percentile([], 0.5)).toThrow(RangeError);
  });
});
