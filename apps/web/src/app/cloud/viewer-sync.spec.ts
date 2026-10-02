import { TestBed } from '@angular/core/testing';
import { USER_SCHEMA, type ViewerChoice, type ViewerChoices } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';
import type { MockInstance } from 'vitest';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage, FakePerformance, FakeTimers, settle } from '../device/fake-browser';
import { SettingsService } from '../settings/settings-service';
import { VIEWER_WRITE_DELAY_MS, ViewerSyncService } from './viewer-sync';

const isUserRecord = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(USER_SCHEMA);

const BEHIND: ViewerChoice = { latitude: 0, longitude: 180, mirror: 'left-right' };
const ABOVE: ViewerChoice = { latitude: 90, longitude: 0, mirror: 'none' };
const TILTED: ViewerChoice = { latitude: 45, longitude: 0, mirror: 'none' };

/** A device of Ada's: its own storage, clock and timers, and its own backend over the account. */
interface Device {
  readonly storage: FakeLocalStorage;
  readonly clock: FakePerformance;
  readonly timers: FakeTimers;
  readonly backend: FakeAccountBackend;
  readonly label: string;
}

describe('ViewerSyncService', () => {
  /** The account's records on the server (users/{uid}), which every device's backend shares. */
  let cloud: Map<string, Record<string, unknown>>;
  let laptop: Device;
  let phone: Device;
  let warn: MockInstance<typeof console.warn>;

  function device(label: string, timeOrigin: number): Device {
    const backend = new FakeAccountBackend();
    backend.users = cloud;
    const clock = new FakePerformance(timeOrigin);
    return {
      storage: new FakeLocalStorage(),
      clock,
      timers: new FakeTimers(clock),
      backend,
      label,
    };
  }

  /** A page load on `on`: the services anew over its storage, clock, timers and backend. */
  function load(on: Device): {
    sync: ViewerSyncService;
    auth: AuthService;
    settings: SettingsService;
  } {
    on.backend.newPage();
    TestBed.resetTestingModule();
    const globals: BrowserGlobals = {
      navigator: { userAgent: 'test' },
      localStorage: on.storage,
      performance: on.clock,
      setTimeout: on.timers.setTimeout,
      clearTimeout: on.timers.clearTimeout,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        { provide: ACCOUNT_LOADER, useValue: on.backend.loader },
      ],
    });
    const settings = TestBed.inject(SettingsService);
    settings.setHostLabel(on.label);
    return {
      sync: TestBed.inject(ViewerSyncService),
      auth: TestBed.inject(AuthService),
      settings,
    };
  }

  /** Lets the account's report, the sync's effects, its merge and the server's answers run. */
  async function settleSync(sync: ViewerSyncService): Promise<void> {
    for (let k = 0; k < 3; k++) {
      await settle();
      TestBed.tick();
      await sync.whenIdle();
      await settle();
    }
  }

  /** The sync sees the changes made, the delay of the writes passes, and the writes settle. */
  async function delay(on: Device, sync: ViewerSyncService): Promise<void> {
    await settle();
    TestBed.tick();
    on.timers.advance(VIEWER_WRITE_DELAY_MS);
    await settleSync(sync);
  }

  async function signIn(auth: AuthService, sync: ViewerSyncService): Promise<void> {
    await auth.signIn();
    await settleSync(sync);
    expect(auth.cloud()?.uid).toBe(ADA.uid);
  }

  /** The account's choices on the server. */
  function viewerInCloud(): ViewerChoices | undefined {
    return cloud.get(ADA.uid)?.['viewer'] as ViewerChoices | undefined;
  }

  /** The account's record on the server as the laptop's sign-in wrote it, with `extra`. */
  function recordInCloud(extra: Record<string, unknown> = {}): void {
    cloud.set(ADA.uid, {
      schema: 1,
      createdMs: ADA.createdMs,
      displayName: ADA.displayName,
      email: ADA.email,
      devices: { 'office-mbp': 1_790_000_000_500 },
      ...extra,
    });
  }

  beforeEach(() => {
    cloud = new Map();
    laptop = device('office-mbp', 1_790_000_000_000);
    phone = device('thinkphone', 1_790_000_500_000);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('does nothing signed out: the account never loads, and nothing is read or written', async () => {
    const { sync, settings } = load(laptop);
    settings.setViewerChoice('laptop', BEHIND);
    await delay(laptop, sync);

    expect(sync.active()).toBe(false);
    expect(sync.error()).toBeNull();
    expect(laptop.backend.loads).toBe(0);
    expect(laptop.backend.reads).toEqual([]);
    expect(laptop.backend.viewerWrites).toEqual([]);
    expect(settings.viewerChoiceFor('laptop')).toEqual(BEHIND);
  });

  it("merges at sign-in: the device keeps the cameras it set, takes the account's others, and writes the account its own", async () => {
    recordInCloud({ viewer: { laptop: ABOVE, 'phone-rear': BEHIND } });
    const { sync, auth, settings } = load(laptop);
    settings.setViewerChoice('laptop', { latitude: 0, longitude: 90, mirror: 'all' });
    settings.setViewerChoice('phone-front', TILTED);
    await signIn(auth, sync);

    expect(sync.active()).toBe(true);
    expect(sync.merging()).toBe(false);
    expect(laptop.backend.reads).toEqual([`user ${ADA.uid}`]);
    expect(settings.viewerChoices()).toEqual({
      laptop: { latitude: 0, longitude: 90, mirror: 'all' },
      'phone-front': TILTED,
      'phone-rear': BEHIND,
    });
    // The sign-in's record carries no choices; the write of the device's own waits for the delay.
    expect(laptop.backend.saved.map((save) => 'viewer' in save.record)).toEqual([false]);
    expect(laptop.backend.viewerWrites).toEqual([]);
    await delay(laptop, sync);
    expect(laptop.backend.viewerWrites).toEqual([`users/${ADA.uid} viewer laptop,phone-front`]);
    expect(viewerInCloud()).toEqual({
      laptop: { latitude: 0, longitude: 90, mirror: 'all' },
      'phone-rear': BEHIND,
      'phone-front': TILTED,
    });
    expect(isUserRecord(cloud.get(ADA.uid)), JSON.stringify(isUserRecord.errors)).toBe(true);
    expect(sync.error()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes a change a second after the last one, several changes in one write, and the same choice never', async () => {
    recordInCloud();
    const { sync, auth, settings } = load(laptop);
    await signIn(auth, sync);
    await delay(laptop, sync);
    expect(laptop.backend.viewerWrites).toEqual([]);

    // A drag: many changes within the second.
    for (let k = 1; k <= 20; k++) {
      settings.setViewerChoice('laptop', { latitude: k, longitude: 2 * k, mirror: 'none' });
      laptop.timers.advance(40);
      await settle();
      TestBed.tick();
    }
    settings.setViewerChoice('phone-rear', ABOVE);
    expect(laptop.backend.viewerWrites).toEqual([]);
    await delay(laptop, sync);
    expect(laptop.backend.viewerWrites).toEqual([`users/${ADA.uid} viewer laptop,phone-rear`]);
    expect(viewerInCloud()).toEqual({
      laptop: { latitude: 20, longitude: 40, mirror: 'none' },
      'phone-rear': ABOVE,
    });

    // The same choice again: no write; a mirror alone: one write of that camera.
    settings.setViewerChoice('laptop', { latitude: 20, longitude: 40, mirror: 'none' });
    await delay(laptop, sync);
    expect(laptop.backend.viewerWrites).toHaveLength(1);
    settings.setViewerChoice('laptop', { latitude: 20, longitude: 40, mirror: 'up-down' });
    await delay(laptop, sync);
    expect(laptop.backend.viewerWrites).toEqual([
      `users/${ADA.uid} viewer laptop,phone-rear`,
      `users/${ADA.uid} viewer laptop`,
    ]);
    expect(viewerInCloud()?.['laptop']).toEqual({ latitude: 20, longitude: 40, mirror: 'up-down' });
  });

  it("says once when the account refuses a write, keeps the device's choice, and tries again at the next change", async () => {
    recordInCloud();
    const { sync, auth, settings } = load(laptop);
    await signIn(auth, sync);
    laptop.backend.saveError = Object.assign(new Error('Missing or insufficient permissions.'), {
      code: 'permission-denied',
    });
    settings.setViewerChoice('laptop', BEHIND);
    await delay(laptop, sync);

    expect(sync.error()).toBe(
      "The clip viewer's choices could not be saved to your account: Missing or insufficient permissions.",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "cubetrace: cloud: The clip viewer's choices could not be saved to your account: Missing or insufficient permissions.",
    );
    expect(settings.viewerChoiceFor('laptop')).toEqual(BEHIND);
    expect(viewerInCloud()).toBeUndefined();

    // The rules take the next change: the refusal clears, and the choice is in the account.
    laptop.backend.saveError = null;
    settings.setViewerChoice('laptop', ABOVE);
    await delay(laptop, sync);
    expect(sync.error()).toBeNull();
    expect(viewerInCloud()).toEqual({ laptop: ABOVE });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("says once when the record cannot be read, writes nothing, and keeps the device's choices", async () => {
    recordInCloud({ viewer: { laptop: ABOVE } });
    laptop.backend.readError = new Error('The client is offline.');
    const { sync, auth, settings } = load(laptop);
    settings.setViewerChoice('laptop', BEHIND);
    await signIn(auth, sync);
    settings.setViewerChoice('phone-rear', TILTED);
    await delay(laptop, sync);

    expect(sync.error()).toBe(
      "The clip viewer's choices of your account could not be read: The client is offline.",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(laptop.backend.viewerWrites).toEqual([]);
    expect(settings.viewerChoices()).toEqual({ laptop: BEHIND, 'phone-rear': TILTED });
    expect(viewerInCloud()).toEqual({ laptop: ABOVE });
  });

  it('merges with an account whose record is not there yet: the device writes its own choices', async () => {
    const { sync, auth, settings } = load(laptop);
    settings.setViewerChoice('laptop', BEHIND);
    laptop.backend.saveError = null;
    await signIn(auth, sync);
    await delay(laptop, sync);

    expect(laptop.backend.reads).toEqual([`user ${ADA.uid}`]);
    expect(viewerInCloud()).toEqual({ laptop: BEHIND });
    expect(isUserRecord(cloud.get(ADA.uid)), JSON.stringify(isUserRecord.errors)).toBe(true);
  });

  it('stops at sign-out, and merges again at the next sign-in; a second device takes the first one’s choices', async () => {
    recordInCloud();
    const { sync, auth, settings } = load(laptop);
    await signIn(auth, sync);
    settings.setViewerChoice('laptop', BEHIND);
    await delay(laptop, sync);
    expect(viewerInCloud()).toEqual({ laptop: BEHIND });

    await auth.signOut();
    await settleSync(sync);
    expect(sync.active()).toBe(false);
    settings.setViewerChoice('phone-rear', ABOVE);
    await delay(laptop, sync);
    expect(laptop.backend.viewerWrites).toHaveLength(1);
    expect(viewerInCloud()).toEqual({ laptop: BEHIND });

    // Signed in again on the same page: merged again, and the change made signed out written.
    await signIn(auth, sync);
    await delay(laptop, sync);
    expect(laptop.backend.reads).toEqual([`user ${ADA.uid}`, `user ${ADA.uid}`]);
    expect(viewerInCloud()).toEqual({ laptop: BEHIND, 'phone-rear': ABOVE });

    // The phone, signed in later with a choice of its own for the laptop's camera, keeps it and
    // writes it, and takes the phone-rear choice made on the laptop.
    const second = load(phone);
    second.settings.setViewerChoice('laptop', TILTED);
    await signIn(second.auth, second.sync);
    expect(second.settings.viewerChoices()).toEqual({ laptop: TILTED, 'phone-rear': ABOVE });
    await delay(phone, second.sync);
    expect(phone.backend.viewerWrites).toEqual([`users/${ADA.uid} viewer laptop`]);
    expect(viewerInCloud()).toEqual({ laptop: TILTED, 'phone-rear': ABOVE });
  });
});
