// Records for the store tests: sessions made by core's createSession and attempts made by its
// attempt machine, as the app makes them. Not exported by the package.
import type { AttemptRecord, SessionRecord } from '@cubetrace/core';
import { AttemptMachine, createSession, parseMoves } from '@cubetrace/core';

export const A = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
export const B = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';
export const C = '0b6f7c1d-2e3a-4f5b-8c9d-a1b2c3d4e5f6';

export function session(id: string, createdMs: number): SessionRecord {
  return createSession({
    host: {
      label: 'phone',
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
      platform: 'Android',
      isPhone: true,
    },
    cube: { model: 'GAN 356 i3', hardware: '1.0', firmware: '1.0', gyro: false },
    settings: { inspection15s: true, autoAdvance: true },
    appVersion: '0.1.0',
    commit: 'abc1234',
    nowMs: createdMs,
    id,
  });
}

/** An attempt of `sessionId` on `R U F`: solved, or with `dnf` a DNF one move into the solve. */
export function attempt(sessionId: string, index: number, dnf = false): AttemptRecord {
  const machine = new AttemptMachine({
    session: sessionId,
    index,
    scramble: 'R U F',
    scrambleShownMs: 0,
  });
  for (const [k, m] of parseMoves(dnf ? "R U F F'" : "R U F F' U' R'").entries()) {
    machine.onMove({ m, cubeMs: 100 * k, hostMs: 100 * k + 50.25 });
  }
  if (dnf) {
    machine.markDnf(1000);
  }
  return machine.toRecord();
}
