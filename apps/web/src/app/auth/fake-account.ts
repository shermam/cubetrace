// A fake of the account's backend for the unit tests (provide `loader` as ACCOUNT_LOADER): the
// Firebase calls of AccountBackend over an in-memory account, without Firebase. Nothing in the app
// imports this file, so it is not in the bundle.
import type { UserRecord } from '@cubetrace/core';

import type { AccountBackend, AccountLoader, BackendUser } from './account-backend';

/** The account the tests sign in with. */
export const ADA: BackendUser = {
  uid: 'ada-uid',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  photoURL: 'https://lh3.googleusercontent.com/a/ada=s96-c',
  createdMs: 1_790_000_000_000,
};

/** An error as Firebase Authentication throws them: a message and a code. */
export function authError(code: string): Error {
  return Object.assign(new Error(`Firebase: Error (${code}).`), { code });
}

/**
 * The account's backend in memory. Like Firebase, it keeps the account signed in across page loads
 * (one instance stands for the device: give the same one to each load), reports it to its watchers
 * asynchronously, and reads a redirect's outcome once.
 */
export class FakeAccountBackend implements AccountBackend {
  /** The account signed in on this device, as Firebase keeps it in IndexedDB. */
  user: BackendUser | null = null;
  /** The account that Google's page signs in. */
  account: BackendUser = ADA;
  /** Set: the popup (or the redirect, or reading its outcome) fails with it. */
  popupError: Error | null = null;
  redirectError: Error | null = null;
  /** The outcome waiting for the page that comes back from a redirect. */
  redirectUser: BackendUser | null = null;
  signOutError: Error | null = null;
  /** Set: users/{uid} cannot be saved (Firestore refuses it). */
  saveError: Error | null = null;
  /** Unset: the first report waits for `release()`, as Firebase reads its persistence first. */
  reportAtOnce = true;

  /** The calls made, in order: `watch`, `popup`, `redirect`, `redirect-result`, `sign-out`. */
  readonly calls: string[] = [];
  /** Every users/{uid} written, in order. */
  readonly saved: { uid: string; record: UserRecord }[] = [];
  /** How many times the loader loaded this backend. */
  loads = 0;

  private readonly watchers = new Set<(user: BackendUser | null) => void>();
  private held: (() => void)[] = [];

  readonly loader: AccountLoader = () => {
    this.loads++;
    return Promise.resolve(this);
  };

  watchUser(next: (user: BackendUser | null) => void): () => void {
    this.calls.push('watch');
    this.watchers.add(next);
    const first = (): void => {
      next(this.user);
    };
    if (this.reportAtOnce) {
      queueMicrotask(first);
    } else {
      this.held.push(first);
    }
    return () => {
      this.watchers.delete(next);
    };
  }

  /** A page load: the previous page's watchers are gone (Firebase starts again in the new page). */
  newPage(): void {
    this.watchers.clear();
    this.held = [];
  }

  /** Sends the first reports held back while `reportAtOnce` was unset. */
  release(): void {
    const held = this.held;
    this.held = [];
    for (const report of held) {
      report();
    }
  }

  signInWithPopup(): Promise<void> {
    this.calls.push('popup');
    if (this.popupError !== null) {
      return Promise.reject(this.popupError);
    }
    this.setUser(this.account);
    return Promise.resolve();
  }

  signInWithRedirect(): Promise<void> {
    this.calls.push('redirect');
    if (this.redirectError !== null) {
      return Promise.reject(this.redirectError);
    }
    // The page would leave for Google's here; the test then loads the page again.
    this.redirectUser = this.account;
    return new Promise<void>(() => undefined);
  }

  redirectResult(): Promise<BackendUser | null> {
    this.calls.push('redirect-result');
    const user = this.redirectUser;
    this.redirectUser = null;
    if (user !== null) {
      this.setUser(user);
    }
    return Promise.resolve(user);
  }

  signOut(): Promise<void> {
    this.calls.push('sign-out');
    if (this.signOutError !== null) {
      return Promise.reject(this.signOutError);
    }
    this.setUser(null);
    return Promise.resolve();
  }

  saveUser(uid: string, record: UserRecord): Promise<void> {
    if (this.saveError !== null) {
      return Promise.reject(this.saveError);
    }
    this.saved.push({ uid, record: structuredClone(record) });
    return Promise.resolve();
  }

  private setUser(user: BackendUser | null): void {
    this.user = user;
    for (const watcher of this.watchers) {
      queueMicrotask(() => {
        watcher(user);
      });
    }
  }
}
