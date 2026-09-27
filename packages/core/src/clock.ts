// The cube clock fit (docs/DATA-MODEL.md §1, §6 and §7): host ≈ a·cube + b, a least-squares line of
// the host time on the cube time of a series of moves, updated online: an attempt's moves for its
// `clock` in attempt.json, a connection's for the coarse `clock.cube` of session.json. A Bluetooth
// packet carries up to seven moves that all get the packet's arrival time, although the older ones
// happened earlier, so only the newest move of each packet (`packetLast`) is a sample of the line.
// When the cube's clock starts again (it reconnected, or its count of a long pause ran out), the fit
// starts again with it (T2.9).

/**
 * The fit as the records store it: `clock` in attempt.json (docs/DATA-MODEL.md §7) and
 * `clock.cube` in session.json (§6).
 */
export interface CubeClockParams {
  /** Host ms per cube ms: 1 plus the cube clock's drift (1.0002 is 200 ppm). */
  a: number;
  /** Host ms at cube ms 0. */
  b: number;
  /**
   * The 95th percentile (nearest rank) of the absolute residuals `|host − (a·cube + b)|` of the
   * most recent samples (the fit's `window`); 0 before two samples.
   */
  residualP95Ms: number;
  /**
   * The samples in the fit: the `packetLast` moves added since the cube's clock last started again
   * (all of them when it did not).
   */
  samples: number;
}

/** How many of the most recent samples `residualP95Ms` is computed over, by default. */
export const CLOCK_FIT_WINDOW = 2000;

/**
 * How far the cube's time may fall behind the host's between two samples of the fit, in ms, beyond
 * {@link CLOCK_RESTART_DRIFT} of the host time between them, before the fit takes the cube's clock
 * for a new one and starts again (docs/DATA-MODEL.md §7). While the cube's clock runs, its time
 * advances as the host's does, to the Bluetooth jitter (tens of ms) and to its drift (the cubes
 * measured run 0.1 to 0.7% slow, docs/DEVICES.md). It falls behind by far more when the clock starts
 * again: the cube reconnected (its count restarts at 0: the GAN 356 i3's went from 561,080 ms back to
 * 10,977 after 434 s, the 12 ui's from 51,434 back to 51,142 after 3 hours), or a pause between two
 * moves outlasted the cube's 16-bit count of it (the i3 reports 65,535 ms for 80 s).
 */
export const CLOCK_RESTART_MS = 1000;

/** The share of the host time between two samples that the cube's clock may lose by drifting. */
export const CLOCK_RESTART_DRIFT = 0.01;

interface Sample {
  cubeMs: number;
  hostMs: number;
}

/**
 * The linear map from the cube's clock to the host clock, fitted online. Only `packetLast` samples
 * enter the fit; the others only serve as a fallback before the first `packetLast` one. With fewer
 * than two samples in the fit (or all at one cube time) there is no line: {@link toHost} adds the
 * cube time elapsed since the last sample (`a = 1`) to that sample's host time, and with no sample
 * at all it is the identity.
 *
 * A sample whose cube time, counted from the fit's previous sample, falls more than
 * {@link CLOCK_RESTART_MS} plus {@link CLOCK_RESTART_DRIFT} of the host time between them behind its
 * host time comes from a new cube clock: the fit drops the samples before it and starts again from
 * it, so that the line is that of the cube's current clock (`samples` counts from there). A cube
 * time that goes back more than a second always does; the Bluetooth jitter and the drift never do.
 *
 * The sums are kept as Welford's running means and co-moments of each sample's offset from the
 * first one, so that host times of about 1.7e12 ms (`performance.timeOrigin` is a wall clock) lose
 * no precision. The fit weighs every sample equally; the residual percentile only looks at the last
 * `window` samples. Pure and synchronous, like the rest of the package.
 */
export class CubeClockFit {
  readonly #window: number;
  /** The first sample in the fit: the origin of the offsets below. */
  #origin: Sample | null = null;
  #n = 0;
  /** Means of the offsets from the origin. */
  #meanX = 0;
  #meanY = 0;
  /** Sums of squared deviations of x, and of products of the deviations of x and y. */
  #sxx = 0;
  #sxy = 0;
  /** The offsets of the last `window` samples in the fit, as a ring buffer. */
  readonly #recentX: Float64Array;
  readonly #recentY: Float64Array;
  /** The last sample in the fit, and the last sample of any kind. */
  #lastFit: Sample | null = null;
  #lastAny: Sample | null = null;
  /** The parameters, computed on demand after the last sample. */
  #params: CubeClockParams | null = null;
  /** How many times the fit started again with a new cube clock. */
  #restarts = 0;

  /**
   * @param opts.window how many of the most recent samples `residualP95Ms` covers (default
   *   {@link CLOCK_FIT_WINDOW}).
   */
  constructor(opts: { window?: number } = {}) {
    const window = opts.window ?? CLOCK_FIT_WINDOW;
    if (!Number.isInteger(window) || window < 1) {
      throw new RangeError(`The window must be a positive integer, got ${String(window)}.`);
    }
    this.#window = window;
    this.#recentX = new Float64Array(window);
    this.#recentY = new Float64Array(window);
  }

  /**
   * Adds a move's two times. Only the newest move of its Bluetooth packet (`packetLast`) enters the
   * fit: the older moves of a packet share its host time. A `packetLast` sample of a new cube clock
   * (see the class comment) starts the fit again. Throws on a time that is not finite.
   */
  addSample(cubeMs: number, hostMs: number, packetLast: boolean): void {
    if (!Number.isFinite(cubeMs) || !Number.isFinite(hostMs)) {
      throw new RangeError(
        `Clock samples must be finite, got cube ${String(cubeMs)} ms and host ${String(hostMs)} ms.`,
      );
    }
    const sample = { cubeMs, hostMs };
    this.#lastAny = sample;
    this.#params = null;
    if (!packetLast) {
      return;
    }
    if (this.#lastFit !== null && clockRestarted(this.#lastFit, sample)) {
      this.#restart();
    }
    this.#origin ??= sample;
    const x = cubeMs - this.#origin.cubeMs;
    const y = hostMs - this.#origin.hostMs;
    this.#n += 1;
    const dx = x - this.#meanX;
    this.#meanX += dx / this.#n;
    this.#meanY += (y - this.#meanY) / this.#n;
    this.#sxx += dx * (x - this.#meanX);
    this.#sxy += dx * (y - this.#meanY);
    const slot = (this.#n - 1) % this.#window;
    this.#recentX[slot] = x;
    this.#recentY[slot] = y;
    this.#lastFit = sample;
  }

  /** The host time of a cube time, by the current fit (see the class comment before two samples). */
  toHost(cubeMs: number): number {
    const line = this.#line();
    if (line !== null && this.#origin !== null) {
      return this.#origin.hostMs + line.a * (cubeMs - this.#origin.cubeMs) + line.offset;
    }
    const anchor = this.#lastFit ?? this.#lastAny;
    return anchor === null ? cubeMs : anchor.hostMs + (cubeMs - anchor.cubeMs);
  }

  /** The fit's parameters, as the records store them. */
  get params(): CubeClockParams {
    this.#params ??= this.#computeParams();
    return { ...this.#params };
  }

  /**
   * Whether the samples make a line: at least two, at different cube times. Without one, the
   * parameters are the fallback of the class comment (`a` = 1), which attempt.json records as null.
   */
  get hasLine(): boolean {
    return this.#line() !== null;
  }

  /** How many times the fit started again because the cube's clock did. */
  get restarts(): number {
    return this.#restarts;
  }

  /** Forgets the samples of the fit: the next one is the origin of a new line. */
  #restart(): void {
    this.#origin = null;
    this.#n = 0;
    this.#meanX = 0;
    this.#meanY = 0;
    this.#sxx = 0;
    this.#sxy = 0;
    this.#lastFit = null;
    this.#restarts += 1;
  }

  /**
   * The line in offsets from the origin, `y = a·x + offset`, or null without two samples at
   * different cube times.
   */
  #line(): { a: number; offset: number } | null {
    if (this.#n < 2 || this.#sxx <= 0) {
      return null;
    }
    const a = this.#sxy / this.#sxx;
    return { a, offset: this.#meanY - a * this.#meanX };
  }

  #computeParams(): CubeClockParams {
    const line = this.#line();
    if (line === null || this.#origin === null) {
      const anchor = this.#lastFit ?? this.#lastAny;
      return {
        a: 1,
        b: anchor === null ? 0 : anchor.hostMs - anchor.cubeMs,
        residualP95Ms: 0,
        samples: this.#n,
      };
    }
    const { a, offset } = line;
    const count = Math.min(this.#n, this.#window);
    const residuals: number[] = [];
    for (let i = 0; i < count; i++) {
      residuals.push(Math.abs(this.#recentY[i] - (a * this.#recentX[i] + offset)));
    }
    residuals.sort((p, q) => p - q);
    return {
      a,
      b: this.#origin.hostMs + offset - a * this.#origin.cubeMs,
      residualP95Ms: residuals[Math.ceil(0.95 * count) - 1],
      samples: this.#n,
    };
  }
}

/**
 * Whether `next` comes from another cube clock than `previous`: its cube time is further behind its
 * host time, counted from `previous`, than the jitter and the drift allow ({@link CLOCK_RESTART_MS},
 * {@link CLOCK_RESTART_DRIFT}).
 */
function clockRestarted(previous: Sample, next: Sample): boolean {
  const hostElapsed = next.hostMs - previous.hostMs;
  const behind = hostElapsed - (next.cubeMs - previous.cubeMs);
  return behind > CLOCK_RESTART_MS + CLOCK_RESTART_DRIFT * Math.max(0, hostElapsed);
}
