// Records for unit tests, made by @cubetrace/core's attempt machine as the app makes them. Nothing
// in the app imports this file, so it is not in the bundle.
import {
  AttemptMachine,
  createSession,
  parseMoves,
  type AttemptRecord,
  type SessionRecord,
} from '@cubetrace/core';

export const SESSION_A = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
export const SESSION_B = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';

/** The scramble of the test attempts, and the solution that undoes it. */
export const TEST_SCRAMBLE = 'R U F';
export const TEST_SOLUTION = "F' U' R'";

export function testSession(id = SESSION_A, createdMs = 1_790_000_000_000): SessionRecord {
  return createSession({
    host: { label: 'Linux laptop', userAgent: 'test', platform: 'Linux', isPhone: false },
    cube: { model: 'Fake cube', hardware: 'simulated', firmware: 'simulated', gyro: false },
    settings: { inspection15s: false, autoAdvance: true },
    appVersion: '0.0.0',
    commit: 'abc1234',
    nowMs: createdMs,
    id,
  });
}

/**
 * Attempt `index` of `session` on {@link TEST_SCRAMBLE}: solved in `timeMs` (the solve's three
 * moves at its start, middle and end), or with `timeMs` null a DNF after the first solve move.
 * `corrected` makes the scramble go off its path (`D D'`) and back.
 */
export function testAttempt(
  index: number,
  timeMs: number | null,
  opts: { session?: string; corrected?: boolean } = {},
): AttemptRecord {
  const machine = new AttemptMachine({
    session: opts.session ?? SESSION_A,
    index,
    scramble: TEST_SCRAMBLE,
    scrambleShownMs: 0,
  });
  const scramble = opts.corrected === true ? "R U D D' F" : TEST_SCRAMBLE;
  let t = 100;
  for (const m of parseMoves(scramble)) {
    machine.onMove({ m, cubeMs: t, hostMs: t });
    t += 100;
  }
  const solution = parseMoves(TEST_SOLUTION);
  const start = t + 1000;
  const times = timeMs === null ? [start] : [start, start + timeMs / 2, start + timeMs];
  for (const [k, ms] of times.entries()) {
    machine.onMove({ m: solution[k], cubeMs: ms, hostMs: ms });
  }
  if (timeMs === null) {
    machine.markDnf(start + 500);
  }
  return machine.toRecord();
}
