import { Component, computed, inject } from '@angular/core';

import {
  STORAGE_STOP_PERCENT,
  STORAGE_WARN_PERCENT,
  StorageService,
} from '../device/storage-service';
import { formatBytes } from './format-bytes';

/**
 * The storage meter (docs/PLAN.md, T2.4), in Camera settings and on the Sessions page: how much
 * of the origin's quota the app uses (`navigator.storage.estimate()`, read again when it is shown),
 * a warning from 80% ("export or delete sessions"), and from 95% that the camera stopped recording
 * while the timer goes on.
 */
@Component({
  selector: 'app-storage-meter',
  template: `
    <div
      class="meter"
      data-testid="storage-meter"
      [attr.data-level]="storage.level()"
      [attr.data-percent]="storage.percent()"
    >
      <span id="storage-meter-label">Storage</span>
      @if (storage.usage(); as usage) {
        <meter
          aria-labelledby="storage-meter-label"
          min="0"
          max="100"
          optimum="0"
          [low]="warnPercent"
          [high]="stopPercent"
          [value]="storage.percent() ?? 0"
        ></meter>
        <span data-testid="storage-meter-text"
          >{{ bytes(usage.usage) }} of {{ bytes(usage.quota) }} ({{ percent() }})</span
        >
      } @else {
        <span class="muted" data-testid="storage-meter-text">unknown in this browser</span>
      }
    </div>
    @switch (storage.level()) {
      @case ('warn') {
        <p class="warning" role="alert" data-testid="storage-warning">
          Storage is {{ percent() }} full: export or delete sessions.
        </p>
      }
      @case ('full') {
        <p class="error" role="alert" data-testid="storage-warning">
          Storage is {{ percent() }} full: the camera stopped recording (the timer goes on). Export
          or delete sessions to record again.
        </p>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-1);
    }

    p {
      margin: 0;
    }

    .meter {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
      font-size: 0.875rem;
    }

    meter {
      width: 8rem;
    }

    .muted {
      color: var(--text-muted);
    }

    .warning {
      color: var(--warn);
    }

    .error {
      color: var(--danger);
    }
  `,
})
export class StorageMeter {
  protected readonly storage = inject(StorageService);
  protected readonly warnPercent = STORAGE_WARN_PERCENT;
  protected readonly stopPercent = STORAGE_STOP_PERCENT;
  /** "83%": whole percents, down, so that 94.9% does not read 95%. */
  protected readonly percent = computed(
    () => `${String(Math.floor(this.storage.percent() ?? 0))}%`,
  );

  constructor() {
    void this.storage.refresh();
  }

  protected bytes(count: number): string {
    return formatBytes(count);
  }
}
