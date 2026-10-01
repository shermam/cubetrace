import { InjectionToken, inject, isDevMode } from '@angular/core';
import type { UserRecord } from '@cubetrace/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';

/** Who is signed in, as the app shows it (docs/PLAN.md, T3.0). */
export interface AccountUser {
  readonly uid: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly photoURL: string | null;
}

/** A signed-in account as the backend reports it: the account, and when it was created. */
export interface BackendUser extends AccountUser {
  /**
   * When the account was created (Firebase Authentication's creation time), in ms since 1970; null
   * when the backend does not say, and then users/{uid} is not written.
   */
  readonly createdMs: number | null;
}

/**
 * The few calls the app makes into Firebase: Authentication with the Google provider, and Firestore
 * for users/{uid} (docs/ARCHITECTURE.md, "Account"). `firebase-sdk.ts` implements it with the SDK, in
 * a lazy chunk of its own; the unit tests and the end-to-end suite give fakes, so that neither loads
 * Firebase.
 */
export interface AccountBackend {
  /**
   * Calls `next` with the account signed in (null: none) once the backend knows it, and again at
   * every change, until the returned function is called; `error` if the backend cannot tell.
   */
  watchUser(next: (user: BackendUser | null) => void, error: (error: unknown) => void): () => void;
  /** Signs in with Google's page in a popup; resolves once signed in. */
  signInWithPopup(): Promise<void>;
  /** Leaves the page for Google's; the page that comes back reads the outcome with `redirectResult`. */
  signInWithRedirect(): Promise<void>;
  /** The account a redirect brought back, or null when there was none (or it was lost). */
  redirectResult(): Promise<BackendUser | null>;
  signOut(): Promise<void>;
  /**
   * Merges `record` into users/{uid}. Firestore applies it to its local cache at once and sends it
   * when it can (offline, it waits in the cache, across reloads); the promise settles when the server
   * has it.
   */
  saveUser(uid: string, record: UserRecord): Promise<void>;
}

/** Loads the account's backend: the Firebase SDK, from its lazy chunk. */
export type AccountLoader = () => Promise<AccountBackend>;

/**
 * The window property through which the end-to-end suite replaces the loader with a fake (an
 * `AccountLoader`, set before the app starts: apps/web/e2e/helpers/account.ts). Read only in
 * development builds (`ng serve`), never in production ones.
 */
export const E2E_ACCOUNT_LOADER = 'cubetraceE2eAccountLoader';

/**
 * The account's loader: a dynamic import of `firebase-sdk.ts`, so that the Firebase SDK is a lazy
 * chunk that only an account in use downloads (`AuthService`); the unit tests provide their own.
 */
export const ACCOUNT_LOADER = new InjectionToken<AccountLoader>('ACCOUNT_LOADER', {
  providedIn: 'root',
  factory: () => {
    const e2e: unknown = isDevMode()
      ? Reflect.get(inject(BROWSER_GLOBALS), E2E_ACCOUNT_LOADER)
      : null;
    return typeof e2e === 'function'
      ? (e2e as AccountLoader)
      : () => import('./firebase-sdk').then((sdk) => sdk.connectFirebase());
  },
});
