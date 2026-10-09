import { DestroyRef, inject, signal, type Signal } from '@angular/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { remotePicturesDefault, type RemotePictures } from '../settings/settings-service';

/**
 * How the Timer page lays out the scramble, the time and the camera's picture (docs/PLAN.md, T2.7
 * and T2.13):
 * - `columns`, a wide window (from {@link TWO_COLUMNS_QUERY}): T2.7's two columns, the picture beside
 *   the time;
 * - `stacked`, a phone with Scramble over the picture off (Settings → Timer): T2.7's column, the
 *   scramble, the time, then the picture;
 * - `pinned`, a phone with the camera off: the same column, the scramble pinned at the top of the
 *   window while the page scrolls;
 * - `overlay`, a phone with the camera on: its picture pinned at the top of the window, as wide as
 *   the screen, with the scramble over its lower part, and the time under them.
 */
export type TimerLayout = 'columns' | 'stacked' | 'pinned' | 'overlay';

/** The windows that have the Timer page's two columns: `$two-columns` in styles/_layout.scss. */
export const TWO_COLUMNS_QUERY = '(min-width: 60rem)';

/**
 * The Timer page's layout (see {@link TimerLayout}) in a window that is `wide` or not (whether
 * {@link TWO_COLUMNS_QUERY} matches), with the camera on or off, and with the Scramble over the
 * picture setting.
 */
export function timerLayout(
  wide: boolean,
  cameraOn: boolean,
  scrambleOverPicture: boolean,
): TimerLayout {
  if (wide) {
    return 'columns';
  }
  if (!scrambleOverPicture) {
    return 'stacked';
  }
  return cameraOn ? 'overlay' : 'pinned';
}

/**
 * How the Timer page shows the phones' pictures (T5.1): "Pictures from phones" as `chosen` in Camera
 * settings → Cameras, else this device's default (small tiles on a `phone`, the same size as its own
 * picture elsewhere), in the Timer page's `layout`: always tiles in a phone's `overlay` (T2.13), whose
 * picture is pinned at the top of the window, under the scramble, as wide as the screen. The width of
 * the window decides that layout (`timerLayout`); within `columns`, whether the cells of `equal`
 * stand side by side or under one another is the page's container query (`timer-page.ts`).
 */
export function remotePicturesLayout(
  chosen: RemotePictures | null,
  layout: TimerLayout,
  phone: boolean,
): RemotePictures {
  if (layout === 'overlay') {
    return 'tiles';
  }
  return chosen ?? remotePicturesDefault(phone);
}

/**
 * Whether the window matches the media query `query`, as a signal that follows it (a phone turned,
 * a window resized), until the caller is destroyed; false where the browser has no `matchMedia`.
 * Called in an injection context, such as a component's field.
 */
export function windowMatches(query: string): Signal<boolean> {
  const list = inject(BROWSER_GLOBALS).matchMedia?.(query);
  const matches = signal(list?.matches ?? false);
  if (list !== undefined) {
    const onChange = (): void => {
      matches.set(list.matches);
    };
    list.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => {
      list.removeEventListener('change', onChange);
    });
  }
  return matches.asReadonly();
}
