import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage } from '../device/fake-browser';
import { SETTINGS_STORAGE_KEY, SettingsService, defaultHostLabel } from './settings-service';

const MAC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';

describe('SettingsService', () => {
  let storage: FakeLocalStorage;

  /** A new service over `globals`, as after a page load. */
  function load(
    globals: BrowserGlobals = { navigator: { userAgent: MAC_USER_AGENT }, localStorage: storage },
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
  });

  it('starts from the defaults', () => {
    const settings = load();

    expect(settings.hostLabel()).toBe('macOS laptop');
    expect(settings.customHostLabel()).toBeNull();
    expect(settings.cubeMacs()).toEqual([]);
    expect(settings.demoSpeed()).toBe(1);
    expect(settings.inspection()).toBe(false);
    expect(settings.autoAdvance()).toBe(true);
    expect(settings.idleDisconnectMinutes()).toBe(5);
    expect(settings.saveError()).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('keeps every setting across a reload, in localStorage', () => {
    const settings = load();
    settings.setHostLabel('  office-mbp ');
    settings.saveCubeMac('GAN12ui_AB12', 'ab-12-cd-34-ef-56');
    expect(settings.setDemoSpeed(20)).toBe(true);
    settings.setInspection(true);
    settings.setAutoAdvance(false);
    expect(settings.setIdleDisconnectMinutes(12)).toBe(true);

    expect(stored()).toEqual({
      version: 1,
      hostLabel: 'office-mbp',
      cubeMacs: [{ name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56' }],
      demoSpeed: 20,
      inspection: true,
      autoAdvance: false,
      idleDisconnectMinutes: 12,
    });
    const reloaded = load();
    expect(reloaded.hostLabel()).toBe('office-mbp');
    expect(reloaded.cubeMacs()).toEqual([{ name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56' }]);
    expect(reloaded.demoSpeed()).toBe(20);
    expect(reloaded.inspection()).toBe(true);
    expect(reloaded.autoAdvance()).toBe(false);
    expect(reloaded.idleDisconnectMinutes()).toBe(12);
  });

  it('stores MAC addresses normalized, sorted by name, and refuses what is not one', () => {
    const settings = load();

    expect(settings.saveCubeMac('GAN356i3_Z', 'ab12cd34ef56')).toEqual({
      ok: true,
      entry: { name: 'GAN356i3_Z', mac: 'AB:12:CD:34:EF:56' },
    });
    expect(settings.saveCubeMac('GAN12ui_A', 'Ab:12:cD:34:eF:57').ok).toBe(true);
    const refused = settings.saveCubeMac('GAN12ui_B', 'AB:12:CD:34:EF');
    expect(refused).toEqual({
      ok: false,
      error: expect.stringContaining('"AB:12:CD:34:EF" is not a MAC address') as unknown,
    });
    expect(settings.saveCubeMac('   ', 'AB:12:CD:34:EF:56').ok).toBe(false);

    expect(settings.cubeMacs()).toEqual([
      { name: 'GAN12ui_A', mac: 'AB:12:CD:34:EF:57' },
      { name: 'GAN356i3_Z', mac: 'AB:12:CD:34:EF:56' },
    ]);
  });

  it('finds, edits and removes MAC addresses by name, ignoring case', () => {
    const settings = load();
    settings.saveCubeMac('GAN12ui_AB12', 'AB:12:CD:34:EF:56');

    expect(settings.macFor('gan12UI_ab12')).toBe('AB:12:CD:34:EF:56');
    expect(settings.macFor('GAN12ui_FFFF')).toBeNull();
    expect(settings.macFor(null)).toBeNull();

    // The same name again replaces the address; editing may rename the entry.
    settings.saveCubeMac('gan12ui_ab12', '11:22:33:44:55:66');
    expect(settings.cubeMacs()).toEqual([{ name: 'gan12ui_ab12', mac: '11:22:33:44:55:66' }]);
    settings.saveCubeMac('GAN12ui_CD34', '11:22:33:44:55:66', 'gan12ui_ab12');
    expect(settings.cubeMacs()).toEqual([{ name: 'GAN12ui_CD34', mac: '11:22:33:44:55:66' }]);

    settings.removeCubeMac('gan12ui_cd34');
    expect(settings.cubeMacs()).toEqual([]);
    expect(load().cubeMacs()).toEqual([]);
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
    expect(settings.cubeMacs()).toEqual([{ name: 'GAN12ui_AB12', mac: 'AB:12:CD:34:EF:56' }]);
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
