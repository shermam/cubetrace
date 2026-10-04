import { TestBed } from '@angular/core/testing';
import { MemorySessionStore } from '@cubetrace/core';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, FakeStorageManager, settle } from '../device/fake-browser';
import { ClipsInFlight } from '../session/clips-in-flight';
import { SessionChanges } from '../session/session-changes';
import { setup } from '../session/session-harness';
import { SESSION_STORAGE } from '../session/session-storage';
import { SESSION_A, testAttempt, testSession } from '../session/session-testing';
import { SettingsService } from '../settings/settings-service';
import { UPLOAD_RUNTIME, UploadService } from './upload-service';
import { FakeUploadRuntime, attemptView, queueView } from './upload-testing';

describe('UploadService', () => {
  let backend: FakeAccountBackend;
  let runtime: FakeUploadRuntime;

  /** The app with the fakes: the account's backend, the queue's runtime, a store said to be OPFS. */
  function start(kind: 'opfs' | 'memory' = 'opfs') {
    const store = new MemorySessionStore();
    const s = setup({
      store,
      providers: [
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        { provide: UPLOAD_RUNTIME, useValue: runtime.loader },
        { provide: SESSION_STORAGE, useValue: { store, kind } },
      ],
    });
    return {
      ...s,
      uploads: TestBed.inject(UploadService),
      auth: TestBed.inject(AuthService),
      changes: TestBed.inject(SessionChanges),
      clips: TestBed.inject(ClipsInFlight),
    };
  }

  async function signIn(auth: AuthService): Promise<void> {
    await auth.signIn();
    await settle();
    await settle();
  }

  beforeEach(() => {
    backend = new FakeAccountBackend();
    runtime = new FakeUploadRuntime();
  });

  it("loads nothing signed out; signed in, starts a queue for the account with this device's settings", async () => {
    const app = start();
    await settle();
    expect(app.uploads.status()).toBe('signed-out');
    expect(app.uploads.view()).toBeNull();
    expect(runtime.loads).toBe(0);

    await signIn(app.auth);
    expect(runtime.loads).toBe(1);
    const queue = runtime.last;
    expect(queue.deps.uid).toBe(ADA.uid);
    expect(queue.deps.backend).toBe(backend);
    // A laptop (the harness's user agent says nothing of a phone): local copies kept, no Wi-Fi only.
    expect(queue.deps.policy).toEqual({ wifiOnly: false, keepLocalCopies: true });
    expect(queue.calls).toEqual(['start']);
    expect(app.uploads.status()).toBe('running');
    expect(app.uploads.view()?.status).toBe('running');
    expect(app.uploads.outstanding()).toBeNull();

    // The queue's view, as it changes.
    queue.set(
      queueView({
        counts: { waiting: 0, pending: 2, uploading: 1, done: 0, failed: 0 },
        bytesLeft: 3_000,
      }),
    );
    expect(app.uploads.outstanding()).toEqual({
      left: 3,
      failed: 0,
      uploading: true,
      pause: null,
      bytesLeft: 3_000,
    });
    queue.attempts.set(`${SESSION_A}/2`, attemptView(2, { state: 'uploading' }));
    expect(app.uploads.attempt(SESSION_A, 2)?.state).toBe('uploading');
    expect(app.uploads.attempt(SESSION_A, 3)).toBeNull();
    app.uploads.retry(SESSION_A, 2);
    expect(queue.calls.at(-1)).toBe(`retry ${SESSION_A}/2`);
  });

  it('tells the queue of every write of the store, once it is done', async () => {
    const app = start();
    await signIn(app.auth);
    const queue = runtime.last;
    const tracked = app.changes.track(new MemorySessionStore());
    await tracked.createSession(testSession(SESSION_A));
    await tracked.saveAttempt(testAttempt(1, 10_000));
    await tracked.deleteAttempt(SESSION_A, 1);
    await tracked.deleteSession(SESSION_A);
    expect(queue.calls.slice(1)).toEqual([
      `session ${SESSION_A}`,
      `attempt ${SESSION_A}/1`,
      `attempt-deleted ${SESSION_A}/1`,
      `session-deleted ${SESSION_A}`,
    ]);
  });

  it("follows the settings, and an attempt's clips: it waits for those still to come", async () => {
    const app = start();
    await signIn(app.auth);
    const queue = runtime.last;
    const settings = TestBed.inject(SettingsService);
    settings.setKeepLocalCopies(false);
    await settle();
    expect(queue.policies.at(-1)).toEqual({ wifiOnly: false, keepLocalCopies: false });

    expect(queue.deps.settled(SESSION_A, 1)).toBe(true);
    app.clips.begin(SESSION_A, 1);
    expect(queue.deps.settled(SESSION_A, 1)).toBe(false);
    app.clips.end(SESSION_A, 1);
    await settle();
    expect(queue.deps.settled(SESSION_A, 1)).toBe(true);
    expect(queue.calls).toContain('refresh');

    // Upload sessions off: the queue stops, and starts again (a new one) when it is on again.
    settings.setUploadSessions(false);
    await settle();
    expect(queue.calls.at(-1)).toBe('stop');
    expect(app.uploads.status()).toBe('off');
    expect(app.uploads.view()).toBeNull();
    settings.setUploadSessions(true);
    await settle();
    expect(runtime.queues).toHaveLength(2);
    expect(runtime.last.calls).toEqual(['start']);
  });

  it("lets an attempt's clips go through SessionService before the queue deletes them, its record unchanged (T4.2a)", async () => {
    const app = start();
    await signIn(app.auth);
    const attempt = testAttempt(1, 10_000);
    const session = testSession(SESSION_A);
    await app.store.createSession(session);
    await app.store.saveAttempt({
      ...attempt,
      video: [
        {
          camera: 'laptop',
          segment: 'solve',
          file: 'laptop.solve.mp4',
          bytes: 1_000,
          codec: 'avc1.640028',
          audio: null,
          width: 1920,
          height: 1080,
          crop: null,
          fpsNominal: 30,
          frames: 30,
          firstFrameHostMs: 1_000,
          framesFile: 'laptop.solve.frames.json',
          syncResidualMs: null,
          truncatedStart: false,
        },
      ],
    });
    const [recorded] = await app.store.loadAttempts(SESSION_A);
    const calls = runtime.last.calls.length;
    const ref = { session: SESSION_A, index: 1, scrambleShown: attempt.events.scrambleShown };
    expect(await runtime.last.deps.releaseClips(ref, ['laptop.solve.mp4'])).toBe(true);
    // Nothing is saved: the record stays as it was uploaded, and the queue is told of no write.
    expect(await app.store.loadAttempts(SESSION_A)).toEqual([recorded]);
    expect(runtime.last.calls.slice(calls)).toEqual([]);
    // Another attempt with that index, or none: no.
    expect(
      await runtime.last.deps.releaseClips({ ...ref, scrambleShown: 1 }, ['laptop.solve.mp4']),
    ).toBe(false);
    expect(await runtime.last.deps.releaseClips({ ...ref, index: 9 }, [])).toBe(false);
  });

  it('stops the queue on sign-out', async () => {
    const app = start();
    await signIn(app.auth);
    const queue = runtime.last;
    await app.auth.signOut();
    await settle();
    expect(queue.calls.at(-1)).toBe('stop');
    expect(app.uploads.status()).toBe('signed-out');
    expect(app.uploads.view()).toBeNull();
    expect(app.uploads.outstanding()).toBeNull();
  });

  it("says when the queue's code could not be loaded, and loads nothing without OPFS", async () => {
    runtime.loadError = new Error('Failed to fetch dynamically imported module');
    const app = start();
    await signIn(app.auth);
    expect(app.uploads.status()).toBe('error');
    expect(app.uploads.error()).toBe(
      'The uploads could not be loaded (Failed to fetch dynamically imported module): they start again with the next page load online.',
    );

    TestBed.resetTestingModule();
    backend = new FakeAccountBackend();
    runtime = new FakeUploadRuntime();
    const memory = start('memory');
    await signIn(memory.auth);
    expect(memory.uploads.status()).toBe('unavailable');
    expect(runtime.loads).toBe(0);
  });
});

describe('UploadService, as the page goes away', () => {
  it('writes the queue’s state at once on pagehide', async () => {
    const window = Object.assign(new EventTarget(), {
      navigator: { userAgent: 'test', storage: new FakeStorageManager({ grant: true }) },
      localStorage: new FakeLocalStorage(),
    });
    const backend = new FakeAccountBackend();
    const runtime = new FakeUploadRuntime();
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: window },
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        { provide: UPLOAD_RUNTIME, useValue: runtime.loader },
        { provide: SESSION_STORAGE, useValue: { store: new MemorySessionStore(), kind: 'opfs' } },
      ],
    });
    TestBed.inject(UploadService);
    await TestBed.inject(AuthService).signIn();
    await settle();
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(runtime.last.calls).toEqual(['start', 'flush']);
  });
});
