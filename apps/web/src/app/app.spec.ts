import {
  type ComponentFixture,
  DeferBlockBehavior,
  DeferBlockState,
  TestBed,
} from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { APP_BUILD } from '../environments/version';
import { App } from './app';
import { routes } from './app.routes';
import { ACCOUNT_LOADER } from './auth/account-backend';
import { FakeAccountBackend } from './auth/fake-account';
import { BROWSER_GLOBALS, type BrowserGlobals } from './device/browser-globals';
import {
  FakeLocalStorage,
  FakeStorageManager,
  FakeVideoEncoder,
  FakeWakeLock,
  polyfillDialog,
  settle,
} from './device/fake-browser';

/** Chrome on a phone or a laptop: every API the app needs (Web Bluetooth is not in the DOM types). */
function chrome(): BrowserGlobals {
  const navigator = {
    bluetooth: {},
    wakeLock: new FakeWakeLock(),
    storage: new FakeStorageManager({}),
  };
  return { navigator, VideoEncoder: FakeVideoEncoder, localStorage: new FakeLocalStorage() };
}

describe('App', () => {
  async function render(browser: BrowserGlobals): Promise<ComponentFixture<App>> {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), { provide: BROWSER_GLOBALS, useValue: browser }],
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture;
  }

  function query(fixture: ComponentFixture<App>, selector: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(selector);
  }

  it('shows the brand and a top navigation to the four pages', async () => {
    const fixture = await render(chrome());

    expect(query(fixture, '.brand')?.textContent).toBe('cubetrace');
    const nav = (fixture.nativeElement as HTMLElement).querySelectorAll('nav a');
    const links = Array.from(nav, (a) => [a.textContent.trim(), a.getAttribute('href')]);
    expect(links).toEqual([
      ['Timer', '/'],
      ['Sessions', '/sessions'],
      ['Settings', '/settings'],
      ['Probe', '/probe'],
    ]);
  });

  it("shows the build's version and commit in the footer", async () => {
    const fixture = await render(chrome());

    expect(query(fixture, '[data-testid="app-version"]')?.textContent).toBe(
      `cubetrace ${APP_BUILD.version} · ${APP_BUILD.commit}`,
    );
  });

  it('shows the wake lock status in the header', async () => {
    const fixture = await render(chrome());

    const status = query(fixture, '[data-testid="wake-lock-status"]');
    expect(status?.textContent.trim()).toBe('Screen may sleep');
    expect(status?.dataset['status']).toBe('inactive');
  });

  it('shows no banner in a browser with every API', async () => {
    const fixture = await render(chrome());

    expect(query(fixture, '[data-testid="support-banner"]')).toBeNull();
  });

  it('lists the missing APIs in a banner that can be dismissed', async () => {
    const fixture = await render({ navigator: {} });

    expect(query(fixture, '[data-testid="support-banner"]')?.textContent).toContain(
      'This browser lacks Web Bluetooth (connecting the cube), the origin private file system ' +
        '(saving sessions) and WebCodecs (recording video): cubetrace needs Chrome on Android, ' +
        'macOS or Windows.',
    );
    expect(query(fixture, '[data-testid="wake-lock-status"]')?.textContent.trim()).toBe(
      'No wake lock',
    );

    query(fixture, '[data-testid="support-banner"] button')?.click();
    await fixture.whenStable();
    expect(query(fixture, '[data-testid="support-banner"]')).toBeNull();
  });

  it('shows the cube status in the header: "Connect cube"; where Bluetooth cannot connect, a click opens the dialog', async () => {
    polyfillDialog();
    // chrome()'s `navigator.bluetooth` is a stand-in without `requestDevice`: no Web Bluetooth.
    const fixture = await render(chrome());
    // The pill and the dialog are deferred: their code loads right after the first render.
    await settle();
    await fixture.whenStable();

    const pill = query(fixture, '[data-testid="cube-status"]');
    expect(pill?.textContent.trim()).toBe('Connect cube');
    expect(query(fixture, 'app-cube-status-pill')).not.toBeNull();
    expect(query(fixture, 'dialog')?.hasAttribute('open')).toBe(false);

    pill?.click();
    await settle();
    await fixture.whenStable();
    expect(query(fixture, 'dialog')?.hasAttribute('open')).toBe(true);
    expect(query(fixture, 'dialog')?.dataset['reason']).toBe('support');
  });

  it('shows Sign in in the header, which loads the account only when clicked, then the account', async () => {
    const backend = new FakeAccountBackend();
    TestBed.overrideProvider(ACCOUNT_LOADER, { useValue: backend.loader });
    const fixture = await render(chrome());
    // The account's control comes with the cube's pill, right after the first render.
    await settle();
    await fixture.whenStable();

    const signIn = query(fixture, '.status [data-testid="sign-in"]');
    expect(signIn?.getAttribute('aria-label')).toBe('Sign in');
    expect(backend.loads).toBe(0);

    signIn?.click();
    await settle();
    await fixture.whenStable();
    expect(backend.loads).toBe(1);
    expect(query(fixture, '.status [data-testid="sign-in"]')).toBeNull();
    expect(query(fixture, '.status [data-testid="account"]')?.getAttribute('aria-label')).toBe(
      'Account: Ada Lovelace',
    );
  });

  it("the pill's placeholder says the same, and the pill acts on a click made on it", async () => {
    polyfillDialog();
    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), { provide: BROWSER_GLOBALS, useValue: chrome() }],
      deferBlockBehavior: DeferBlockBehavior.Manual,
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const placeholder = query(fixture, '[data-testid="cube-status"]');
    expect(query(fixture, 'app-cube-status-pill')).toBeNull();
    expect(placeholder?.textContent.trim()).toBe('Connect cube');
    placeholder?.click();
    for (const block of await fixture.getDeferBlocks()) {
      await block.render(DeferBlockState.Complete);
    }
    await settle();
    await fixture.whenStable();

    expect(query(fixture, 'app-cube-status-pill')).not.toBeNull();
    // Without Web Bluetooth, the pill's click opens the dialog that says so.
    expect(query(fixture, 'dialog')?.dataset['reason']).toBe('support');
  });
});
