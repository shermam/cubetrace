// The words of a camera's capture latency and motion lag on the Timer page's status lines (docs/PLAN.md
// T5.3, issue #67): the host's own camera's line under its preview (`CameraPreview`) and a phone's
// under its picture (`remoteStatusLine`) say them alike, from one pure module.
import type { AttemptRecord, VideoClip } from '@cubetrace/core';

/**
 * A solve clip's lag from its own moves (`motionLagMs`) this far from its sync check's
 * (`syncResidualMs`), ms, or farther, is said on the camera's line: the step of 2026-10-09 was 75 ms.
 */
export const MOTION_LAG_LIMIT_MS = 30;

/** `+75 ms`, `-40 ms`: a drift of the capture latency, whole ms, with its sign. */
export function signedMs(deltaMs: number): string {
  const whole = Math.round(deltaMs);
  return `${whole > 0 ? '+' : whole < 0 ? '-' : '±'}${String(Math.abs(whole))} ms`;
}

/** "latency +75 ms": the capture latency's drift from the camera's sync check (amber on the line). */
export function latencyWords(deltaMs: number): string {
  return `latency ${signedMs(deltaMs)}`;
}

/** A camera's motion lag in its last solve clip, and its sync check's lag, whole ms. */
export interface MotionLagOff {
  readonly lagMs: number;
  readonly checkMs: number;
}

/**
 * The motion lag of `clip` and its check's lag, when they are {@link MOTION_LAG_LIMIT_MS} or more
 * apart; null otherwise, and when either is unknown (no peak, no check, a clip before T5.3).
 */
export function motionLagOff(
  clip: Pick<VideoClip, 'motionLagMs' | 'syncResidualMs'> | undefined,
): MotionLagOff | null {
  const lag = clip?.motionLagMs;
  const check = clip?.syncResidualMs;
  if (lag === undefined || lag === null || check === undefined || check === null) {
    return null;
  }
  // To a tenth of a ms, as the record keeps them: 30.0 apart is not more than 30.
  const apart = Math.round(Math.abs(lag - check) * 10) / 10;
  return apart > MOTION_LAG_LIMIT_MS
    ? { lagMs: Math.round(lag), checkMs: Math.round(check) }
    : null;
}

/** "motion lag 133 ms (check 58)" (amber on the line). */
export function motionLagWords(off: MotionLagOff): string {
  return `motion lag ${String(off.lagMs)} ms (check ${String(off.checkMs)})`;
}

/** The solve clip of the camera labelled `label` in an attempt's record; undefined without one. */
export function solveClipOf(
  record: Pick<AttemptRecord, 'video'> | null,
  label: string | null,
): VideoClip | undefined {
  return label === null
    ? undefined
    : record?.video.find((clip) => clip.camera === label && clip.segment === 'solve');
}
