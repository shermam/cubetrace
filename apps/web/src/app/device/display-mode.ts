import type { BrowserGlobals } from './browser-globals';

/**
 * Whether the app runs installed (display mode `standalone`: Chrome's WebAPK on Android, a window of
 * its own on a laptop) rather than in a browser tab. The account's sign-in is the same popup either
 * way, which Chrome on Android opens over the installed app as a Custom Tab (docs/ARCHITECTURE.md,
 * "Account"); only what a popup that did not finish says differs (`AuthErrorContext`), and the
 * diagnostics events say where the app ran (T3.9).
 */
export function installedApp(globals: BrowserGlobals): boolean {
  return globals.matchMedia?.('(display-mode: standalone)').matches === true;
}
