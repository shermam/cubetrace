import { describe, expect, it } from 'vitest';

import {
  MIN_MATCHES,
  SINGLE_TURN_MS,
  detectClapperboard,
  frameHostTimes,
  singleTurns,
} from './clapperboard';
import { MotionMeter } from './motion';
import type { MotionSample } from './protocol';
import { SyntheticFrame, seeded } from './test-frames';

// A sync check filmed (docs/PLAN.md, T2.8 and T2.11): a synthetic camera sees a person holding a cube
// in the middle of a room, the whole picture as the region, as the owner's first checks had it.
// Everywhere in the picture, all the time: the sensor's noise, a flicker of the light, the body and the
// cube swaying and breathing, and a few fidgets of a hand or the head between the turns, each changing
// as much of the picture as a turn, three of them within half a second after a turn. Ten single turns,
// 1.25 s apart: each is the cube's top layer turning, with a finger on it, over three frames from the
// first frame 60 ms or more after the cube reports the move, a compact change of about 1% of the
// picture. The frames go through the capture worker's motion meter (320 × 180 for the whole frame),
// then through the clapperboard of T2.5 on the mean difference, and through the detection of T2.8 and
// T2.11 on the changed area. 640 × 360 frames, so that the test stays fast: a pixel of the meter's
// plane is 2 × 2 of them, as a pixel is 6 × 6 of a 1080p frame's.
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const FRAMES = 14 * FPS;
const T0_US = 812_004_133_000;
const OFFSET_MS = 1_790_600_000_000.25;

/** When the cube reports each turn, ms from the first frame: the frames' phase drifts 3.3 ms a turn. */
const TURNS_MS = Array.from({ length: 10 }, (_, k) => 1500 + 1250 * k + 3.3 * k);
/** The camera shows each turn from the first frame this long after the cube reports it. */
const SHOWN_AFTER_MS = 60;
/** The fidgets: when they start (ms), where (the top-left corner of a 40 × 40 area) and how long. */
const FIDGETS = [
  { atMs: 2150, x: 150, y: 90, frames: 4 },
  { atMs: 4430, x: 520, y: 260, frames: 3 },
  { atMs: 9500, x: 90, y: 200, frames: 5 },
];

/** The cube: its top-left corner, and its stickers of 24 pixels, three by three. */
const CUBE = { x: 420, y: 150, sticker: 24 };
/** Its stickers' luma: white, yellow, red, orange, green, blue. */
const COLOURS = [200, 175, 85, 130, 110, 60];

function frameMs(frame: number): number {
  return (frame * 1000) / FPS;
}

/** The first frame at or after `ms`. */
function frameAtOrAfter(ms: number): number {
  return Math.ceil((ms * FPS) / 1000 - 1e-9);
}

/** Films the check: each frame's pixels, one frame at a time. */
function* film(): Generator<Uint8Array> {
  const random = seeded(2826);
  // The room: a still texture.
  const room = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      room[y * WIDTH + x] =
        115 + 30 * Math.sin(x / 17) * Math.cos(y / 13) + 18 * Math.sin((x + 2 * y) / 41);
    }
  }
  // The person with the cube in their hands, at rest: a layer over the room, with its coverage, in
  // two versions, the cube's top layer as the scramble left it or turned.
  const top = [0, 1, 2].map(() => COLOURS[Math.floor(random() * COLOURS.length)]);
  const turned = top.map((_, k) => COLOURS[(k * 2 + 3) % COLOURS.length]);
  const sticker = (row: number, column: number, state: number): number =>
    row === 0 ? (state % 2 === 0 ? top : turned)[column] : COLOURS[(row * 3 + column) % 6];
  // Two rows more than the picture: the body goes on below it, whatever the sway.
  const cover = new Float32Array(WIDTH * (HEIGHT + 2));
  const layers = [0, 1].map((state) => {
    const layer = new Float32Array(WIDTH * (HEIGHT + 2));
    for (let y = 40; y < HEIGHT + 2; y++) {
      for (let x = 60; x < 520; x++) {
        const at = y * WIDTH + x;
        const body = x >= 80 && x < 330 && y >= 60;
        const arms = x >= 330 && x < 510 && y >= 200 && y < 250;
        const cx = x - CUBE.x;
        const cy = y - CUBE.y;
        if (cx >= 0 && cy >= 0 && cx < 3 * CUBE.sticker && cy < 3 * CUBE.sticker) {
          layer[at] = sticker(Math.floor(cy / CUBE.sticker), Math.floor(cx / CUBE.sticker), state);
          cover[at] = 1;
        } else if (body || arms) {
          layer[at] = 70 + 12 * Math.sin(x / 7) + 8 * Math.cos(y / 9);
          cover[at] = 1;
        }
      }
    }
    return layer;
  });
  // Noise: planes of ±6 levels (a triangle of two draws), one of them at a random offset a frame.
  const noise = Array.from({ length: 4 }, () =>
    Int8Array.from({ length: WIDTH * HEIGHT }, () => Math.round(6 * (random() - random()))),
  );
  const onsets = TURNS_MS.map((ms) => frameAtOrAfter(ms + SHOWN_AFTER_MS));
  for (let frame = 0; frame < FRAMES; frame++) {
    const t = frameMs(frame) / 1000;
    // Sway and breathing (pixels), and the light's flicker (levels).
    const sx =
      0.7 * Math.sin((2 * Math.PI * t) / 3.1) + 0.35 * Math.sin((2 * Math.PI * t) / 1.7 + 1);
    const sy = 0.5 * Math.sin((2 * Math.PI * t) / 4);
    const flicker = 3 * Math.sin(2 * Math.PI * 7.3 * t);
    const layer = layers[onsets.filter((onset) => onset <= frame).length % 2];
    const pixels = new Float32Array(room);
    // The layer, moved by (sx, sy), bilinear: a sensor's pixels take the light that falls on them,
    // so an edge that moves by a tenth of a pixel changes its pixels by a tenth of its contrast.
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const fx = sx - ix;
    const fy = sy - iy;
    for (let y = 40; y < HEIGHT; y++) {
      const ly = y - iy - 1;
      for (let x = 60; x < 522; x++) {
        const lx = x - ix - 1;
        const a = ly * WIDTH + lx;
        const w00 = fx * fy;
        const w10 = (1 - fx) * fy;
        const w01 = fx * (1 - fy);
        const w11 = (1 - fx) * (1 - fy);
        const c =
          cover[a] * w00 + cover[a + 1] * w10 + cover[a + WIDTH] * w01 + cover[a + WIDTH + 1] * w11;
        if (c > 0) {
          const v =
            layer[a] * cover[a] * w00 +
            layer[a + 1] * cover[a + 1] * w10 +
            layer[a + WIDTH] * cover[a + WIDTH] * w01 +
            layer[a + WIDTH + 1] * cover[a + WIDTH + 1] * w11;
          const at = y * WIDTH + x;
          pixels[at] = pixels[at] * (1 - c) + v;
        }
      }
    }
    // The top layer turning: its stickers slide by a quarter of the cube a frame, the next state's
    // coming in, with a finger on them.
    const turning = onsets.findIndex((onset) => frame >= onset && frame < onset + 3);
    if (turning >= 0) {
      const step = frame - onsets[turning] + 1;
      for (let cy = 0; cy < CUBE.sticker; cy++) {
        for (let cx = 0; cx < 3 * CUBE.sticker; cx++) {
          const slid = cx + (step * CUBE.sticker * 3) / 4;
          const state = slid < 3 * CUBE.sticker ? turning : turning + 1;
          const finger = cx >= 18 * step && cx < 18 * step + 16;
          pixels[(CUBE.y + cy) * WIDTH + CUBE.x + cx] = finger
            ? 150
            : sticker(0, Math.floor(slid / CUBE.sticker) % 3, state);
        }
      }
    }
    // A fidget: a hand or the head moving, 40 × 40 pixels changing for a few frames.
    for (const fidget of FIDGETS) {
      const first = frameAtOrAfter(fidget.atMs);
      if (frame >= first && frame < first + fidget.frames) {
        for (let y = fidget.y; y < fidget.y + 40; y++) {
          for (let x = fidget.x; x < fidget.x + 40; x++) {
            pixels[y * WIDTH + x] += (frame - first) % 2 === 0 ? 45 : -35;
          }
        }
      }
    }
    const plane = noise[frame % noise.length];
    const shift = Math.floor(random() * plane.length);
    const out = new Uint8Array(WIDTH * HEIGHT);
    for (let at = 0; at < out.length; at++) {
      const value = Math.round(pixels[at] + flicker + plane[(at + shift) % plane.length]);
      out[at] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
    yield out;
  }
}

/** The check as the capture worker measures it: each frame's motion, on the host clock. */
async function measure(): Promise<MotionSample[]> {
  const meter = new MotionMeter();
  const samples: MotionSample[] = [];
  let frame = 0;
  for (const pixels of film()) {
    const timestampUs = T0_US + Math.round(frameMs(frame) * 1000);
    const measured = await meter.measure(new SyntheticFrame(timestampUs, pixels, WIDTH, HEIGHT));
    if (measured.mean !== null && measured.changed !== null) {
      samples.push({
        timestampUs,
        arrivalHostMs: timestampUs / 1000 + OFFSET_MS + (frame % 3),
        mean: measured.mean,
        changed: measured.changed,
        costMs: measured.costMs,
      });
    }
    frame += 1;
  }
  return samples;
}

/**
 * The clapperboard of T2.5, as it was: onsets are the first frames of runs above 4 times the still
 * stretches' median of the mean difference after 500 ms under it, each matched to the nearest single
 * turn within 500 ms, one to one. How many turns it matches.
 */
function matchesOfT25(samples: readonly MotionSample[], moves: readonly number[]): number {
  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const { times } = frameHostTimes(samples);
  const energies = samples.map((sample) => sample.mean);
  const first = Math.max(4 * median(energies), 0.5);
  const still: number[] = [];
  let runStart = -1;
  for (let i = 0; i <= energies.length; i++) {
    if (i < energies.length && energies[i] <= first) {
      runStart = runStart < 0 ? i : runStart;
    } else {
      if (runStart >= 0 && times[i - 1] - times[runStart] >= 500) {
        still.push(...energies.slice(runStart, i));
      }
      runStart = -1;
    }
  }
  const threshold = Math.max(4 * median(still.length > 0 ? still : energies), 0.5);
  const onsets: number[] = [];
  let stillSince: number | null = null;
  energies.forEach((energy, i) => {
    if (energy > threshold) {
      if (stillSince !== null && times[i] - stillSince >= 500) {
        onsets.push(times[i]);
      }
      stillSince = null;
    } else {
      stillSince ??= times[i];
    }
  });
  const turns = singleTurns(moves, SINGLE_TURN_MS);
  const pairs = onsets
    .flatMap((onset, i) =>
      turns.flatMap((move, j) =>
        Math.abs(onset - move) <= 500 ? [{ i, j, distance: Math.abs(onset - move) }] : [],
      ),
    )
    .sort((p, q) => p.distance - q.distance);
  const taken = { onsets: new Set<number>(), moves: new Set<number>() };
  let matched = 0;
  for (const { i, j } of pairs) {
    if (!taken.onsets.has(i) && !taken.moves.has(j)) {
      taken.onsets.add(i);
      taken.moves.add(j);
      matched += 1;
    }
  }
  return matched;
}

describe('a sync check filmed with the whole frame as the region, a person moving in it', () => {
  it("defeats T2.5's detector, while the detection since T2.8 matches the turns and finds the lag", async () => {
    const samples = await measure();
    const moves = TURNS_MS.map((ms) => T0_US / 1000 + OFFSET_MS + 1 + ms);

    // What the picture does: the mean difference is mostly noise and flicker, and a turn barely
    // moves it; the changed area is near 0 but for the turns and the fidgets.
    const means = samples.map((sample) => sample.mean).sort((a, b) => a - b);
    const changed = samples.map((sample) => sample.changed).sort((a, b) => a - b);
    const turnFrames = new Set(TURNS_MS.map((ms) => frameAtOrAfter(ms + SHOWN_AFTER_MS)));
    const atTurns = samples.filter((_, k) => turnFrames.has(k + 1));
    const report = {
      meanMedian: means[Math.floor(means.length / 2)],
      meanAtTurns: atTurns.map((sample) => sample.mean),
      changedMedian: changed[Math.floor(changed.length / 2)],
      changedAtTurns: atTurns.map((sample) => sample.changed),
    };
    console.log(`the filmed check: ${JSON.stringify(report)}`);
    expect(report.meanMedian).toBeGreaterThan(1.5);
    expect(Math.max(...report.meanAtTurns)).toBeLessThan(4 * report.meanMedian);
    expect(Math.min(...report.changedAtTurns)).toBeGreaterThan(0.005);

    const old = matchesOfT25(samples, moves);
    const result = detectClapperboard(samples, moves);
    console.log(
      `T2.5's detector matched ${String(old)} of 10 turns; the detection since T2.8 ${String(result.analysis.matched)}` +
        ` (${result.ok ? `lag ${String(result.offsetMs)} ms, spread ${String(result.clapperboardResidualMs)} ms over ${String(result.clapperboardSamples)} turns kept` : result.message};` +
        ` each turn's lag ${JSON.stringify(result.analysis.turns.map((turn) => turn.lagMs))})`,
    );

    expect(old).toBeLessThan(MIN_MATCHES);
    expect(result.analysis.matched).toBeGreaterThanOrEqual(8);
    // Since T2.11 a turn's lag is to the middle of its motion, not to its first frame (T2.8's 60 to
    // 93 ms): the camera shows each turn from the first frame 60 ms or more after the move, changing the
    // picture over four frames (the stickers sliding over three, then into place), whose middle is
    // about a frame and a half (50 ms) after the first, so about 110 to 143 ms after the move. So is
    // every turn's: none of the fidgets, which change as much of the picture within half a second after
    // three of the turns, took a turn's place (EARLIER_PEAK_SHARE).
    for (const turn of result.analysis.turns) {
      expect(turn.lagMs).toBeGreaterThanOrEqual(105);
      expect(turn.lagMs).toBeLessThan(145);
    }
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.offsetMs).toBeGreaterThanOrEqual(105);
      expect(result.offsetMs).toBeLessThan(145);
      // Within the limit of 50 ms plus a frame at 30 fps.
      expect(result.analysis.maxSpreadMs).toBeCloseTo(83.3, 1);
      expect(result.clapperboardResidualMs).toBeLessThanOrEqual(result.analysis.maxSpreadMs);
    }
  });
});
