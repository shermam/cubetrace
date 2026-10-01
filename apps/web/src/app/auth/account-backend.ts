import { InjectionToken, inject, isDevMode } from '@angular/core';
import type { CloudAttempt, CloudAttemptFields, CloudSession, UserRecord } from '@cubetrace/core';
import type { ConfirmRequest, ConfirmResult, SignRequest, SignedFile } from '@cubetrace/upload';

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

/** A document of the session index as Firestore gives it back (docs/DATA-MODEL.md §10, T3.1). */
export interface CloudDocument {
  /** The document's id: a session's id, or an attempt's index zero-padded to 4 digits (`0001`). */
  readonly id: string;
  /** Its fields as Firestore holds them, unchecked: core's parseCloudSession and parseCloudAttempt read them. */
  readonly data: unknown;
  /**
   * It holds writes of this device that the server has not confirmed yet (Firestore's
   * `hasPendingWrites`): offline, they wait in the cache.
   */
  readonly pending: boolean;
}

/** The documents a query of the session index found. */
export interface CloudListing {
  readonly documents: readonly CloudDocument[];
  /** They come from this device's cache, the server being out of reach (Firestore's `fromCache`). */
  readonly fromCache: boolean;
}

/**
 * The few calls the app makes into Firebase: Authentication with the Google provider, Firestore for
 * users/{uid} and the session index (docs/ARCHITECTURE.md, "Account"), and the upload's two callable
 * functions (T3.2, T3.3). `firebase-sdk.ts` implements it with the SDK, in a lazy chunk of its own;
 * the unit tests and the end-to-end suite give fakes, so that neither loads Firebase.
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
  /**
   * Merges `session` into sessions/{id}, and in the same batch each of `attempts` into its
   * sessions/{id}/attempts/{index} (docs/PLAN.md T3.1): an attempt with its `upload` creates its
   * document, one without (its fields) changes the others and leaves `upload`, which is the upload
   * functions' once the document exists, as it is. As `saveUser`, Firestore applies the writes to its
   * cache at once and sends them when it can; the promise settles when the server has them, and
   * rejects when it refuses them (the rules, a document too large).
   */
  saveSessionIndex(
    session: CloudSession,
    attempts?: readonly (CloudAttempt | CloudAttemptFields)[],
  ): Promise<void>;
  /** Merges `attempt` into sessions/{id}/attempts/{index}, as `saveSessionIndex` merges it. */
  saveAttemptIndex(attempt: CloudAttempt | CloudAttemptFields): Promise<void>;
  /** Deletes sessions/{id}/attempts/{index} (the timer's Delete last); settles as `saveSessionIndex`. */
  deleteAttemptIndex(sessionId: string, index: number): Promise<void>;
  /**
   * The newest `limit` sessions of the account `uid`, newest first: `where('owner', '==', uid)` (the
   * rules refuse a query that does not ask for the account's own documents), by `createdMs`. From the
   * server, or from the cache when the server is out of reach.
   */
  listSessions(uid: string, limit: number): Promise<CloudListing>;
  /** sessions/{id}; null when it is not there. */
  getSession(sessionId: string): Promise<CloudDocument | null>;
  /** The attempts of session `sessionId` of the account `uid` (`where('owner', '==', uid)`), by index. */
  listAttempts(uid: string, sessionId: string): Promise<CloudListing>;
  /**
   * Resolves once the writes made so far are on the server (Firestore's `waitForPendingWrites`):
   * the upload's functions find only the documents that are there (T3.3). Offline, it waits.
   */
  waitForIndexWrites(): Promise<void>;
  /**
   * `signUpload` (functions/README.md): a PUT URL per file of an attempt, with the headers to send.
   * Rejects with the function's `HttpsError`: its `code` (`functions/not-found`,
   * `functions/resource-exhausted`, …), `message` and `details`.
   */
  signUpload(request: SignRequest): Promise<SignedFile[]>;
  /** `confirmUpload` (functions/README.md): the files found in the bucket; rejects as `signUpload`. */
  confirmUpload(request: ConfirmRequest): Promise<ConfirmResult>;
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
