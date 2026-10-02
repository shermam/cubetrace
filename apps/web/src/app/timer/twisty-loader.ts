import { InjectionToken } from '@angular/core';

/**
 * Loads cubing.js's `<twisty-player>` element (`cubing/twisty` defines it when imported). A dynamic
 * import, so that it is a lazy chunk of its own and nothing of it is in the initial bundle; the unit
 * tests give a loader that does nothing. The scramble view (its 2D picture) and the clip viewer
 * (its 3D cube, T3.8) share it, from a module of its own so that neither pulls the other's code.
 */
export const TWISTY_LOADER = new InjectionToken<() => Promise<unknown>>('TWISTY_LOADER', {
  providedIn: 'root',
  factory: () => () => import('cubing/twisty'),
});
