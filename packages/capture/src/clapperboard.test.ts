import { describe, expect, it } from 'vitest';

import {
  MATCH_WINDOW_MS,
  MAX_SPREAD_MS,
  MIN_MATCHES,
  MIN_ONSET_ENERGY,
  ONSET_FACTOR,
  ONSET_QUIET_MS,
  SINGLE_TURN_MS,
  SYNC_CHECK_MS,
  detectClapperboard,
  findOnsets,
  frameHostTimes,
  matchOnsets,
  onsetThreshold,
  percentile,
  singleTurns,
} from './clapperboard';
import type { MotionSample } from './protocol';

// Synthetic sync checks: 20 s of a 30 fps camera whose frames have a timestamp on their own clock
// (µs) and arrive in the worker at a constant offset on the host clock (ms) plus a jitter whose
// median is 0; a still picture's energy of about 1 luma level; a turn's motion over five frames.
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

/** A still picture's energy: about a level, never twice as much. */
function still(frame: number): number {
  return 1 + 0.3 * Math.sin(frame * 1.7);
}

/** A turn's motion, frame by frame from its onset. */
const TURN = [9, 14, 11, 6, 2.5];

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

/** The frames' motion and the moves' host times of a check with `turns`. */
function check(
  turns: readonly Turn[],
  energy: (frame: number) => number = still,
): { frames: MotionSample[]; moves: number[] } {
  const motion = new Map<number, number>();
  for (const turn of turns) {
    if (turn.seen !== false) {
      TURN.forEach((value, k) => motion.set(turn.frame + k, value));
    }
  }
  const frames = Array.from({ length: FRAMES }, (_, frame) => ({
    timestampUs: timestampUs(frame),
    arrivalHostMs: hostMs(frame) + JITTER_MS[frame % JITTER_MS.length],
    energy: motion.get(frame) ?? energy(frame),
    costMs: 0.8,
  }));
  const moves = turns.flatMap((turn) =>
    turn.lagMs === null ? [] : [hostMs(turn.frame) - turn.lagMs],
  );
  return { frames, moves };
}

/** Whether `times` are the host times of the frames `frames`, to a hundredth of a ms. */
function expectTimes(times: readonly number[], frames: readonly number[]): void {
  expect(times).toHaveLength(frames.length);
  times.forEach((time, k) => {
    expect(time).toBeCloseTo(hostMs(frames[k]), 1);
  });
}

describe('the thresholds', () => {
  it("are the plan's", () => {
    expect([SYNC_CHECK_MS, ONSET_FACTOR, ONSET_QUIET_MS, MATCH_WINDOW_MS]).toEqual([
      20_000, 4, 500, 500,
    ]);
    expect([MIN_MATCHES, MAX_SPREAD_MS, MIN_ONSET_ENERGY, SINGLE_TURN_MS]).toEqual([
      4, 40, 0.5, 500,
    ]);
  });
});

describe('detectClapperboard', () => {
  it('finds five clean onsets, matches them to the turns, and gives the median lag and its spread', () => {
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
      // The arrivals' jitter does not move the frames: their median offset is the true one.
      arrivalOffsetMs: OFFSET_MS,
      offsetMs: 41,
      spreadMs: 7,
    });
    expectTimes(
      result.analysis.onsets,
      FIVE.map((turn) => turn.frame),
    );
    expect(result.analysis.baseline).toBeCloseTo(1, 1);
    expect(result.analysis.threshold).toBeCloseTo(4, 0);
  });

  it('takes no noise under the threshold for a turn', () => {
    // Noise up to three times the still picture's level, on every seventh frame.
    const { frames, moves } = check(FIVE, (frame) => (frame % 7 === 3 ? 3 : still(frame)));

    const result = detectClapperboard(frames, moves);

    expect(result.analysis.onsets).toHaveLength(5);
    expect(result).toMatchObject({ ok: true, offsetMs: 41, clapperboardSamples: 5 });
  });

  it('passes with four turns when the camera missed one', () => {
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
  });

  it('ignores motion far from any turn', () => {
    // A hand moving at 13 s (and at 14.1 s), more than half a second from every turn.
    const { frames, moves } = check([
      ...FIVE,
      { frame: 390, lagMs: null },
      { frame: 423, lagMs: null },
    ]);

    const result = detectClapperboard(frames, moves);

    expect(result.analysis.onsets).toHaveLength(7);
    expect(result).toMatchObject({ ok: true, offsetMs: 41, clapperboardSamples: 5 });
  });

  it('fails with fewer than four matches, saying how many turns matched', () => {
    const { frames, moves } = check(FIVE.slice(0, 3));

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({
      ok: false,
      reason: 'few-matches',
      message: 'fewer than 4 matches (3 of 3 single turns matched a motion)',
    });
    expect(result.analysis.pairs).toHaveLength(3);
  });

  it("matches only single turns: a scramble's turns, close together, match no motion", () => {
    // A scramble's twenty turns 60 ms apart from 13 s, with its motion from their start; the five
    // single turns as before.
    const scramble = Array.from({ length: 20 }, (_, k) => hostMs(390) - 40 + 60 * k);
    const { frames, moves } = check([...FIVE, { frame: 390, lagMs: null }]);

    const result = detectClapperboard(frames, [...moves, ...scramble]);

    expect(result).toMatchObject({ ok: true, offsetMs: 41, clapperboardSamples: 5 });
    expect(result.analysis).toMatchObject({ moves: 25, turns: 5 });

    // Only the scramble: its onset finds a turn 40 ms before it, but none of them is single.
    const alone = check([{ frame: 390, lagMs: null }]).frames;
    expect(detectClapperboard(alone, scramble)).toMatchObject({
      ok: false,
      reason: 'few-matches',
      message:
        'fewer than 4 matches (0 of 0 single turns matched a motion; 20 turns came within half ' +
        'a second of another)',
    });
  });

  it('fails when the lags spread over 40 ms, saying the spread', () => {
    const turns = [10, 41, 45, 40, 90].map((lagMs, k) => ({ frame: 60 * (k + 1), lagMs }));
    const { frames, moves } = check(turns);

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({
      ok: false,
      reason: 'wide-spread',
      message: 'spread over 40 ms (80 ms)',
    });
    expect(result.analysis).toMatchObject({ offsetMs: 41, spreadMs: 80 });
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
    });
    const stillFrames = check([]).frames;
    expect(detectClapperboard(stillFrames, moves)).toMatchObject({
      ok: false,
      reason: 'no-motion',
      message: 'no motion seen in the framing rectangle',
    });
  });

  it('finds no onset in motion that never stops, such as a test pattern that keeps moving', () => {
    // Every frame changes by 10 to 13 levels; the turns' motion is lost in it.
    const unseen = FIVE.map((turn) => ({ ...turn, seen: false }));
    const { frames, moves } = check(unseen, (frame) => 10 + (frame % 4));

    const result = detectClapperboard(frames, moves);

    expect(result).toMatchObject({ ok: false, reason: 'no-motion' });
    expect(result.analysis.threshold).toBeGreaterThan(40);
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
      energy: 0,
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

describe('onsetThreshold and findOnsets', () => {
  const times = Array.from({ length: 90 }, (_, k) => k * 33.3);

  it('draws the baseline from the still stretches, and never goes under the floor', () => {
    const energies = times.map((_, k) => (k >= 30 && k < 60 ? 12 : 1));
    expect(onsetThreshold(times, energies)).toEqual({ baseline: 1, threshold: 4 });
    expect(
      onsetThreshold(
        times,
        times.map(() => 0),
      ),
    ).toEqual({
      baseline: 0,
      threshold: MIN_ONSET_ENERGY,
    });
    expect(onsetThreshold([], [])).toBeNull();
  });

  it('takes the first frame of a run above the threshold after half a second under it', () => {
    // Still from 0; motion at frame 20 (after 666 ms), again at frame 30 (after 266 ms of stillness:
    // no onset), and at frame 60 (after 932 ms).
    const energies = times.map((_, k) => ([20, 21, 30, 31, 60, 61].includes(k) ? 9 : 1));
    expect(findOnsets(times, energies, 4)).toEqual([times[20], times[60]]);
    // The first half second of a series has no onset: what came before it is unknown.
    expect(
      findOnsets(
        times,
        times.map((_, k) => (k === 10 ? 9 : 1)),
        4,
      ),
    ).toEqual([]);
  });
});

describe('singleTurns', () => {
  it('keeps the turns with no other within half a second either way', () => {
    expect(singleTurns([3000, 1000, 1400, 5000, 5499, 7000])).toEqual([3000, 7000]);
    expect(singleTurns([1000, 1500, 2000])).toEqual([1000, 1500, 2000]);
    expect(singleTurns([])).toEqual([]);
  });
});

describe('matchOnsets', () => {
  it('pairs each onset with the nearest move within half a second, one to one', () => {
    // Two onsets near the move at 1000: the nearer one takes it; the other takes the move at 1600.
    expect(matchOnsets([1040, 1300, 3000], [1000, 1600, 2200])).toEqual([
      { moveHostMs: 1000, onsetHostMs: 1040 },
      { moveHostMs: 1600, onsetHostMs: 1300 },
    ]);
    expect(matchOnsets([1000], [1501])).toEqual([]);
    expect(matchOnsets([1000], [1500])).toEqual([{ moveHostMs: 1500, onsetHostMs: 1000 }]);
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
