// The capture latency (docs/PLAN.md T5.3, issue #67): how long a camera's frame takes from its
// capture to the capture worker, whose host time for it (its arrival) is what the clips' frame times
// come from (docs/DATA-MODEL.md §9), and from there to its encoded chunk. On 2026-10-09 the MacBook's
// frames came about 75 ms later relative to the cube from the 38th attempt on, with no sign in the
// app; this meter is the sign. The capture worker feeds it every frame and reports it once a second
// (`CaptureStats.latency`) and per clip (`captureLatencyMs`, `encodeLatencyMs` of the clip's entry);
// `LatencyDrift` watches the reports against the camera's sync check. Plain TypeScript, no browser
// API: tested in Node.
import type { CaptureLatency, LatencyBasis, LatencyPercentiles } from '@cubetrace/core';

/**
 * A frame's capture time from the browser beyond this far from its arrival, ms, is not on the host
 * clock (another time origin, a camera's own clock): the frame is timed by its timestamp instead.
 */
export const CAPTURE_TIME_LIMIT_MS = 10_000;

/** A capture time this much after the arrival, ms, is still the same moment (the clocks' rounding). */
const CAPTURE_TIME_SLACK_MS = 5;

/** The most frames one reading keeps: a second at 240 fps. */
export const MAX_READING_FRAMES = 240;

/** What the capture worker knows of one frame's way through it (host ms; the timestamp in µs). */
export interface FrameTiming {
  /** The frame's own `VideoFrame.timestamp`, µs on the camera's clock. */
  readonly timestampUs: number;
  /**
   * The frame's capture time on the host clock, ms: `performance.timeOrigin` plus
   * `VideoFrame.metadata().captureTime`, where the browser gives one; null otherwise.
   */
  readonly captureHostMs: number | null;
  /** When the frame reached the capture worker: the time its clip's frame times come from. */
  readonly arrivalHostMs: number;
  /** When its encoded chunk came out of the encoder; null for a frame not encoded (dropped). */
  readonly encodedHostMs: number | null;
}

/** A frame's capture latency, by one basis, ms. */
interface Timed {
  readonly basis: LatencyBasis;
  readonly ms: number;
}

/**
 * The frame's capture time from the browser, on the host clock, ms: `timeOrigin` plus
 * `frame.metadata().captureTime` (Chrome's `VideoFrame.metadata()`, which some tracks and versions
 * fill); null where there is none, or where reading it throws.
 */
export function captureTimeOf(frame: object, timeOrigin: number): number | null {
  const metadata: unknown = Reflect.get(frame, 'metadata');
  if (typeof metadata !== 'function') {
    return null;
  }
  try {
    const read: unknown = (metadata as (this: object) => unknown).call(frame);
    const time: unknown =
      typeof read === 'object' && read !== null ? Reflect.get(read, 'captureTime') : undefined;
    return typeof time === 'number' && Number.isFinite(time) ? timeOrigin + time : null;
  } catch {
    return null;
  }
}

/**
 * The median and the 95th percentile (nearest rank) of `values`, ms to 0.1, never under 0; null
 * without values.
 */
export function percentiles(values: readonly number[]): LatencyPercentiles | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
  return { p50: tenth(Math.max(0, rank(0.5))), p95: tenth(Math.max(0, rank(0.95))) };
}

/** The frames' latencies over a span (a second of the counters, a clip), as `LatencyMeter` reads them. */
export interface LatencyReading {
  /**
   * From capture to arrival: by the frames' capture times where every frame of the span had one
   * (`capture-time`), else by their timestamps beyond the floor (`timestamp`); null without frames.
   */
  readonly capture: CaptureLatency | null;
  /** From arrival to the encoded chunk; null when no frame of the span was encoded. */
  readonly encode: LatencyPercentiles | null;
  /** The frames read. */
  readonly frames: number;
}

/**
 * The capture latency of a camera's frames (docs/PLAN.md T5.3): per frame, from its capture to its
 * arrival in the capture worker, and from there to its encoded chunk. A frame's capture is its
 * capture time on the host clock where the browser gives it with the frame (`capture-time`: the
 * latency itself), else its own timestamp, which counts from the camera's zero, not the host's: then
 * the latency is counted from the least `arrival − timestamp` seen on the camera's track (its floor:
 * the frame that came soonest), so that it says how much later than the best a frame came, which a
 * queue anywhere between the camera's timestamp and the worker raises and nothing else does (on the
 * devices measured both clocks advance together: docs/DEVICES.md, "VideoFrame.timestamp"). The floor
 * starts with the camera's track (`floorMs`, which the window carries from one run of the pipeline to
 * the next on the same track) and only goes down.
 *
 * The capture worker adds each frame as its chunk comes out of the encoder (`add`), takes a reading
 * of the frames since the last one once a second (`take`), and reads a clip's frames with `read`.
 */
export class LatencyMeter {
  #floorMs: number | null;
  #frames: FrameTiming[] = [];

  /** `floorMs`: the floor of the camera's track so far (an earlier run's), or null for a new track. */
  constructor(floorMs: number | null = null) {
    this.#floorMs = floorMs;
  }

  /**
   * The least `arrivalHostMs − timestampUs / 1000` seen on the track, ms (a large number: the
   * timestamp's zero is the camera's); null before the first frame.
   */
  get floorMs(): number | null {
    return this.#floorMs;
  }

  /** One frame, once its chunk is out of the encoder (or it was dropped): it lowers the floor. */
  add(frame: FrameTiming): void {
    this.#lower(frame);
    if (this.#frames.length < MAX_READING_FRAMES) {
      this.#frames.push(frame);
    }
  }

  /** The reading of the frames added since the last `take`, which it forgets. */
  take(): LatencyReading {
    const frames = this.#frames;
    this.#frames = [];
    return this.read(frames);
  }

  /**
   * The reading of `frames` (a clip's), by the floor now: they lower it first, as the frames came
   * before (a clip's frames are in the meter already, but not necessarily one cut from an older run).
   */
  read(frames: readonly FrameTiming[]): LatencyReading {
    for (const frame of frames) {
      this.#lower(frame);
    }
    const timed = frames.map((frame) => this.#timed(frame));
    const absolute = timed.length > 0 && timed.every((t) => t.basis === 'capture-time');
    const capture = absolute
      ? timed.map((t) => t.ms)
      : frames.map((frame) => this.#beyondFloor(frame));
    const latency = percentiles(capture);
    const encodes = frames.flatMap((frame) =>
      frame.encodedHostMs === null ? [] : [frame.encodedHostMs - frame.arrivalHostMs],
    );
    return {
      capture:
        latency === null ? null : { ...latency, basis: absolute ? 'capture-time' : 'timestamp' },
      encode: percentiles(encodes),
      frames: frames.length,
    };
  }

  #lower(frame: FrameTiming): void {
    const offset = rawOffset(frame);
    if (this.#floorMs === null || offset < this.#floorMs) {
      this.#floorMs = offset;
    }
  }

  /** A frame's capture latency by its capture time when it has a plausible one, else beyond the floor. */
  #timed(frame: FrameTiming): Timed {
    const capture = frame.captureHostMs;
    if (capture !== null) {
      const ms = frame.arrivalHostMs - capture;
      if (ms >= -CAPTURE_TIME_SLACK_MS && ms <= CAPTURE_TIME_LIMIT_MS) {
        return { basis: 'capture-time', ms };
      }
    }
    return { basis: 'timestamp', ms: this.#beyondFloor(frame) };
  }

  #beyondFloor(frame: FrameTiming): number {
    return rawOffset(frame) - (this.#floorMs ?? rawOffset(frame));
  }
}

/** `arrivalHostMs − timestampUs / 1000`: the frame's arrival on the timestamp's own zero. */
function rawOffset(frame: FrameTiming): number {
  return frame.arrivalHostMs - frame.timestampUs / 1000;
}

/** The capture latency beyond which the running median has drifted from its baseline, ms. */
export const DRIFT_THRESHOLD_MS = 30;

/** How long the running median must sit beyond (or back within) the threshold to count, ms. */
export const DRIFT_HOLD_MS = 5000;

/** The running median is that of the readings of this long, ms. */
export const DRIFT_WINDOW_MS = 10_000;

/** At most one event a camera this often, ms. */
export const DRIFT_EVENT_INTERVAL_MS = 60_000;

/** What `LatencyDrift` asks to record (`recording.latency`, docs/DIAGNOSTICS.md). */
export interface LatencyDriftEvent {
  /** `drift`: the capture latency left its baseline; `recovered`: it came back within it. */
  readonly why: 'drift' | 'recovered';
  /** The camera's capture latency at its last sync check, ms. */
  readonly baselineMs: number;
  /** The running median now (over the last `DRIFT_WINDOW_MS`), ms. */
  readonly p50Ms: number;
  /** The running 95th percentile's median over the same readings, ms; null without one. */
  readonly p95Ms: number | null;
  /** `p50Ms − baselineMs`, ms. */
  readonly deltaMs: number;
}

/** One reading of the capture latency: its median and 95th percentile, ms. */
interface DriftSample {
  readonly atMs: number;
  readonly p50: number;
  readonly p95: number;
}

/**
 * The drift of a camera's capture latency from its sync check (docs/PLAN.md T5.3): fed a reading of
 * the meter every second (a phone's every 2 s, from its reports), it keeps the running median over
 * the last 10 s (the median of the readings' medians), and says the camera drifts once that median
 * has sat more than 30 ms from the baseline (the meter's median when the camera's last check ended)
 * for 5 s, and that it recovered once it has sat back within 30 ms for 5 s; `deltaMs` is the
 * difference while it drifts (the status line's `latency +75 ms`). Each change asks for an event,
 * one a minute at most for the camera: a change that comes sooner waits for the minute, and is
 * forgotten if the camera changed back meanwhile. Without a baseline (no check yet) nothing drifts.
 */
export class LatencyDrift {
  readonly #thresholdMs: number;
  readonly #holdMs: number;
  readonly #windowMs: number;
  readonly #intervalMs: number;
  #baselineMs: number | null = null;
  #samples: DriftSample[] = [];
  #drifting = false;
  /** Since when the median has sat on the other side of the threshold; null while it has not. */
  #crossedMs: number | null = null;
  /** The change waiting for its minute. */
  #pending: 'drift' | 'recovered' | null = null;
  #lastEventMs: number | null = null;
  #lastEvent: 'drift' | 'recovered' | null = null;

  constructor(
    options: {
      readonly thresholdMs?: number;
      readonly holdMs?: number;
      readonly windowMs?: number;
      readonly intervalMs?: number;
    } = {},
  ) {
    this.#thresholdMs = options.thresholdMs ?? DRIFT_THRESHOLD_MS;
    this.#holdMs = options.holdMs ?? DRIFT_HOLD_MS;
    this.#windowMs = options.windowMs ?? DRIFT_WINDOW_MS;
    this.#intervalMs = options.intervalMs ?? DRIFT_EVENT_INTERVAL_MS;
  }

  /** The baseline, ms; null without a check. */
  get baselineMs(): number | null {
    return this.#baselineMs;
  }

  /** The running median over the window, ms to 0.1; null without a reading in it. */
  get p50Ms(): number | null {
    return this.#median('p50');
  }

  /** The running median of the readings' 95th percentiles, ms to 0.1; null without a reading. */
  get p95Ms(): number | null {
    return this.#median('p95');
  }

  /** While the camera drifts, the running median less the baseline, whole ms; null otherwise. */
  get deltaMs(): number | null {
    const p50 = this.p50Ms;
    return this.#drifting && p50 !== null && this.#baselineMs !== null
      ? Math.round(p50 - this.#baselineMs)
      : null;
  }

  /** The camera's capture latency at its last check, ms (null: none); the drift is measured anew. */
  setBaseline(baselineMs: number | null): void {
    this.#baselineMs = baselineMs;
    this.#crossedMs = null;
  }

  /** The camera changed (or its pipeline restarted on another track): the readings start again. */
  restart(): void {
    this.#samples = [];
    this.#crossedMs = null;
  }

  /**
   * A reading at `nowMs` (null when the meter had no frame): the drift's state at that time, and the
   * event to record, if one is due now.
   */
  update(nowMs: number, reading: LatencyPercentiles | null): LatencyDriftEvent | null {
    if (reading !== null) {
      this.#samples.push({ atMs: nowMs, p50: reading.p50, p95: reading.p95 });
    }
    this.#samples = this.#samples.filter((sample) => nowMs - sample.atMs < this.#windowMs);
    const p50 = this.p50Ms;
    const baseline = this.#baselineMs;
    if (baseline === null) {
      // Nothing to compare with: a camera without a check never drifts (a new session's camera).
      this.#drifting = false;
      this.#crossedMs = null;
      this.#pending = null;
      return null;
    }
    if (p50 === null) {
      // No frame for the window (the recording stopped): the state stays as it was.
      return null;
    }
    const beyond = Math.abs(p50 - baseline) > this.#thresholdMs;
    if (beyond === this.#drifting) {
      this.#crossedMs = null;
    } else {
      this.#crossedMs ??= nowMs;
      if (nowMs - this.#crossedMs >= this.#holdMs) {
        this.#drifting = beyond;
        this.#crossedMs = null;
        this.#pending = beyond ? 'drift' : 'recovered';
      }
    }
    return this.#due(nowMs, baseline, p50);
  }

  /** The pending change as an event, when its minute has come and it says something new. */
  #due(nowMs: number, baselineMs: number, p50Ms: number): LatencyDriftEvent | null {
    const why = this.#pending;
    if (why === null) {
      return null;
    }
    if (this.#lastEventMs !== null && nowMs - this.#lastEventMs < this.#intervalMs) {
      return null;
    }
    this.#pending = null;
    // A drift that recovered before its minute came (or the reverse) says nothing new.
    if (why === this.#lastEvent || (this.#lastEvent === null && why === 'recovered')) {
      return null;
    }
    this.#lastEventMs = nowMs;
    this.#lastEvent = why;
    return {
      why,
      baselineMs: tenth(baselineMs),
      p50Ms,
      p95Ms: this.p95Ms,
      deltaMs: Math.round(p50Ms - baselineMs),
    };
  }

  #median(key: 'p50' | 'p95'): number | null {
    if (this.#samples.length === 0) {
      return null;
    }
    const sorted = this.#samples.map((sample) => sample[key]).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const value =
      sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return tenth(value);
  }
}

/** `value` to 0.1; never −0. */
function tenth(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}
