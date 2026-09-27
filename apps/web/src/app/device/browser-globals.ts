import { DOCUMENT, InjectionToken, inject } from '@angular/core';

/**
 * The parts of the browser's global object that the device services read. Every API is
 * optional because the app also runs, with a warning, on browsers that lack them.
 */
export interface BrowserGlobals {
  readonly navigator?: Partial<Navigator>;
  readonly VideoEncoder?: unknown;
  /** Web Storage, for the settings. Reading it throws where the browser blocks storage. */
  readonly localStorage?: Storage;
  /** For files the app loads on demand, such as the demo solves. */
  readonly fetch?: typeof fetch;
  /** The host clock: `performance.timeOrigin + performance.now()` (docs/DATA-MODEL.md §1). */
  readonly performance?: Pick<Performance, 'timeOrigin' | 'now'>;
  /** Drives the running timer, one update per frame. */
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  /** Object URLs, for the files the app hands the user (a session export). */
  readonly URL?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

/**
 * The host clock now, in ms: `performance.timeOrigin + performance.now()` (docs/DATA-MODEL.md §1),
 * or the wall clock where the browser has no `performance`.
 */
export function hostNow(globals: BrowserGlobals): number {
  const performance = globals.performance;
  return performance === undefined ? Date.now() : performance.timeOrigin + performance.now();
}

/** The browser's `window` in the app; unit tests provide a fake with the APIs they need. */
export const BROWSER_GLOBALS = new InjectionToken<BrowserGlobals>('BROWSER_GLOBALS', {
  providedIn: 'root',
  factory: () => inject(DOCUMENT).defaultView ?? {},
});
