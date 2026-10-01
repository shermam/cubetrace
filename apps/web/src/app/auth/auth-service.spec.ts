import { TestBed } from '@angular/core/testing';
import { USER_SCHEMA } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage, FakeMediaQuery, FakePerformance, settle } from '../device/fake-browser';
import { SettingsService } from '../settings/settings-service';
import { ACCOUNT_LOADER, type AccountLoader } from './account-backend';
import { ACCOUNT_STORAGE_KEY, AuthService, signInFlow } from './auth-service';
import { ADA, FakeAccountBackend, authError } from './fake-account';

const MAC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';
const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Mobile Safari/537.36';

/** `matchMedia` of a page in a browser tab, or of the installed app (display mode standalone). */
function displayMode(installed: boolean): BrowserGlobals['matchMedia'] {
  return (query) => new FakeMediaQuery(installed && query === '(display-mode: standalone)');
}

describe('signInFlow', () => {
  it.each([
    ['a tab on a laptop', MAC_USER_AGENT, false, 'popup'],
    ['the app installed on a laptop', MAC_USER_AGENT, true, 'popup'],
    ['a tab on an Android phone', ANDROID_USER_AGENT, false, 'popup'],
    ['the app installed on an Android phone', ANDROID_USER_AGENT, true, 'redirect'],
  ] as const)('signs in from %s with a %s', (_, userAgent, installed, flow) => {
    expect(signInFlow({ navigator: { userAgent }, matchMedia: displayMode(installed) })).toBe(flow);
  });

  it('takes a browser without matchMedia for a tab', () => {
    expect(signInFlow({ navigator: { userAgent: ANDROID_USER_AGENT } })).toBe('popup');
  });
});

describe('AuthService', () => {
  let storage: FakeLocalStorage;
  let clock: FakePerformance;
  let backend: FakeAccountBackend;
  let globals: BrowserGlobals;

  /** A new service, as after a page load, on the same device (storage and backend). */
  function load(loader: AccountLoader = backend.loader): AuthService {
    backend.newPage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        { provide: ACCOUNT_LOADER, useValue: loader },
      ],
    });
    return TestBed.inject(AuthService);
  }

  function remembered(): string | null {
    return storage.getItem(ACCOUNT_STORAGE_KEY);
  }

  beforeEach(() => {
    storage = new FakeLocalStorage();
    clock = new FakePerformance();
    backend = new FakeAccountBackend();
    globals = {
      navigator: { userAgent: MAC_USER_AGENT },
      localStorage: storage,
      performance: clock,
      matchMedia: displayMode(false),
    };
  });

  it('starts signed out, without loading Firebase, when no sign-in is remembered', async () => {
    const auth = load();
    await settle();

    expect(auth.status()).toBe('signed-out');
    expect(auth.user()).toBeNull();
    expect(auth.error()).toBeNull();
    expect(backend.loads).toBe(0);
    expect(remembered()).toBeNull();
  });

  it('signs in with a popup on a laptop: the account, remembered, and users/{uid} with this device', async () => {
    const auth = load();
    TestBed.inject(SettingsService).setHostLabel('office-mbp');
    clock.advance(1234.5);

    const signingIn = auth.signIn();
    expect(auth.status()).toBe('loading');
    await signingIn;
    await settle();

    expect(backend.loads).toBe(1);
    expect(backend.calls).toEqual(['watch', 'popup']);
    expect(auth.status()).toBe('signed-in');
    expect(auth.user()).toEqual({
      uid: 'ada-uid',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      photoURL: 'https://lh3.googleusercontent.com/a/ada=s96-c',
    });
    expect(remembered()).toBe('signed-in');
    expect(backend.saved).toEqual([
      {
        uid: 'ada-uid',
        record: {
          schema: 1,
          createdMs: 1_790_000_000_000,
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          devices: { 'office-mbp': clock.hostMs },
        },
      },
    ]);
    const validate = new Ajv2020({ allowUnionTypes: true }).compile(USER_SCHEMA);
    expect(validate(backend.saved[0].record), JSON.stringify(validate.errors)).toBe(true);
    expect(auth.recordError()).toBeNull();
  });

  it('starts signed in when a sign-in is remembered: Firebase loads at once, and the device is seen again', async () => {
    await load().signIn();
    await settle();
    clock.advance(60_000);

    backend.reportAtOnce = false;
    const auth = load();
    expect(auth.status()).toBe('loading');
    await settle();
    expect(backend.loads).toBe(2);
    expect(auth.status()).toBe('loading');

    backend.release();
    await settle();
    expect(auth.status()).toBe('signed-in');
    expect(auth.user()?.uid).toBe('ada-uid');
    expect(backend.calls.filter((call) => call === 'popup')).toHaveLength(1);
    expect(backend.saved.map((entry) => entry.record.devices)).toEqual([
      { 'macOS laptop': clock.hostMs - 60_000 },
      { 'macOS laptop': clock.hostMs },
    ]);
  });

  it('starts signed out when the remembered account is gone (signed out elsewhere, expired), and forgets it', async () => {
    storage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    const auth = load();
    await settle();

    expect(backend.loads).toBe(1);
    expect(auth.status()).toBe('signed-out');
    expect(auth.user()).toBeNull();
    expect(remembered()).toBeNull();
    expect(backend.saved).toEqual([]);
  });

  it('signs out: the account is gone, nothing is remembered, and the next start does not load Firebase', async () => {
    const auth = load();
    await auth.signIn();
    await settle();

    await auth.signOut();
    expect(auth.status()).toBe('signed-out');
    expect(auth.user()).toBeNull();
    expect(remembered()).toBeNull();
    expect(backend.calls.at(-1)).toBe('sign-out');
    await settle();
    expect(auth.status()).toBe('signed-out');

    const next = load();
    await settle();
    expect(next.status()).toBe('signed-out');
    expect(backend.loads).toBe(1);
  });

  it.each([
    [
      'the popup closed',
      'auth/popup-closed-by-user',
      'Signing in was cancelled: the Google window was closed first.',
    ],
    [
      'the network down',
      'auth/network-request-failed',
      'No connection to Google: sign in again once the device is online.',
    ],
    [
      'the popup blocked',
      'auth/popup-blocked',
      'Chrome blocked the Google window: allow pop-ups for this site (the icon at the end of the ' +
        'address bar), then sign in again.',
    ],
    [
      'an error of its own',
      'auth/internal-error',
      'Signing in failed: Firebase: Error (auth/internal-error).',
    ],
  ])('says so, without throwing, when signing in fails with %s', async (_, code, message) => {
    backend.popupError = authError(code);
    const auth = load();

    await expect(auth.signIn()).resolves.toBeUndefined();
    await settle();

    expect(auth.status()).toBe('error');
    expect(auth.error()).toBe(message);
    expect(auth.user()).toBeNull();
    expect(remembered()).toBeNull();

    // Sign in again: the backend is not loaded twice, and the error goes.
    backend.popupError = null;
    await auth.signIn();
    await settle();
    expect(auth.status()).toBe('signed-in');
    expect(auth.error()).toBeNull();
    expect(backend.loads).toBe(1);
  });

  it('says so when the account cannot be loaded (offline), and loads it again at the next Sign in', async () => {
    let fail = true;
    const loader: AccountLoader = () =>
      fail
        ? Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
        : backend.loader();
    const auth = load(loader);

    await auth.signIn();
    expect(auth.status()).toBe('error');
    expect(auth.error()).toBe(
      'The account could not be loaded (Failed to fetch dynamically imported module): try again ' +
        'once the device is online.',
    );

    fail = false;
    await auth.signIn();
    await settle();
    expect(auth.status()).toBe('signed-in');
    expect(backend.loads).toBe(1);
  });

  it('keeps a remembered account when it cannot be loaded at start (offline), for the next start', async () => {
    storage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    const auth = load(() => Promise.reject(new TypeError('Failed to fetch')));
    await settle();

    expect(auth.status()).toBe('error');
    expect(auth.error()).toBe(
      'The account could not be loaded (Failed to fetch): try again once the device is online.',
    );
    expect(remembered()).toBe('signed-in');
  });

  it('brings a remembered account back at Sign in, without Google, once it loads', async () => {
    await load().signIn();
    await settle();
    let fail = true;
    const auth = load(() =>
      fail ? Promise.reject(new TypeError('Failed to fetch')) : backend.loader(),
    );
    await settle();
    expect(auth.status()).toBe('error');

    fail = false;
    await auth.signIn();
    await settle();
    expect(auth.status()).toBe('signed-in');
    expect(auth.user()?.uid).toBe('ada-uid');
    expect(backend.calls.filter((call) => call === 'popup')).toHaveLength(1);
  });

  it('signs in once however often Sign in is clicked meanwhile', async () => {
    const auth = load();
    const first = auth.signIn();
    const second = auth.signIn();
    await Promise.all([first, second]);
    await settle();

    expect(backend.calls).toEqual(['watch', 'popup']);
    expect(auth.status()).toBe('signed-in');
  });

  it('signs in with a redirect in the app installed on Android, and reads its outcome when the page comes back', async () => {
    globals = {
      ...globals,
      navigator: { userAgent: ANDROID_USER_AGENT },
      matchMedia: displayMode(true),
    };
    const auth = load();
    void auth.signIn();
    await settle();

    expect(backend.calls).toEqual(['watch', 'redirect']);
    expect(remembered()).toBe('redirect');
    expect(auth.status()).toBe('loading');

    // Google sends the page back: a new page load.
    const back = load();
    expect(back.status()).toBe('loading');
    await settle();

    expect(backend.calls.slice(2)).toEqual(['watch', 'redirect-result']);
    expect(back.status()).toBe('signed-in');
    expect(back.user()?.email).toBe('ada@example.com');
    expect(remembered()).toBe('signed-in');
    expect(Object.keys(backend.saved[0].record.devices)).toEqual(['Android phone']);
  });

  it('says so when the page comes back from a redirect without an account', async () => {
    storage.setItem(ACCOUNT_STORAGE_KEY, 'redirect');
    const auth = load();
    await settle();

    expect(backend.calls).toEqual(['watch', 'redirect-result']);
    expect(auth.status()).toBe('error');
    expect(auth.error()).toBe(
      'Signing in did not finish: Google sent the page back without an account. Sign in again.',
    );
    expect(remembered()).toBeNull();
  });

  it('says so when the redirect cannot leave (offline), and forgets it', async () => {
    globals = {
      ...globals,
      navigator: { userAgent: ANDROID_USER_AGENT },
      matchMedia: displayMode(true),
    };
    backend.redirectError = authError('auth/network-request-failed');
    const auth = load();
    await auth.signIn();

    expect(auth.status()).toBe('error');
    expect(auth.error()).toBe('No connection to Google: sign in again once the device is online.');
    expect(remembered()).toBeNull();
  });

  it('stays signed in, and says why, when users/{uid} cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.saveError = authError('permission-denied');
    const auth = load();
    await auth.signIn();
    await settle();

    expect(auth.status()).toBe('signed-in');
    expect(auth.recordError()).toBe(
      "The account's record (users/{uid}) could not be saved: Firebase: Error (permission-denied).",
    );
    expect(warn).toHaveBeenCalledWith(`cubetrace: ${auth.recordError() ?? ''}`);
    warn.mockRestore();
  });

  it('writes no users/{uid} for an account without a creation time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    backend.account = { ...ADA, createdMs: null };
    const auth = load();
    await auth.signIn();
    await settle();

    expect(auth.status()).toBe('signed-in');
    expect(backend.saved).toEqual([]);
    expect(auth.recordError()).toBe(
      "The account's record (users/{uid}) could not be saved: the account has no creation time.",
    );
    warn.mockRestore();
  });

  it('says so when signing out fails, and stays signed in', async () => {
    const auth = load();
    await auth.signIn();
    await settle();
    backend.signOutError = new Error('IndexedDB is gone');

    await auth.signOut();
    expect(auth.status()).toBe('error');
    expect(auth.error()).toBe('Signing out failed: IndexedDB is gone');
    expect(auth.user()?.uid).toBe('ada-uid');
    expect(remembered()).toBe('signed-in');
  });

  it('works where the browser blocks storage: signed in for the page, nothing remembered', async () => {
    globals = {
      ...globals,
      get localStorage(): Storage {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    };
    const auth = load();
    await settle();
    expect(auth.status()).toBe('signed-out');

    await auth.signIn();
    await settle();
    expect(auth.status()).toBe('signed-in');
    expect(storage.length).toBe(0);
  });
});
