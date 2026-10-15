import type { AttemptRecord } from '@cubetrace/core';

import {
  MOTION_LAG_LIMIT_MS,
  latencyWords,
  motionLagOff,
  motionLagWords,
  signedMs,
  solveClipOf,
} from './latency-words';

// The words of a camera's capture latency and motion lag on the Timer page's lines (docs/PLAN.md
// T5.3), the host's own and a phone's alike.

describe('the latency words', () => {
  it('says a drift with its sign, whole ms', () => {
    expect(signedMs(75.4)).toBe('+75 ms');
    expect(signedMs(-40.6)).toBe('-41 ms');
    expect(signedMs(0.2)).toBe('±0 ms');
    expect(latencyWords(75.4)).toBe('latency +75 ms');
  });

  it("says a solve clip's motion lag when it sits more than 30 ms from its check's", () => {
    expect(MOTION_LAG_LIMIT_MS).toBe(30);
    // Issue #67's step: 133 against 58.
    const off = motionLagOff({ motionLagMs: 133.4, syncResidualMs: 58.4 });
    expect(off).toEqual({ lagMs: 133, checkMs: 58 });
    expect(off === null ? null : motionLagWords(off)).toBe('motion lag 133 ms (check 58)');
    expect(motionLagOff({ motionLagMs: 30, syncResidualMs: 65 })).toEqual({
      lagMs: 30,
      checkMs: 65,
    });
    // Within 30 ms, or unknown: nothing to say.
    expect(motionLagOff({ motionLagMs: 88.4, syncResidualMs: 58.4 })).toBeNull();
    expect(motionLagOff({ motionLagMs: null, syncResidualMs: 58.4 })).toBeNull();
    expect(motionLagOff({ syncResidualMs: 58.4 })).toBeNull();
    expect(motionLagOff({ motionLagMs: 140, syncResidualMs: null })).toBeNull();
    expect(motionLagOff(undefined)).toBeNull();
  });

  it("finds a camera's solve clip in an attempt's record", () => {
    const clip = (camera: string, segment: 'scramble' | 'solve') =>
      ({ camera, segment }) as AttemptRecord['video'][number];
    const record = {
      video: [clip('laptop', 'scramble'), clip('laptop', 'solve'), clip('phone-rear', 'solve')],
    };
    expect(solveClipOf(record, 'laptop')).toBe(record.video[1]);
    expect(solveClipOf(record, 'phone-rear')).toBe(record.video[2]);
    expect(solveClipOf(record, 'laptop-2')).toBeUndefined();
    expect(solveClipOf(record, null)).toBeUndefined();
    expect(solveClipOf(null, 'laptop')).toBeUndefined();
  });
});
