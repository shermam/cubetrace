// A solve clip's motion around the solve's own moves (docs/PLAN.md T5.3, issue #67): the host's own
// camera's clip (`RecordingService`) and a phone's (`RemoteCutsService`) are measured alike.
import { clipMotionPoints, motionPeak, moveTimes, type MotionPeak } from '@cubetrace/capture';
import type { AttemptRecord } from '@cubetrace/core';

/** A clip's motion as the capture measured it: its first frame's host time and each frame's. */
export interface SolveMotion {
  /** The clip's first frame on the host clock: its frames file's `t0HostMs`. */
  readonly t0HostMs: number;
  /** Per frame measured, its time after the first frame (from the frames' timestamps), ms. */
  readonly atMs: readonly number[];
  /** Its changed area, 0 to 1. */
  readonly changed: readonly number[];
}

/**
 * Where the motion of a solve clip's frames peaks around the attempt's solve moves (`motionPeak` on
 * the moves placed by the attempt's clock fit): the clip's `motionPeakMs` and `motionSpreadMs`; null
 * without the motion (the meter off, a phone's build before T5.3) or the record, or without a clear
 * peak (fewer than ten moves, a rise lost in the noise).
 */
export function solveMotionPeak(
  motion: SolveMotion | null,
  record: Pick<AttemptRecord, 'moves' | 'clock'> | null,
): MotionPeak | null {
  if (motion === null || record === null) {
    return null;
  }
  return motionPeak(
    clipMotionPoints(motion.t0HostMs, motion.atMs, motion.changed),
    moveTimes(record.moves, record.clock),
  );
}
