import type { RemoteClockFit, RemoteClockSnapshot } from '@cubetrace/core';

/**
 * From this many samples kept, the fit's estimate (their offsets' median, the drift once they span a
 * minute) places a remote camera's cuts and clips (T4.2); with fewer, the offset of the window's
 * sample of least round trip does, which had the least room for an asymmetry between the legs.
 */
export const ESTIMATE_MIN_SAMPLES = 3;

/**
 * The least margin by which a cut's window is widened on each side, in ms (T4.2). The phone's clip
 * must cover the host's window whatever the estimate's error: half a round trip at most for a
 * symmetric network, more with Wi-Fi power saving's bursts (trips of 100 to 300 ms). Half a second
 * covers that several times over for about a second more video per clip (0.5 MB at 4 Mbps); a clip
 * begins at a keyframe anyway, up to a second before its window.
 */
export const CUT_MARGIN_MS = 500;

/** The clock estimate of a remote camera, as its cuts and the conversion of its clips use it. */
export interface ClockEstimate extends RemoteClockSnapshot {
  /** The phone's time of a host time. */
  toRemoteMs(hostMs: number): number;
  /**
   * How far a cut's window is widened on each side, in ms: the 95th percentile of the kept round
   * trips plus that of the residuals, {@link CUT_MARGIN_MS} at least.
   */
  readonly marginMs: number;
}

/**
 * The estimate a cut or a conversion uses now (T4.2), whether the fit has converged or not: the fit's
 * own once it keeps {@link ESTIMATE_MIN_SAMPLES} samples, the offset of its least-round-trip sample
 * before; null with no sample at all (nothing places the phone's clock yet). Its record (`params`)
 * says which numbers it stands on, and `converged` whether the fit had converged: a fit on a busy
 * Wi-Fi may never be (the first real pairing, 2026-10-03), and nothing waits for it.
 */
export function clockEstimate(fit: RemoteClockFit): ClockEstimate | null {
  const least = fit.least;
  if (least === null) {
    return null;
  }
  const params = fit.params;
  const marginMs = Math.max(CUT_MARGIN_MS, fit.rttP95Ms + params.residualP95Ms);
  if (params.samples >= ESTIMATE_MIN_SAMPLES) {
    return {
      toHostMs: (remoteMs) => fit.toHostMs(remoteMs),
      toRemoteMs: (hostMs) => fit.toRemoteMs(hostMs),
      params,
      converged: fit.converged,
      marginMs,
    };
  }
  const offsetMs = least.offsetMs;
  return {
    toHostMs: (remoteMs) => remoteMs - offsetMs,
    toRemoteMs: (hostMs) => hostMs + offsetMs,
    params: { ...params, offsetMs, driftPpm: 0 },
    converged: false,
    marginMs,
  };
}
