import { TestBed } from '@angular/core/testing';
import { CLOUD_CUBE_SCHEMA, cloudCube, type CloudCube } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage, FakePerformance, settle } from '../device/fake-browser';
import { SETTINGS_STORAGE_KEY, SettingsService } from '../settings/settings-service';
import { CUBE_SYNC_KEY, CubeSyncService } from './cube-sync';

const isCubeDocument = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(
  CLOUD_CUBE_SCHEMA,
);

const CUBES = `users/${ADA.uid}/cubes`;

/** A device of Ada's: its own storage and clock, and its own backend over the account's cubes. */
interface Device {
  readonly storage: FakeLocalStorage;
  readonly clock: FakePerformance;
  readonly backend: FakeAccountBackend;
  readonly label: string;
}

describe('CubeSyncService', () => {
  /** The account's cubes on the server, which every device's backend shares. */
  let cloud: Map<string, Map<string, CloudCube>>;
  let laptop: Device;
  let phone: Device;

  function device(label: string, timeOrigin: number): Device {
    const backend = new FakeAccountBackend();
    backend.cubes = cloud;
    return {
      storage: new FakeLocalStorage(),
      clock: new FakePerformance(timeOrigin),
      backend,
      label,
    };
  }

  /** A page load on `on`: the services anew over its storage, clock and backend. */
  function load(on: Device): {
    sync: CubeSyncService;
    auth: AuthService;
    settings: SettingsService;
  } {
    on.backend.newPage();
    TestBed.resetTestingModule();
    const globals: BrowserGlobals = {
      navigator: { userAgent: 'test' },
      localStorage: on.storage,
      performance: on.clock,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        { provide: ACCOUNT_LOADER, useValue: on.backend.loader },
      ],
    });
    const settings = TestBed.inject(SettingsService);
    settings.setHostLabel(on.label);
    return { sync: TestBed.inject(CubeSyncService), auth: TestBed.inject(AuthService), settings };
  }

  /** Lets the account's report, the sync's effects, its merge and the server's answers run. */
  async function settleSync(sync: CubeSyncService): Promise<void> {
    for (let k = 0; k < 3; k++) {
      await settle();
      TestBed.tick();
      await sync.whenIdle();
      await settle();
    }
  }

  async function signIn(auth: AuthService, sync: CubeSyncService): Promise<void> {
    await auth.signIn();
    await settleSync(sync);
    expect(auth.cloud()?.uid).toBe(ADA.uid);
  }

  /** The account's cubes on the server, by name. */
  function cubesInCloud(): Record<string, CloudCube> {
    return Object.fromEntries(cloud.get(ADA.uid) ?? new Map<string, CloudCube>());
  }

  /** What the sync keeps on `on` for Ada. */
  function kept(on: Device): { mergedMs: number | null; known: Record<string, number> } {
    const state = JSON.parse(on.storage.getItem(CUBE_SYNC_KEY) ?? '{}') as Record<
      string,
      { mergedMs: number | null; known: Record<string, number> }
    >;
    return state[ADA.uid];
  }

  /** Another device of the account wrote `cube` (on the server, past this device). */
  function writtenElsewhere(cube: CloudCube): void {
    let cubes = cloud.get(ADA.uid);
    if (cubes === undefined) {
      cubes = new Map();
      cloud.set(ADA.uid, cubes);
    }
    cubes.set(cube.name, cube);
  }

  beforeEach(() => {
    cloud = new Map();
    laptop = device('office-mbp', 1_790_000_000_000);
    phone = device('thinkphone', 1_790_000_500_000);
  });

  it('does nothing signed out: the account never loads, and nothing is read or written', async () => {
    const { sync, settings } = load(laptop);
    settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
    settings.removeCubeMac('GAN12ui_AB12');
    await settleSync(sync);

    expect(sync.active()).toBe(false);
    expect(sync.lastMerge()).toBeNull();
    expect(laptop.backend.loads).toBe(0);
    expect(laptop.backend.reads).toEqual([]);
    expect(laptop.backend.cubeWrites).toEqual([]);
    expect(laptop.storage.getItem(CUBE_SYNC_KEY)).toBeNull();
  });

  it("merges at sign-in: this device's cubes go to the account, the account's come to Settings", async () => {
    writtenElsewhere(
      cloudCube({
        name: 'GAN356i3_CD34',
        mac: '11:22:33:44:55:66',
        updatedMs: 1_789_000_000_000,
        device: 'thinkphone',
      }),
    );
    const { sync, auth, settings } = load(laptop);
    settings.saveCubeMac('GAN12ui_AB12', 'ab:12:cd:34:ef:56');
    await signIn(auth, sync);

    expect(laptop.backend.reads).toEqual([`cubes ${ADA.uid}`]);
    expect(laptop.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);
    const written = cubesInCloud()['GAN12ui_AB12'];
    expect(written).toEqual({
      schema: 1,
      name: 'GAN12ui_AB12',
      mac: 'AB:12:CD:34:EF:56',
      updatedMs: laptop.clock.hostMs,
      device: 'office-mbp',
    });
    expect(isCubeDocument(written), JSON.stringify(isCubeDocument.errors)).toBe(true);
    expect(settings.cubeMacs()).toEqual([
      { name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56', updatedMs: laptop.clock.hostMs },
      { name: 'GAN356i3_CD34', mac: '11:22:33:44:55:66', updatedMs: 1_789_000_000_000 },
    ]);
    // Kept in Settings' own storage, as any change of the list.
    expect(JSON.parse(laptop.storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      cubeMacs: settings.cubeMacs(),
    });
    expect(sync.active()).toBe(true);
    expect(sync.lastMerge()).toBe(laptop.clock.hostMs);
    expect(sync.unconfirmed()).toBe(0);
    expect(sync.error()).toBeNull();
    expect(kept(laptop)).toEqual({
      mergedMs: laptop.clock.hostMs,
      known: { GAN12ui_AB12: laptop.clock.hostMs, GAN356i3_CD34: 1_789_000_000_000 },
    });
  });

  it('writes every change of the list while signed in, and deletes the documents of the cubes removed or renamed', async () => {
    const { sync, auth, settings } = load(laptop);
    await signIn(auth, sync);
    expect(laptop.backend.cubeWrites).toEqual([]);

    laptop.clock.advance(1_000);
    settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
    await settleSync(sync);
    expect(laptop.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);

    // Edited (a new address), renamed in case only, then removed: each change follows.
    laptop.clock.advance(1_000);
    settings.saveCubeMac('GAN12ui_AB12', '11:22:33:44:55:66');
    await settleSync(sync);
    laptop.clock.advance(1_000);
    settings.saveCubeMac('gan12ui_ab12', '11:22:33:44:55:66', 'GAN12ui_AB12');
    await settleSync(sync);
    expect(Object.keys(cubesInCloud())).toEqual(['gan12ui_ab12']);
    settings.removeCubeMac('gan12ui_ab12');
    await settleSync(sync);

    expect(laptop.backend.cubeWrites).toEqual([
      `${CUBES}/GAN12ui_AB12`,
      `${CUBES}/GAN12ui_AB12`,
      `${CUBES}/gan12ui_ab12`,
      `delete ${CUBES}/GAN12ui_AB12`,
      `delete ${CUBES}/gan12ui_ab12`,
    ]);
    expect(cubesInCloud()).toEqual({});
    expect(kept(laptop).known).toEqual({});
    // Nothing more to send: a change that changes nothing writes nothing.
    settings.setCubeMacs([]);
    await settleSync(sync);
    expect(laptop.backend.cubeWrites).toHaveLength(5);
  });

  it('brings a MAC address typed on one device to the other at its next start, and a removal too', async () => {
    // The laptop signed in once, its list empty. (One page at a time: a load ends the one before.)
    const first = load(laptop);
    await signIn(first.auth, first.sync);

    // On the phone, signed in, the connect dialog keeps the address it asked for.
    const onPhone = load(phone);
    await signIn(onPhone.auth, onPhone.sync);
    onPhone.settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
    await settleSync(onPhone.sync);
    expect(cubesInCloud()['GAN12ui_AB12'].device).toBe('thinkphone');

    // The laptop starts again (the sign-in remembered): the address is there.
    const onLaptop = load(laptop);
    await settleSync(onLaptop.sync);
    expect(onLaptop.auth.cloud()?.uid).toBe(ADA.uid);
    expect(onLaptop.settings.macFor('gan12ui_ab12')).toBe('AB:12:CD:34:EF:56');
    expect(laptop.backend.cubeWrites).toEqual([]);

    // Removed on the laptop; the phone's next start removes it there too.
    onLaptop.settings.removeCubeMac('GAN12ui_AB12');
    await settleSync(onLaptop.sync);
    expect(cubesInCloud()).toEqual({});
    const reloaded = load(phone);
    await settleSync(reloaded.sync);
    expect(reloaded.settings.cubeMacs()).toEqual([]);
    expect(phone.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);
  });

  it('carries the changes made signed out at the next sign-in: removals deleted, new cubes written', async () => {
    const first = load(laptop);
    first.settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
    first.settings.saveCubeMac('GAN356i3_CD34', '11:22:33:44:55:66');
    await signIn(first.auth, first.sync);
    await first.auth.signOut();
    await settleSync(first.sync);
    expect(first.sync.active()).toBe(false);

    laptop.clock.advance(60_000);
    first.settings.removeCubeMac('GAN12ui_AB12');
    first.settings.saveCubeMac('GANicV2_EF56', '22:33:44:55:66:77');
    await settleSync(first.sync);
    expect(laptop.backend.cubeWrites).toHaveLength(2);

    await signIn(first.auth, first.sync);
    expect(laptop.backend.cubeWrites.slice(2)).toEqual([
      `${CUBES}/GANicV2_EF56`,
      `delete ${CUBES}/GAN12ui_AB12`,
    ]);
    expect(Object.keys(cubesInCloud()).sort()).toEqual(['GAN356i3_CD34', 'GANicV2_EF56']);
    expect(first.settings.cubeMacs().map((entry) => entry.name)).toEqual([
      'GAN356i3_CD34',
      'GANicV2_EF56',
    ]);
  });

  it('keeps the newest copy of a cube changed on two devices, whichever merges first', async () => {
    const onLaptop = load(laptop);
    onLaptop.settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
    await signIn(onLaptop.auth, onLaptop.sync);
    await onLaptop.auth.signOut();
    // Changed on the laptop while signed out, after the phone (whose clock is ahead) changed it.
    writtenElsewhere(
      cloudCube({
        name: 'GAN12ui_AB12',
        mac: '11:11:11:11:11:11',
        updatedMs: laptop.clock.hostMs + 1_000,
        device: 'thinkphone',
      }),
    );
    laptop.clock.advance(5_000);
    onLaptop.settings.saveCubeMac('GAN12ui_AB12', '22:22:22:22:22:22');
    await signIn(onLaptop.auth, onLaptop.sync);
    expect(cubesInCloud()['GAN12ui_AB12'].mac).toBe('22:22:22:22:22:22');

    // The phone changes it later still: the laptop's next start takes it.
    writtenElsewhere(
      cloudCube({
        name: 'GAN12ui_AB12',
        mac: '33:33:33:33:33:33',
        updatedMs: laptop.clock.hostMs + 10_000,
        device: 'thinkphone',
      }),
    );
    const reloaded = load(laptop);
    await settleSync(reloaded.sync);
    expect(reloaded.settings.macFor('GAN12ui_AB12')).toBe('33:33:33:33:33:33');
    expect(cubesInCloud()['GAN12ui_AB12'].mac).toBe('33:33:33:33:33:33');
  });

  it('never waits for the server: offline, the writes wait, Settings says so, and they are confirmed later', async () => {
    const { sync, auth, settings } = load(laptop);
    laptop.backend.online = false;
    await signIn(auth, sync);
    // Merged with this device's copy of the account's list, which is empty.
    expect(sync.offline()).toBe(true);
    expect(sync.lastMerge()).toBeNull();

    settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
    await settleSync(sync);
    // Firestore applied it to its cache at once.
    expect(laptop.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);
    expect(sync.unconfirmed()).toBe(1);
    expect(kept(laptop).known).toEqual({});

    // Signed out, nothing waits for the page; signed in again, the write still does, and is not
    // sent twice: Firestore keeps it for the account.
    await auth.signOut();
    await settleSync(sync);
    expect(sync.unconfirmed()).toBe(0);
    await signIn(auth, sync);
    expect(sync.unconfirmed()).toBe(1);
    expect(laptop.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);

    laptop.backend.goOnline();
    await settleSync(sync);
    expect(sync.unconfirmed()).toBe(0);
    expect(kept(laptop).known).toEqual({ GAN12ui_AB12: laptop.clock.hostMs });
    expect(sync.error()).toBeNull();
  });

  it("does not take a cube missing from this device's cache for a deletion", async () => {
    const first = load(laptop);
    first.settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
    await signIn(first.auth, first.sync);
    // Next start offline, with a cache that lost the document: the cube stays, and is not written.
    cloud.get(ADA.uid)?.clear();
    laptop.backend.online = false;
    const offline = load(laptop);
    await settleSync(offline.sync);
    expect(offline.sync.offline()).toBe(true);
    expect(offline.settings.macFor('GAN12ui_AB12')).toBe('AB:12:CD:34:EF:56');
    expect(laptop.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);
  });

  it('says a write the server refuses, once in the console, and keeps the list as it is', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { sync, auth, settings } = load(laptop);
      await signIn(auth, sync);
      laptop.backend.cubeError = Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      });
      settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
      await settleSync(sync);
      const message =
        'The cube GAN12ui_AB12 could not be saved to your account: Missing or insufficient permissions.';
      expect(sync.error()).toBe(message);
      expect(settings.macFor('GAN12ui_AB12')).toBe('AB:12:CD:34:EF:56');
      expect(sync.unconfirmed()).toBe(0);

      // The next change of the list tries again; the console hears of it once.
      laptop.clock.advance(1_000);
      settings.saveCubeMac('GAN12ui_AB12', '11:22:33:44:55:66');
      await settleSync(sync);
      expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
        `cubetrace: cloud: ${message}`,
      ]);
      laptop.backend.cubeError = null;
      laptop.clock.advance(1_000);
      settings.saveCubeMac('GAN356i3_CD34', '22:22:22:22:22:22');
      await settleSync(sync);
      expect(Object.keys(cubesInCloud()).sort()).toEqual(['GAN12ui_AB12', 'GAN356i3_CD34']);
      // Saved at last: the refusal no longer stands.
      expect(sync.error()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps on this device a cube whose name cannot name a document, and says so while it is listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { sync, auth, settings } = load(laptop);
      await signIn(auth, sync);
      settings.saveCubeMac('GAN/12', 'AB:12:CD:34:EF:56');
      settings.saveCubeMac('GAN12ui_AB12', '11:22:33:44:55:66');
      await settleSync(sync);
      expect(laptop.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);
      expect(sync.error()).toBe(
        'The cube GAN/12 stays on this device: its name cannot name a document.',
      );
      settings.removeCubeMac('GAN/12');
      await settleSync(sync);
      expect(sync.error()).toBeNull();
      expect(laptop.backend.cubeWrites).toEqual([`${CUBES}/GAN12ui_AB12`]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("says that the account's list could not be read, and then writes nothing", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { sync, auth, settings } = load(laptop);
      settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');
      laptop.backend.readError = new Error('Missing or insufficient permissions.');
      await signIn(auth, sync);
      expect(sync.error()).toBe(
        'The cubes of your account could not be read: Missing or insufficient permissions.',
      );
      expect(sync.lastMerge()).toBeNull();
      settings.saveCubeMac('GAN356i3_CD34', '22:22:22:22:22:22');
      await settleSync(sync);
      expect(laptop.backend.cubeWrites).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves alone a cube whose document is of another version, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const newer = {
        ...cloudCube({ name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56', updatedMs: 1, device: 'x' }),
        schema: 2,
      };
      writtenElsewhere(newer as unknown as CloudCube);
      const { sync, auth, settings } = load(laptop);
      settings.saveCubeMac('GAN12ui_AB12', '11:22:33:44:55:66');
      await signIn(auth, sync);

      expect(laptop.backend.cubeWrites).toEqual([]);
      expect(cubesInCloud()['GAN12ui_AB12']).toEqual(newer);
      expect(settings.macFor('GAN12ui_AB12')).toBe('11:22:33:44:55:66');
      expect(sync.error()).toBe(
        'The cube GAN12ui_AB12 of your account is left as it is: users/{uid}/cubes/{name}: schema must be 1, got 2.',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('sends the addresses kept by 0.2.0, dated when this version first read them', async () => {
    // What the ThinkPhone stored in manual round 1.
    phone.storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        cubeMacs: [{ name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56' }],
      }),
    );
    const { sync, auth } = load(phone);
    const migratedAt = phone.clock.hostMs;
    phone.clock.advance(30_000);
    await signIn(auth, sync);
    expect(cubesInCloud()['GAN12ui_AB12']).toEqual({
      schema: 1,
      name: 'GAN12ui_AB12',
      mac: 'AB:12:CD:34:EF:56',
      updatedMs: migratedAt,
      device: 'thinkphone',
    });
  });
});
