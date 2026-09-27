import { DOCUMENT, InjectionToken, inject } from '@angular/core';

/**
 * The parts of the browser's global object that the device services read. Every API is
 * optional because the app also runs, with a warning, on browsers that lack them.
 */
export interface BrowserGlobals {
  readonly navigator?: Partial<Navigator>;
  readonly VideoEncoder?: unknown;
}

/** The browser's `window` in the app; unit tests provide a fake with the APIs they need. */
export const BROWSER_GLOBALS = new InjectionToken<BrowserGlobals>('BROWSER_GLOBALS', {
  providedIn: 'root',
  factory: () => inject(DOCUMENT).defaultView ?? {},
});
