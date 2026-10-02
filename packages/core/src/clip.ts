// A clip's time against the host clock (docs/DATA-MODEL.md §7, §9): a frame's host time is when it
// reached the browser, later than the light by the camera's lag, which the sync check measures
// (`syncResidualMs`); the clip viewer (T3.8) places the moves and the gyro samples with it.
import type { VideoClip } from './attempt';

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
