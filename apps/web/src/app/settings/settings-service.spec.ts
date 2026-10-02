import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage, FakePerformance } from '../device/fake-browser';
import { SETTINGS_STORAGE_KEY, SettingsService, defaultHostLabel } from './settings-service';

const MAC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';

describe('SettingsService', () => {
  let storage: FakeLocalStorage;
  /** The host clock: the cube entries' times (T3.4). */
  let clock: FakePerformance;

  /** A new service over `globals`, as after a page load. */
  function load(
    globals: BrowserGlobals = {
      navigator: { userAgent: MAC_USER_AGENT },
      localStorage: storage,
      performance: clock,
    },
  ): SettingsService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: globals }],
    });
    return TestBed.inject(SettingsService);
  }

  function stored(): unknown {
    return JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
  }

  beforeEach(() => {
    storage = new FakeLocalStorage();
    clock = new FakePerformance();
  });

  it('starts from the defaults', () => {
    const settings = load();

    expect(settings.hostLabel()).toBe('macOS laptop');
    expect(settings.customHostLabel()).toBeNull();
    expect(settings.cubeMacs()).toEqual([]);
    expect(settings.demoSpeed()).toBe(1);
    expect(settings.inspection()).toBe(false);
    expect(settings.autoAdvance()).toBe(true);
    expect(settings.scrambleOverPicture()).toBe(true);
    expect(settings.idleDisconnectMinutes()).toBe(5);
    expect(settings.cameraOn()).toBe(false);
    expect(settings.cameraResolution()).toBe('1080p');
    expect(settings.cameraFrameRate()).toBe('best');
    expect(settings.sharpnessThreshold()).toBe(20);
    expect(settings.recordAudio()).toBe(true);
    expect(settings.microphoneProcessing()).toBe('raw');
    expect(settings.videoQuality()).toBe('standard');
    expect(settings.cameraSettingsOpen()).toBeNull();
    expect(settings.cameraPickFor('macOS laptop')).toBeNull();
    expect(settings.cameraControlsFor('FaceTime HD Camera')).toEqual({});
    expect(settings.cameraFramings()).toEqual([]);
    expect(settings.uploadSessions()).toBe(true);
    expect(settings.keepLocalCopies()).toBe(true);
    expect(settings.diagnostics()).toBe(true);
    expect(settings.networkTypeKnown).toBe(false);
    expect(settings.wifiOnly()).toBe(false);
    expect(settings.saveError()).toBeNull();
    expect(storage.length).toBe(0);
  });

  it("gives the uploads a phone's defaults on a phone: Wi-Fi only where the network's type is known, no local copies", () => {
    const phone =
      'Mozilla/5.0 (Linux; Android 15; motorola edge 50 neo) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
    const connection = Object.assign(new EventTarget(), { type: 'cellular', effectiveType: '4g' });
    const settings = load({
      navigator: { userAgent: phone, connection } as Partial<Navigator>,
      localStorage: storage,
    });
    expect(settings.isPhone).toBe(true);
    expect(settings.networkTypeKnown).toBe(true);
    expect(settings.wifiOnlySetting()).toBe(true);
    expect(settings.wifiOnly()).toBe(true);
    expect(settings.keepLocalCopies()).toBe(false);
    settings.setWifiOnly(false);
    settings.setKeepLocalCopies(true);
    expect(settings.wifiOnly()).toBe(false);
    expect(settings.keepLocalCopies()).toBe(true);

    // A phone whose browser does not say the network's type: Wi-Fi only cannot be honoured.
    const blind = load({ navigator: { userAgent: phone }, localStorage: new FakeLocalStorage() });
    expect(blind.networkTypeKnown).toBe(false);
    expect(blind.wifiOnlySetting()).toBe(true);
    expect(blind.wifiOnly()).toBe(false);
    // A laptop's browser that has navigator.connection without a type (desktop Chrome).
    const laptop = load({
      navigator: {
        userAgent: MAC_USER_AGENT,
        connection: Object.assign(new EventTarget(), { effectiveType: '4g' }),
      } as Partial<Navigator>,
      localStorage: new FakeLocalStorage(),
    });
    expect(laptop.networkTypeKnown).toBe(false);
    expect(laptop.wifiOnly()).toBe(false);
    expect(laptop.keepLocalCopies()).toBe(true);
  });

  it('keeps every setting across a reload, in localStorage', () => {
    const settings = load();
    settings.setHostLabel('  office-mbp ');
    settings.saveCubeMac('GAN12ui_AB12', 'ab-12-cd-34-ef-56');
    expect(settings.setDemoSpeed(20)).toBe(true);
    settings.setInspection(true);
    settings.setAutoAdvance(false);
    settings.setScrambleOverPicture(false);
    expect(settings.setIdleDisconnectMinutes(12)).toBe(true);
    settings.setCameraOn(true);
    settings.setCameraResolution('720p');
    settings.setCameraFrameRate('60');
    expect(settings.setSharpnessThreshold(35.5)).toBe(true);
    settings.setRecordAudio(false);
    settings.setMicrophoneProcessing('voice');
    settings.setVideoQuality('high');
    settings.setCameraSettingsOpen(false);
    settings.setCameraPick('office-mbp', 'id-1', 'FaceTime HD Camera');
    settings.setCameraControls('camera 0, facing back', { exposureMode: 'manual', iso: 400 });
    settings.setCameraFraming(
      'FaceTime HD Camera',
      { width: 1920, height: 1080 },
      { x: 480, y: 270, w: 960, h: 540 },
    );
    settings.setUploadSessions(false);
    settings.setWifiOnly(true);
    settings.setKeepLocalCopies(false);
    settings.setDiagnostics(false);

    expect(stored()).toEqual({
      version: 2,
      hostLabel: 'office-mbp',
      cubeMacs: [{ name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56', updatedMs: clock.hostMs }],
      demoSpeed: 20,
      inspection: true,
      autoAdvance: false,
      scrambleOverPicture: false,
      idleDisconnectMinutes: 12,
      cameraOn: true,
      cameraResolution: '720p',
      cameraFrameRate: '60',
      sharpnessThreshold: 35.5,
      recordAudio: false,
      microphoneProcessing: 'voice',
      videoQuality: 'high',
      cameraSettingsOpen: false,
      cameraPicks: [{ host: 'office-mbp', deviceId: 'id-1', label: 'FaceTime HD Camera' }],
      cameraControls: [
        { camera: 'camera 0, facing back', values: { exposureMode: 'manual', iso: 400 } },
      ],
      cameraFramings: [
        {
          camera: 'FaceTime HD Camera',
          width: 1920,
          height: 1080,
          rect: { x: 480, y: 270, w: 960, h: 540 },
        },
      ],
      uploadSessions: false,
      wifiOnly: true,
      keepLocalCopies: false,
      diagnostics: false,
    });
    const reloaded = load();
    expect(reloaded.uploadSessions()).toBe(false);
    expect(reloaded.diagnostics()).toBe(false);
    expect(reloaded.wifiOnlySetting()).toBe(true);
    // A laptop's browser does not say the network's type: it uploads on any network.
    expect(reloaded.wifiOnly()).toBe(false);
    expect(reloaded.keepLocalCopies()).toBe(false);
    expect(reloaded.hostLabel()).toBe('office-mbp');
    expect(reloaded.cubeMacs()).toEqual([
      { name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56', updatedMs: clock.hostMs },
    ]);
    expect(reloaded.demoSpeed()).toBe(20);
    expect(reloaded.inspection()).toBe(true);
    expect(reloaded.autoAdvance()).toBe(false);
    expect(reloaded.scrambleOverPicture()).toBe(false);
    expect(reloaded.idleDisconnectMinutes()).toBe(12);
    expect(reloaded.cameraOn()).toBe(true);
    expect(reloaded.cameraResolution()).toBe('720p');
    expect(reloaded.cameraFrameRate()).toBe('60');
    expect(reloaded.sharpnessThreshold()).toBe(35.5);
    expect(reloaded.recordAudio()).toBe(false);
    expect(reloaded.microphoneProcessing()).toBe('voice');
    expect(reloaded.videoQuality()).toBe('high');
    expect(reloaded.cameraSettingsOpen()).toBe(false);
    expect(reloaded.cameraPickFor('office-mbp')).toEqual({
      host: 'office-mbp',
      deviceId: 'id-1',
      label: 'FaceTime HD Camera',
    });
    expect(reloaded.cameraControlsFor('camera 0, facing back')).toEqual({
      exposureMode: 'manual',
      iso: 400,
    });
    expect(reloaded.cameraFramingsOf('FaceTime HD Camera')).toEqual([
      {
        camera: 'FaceTime HD Camera',
        width: 1920,
        height: 1080,
        rect: { x: 480, y: 270, w: 960, h: 540 },
      },
    ]);
  });

  it('keeps the camera chosen on each host, and forgets nothing else when it changes', () => {
    const settings = load();
    settings.setCameraPick('macOS laptop', 'id-1', 'FaceTime HD Camera');
    settings.setCameraPick('thinkphone', 'id-2', 'camera 0, facing back');
    settings.setCameraPick('macOS laptop', 'id-3', 'USB webcam');

    expect(settings.cameraPickFor('macOS laptop')).toEqual({
      host: 'macOS laptop',
      deviceId: 'id-3',
      label: 'USB webcam',
    });
    expect(settings.cameraPickFor('thinkphone')?.deviceId).toBe('id-2');
    expect(load().cameraPickFor('macOS laptop')?.deviceId).toBe('id-3');
  });

  it('keeps manual controls per camera, never the torch, and forgets them when emptied', () => {
    const settings = load();
    settings.setCameraControls('camera 0, facing back', {
      exposureMode: 'manual',
      exposureTime: 20,
      zoom: 2,
      torch: true,
    });
    settings.setCameraControls('camera 1, facing front', { focusMode: 'manual' });

    expect(settings.cameraControlsFor('camera 0, facing back')).toEqual({
      exposureMode: 'manual',
      exposureTime: 20,
      zoom: 2,
    });
    settings.setCameraControls('camera 0, facing back', { torch: true });
    expect(settings.cameraControlsFor('camera 0, facing back')).toEqual({});
    expect(load().cameraControlsFor('camera 1, facing front')).toEqual({ focusMode: 'manual' });
  });

  it('keeps a framing rectangle per camera and frame size, the newest last', () => {
    const settings = load();
    const hd = { width: 1920, height: 1080 };
    settings.setCameraFraming('cam', hd, { x: 0, y: 0, w: 100, h: 100 });
    settings.setCameraFraming('cam', { width: 1080, height: 1920 }, { x: 5, y: 5, w: 200, h: 200 });
    settings.setCameraFraming('other', hd, { x: 1, y: 2, w: 300, h: 400 });
    settings.setCameraFraming('cam', hd, { x: 10, y: 20, w: 500, h: 400 });

    expect(settings.cameraFramingsOf('cam')).toEqual([
      { camera: 'cam', width: 1080, height: 1920, rect: { x: 5, y: 5, w: 200, h: 200 } },
      { camera: 'cam', width: 1920, height: 1080, rect: { x: 10, y: 20, w: 500, h: 400 } },
    ]);
    expect(settings.cameraFramings()).toHaveLength(3);

    // At most 24 are kept: the oldest go.
    for (let i = 0; i < 30; i++) {
      settings.setCameraFraming(`cam ${String(i)}`, hd, { x: 0, y: 0, w: 100, h: 100 });
    }
    expect(settings.cameraFramings()).toHaveLength(24);
    expect(settings.cameraFramingsOf('cam')).toEqual([]);
    expect(settings.cameraFramingsOf('cam 29')).toHaveLength(1);
  });

  it('takes a sharpness threshold above 0, up to 100000', () => {
    const settings = load();

    for (const threshold of [0, -3, 100_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(settings.setSharpnessThreshold(threshold)).toBe(false);
    }
    expect(settings.sharpnessThreshold()).toBe(20);
    expect(settings.setSharpnessThreshold(0.5)).toBe(true);
    expect(load().sharpnessThreshold()).toBe(0.5);
  });

  it('drops stored camera settings that are not valid, entry by entry', () => {
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        cameraOn: 'yes',
        cameraResolution: '4k',
        cameraFrameRate: 120,
        sharpnessThreshold: -1,
        recordAudio: 'no',
        microphoneProcessing: 'studio',
        videoQuality: 'ultra',
        cameraSettingsOpen: 'open',
        cameraPicks: [{ host: 'a', deviceId: '' }, { host: 'b', deviceId: 'id' }, 'c'],
        cameraControls: [
          { camera: 'x', values: { exposureMode: 'sometimes', iso: 'high', zoom: 2, torch: true } },
          { camera: 'y', values: { focusMode: 'fast' } },
          { values: { zoom: 1 } },
        ],
        cameraFramings: [
          { camera: 'x', width: 1920, height: 1080, rect: { x: 0, y: 0, w: 1920, h: 1080 } },
          { camera: 'y', width: 1920, height: 1080, rect: { x: 100, y: 0, w: 1920, h: 1080 } },
          { camera: 'z', width: 1920, height: 1080, rect: { x: 0.5, y: 0, w: 10, h: 10 } },
          { camera: 'w', width: 0, height: 1080, rect: { x: 0, y: 0, w: 1, h: 1 } },
        ],
      }),
    );
    const settings = load();

    expect(settings.cameraOn()).toBe(false);
    expect(settings.cameraResolution()).toBe('1080p');
    expect(settings.cameraFrameRate()).toBe('best');
    expect(settings.sharpnessThreshold()).toBe(20);
    expect(settings.recordAudio()).toBe(true);
    expect(settings.microphoneProcessing()).toBe('raw');
    expect(settings.videoQuality()).toBe('standard');
    expect(settings.cameraSettingsOpen()).toBeNull();
    expect(settings.cameraPickFor('a')).toBeNull();
    expect(settings.cameraPickFor('b')).toEqual({ host: 'b', deviceId: 'id', label: '' });
    expect(settings.cameraControlsFor('x')).toEqual({ zoom: 2 });
    expect(settings.cameraControlsFor('y')).toEqual({});
    expect(settings.cameraFramings().map((entry) => entry.camera)).toEqual(['x']);
  });

  it('reads the settings stored before the video quality existed as Standard, the rest as stored', () => {
    // What 0.2.0 stored before T2.10: every camera setting but the video quality.
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        cameraOn: true,
        cameraResolution: '720p',
        cameraFrameRate: '30',
        sharpnessThreshold: 30,
        recordAudio: false,
        cameraSettingsOpen: true,
      }),
    );
    const settings = load();

    expect(settings.videoQuality()).toBe('standard');
    expect(settings.cameraOn()).toBe(true);
    expect(settings.cameraResolution()).toBe('720p');
    expect(settings.cameraFrameRate()).toBe('30');
    expect(settings.recordAudio()).toBe(false);

    settings.setVideoQuality('maximum');
    expect(stored()).toMatchObject({ videoQuality: 'maximum', cameraResolution: '720p' });
    expect(load().videoQuality()).toBe('maximum');
    load().setVideoQuality('standard');
    expect(load().videoQuality()).toBe('standard');
    expect(stored()).toMatchObject({ videoQuality: 'standard' });
  });

  it('reads the settings stored before Scramble over the picture existed as on, and a value that is not a switch as on', () => {
    // What 0.2.0 stored before T2.13: the timer's other settings, and the camera on.
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        inspection: true,
        autoAdvance: false,
        cameraOn: true,
        videoQuality: 'high',
      }),
    );
    const settings = load();

    expect(settings.scrambleOverPicture()).toBe(true);
    expect(settings.inspection()).toBe(true);
    expect(settings.autoAdvance()).toBe(false);
    expect(settings.cameraOn()).toBe(true);

    settings.setScrambleOverPicture(false);
    expect(stored()).toMatchObject({ scrambleOverPicture: false, videoQuality: 'high' });
    expect(load().scrambleOverPicture()).toBe(false);
    load().setScrambleOverPicture(true);
    expect(load().scrambleOverPicture()).toBe(true);

    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ scrambleOverPicture: 'off' }));
    expect(load().scrambleOverPicture()).toBe(true);
  });

  it('reads the settings stored before the microphone setting existed as Raw, the rest as stored', () => {
    // What 0.2.0 stored before T2.12: the video quality, but no microphone setting.
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        cameraOn: true,
        recordAudio: true,
        videoQuality: 'high',
        cameraSettingsOpen: true,
      }),
    );
    const settings = load();

    expect(settings.microphoneProcessing()).toBe('raw');
    expect(settings.recordAudio()).toBe(true);
    expect(settings.videoQuality()).toBe('high');
    expect(settings.cameraOn()).toBe(true);
    // Nothing is written by reading.
    expect(stored()).not.toHaveProperty('microphoneProcessing');

    settings.setMicrophoneProcessing('voice');
    expect(stored()).toMatchObject({ microphoneProcessing: 'voice', videoQuality: 'high' });
    expect(load().microphoneProcessing()).toBe('voice');
    load().setMicrophoneProcessing('raw');
    expect(load().microphoneProcessing()).toBe('raw');
    expect(stored()).toMatchObject({ microphoneProcessing: 'raw' });
  });

  it('stores MAC addresses normalized, sorted by name, and refuses what is not one', () => {
    const settings = load();

    expect(settings.saveCubeMac('GAN356i3_Z', 'ab12cd34ef56')).toEqual({
      ok: true,
      entry: { name: 'GAN356i3_Z', mac: 'AB:12:CD:34:EF:56', updatedMs: clock.hostMs },
    });
    clock.advance(1_000);
    expect(settings.saveCubeMac('GAN12ui_A', 'Ab:12:cD:34:eF:57').ok).toBe(true);
    const refused = settings.saveCubeMac('GAN12ui_B', 'AB:12:CD:34:EF');
    expect(refused).toEqual({
      ok: false,
      error: expect.stringContaining('"AB:12:CD:34:EF" is not a MAC address') as unknown,
    });
    expect(settings.saveCubeMac('   ', 'AB:12:CD:34:EF:56').ok).toBe(false);

    expect(settings.cubeMacs()).toEqual([
      { name: 'GAN12ui_A', mac: 'AB:12:CD:34:EF:57', updatedMs: clock.hostMs },
      { name: 'GAN356i3_Z', mac: 'AB:12:CD:34:EF:56', updatedMs: clock.hostMs - 1_000 },
    ]);
  });

  it('finds, edits and removes MAC addresses by name, ignoring case', () => {
    const settings = load();
    settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');

    expect(settings.macFor('gan12UI_ab12')).toBe('AB:12:CD:34:EF:56');
    expect(settings.macFor('GAN12ui_FFFF')).toBeNull();
    expect(settings.macFor(null)).toBeNull();

    // The same name again replaces the address; editing may rename the entry. Each change is later
    // than the entry it replaces, even within the same millisecond.
    clock.advance(60_000);
    settings.saveCubeMac('gan12ui_ab12', '11:22:33:44:55:66');
    expect(settings.cubeMacs()).toEqual([
      { name: 'gan12ui_ab12', mac: '11:22:33:44:55:66', updatedMs: clock.hostMs },
    ]);
    settings.saveCubeMac('GAN12ui_CD34', '11:22:33:44:55:66', 'gan12ui_ab12');
    expect(settings.cubeMacs()).toEqual([
      { name: 'GAN12ui_CD34', mac: '11:22:33:44:55:66', updatedMs: clock.hostMs + 1 },
    ]);

    settings.removeCubeMac('gan12ui_cd34');
    expect(settings.cubeMacs()).toEqual([]);
    expect(load().cubeMacs()).toEqual([]);
  });

  it('dates the MAC addresses stored before T3.4 at their first read, and keeps that date', () => {
    // What 0.2.0 stored: version 1, entries without updatedMs.
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        hostLabel: 'thinkphone',
        cubeMacs: [
          { name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56' },
          { name: 'GAN356i3_Z', mac: '11:22:33:44:55:66', updatedMs: 1_700_000_000_000 },
        ],
        inspection: true,
      }),
    );
    const migratedAt = clock.hostMs;
    const settings = load();

    const migrated = [
      { name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56', updatedMs: migratedAt },
      { name: 'GAN356i3_Z', mac: '11:22:33:44:55:66', updatedMs: 1_700_000_000_000 },
    ];
    expect(settings.cubeMacs()).toEqual(migrated);
    expect(settings.saveError()).toBeNull();
    // Written back at once, with the rest as it was: a later read finds the same time.
    expect(stored()).toMatchObject({
      version: 2,
      hostLabel: 'thinkphone',
      cubeMacs: migrated,
      inspection: true,
    });
    clock.advance(86_400_000);
    expect(load().cubeMacs()).toEqual(migrated);
    expect(load().hostLabel()).toBe('thinkphone');
  });

  it('dates a stored entry whose time is not one when it reads it, and writes nothing otherwise', () => {
    const entries = [
      { name: 'A', mac: 'AB:12:CD:34:EF:56', updatedMs: -5 },
      { name: 'B', mac: 'AB:12:CD:34:EF:57', updatedMs: 'yesterday' },
      { name: 'C', mac: 'AB:12:CD:34:EF:58', updatedMs: 1_790_000_000_000.5 },
    ];
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ version: 2, cubeMacs: entries }));
    clock.advance(42);

    expect(
      load()
        .cubeMacs()
        .map((entry) => entry.updatedMs),
    ).toEqual([clock.hostMs, clock.hostMs, 1_790_000_000_000.5]);
    const kept = storage.getItem(SETTINGS_STORAGE_KEY);
    storage.failWith = new DOMException('No writes expected.', 'InvalidStateError');
    expect(load().saveError()).toBeNull();
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBe(kept);
  });

  it('dates an edit later than the entry it replaces, even when that one is from a clock ahead', () => {
    const settings = load();
    // As a merge with the account's list left it (T3.4): a copy changed on a device whose clock is
    // an hour ahead.
    const ahead = clock.hostMs + 3_600_000;
    settings.setCubeMacs([
      { name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56', updatedMs: ahead },
      { name: 'gan12ui_ab12', mac: 'ab:12:cd:34:ef:57', updatedMs: ahead - 1 },
      { name: 'GAN356i3_Z', mac: 'zz', updatedMs: 1 },
    ]);
    // One entry per name ignoring case (the later in the list), normalized; anything else dropped.
    expect(settings.cubeMacs()).toEqual([
      { name: 'gan12ui_ab12', mac: 'AB:12:CD:34:EF:57', updatedMs: ahead - 1 },
    ]);
    expect(load().cubeMacs()).toEqual(settings.cubeMacs());

    expect(settings.saveCubeMac('GAN12ui_AB12', '11:22:33:44:55:66')).toEqual({
      ok: true,
      entry: { name: 'GAN12ui_AB12', mac: '11:22:33:44:55:66', updatedMs: ahead },
    });
  });

  it('restores the default host label when it is emptied', () => {
    const settings = load();
    settings.setHostLabel('office-mbp');
    settings.setHostLabel('   ');

    expect(settings.hostLabel()).toBe('macOS laptop');
    expect(settings.customHostLabel()).toBeNull();
  });

  it('refuses a demo speed outside 0.1 to 100', () => {
    const settings = load();

    for (const speed of [0, 0.05, 101, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(settings.setDemoSpeed(speed)).toBe(false);
    }
    expect(settings.setDemoSpeed(0.5)).toBe(true);
    expect(settings.demoSpeed()).toBe(0.5);
  });

  it('takes a whole number of idle minutes from 0 (never) to 60', () => {
    const settings = load();

    for (const minutes of [-1, 61, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(settings.setIdleDisconnectMinutes(minutes)).toBe(false);
    }
    expect(settings.idleDisconnectMinutes()).toBe(5);
    expect(settings.setIdleDisconnectMinutes(0)).toBe(true);
    expect(settings.idleDisconnectMinutes()).toBe(0);
    expect(settings.setIdleDisconnectMinutes(60)).toBe(true);
    expect(load().idleDisconnectMinutes()).toBe(60);
  });

  it('keeps the valid stored values and drops the others one by one', () => {
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        hostLabel: 42,
        cubeMacs: [
          { name: 'Bad', mac: 'zz' },
          { name: 'GAN12ui_AB12', mac: 'ab12cd34ef56' },
          { mac: '11:22:33:44:55:66' },
          'GAN356',
        ],
        demoSpeed: 0,
        inspection: 'yes',
        autoAdvance: false,
        idleDisconnectMinutes: 90,
      }),
    );
    const settings = load();

    expect(settings.hostLabel()).toBe('macOS laptop');
    expect(settings.cubeMacs()).toEqual([
      { name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56', updatedMs: clock.hostMs },
    ]);
    expect(settings.demoSpeed()).toBe(1);
    expect(settings.inspection()).toBe(false);
    expect(settings.autoAdvance()).toBe(false);
    expect(settings.idleDisconnectMinutes()).toBe(5);
  });

  it('starts from the defaults when the stored text is not JSON', () => {
    storage.setItem(SETTINGS_STORAGE_KEY, '{not json');

    expect(load().autoAdvance()).toBe(true);
  });

  it('says so when the settings cannot be saved, and keeps them for the page', () => {
    const settings = load();
    storage.failWith = new DOMException('The quota has been exceeded.', 'QuotaExceededError');

    settings.setInspection(true);
    expect(settings.inspection()).toBe(true);
    expect(settings.saveError()).toBe(
      'The settings could not be saved (The quota has been exceeded.): they last until the page closes.',
    );

    storage.failWith = null;
    settings.setInspection(false);
    expect(settings.saveError()).toBeNull();
  });

  it('works without localStorage, and without a readable one', () => {
    const settings = load({ navigator: { userAgent: MAC_USER_AGENT } });
    settings.setAutoAdvance(false);
    expect(settings.autoAdvance()).toBe(false);
    expect(settings.saveError()).toContain('does not let cubetrace store its settings');

    // Chrome throws on reading window.localStorage when the user blocks site data.
    const blocked: BrowserGlobals = {
      get localStorage(): Storage {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    };
    expect(load(blocked).demoSpeed()).toBe(1);
  });
});

describe('defaultHostLabel', () => {
  function withHints(platform: string, mobile: boolean): Partial<Navigator> {
    const navigator = { userAgent: '', userAgentData: { platform, mobile } };
    return navigator;
  }

  it.each([
    ['Android', true, 'Android phone'],
    ['Android', false, 'Android tablet'],
    ['macOS', false, 'macOS laptop'],
    ['Windows', false, 'Windows laptop'],
    ['Linux', false, 'Linux laptop'],
    ['Chrome OS', false, 'Chromebook'],
    ['Fuchsia', false, 'Laptop'],
  ])('names %s (mobile: %s) from the client hints: %s', (platform, mobile, label) => {
    expect(defaultHostLabel(withHints(platform, mobile))).toBe(label);
  });

  it.each([
    [
      'Mozilla/5.0 (Linux; Android 14; motorola edge 50 fusion) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Android phone',
    ],
    [MAC_USER_AGENT, 'macOS laptop'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Windows laptop',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Linux laptop',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chromebook',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
      'iPhone',
    ],
  ])('names the user agent %s: %s', (userAgent, label) => {
    expect(defaultHostLabel({ userAgent })).toBe(label);
  });

  it('falls back to "Laptop" without a navigator', () => {
    expect(defaultHostLabel(undefined)).toBe('Laptop');
  });
});
