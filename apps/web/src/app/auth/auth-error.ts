import { errorMessage } from '../shared/error-message';

/** The account's code could not be loaded (the Firebase chunk: offline, or a failed download). */
export class AccountLoadError extends Error {
  constructor(readonly reason: unknown) {
    super(`the account could not be loaded: ${errorMessage(reason)}`);
    this.name = 'AccountLoadError';
  }
}

/** Where a sign-in ran, which decides what a popup that did not finish should say. */
export interface AuthErrorContext {
  /**
   * The app runs installed (display mode `standalone`), where Google's window opens over it (a Custom
   * Tab on Android) and the browser's own remedies, such as allowing pop-ups from the address bar, are
   * out of reach.
   */
  readonly installed: boolean;
}

/** What to say for each Firebase Authentication error code that a sign-in can meet. */
const AUTH_ERRORS: Readonly<Record<string, string>> = {
  'auth/popup-closed-by-user': 'Signing in was cancelled: the Google window was closed first.',
  'auth/cancelled-popup-request': 'Signing in was cancelled: the Google window was closed first.',
  'auth/user-cancelled': 'Signing in was cancelled.',
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

/** The codes of a popup that was blocked, or closed before Google was done. */
const POPUP_ERRORS: ReadonlySet<string> = new Set([
  'auth/popup-blocked',
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
]);

/**
 * What a popup that did not finish says in the installed app (docs/ARCHITECTURE.md, "Account"):
 * Chrome's installed apps share the site's storage with Chrome's tabs (the account that Firebase
 * keeps in IndexedDB, and the `localStorage` that remembers it, are the same), so a sign-in made in a
 * Chrome tab at the app's address is the installed app's too.
 */
export const INSTALLED_POPUP_MESSAGE =
  "Google's window did not finish signing in from the installed app. Open the app's address in " +
  'Chrome itself and sign in there once: the installed app shares its storage with Chrome, so that ' +
  'signs it in too. Then open the installed app again.';

/**
 * The sentence the account controls show for a failed sign-in, sign-out or start: what happened and
 * what to do, from the Firebase error's code when it has one, and from where the sign-in ran.
 */
export function authErrorMessage(error: unknown, context: AuthErrorContext): string {
  if (error instanceof AccountLoadError) {
    return (
      `The account could not be loaded (${errorMessage(error.reason)}): try again once the device ` +
      'is online.'
    );
  }
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  if (typeof code === 'string' && context.installed && POPUP_ERRORS.has(code)) {
    return INSTALLED_POPUP_MESSAGE;
  }
  if (typeof code === 'string' && code in AUTH_ERRORS) {
    return AUTH_ERRORS[code];
  }
  // Firebase's own messages end with the code ("Firebase: Error (auth/internal-error).").
  const message = errorMessage(error).replace(/\.$/, '');
  const detail = typeof code === 'string' && !message.includes(code) ? ` (${code})` : '';
  return `Signing in failed: ${message}${detail}.`;
}
