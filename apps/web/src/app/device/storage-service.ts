import { Injectable, inject, signal } from '@angular/core';

import { BROWSER_GLOBALS } from './browser-globals';

/**
 * `persistent`: the browser keeps the app's data until the user deletes it. `best-effort`: the
 * browser may delete it when the disk runs short. `unknown`: not checked yet, or the check
 * failed. `unsupported`: no Storage API (`navigator.storage`).
 */
export type StoragePersistence = 'unsupported' | 'unknown' | 'persistent' | 'best-effort';

/** Bytes used by the app and the quota the browser gives it (`navigator.storage.estimate()`). */
export interface StorageUsage {
  readonly usage: number;
  readonly quota: number;
}

/**
 * Asks the browser to keep the app's storage (sessions staged in OPFS) out of automatic
 * eviction, and reports the result and the quota. Chrome answers `persist()` without a prompt,
 * from how the site is used: it grants it to installed apps and to sites used often.
 */
@Injectable({ providedIn: 'root' })
export class StorageService {
  private readonly storage = inject(BROWSER_GLOBALS).navigator?.storage;
  private readonly persistenceSignal = signal<StoragePersistence>(
    this.storage ? 'unknown' : 'unsupported',
  );
  private readonly usageSignal = signal<StorageUsage | null>(null);
  private readonly refusedSignal = signal(false);

  readonly persistence = this.persistenceSignal.asReadonly();
  /** Null until `refresh()` or `persist()` has read it, or when the browser cannot tell. */
  readonly usage = this.usageSignal.asReadonly();
  /** `persist()` was called and the browser said no. */
  readonly refused = this.refusedSignal.asReadonly();

  /** Reads the persistence status and the usage again. */
  async refresh(): Promise<void> {
    const storage = this.storage;
    if (!storage) {
      return;
    }
    const [persisted, estimate] = await Promise.allSettled([
      storage.persisted(),
      storage.estimate(),
    ]);
    if (persisted.status === 'fulfilled') {
      this.persistenceSignal.set(persisted.value ? 'persistent' : 'best-effort');
    } else {
      this.persistenceSignal.set('unknown');
    }
    if (estimate.status === 'fulfilled') {
      const { usage, quota } = estimate.value;
      this.usageSignal.set(usage === undefined || quota === undefined ? null : { usage, quota });
    }
  }

  /**
   * Asks for persistent storage (`navigator.storage.persist()`); resolves to whether it is
   * granted. Settings has a button for it; the timer calls it when it creates its first session
   * (`SessionService`).
   */
  async persist(): Promise<boolean> {
    const storage = this.storage;
    if (!storage) {
      return false;
    }
    let granted = false;
    try {
      granted = await storage.persist();
    } catch {
      // Treated as a refusal: the status below says what the browser decided.
    }
    this.refusedSignal.set(!granted);
    await this.refresh();
    return granted;
  }
}
