import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AttemptView } from '@cubetrace/upload';

import { formatBytes } from '../shared/format-bytes';
import { attemptStateText, attemptsText, countsText, statusText, uploadTime } from './upload-text';
import { UploadService } from './upload-service';

/** The attempts the panel lists, the first in the queue's order; it counts the others. */
export const PANEL_ROWS = 20;

/**
 * The upload queue on the Sessions page (T3.3), signed in: where the uploads are (running, paused by
 * the day's quota until a time, waiting for Wi-Fi or the network, off, another tab uploading), the
 * attempts by state, and each attempt still to upload in the queue's order (the oldest session first)
 * with its progress, its last error and, once it failed, Retry; the attempts uploaded last, and the
 * clips deleted from the device once uploaded.
 */
@Component({
  selector: 'app-upload-panel',
  imports: [RouterLink],
  template: `
    <section
      id="uploads"
      class="panel"
      aria-labelledby="uploads-heading"
      data-testid="upload-panel"
      [attr.data-status]="uploads.status()"
    >
      <h2 id="uploads-heading">Uploads</h2>
      <p data-testid="upload-status">{{ status() }}</p>
      @if (uploads.error(); as error) {
        <p class="error" role="alert" data-testid="upload-load-error">{{ error }}</p>
      }
      @if (view(); as view) {
        <p class="muted" data-testid="upload-counts">{{ counts() }}</p>
        @if (view.active.length > 0) {
          <ul class="rows">
            @for (attempt of rows(); track attempt.sessionId + '/' + attempt.index) {
              <li
                data-testid="upload-row"
                [attr.data-session]="attempt.sessionId"
                [attr.data-index]="attempt.index"
                [attr.data-state]="attempt.state"
              >
                <p class="what">
                  <a [routerLink]="['/sessions', attempt.sessionId]">{{
                    when(attempt.sessionCreatedMs)
                  }}</a>
                  · attempt {{ attempt.index }}
                  <span
                    class="state"
                    data-testid="upload-state"
                    [attr.data-state]="attempt.state"
                    >{{ stateText(attempt) }}</span
                  >
                </p>
                <progress
                  [max]="attempt.bytes"
                  [value]="attempt.sent"
                  [attr.aria-label]="'Attempt ' + attempt.index + ' sent'"
                ></progress>
                <span class="bytes muted" data-testid="upload-bytes"
                  >{{ bytes(attempt.sent) }} of {{ bytes(attempt.bytes) }}</span
                >
                @if (attempt.error; as error) {
                  <p
                    class="reason"
                    [class.error]="attempt.state === 'failed'"
                    data-testid="upload-error"
                  >
                    {{ error }}
                  </p>
                }
                @if (attempt.state === 'failed') {
                  <button type="button" data-testid="upload-retry" (click)="retry(attempt)">
                    Retry
                  </button>
                }
              </li>
            }
          </ul>
          @if (more() > 0) {
            <p class="muted" data-testid="upload-more">
              And {{ attemptsText(more()) }} after them.
            </p>
          }
          @if (view.counts.failed > 1) {
            <button type="button" data-testid="upload-retry-all" (click)="retryAll()">
              Retry all
            </button>
          }
        }
        @if (view.recent.length > 0) {
          <p class="muted" data-testid="upload-recent">
            Uploaded last:
            @for (attempt of view.recent; track attempt.sessionId + '/' + attempt.index) {
              <span
                >{{ $first ? '' : ', ' }}attempt {{ attempt.index }} of
                {{ when(attempt.sessionCreatedMs) }}</span
              >
            }
          </p>
        }
        @if (view.freed.clips > 0) {
          <p class="muted" data-testid="upload-freed">
            {{ view.freed.clips }} uploaded {{ view.freed.clips === 1 ? 'clip' : 'clips' }} deleted
            from this device ({{ bytes(view.freed.bytes) }}): they are in the cloud.
          </p>
        }
        @if (view.error; as error) {
          <p class="warning" data-testid="upload-queue-error">{{ error }}</p>
        }
      }
    </section>
  `,
  styles: `
    .panel {
      display: grid;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }

    h2 {
      margin: 0;
      font-size: 1rem;
    }

    p {
      margin: 0;
    }

    .muted {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger);
    }

    .warning {
      color: var(--warn);
    }

    .rows {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-1) var(--space-3);
      align-items: center;
      padding: var(--space-2) 0;
      border-top: 1px solid var(--line);
    }

    .what,
    .reason {
      grid-column: 1 / -1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .reason {
      color: var(--warn);
      font-size: 0.875rem;
    }

    .reason.error {
      color: var(--danger);
    }

    progress {
      width: 100%;
      accent-color: var(--accent);
    }

    .bytes {
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
    }

    .state {
      margin-left: var(--space-2);
      padding: 0 var(--space-2);
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--text-muted);
      font-size: 0.75rem;

      &[data-state='uploading'] {
        border-color: var(--accent);
        color: var(--accent);
      }

      &[data-state='failed'] {
        border-color: var(--danger);
        color: var(--danger);
      }
    }

    button {
      justify-self: start;
    }
  `,
})
export class UploadPanel {
  protected readonly uploads = inject(UploadService);

  protected readonly view = this.uploads.view;
  protected readonly status = computed(() => statusText(this.uploads.status(), this.view()));
  protected readonly counts = computed(() => {
    const view = this.view();
    return view === null ? '' : countsText(view);
  });
  protected readonly rows = computed(() => this.view()?.active.slice(0, PANEL_ROWS) ?? []);
  protected readonly more = computed(() =>
    Math.max(0, (this.view()?.active.length ?? 0) - PANEL_ROWS),
  );
  protected readonly attemptsText = attemptsText;

  protected when(ms: number): string {
    return uploadTime(ms);
  }

  protected bytes(count: number): string {
    return formatBytes(count);
  }

  protected stateText(attempt: AttemptView): string {
    return attemptStateText(attempt);
  }

  protected retry(attempt: AttemptView): void {
    this.uploads.retry(attempt.sessionId, attempt.index);
  }

  protected retryAll(): void {
    this.uploads.retry();
  }
}
