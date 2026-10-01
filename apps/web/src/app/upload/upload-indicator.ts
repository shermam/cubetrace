import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { indicatorOf } from './upload-text';
import { UploadService } from './upload-service';

/**
 * The header's upload indicator (T3.3): an arrow with the number of attempts still to upload (or of
 * those that failed), which opens the Sessions page's queue; nothing while there is nothing to
 * upload, and signed out. Its title says what the queue does: uploading, paused by the day's quota
 * until a time, waiting for Wi-Fi or for the network, and the failures.
 */
@Component({
  selector: 'app-upload-indicator',
  imports: [RouterLink],
  template: `
    @if (shown(); as shown) {
      <a
        class="uploads"
        routerLink="/sessions"
        fragment="uploads"
        data-testid="upload-indicator"
        [attr.data-state]="shown.state"
        [attr.aria-label]="shown.title"
        [title]="shown.title"
        ><span class="arrow" aria-hidden="true">↑</span
        ><span class="count" data-testid="upload-count">{{ shown.count }}</span></a
      >
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    .uploads {
      --status-colour: var(--accent);

      display: inline-flex;
      gap: var(--space-1);
      align-items: center;
      padding: 0 var(--space-2);
      border: 1px solid var(--status-colour);
      border-radius: 999px;
      color: var(--status-colour);
      font-size: 0.875rem;
      font-variant-numeric: tabular-nums;
      line-height: 1.75;
      text-decoration: none;
      white-space: nowrap;

      &[data-state='paused'] {
        --status-colour: var(--text-muted);

        border-style: dashed;
      }

      &[data-state='failed'] {
        --status-colour: var(--danger);
      }
    }

    .arrow {
      font-weight: 700;
    }
  `,
})
export class UploadIndicator {
  private readonly uploads = inject(UploadService);

  protected readonly shown = computed(() => indicatorOf(this.uploads.outstanding()));
}
