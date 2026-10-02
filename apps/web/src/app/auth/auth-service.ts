import { Injectable, computed, inject, signal } from '@angular/core';
import { userRecord } from '@cubetrace/core';

import { BROWSER_GLOBALS, hostNow, type BrowserGlobals } from '../device/browser-globals';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import {
  ACCOUNT_LOADER,
  type AccountBackend,
  type AccountUser,
  type BackendUser,
} from './account-backend';
import { AccountLoadError, type AuthErrorContext, authErrorMessage } from './auth-error';

/**
 * The `localStorage` key that remembers the account between page loads, so that the app loads
 * Firebase as it starts only then: `signed-in` once an account is signed in; removed on sign-out.
 * (0.3.0 also wrote `redirect` while a sign-in had left the page for Google's; a start that finds it
 * removes it, and nothing more: T3.6.)
 */
export const ACCOUNT_STORAGE_KEY = 'cubetrace.account';

/** The value that remembers an account. */
const SIGNED_IN = 'signed-in';

/**
 * `signed-out`; `loading` (the account is being loaded or a sign-in is under way); `signed-in`;
 * `error`: the last sign-in, sign-out or start failed, and `AuthService.error` says why.
 */
export type AuthStatus = 'signed-out' | 'loading' | 'signed-in' | 'error';

/** The account signed in and the backend that reaches its data: for the session index (T3.1). */
export interface CloudAccount {
  readonly uid: string;
  readonly backend: AccountBackend;
}

/**
 * Whether the app runs installed (display mode `standalone`: Chrome's WebAPK on Android, a window of
 * its own on a laptop) rather than in a browser tab. Signing in is the same popup either way, which
 * Chrome on Android opens over the installed app as a Custom Tab (docs/ARCHITECTURE.md, "Account");
 * only what a popup that did not finish says differs (`AuthErrorContext`).
 */
export function installedApp(globals: BrowserGlobals): boolean {
  return globals.matchMedia?.('(display-mode: standalone)').matches === true;
}

/**
 * The account (docs/PLAN.md, T3.0): Google sign-in through Firebase Authentication, and
 * users/{uid} in Firestore written at each sign-in and at each start signed in, with this device's
 * host label. Firebase is loaded only when the account is used (`ACCOUNT_LOADER`): on Sign in, and
 * as the app starts if a sign-in is remembered (`ACCOUNT_STORAGE_KEY`), so that a device that never
 * signs in never downloads it, and the app works signed out exactly as without an account. Errors
 * are kept in `status` and `error` for the controls to show; no method throws.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly loadBackend = inject(ACCOUNT_LOADER);
  private readonly settings = inject(SettingsService);
  private readonly storage = storageOf(this.globals);

  private readonly userSignal = signal<AccountUser | null>(null);
  private readonly statusSignal = signal<AuthStatus>('signed-out');
  private readonly errorSignal = signal<string | null>(null);
  private readonly recordErrorSignal = signal<string | null>(null);
  /** The backend, once loaded. */
  private readonly loadedSignal = signal<AccountBackend | null>(null);

  /** The backend, once loading it has begun; dropped when that failed, so that Sign in tries again. */
  private backend: Promise<AccountBackend> | null = null;
  /** What the backend last reported: undefined before its first report. */
  private reported: BackendUser | null | undefined = undefined;
  /** The backend's first report, once it is loading. */
  private firstReport: Promise<BackendUser | null> = Promise.resolve(null);
  /**
   * Sign-ins under way (a popup; a remembered account being loaded): meanwhile a report of no account
   * is the state before them, and leaves the status at `loading`.
   */
  private pending = 0;
  /** The account whose users/{uid} this page load has written. */
  private recordedUid: string | null = null;

  /** The account signed in; null without one. */
  readonly user = this.userSignal.asReadonly();
  readonly status = this.statusSignal.asReadonly();
  /** Why the status is `error`; null otherwise. */
  readonly error = this.errorSignal.asReadonly();
  /**
   * Why users/{uid} could not be written at the last sign-in; null when it was (or is on its way),
   * and once signed out.
   */
  readonly recordError = this.recordErrorSignal.asReadonly();
  /**
   * The account signed in with its backend, through which the session index (T3.1) writes and reads
   * its documents; null without an account, and while a remembered one is still loading.
   */
  readonly cloud = computed<CloudAccount | null>(
    () => {
      const uid = this.userSignal()?.uid;
      const backend = this.loadedSignal();
      return uid === undefined || backend === null ? null : { uid, backend };
    },
    // The same account again (the backend reports it at each start, and on a new token) is no change.
    { equal: (p, q) => p?.uid === q?.uid && p?.backend === q?.backend },
  );

  constructor() {
    if (this.remembered()) {
      this.statusSignal.set('loading');
      void this.resume();
    }
  }

  /**
   * Signs in with Google's page in a popup, in a browser tab and in the installed app alike: the
   * popup passes its outcome by messages, where a redirect's went through Firebase's helper frame on
   * another site, which Chrome's partitioned storage kept from the installed app (issue #50).
   */
  async signIn(): Promise<void> {
    if (this.statusSignal() === 'loading' || this.userSignal() !== null) {
      return;
    }
    this.statusSignal.set('loading');
    this.errorSignal.set(null);
    this.pending++;
    try {
      const backend = await this.connect();
      // A remembered account whose start failed (offline) comes back without Google's page.
      if (this.remembered() && (await this.firstReport) !== null) {
        return;
      }
      await backend.signInWithPopup();
      this.expectUser();
    } catch (error: unknown) {
      this.fail(this.message(error));
    } finally {
      this.endPending();
    }
  }

  /** Signs out: Firebase forgets the account on this device, and the app stops loading it. */
  async signOut(): Promise<void> {
    const loading = this.backend;
    if (loading === null) {
      this.forget();
      this.userSignal.set(null);
      this.statusSignal.set('signed-out');
      this.errorSignal.set(null);
      return;
    }
    try {
      await (await loading).signOut();
      // The backend reports it too; the page need not wait for that.
      this.userSignal.set(null);
      this.recordedUid = null;
      this.recordErrorSignal.set(null);
      this.errorSignal.set(null);
      this.statusSignal.set('signed-out');
      this.forget();
    } catch (error: unknown) {
      this.fail(`Signing out failed: ${errorMessage(error)}`);
    }
  }

  /** A remembered account as the app starts: the backend reports it from IndexedDB. */
  private async resume(): Promise<void> {
    this.pending++;
    try {
      await this.connect();
    } catch (error: unknown) {
      // Not loaded (offline): the account is still remembered, for the next start or Sign in.
      this.fail(this.message(error), !(error instanceof AccountLoadError));
    } finally {
      this.endPending();
    }
  }

  /** The backend, loaded once and watched from then on. */
  private connect(): Promise<AccountBackend> {
    if (this.backend === null) {
      let first: (user: BackendUser | null) => void = () => undefined;
      this.firstReport = new Promise((resolve) => {
        first = resolve;
      });
      const loading = this.loadBackend().then(
        (backend) => {
          this.loadedSignal.set(backend);
          backend.watchUser(
            (user) => {
              this.onReport(user, backend);
              first(user);
            },
            (error: unknown) => {
              this.fail(this.message(error));
            },
          );
          return backend;
        },
        (error: unknown) => {
          throw new AccountLoadError(error);
        },
      );
      this.backend = loading;
      void loading.catch(() => {
        if (this.backend === loading) {
          this.backend = null;
        }
      });
    }
    return this.backend;
  }

  private onReport(user: BackendUser | null, backend: AccountBackend): void {
    this.reported = user;
    if (user === null) {
      this.userSignal.set(null);
      this.recordedUid = null;
      this.recordErrorSignal.set(null);
      if (this.pending === 0) {
        this.settleSignedOut();
      }
      return;
    }
    const { uid, displayName, email, photoURL } = user;
    this.userSignal.set({ uid, displayName, email, photoURL });
    this.statusSignal.set('signed-in');
    this.errorSignal.set(null);
    this.remember();
    this.record(user, backend);
  }

  /**
   * A sign-in succeeded: the backend reports its account next (Firebase's listeners are called
   * asynchronously), so its last report of no account no longer counts.
   */
  private expectUser(): void {
    if (this.userSignal() === null) {
      this.reported = undefined;
    }
  }

  private endPending(): void {
    this.pending--;
    if (this.pending === 0 && this.reported === null) {
      this.settleSignedOut();
    }
  }

  /** No account: the status says so, unless it holds an error to show. */
  private settleSignedOut(): void {
    if (this.userSignal() !== null) {
      return;
    }
    if (this.statusSignal() !== 'error') {
      this.statusSignal.set('signed-out');
    }
    this.forget();
  }

  /** Shows `message`; without an account, nothing stays remembered unless `forget` is false. */
  private fail(message: string, forget = true): void {
    this.errorSignal.set(message);
    this.statusSignal.set('error');
    if (forget && this.userSignal() === null) {
      this.forget();
    }
  }

  /**
   * Writes users/{uid} once per page load and account: the account and this device's host label with
   * its host clock, merged into the document. Not awaited: Firestore applies the write locally at
   * once and sends it when it can, offline after the network is back, so the page never waits.
   */
  private record(user: BackendUser, backend: AccountBackend): void {
    if (this.recordedUid === user.uid) {
      return;
    }
    this.recordedUid = user.uid;
    if (user.createdMs === null) {
      this.recordFailed('the account has no creation time');
      return;
    }
    const record = userRecord({
      createdMs: user.createdMs,
      displayName: user.displayName,
      email: user.email,
      hostLabel: this.settings.hostLabel(),
      nowMs: hostNow(this.globals),
    });
    void backend.saveUser(user.uid, record).then(
      () => {
        this.recordErrorSignal.set(null);
      },
      (error: unknown) => {
        this.recordFailed(errorMessage(error));
      },
    );
  }

  private recordFailed(reason: string): void {
    const message = `The account's record (users/{uid}) could not be saved: ${reason.replace(/\.$/, '')}.`;
    this.recordErrorSignal.set(message);
    console.warn(`cubetrace: ${message}`);
  }

  /** The sentence for a failure: from the error, and from where the sign-in ran. */
  private message(error: unknown): string {
    const context: AuthErrorContext = { installed: installedApp(this.globals) };
    return authErrorMessage(error, context);
  }

  /**
   * Whether an account is remembered. Any other value is stale (0.3.0's `redirect`, left on a phone
   * by a sign-in that never came back) and is removed, so that the start neither loads Firebase for
   * it nor says anything.
   */
  private remembered(): boolean {
    try {
      const value = this.storage?.getItem(ACCOUNT_STORAGE_KEY) ?? null;
      if (value !== null && value !== SIGNED_IN) {
        this.forget();
      }
      return value === SIGNED_IN;
    } catch {
      return false;
    }
  }

  private remember(): void {
    try {
      this.storage?.setItem(ACCOUNT_STORAGE_KEY, SIGNED_IN);
    } catch {
      // Storage blocked: the account is not remembered, and the next start shows Sign in.
    }
  }

  private forget(): void {
    try {
      this.storage?.removeItem(ACCOUNT_STORAGE_KEY);
    } catch {
      // Storage blocked: there is nothing remembered either.
    }
  }
}

/** `localStorage`, or null where the browser has none or refuses it to this page. */
function storageOf(globals: BrowserGlobals): Storage | null {
  try {
    return globals.localStorage ?? null;
  } catch {
    return null;
  }
}
