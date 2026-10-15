// A clip's time against the host clock (docs/DATA-MODEL.md §7, §9): a frame's host time is when it
// reached the browser, later than the light by the camera's lag, which the sync check measures
// (`syncResidualMs`); the clip viewer (T3.8) places the moves and the gyro samples with it.
import type { VideoClip } from './attempt';
import type { CameraClock } from './session';

/**
 * How far the camera's picture lags the cube in `clip`, in ms: its `syncResidualMs`, measured by
 * the sync check (docs/DATA-MODEL.md §6, §7), 0 when none was made. A frame whose host time is `t`
 * shows the world as it was at `t − lag`, so a move made at host time `m` is in the picture at
 * `m + lag`.
 */
export function clipLagMs(clip: VideoClip): number {
  return clip.syncResidualMs ?? 0;
}

/** The host time the picture at `seconds` into `clip` shows: `firstFrameHostMs + seconds × 1000 − lag`. */
export function clipHostMs(clip: VideoClip, seconds: number): number {
  return clip.firstFrameHostMs + seconds * 1000 - clipLagMs(clip);
}

/** Where `clip` shows the host time `hostMs`, in seconds from its first frame: the lag later. */
export function clipSeconds(clip: VideoClip, hostMs: number): number {
  return (hostMs + clipLagMs(clip) - clip.firstFrameHostMs) / 1000;
}

/**
 * The camera's lag behind the cube from a clip's own moves (docs/PLAN.md T5.3, docs/DATA-MODEL.md §7:
 * `motionLagMs`): the camera's sync check's lag (`offsetMs` of `check`, its entry in `clock.cameras`)
 * plus how far the clip's motion peak around its moves (`motionPeakMs`) sits from where the check's
 * own motion peaked around its turns (`motionPeakAtCheckMs`), ms to 0.1. The peak sits a little after
 * the camera's lag, by a constant of the camera and the hands, which the difference cancels. Null
 * without a peak, without a check (none, or a remote camera's entry before its check:
 * `clapperboardSamples` 0), or with a check that kept no peak of its own (fewer than four single
 * turns among its frames, a record written before T5.3).
 */
export function anchoredMotionLag(
  motionPeakMs: number | null | undefined,
  check: CameraClock | undefined,
): number | null {
  const anchor = check?.motionPeakAtCheckMs;
  if (
    check === undefined ||
    check.clapperboardSamples === 0 ||
    anchor === undefined ||
    anchor === null ||
    motionPeakMs === undefined ||
    motionPeakMs === null
  ) {
    return null;
  }
  return Math.round((check.offsetMs + motionPeakMs - anchor) * 10) / 10 + 0;
}
