import { Component, computed, inject } from '@angular/core';

import { type StoragePersistence, StorageService } from '../device/storage-service';
import { WAKE_LOCK_TEXT, WakeLockService } from '../device/wake-lock-service';

const PERSISTENCE_TEXT: Readonly<Record<StoragePersistence, string>> = {
  unsupported: 'This browser has no Storage API, so it cannot be asked to keep the data.',
  unknown: 'Checking whether the browser keeps the data…',
  persistent: 'Persistent: the browser keeps cubetrace’s data until you delete it.',
  'best-effort': 'Best effort: the browser may delete cubetrace’s data when the disk runs short.',
};

/**
 * `/settings`: the screen wake lock and storage persistence. Inspection, auto-advance, the
 * host label and cube addresses arrive with T1.6.
 */
@Component({
  selector: 'app-settings-page',
  template: `
    <h1>Settings</h1>

    <section aria-labelledby="screen-heading">
      <h2 id="screen-heading">Screen</h2>
      <label class="switch">
        <input
          #keepAwake
          type="checkbox"
          [checked]="wakeLock.wanted()"
          [disabled]="wakeLock.status() === 'unsupported'"
          (change)="setKeepAwake(keepAwake.checked)"
        />
        Keep the screen on
      </label>
      <p class="status" data-testid="wake-lock-detail">
        {{ wakeLockText().detail }}
        @if (wakeLock.error(); as error) {
          ({{ error }})
        }
      </p>
      <p class="hint">The timer will also turn it on by itself during a session (T1.6).</p>
    </section>

    <section aria-labelledby="storage-heading">
      <h2 id="storage-heading">Storage</h2>
      <p class="status" data-testid="storage-persistence">
        {{ persistenceText[storage.persistence()] }}
      </p>
      @if (storage.usage(); as usage) {
        <p class="status" data-testid="storage-usage">
          Using {{ bytes(usage.usage) }} of the {{ bytes(usage.quota) }} this browser allows.
        </p>
      }
      <button type="button" class="primary" [disabled]="!canPersist()" (click)="keepData()">
        Keep my data
      </button>
      <p class="hint">The timer will also ask when the first session starts (T1.6).</p>
      @if (storage.refused()) {
        <p class="hint" data-testid="storage-refused">
          The browser said no. Chrome grants it to installed apps and to sites used often: install
          cubetrace (Install app, or Add to Home screen) and try again.
        </p>
      }
    </section>

    <p class="hint">Inspection, auto-advance, host label and cube addresses arrive with T1.6.</p>
  `,
  styles: `
    section {
      margin-bottom: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }

    h2 {
      margin-top: 0;
    }

    .switch {
      display: inline-flex;
      gap: var(--space-2);
      align-items: center;
    }

    .status {
      margin: var(--space-2) 0;
    }

    .hint {
      color: var(--text-muted);
      font-size: 0.875rem;
    }
  `,
})
export class SettingsPage {
  protected readonly wakeLock = inject(WakeLockService);
  protected readonly storage = inject(StorageService);
  protected readonly wakeLockText = computed(() => WAKE_LOCK_TEXT[this.wakeLock.status()]);
  protected readonly persistenceText = PERSISTENCE_TEXT;
  protected readonly canPersist = computed(() => {
    const persistence = this.storage.persistence();
    return persistence === 'unknown' || persistence === 'best-effort';
  });

  constructor() {
    void this.storage.refresh();
  }

  protected setKeepAwake(on: boolean): void {
    void (on ? this.wakeLock.request() : this.wakeLock.release());
  }

  protected keepData(): void {
    void this.storage.persist();
  }

  /** Decimal units, as Chrome shows storage: "0 B", "12.3 kB", "1.2 GB". */
  protected bytes(count: number): string {
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let value = count;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit++;
    }
    return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit] ?? ''}`;
  }
}
