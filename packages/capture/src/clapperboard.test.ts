import { describe, expect, it } from 'vitest';

import {
  BASELINE_FROM_MS,
  BASELINE_TO_MS,
  CLOCK_TOLERANCE_MS,
  ENERGY_FLOOR,
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
  frameHostTimes,
  percentile,
  singleTurns,
  spreadLimitMs,
  type ClapperboardFrame,
} from './clapperboard';

// Synthetic sync checks: 20 s of a 30 fps camera whose frames have a timestamp on their own clock
// (µs) and arrive in the worker at a constant offset on the host clock (ms) plus a jitter whose
// median is 0, and reach the page 2 ms later; a still picture where a few pixels in ten thousand
// change from one frame to the next; a turn's motion over five frames, 2 to 3.5% of the pixels.
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

/** A turn's motion from its onset, frame by frame: the changed area, and the mean difference. */
const TURN = [0.02, 0.035, 0.028, 0.012, 0.004];
const TURN_MEAN = [9, 14, 11, 6, 2.5];

interface Turn {
  /** The frame where its motion begins in the camera's picture. */
  readonly frame: number;
  /** How far the camera lags the cube's report of it, ms; null: motion without a turn (a hand). */
  readonly lagMs: number | null;
  /** False: the camera did not see it (the cube's report is there). */
  readonly seen?: boolean;
}

/** Five turns two seconds apart, from 2 s, lagged by 38 to 45 ms: median 41, spread 7. */
const FIVE: readonly Turn[] = [38, 41, 45, 40, 43].map((lagMs, k) => ({
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
  const motion = new Map<number, number>();
  for (const turn of turns) {
    if (turn.seen !== false) {
      TURN.forEach((_, k) => motion.set(turn.frame + k, k));
    }
  }
  const frames = Array.from({ length: FRAMES }, (_, frame) => {
    const at = motion.get(frame);
    return {
      timestampUs: timestampUs(frame) + frameClockMs * 1000,
      arrivalHostMs: hostMs(frame) + frameClockMs + JITTER_MS[frame % JITTER_MS.length],
      receivedHostMs: hostMs(frame) + JITTER_MS[frame % JITTER_MS.length] + 2,
      mean: at === undefined ? 1 + 0.3 * Math.sin(frame * 1.7) : TURN_MEAN[at],
      changed: at === undefined ? energy(frame) : TURN[at],
      costMs: 0.8,
    };
  });
  const moves = turns.flatMap((turn) =>
    turn.lagMs === null ? [] : [hostMs(turn.frame) - turn.lagMs],
  );
  return { frames, moves };
}

/**
 * A check filmed at `fps` frames a second for 20 s: five turns, their motion from the frames nearest
 * 2, 4, 6, 8 and 10 s, each reported by the cube its lag (ms) before that frame.
 */
function atRate(
  fps: number,
  lags: readonly number[],
): { frames: ClapperboardFrame[]; moves: number[] } {
  const stamp = (frame: number): number => T0_US + Math.round((frame * 1e6) / fps);
  const host = (frame: number): number => stamp(frame) / 1000 + OFFSET_MS;
  const onsets = lags.map((_, k) => Math.round(2 * (k + 1) * fps));
  const motion = new Map<number, number>();
  for (const onset of onsets) {
    TURN.forEach((_, k) => motion.set(onset + k, k));
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
  return { frames, moves: onsets.map((onset, k) => host(onset) - lags[k]) };
}

/** Whether `times` are the host times of the frames `frames`, to a hundredth of a ms. */
function expectTimes(times: readonly (number | null)[], frames: readonly number[]): void {
  expect(times).toHaveLength(frames.length);
  times.forEach((time, k) => {
    expect(time).toBeCloseTo(hostMs(frames[k]), 1);
  });
}

describe('the thresholds', () => {
  it("are the plan's", () => {
    expect([SYNC_CHECK_MS, WINDOW_BEFORE_MS, WINDOW_AFTER_MS]).toEqual([20_000, 400, 700]);
    expect([BASELINE_FROM_MS, BASELINE_TO_MS, MIN_BASELINE_FRAMES]).toEqual([900, 300, 5]);
    expect([ONSET_MADS, PEAK_MADS, ENERGY_FLOOR]).toEqual([3, 6, 0.001]);
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
});

describe('detectClapperboard', () => {
  it("finds each turn's onset in the frames around it, and gives the median lag and its spread", () => {
    const { frames, moves } = check(FIVE);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({
      ok: true,
      offsetMs: 41,
      clapperboardResidualMs: 7,
      clapperboardSamples: 5,
    });
    const samples = result.ok ? result.samples : [];
    expect(samples.map((sample) => sample.moveHostMs)).toEqual(moves);
    expectTimes(
      samples.map((sample) => sample.onsetHostMs),
      FIVE.map((turn) => turn.frame),
    );
    expect(result.analysis).toMatchObject({
      frames: FRAMES,
      moves: 5,
      matched: 5,
      unmatched: 0,
      offsetMs: 41,
      spreadMs: 7,
      // The arrivals' jitter does not move the frames: their median offset is the true one; the page
      // got them 2 ms after they arrived.
      clock: { arrivalOffsetMs: OFFSET_MS, arrivalResidualP95Ms: 8, frameMinusPageMs: -2 },
      // Frames at 30 fps: a spread of up to 50 ms plus a frame passes.
      frameIntervalMs: 33.33,
      maxSpreadMs: 83.3,
    });
    expect(result.analysis.turns.map((turn) => turn.miss)).toEqual(Array(5).fill(null));
    expect(result.analysis.turns.map((turn) => turn.lagMs)).toEqual([38, 41, 45, 40, 43]);
  });

  it('says, for each turn, where it looked, the baseline, its deviation, the peak and the onset', () => {
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
    expect(first.peak).toBe(0.035);
    expect(first.peakHostMs).toBeCloseTo(hostMs(FIVE[0].frame + 1), 1);
    expect(first.onsetHostMs).toBeCloseTo(hostMs(FIVE[0].frame), 1);
    expect(first.lagMs).toBe(38);
    expect(first.miss).toBeNull();
  });

  it('takes no noise under the onset level for a turn', () => {
    // Noise three times the still picture's level, on every seventh frame.
    const { frames, moves } = check(FIVE, (frame) => (frame % 7 === 3 ? 0.0009 : still(frame)));

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, offsetMs: 41, clapperboardSamples: 5 });
  });

  it('passes with four turns when the camera missed one, which it says had no clear change', () => {
    const turns = FIVE.map((turn, k) => (k === 2 ? { ...turn, seen: false } : turn));
    const { frames, moves } = check(turns);
    // The move is there, but no motion.
    expect(moves).toHaveLength(5);

    const result = detectClapperboard(frames, moves);

    // Lags 38, 41, 40, 43: the median is 40.5, the spread 5.
    expect(result).toMatchObject({
      ok: true,
      offsetMs: 40.5,
      clapperboardResidualMs: 5,
      clapperboardSamples: 4,
    });
    expect(result.analysis).toMatchObject({ matched: 4, unmatched: 1 });
    expect(result.analysis.turns[2]).toMatchObject({ onsetHostMs: null, miss: 'no-rise' });
  });

  it('ignores motion far from any turn', () => {
    // A hand moving at 13 s (and at 14.1 s), more than half a second from every turn.
    const { frames, moves } = check([
      ...FIVE,
      { frame: 390, lagMs: null },
      { frame: 423, lagMs: null },
    ]);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, offsetMs: 41, clapperboardSamples: 5 });
  });

  it('finds the turns in a picture that changes everywhere a little all the time', () => {
    // 1 to 2% of the pixels change on every frame (a person moving, in dim light): the turns rise
    // above that by more than its deviation, which the detection measures around each turn.
    const busy = (frame: number): number => 0.012 + 0.003 * Math.sin(frame * 2.3);
    const { frames, moves } = check(FIVE, busy);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: true, offsetMs: 41, clapperboardSamples: 5 });
  });

  it('fails with fewer than four matches, saying how many turns matched and why the others did not', () => {
    const three = check(FIVE.slice(0, 3));
    expect(detectClapperboard(three.frames, three.moves)).toMatchObject({
      ok: false,
      reason: 'few-matches',
      message: 'fewer than 4 matches (3 of 3 single turns matched a motion)',
    });

    const unseen = FIVE.map((turn, k) => (k >= 2 ? { ...turn, seen: false } : turn));
    // A sixth turn in the check's first half second, before any baseline.
    const { frames, moves } = check([{ frame: 12, lagMs: 40 }, ...unseen]);
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

    expect(result).toMatchObject({ ok: true, offsetMs: 41, clapperboardSamples: 5 });
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

  it('gives an onset to one turn only: the nearer move takes it, the other its next rise', () => {
    // Two single turns 600 ms apart (frames 150 and 168), one motion at 20 ms after the second: it
    // lies in both turns' windows, and the second takes it; the first has nothing else.
    const second = hostMs(168) - 20;
    const first = second - 600;
    const one = check([{ frame: 168, lagMs: null }]).frames;
    const shared = detectClapperboard(one, [first, second]).analysis.turns;
    expect(shared.map((turn) => turn.miss)).toEqual(['taken', null]);
    expect(shared[1].lagMs).toBeCloseTo(20, 1);

    // Motion 250 ms after the first turn (frame 150) and 50 ms after the second, 600 ms later (frame
    // 162): the first motion lies in both windows but is nearer the first turn, which keeps it; the
    // second turn takes its next rise.
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

    expect(result.analysis.turns[1]).toMatchObject({ miss: 'no-onset', onsetHostMs: null });
    expect(result).toMatchObject({ ok: true, clapperboardSamples: 4 });
  });

  it('fails when the lags spread wider than 50 ms plus a frame, saying the spread and the limit', () => {
    const turns = [10, 41, 45, 40, 110].map((lagMs, k) => ({ frame: 60 * (k + 1), lagMs }));
    const { frames, moves } = check(turns);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({
      ok: false,
      reason: 'wide-spread',
      message: 'spread over 83 ms at 30 fps (100 ms)',
    });
    expect(result.analysis).toMatchObject({ offsetMs: 41, spreadMs: 100, maxSpreadMs: 83.3 });
  });

  it('lets a spread of 60 ms pass at 30 fps and fails it at 120 fps', () => {
    // Each onset is only known to a frame: at 30 fps the limit is 83 ms, at 120 fps 58 ms.
    const lags = [30, 90, 50, 60, 55];

    const slow = atRate(30, lags);
    expect(detectClapperboard(slow.frames, slow.moves)).toMatchObject({
      ok: true,
      offsetMs: 55,
      clapperboardResidualMs: 60,
      analysis: { frameIntervalMs: 33.33, maxSpreadMs: 83.3 },
    });

    const fast = atRate(120, lags);
    expect(detectClapperboard(fast.frames, fast.moves)).toMatchObject({
      ok: false,
      reason: 'wide-spread',
      message: 'spread over 58 ms at 120 fps (60 ms)',
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

    expect(detectClapperboard(shuffled, moves)).toMatchObject({ ok: true, offsetMs: 41 });
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
