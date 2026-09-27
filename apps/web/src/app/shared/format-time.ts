// How times are written on screen: the timer, the solve list, the statistics and the chart.
import { DNF } from '@cubetrace/core';

/**
 * A duration as the timer shows it, with 10 ms resolution: `s.cc` under a minute (`0.00`, `12.34`)
 * and `m:ss.cc` from one minute on (`1:02.34`). Truncated to the hundredth, as WCA times are; a
 * negative duration shows as `0.00`, {@link DNF} (Infinity) as `DNF`, and anything else that is not
 * a number as `–`.
 */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) {
    return ms === DNF ? 'DNF' : '–';
  }
  const hundredths = Math.floor(Math.max(0, ms) / 10);
  const cc = String(hundredths % 100).padStart(2, '0');
  const seconds = Math.floor(hundredths / 100);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0
    ? `${String(seconds)}.${cc}`
    : `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}.${cc}`;
}

/** An average or a mean: rounded to the nearest hundredth (WCA rounds averages), then written. */
export function formatAverage(ms: number): string {
  return Number.isFinite(ms) ? formatTime(Math.round(ms / 10) * 10) : formatTime(ms);
}
