import type { Probed } from './probe-types';

/**
 * Frame timing from `requestVideoFrameCallback` (docs/PLAN.md, T1.8; the design's §6).
 *
 * For a local camera, Chrome's `captureTime` is the moment the frame reached Chrome, on the
 * `performance.now()` timeline: the host timestamp the capture pipeline will store. `mediaTime`
 * is the camera's own clock: not comparable to the host clock, but exact for frame intervals and
 * therefore for dropped frames. `presentedFrames` counts frames handed to the compositor, so a
 * jump of more than one between callbacks means frames arrived that no callback saw.
 */

/** One callback: the page clock when it ran and the frame's metadata. */
export interface FrameSample {
  /** `performance.now()` inside the callback. */
  readonly at: number;
  /** `metadata.captureTime`, when the browser provides it. */
  readonly captureTime?: number;
  /** `metadata.mediaTime`, in seconds. */
  readonly mediaTime: number;
  /** `metadata.presentedFrames`. */
  readonly presentedFrames?: number;
  readonly width: number;
  readonly height: number;
}

/** A distribution: size, extremes, 5th/50th/95th percentiles (linear interpolation) and mean. */
export interface Summary {
  readonly count: number;
  readonly min: number;
  readonly p5: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

export interface FrameTiming {
  /** Callbacks in the window. */
  readonly frames: number;
  /** From the first to the last callback of the window. */
  readonly durationMs: number;
  /** Callbacks per second. */
  readonly achievedFps: number;
  /** Frames presented per second, counting the ones no callback saw. */
  readonly presentedFps: Probed<number>;
  /** Time between consecutive callbacks (`performance.now()`). */
  readonly intervalMs: Probed<Summary>;
  /** `captureTime − performance.now()` in each callback: how late the page sees a frame. */
  readonly captureMinusNowMs: Probed<Summary>;
  /** Differences of consecutive `mediaTime`s: the camera's own frame intervals. */
  readonly mediaTimeDeltaMs: Probed<Summary>;
  /** `captureTime − mediaTime`: a constant offset plus arrival jitter (its spread). */
  readonly captureMinusMediaMs: Probed<Summary>;
  /** Frames presented between two callbacks and seen by neither. */
  readonly callbackMissedFrames: Probed<number>;
  /** Frames missing from the camera's sequence: `mediaTime` gaps not explained by callback misses. */
  readonly droppedFramesEstimate: Probed<number>;
  /** Distinct frame sizes seen, as "WIDTHxHEIGHT". */
  readonly frameSizes: readonly string[];
}

/** Summarises the samples of one measurement window; needs at least two frames. */
export function analyzeFrames(samples: readonly FrameSample[]): Probed<FrameTiming> {
  if (samples.length < 2) {
    return { skipped: `${String(samples.length)} frame(s) in the window, at least 2 are needed` };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const durationMs = last.at - first.at;
  if (durationMs <= 0) {
    return { skipped: 'the callbacks did not advance performance.now()' };
  }
  const pairs = samples
    .slice(1)
    .map((sample, index) => ({ before: samples[index], after: sample }));
  const captured = samples.filter(
    (sample): sample is FrameSample & { readonly captureTime: number } =>
      sample.captureTime !== undefined,
  );
  const presented =
    first.presentedFrames !== undefined && last.presentedFrames !== undefined
      ? round(((last.presentedFrames - first.presentedFrames) / durationMs) * 1000, 2)
      : { missing: 'presentedFrames' };
  const gaps = frameGaps(pairs);
  return {
    frames: samples.length,
    durationMs: round(durationMs),
    achievedFps: round(((samples.length - 1) / durationMs) * 1000, 2),
    presentedFps: presented,
    intervalMs: summarize(pairs.map(({ before, after }) => after.at - before.at)),
    captureMinusNowMs:
      captured.length > 0
        ? summarize(captured.map((sample) => sample.captureTime - sample.at))
        : { missing: 'captureTime' },
    mediaTimeDeltaMs: summarize(
      pairs.map(({ before, after }) => (after.mediaTime - before.mediaTime) * 1000),
    ),
    captureMinusMediaMs:
      captured.length > 0
        ? summarize(captured.map((sample) => sample.captureTime - sample.mediaTime * 1000))
        : { missing: 'captureTime' },
    callbackMissedFrames: gaps.missed,
    droppedFramesEstimate: gaps.dropped,
    frameSizes: [
      ...new Set(samples.map((sample) => `${String(sample.width)}x${String(sample.height)}`)),
    ],
  };
}

/**
 * Counts missing frames between consecutive callbacks. The nominal interval is the median
 * `mediaTime` step per presented frame; a step of k nominal intervals holds k frames, of which
 * the presented ones arrived (seen by a callback or not) and the rest never reached the page.
 */
function frameGaps(pairs: readonly { before: FrameSample; after: FrameSample }[]): {
  readonly missed: Probed<number>;
  readonly dropped: Probed<number>;
} {
  const steps = pairs.map(({ before, after }) => ({
    mediaMs: (after.mediaTime - before.mediaTime) * 1000,
    presented:
      before.presentedFrames !== undefined && after.presentedFrames !== undefined
        ? after.presentedFrames - before.presentedFrames
        : undefined,
  }));
  const knowsPresented = steps.every((step) => step.presented !== undefined);
  const perFrameMs = steps
    .map((step) => ({ mediaMs: step.mediaMs, presented: step.presented ?? 1 }))
    .filter((step) => step.mediaMs > 0 && step.presented >= 1)
    .map((step) => step.mediaMs / step.presented);
  let missed = 0;
  let dropped = 0;
  const nominalMs = perFrameMs.length > 0 ? percentile(sorted(perFrameMs), 50) : 0;
  for (const step of steps) {
    const presented = step.presented ?? 1;
    missed += Math.max(0, presented - 1);
    if (nominalMs > 0 && step.mediaMs > 0) {
      dropped += Math.max(0, Math.round(step.mediaMs / nominalMs) - presented);
    }
  }
  return {
    missed: knowsPresented ? missed : { missing: 'presentedFrames' },
    dropped: nominalMs > 0 ? dropped : { skipped: 'mediaTime did not advance' },
  };
}

/** The distribution of `values`, rounded to microseconds; absent for an empty series. */
export function summarize(values: readonly number[]): Probed<Summary> {
  if (values.length === 0) {
    return { skipped: 'no values' };
  }
  const ordered = sorted(values);
  const total = ordered.reduce((sum, value) => sum + value, 0);
  return {
    count: ordered.length,
    min: round(ordered[0]),
    p5: round(percentile(ordered, 5)),
    p50: round(percentile(ordered, 50)),
    p95: round(percentile(ordered, 95)),
    max: round(ordered[ordered.length - 1]),
    mean: round(total / ordered.length),
  };
}

/** The p-th percentile of an ascending, non-empty series, interpolating between ranks. */
export function percentile(ascending: readonly number[], p: number): number {
  const rank = (p / 100) * (ascending.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return ascending[lower] + (ascending[upper] - ascending[lower]) * (rank - lower);
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
