import { DOCUMENT, DestroyRef, Injectable, inject, signal } from '@angular/core';

import { BROWSER_GLOBALS } from './browser-globals';

/**
 * `unsupported`: the browser has no Screen Wake Lock API. `inactive`: the screen follows the
 * system's timeout. `active`: the screen stays on. `error`: the browser refused the lock.
 */
export type WakeLockStatus = 'unsupported' | 'inactive' | 'active' | 'error';

/** Short labels and explanations of each status, for the header and the Settings page. */
export const WAKE_LOCK_TEXT: Readonly<Record<WakeLockStatus, { label: string; detail: string }>> = {
  unsupported: {
    label: 'No wake lock',
    detail: 'This browser cannot keep the screen on (no Screen Wake Lock API).',
  },
  inactive: {
    label: 'Screen may sleep',
    detail: 'The screen turns off after the system timeout.',
  },
  active: {
    label: 'Screen on',
    detail: 'The screen stays on while cubetrace is visible.',
  },
  error: {
    label: 'Wake lock refused',
    detail: 'The browser refused to keep the screen on.',
  },
};

/**
 * Keeps the screen on while the app wants it (a session in progress, or the switch in
 * Settings). Chrome releases a wake lock whenever the page is hidden, so the lock is
 * requested again each time the page becomes visible, until `release()`.
 */
@Injectable({ providedIn: 'root' })
export class WakeLockService {
  private readonly document = inject(DOCUMENT);
  private readonly wakeLock = inject(BROWSER_GLOBALS).navigator?.wakeLock;
  private readonly statusSignal = signal<WakeLockStatus>(
    this.wakeLock ? 'inactive' : 'unsupported',
  );
  private readonly wantedSignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private sentinel: WakeLockSentinel | null = null;
  private pending: Promise<void> | null = null;

  /** The lock's state now; `active` means the screen stays on. */
  readonly status = this.statusSignal.asReadonly();
  /** Whether the app asked for the lock (between `request()` and `release()`). */
  readonly wanted = this.wantedSignal.asReadonly();
  /** The browser's reason when the last request failed, otherwise null. */
  readonly error = this.errorSignal.asReadonly();

  constructor() {
    const onVisibilityChange = (): void => {
      if (this.document.visibilityState === 'visible' && this.wantedSignal()) {
        void this.acquire();
      }
    };
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      void this.release();
    });
  }

  /** Keeps the screen on until `release()`; does nothing where the API is missing. */
  async request(): Promise<void> {
    if (!this.wakeLock) {
      return;
    }
    this.wantedSignal.set(true);
    await this.acquire();
  }

  /** Lets the screen turn off again. */
  async release(): Promise<void> {
    this.wantedSignal.set(false);
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (this.wakeLock) {
      this.statusSignal.set('inactive');
      this.errorSignal.set(null);
    }
    await sentinel?.release();
  }

  private acquire(): Promise<void> {
    const wakeLock = this.wakeLock;
    // A hidden page cannot hold the lock; the next `visibilitychange` asks again.
    if (!wakeLock || this.sentinel || this.document.visibilityState !== 'visible') {
      return Promise.resolve();
    }
    this.pending ??= wakeLock
      .request('screen')
      .then(async (sentinel) => {
        if (!this.wantedSignal()) {
          // `release()` was called while the request was pending.
          await sentinel.release();
          return;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener('release', () => {
          // Released by the browser (the page was hidden), not by `release()`.
          if (this.sentinel === sentinel) {
            this.sentinel = null;
            this.statusSignal.set('inactive');
          }
        });
        this.statusSignal.set('active');
        this.errorSignal.set(null);
      })
      .catch((error: unknown) => {
        this.statusSignal.set('error');
        this.errorSignal.set(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
