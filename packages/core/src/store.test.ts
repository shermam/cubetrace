import { describe, expect, it } from 'vitest';

import type { AttemptRecord, SessionRecord } from './index';
import { AttemptMachine, MemorySessionStore, createSession, parseMoves } from './index';

const A = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const B = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';
const C = '0b6f7c1d-2e3a-4f5b-8c9d-a1b2c3d4e5f6';

function session(id: string, createdMs: number): SessionRecord {
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

/** An attempt of `sessionId` on `R U F`, solved, or a DNF with `dnf`. */
function attempt(sessionId: string, index: number, dnf = false): AttemptRecord {
  const machine = new AttemptMachine({
    session: sessionId,
    index,
    scramble: 'R U F',
    scrambleShownMs: 0,
  });
  for (const [k, m] of parseMoves("R U F F' U' R'").entries()) {
    machine.onMove({ m, cubeMs: 100 * k, hostMs: 100 * k + 50 });
  }
  if (dnf) {
    machine.markDnf(1000);
  }
  return machine.toRecord();
}

async function storeWith(...sessions: SessionRecord[]): Promise<MemorySessionStore> {
  const store = new MemorySessionStore();
  for (const s of sessions) {
    await store.createSession(s);
  }
  return store;
}

describe('MemorySessionStore', () => {
  it('lists the sessions it has, newest first', async () => {
    const store = await storeWith(session(A, 2000), session(B, 3000), session(C, 1000));
    expect((await store.listSessions()).map((s) => s.id)).toEqual([B, A, C]);
    expect(await new MemorySessionStore().listSessions()).toEqual([]);
  });

  it('creates a session once, and saves only a session it has', async () => {
    const store = await storeWith(session(A, 1000));
    await expect(store.createSession(session(A, 5000))).rejects.toThrow(/exists/);
    await expect(store.saveSession(session(B, 1000))).rejects.toThrow(/No session/);
    const saved = {
      ...session(A, 1000),
      notes: 'sofa',
      summary: { attempts: 1, solved: 1, dnf: 0 },
    };
    await store.saveSession(saved);
    expect(await store.listSessions()).toEqual([saved]);
  });

  it("keeps a session's attempts by index: saved again, an attempt is replaced", async () => {
    const store = await storeWith(session(A, 1000), session(B, 2000));
    await store.saveAttempt(attempt(A, 3));
    await store.saveAttempt(attempt(A, 1));
    await store.saveAttempt(attempt(B, 1));
    await store.saveAttempt(attempt(A, 2));
    const replaced = attempt(A, 3, true);
    await store.saveAttempt(replaced);
    const loaded = await store.loadAttempts(A);
    expect(loaded.map((a) => a.index)).toEqual([1, 2, 3]);
    expect(loaded[2]).toEqual(replaced);
    expect(await store.loadAttempts(B)).toEqual([attempt(B, 1)]);
  });

  it('rejects the attempts of a session it does not have', async () => {
    const store = await storeWith(session(A, 1000));
    await expect(store.saveAttempt(attempt(B, 1))).rejects.toThrow(/No session/);
    await expect(store.loadAttempts(B)).rejects.toThrow(/No session/);
    await expect(store.exportSession(B)).rejects.toThrow(/No session/);
  });

  it('deletes a session with its attempts; an unknown one is already gone', async () => {
    const store = await storeWith(session(A, 1000), session(B, 2000));
    await store.saveAttempt(attempt(A, 1));
    await store.saveAttempt(attempt(B, 1));
    await store.deleteSession(A);
    await store.deleteSession(C);
    expect((await store.listSessions()).map((s) => s.id)).toEqual([B]);
    await expect(store.loadAttempts(A)).rejects.toThrow(/No session/);
    // The same id again starts empty.
    await store.createSession(session(A, 3000));
    expect(await store.loadAttempts(A)).toEqual([]);
    expect(await store.loadAttempts(B)).toHaveLength(1);
  });

  it('exports a session with its attempts sorted by index', async () => {
    const s = session(A, 1000);
    const store = await storeWith(s);
    await store.saveAttempt(attempt(A, 2, true));
    await store.saveAttempt(attempt(A, 1));
    const exported = await store.exportSession(A);
    expect(exported).toEqual({ session: s, attempts: [attempt(A, 1), attempt(A, 2, true)] });
  });

  it('keeps copies: records changed after saving or loading leave it as it was', async () => {
    const s = session(A, 1000);
    const store = await storeWith(s);
    const a = attempt(A, 1);
    await store.saveAttempt(a);
    s.notes = 'changed';
    a.result.timeMs = 1;
    const [loaded] = await store.loadAttempts(A);
    expect(loaded).toEqual(attempt(A, 1));
    loaded.moves.length = 0;
    const listed = await store.listSessions();
    listed[0].summary.attempts = 99;
    expect(await store.exportSession(A)).toEqual({
      session: session(A, 1000),
      attempts: [attempt(A, 1)],
    });
  });
});
