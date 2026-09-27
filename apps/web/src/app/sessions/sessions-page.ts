import { Component, DOCUMENT, inject, signal } from '@angular/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { SessionService, type SessionListItem } from '../session/session-service';
import { downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The file name of a session's export. */
export function exportFileName(sessionId: string): string {
  return `cubetrace-session-${sessionId}.json`;
}

/**
 * `/sessions` (docs/PLAN.md, T1.6b): the stored sessions, newest first, with their date, host,
 * cube, number of attempts and mean; each can be exported as one JSON file (`{session, attempts}`,
 * as the store's `exportSession` gives it) or deleted, after a confirmation.
 */
@Component({
  selector: 'app-sessions-page',
  template: `
    <h1>Sessions</h1>
    @if (error(); as message) {
      <p class="error" role="alert" data-testid="sessions-error">{{ message }}</p>
    }
    @if (items(); as items) {
      @if (items.length === 0) {
        <p class="muted" data-testid="no-sessions">
          No sessions yet: the timer records one from the first solve.
        </p>
      } @else {
        <ul class="sessions">
          @for (item of items; track item.session.id) {
            <li data-testid="session-row" [attr.data-session]="item.session.id">
              <div class="what">
                <p class="when">
                  {{ when(item.session.createdMs) }}
                  @if (item.current) {
                    <span class="current">current</span>
                  }
                </p>
                <p class="muted">
                  {{ item.session.host.label }} · {{ item.session.cube.model }} ·
                  <span data-testid="session-attempts">{{ attemptCount(item.attempts) }}</span> ·
                  mean <span class="mono">{{ item.mean }}</span>
                </p>
              </div>
              @if (confirming() === item.session.id) {
                <div class="actions" role="group" aria-label="Confirm the deletion">
                  <p>Delete this session and its {{ attemptCount(item.attempts) }}?</p>
                  <button type="button" class="danger" (click)="remove(item)">Delete</button>
                  <button type="button" (click)="confirming.set(null)">Cancel</button>
                </div>
              } @else {
                <div class="actions">
                  <button type="button" (click)="download(item)">Export</button>
                  <button type="button" (click)="confirming.set(item.session.id)">Delete…</button>
                </div>
              }
            </li>
          }
        </ul>
      }
    } @else {
      <p class="muted">Reading the sessions…</p>
    }
    @if (notice(); as notice) {
      <p class="muted" role="status" data-testid="sessions-notice">{{ notice }}</p>
    }
  `,
  styles: `
    p {
      margin: 0;
    }

    .muted {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger);
    }

    .sessions {
      display: grid;
      gap: var(--space-3);
      margin: 0 0 var(--space-4);
      padding: 0;
      list-style: none;
    }

    li {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-4);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }

    .what {
      min-width: 0;
    }

    .when {
      font-weight: 600;
    }

    .current {
      margin-left: var(--space-2);
      padding: 0 var(--space-2);
      border-radius: 999px;
      background: var(--accent);
      color: var(--on-accent);
      font-size: 0.75rem;
    }

    .mono {
      font-family: var(--font-mono);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }

    .danger {
      border-color: transparent;
      background: var(--danger);
      color: var(--on-accent);
    }
  `,
})
export class SessionsPage {
  private readonly session = inject(SessionService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly document = inject(DOCUMENT);

  /** Null while the store is read. */
  protected readonly items = signal<readonly SessionListItem[] | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected when(ms: number): string {
    return WHEN.format(ms);
  }

  protected attemptCount(count: number): string {
    return `${String(count)} ${count === 1 ? 'attempt' : 'attempts'}`;
  }

  protected async download(item: SessionListItem): Promise<void> {
    try {
      const exported = await this.session.exportSession(item.session.id);
      const fileName = exportFileName(item.session.id);
      downloadJson(this.globals, this.document, fileName, exported);
      this.notice.set(`Exported ${fileName}.`);
    } catch (error: unknown) {
      this.error.set(`The session could not be exported: ${errorMessage(error)}`);
    }
  }

  protected async remove(item: SessionListItem): Promise<void> {
    this.confirming.set(null);
    try {
      await this.session.deleteSession(item.session.id);
      this.notice.set(`Deleted the session of ${this.when(item.session.createdMs)}.`);
    } catch (error: unknown) {
      this.error.set(`The session could not be deleted: ${errorMessage(error)}`);
    }
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      this.items.set(await this.session.listSessions());
    } catch (error: unknown) {
      this.items.set([]);
      this.error.set(`The sessions could not be read: ${errorMessage(error)}`);
    }
  }
}
