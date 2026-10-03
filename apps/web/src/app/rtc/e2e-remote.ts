import { isDevMode } from '@angular/core';

import type { BrowserGlobals } from '../device/browser-globals';

/**
 * The window property through which the end-to-end suite bends the remote cameras' clips (T4.2),
 * read only in development builds (`ng serve`), never in production ones, like
 * `window.cubetraceE2eSignaling` (session-signaling.ts): apps/web/e2e/remote-clips.spec.ts sets it
 * before the app's scripts run.
 */
export const E2E_REMOTE = 'cubetraceE2eRemote';

/** What the end-to-end suite may set (each field optional). */
export interface E2eRemote {
  /**
   * The camera device's clock, as the connection sees it, runs this far ahead of the page's own, in
   * ms (`RTC_TIMERS`): two pages of one browser share a clock, and the suite wants a phone whose
   * clock is off, so that the conversion of its clips' times to the host clock shows.
   */
  readonly clockOffsetMs?: number;
  /**
   * The camera device closes its connection, once, when this many bytes of a clip's file have gone
   * and more are left: a transfer cut in the middle of a file, which the reconnection resumes.
   */
  readonly closeAfterBytes?: number;
  /** The camera device never answers a cut: a phone that never sends its clips. */
  readonly ignoreCuts?: boolean;
  /** The host waits this long for the remote clips after an attempt's end, in place of 120 s. */
  readonly clipWaitMs?: number;
}

/** The end-to-end suite's settings, in a development build; none otherwise. */
export function e2eRemote(globals: BrowserGlobals): E2eRemote {
  if (!isDevMode()) {
    return {};
  }
  const value: unknown = Reflect.get(globals, E2E_REMOTE);
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const number = (key: string): number | undefined => {
    const field: unknown = Reflect.get(value, key);
    return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
  };
  const ignoreCuts: unknown = Reflect.get(value, 'ignoreCuts');
  return {
    clockOffsetMs: number('clockOffsetMs'),
    closeAfterBytes: number('closeAfterBytes'),
    ignoreCuts: ignoreCuts === true,
    clipWaitMs: number('clipWaitMs'),
  };
}
