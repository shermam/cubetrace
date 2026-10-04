import { InjectionToken, inject } from '@angular/core';
import type { Timers } from '@cubetrace/rtc';

import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { e2eRemote } from './e2e-remote';

/**
 * The clock and the timers of the remote cameras' services (`@cubetrace/rtc`'s `Timers`): the host
 * clock and the browser's timers, read through BROWSER_GLOBALS so that the unit tests give the fakes
 * they drive (`FakeTimers` of `@cubetrace/rtc`). In a development build, the end-to-end suite may
 * move a camera device's clock (`E2eRemote.clockOffsetMs`, T4.2): everything that page says of its
 * clock over the connection then is off by that much, as a phone's own clock is off the host's.
 */
export const RTC_TIMERS = new InjectionToken<Timers>('RTC_TIMERS', {
  providedIn: 'root',
  factory: () => {
    const globals = inject(BROWSER_GLOBALS);
    const offsetMs = e2eRemote(globals).clockOffsetMs ?? 0;
    return {
      now: () => hostNow(globals) + offsetMs,
      setTimeout: (callback, ms) =>
        globals.setTimeout === undefined
          ? setTimeout(callback, ms)
          : globals.setTimeout(callback, ms),
      clearTimeout: (handle) => {
        if (globals.clearTimeout === undefined) {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        } else {
          globals.clearTimeout(handle as number);
        }
      },
    };
  },
});
