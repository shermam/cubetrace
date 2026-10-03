import { InjectionToken, inject } from '@angular/core';
import type { Timers } from '@cubetrace/rtc';

import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';

/**
 * The clock and the timers of the remote cameras' services (`@cubetrace/rtc`'s `Timers`): the host
 * clock and the browser's timers, read through BROWSER_GLOBALS so that the unit tests give the fakes
 * they drive (`FakeTimers` of `@cubetrace/rtc`).
 */
export const RTC_TIMERS = new InjectionToken<Timers>('RTC_TIMERS', {
  providedIn: 'root',
  factory: () => {
    const globals = inject(BROWSER_GLOBALS);
    return {
      now: () => hostNow(globals),
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
