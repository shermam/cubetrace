// The cube's gyroscope stream (docs/PLAN.md T3.7, docs/DATA-MODEL.md §11): a ring buffer of the
// orientation reports, which the app fills with every `gyro` event without allocating, and the file
// written once per attempt from it, `gyro.json`, with the samples of the attempt's window. Pure
// TypeScript: the times come from the caller, so the tests run it on their own clock.
import type { AppBuild } from './session';

/** The name of the gyroscope file in an attempt's folder (docs/DATA-MODEL.md §5). */
export const GYRO_FILE = 'gyro.json';

/** How far back the buffer keeps samples, ms: the last 10 minutes. */
export const GYRO_BUFFER_MS = 10 * 60_000;

/**
 * The rate the buffer is sized for, in samples per second: its capacity holds
 * {@link GYRO_BUFFER_MS} of samples at this rate (a GAN cube reports its gyroscope at 50 to
 * 100 Hz); a cube that reports faster keeps less time.
 */
export const GYRO_BUFFER_RATE_HZ = 100;

/** An attempt's gyro window begins this long before its first scramble turn (the scramble clip's margin). */
export const GYRO_LEAD_MS = 2000;

/** An attempt's gyro window ends this long after `solveEnd` or the DNF (the clips' margin). */
export const GYRO_TAIL_MS = 1000;

/** The velocity stored for a sample whose packet carried none. */
const NO_VELOCITY = -128;

/**
 * The samples of a stretch of the buffer ({@link GyroBuffer.window}), oldest first: the host time of
 * each, four quaternion components per sample (`x, y, z, w`), and three velocity integers per sample
 * when the cube reports them.
 */
export interface GyroWindow {
  readonly hostMs: Float64Array;
  readonly q: Float32Array;
  /** Null when no sample of the window has a velocity. */
  readonly v: Int8Array | null;
  /** The buffer did not reach back to the window's start: its oldest sample is later. */
  readonly truncatedStart: boolean;
}

/**
 * `gyro.json`, schema version 1 (docs/DATA-MODEL.md §11): the gyroscope samples of one attempt's
 * window, from 2 s before its first scramble turn to 1 s after its end. Sample k is at host time
 * `t0HostMs + dtMs[0] + … + dtMs[k]`; its quaternion is `q[4k..4k+3]` (`x, y, z, w`) and its
 * velocity `v[3k..3k+2]`.
 */
export interface GyroJson {
  schema: 1;
  session: string;
  index: number;
  /** The build that wrote the file. */
  app: AppBuild;
  /** The host time of the first sample. */
  t0HostMs: number;
  /**
   * Per sample, the time since the previous one, in steps of 0.1 ms (the differences of the sample
   * times rounded to 0.1 ms, so that the sums do not drift, as the frames files keep them); 0 for the
   * first sample.
   */
  dtMs: number[];
  /** Unit quaternions, flat, four per sample, as the cube reports them, to 5 decimals. */
  q: number[];
  /** The angular velocity's raw integers, flat, three per sample; null when the cube gives none. */
  v: number[] | null;
  /** The buffer did not reach back to the window's start: the file begins at its oldest sample. */
  truncatedStart: boolean;
}

/** `gyro` in attempt.json (docs/DATA-MODEL.md §7): what the attempt's gyro file holds. */
export interface GyroSummary {
  /** The file's name in the attempt's folder: `gyro.json`. */
  file: string;
  /** The samples in it. */
  samples: number;
  /** The host time of its first sample. */
  fromHostMs: number;
  /** The host time of its last sample. */
  toHostMs: number;
  /** The samples per second over the file, to one decimal; 0 with fewer than two samples. */
  rateHz: number;
  truncatedStart: boolean;
}

/**
 * The last {@link GYRO_BUFFER_MS} of a cube's gyroscope reports, in typed arrays: `push` writes a
 * sample without allocating (the app calls it for every `gyro` event), dropping the samples older
 * than the window behind it, and the oldest one when the buffer is full; `window` copies a stretch
 * out, once per attempt. The buffer is the page's, not a connection's: the host clock runs on
 * across the cube's reconnections, so an attempt that spans one keeps its samples from before it,
 * with the gap between them.
 */
export class GyroBuffer {
  readonly capacity: number;
  readonly #windowMs: number;
  readonly #hostMs: Float64Array;
  readonly #q: Float32Array;
  readonly #v: Int8Array;
  /** The index of the oldest sample. */
  #head = 0;
  #length = 0;

  /**
   * @param opts.windowMs how far back samples are kept; default {@link GYRO_BUFFER_MS}.
   * @param opts.rateHz the rate the capacity is sized for; default {@link GYRO_BUFFER_RATE_HZ}.
   */
  constructor(opts: { windowMs?: number; rateHz?: number } = {}) {
    const windowMs = opts.windowMs ?? GYRO_BUFFER_MS;
    const rateHz = opts.rateHz ?? GYRO_BUFFER_RATE_HZ;
    if (!(windowMs > 0) || !(rateHz > 0)) {
      throw new RangeError(
        `A gyro buffer needs a positive window and rate, got ${String(windowMs)} ms at ${String(rateHz)} Hz.`,
      );
    }
    this.#windowMs = windowMs;
    this.capacity = Math.max(1, Math.ceil((windowMs / 1000) * rateHz));
    this.#hostMs = new Float64Array(this.capacity);
    this.#q = new Float32Array(this.capacity * 4);
    this.#v = new Int8Array(this.capacity * 3);
  }

  /** The samples held. */
  get length(): number {
    return this.#length;
  }

  /** The host time of the oldest sample held; null when the buffer is empty. */
  get oldestHostMs(): number | null {
    return this.#length === 0 ? null : this.#hostMs[this.#head];
  }

  /** The host time of the newest sample held; null when the buffer is empty. */
  get newestHostMs(): number | null {
    return this.#length === 0 ? null : this.#hostMs[this.#at(this.#length - 1)];
  }

  /**
   * Adds a sample: the host time of the report, its quaternion (`x, y, z, w`) and its velocity's
   * integers, if the cube gave them. Nothing is allocated. A sample that is not finite in time is
   * ignored; a sample older than the newest one is kept in the order it came (the times stay as
   * reported).
   */
  push(
    hostMs: number,
    q: readonly [number, number, number, number],
    v?: readonly [number, number, number] | null,
  ): void {
    if (!Number.isFinite(hostMs)) {
      return;
    }
    // The samples older than the window behind this one go, from the head.
    const limit = hostMs - this.#windowMs;
    while (this.#length > 0 && this.#hostMs[this.#head] < limit) {
      this.#head = (this.#head + 1) % this.capacity;
      this.#length--;
    }
    let at: number;
    if (this.#length === this.capacity) {
      at = this.#head;
      this.#head = (this.#head + 1) % this.capacity;
    } else {
      at = this.#at(this.#length);
      this.#length++;
    }
    this.#hostMs[at] = hostMs;
    const q4 = at * 4;
    this.#q[q4] = q[0];
    this.#q[q4 + 1] = q[1];
    this.#q[q4 + 2] = q[2];
    this.#q[q4 + 3] = q[3];
    const v3 = at * 3;
    if (v === undefined || v === null) {
      this.#v[v3] = NO_VELOCITY;
      this.#v[v3 + 1] = NO_VELOCITY;
      this.#v[v3 + 2] = NO_VELOCITY;
    } else {
      this.#v[v3] = v[0];
      this.#v[v3 + 1] = v[1];
      this.#v[v3 + 2] = v[2];
    }
  }

  /**
   * The samples from `fromHostMs` to `toHostMs` (both included), oldest first, as copies, with
   * whether the buffer reached back to `fromHostMs`: when its oldest sample is later (or it is
   * empty), `truncatedStart` is true and the window begins at that sample. Empty arrays when no
   * sample falls in the stretch.
   */
  window(fromHostMs: number, toHostMs: number): GyroWindow {
    const first = this.#firstAtOrAfter(fromHostMs);
    let last = first;
    while (last < this.#length && this.#hostMs[this.#at(last)] <= toHostMs) {
      last++;
    }
    const count = Math.max(0, last - first);
    const hostMs = new Float64Array(count);
    const q = new Float32Array(count * 4);
    const v = new Int8Array(count * 3);
    let hasVelocity = false;
    for (let k = 0; k < count; k++) {
      const at = this.#at(first + k);
      hostMs[k] = this.#hostMs[at];
      q.set(this.#q.subarray(at * 4, at * 4 + 4), k * 4);
      const v3 = at * 3;
      if (this.#v[v3] === NO_VELOCITY) {
        v[k * 3] = 0;
        v[k * 3 + 1] = 0;
        v[k * 3 + 2] = 0;
      } else {
        hasVelocity = true;
        v[k * 3] = this.#v[v3];
        v[k * 3 + 1] = this.#v[v3 + 1];
        v[k * 3 + 2] = this.#v[v3 + 2];
      }
    }
    const oldest = this.oldestHostMs;
    return {
      hostMs,
      q,
      v: hasVelocity ? v : null,
      truncatedStart: oldest === null || oldest > fromHostMs,
    };
  }

  /** Forgets every sample. */
  clear(): void {
    this.#head = 0;
    this.#length = 0;
  }

  /** The array index of the sample `k` from the oldest. */
  #at(k: number): number {
    return (this.#head + k) % this.capacity;
  }

  /** The position (from the oldest) of the first sample at or after `hostMs`; `length` if none. */
  #firstAtOrAfter(hostMs: number): number {
    let low = 0;
    let high = this.#length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#hostMs[this.#at(middle)] < hostMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/** `x` rounded to 5 decimals: the precision of the cube's 15-bit quaternion fractions. */
function round5(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

/**
 * The intervals of `hostMs`, in steps of 0.1 ms without drift (docs/DATA-MODEL.md §9): with `tₖ`
 * the k-th time, `dtMs[k] = r(tₖ − t₀) − r(tₖ₋₁ − t₀)`, where `r` rounds to 0.1 ms, so that the
 * running sums are the times rounded to 0.1 ms; `dtMs[0]` is 0.
 */
export function gyroIntervals(hostMs: ArrayLike<number>): number[] {
  const dtMs: number[] = [];
  if (hostMs.length === 0) {
    return dtMs;
  }
  const t0 = hostMs[0];
  let previous = 0;
  for (let k = 0; k < hostMs.length; k++) {
    const tenths = Math.round((hostMs[k] - t0) * 10);
    dtMs.push((tenths - previous) / 10);
    previous = tenths;
  }
  return dtMs;
}

/**
 * The gyro file of attempt `index` of `session` from the samples of `window` (docs/DATA-MODEL.md
 * §11): the first sample's host time, the intervals ({@link gyroIntervals}), the quaternions flat to
 * 5 decimals, the velocities flat (null when the cube gives none) and whether the window was
 * truncated. Throws a RangeError on a window without a sample: such an attempt has no file.
 */
export function gyroFile(input: {
  session: string;
  index: number;
  app: AppBuild;
  window: GyroWindow;
}): GyroJson {
  const { session, index, app, window } = input;
  const count = window.hostMs.length;
  if (count === 0) {
    throw new RangeError('A gyro file needs at least one sample.');
  }
  const q: number[] = new Array<number>(count * 4);
  for (let k = 0; k < q.length; k++) {
    q[k] = round5(window.q[k]);
  }
  return {
    schema: 1,
    session,
    index,
    app: { version: app.version, commit: app.commit },
    t0HostMs: window.hostMs[0],
    dtMs: gyroIntervals(window.hostMs),
    q,
    v: window.v === null ? null : Array.from(window.v),
    truncatedStart: window.truncatedStart,
  };
}

/**
 * `gyro` of attempt.json for `file` (docs/DATA-MODEL.md §7): its name, its samples, the host times
 * of its first and last samples (`t0HostMs` plus the intervals), their rate over that span to one
 * decimal (0 with fewer than two samples), and whether it was truncated.
 */
export function gyroSummary(file: GyroJson, name = GYRO_FILE): GyroSummary {
  const samples = file.dtMs.length;
  let tenths = 0;
  for (const dt of file.dtMs) {
    tenths += Math.round(dt * 10);
  }
  const spanMs = tenths / 10;
  const toHostMs = file.t0HostMs + spanMs;
  const rateHz =
    samples < 2 || spanMs <= 0 ? 0 : Math.round(((samples - 1) / spanMs) * 10_000) / 10;
  return {
    file: name,
    samples,
    fromHostMs: file.t0HostMs,
    toHostMs,
    rateHz,
    truncatedStart: file.truncatedStart,
  };
}
