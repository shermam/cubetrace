import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { CLOUD_EVENT_SCHEMA, EVENT_ID, type CloudEvent } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';

import { APP_BUILD } from '../../environments/version';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import {
  FakeDocument,
  FakeLocalStorage,
  FakeMediaQuery,
  FakePerformance,
  FakeTimers,
  FakeWakeLock,
  settle,
} from '../device/fake-browser';
import { WakeLockService } from '../device/wake-lock-service';
import { SETTINGS_STORAGE_KEY, SettingsService } from '../settings/settings-service';
import {
  DAILY_CAP,
  DIAGNOSTICS_STORAGE_KEY,
  DiagnosticsService,
  FLUSH_AT,
  FLUSH_DELAY_MS,
  RING_SIZE,
  type EventKind,
} from './diagnostics-service';

const isCloudEvent = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(
  CLOUD_EVENT_SCHEMA,
);

const MAC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';

@Component({ template: '' })
class Blank {}

describe('DiagnosticsService', () => {
  let storage: FakeLocalStorage;
  let clock: FakePerformance;
  let timers: FakeTimers;
  let page: FakeDocument;
  let wakeLock: FakeWakeLock;
  let backend: FakeAccountBackend;
  let installed: boolean;
  /** The window's listeners, by event (`pagehide`, `online`, `offline`). */
  let listeners: Map<string, Set<() => void>>;

  function fire(type: string): void {
    for (const listener of listeners.get(type) ?? []) {
      listener();
    }
  }

  /** A page load: the service anew over the device's storage, clock and timers. */
  function load(options: { router?: boolean; onLine?: boolean } = {}): DiagnosticsService {
    TestBed.resetTestingModule();
    const globals: BrowserGlobals = {
      navigator: { userAgent: MAC_USER_AGENT, wakeLock, onLine: options.onLine ?? true },
      localStorage: storage,
      performance: clock,
      document: page,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      matchMedia: (query) =>
        new FakeMediaQuery(installed && query === '(display-mode: standalone)'),
      addEventListener: (type, listener) => {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener: (type, listener) => {
        listeners.get(type)?.delete(listener);
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        ...(options.router === true ? [provideRouter([{ path: '**', component: Blank }])] : []),
      ],
    });
    const diagnostics = TestBed.inject(DiagnosticsService);
    // The watchers' first run: the settings as they are, which is no change.
    TestBed.tick();
    return diagnostics;
  }

  /** The kinds written to the account, in order. */
  function written(): string[] {
    return backend.eventKinds(ADA.uid);
  }

  /** The events written to the account, in order. */
  function events(): CloudEvent[] {
    return backend.events.map((entry) => entry.write.event);
  }

  function signIn(diagnostics: DiagnosticsService): void {
    diagnostics.attach({ uid: ADA.uid, backend });
  }

  beforeEach(() => {
    storage = new FakeLocalStorage();
    clock = new FakePerformance(new Date(2026, 9, 2, 10, 0, 0).getTime());
    timers = new FakeTimers(clock);
    page = new FakeDocument();
    wakeLock = new FakeWakeLock();
    backend = new FakeAccountBackend();
    installed = false;
    listeners = new Map();
  });

  it('records the start into the ring while signed out, and writes the ring in one batch at a sign-in', async () => {
    const diagnostics = load();
    await settle();
    expect(diagnostics.counts()).toMatchObject({ ringed: 1, queued: 0, written: 0 });
    expect(backend.events).toEqual([]);

    diagnostics.record('cube.connected', { model: 'GAN 12 ui', mac: 'stored' });
    expect(diagnostics.counts().ringed).toBe(2);

    signIn(diagnostics);
    expect(diagnostics.counts()).toMatchObject({ ringed: 0, queued: 2 });
    expect(backend.events).toEqual([]);
    timers.advance(FLUSH_DELAY_MS);
    await settle();
    expect(backend.eventBatches).toBe(1);
    expect(written()).toEqual(['app.start', 'cube.connected']);
    expect(diagnostics.counts()).toMatchObject({ queued: 0, written: 2 });
    for (const event of events()) {
      expect(isCloudEvent(event), JSON.stringify(isCloudEvent.errors)).toBe(true);
      expect(event.app).toEqual(APP_BUILD);
      expect(event.device).toEqual({ label: 'macOS laptop', platform: 'macOS', installed: false });
    }
    expect(events()[0].data).toEqual({
      installed: false,
      online: true,
      persisted: 'unsupported',
      previousVersion: null,
      previousCommit: null,
      updated: false,
      firstStart: true,
    });
  });

  it('gives each event an id of its time and 8 hex digits, so that ids sort by time', async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    clock.advance(1);
    diagnostics.record('page.viewed', { page: 'timer' });
    clock.advance(1);
    diagnostics.record('page.viewed', { page: 'settings' });
    diagnostics.flush();
    await settle();
    const ids = backend.events.map((entry) => entry.write.id);
    expect(ids).toHaveLength(3);
    for (const [k, id] of ids.entries()) {
      expect(id).toMatch(EVENT_ID);
      expect(id.slice(0, 13)).toBe(String(Math.floor(events()[k].tsMs)));
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it(`writes a batch ${String(FLUSH_DELAY_MS / 1000)} s after its first event, or as soon as it holds ${String(FLUSH_AT)}`, async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    timers.advance(FLUSH_DELAY_MS);
    await settle();
    expect(written()).toEqual(['app.start']);

    // By time: three events, nothing until the delay is up.
    for (let k = 0; k < 3; k++) {
      diagnostics.record('page.viewed', { page: 'timer' });
      timers.advance(1000);
    }
    expect(backend.eventBatches).toBe(1);
    timers.advance(FLUSH_DELAY_MS - 3000);
    await settle();
    expect(backend.eventBatches).toBe(2);
    expect(written()).toHaveLength(4);

    // By count: the twentieth event goes at once, with the others.
    for (let k = 0; k < FLUSH_AT - 1; k++) {
      diagnostics.record('settings.changed', { key: 'k', value: k });
    }
    expect(backend.eventBatches).toBe(2);
    diagnostics.record('settings.changed', { key: 'k', value: FLUSH_AT });
    expect(backend.eventBatches).toBe(3);
    await settle();
    expect(written()).toHaveLength(4 + FLUSH_AT);
    // No timer left behind for the batch that went by count.
    timers.advance(FLUSH_DELAY_MS);
    await settle();
    expect(backend.eventBatches).toBe(3);
  });

  it('writes what is queued when the page is hidden, and when it goes away', async () => {
    const diagnostics = load();
    signIn(diagnostics);
    diagnostics.record('attempt.deleted', {}, { session: 's', attempt: 1 });
    expect(backend.eventBatches).toBe(0);
    page.setVisibility('hidden');
    await settle();
    expect(backend.eventBatches).toBe(1);
    expect(written().at(-1)).toBe('attempt.deleted');
    page.setVisibility('visible');
    diagnostics.record('cube.reset', { kind: 'gan' });
    fire('pagehide');
    await settle();
    expect(backend.eventBatches).toBe(2);
    expect(written().at(-1)).toBe('cube.reset');
    fire('pagehide');
    expect(backend.eventBatches).toBe(2);
  });

  it(`keeps the last ${String(RING_SIZE)} events raised signed out, and nothing of them across a reload`, async () => {
    const diagnostics = load();
    await settle();
    for (let k = 0; k < RING_SIZE + 100; k++) {
      diagnostics.record('page.viewed', { page: 'timer', k });
    }
    expect(diagnostics.counts().ringed).toBe(RING_SIZE);
    // A reload: the ring was the page's.
    const next = load();
    await settle();
    expect(next.counts().ringed).toBe(1);
    signIn(diagnostics);
    diagnostics.flush();
    await settle();
    expect(written()).toHaveLength(RING_SIZE);
    // The oldest went first: the start, then the first hundred views.
    expect(written()[0]).toBe('page.viewed');
    expect(events()[0].data['k']).toBe(100);
    expect(storage.getItem(DIAGNOSTICS_STORAGE_KEY)).not.toContain('ring');
  });

  it('writes a batch to the account signed out, before the next account gets the ring', async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    diagnostics.record('page.viewed', { page: 'sessions' });
    diagnostics.attach(null);
    await settle();
    expect(written()).toEqual(['app.start', 'page.viewed']);
    diagnostics.record('page.viewed', { page: 'settings' });
    expect(diagnostics.counts().ringed).toBe(1);
    const bob = new FakeAccountBackend();
    diagnostics.attach({ uid: 'bob-uid', backend: bob });
    bob.user = null;
    diagnostics.flush();
    await settle();
    expect(bob.eventKinds('bob-uid')).toEqual(['page.viewed']);
    expect(written()).toHaveLength(2);
  });

  it('stops with the setting off, after one last settings.changed, and starts again with it on', async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    const settings = TestBed.inject(SettingsService);
    settings.setDiagnostics(false);
    TestBed.tick();
    await settle();
    expect(written()).toEqual(['app.start', 'settings.changed']);
    expect(events().at(-1)?.data).toEqual({ key: 'diagnostics', value: false });
    diagnostics.record('page.viewed', { page: 'timer' });
    diagnostics.attach(null);
    diagnostics.record('cube.connected', {});
    expect(diagnostics.counts()).toMatchObject({ queued: 0, ringed: 0 });
    settings.setDiagnostics(true);
    TestBed.tick();
    expect(diagnostics.counts().ringed).toBe(1);
    signIn(diagnostics);
    diagnostics.flush();
    await settle();
    expect(events().at(-1)?.data).toEqual({ key: 'diagnostics', value: true });
    expect(written()).toHaveLength(3);
  });

  it('writes the last settings.changed of the switch turned off when the page goes away before the change took effect, once', async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    // Unchecked, and the page goes at once (a navigation): the effect that follows the setting runs
    // in the next tick, which an unload does not wait for. What the page wrote as it went, at once,
    // is all it writes.
    TestBed.inject(SettingsService).setDiagnostics(false);
    fire('pagehide');
    expect(backend.eventBatches).toBe(1);
    expect(written()).toEqual(['app.start', 'settings.changed']);
    expect(events().at(-1)?.data).toEqual({ key: 'diagnostics', value: false });
    // The page comes back (the back/forward cache), and the tick with it: nothing twice, nothing more.
    await settle();
    TestBed.tick();
    await settle();
    diagnostics.record('page.viewed', { page: 'sessions' });
    diagnostics.flush();
    timers.advance(FLUSH_DELAY_MS);
    await settle();
    expect(written()).toEqual(['app.start', 'settings.changed']);
    expect(backend.eventBatches).toBe(1);
    expect(diagnostics.counts()).toMatchObject({ queued: 0, ringed: 0 });
  });

  it('settles the switch the same way turned on, when the page is hidden, and as the app is torn down', async () => {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ diagnostics: false }));
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    const settings = TestBed.inject(SettingsService);
    // Checked, and the page goes at once: its event is in that last batch.
    settings.setDiagnostics(true);
    fire('pagehide');
    expect(written()).toEqual(['settings.changed']);
    expect(events().at(-1)?.data).toEqual({ key: 'diagnostics', value: true });
    // The tick after all: nothing twice, and what is recorded from then on goes.
    await settle();
    TestBed.tick();
    diagnostics.record('page.viewed', { page: 'timer' });
    diagnostics.flush();
    await settle();
    expect(written()).toEqual(['settings.changed', 'page.viewed']);
    // Unchecked, and the page is hidden at once (another tab in front): the last event goes then.
    settings.setDiagnostics(false);
    page.setVisibility('hidden');
    expect(events().at(-1)?.data).toEqual({ key: 'diagnostics', value: false });
    await settle();
    TestBed.tick();
    diagnostics.record('page.viewed', { page: 'timer' });
    diagnostics.flush();
    // Checked again, and the app is torn down before its tick.
    settings.setDiagnostics(true);
    TestBed.resetTestingModule();
    await settle();
    expect(written()).toEqual([
      'settings.changed',
      'page.viewed',
      'settings.changed',
      'settings.changed',
    ]);
    expect(events().at(-1)?.data).toEqual({ key: 'diagnostics', value: true });
    expect(backend.eventBatches).toBe(4);
  });

  it(`writes at most ${String(DAILY_CAP)} events a day, then the errors alone, and counts the day in localStorage`, async () => {
    storage.setItem(
      DIAGNOSTICS_STORAGE_KEY,
      JSON.stringify({ day: '2026-10-02', count: DAILY_CAP - 1, build: APP_BUILD }),
    );
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    diagnostics.record('page.viewed', { page: 'timer' });
    diagnostics.record('error.app', { where: 'test', message: 'kept' });
    diagnostics.record('clip.saved', { segment: 'solve' });
    diagnostics.flush();
    await settle();
    expect(written()).toEqual(['app.start', 'error.app']);
    expect(diagnostics.counts().capped).toBe(2);
    expect(JSON.parse(storage.getItem(DIAGNOSTICS_STORAGE_KEY) ?? '{}')).toMatchObject({
      day: '2026-10-02',
      count: DAILY_CAP + 1,
    });
    // The next day counts from zero.
    clock.advance(24 * 60 * 60 * 1000);
    diagnostics.record('page.viewed', { page: 'timer' });
    diagnostics.flush();
    await settle();
    expect(written().at(-1)).toBe('page.viewed');
    expect(JSON.parse(storage.getItem(DIAGNOSTICS_STORAGE_KEY) ?? '{}')).toMatchObject({
      day: '2026-10-03',
      count: 1,
    });
  });

  it('says in app.start which build the device saw last, when it differs', async () => {
    storage.setItem(
      DIAGNOSTICS_STORAGE_KEY,
      JSON.stringify({
        day: '2026-10-01',
        count: 5,
        build: { version: '0.3.0', commit: 'old1234' },
      }),
    );
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    diagnostics.flush();
    await settle();
    expect(events()[0].data).toMatchObject({
      previousVersion: '0.3.0',
      previousCommit: 'old1234',
      updated: true,
      firstStart: false,
    });
    expect(JSON.parse(storage.getItem(DIAGNOSTICS_STORAGE_KEY) ?? '{}')).toMatchObject({
      build: APP_BUILD,
    });
    // The same build again: no update.
    const again = load();
    await settle();
    signIn(again);
    again.flush();
    await settle();
    expect(events().at(-1)?.data).toMatchObject({
      previousVersion: APP_BUILD.version,
      previousCommit: APP_BUILD.commit,
      updated: false,
    });
  });

  it('puts the session and attempt under way on an event, unless the event says otherwise', async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    diagnostics.setSession('3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f');
    diagnostics.setAttempt(3);
    diagnostics.record('cube.disconnected', { reason: 'closed' });
    diagnostics.record('clip.saved', { segment: 'solve' }, { session: 'other', attempt: 9 });
    diagnostics.record('page.viewed', { page: 'timer' }, null);
    diagnostics.setAttempt(null);
    diagnostics.record('cube.reset', {});
    diagnostics.setSession(null);
    diagnostics.record('camera.off', {});
    diagnostics.flush();
    await settle();
    const scopes = events()
      .slice(1)
      .map((event) => [event.session ?? null, event.attempt ?? null]);
    expect(scopes).toEqual([
      ['3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f', 3],
      ['other', 9],
      [null, null],
      ['3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f', null],
      [null, null],
    ]);
  });

  it('records the settings the checklists name as they change, not as they are, and the wake lock', async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    diagnostics.flush();
    await settle();
    expect(written()).toEqual(['app.start']);
    const settings = TestBed.inject(SettingsService);
    settings.setInspection(true);
    settings.setIdleDisconnectMinutes(1);
    settings.setVideoQuality('high');
    settings.setHostLabel('office-mbp');
    TestBed.tick();
    // Settings → Keep the screen on: the lock it takes (wake.lock says it is wanted; no setting).
    await TestBed.inject(WakeLockService).request();
    TestBed.tick();
    diagnostics.flush();
    await settle();
    const changes = events()
      .filter((event) => event.kind === 'settings.changed')
      .map((event) => event.data);
    expect(changes).toEqual([
      { key: 'hostLabel', value: 'office-mbp' },
      { key: 'inspection', value: true },
      { key: 'idleDisconnectMinutes', value: 1 },
      { key: 'videoQuality', value: 'high' },
    ]);
    expect(events().find((event) => event.kind === 'wake.lock')?.data).toEqual({
      status: 'active',
      wanted: true,
    });
    // The label changed: the later events carry it.
    expect(events().at(-1)?.device.label).toBe('office-mbp');
  });

  it('records the page viewed, with the session a session page shows', async () => {
    const diagnostics = load({ router: true });
    signIn(diagnostics);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/?demo=0&speed=20');
    await router.navigateByUrl('/sessions/3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f');
    await router.navigateByUrl('/qa');
    diagnostics.flush();
    await settle();
    const views = events().filter((event) => event.kind === 'page.viewed');
    expect(views.map((event) => event.data)).toEqual([
      { page: 'timer', demo: true },
      { page: 'session', demo: false },
      { page: 'qa', demo: false },
    ]);
    expect(views[1].session).toBe('3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f');
    expect(views[0].session).toBeUndefined();
  });

  it('records the network going and coming back', async () => {
    const diagnostics = load({ onLine: false });
    await settle();
    signIn(diagnostics);
    fire('online');
    fire('offline');
    diagnostics.flush();
    await settle();
    expect(events()[0].data).toMatchObject({ online: false });
    expect(
      events()
        .slice(1)
        .map((event) => [event.kind, event.data['online']]),
    ).toEqual([
      ['network.changed', true],
      ['network.changed', false],
    ]);
  });

  it('says where the app runs: installed, on this platform', async () => {
    installed = true;
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    diagnostics.flush();
    await settle();
    expect(events()[0].device.installed).toBe(true);
    expect(events()[0].data['installed']).toBe(true);
  });

  it('never throws: a kind that is not one, facts that cannot be made into an event, a backend that refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const diagnostics = load();
      await settle();
      signIn(diagnostics);
      expect(() => {
        diagnostics.record('Not a kind' as unknown as EventKind);
        diagnostics.record('attempt.done', {}, { session: 's', attempt: 0 });
        diagnostics.record('cube.connected', { mac: 'AB:12:CD:34:EF:56', fn: () => 1 });
      }).not.toThrow();
      diagnostics.flush();
      await settle();
      expect(written()).toEqual(['app.start', 'cube.connected']);
      expect(events().at(-1)?.data).toEqual({ mac: '[mac]' });
      expect(warn).toHaveBeenCalledTimes(2);

      backend.eventError = Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      });
      diagnostics.record('page.viewed', { page: 'timer' });
      expect(() => {
        diagnostics.flush();
      }).not.toThrow();
      await diagnostics.whenIdle();
      await settle();
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls.at(-1)?.[0]).toContain('1 event could not be saved to the account');
      // Said once: the next refusal is quiet, and nothing is thrown.
      diagnostics.record('page.viewed', { page: 'timer' });
      diagnostics.flush();
      await diagnostics.whenIdle();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('writes nothing to localStorage but its own key, and works without localStorage', async () => {
    const diagnostics = load();
    await settle();
    signIn(diagnostics);
    diagnostics.flush();
    await settle();
    expect(Array.from({ length: storage.length }, (_, k) => storage.key(k))).toEqual([
      DIAGNOSTICS_STORAGE_KEY,
    ]);
    storage.failWith = new Error('QuotaExceededError');
    diagnostics.record('page.viewed', { page: 'timer' });
    diagnostics.flush();
    await settle();
    expect(written().at(-1)).toBe('page.viewed');
  });
});
