import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { ACCOUNT_LOADER } from './account-backend';
import { AccountControl, type AccountControlPlace } from './account-control';
import { ACCOUNT_STORAGE_KEY } from './auth-service';
import { ADA, FakeAccountBackend, authError } from './fake-account';

describe('AccountControl', () => {
  let backend: FakeAccountBackend;
  let globals: BrowserGlobals;

  async function render(place: AccountControlPlace): Promise<ComponentFixture<AccountControl>> {
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
      ],
    });
    const fixture = TestBed.createComponent(AccountControl);
    fixture.componentRef.setInput('place', place);
    await update(fixture);
    return fixture;
  }

  async function update(fixture: ComponentFixture<AccountControl>): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  function find(fixture: ComponentFixture<AccountControl>, testId: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`);
  }

  function text(fixture: ComponentFixture<AccountControl>, testId: string): string | undefined {
    return find(fixture, testId)?.textContent.replace(/\s+/g, ' ').trim();
  }

  beforeEach(() => {
    backend = new FakeAccountBackend();
    globals = {
      navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
      localStorage: new FakeLocalStorage(),
    };
  });

  describe('in the header', () => {
    it('offers Sign in, which signs in and shows the account: its photo and name, with a menu holding Sign out', async () => {
      const fixture = await render('header');
      const signIn = find(fixture, 'sign-in');
      expect(signIn?.getAttribute('aria-label')).toBe('Sign in');
      expect(signIn?.title).toBe('Sign in with Google');
      expect(backend.loads).toBe(0);

      signIn?.click();
      await update(fixture);

      expect(find(fixture, 'sign-in')).toBeNull();
      const account = find(fixture, 'account');
      expect(account?.getAttribute('aria-label')).toBe('Account: Ada Lovelace');
      expect(account?.title).toBe('ada@example.com');
      expect(account?.getAttribute('popovertarget')).toBe('account-menu');
      expect(account?.querySelector('img')?.getAttribute('src')).toBe(ADA.photoURL);
      expect(text(fixture, 'account-name')).toBe('Ada Lovelace');
      const menu = find(fixture, 'account-menu');
      expect(menu?.id).toBe('account-menu');
      expect(menu?.hasAttribute('popover')).toBe(true);
      expect(Array.from(menu?.querySelectorAll('.who > *') ?? [], (e) => e.textContent)).toEqual([
        'Ada Lovelace',
        'ada@example.com',
      ]);
      expect(menu?.querySelector('[data-testid="sign-out"]')?.textContent.trim()).toBe('Sign out');

      find(fixture, 'sign-out')?.click();
      await update(fixture);
      expect(find(fixture, 'account')).toBeNull();
      expect(find(fixture, 'sign-in')).not.toBeNull();
    });

    it("shows the account's initial when it has no photo, or when its photo does not load", async () => {
      backend.account = { ...ADA, photoURL: null, displayName: null };
      const fixture = await render('header');
      find(fixture, 'sign-in')?.click();
      await update(fixture);
      expect(find(fixture, 'account')?.querySelector('img')).toBeNull();
      expect(find(fixture, 'account')?.querySelector('app-account-photo')?.textContent.trim()).toBe(
        'A',
      );
      expect(text(fixture, 'account-name')).toBe('ada@example.com');

      find(fixture, 'sign-out')?.click();
      await update(fixture);
      backend.account = ADA;
      find(fixture, 'sign-in')?.click();
      await update(fixture);
      const photo = find(fixture, 'account')?.querySelector('img');
      photo?.dispatchEvent(new Event('error'));
      await update(fixture);
      expect(find(fixture, 'account')?.querySelector('img')).toBeNull();
      expect(find(fixture, 'account')?.textContent).toContain('A');
    });

    it('says Signing in… while it signs in, and puts a failure in the title of Sign in', async () => {
      backend.popupError = authError('auth/popup-blocked');
      globals.localStorage?.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
      backend.reportAtOnce = false;
      const fixture = await render('header');

      const loading = find(fixture, 'sign-in') as HTMLButtonElement;
      expect(loading.disabled).toBe(true);
      expect(loading.getAttribute('aria-label')).toBe('Signing in…');
      expect(loading.textContent.trim()).toBe('Signing in…');

      backend.release();
      await update(fixture);
      const signIn = find(fixture, 'sign-in') as HTMLButtonElement;
      expect(signIn.disabled).toBe(false);
      signIn.click();
      await update(fixture);
      expect(signIn.dataset['status']).toBe('error');
      expect(signIn.title).toBe(
        'Chrome blocked the Google window: allow pop-ups for this site (the icon at the end of the ' +
          'address bar), then sign in again.',
      );
    });
  });

  describe('in Settings', () => {
    it('offers Sign in with Google, then shows the account, its email, and Sign out', async () => {
      const fixture = await render('settings');
      const signIn = find(fixture, 'sign-in');
      expect(signIn?.textContent.trim()).toBe('Sign in with Google');

      signIn?.click();
      await update(fixture);
      expect(text(fixture, 'account-name')).toBe('Ada Lovelace');
      expect(text(fixture, 'account-email')).toBe('ada@example.com');
      expect(find(fixture, 'account')?.querySelector('img')?.getAttribute('src')).toBe(
        ADA.photoURL,
      );
      expect(find(fixture, 'account-error')).toBeNull();

      find(fixture, 'sign-out')?.click();
      await update(fixture);
      expect(find(fixture, 'sign-in')?.textContent.trim()).toBe('Sign in with Google');
    });

    it('says what went wrong: a failed sign-in, and a record that could not be saved', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      backend.popupError = authError('auth/popup-closed-by-user');
      const fixture = await render('settings');
      find(fixture, 'sign-in')?.click();
      await update(fixture);

      const error = find(fixture, 'account-error');
      expect(error?.getAttribute('role')).toBe('alert');
      expect(error?.textContent.trim()).toBe(
        'Signing in was cancelled: the Google window was closed first.',
      );

      backend.popupError = null;
      backend.saveError = new Error('Missing or insufficient permissions.');
      find(fixture, 'sign-in')?.click();
      await update(fixture);
      expect(find(fixture, 'account-error')).toBeNull();
      expect(text(fixture, 'account-record-error')).toBe(
        "The account's record (users/{uid}) could not be saved: Missing or insufficient permissions.",
      );
      warn.mockRestore();
    });
  });
});
