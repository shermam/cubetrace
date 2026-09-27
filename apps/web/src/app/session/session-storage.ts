import { InjectionToken, inject } from '@angular/core';
import { MemorySessionStore, type SessionStore } from '@cubetrace/core';
import { OpfsSessionStore, opfsAvailable, type ProblemReporter } from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';

/** Where the sessions are kept. */
export interface SessionStorage {
  /**
   * The store. The OPFS one also lists the files it could not read (`listProblems`); the memory
   * one has none.
   */
  readonly store: SessionStore & Partial<ProblemReporter>;
  /**
   * `opfs`: in the browser's origin private file system (docs/DATA-MODEL.md §5), kept across
   * reloads; `memory`: this browser has no OPFS, so sessions last until the page closes.
   */
  readonly kind: 'opfs' | 'memory';
}

/**
 * The session store of the app: an `OpfsSessionStore` on `navigator.storage.getDirectory()`, or,
 * where the browser has no origin private file system, a `MemorySessionStore` (the timer page
 * then says that nothing is kept). The unit tests provide a `MemorySessionStore`.
 */
export const SESSION_STORAGE = new InjectionToken<SessionStorage>('SESSION_STORAGE', {
  providedIn: 'root',
  factory: () => {
    const navigator = inject(BROWSER_GLOBALS).navigator;
    return opfsAvailable(navigator)
      ? { store: new OpfsSessionStore(navigator.storage.getDirectory()), kind: 'opfs' }
      : { store: new MemorySessionStore(), kind: 'memory' };
  },
});
