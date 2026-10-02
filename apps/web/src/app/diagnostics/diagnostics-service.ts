import { DestroyRef, Injectable, effect, inject, untracked } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { cloudEvent, eventId, type CloudEventWrite, type EventDevice } from '@cubetrace/core';

import { APP_BUILD } from '../../environments/version';
import type { AccountBackend } from '../auth/account-backend';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { installedApp } from '../device/display-mode';
import { StorageService } from '../device/storage-service';
import { WakeLockService } from '../device/wake-lock-service';
import { SettingsService, hostPlatform } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { localDay } from '../shared/local-day';

/**
 * The `localStorage` key of what the diagnostics keep on this device: the day's count of events
 * written, for the cap, and the build last seen, for the update evidence of `app.start`.
 */
export const DIAGNOSTICS_STORAGE_KEY = 'cubetrace.diagnostics';

/** The events queued are written this long after the first of them, ms. */
export const FLUSH_DELAY_MS = 5000;

/** Or as soon as this many are queued. */
export const FLUSH_AT = 20;

/** The events kept in memory while no account is signed in: the last this many. */
export const RING_SIZE = 500;

/** The events a device writes in a local day, at most; past it, only the `error.*` kinds go. */
export const DAILY_CAP = 2000;

/** The account the events go to: its uid and the backend that writes them. */
export interface EventSink {
  readonly uid: string;
  readonly backend: Pick<AccountBackend, 'saveEvents'>;
}

/** The session and attempt an event belongs to; null or absent for none. */
export interface EventScope {
  readonly session?: string | null;
  readonly attempt?: number | null;
}

/** What the diagnostics keep on this device. */
interface Kept {
  /** The local day of `count`, as `2026-10-01`. */
  day: string;
  /** The events written to the account on that day (the cap counts them). */
  count: number;
  /** The build that last recorded `app.start` on this device; null before the first. */
  build: { version: string; commit: string } | null;
}

/** The settings whose changes are events (docs/DIAGNOSTICS.md, `settings.changed`), by key. */
type Watched = Readonly<Record<string, () => string | number | boolean>>;

/**
 * The diagnostics events (docs/PLAN.md T3.9, docs/DIAGNOSTICS.md, docs/DATA-MODEL.md §10): facts
 * about the app's own use that the services record where they know them (`record`), written to the
 * account's `users/{uid}/events` so that the coordinator's round report, not the owner's notes, is
 * the evidence of the manual rounds. `record` never throws and never waits: an event is queued in
 * memory and the queue goes to Firestore in one batch {@link FLUSH_DELAY_MS} after its first event,
 * at {@link FLUSH_AT} events, and when the page is hidden or goes away; Firestore's persistent cache
 * carries the batch when the device is offline. Only while an account is signed in (`attach`) and
 * Settings → Account → Diagnostics is on: events raised signed out wait in a ring of the last
 * {@link RING_SIZE}, written when a sign-in comes during the page's life (so that a session's start
 * is not lost), and nothing of them lives past a reload but through Firestore; with the setting off,
 * nothing is kept, after one last `settings.changed`. A device writes at most {@link DAILY_CAP}
 * events a local day (counted in `localStorage`), then the `error.*` kinds alone. Besides what the
 * services record, this service records `app.start` (with the build last seen on the device: the
 * update evidence), `page.viewed` (the router), `settings.changed` for the settings the checklists
 * name, `wake.lock`, `storage.persistence` and `network.changed`, which it watches itself. The
 * session and attempt under way (`setSession`, `setAttempt`, kept by `SessionService`) go on every
 * event recorded without a scope of its own.
 */
@Injectable({ providedIn: 'root' })
export class DiagnosticsService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly settings = inject(SettingsService);
  private readonly storage = inject(StorageService);
  private readonly wakeLock = inject(WakeLockService);
  /** The router, where there is one (the unit tests of the services have none): the pages viewed. */
  private readonly router = inject(Router, { optional: true });

  /** This device, for every event: its platform and whether the app runs installed never change. */
  private readonly platform = hostPlatform(this.globals.navigator).platform;
  private readonly installed = installedApp(this.globals);

  private account: EventSink | null = null;
  /** The setting, as this service follows it (the last `settings.changed` goes before it flips). */
  private enabled = this.settings.diagnostics();
  /** The events raised while no account was signed in, the oldest first. */
  private ring: CloudEventWrite[] = [];
  /** The events to write in the next batch. */
  private pending: CloudEventWrite[] = [];
  private flushTimer: number | null = null;
  /** The batches handed to the backend and not settled yet. */
  private readonly inFlight = new Set<Promise<void>>();
  /** The session and attempt under way, for the events recorded without a scope. */
  private context: { session: string | null; attempt: number | null } = {
    session: null,
    attempt: null,
  };
  /** What this page load has said in the console, so that each thing is said once. */
  private readonly said = new Set<string>();
  /** The events written to the account by this page load, and those the cap held back. */
  private writtenCount = 0;
  private cappedCount = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);
    // The page is hidden or going away: what is queued goes now rather than in a moment.
    const page = this.globals.document;
    const onVisibilityChange = (): void => {
      if (page?.visibilityState === 'hidden') {
        this.flush();
      }
    };
    page?.addEventListener('visibilitychange', onVisibilityChange);
    const onPageHide = (): void => {
      this.flush();
    };
    this.globals.addEventListener?.('pagehide', onPageHide);
    const onOnline = (): void => {
      this.record('network.changed', { online: true });
    };
    const onOffline = (): void => {
      this.record('network.changed', { online: false });
    };
    this.globals.addEventListener?.('online', onOnline);
    this.globals.addEventListener?.('offline', onOffline);
    const navigation = this.router?.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.pageViewed(event.urlAfterRedirects);
      }
    });
    if (this.router?.navigated === true) {
      this.pageViewed(this.router.url);
    }
    destroyRef.onDestroy(() => {
      page?.removeEventListener('visibilitychange', onVisibilityChange);
      this.globals.removeEventListener?.('pagehide', onPageHide);
      this.globals.removeEventListener?.('online', onOnline);
      this.globals.removeEventListener?.('offline', onOffline);
      navigation?.unsubscribe();
      this.flush();
    });
    // The setting: off writes one last event and stops; on starts again.
    effect(() => {
      const on = this.settings.diagnostics();
      untracked(() => {
        this.onSetting(on);
      });
    });
    this.watchSettings();
    this.watchDevice();
    // The start, once the storage's persistence is known (it is read in a moment anyway).
    void this.storage
      .refresh()
      .catch(() => undefined)
      .then(() => {
        this.start();
      });
  }

  /**
   * Records an event of `kind` with its facts, which `cloudEvent` sanitizes (texts cut and scrubbed,
   * at most 32 of them), for the session and attempt under way unless `scope` says otherwise (a
   * scope of its own, or null for none). Cheap, never throws, never waits: a kind that is not one, or
   * facts that cannot be made into an event, are said once in the console and dropped.
   */
  record(
    kind: string,
    data: Readonly<Record<string, unknown>> = {},
    scope?: EventScope | null,
  ): void {
    if (!this.enabled) {
      return;
    }
    let write: CloudEventWrite;
    try {
      const tsMs = hostNow(this.globals);
      const at = scope === undefined ? this.context : (scope ?? {});
      write = {
        id: eventId(tsMs, randomSuffix()),
        event: cloudEvent({
          tsMs,
          kind,
          app: APP_BUILD,
          device: this.device(),
          session: at.session,
          attempt: at.attempt,
          data,
        }),
      };
    } catch (error: unknown) {
      this.say(`make ${kind}`, `the event ${kind} could not be made: ${errorMessage(error)}`);
      return;
    }
    if (this.account === null) {
      this.ring.push(write);
      if (this.ring.length > RING_SIZE) {
        this.ring.shift();
      }
      return;
    }
    this.queue(write);
  }

  /**
   * The account the events go to, or null once it is signed out: `AuthService` keeps it. A sign-in
   * writes what the ring holds; a sign-out writes what is queued first.
   */
  attach(account: EventSink | null): void {
    const before = this.account;
    if (account?.uid === before?.uid && account?.backend === before?.backend) {
      return;
    }
    if (before !== null) {
      this.flush();
    }
    this.account = account;
    if (account === null) {
      return;
    }
    const ring = this.ring;
    this.ring = [];
    for (const write of ring) {
      this.queue(write);
    }
  }

  /** The session under way (its id), or null: `SessionService` keeps it. */
  setSession(id: string | null): void {
    if (this.context.session !== id) {
      this.context = { session: id, attempt: id === null ? null : this.context.attempt };
    }
  }

  /** The attempt under way (its index), or null between attempts: `SessionService` keeps it. */
  setAttempt(index: number | null): void {
    if (this.context.attempt !== index) {
      this.context = { session: this.context.session, attempt: index };
    }
  }

  /** Writes the events queued now, in one batch, without waiting for the server. */
  flush(): void {
    this.flushTimer = this.clearTimer(this.flushTimer);
    const account = this.account;
    if (account === null || this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    let sent: Promise<void>;
    try {
      sent = account.backend.saveEvents(account.uid, batch);
    } catch (error: unknown) {
      sent = Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    this.inFlight.add(sent);
    void sent.then(
      () => {
        this.inFlight.delete(sent);
        this.writtenCount += batch.length;
      },
      (error: unknown) => {
        this.inFlight.delete(sent);
        this.say(
          'save',
          `${String(batch.length)} ${batch.length === 1 ? 'event' : 'events'} could not be saved to the account: ${errorMessage(error)}`,
        );
      },
    );
  }

  /** Resolves once the batches handed to the backend so far have settled (for tests). */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** What this page load has done: the events queued now, written, held in the ring, or capped. */
  counts(): { queued: number; written: number; ringed: number; capped: number } {
    return {
      queued: this.pending.length,
      written: this.writtenCount,
      ringed: this.ring.length,
      capped: this.cappedCount,
    };
  }

  /** Queues `write` for the next batch, within the day's cap. */
  private queue(write: CloudEventWrite): void {
    if (!this.withinCap(write.event.kind)) {
      this.cappedCount++;
      return;
    }
    this.pending.push(write);
    if (this.pending.length >= FLUSH_AT) {
      this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = this.setTimer(() => {
        this.flushTimer = null;
        this.flush();
      }, FLUSH_DELAY_MS);
    }
  }

  /**
   * Counts one more event of `kind` written today, and whether it may go: the first
   * {@link DAILY_CAP} of a local day, and every `error.*` event.
   */
  private withinCap(kind: string): boolean {
    const kept = this.readKept();
    const day = localDay(hostNow(this.globals));
    if (kept.day !== day) {
      kept.day = day;
      kept.count = 0;
    }
    if (kept.count >= DAILY_CAP && !kind.startsWith('error.')) {
      return false;
    }
    kept.count++;
    this.writeKept(kept);
    return true;
  }

  /** `app.start`: where the app runs, and the build last seen on this device when it differs. */
  private start(): void {
    const kept = this.readKept();
    const previous = kept.build;
    const updated =
      previous !== null &&
      (previous.version !== APP_BUILD.version || previous.commit !== APP_BUILD.commit);
    if (
      previous === null ||
      previous.version !== APP_BUILD.version ||
      previous.commit !== APP_BUILD.commit
    ) {
      kept.build = { version: APP_BUILD.version, commit: APP_BUILD.commit };
      this.writeKept(kept);
    }
    this.record('app.start', {
      installed: this.installed,
      online: this.globals.navigator?.onLine !== false,
      persisted: this.storage.persistence(),
      previousVersion: previous?.version ?? null,
      previousCommit: previous?.commit ?? null,
      updated,
      firstStart: previous === null,
    });
  }

  private pageViewed(url: string): void {
    const path = url.split('?')[0].split('#')[0];
    const segments = path.split('/').filter((segment) => segment !== '');
    const first = segments[0] ?? '';
    const page =
      first === '' ? 'timer' : first === 'sessions' && segments.length > 1 ? 'session' : first;
    const demo = /[?&]demo=/u.test(url);
    if (page === 'session') {
      this.record('page.viewed', { page, demo }, { session: segments[1] });
    } else {
      this.record('page.viewed', { page, demo });
    }
  }

  private onSetting(on: boolean): void {
    if (on === this.enabled) {
      return;
    }
    if (on) {
      this.enabled = true;
      this.record('settings.changed', { key: 'diagnostics', value: true });
      return;
    }
    // One last event, then nothing: not even the ring.
    this.record('settings.changed', { key: 'diagnostics', value: false });
    this.enabled = false;
    this.ring = [];
    this.flush();
  }

  /** `settings.changed` for each setting the checklists name, as it changes (not its first value). */
  private watchSettings(): void {
    const settings = this.settings;
    const watched: Watched = {
      hostLabel: () => settings.hostLabel(),
      inspection: () => settings.inspection(),
      autoAdvance: () => settings.autoAdvance(),
      scrambleOverPicture: () => settings.scrambleOverPicture(),
      idleDisconnectMinutes: () => settings.idleDisconnectMinutes(),
      cameraResolution: () => settings.cameraResolution(),
      cameraFrameRate: () => settings.cameraFrameRate(),
      sharpnessThreshold: () => settings.sharpnessThreshold(),
      recordAudio: () => settings.recordAudio(),
      microphoneProcessing: () => settings.microphoneProcessing(),
      videoQuality: () => settings.videoQuality(),
      demoSpeed: () => settings.demoSpeed(),
      uploadSessions: () => settings.uploadSessions(),
      wifiOnly: () => settings.wifiOnlySetting(),
      keepLocalCopies: () => settings.keepLocalCopies(),
      keepScreenOn: () => this.wakeLock.wanted(),
    };
    let last: Record<string, string | number | boolean> | null = null;
    effect(() => {
      const now: Record<string, string | number | boolean> = {};
      for (const [key, read] of Object.entries(watched)) {
        now[key] = read();
      }
      untracked(() => {
        if (last !== null) {
          for (const [key, value] of Object.entries(now)) {
            if (value !== last[key]) {
              this.record('settings.changed', { key, value });
            }
          }
        }
        last = now;
      });
    });
  }

  /** `wake.lock` and `storage.persistence` as they change (not their first values). */
  private watchDevice(): void {
    let lock: string | null = null;
    effect(() => {
      const status = this.wakeLock.status();
      const wanted = this.wakeLock.wanted();
      untracked(() => {
        if (lock !== null && lock !== status) {
          this.record('wake.lock', { status, wanted });
        }
        lock = status;
      });
    });
    let persistence: string | null = null;
    effect(() => {
      const state = this.storage.persistence();
      const refused = this.storage.refused();
      untracked(() => {
        if (persistence !== null && persistence !== state && state !== 'unknown') {
          this.record('storage.persistence', { state, refused });
        }
        persistence = state;
      });
    });
  }

  private device(): EventDevice {
    return { label: this.settings.hostLabel(), platform: this.platform, installed: this.installed };
  }

  private readKept(): Kept {
    try {
      const parsed: unknown = JSON.parse(
        this.globals.localStorage?.getItem(DIAGNOSTICS_STORAGE_KEY) ?? 'null',
      );
      if (typeof parsed === 'object' && parsed !== null) {
        const day: unknown = Reflect.get(parsed, 'day');
        const count: unknown = Reflect.get(parsed, 'count');
        const build: unknown = Reflect.get(parsed, 'build');
        const version: unknown =
          typeof build === 'object' && build !== null ? Reflect.get(build, 'version') : null;
        const commit: unknown =
          typeof build === 'object' && build !== null ? Reflect.get(build, 'commit') : null;
        return {
          day: typeof day === 'string' ? day : '',
          count: typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0,
          build:
            typeof version === 'string' && typeof commit === 'string' ? { version, commit } : null,
        };
      }
    } catch {
      // Storage blocked or not JSON: as if nothing were kept.
    }
    return { day: '', count: 0, build: null };
  }

  private writeKept(kept: Kept): void {
    try {
      this.globals.localStorage?.setItem(DIAGNOSTICS_STORAGE_KEY, JSON.stringify(kept));
    } catch {
      // Storage blocked: the cap counts this page load alone, and every start is a first.
    }
  }

  /** Says `message` in the console once per page load and `key`: the diagnostics never record themselves. */
  private say(key: string, message: string): void {
    if (!this.said.has(key)) {
      this.said.add(key);
      console.warn(`cubetrace: diagnostics: ${message}`);
    }
  }

  private setTimer(callback: () => void, ms: number): number {
    const set =
      this.globals.setTimeout ?? ((cb: () => void, delay: number) => setTimeout(cb, delay));
    return set(callback, ms);
  }

  private clearTimer(handle: number | null): null {
    if (handle !== null) {
      const clear = this.globals.clearTimeout;
      if (clear === undefined) {
        clearTimeout(handle);
      } else {
        clear(handle);
      }
    }
    return null;
  }
}

/** 8 hex digits from the browser's random numbers (or `Math.random` where there are none). */
function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  const random: unknown = Reflect.get(globalThis, 'crypto');
  if (typeof random === 'object' && random !== null && 'getRandomValues' in random) {
    (random as Crypto).getRandomValues(bytes);
  } else {
    for (let k = 0; k < bytes.length; k++) {
      bytes[k] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
