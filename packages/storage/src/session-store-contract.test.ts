// The semantics of SessionStore (packages/core/src/store.ts), checked on both implementations: the
// in-memory store of core and the OPFS store over the in-memory file system of fake-opfs.ts.
import type { SessionStore } from '@cubetrace/core';
import { MemorySessionStore } from '@cubetrace/core';
import { describe, expect, it } from 'vitest';

import { FakeDirectoryHandle } from './fake-opfs';
import { OpfsSessionStore } from './opfs-session-store';
import { A, B, C, attempt, session } from './test-records';

const stores: [string, () => SessionStore][] = [
  ['MemorySessionStore', () => new MemorySessionStore()],
  ['OpfsSessionStore', () => new OpfsSessionStore(new FakeDirectoryHandle())],
];

describe.each(stores)('%s', (_name, makeStore) => {
  async function storeWith(...sessions: ReturnType<typeof session>[]): Promise<SessionStore> {
    const store = makeStore();
    for (const s of sessions) {
      await store.createSession(s);
    }
    return store;
  }

  it('lists the sessions it has, newest first', async () => {
    const store = await storeWith(session(A, 2000), session(B, 3000), session(C, 1000));
    expect((await store.listSessions()).map((s) => s.id)).toEqual([B, A, C]);
    expect(await makeStore().listSessions()).toEqual([]);
  });

  it('orders sessions created at the same time by id', async () => {
    const store = await storeWith(session(B, 1000), session(A, 1000));
    expect((await store.listSessions()).map((s) => s.id)).toEqual([A, B]);
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
    expect(loaded[2].result.status).toBe('dnf');
    expect(await store.loadAttempts(B)).toEqual([attempt(B, 1)]);
  });

  it('sorts attempts by index, not by name, past 9999', async () => {
    const store = await storeWith(session(A, 1000));
    for (const index of [10000, 2, 9999, 10]) {
      await store.saveAttempt(attempt(A, index));
    }
    expect((await store.loadAttempts(A)).map((a) => a.index)).toEqual([2, 10, 9999, 10000]);
  });

  it('rejects the attempts of a session it does not have', async () => {
    const store = await storeWith(session(A, 1000));
    await expect(store.saveAttempt(attempt(B, 1))).rejects.toThrow(/No session/);
    await expect(store.loadAttempts(B)).rejects.toThrow(/No session/);
    await expect(store.exportSession(B)).rejects.toThrow(/No session/);
    await expect(store.deleteAttempt(B, 1)).rejects.toThrow(/No session/);
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

  it('deletes one attempt of a session; an unknown index is already gone', async () => {
    const store = await storeWith(session(A, 1000), session(B, 2000));
    await store.saveAttempt(attempt(A, 1));
    await store.saveAttempt(attempt(A, 2, true));
    await store.saveAttempt(attempt(B, 2));
    await store.deleteAttempt(A, 2);
    await store.deleteAttempt(A, 7);
    expect(await store.loadAttempts(A)).toEqual([attempt(A, 1)]);
    expect(await store.loadAttempts(B)).toEqual([attempt(B, 2)]);
    // The index is free again: "Delete last" reuses the number.
    await store.saveAttempt(attempt(A, 2));
    expect((await store.loadAttempts(A)).map((a) => a.index)).toEqual([1, 2]);
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

  it('copies a record when the call is made, before its promise settles', async () => {
    const store = await storeWith(session(A, 1000));
    const a = attempt(A, 1);
    const saving = store.saveAttempt(a);
    a.result.timeMs = 1;
    await saving;
    expect(await store.loadAttempts(A)).toEqual([attempt(A, 1)]);
  });
});
