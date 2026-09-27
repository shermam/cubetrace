import { Component, DOCUMENT, inject, signal } from '@angular/core';
import { describeProblem, type StorageProblem } from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { StorageService } from '../device/storage-service';
import { SessionService, type SessionList, type SessionListItem } from '../session/session-service';
import { downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';
import { formatBytes } from '../shared/format-bytes';
import { StorageMeter } from '../shared/storage-meter';

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The file name of a session's export. */
export function exportFileName(sessionId: string): string {
  return `cubetrace-session-${sessionId}.json`;
}

/**
 * `/sessions` (docs/PLAN.md, T1.6b): the stored sessions, newest first, with their date, host,
 * cube, number of attempts and mean; each can be exported as one JSON file (`{session, attempts}`,
 * as the store's `exportSession` gives it) or deleted, after a confirmation. A session whose
 * `session.json` cannot be read (a write cut short, issue #12) is a row that names the file and
 * what is wrong with it, and can be deleted; an unreadable `attempt.json` is named in its
 * session's row, and left out of its count, mean and export. The page-level error is for a listing
 * that failed; an export or a deletion that failed is said in its row. Since T2.4 each row says how
 * many clips its attempts have and their size, and the storage meter is above the list; the export
 * stays the JSON records only, and a note says where the clips are downloaded.
 */
@Component({
  selector: 'app-sessions-page',
  imports: [StorageMeter],
  template: `
    <h1>Sessions</h1>
    <app-storage-meter />
    <p class="muted note" data-testid="sessions-clips-note">
      Export saves a session's records as one JSON file, without its video. The clips of an attempt
      are downloaded from its clip badge in the Timer's list of solves (the current session's).
    </p>
    @if (error(); as message) {
      <p class="error" role="alert" data-testid="sessions-error">{{ message }}</p>
    } @else if (list(); as list) {
      @if (list.sessions.length === 0 && list.unreadable.length === 0) {
        <p class="muted" data-testid="no-sessions">
          No sessions yet: the timer records one from the first solve.
        </p>
      } @else {
        <ul class="sessions">
          @for (problem of list.unreadable; track problem.path) {
            <li
              class="unreadable"
              data-testid="unreadable-row"
              [attr.data-session]="problem.sessionId"
            >
              <div class="what">
                <p class="when">Unreadable session</p>
                <p class="muted path" data-testid="unreadable-reason">{{ describe(problem) }}</p>
                @if (failure()?.id === problem.sessionId) {
                  <p class="error" role="alert" data-testid="row-error">{{ failure()?.message }}</p>
                }
              </div>
              @if (confirming() === problem.sessionId) {
                <div class="actions" role="group" aria-label="Confirm the deletion">
                  <p>Delete this session's folder, with everything in it?</p>
                  <button type="button" class="danger" (click)="removeUnreadable(problem)">
                    Delete
                  </button>
                  <button type="button" (click)="confirming.set(null)">Cancel</button>
                </div>
              } @else {
                <div class="actions">
                  <button type="button" (click)="confirming.set(problem.sessionId)">Delete…</button>
                </div>
              }
            </li>
          }
          @for (item of list.sessions; track item.session.id) {
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
                  @if (item.clips > 0) {
                    ·
                    <span data-testid="session-clips" [attr.data-bytes]="item.clipBytes">{{
                      clipsText(item)
                    }}</span>
                  }
                </p>
                @for (problem of item.unreadable; track problem.path) {
                  <p class="warning path" data-testid="session-left-out">
                    Left out: {{ describe(problem) }}
                  </p>
                }
                @if (failure()?.id === item.session.id) {
                  <p class="error" role="alert" data-testid="row-error">{{ failure()?.message }}</p>
                }
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

    .note {
      margin: var(--space-2) 0 var(--space-4);
      font-size: 0.875rem;
    }

    .error {
      color: var(--danger);
    }

    .warning {
      color: var(--warn);
    }

    /* A path is one long word: it wraps anywhere rather than widen the page on a phone. */
    .path {
      overflow-wrap: anywhere;
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

    li.unreadable {
      border-color: var(--warn);
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
  private readonly storage = inject(StorageService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly document = inject(DOCUMENT);

  /** Null while the store is read. */
  protected readonly list = signal<SessionList | null>(null);
  /** The session whose deletion is being confirmed. */
  protected readonly confirming = signal<string | null>(null);
  /** Why the sessions could not be listed. */
  protected readonly error = signal<string | null>(null);
  /** The last export or deletion that failed, and why, shown in the session's row. */
  protected readonly failure = signal<{ id: string; message: string } | null>(null);
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

  /** "2 clips, 5.3 MB" */
  protected clipsText(item: SessionListItem): string {
    return (
      `${String(item.clips)} ${item.clips === 1 ? 'clip' : 'clips'}, ` + formatBytes(item.clipBytes)
    );
  }

  protected describe(problem: StorageProblem): string {
    return describeProblem(problem);
  }

  protected async download(item: SessionListItem): Promise<void> {
    this.failure.set(null);
    try {
      const exported = await this.session.exportSession(item.session.id);
      const fileName = exportFileName(item.session.id);
      downloadJson(this.globals, this.document, fileName, exported);
      this.notice.set(`Exported ${fileName}.`);
    } catch (error: unknown) {
      this.failure.set({
        id: item.session.id,
        message: `The session could not be exported: ${errorMessage(error)}`,
      });
    }
  }

  protected remove(item: SessionListItem): Promise<void> {
    return this.removeSession(
      item.session.id,
      `Deleted the session of ${this.when(item.session.createdMs)}.`,
    );
  }

  protected removeUnreadable(problem: StorageProblem): Promise<void> {
    return this.removeSession(
      problem.sessionId,
      `Deleted the unreadable session ${problem.sessionId}.`,
    );
  }

  private async removeSession(id: string, done: string): Promise<void> {
    this.confirming.set(null);
    this.failure.set(null);
    try {
      await this.session.deleteSession(id);
      this.notice.set(done);
    } catch (error: unknown) {
      this.failure.set({ id, message: `The session could not be deleted: ${errorMessage(error)}` });
    }
    // The meter goes down with it, and a camera stopped by full storage records again.
    void this.storage.refresh();
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      this.list.set(await this.session.listSessions());
      this.error.set(null);
    } catch (error: unknown) {
      this.error.set(`The sessions could not be read: ${errorMessage(error)}`);
    }
  }
}
