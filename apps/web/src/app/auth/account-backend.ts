import { InjectionToken, inject, isDevMode } from '@angular/core';
import type {
  CloudAttempt,
  CloudAttemptFields,
  CloudCube,
  CloudSession,
  UserRecord,
} from '@cubetrace/core';
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

/**
 * A document as Firestore gives it back (docs/DATA-MODEL.md §10): of the session index (T3.1), or a
 * cube of the account's list (T3.4).
 */
export interface CloudDocument {
  /**
   * The document's id: a session's id, an attempt's index zero-padded to 4 digits (`0001`), or a
   * cube's name.
   */
  readonly id: string;
  /**
   * Its fields as Firestore holds them, unchecked: core's parseCloudSession, parseCloudAttempt and
   * parseCloudCube read them.
   */
  readonly data: unknown;
  /**
   * It holds writes of this device that the server has not confirmed yet (Firestore's
   * `hasPendingWrites`): offline, they wait in the cache.
   */
  readonly pending: boolean;
}

/** The documents a query of the session index, or of the account's cubes, found. */
export interface CloudListing {
  readonly documents: readonly CloudDocument[];
  /** They come from this device's cache, the server being out of reach (Firestore's `fromCache`). */
  readonly fromCache: boolean;
}

/**
 * The few calls the app makes into Firebase: Authentication with the Google provider, Firestore for
 * users/{uid}, the session index and the account's cubes (docs/ARCHITECTURE.md, "Account"), and the
 * upload's two callable functions (T3.2, T3.3). `firebase-sdk.ts` implements it with the SDK, in a
 * lazy chunk of its own; the unit tests and the end-to-end suite give fakes, so that neither loads
 * Firebase.
 */
export interface AccountBackend {
  /**
   * Calls `next` with the account signed in (null: none) once the backend knows it, and again at
   * every change, until the returned function is called; `error` if the backend cannot tell.
   */
  watchUser(next: (user: BackendUser | null) => void, error: (error: unknown) => void): () => void;
  /**
   * Signs in with Google's page in a popup (over the installed app on Android, a Custom Tab that
   * closes itself when Google is done); resolves once signed in.
   */
  signInWithPopup(): Promise<void>;
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

  // ---- The cubes (T3.4): users/{uid}/cubes/{name}, Settings' list of MAC addresses ----

  /**
   * The cubes of the account `uid` (users/{uid}/cubes): from the server, or from the cache when the
   * server is out of reach (`fromCache`), with this device's writes that the server has not confirmed
   * (`pending`).
   */
  listCubes(uid: string): Promise<CloudListing>;
  /**
   * Writes users/{uid}/cubes/{cube.name}, replacing what it held. As `saveUser`, Firestore applies it
   * to its cache at once and sends it when it can; the promise settles when the server has it, and
   * rejects when it refuses it (the rules).
   */
  saveCube(uid: string, cube: CloudCube): Promise<void>;
  /** Deletes users/{uid}/cubes/{name}; settles as `saveCube`. */
  deleteCube(uid: string, name: string): Promise<void>;
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
 * The window property through which the end-to-end suite's cloud project points the Firebase SDK at
 * the emulators (`FirebaseEmulators`, set before the app starts: apps/web/e2e/helpers/emulators.ts).
 * Read only in development builds (`ng serve`), never in production ones.
 */
export const E2E_EMULATORS = 'cubetraceE2eEmulators';

/**
 * The Firebase emulators that the end-to-end suite's cloud project runs (`npm run e2e:cloud`), for the
 * real SDK to use in place of Google's servers: `firebase-sdk.ts` connects Authentication, Firestore
 * and the functions to them, under their offline project, and Sign in signs in the Google account of
 * `googleIdToken`, without Google's page.
 */
export interface FirebaseEmulators {
  /** The emulators' project, `demo-cubetrace`, in place of the web config's. */
  readonly projectId: string;
  /** The Auth emulator, `host:port` (as `FIREBASE_AUTH_EMULATOR_HOST` says it). */
  readonly auth: string;
  /** The Firestore emulator, `host:port` (as `FIRESTORE_EMULATOR_HOST` says it). */
  readonly firestore: string;
  /** The Functions emulator, `host:port`. */
  readonly functions: string;
  /**
   * The Google account that Sign in signs in: an ID token of unsigned claims (`{"sub": …, "email": …,
   * "name": …}`), which the Auth emulator takes for its Google provider and Google never would.
   */
  readonly googleIdToken: string;
}

/** The window property's value as `FirebaseEmulators`, or null when it is not one (or not there). */
export function readEmulators(value: unknown): FirebaseEmulators | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const field = (name: keyof FirebaseEmulators): string | null => {
    const text: unknown = Reflect.get(value, name);
    return typeof text === 'string' && text !== '' ? text : null;
  };
  const projectId = field('projectId');
  const auth = field('auth');
  const firestore = field('firestore');
  const functions = field('functions');
  const googleIdToken = field('googleIdToken');
  return projectId === null ||
    auth === null ||
    firestore === null ||
    functions === null ||
    googleIdToken === null
    ? null
    : { projectId, auth, firestore, functions, googleIdToken };
}

/**
 * The account's loader: a dynamic import of `firebase-sdk.ts`, so that the Firebase SDK is a lazy
 * chunk that only an account in use downloads (`AuthService`); the unit tests provide their own. In
 * development builds, the end-to-end suite's fake replaces it, or its emulators redirect the SDK.
 */
export const ACCOUNT_LOADER = new InjectionToken<AccountLoader>('ACCOUNT_LOADER', {
  providedIn: 'root',
  factory: () => {
    const globals = inject(BROWSER_GLOBALS);
    const e2e: unknown = isDevMode() ? Reflect.get(globals, E2E_ACCOUNT_LOADER) : null;
    if (typeof e2e === 'function') {
      return e2e as AccountLoader;
    }
    const emulators = isDevMode() ? readEmulators(Reflect.get(globals, E2E_EMULATORS)) : null;
    return () => import('./firebase-sdk').then((sdk) => sdk.connectFirebase(emulators));
  },
});
