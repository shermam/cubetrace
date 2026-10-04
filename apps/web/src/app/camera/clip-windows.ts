import type { VideoSegment } from '@cubetrace/core';

import type { AttemptMilestone } from '../session/session-service';

/** The scramble clip begins this long before the first scramble turn (docs/PLAN.md, T2.4). */
export const SCRAMBLE_LEAD_MS = 2000;

/**
 * The scramble clip begins at most this long before the scramble is done (docs/PLAN.md, T2.9). A
 * scramble takes 10 to 15 s, and the turns that matter are its last ones before `scrambleDone`: a
 * pause inside it (a sync check that failed, a break) is not worth minutes of video, which the 90 s
 * in memory would not hold anyway.
 */
export const SCRAMBLE_CLIP_MAX_MS = 60_000;

/** The solve clip begins this long before the first solve turn. */
export const SOLVE_LEAD_MS = 3000;

/** Both clips end this long after their segment: the scramble done, the cube solved or the DNF. */
export const CLIP_TAIL_MS = 1000;

/** The window of a clip of an attempt, on the host clock. */
export interface ClipWindow {
  readonly segment: VideoSegment;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The clip a milestone of an attempt asks for, from every camera of the session: the host's own
 * (`RecordingService`, T2.4) and the remote ones (`RemoteCutsService`, T4.2), so that all of an
 * attempt's clips cover the same window. Once the scramble is done (`armed`), the scramble clip
 * `[max(scrambleStart − 2 s, scrambleDone − 60 s), scrambleDone + 1 s]`; once the attempt ended
 * (solved or a DNF), the solve clip `[solveStart − 3 s, end + 1 s]`, none when the solve never
 * started; nothing for an attempt that went without a record (`dropped`).
 */
export function clipWindow(milestone: AttemptMilestone): ClipWindow | null {
  switch (milestone.type) {
    case 'armed':
      return {
        segment: 'scramble',
        startMs: Math.max(
          milestone.scrambleStart - SCRAMBLE_LEAD_MS,
          milestone.scrambleDone - SCRAMBLE_CLIP_MAX_MS,
        ),
        endMs: milestone.scrambleDone + CLIP_TAIL_MS,
      };
    case 'ended': {
      const solveStart = milestone.record.events.solveStart;
      return solveStart === null
        ? null
        : {
            segment: 'solve',
            startMs: solveStart - SOLVE_LEAD_MS,
            endMs: milestone.endMs + CLIP_TAIL_MS,
          };
    }
    case 'dropped':
      return null;
  }
}
