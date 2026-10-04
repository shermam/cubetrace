// The clock sync of a remote camera (docs/DATA-MODEL.md §1 and §6, docs/RTC.md, docs/PLAN.md T4.0):
// the phone keeps its own clock (its `performance.timeOrigin + performance.now()`), and the host
// measures how far it is from the host clock over the data channel, as NTP does over a network. The
// host sends a `ping` at `t1`; the phone receives it at `t2` and answers at `t3`, both on its clock;
// the host receives the `pong` at `t4`. Each round trip gives one sample of the offset (the phone's
// clock minus the host's) and of the round-trip time; the samples with the least round trip have
// the least room for an asymmetry between the two legs, so the offset is the median of those, as a
// clock filter takes it: those within a band of the least, and at least the ten of least round trip
// of the window however jittery the link (T4.2b); and once they span a minute, a line through them
// gives the drift of the phone's clock against the host's. The dataset stays on the host clock: the
// phone's frame times are converted with `toHostMs`, and the fit is recorded in session.json as
// `clock.cameras[label].remote`.

/**
 * The fit as session.json records it (`clock.cameras[label].remote`, docs/DATA-MODEL.md §6): a
 * snapshot of the estimate when the record was written.
 */
export interface RemoteClockParams {
  /**
   * The remote clock minus the host clock, in ms, at the time of the snapshot: `remoteMs ≈ hostMs +
   * offsetMs`. Positive when the phone's clock is ahead.
   */
  offsetMs: number;
  /**
   * The drift of the remote clock against the host's, in parts per million: how many ms the offset
   * grows per second, times a thousand (50 ppm is 3 ms a minute). 0 before the samples span enough
   * for a fit ({@link REMOTE_CLOCK_DRIFT_SPAN_MS}).
   */
  driftPpm: number;
  /** The least round trip of the samples the estimate stands on, in ms. */
  rttMs: number;
  /**
   * The samples the estimate stands on (kept): those of the window whose round trip was short enough
   * ({@link RemoteClockFit}).
   */
  samples: number;
  /**
   * The 95th percentile (nearest rank) of the absolute residuals of those samples' offsets from the
   * estimate (the line, or the median before the fit), in ms; 0 with fewer than two samples.
   */
  residualP95Ms: number;
  /** The host time (`t4`) of the oldest sample the estimate stands on. */
  since: number;
}

/**
 * The fit's record as session.json keeps it in `clock.cameras[label].remote` (docs/DATA-MODEL.md §6):
 * {@link RemoteClockParams}, and since T4.2 whether the fit had converged when the record was
 * written. The host writes it at convergence (T4.1, `converged` true), and, when a remote camera's
 * first cut goes before that, the estimate the cut relied on (T4.2, `converged` false). Absent from
 * the records written before T4.2, which were all written at convergence.
 */
export interface RemoteClockRecord extends RemoteClockParams {
  converged?: boolean;
}

/** The sample of least round trip of a fit's window ({@link RemoteClockFit.least}). */
export interface RemoteClockLeast {
  /** Its offset: the remote clock minus the host's, in ms. */
  readonly offsetMs: number;
  /** Its round trip, in ms. */
  readonly rttMs: number;
  /** The host time it stands for: the middle of its round trip. */
  readonly hostMs: number;
}

/**
 * The window's round trips, kept or not (T4.2b): how the link behaves, for the diagnostics (the
 * `rtc.clock` event) rather than for the estimate.
 */
export interface RemoteClockWindow {
  /** The samples the window holds. */
  readonly samples: number;
  /** Of them, those the estimate stands on. */
  readonly kept: number;
  /** The median of their round trips, in ms; 0 with no sample. */
  readonly rttP50Ms: number;
  /** The 95th percentile (nearest rank) of their round trips, in ms; 0 with no sample. */
  readonly rttP95Ms: number;
}

/** One round trip: the host's `t1` and `t4`, the remote's `t2` and `t3`, all in ms. */
export interface RemoteClockSample {
  /** When the host sent the ping, on the host clock. */
  t1: number;
  /** When the remote received it, on its clock. */
  t2: number;
  /** When the remote answered, on its clock. */
  t3: number;
  /** When the host received the answer, on the host clock. */
  t4: number;
}

/**
 * The window the fit looks at, by default: the samples of the last two minutes (T4.2b; the last 60
 * samples before, which is the same at the pings' steady 2 s): long enough for the drift fit's minute
 * ({@link REMOTE_CLOCK_DRIFT_SPAN_MS}) whatever the pings' rate, short enough to forget a bad spell in
 * two minutes.
 */
export const REMOTE_CLOCK_WINDOW_MS = 120_000;

/**
 * At most this many samples, by default, however fast the pings come: two minutes at the 500 ms of
 * the first pings (`ClockPinger`, T4.2b).
 */
export const REMOTE_CLOCK_WINDOW = 240;

/**
 * A sample enters the estimate when its round trip is at most this many times the least round trip
 * of the window: the longer trips had more room for an asymmetry between the two legs.
 */
export const REMOTE_CLOCK_RTT_FACTOR = 1.5;

/**
 * Or at most this much longer than the least round trip, in ms, when that is more (T4.1): on a
 * loopback or an Ethernet link the least trip is a millisecond, and 1.5 times it keeps only the
 * samples that met no work at all on either main thread (4 of 31 in a minute between two pages
 * encoding video), while a trip 3 ms over the least can be off by 1.5 ms at most, under what the
 * factor already admits from a 6 ms trip up.
 */
export const REMOTE_CLOCK_RTT_ALLOWANCE_MS = 3;

/**
 * However jittery the link, the estimate stands on at least this many samples of the window, those
 * of least round trip (T4.2b; the lower half of the window while it holds fewer than twice as many,
 * so that a trip of a burst never decides a median of two). The band above is a share of the least
 * trip, and on a Wi-Fi whose trips jitter by more than it, it keeps a handful: on the owner's home
 * Wi-Fi (2026-10-04: the least trip 5.4 to 8.5 ms) it kept 2 to 14 of 60, the count flapped around
 * the ten that convergence asks for, and only 10 of the 36 cuts went with the fit converged; between
 * two pages of one browser that both encode (the least 2 to 3 ms, the median 17 to 18) it kept 1 to
 * 4 of 16. Ten is the count convergence asks for; a fixed count rather than a share of the window, so
 * that the faster pings of the start (more samples in the window) keep better trips, not more.
 */
export const REMOTE_CLOCK_MIN_KEPT = 10;

/**
 * The drift is fitted once the samples kept span more than this, in ms: over a shorter span the
 * slope of a line through offsets that jitter by a millisecond would mostly be noise (50 ppm is
 * 3 ms over a minute).
 */
export const REMOTE_CLOCK_DRIFT_SPAN_MS = 60_000;

/**
 * When the sync counts as converged ({@link RemoteClockFit.converged}): at least `samples` kept,
 * spanning at least `spanMs`, whose offsets spread (90th minus 10th percentile of their residuals
 * from the estimate) by less than `spreadMs`, and every sample of the window within half its round
 * trip of the estimate, give or take `spreadMs` (a sample farther off than its own trip allows says
 * that a clock moved: the phone slept, T4.2b). The spread was 3 ms until T4.2b: the ten trips of
 * least round trip of a jittery Wi-Fi are up to about 4 ms over the least, so their offsets spread by
 * 2.5 to 3.5 ms, and 3 ms flapped (the simulations of `remote-clock.test.ts`); 5 ms is a sixth of a
 * frame at 30 fps, and still refuses a busy network's 10 ms and more.
 */
export const REMOTE_CLOCK_CONVERGED = { samples: 10, spanMs: 10_000, spreadMs: 5 } as const;

/**
 * A remote clock's estimate frozen as it stood (T4.3): the line `offset(h) = offsetMs + drift·(h −
 * atHostMs)`, the drift `driftPpm · 10⁻⁶`, from which {@link toHostMs} and {@link toRemoteMs} are exact
 * inverses. {@link RemoteClockFit}'s own conversions follow its window as answers come; a line taken
 * when a remote camera's clip was cut keeps the estimate of the clip's own time, whatever the fit
 * becomes before the clip's files come (a reconnection whose new samples fill the window, a clock
 * that moved while the phone slept), and places the clip's first frame by the line's value there.
 */
export class RemoteClockLine {
  /**
   * @param offsetMs the remote clock minus the host clock at `atHostMs`, in ms.
   * @param driftPpm how fast that offset grows, in parts per million (0: a constant offset).
   * @param atHostMs the host time at which the offset is `offsetMs`.
   */
  constructor(
    readonly offsetMs: number,
    readonly driftPpm: number,
    readonly atHostMs: number,
  ) {
    for (const value of [offsetMs, driftPpm, atHostMs]) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`A clock line takes finite numbers, got ${String(value)}.`);
      }
    }
  }

  /** The remote clock minus the host clock at a host time. */
  offsetAt(hostMs: number): number {
    return this.offsetMs + this.driftPpm * 1e-6 * (hostMs - this.atHostMs);
  }

  /** The remote time of a host time. */
  toRemoteMs(hostMs: number): number {
    return hostMs + this.offsetAt(hostMs);
  }

  /**
   * The host time of a remote time: `remote = host + offset(host)` solved for the host time,
   * counted from `atHostMs`, so that wall-clock values lose no precision.
   */
  toHostMs(remoteMs: number): number {
    return this.atHostMs + (remoteMs - this.offsetMs - this.atHostMs) / (1 + this.driftPpm * 1e-6);
  }
}

/** A sample as the window keeps it. */
interface Measured {
  /** The host time the sample stands for: the middle of the round trip. */
  hostMs: number;
  /** When the host received the answer. */
  t4: number;
  /** `((t2 − t1) + (t3 − t4)) / 2`: the remote clock minus the host's, with the legs symmetric. */
  offsetMs: number;
  /** `(t4 − t1) − (t3 − t2)`: the round trip without the remote's time to answer. */
  rttMs: number;
}

/** The estimate over the window, computed on demand after the last sample. */
interface Estimate {
  /** The window's samples, oldest first. */
  samples: readonly Measured[];
  kept: Measured[];
  rttMs: number;
  /** The offset at `t0`: the median of the kept offsets, or the line's value there. */
  a: number;
  /** The slope of the line, in ms per ms; 0 without a fit. */
  b: number;
  /** The host time the line is anchored at: the mean host time of the kept samples. */
  t0: number;
  hasDrift: boolean;
  residuals: number[];
  /** The host time of the newest sample of the window: when the estimate is "now". */
  latestMs: number;
}

/**
 * The offset and the drift of a remote clock against the host clock, estimated online from the
 * round trips of the data channel's pings (the file comment). The window holds the samples of the
 * last {@link REMOTE_CLOCK_WINDOW_MS} (at most {@link REMOTE_CLOCK_WINDOW}); of them, the estimate
 * stands on (keeps) those whose round trip is within {@link REMOTE_CLOCK_RTT_FACTOR} of the least
 * (or {@link REMOTE_CLOCK_RTT_ALLOWANCE_MS} over it, when that is more), and on at least the
 * {@link REMOTE_CLOCK_MIN_KEPT} of least round trip (the lower half of the window while it holds
 * fewer than twice as many): the median of their offsets, and, once they span more than
 * {@link REMOTE_CLOCK_DRIFT_SPAN_MS}, a least-squares line `offset(t) = a + b·(t − t0)` through them
 * for the drift. {@link toHostMs} and {@link toRemoteMs} use the line when there is one and the
 * median before; with no sample at all they are the identity. Pure and synchronous, like the rest of
 * the package: the tests simulate clocks.
 *
 * The sums of the fit are taken over host times counted from the kept samples' mean, so that host
 * times of about 1.7e12 ms (`performance.timeOrigin` is a wall clock) lose no precision.
 */
export class RemoteClockFit {
  readonly #window: number;
  readonly #windowMs: number;
  /** The window's samples, oldest first. */
  readonly #samples: Measured[] = [];
  #estimate: Estimate | null = null;

  /**
   * @param opts.window at most how many of the most recent samples the estimate looks at (default
   *   {@link REMOTE_CLOCK_WINDOW}).
   * @param opts.windowMs how far back from the newest sample it looks, in ms (default
   *   {@link REMOTE_CLOCK_WINDOW_MS}): a sample received that long before the newest leaves.
   */
  constructor(opts: { window?: number; windowMs?: number } = {}) {
    const window = opts.window ?? REMOTE_CLOCK_WINDOW;
    const windowMs = opts.windowMs ?? REMOTE_CLOCK_WINDOW_MS;
    if (!Number.isInteger(window) || window < 1) {
      throw new RangeError(`The window must be a positive integer, got ${String(window)}.`);
    }
    if (!(windowMs > 0)) {
      throw new RangeError(`The window must last some time, got ${String(windowMs)} ms.`);
    }
    this.#window = window;
    this.#windowMs = windowMs;
  }

  /**
   * Adds a round trip. Throws on a time that is not finite, on a `t4` before `t1` and on a `t3`
   * before `t2`, which no monotonic clock gives.
   */
  addSample(t1: number, t2: number, t3: number, t4: number): void {
    for (const t of [t1, t2, t3, t4]) {
      if (!Number.isFinite(t)) {
        throw new RangeError(`Clock samples must be finite, got ${String(t)} ms.`);
      }
    }
    if (t4 < t1 || t3 < t2) {
      throw new RangeError(
        `A round trip runs forward on each clock, got t1 ${String(t1)}, t2 ${String(t2)}, t3 ${String(t3)}, t4 ${String(t4)}.`,
      );
    }
    this.#samples.push({
      hostMs: (t1 + t4) / 2,
      t4,
      offsetMs: (t2 - t1 + (t3 - t4)) / 2,
      rttMs: t4 - t1 - (t3 - t2),
    });
    // The samples received `windowMs` or more before the newest one leave, and the oldest beyond
    // `window`. The answers come in the order of their t4, which is the host's clock.
    const since = t4 - this.#windowMs;
    let gone = Math.max(0, this.#samples.length - this.#window);
    while (gone < this.#samples.length - 1 && this.#samples[gone].t4 <= since) {
      gone++;
    }
    this.#samples.splice(0, gone);
    this.#estimate = null;
  }

  /** How many samples the window holds. */
  get samples(): number {
    return this.#samples.length;
  }

  /** The host time of a remote time, by the current estimate (the identity with no sample). */
  toHostMs(remoteMs: number): number {
    const e = this.#current();
    if (e === null) {
      return remoteMs;
    }
    // remote = host + a + b·(host − t0), solved for host.
    return (remoteMs - e.a + e.b * e.t0) / (1 + e.b);
  }

  /** The remote time of a host time, by the current estimate (the identity with no sample). */
  toRemoteMs(hostMs: number): number {
    const e = this.#current();
    return e === null ? hostMs : hostMs + e.a + e.b * (hostMs - e.t0);
  }

  /**
   * The remote clock minus the host clock now: at the host time of the window's newest sample, the
   * line's value there, or the median before the fit; 0 with no sample.
   */
  get offsetMs(): number {
    const e = this.#current();
    return e === null ? 0 : fitted(e, e.latestMs);
  }

  /** The least round trip of the window's samples, in ms; 0 with no sample. */
  get rttMs(): number {
    return this.#current()?.rttMs ?? 0;
  }

  /** The drift in parts per million; 0 before the fit. */
  get driftPpm(): number {
    return (this.#current()?.b ?? 0) * 1e6;
  }

  /**
   * The window's sample of least round trip, whose offset had the least room for an asymmetry
   * between the two legs (T4.2: the estimate of the cuts before the fit keeps a few samples); null
   * with no sample.
   */
  get least(): RemoteClockLeast | null {
    let best: Measured | null = null;
    for (const sample of this.#samples) {
      if (best === null || sample.rttMs < best.rttMs) {
        best = sample;
      }
    }
    return best === null
      ? null
      : { offsetMs: best.offsetMs, rttMs: best.rttMs, hostMs: best.hostMs };
  }

  /**
   * The window's round trips, kept or not (T4.2b): their median and 95th percentile, and the share
   * the estimate keeps, for the `rtc.clock` event; zeros with no sample.
   */
  get window(): RemoteClockWindow {
    const e = this.#current();
    if (e === null) {
      return { samples: 0, kept: 0, rttP50Ms: 0, rttP95Ms: 0 };
    }
    const trips = e.samples.map((s) => s.rttMs).sort((p, q) => p - q);
    return {
      samples: e.samples.length,
      kept: e.kept.length,
      rttP50Ms: percentile(trips, 0.5),
      rttP95Ms: percentile(trips, 0.95),
    };
  }

  /**
   * The 95th percentile (nearest rank) of the round trips of the samples the estimate stands on, in
   * ms (T4.2: the margin of a cut's window); 0 with no sample.
   */
  get rttP95Ms(): number {
    const e = this.#current();
    if (e === null) {
      return 0;
    }
    return percentile(
      e.kept.map((s) => s.rttMs).sort((p, q) => p - q),
      0.95,
    );
  }

  /** Whether the kept samples span enough for the drift to be fitted. */
  get hasDrift(): boolean {
    return this.#current()?.hasDrift ?? false;
  }

  /**
   * Whether the estimate is good enough to use ({@link REMOTE_CLOCK_CONVERGED}): enough samples
   * kept over enough time, whose offsets agree with the estimate to within a few milliseconds, and
   * no sample of the window farther from it than its own round trip allows. It is withdrawn when the
   * window's samples no longer agree (the network got busy) and at the first sample that cannot be
   * (a clock moved: the phone slept), and comes back once the window has turned over.
   */
  get converged(): boolean {
    const e = this.#current();
    if (e === null || e.kept.length < REMOTE_CLOCK_CONVERGED.samples) {
      return false;
    }
    const span = e.kept[e.kept.length - 1].hostMs - e.kept[0].hostMs;
    if (span < REMOTE_CLOCK_CONVERGED.spanMs) {
      return false;
    }
    const signed = [...e.residuals].sort((p, q) => p - q);
    if (percentile(signed, 0.9) - percentile(signed, 0.1) >= REMOTE_CLOCK_CONVERGED.spreadMs) {
      return false;
    }
    // A sample's offset is off the truth by half the difference of its two legs, so by at most half
    // its round trip, whatever the network did: one farther from the estimate than that, and than
    // the estimate's own error, says that one of the clocks moved since the others.
    return e.samples.every(
      (s) =>
        Math.abs(s.offsetMs - fitted(e, s.hostMs)) <= s.rttMs / 2 + REMOTE_CLOCK_CONVERGED.spreadMs,
    );
  }

  /**
   * The estimate now, frozen (T4.3): its line (or, before the drift is fitted, the median offset
   * with no drift) at the host time of the window's newest sample, which converts as
   * {@link toHostMs} and {@link toRemoteMs} do now and keeps doing so whatever samples come after;
   * the identity with no sample.
   */
  line(): RemoteClockLine {
    const e = this.#current();
    return e === null
      ? new RemoteClockLine(0, 0, 0)
      : new RemoteClockLine(fitted(e, e.latestMs), e.b * 1e6, e.latestMs);
  }

  /** The estimate, as session.json records it; the zero record with no sample. */
  get params(): RemoteClockParams {
    const e = this.#current();
    if (e === null) {
      return { offsetMs: 0, driftPpm: 0, rttMs: 0, samples: 0, residualP95Ms: 0, since: 0 };
    }
    const absolute = e.residuals.map(Math.abs).sort((p, q) => p - q);
    return {
      offsetMs: this.offsetMs,
      driftPpm: e.b * 1e6,
      rttMs: e.rttMs,
      samples: e.kept.length,
      residualP95Ms: absolute.length < 2 ? 0 : percentile(absolute, 0.95),
      since: e.kept[0].t4,
    };
  }

  #current(): Estimate | null {
    if (this.#samples.length === 0) {
      return null;
    }
    this.#estimate ??= estimate(this.#samples);
    return this.#estimate;
  }
}

/** The estimate over the window's samples (at least one). */
function estimate(samples: readonly Measured[]): Estimate {
  const trips = samples.map((s) => s.rttMs).sort((p, q) => p - q);
  const rttMs = trips[0];
  // The band of the least trip, or the trip of the REMOTE_CLOCK_MIN_KEPT-th least when that is
  // longer (the lower half of a window of fewer than twice as many).
  const least = Math.min(REMOTE_CLOCK_MIN_KEPT, Math.max(1, Math.floor(samples.length / 2)));
  const limit = Math.max(
    REMOTE_CLOCK_RTT_FACTOR * rttMs,
    rttMs + REMOTE_CLOCK_RTT_ALLOWANCE_MS,
    trips[least - 1],
  );
  const kept = samples.filter((s) => s.rttMs <= limit);
  const t0 = kept.reduce((sum, s) => sum + s.hostMs, 0) / kept.length;
  const span = kept[kept.length - 1].hostMs - kept[0].hostMs;
  let a = median(kept.map((s) => s.offsetMs));
  let b = 0;
  let hasDrift = false;
  if (span > REMOTE_CLOCK_DRIFT_SPAN_MS) {
    // Least squares of the offset on the host time counted from t0: the slope, and the mean offset
    // as the intercept (the mean of x is 0 at t0).
    let sxx = 0;
    let sxy = 0;
    let meanY = 0;
    for (const s of kept) {
      meanY += s.offsetMs / kept.length;
    }
    for (const s of kept) {
      const x = s.hostMs - t0;
      sxx += x * x;
      sxy += x * (s.offsetMs - meanY);
    }
    if (sxx > 0) {
      b = sxy / sxx;
      a = meanY;
      hasDrift = true;
    }
  }
  const e: Estimate = {
    samples,
    kept,
    rttMs,
    a,
    b,
    t0,
    hasDrift,
    residuals: [],
    latestMs: samples[samples.length - 1].hostMs,
  };
  e.residuals = kept.map((s) => s.offsetMs - fitted(e, s.hostMs));
  return e;
}

/** The estimate's offset at a host time. */
function fitted(e: Estimate, hostMs: number): number {
  return e.a + e.b * (hostMs - e.t0);
}

/** The median of `values` (at least one): the middle one, or the mean of the two middle ones. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((p, q) => p - q);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The nearest-rank percentile `p` (0 to 1) of `sorted` (ascending, at least one value). */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
