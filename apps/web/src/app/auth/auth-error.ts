import { errorMessage } from '../shared/error-message';

/** The account's code could not be loaded (the Firebase chunk: offline, or a failed download). */
export class AccountLoadError extends Error {
  constructor(readonly reason: unknown) {
    super(`the account could not be loaded: ${errorMessage(reason)}`);
    this.name = 'AccountLoadError';
  }
}

/** A sign-in by redirect came back from Google's page without an account. */
export class RedirectLostError extends Error {
  constructor() {
    super('the page came back from Google without an account');
    this.name = 'RedirectLostError';
  }
}

/** What to say for each Firebase Authentication error code that a sign-in can meet. */
const AUTH_ERRORS: Readonly<Record<string, string>> = {
  'auth/popup-closed-by-user': 'Signing in was cancelled: the Google window was closed first.',
  'auth/cancelled-popup-request': 'Signing in was cancelled: the Google window was closed first.',
  'auth/user-cancelled': 'Signing in was cancelled.',
  'auth/redirect-cancelled-by-user': 'Signing in was cancelled.',
  'auth/popup-blocked':
    'Chrome blocked the Google window: allow pop-ups for this site (the icon at the end of the ' +
    'address bar), then sign in again.',
  'auth/network-request-failed':
    'No connection to Google: sign in again once the device is online.',
  'auth/timeout': 'Google did not answer in time: sign in again.',
  'auth/too-many-requests': 'Too many attempts to sign in: wait a few minutes, then try again.',
  'auth/user-disabled': 'This Google account is disabled in cubetrace.',
  'auth/unauthorized-domain':
    'This address may not sign in to cubetrace: its domain is not among the authorized domains of ' +
    'the Firebase project (docs/USER-ACTIONS.md).',
  'auth/operation-not-allowed':
    'Signing in with Google is not enabled in the Firebase project (docs/USER-ACTIONS.md).',
  'auth/web-storage-unsupported':
    'This browser blocks the storage that signing in needs (cookies and site data): allow them for ' +
    'this site, then sign in again.',
};

/**
 * The sentence the account controls show for a failed sign-in, sign-out or start: what happened and
 * what to do, from the Firebase error's code when it has one.
 */
export function authErrorMessage(error: unknown): string {
  if (error instanceof AccountLoadError) {
    return (
      `The account could not be loaded (${errorMessage(error.reason)}): try again once the device ` +
      'is online.'
    );
  }
  if (error instanceof RedirectLostError) {
    return 'Signing in did not finish: Google sent the page back without an account. Sign in again.';
  }
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  if (typeof code === 'string' && code in AUTH_ERRORS) {
    return AUTH_ERRORS[code];
  }
  // Firebase's own messages end with the code ("Firebase: Error (auth/internal-error).").
  const message = errorMessage(error).replace(/\.$/, '');
  const detail = typeof code === 'string' && !message.includes(code) ? ` (${code})` : '';
  return `Signing in failed: ${message}${detail}.`;
}
