import { InjectionToken, inject, isDevMode } from '@angular/core';
import type { SessionPairing } from '@cubetrace/core';
import {
  FirestoreSignaling,
  type IncomingOffer,
  type PairingCheck,
  type Signaling,
} from '@cubetrace/rtc';

import type { CloudAccount } from '../auth/auth-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';

/**
 * A session's signaling for either device (docs/RTC.md §5): what the host's Cameras panel and the
 * phone's Camera page need of `@cubetrace/rtc`'s `FirestoreSignaling`, which satisfies it. The host
 * publishes a pairing and watches for offers; the phone checks a pairing and calls.
 */
export interface SessionSignaling {
  readonly sessionId: string;
  /** Publishes the hash of `token` in the session's document, good for `ttlMs` (10 minutes by default). */
  publishPairing(token: string, ttlMs?: number): Promise<SessionPairing>;
  /** Closes the pairing: no token is taken until the next `publishPairing`. */
  closePairing(): Promise<void>;
  /** Calls `next` once for each peer that offers, with the host's side of its signaling. */
  watchOffers(next: (offer: IncomingOffer) => void, error: (error: unknown) => void): () => void;
  /** Whether the session takes `token` now. */
  checkPairing(token: string): Promise<PairingCheck>;
  /** The phone's side of a new peer connection, which presents the token's hash. */
  call(options: { tokenHash: string; peerId?: string }): Signaling;
}

/** Makes the signaling of `sessionId` for the account signed in. */
export type SessionSignalingFactory = (
  account: CloudAccount,
  sessionId: string,
) => SessionSignaling;

/**
 * The window property through which the end-to-end suite replaces the signaling with its fake over a
 * `BroadcastChannel` (a function of the session id and the uid that gives a {@link SessionSignaling};
 * apps/web/e2e/helpers/signaling.ts). Read only in development builds (`ng serve`), never in
 * production ones, like the account's `E2E_ACCOUNT_LOADER`.
 */
export const E2E_SIGNALING = 'cubetraceE2eSignaling';

/**
 * The signaling's factory: Firestore, through the account's backend, over the documents of
 * docs/DATA-MODEL.md §10. In development builds, the end-to-end suite's fake replaces it. The
 * services that pair are in lazy chunks, so this file, and `@cubetrace/rtc` with it, loads only with
 * them.
 */
export const SESSION_SIGNALING = new InjectionToken<SessionSignalingFactory>('SESSION_SIGNALING', {
  providedIn: 'root',
  factory: () => {
    const globals = inject(BROWSER_GLOBALS);
    const e2e: unknown = isDevMode() ? Reflect.get(globals, E2E_SIGNALING) : null;
    if (typeof e2e === 'function') {
      const make = e2e as (sessionId: string, uid: string) => SessionSignaling;
      return (account, sessionId) => make(sessionId, account.uid);
    }
    return (account, sessionId) =>
      new FirestoreSignaling(account.backend, { sessionId, uid: account.uid });
  },
});
