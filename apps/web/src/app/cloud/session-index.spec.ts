import { TestBed } from '@angular/core/testing';
import {
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  MemorySessionStore,
  cloudSession,
  type SessionRecord,
} from '@cubetrace/core';
import { recordJson } from '@cubetrace/storage';
import { Ajv2020 } from 'ajv/dist/2020';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend, authError } from '../auth/fake-account';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage, FakePerformance, settle } from '../device/fake-browser';
import { ATTEMPT_FILES, type AttemptFiles } from '../session/attempt-files';
import { SESSION_STORAGE } from '../session/session-storage';
import { SESSION_A, SESSION_B, testAttempt, testSession } from '../session/session-testing';
import { attemptDocument, attemptWithClips, realSession, sessionDocument } from './cloud-testing';
import { CATCH_UP_DOCUMENTS, SESSION_INDEX_KEY, SessionIndexService } from './session-index';

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isSessionDocument = ajv.compile(CLOUD_SESSION_SCHEMA);
const isAttemptDocument = ajv.compile(CLOUD_ATTEMPT_SCHEMA);

const SESSION_C = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const DEMO = '0d0d0d0d-0000-4000-8000-000000000001';

/** The size of a frames file on this device, as the fake file system has them. */
const FRAMES_BYTES = 2_345;

describe('SessionIndexService', () => {
  let storage: FakeLocalStorage;
  let clock: FakePerformance;
  let backend: FakeAccountBackend;
  let store: MemorySessionStore;
  let notes: { sessionId: string; line: string }[];

  /** A page load on this device: the services anew, the same storage, store and backend. */
  function load(): {
    index: SessionIndexService;
    auth: AuthService;
    tracked: ReturnType<SessionIndexService['track']>;
  } {
    backend.newPage();
    TestBed.resetTestingModule();
    const globals: BrowserGlobals = {
      navigator: { userAgent: 'test' },
      localStorage: storage,
      performance: clock,
    };
    const files: AttemptFiles = {
      read: (_sessionId, _index, name) =>
        name.endsWith('.frames.json')
          ? Promise.resolve(new Blob(['x'.repeat(FRAMES_BYTES)]))
          : Promise.reject(new DOMException('No such file.', 'NotFoundError')),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        { provide: SESSION_STORAGE, useValue: { store, kind: 'opfs' } },
        { provide: ATTEMPT_FILES, useValue: files },
      ],
    });
    const index = TestBed.inject(SessionIndexService);
    // As SessionService.addNote: the line in the session's notes, saved through the tracked store.
    const tracked = index.track(store, async (sessionId, line) => {
      notes.push({ sessionId, line });
      const { session } = await store.exportSession(sessionId);
      await tracked.saveSession({ ...session, notes: `${session.notes}\n${line}`.trim() });
    });
    return { index, auth: TestBed.inject(AuthService), tracked };
  }

  /** Lets the account's report, the index's effect, its operations and the server's answers run. */
  async function settleIndex(index: SessionIndexService): Promise<void> {
    for (let k = 0; k < 3; k++) {
      await settle();
      TestBed.tick();
      await index.whenIdle();
      await settle();
    }
  }

  async function signIn(auth: AuthService, index: SessionIndexService): Promise<void> {
    await auth.signIn();
    await settleIndex(index);
    expect(auth.cloud()?.uid).toBe(ADA.uid);
  }

  /** A demo session: the fake cube's. */
  function demoSession(): SessionRecord {
    return testSession(DEMO, 1_790_000_050_000);
  }

  function kept(): Record<string, { sessions: string[]; lastSyncMs: number | null }> {
    return JSON.parse(storage.getItem(SESSION_INDEX_KEY) ?? '{}') as Record<
      string,
      { sessions: string[]; lastSyncMs: number | null }
    >;
  }

  beforeEach(() => {
    storage = new FakeLocalStorage();
    clock = new FakePerformance();
    backend = new FakeAccountBackend();
    store = new MemorySessionStore();
    notes = [];
  });

  it('writes a session and its attempts as they are saved, signed in: the session with its owner, the attempt without its moves, with its device and its files pending', async () => {
    const { index, auth, tracked } = load();
    await signIn(auth, index);
    const session = realSession();
    const attempt = attemptWithClips(1);

    await tracked.createSession(session);
    await tracked.saveAttempt(attempt);
    const saved: SessionRecord = { ...session, summary: { attempts: 1, solved: 1, dnf: 0 } };
    await tracked.saveSession(saved);
    await settleIndex(index);

    expect(backend.indexWrites).toEqual([
      `sessions/${SESSION_A}`,
      `sessions/${SESSION_A}/attempts/0001`,
      `sessions/${SESSION_A}`,
    ]);
    const sessionDoc = backend.sessionDocument(SESSION_A);
    expect(sessionDoc).toEqual({ ...saved, owner: ADA.uid });
    expect(isSessionDocument(sessionDoc), JSON.stringify(isSessionDocument.errors)).toBe(true);
    const [attemptDoc] = backend.attemptDocuments(SESSION_A);
    expect(isAttemptDocument(attemptDoc), JSON.stringify(isAttemptDocument.errors)).toBe(true);
    expect('moves' in attemptDoc).toBe(false);
    expect(attemptDoc).toMatchObject({
      schema: 2,
      session: SESSION_A,
      index: 1,
      owner: ADA.uid,
      result: attempt.result,
      phases: attempt.phases,
      video: attempt.video,
      device: { host: 'Linux laptop', cameras: ['laptop'] },
    });
    expect(attemptDoc.upload).toEqual({
      state: 'pending',
      files: {
        'attempt.json': {
          bytes: new TextEncoder().encode(recordJson(attempt)).byteLength,
          doneMs: null,
        },
        'laptop.scramble.mp4': { bytes: 1_200_000, doneMs: null },
        'laptop.scramble.frames.json': { bytes: FRAMES_BYTES, doneMs: null },
        'laptop.solve.mp4': { bytes: 4_100_000, doneMs: null },
        'laptop.solve.frames.json': { bytes: FRAMES_BYTES, doneMs: null },
      },
    });
    expect(index.written()).toEqual(new Set([SESSION_A]));
    expect(index.unconfirmed()).toBe(0);
    expect(index.lastSync()).toBe(clock.hostMs);
    expect(index.failures().size).toBe(0);
    // The attempt's document was created with its upload.
    expect(backend.uploadWrites).toEqual([`sessions/${SESSION_A}/attempts/0001`]);
    // Created signed in, the session is all in the index: the next start has nothing to catch up.
    expect(kept()[ADA.uid].sessions).toEqual([SESSION_A]);
    expect(notes).toEqual([]);
  });

  it('writes an attempt again when a clip is attached, without its upload, which the functions keep; and deletes it with Delete last', async () => {
    const { index, auth, tracked } = load();
    await signIn(auth, index);
    const session = realSession();
    await tracked.createSession(session);
    const bare = testAttempt(1, 10_000);
    await tracked.saveAttempt(bare);
    await settleIndex(index);
    const path = `sessions/${SESSION_A}/attempts/0001`;
    expect(backend.uploadWrites).toEqual([path]);
    // The upload's functions sign the attempt.json meanwhile (T3.2).
    const signed = {
      state: 'uploading' as const,
      files: { 'attempt.json': { bytes: 4_321, doneMs: null } },
    };
    backend.serverSetsUpload(SESSION_A, 1, signed);

    await tracked.saveAttempt({ ...bare, video: attemptWithClips(1).video.slice(0, 1) });
    await settleIndex(index);
    const [attemptDoc] = backend.attemptDocuments(SESSION_A);
    expect(attemptDoc.video.map((clip) => clip.file)).toEqual(['laptop.scramble.mp4']);
    expect(attemptDoc.upload).toEqual(signed);
    expect(backend.uploadWrites).toEqual([path]);
    expect(index.failures().size).toBe(0);

    await tracked.deleteAttempt(SESSION_A, 1);
    await settleIndex(index);
    expect(backend.attemptDocuments(SESSION_A)).toEqual([]);
    expect(backend.indexWrites.at(-1)).toBe(`delete ${path}`);
    // An attempt of the same index after it is a new document, created with its upload.
    await tracked.saveAttempt(testAttempt(1, 12_000));
    await settleIndex(index);
    expect(backend.uploadWrites).toEqual([path, path]);
    expect(backend.attemptDocuments(SESSION_A)[0].upload.state).toBe('pending');
  });

  it('never writes a demo session, whose cube is simulated', async () => {
    const { index, auth, tracked } = load();
    await signIn(auth, index);
    await tracked.createSession(demoSession());
    await tracked.saveAttempt(testAttempt(1, 10_000, { session: DEMO }));
    await tracked.saveSession({ ...demoSession(), notes: 'x' });
    await tracked.deleteAttempt(DEMO, 1);
    await settleIndex(index);

    expect(backend.indexWrites).toEqual([]);
    expect(index.written().size).toBe(0);
  });

  it('writes nothing while signed out, keeps nothing on a device never signed in, and the store never waits for the index', async () => {
    const { index, tracked } = load();
    await tracked.createSession(realSession());
    await tracked.saveAttempt(attemptWithClips(1));
    await settleIndex(index);

    expect(backend.loads).toBe(0);
    expect(backend.indexWrites).toEqual([]);
    expect((await store.exportSession(SESSION_A)).attempts).toHaveLength(1);
    expect(storage.getItem(SESSION_INDEX_KEY)).toBeNull();
  });

  it('does not wait for the server: offline, the writes wait and are confirmed when the network is back', async () => {
    const { index, auth, tracked } = load();
    await signIn(auth, index);
    backend.online = false;

    await tracked.createSession(realSession());
    await tracked.saveAttempt(attemptWithClips(1));
    await settleIndex(index);
    // Firestore applied them to its cache at once; the server has not confirmed them.
    expect(backend.attemptDocuments(SESSION_A)).toHaveLength(1);
    expect(index.unconfirmed()).toBe(2);
    expect(index.lastSync()).toBeNull();
    const cached = await index.cloudSessions(10);
    expect(cached?.fromCache).toBe(true);
    expect(cached?.entries.map((entry) => [entry.id, entry.pending])).toEqual([[SESSION_A, true]]);

    clock.advance(60_000);
    backend.goOnline();
    await settleIndex(index);
    expect(index.unconfirmed()).toBe(0);
    expect(index.lastSync()).toBe(clock.hostMs);
    expect(kept()[ADA.uid].lastSyncMs).toBe(clock.hostMs);
    expect(index.failures().size).toBe(0);
  });

  it('says a refusal once per session: in failures, in the console and in the session’s notes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { index, auth, tracked } = load();
    await signIn(auth, index);
    backend.indexError = Object.assign(new Error('Missing or insufficient permissions.'), {
      code: 'permission-denied',
    });

    await tracked.createSession(realSession());
    await tracked.saveAttempt(attemptWithClips(1));
    await tracked.saveAttempt(attemptWithClips(2));
    await settleIndex(index);

    const message = 'the session could not be indexed: Missing or insufficient permissions.';
    expect(index.failures()).toEqual(new Map([[SESSION_A, message]]));
    expect(notes).toEqual([{ sessionId: SESSION_A, line: `cloud: ${message}` }]);
    expect(warn.mock.calls.map(([text]) => String(text))).toEqual([`cubetrace: cloud: ${message}`]);
    expect(index.unconfirmed()).toBe(0);

    expect((await store.exportSession(SESSION_A)).session.notes).toBe(`cloud: ${message}`);
    // Refused, the session is not in the index: the next start tries it again, says it again, and
    // does not note it twice.
    expect(kept()[ADA.uid].sessions).toEqual([]);
    const reload = load();
    await settleIndex(reload.index);
    expect(reload.index.failures().get(SESSION_A)).toBe(message);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(notes).toHaveLength(1);
    expect((await store.exportSession(SESSION_A)).session.notes).toBe(`cloud: ${message}`);
    // Allowed again (the rules fixed), its next save writes the session with its attempts.
    backend.indexError = null;
    const reloaded = load();
    await settleIndex(reloaded.index);
    expect(reloaded.index.failures().size).toBe(0);
    expect(backend.sessionDocument(SESSION_A)?.notes).toBe(`cloud: ${message}`);
    expect(backend.attemptDocuments(SESSION_A).map((doc) => doc.index)).toEqual([1, 2]);
    warn.mockRestore();
  });

  it('catches up on sign-in: the sessions saved signed out, the oldest first, each with its attempts in one batch, never a demo, and once', async () => {
    const older = realSession(SESSION_A, 1_790_000_000_000);
    const newer = realSession(SESSION_B, 1_790_000_100_000, 'ThinkPhone');
    for (const record of [older, newer, demoSession()]) {
      await store.createSession(record);
    }
    await store.saveAttempt(attemptWithClips(1, 10_000, SESSION_A));
    await store.saveAttempt(attemptWithClips(2, null, SESSION_A));
    await store.saveAttempt(testAttempt(1, 12_000, { session: SESSION_B }));
    await store.saveAttempt(testAttempt(1, 9_000, { session: DEMO }));

    const { index, auth } = load();
    await signIn(auth, index);

    expect(backend.indexWrites).toEqual([
      `sessions/${SESSION_A}`,
      `sessions/${SESSION_A}/attempts/0001`,
      `sessions/${SESSION_A}/attempts/0002`,
      `sessions/${SESSION_B}`,
      `sessions/${SESSION_B}/attempts/0001`,
    ]);
    expect(backend.batches).toBe(2);
    expect(backend.sessionDocument(SESSION_B)).toEqual(cloudSession(newer, ADA.uid));
    expect(backend.attemptDocuments(SESSION_B)[0].device.host).toBe('ThinkPhone');
    expect(backend.sessionDocument(DEMO)).toBeUndefined();
    expect(index.written()).toEqual(new Set([SESSION_A, SESSION_B]));
    expect(kept()[ADA.uid].sessions).toEqual([SESSION_A, SESSION_B]);

    // The next start signed in has nothing to catch up.
    const reload = load();
    await settleIndex(reload.index);
    expect(reload.auth.cloud()?.uid).toBe(ADA.uid);
    expect(backend.indexWrites).toHaveLength(5);
  });

  it('writes a session changed while signed out whole at the next sign-in, leaving the upload of the attempts already there', async () => {
    const { index, auth, tracked } = load();
    await signIn(auth, index);
    await tracked.createSession(realSession());
    await tracked.saveAttempt(attemptWithClips(1));
    await settleIndex(index);
    expect(backend.indexWrites).toHaveLength(2);
    const done = {
      state: 'done' as const,
      files: { 'attempt.json': { bytes: 6_000, doneMs: 1_790_000_900_000 } },
    };
    backend.serverSetsUpload(SESSION_A, 1, done);

    await auth.signOut();
    await settleIndex(index);
    await tracked.saveAttempt(attemptWithClips(2));
    await settleIndex(index);
    expect(backend.indexWrites).toHaveLength(2);
    expect(kept()[ADA.uid].sessions).toEqual([]);

    await signIn(auth, index);
    expect(backend.indexWrites.slice(2)).toEqual([
      `sessions/${SESSION_A}`,
      `sessions/${SESSION_A}/attempts/0001`,
      `sessions/${SESSION_A}/attempts/0002`,
    ]);
    expect(backend.reads).toContain(`attempts ${SESSION_A} ${ADA.uid}`);
    // Attempt 1 was there: written again without its upload, which stays the functions'. Attempt 2
    // is new: created with its own.
    expect(backend.uploadWrites).toEqual([
      `sessions/${SESSION_A}/attempts/0001`,
      `sessions/${SESSION_A}/attempts/0002`,
    ]);
    const [first, second] = backend.attemptDocuments(SESSION_A);
    expect(first.upload).toEqual(done);
    expect(second.upload.state).toBe('pending');
    expect(index.failures().size).toBe(0);
  });

  it('leaves a session for the next catch-up when its attempts in the index cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.createSession(realSession());
    await store.saveAttempt(attemptWithClips(1));
    backend.readError = new Error('Failed to get documents because the client is offline.');
    const { index, auth } = load();
    await signIn(auth, index);
    expect(backend.indexWrites).toEqual([]);
    // Nothing written, nothing kept: the session is not in the index.
    expect(storage.getItem(SESSION_INDEX_KEY)).toBeNull();
    expect(warn.mock.calls.map(([text]) => String(text))).toEqual([
      `cubetrace: cloud: the attempts of session ${SESSION_A} in the index could not be read; it waits for the next catch-up: Failed to get documents because the client is offline.`,
    ]);

    backend.readError = null;
    const reload = load();
    await settleIndex(reload.index);
    expect(backend.indexWrites).toEqual([
      `sessions/${SESSION_A}`,
      `sessions/${SESSION_A}/attempts/0001`,
    ]);
    warn.mockRestore();
  });

  it(`writes at most ${String(CATCH_UP_DOCUMENTS)} documents per catch-up; a session left for later goes with its next attempt, and whole at the next start`, async () => {
    await store.createSession(realSession(SESSION_A, 1_790_000_000_000));
    for (let k = 1; k < CATCH_UP_DOCUMENTS; k++) {
      await store.saveAttempt(testAttempt(k, 10_000 + k));
    }
    await store.createSession(realSession(SESSION_B, 1_790_000_100_000));
    await store.saveAttempt(testAttempt(1, 12_000, { session: SESSION_B }));
    await store.createSession(realSession(SESSION_C, 1_790_000_200_000));

    const { index, auth, tracked } = load();
    await signIn(auth, index);
    // Session A and its attempts fill the catch-up.
    expect(backend.indexWrites).toHaveLength(CATCH_UP_DOCUMENTS);
    expect(backend.sessionDocument(SESSION_B)).toBeUndefined();
    expect(backend.sessionDocument(SESSION_C)).toBeUndefined();

    // Session B goes on here: its next attempt goes with its session, which the rules require.
    await tracked.saveAttempt(testAttempt(2, 11_000, { session: SESSION_B }));
    await settleIndex(index);
    expect(backend.indexWrites.slice(CATCH_UP_DOCUMENTS)).toEqual([
      `sessions/${SESSION_B}`,
      `sessions/${SESSION_B}/attempts/0002`,
    ]);
    expect(index.failures().size).toBe(0);

    // The next start writes B whole, and C.
    const reload = load();
    await settleIndex(reload.index);
    expect(backend.indexWrites.slice(CATCH_UP_DOCUMENTS + 2)).toEqual([
      `sessions/${SESSION_B}`,
      `sessions/${SESSION_B}/attempts/0001`,
      `sessions/${SESSION_B}/attempts/0002`,
      `sessions/${SESSION_C}`,
    ]);
  });

  it('keeps the documents of a session deleted on this device', async () => {
    const { index, auth, tracked } = load();
    await signIn(auth, index);
    await tracked.createSession(realSession());
    await settleIndex(index);
    await tracked.deleteSession(SESSION_A);
    await settleIndex(index);

    expect(backend.sessionDocument(SESSION_A)).toBeDefined();
    expect(backend.indexWrites).toEqual([`sessions/${SESSION_A}`]);
    expect(kept()[ADA.uid].sessions).toEqual([]);
  });

  it('reads the index: sessions newest first and the unreadable ones apart, one session, its attempts', async () => {
    const { index, auth } = load();
    expect(await index.cloudSessions(10)).toBeNull();
    await signIn(auth, index);
    const phone = realSession(SESSION_B, 1_790_000_100_000, 'ThinkPhone');
    await backend.saveSessionIndex(sessionDocument(phone, ADA.uid), [
      attemptDocument(attemptWithClips(1, 10_000, SESSION_B), phone, ADA.uid),
    ]);
    await backend.saveSessionIndex(sessionDocument(realSession(), ADA.uid));
    await backend.saveSessionIndex({
      ...sessionDocument(realSession(SESSION_C, 1_790_000_200_000), ADA.uid),
      schema: 3,
    } as unknown as ReturnType<typeof sessionDocument>);
    await backend.saveSessionIndex(sessionDocument(realSession(DEMO), 'someone-else'));

    const listed = await index.cloudSessions(10);
    expect(listed?.entries.map((entry) => entry.id)).toEqual([SESSION_B, SESSION_A]);
    expect(listed?.unreadable).toEqual([
      { id: SESSION_C, reason: 'sessions/{id}: schema must be 2, got 3.' },
    ]);
    expect(listed?.fromCache).toBe(false);
    expect(backend.reads).toContain(`sessions ${ADA.uid} 10`);

    expect((await index.cloudSession(SESSION_B))?.document.host.label).toBe('ThinkPhone');
    expect(await index.cloudSession('no-such-session')).toBeNull();
    const attempts = await index.cloudAttempts(SESSION_B);
    expect(attempts?.entries.map((entry) => entry.document.index)).toEqual([1]);

    // The rules refuse to read what is not the account's (or not there): not in its index.
    backend.readError = Object.assign(new Error('Missing or insufficient permissions.'), {
      code: 'permission-denied',
    });
    expect(await index.cloudSession(SESSION_B)).toBeNull();
    await expect(index.cloudSessions(10)).rejects.toThrow('Missing or insufficient permissions.');
    backend.readError = authError('unavailable');
    await expect(index.cloudSession(SESSION_B)).rejects.toThrow('unavailable');
  });
});
