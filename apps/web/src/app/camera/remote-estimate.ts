import { RemoteClockLine, type RemoteClockFit, type RemoteClockSnapshot } from '@cubetrace/core';

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

/**
 * The clock estimate of a remote camera, as its cuts, the conversion of its clips and its sync check
 * use it: frozen when it was taken (T4.3), so that a clip converts with the estimate of its cut,
 * whatever the fit became before its files came.
 */
export interface ClockEstimate extends RemoteClockSnapshot {
  /** The estimate's line, frozen: its offset and drift at the host time it was taken. */
  readonly line: RemoteClockLine;
  /** The phone's time of a host time. */
  toRemoteMs(hostMs: number): number;
  /**
   * How far a cut's window is widened on each side, in ms: the 95th percentile of the kept round
   * trips plus that of the residuals, {@link CUT_MARGIN_MS} at least.
   */
  readonly marginMs: number;
}

/**
 * The estimate a cut, a conversion or a sync check uses now (T4.2), whether the fit has converged or
 * not, frozen (T4.3: `RemoteClockFit.line`): the fit's own once it keeps {@link ESTIMATE_MIN_SAMPLES}
 * samples (its line, the drift once the samples span a minute), the offset of its least-round-trip
 * sample before; null with no sample at all (nothing places the phone's clock yet). Its record
 * (`params`) says which numbers it stands on, and `converged` whether the fit had converged: a fit on
 * a busy Wi-Fi may never be (the first real pairing, 2026-10-03), and nothing waits for it.
 */
export function clockEstimate(fit: RemoteClockFit): ClockEstimate | null {
  const least = fit.least;
  if (least === null) {
    return null;
  }
  const params = fit.params;
  const marginMs = Math.max(CUT_MARGIN_MS, fit.rttP95Ms + params.residualP95Ms);
  if (params.samples >= ESTIMATE_MIN_SAMPLES) {
    return frozen(fit.line(), params, fit.converged, marginMs);
  }
  return frozen(
    new RemoteClockLine(least.offsetMs, 0, least.hostMs),
    { ...params, offsetMs: least.offsetMs, driftPpm: 0 },
    false,
    marginMs,
  );
}

function frozen(
  line: RemoteClockLine,
  params: ClockEstimate['params'],
  converged: boolean,
  marginMs: number,
): ClockEstimate {
  return {
    line,
    toHostMs: (remoteMs) => line.toHostMs(remoteMs),
    toRemoteMs: (hostMs) => line.toRemoteMs(hostMs),
    params,
    converged,
    marginMs,
  };
}
