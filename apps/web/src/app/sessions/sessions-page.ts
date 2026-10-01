import { Component, DOCUMENT, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isSimulated, type CloudSession } from '@cubetrace/core';
import { describeProblem, type StorageProblem } from '@cubetrace/storage';

import { AuthService } from '../auth/auth-service';
import { SessionIndexService, type CloudRead } from '../cloud/session-index';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { StorageService } from '../device/storage-service';
import { SessionService, type SessionList, type SessionListItem } from '../session/session-service';
import { clipsSummary } from '../shared/clips-text';
import { downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';
import { StorageMeter } from '../shared/storage-meter';
import { UploadPanel } from '../upload/upload-panel';
import { exportFileName } from './session-export';
import {
  PLACE_LABELS,
  hostLabels,
  mergeSessions,
  withCurrent,
  type MergedSession,
} from './session-merge';

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The cloud's sessions the page lists, the newest (T3.1). */
export const CLOUD_SESSIONS_LISTED = 100;

/** The latest line of `notes` that the session index wrote (`cloud: …`), without its prefix. */
function lastCloudNote(notes: string): string | null {
  const line = notes
    .split('\n')
    .reverse()
    .find((text) => text.startsWith('cloud: '));
  return line === undefined ? null : line.slice('cloud: '.length);
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
 * stays the JSON records only, and a note says where the clips are downloaded. Since T2.7 each
 * row's date opens the session's page (`SessionPage`), with all its attempts and their clips. The
 * current session's row follows the timer's attempts while the page is open. Since T3.1, with an
 * account signed in, the page also lists the sessions of the account's index in the cloud, merged
 * with this device's by id, each with a badge (this device, cloud, both), a filter by device (the
 * host labels seen) and a link to the QA view; a session of the cloud alone opens a read-only page.
 * Signed out, it is as before.
 */
@Component({
  selector: 'app-sessions-page',
  imports: [RouterLink, StorageMeter, UploadPanel],
  template: `
    <h1>Sessions</h1>
    <app-storage-meter />
    <p class="muted note" data-testid="sessions-clips-note">
      Export saves a session's records as one JSON file, without its video. The clips of an attempt
      are downloaded from its clip badge on the session's page, which its date opens.
    </p>
    @if (signedIn()) {
      <div class="cloud" data-testid="sessions-cloud">
        <p class="muted note">
          Signed in, the sessions of this device go to your cloud index, and their records and clips
          to your account's storage (Uploads, below; Settings → Uploads); your other devices'
          sessions are listed here too.
        </p>
        <div class="tools">
          <label for="device-filter">Device</label>
          <select id="device-filter" data-testid="device-filter" (change)="filterBy($event)">
            <option value="" [selected]="device() === null">All devices</option>
            @for (label of devices(); track label) {
              <option [value]="label" [selected]="device() === label">{{ label }}</option>
            }
          </select>
          <a routerLink="/qa" data-testid="qa-link">QA view</a>
        </div>
        @if (cloudStatus(); as status) {
          <p class="muted" data-testid="cloud-status">{{ status }}</p>
        }
        @if (cloudError(); as error) {
          <p class="warning" role="alert" data-testid="cloud-error">{{ error }}</p>
        }
      </div>
      <app-upload-panel />
    }
    @if (error(); as message) {
      <p class="error" role="alert" data-testid="sessions-error">{{ message }}</p>
    } @else if (list(); as list) {
      @if (rows().length === 0 && list.unreadable.length === 0) {
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
          @for (row of shownRows(); track row.id) {
            <li
              data-testid="session-row"
              [attr.data-session]="row.id"
              [attr.data-place]="row.place"
            >
              <div class="what">
                <p class="when">
                  <a [routerLink]="['/sessions', row.id]" data-testid="session-link">{{
                    when(row.session.createdMs)
                  }}</a>
                  @if (row.local?.current) {
                    <span class="current">current</span>
                  }
                  @if (signedIn()) {
                    <span
                      class="place"
                      data-testid="session-place"
                      [attr.data-place]="row.place"
                      [attr.data-pending]="waiting(row) ? '' : null"
                      [title]="placeTitle(row)"
                      >{{ placeLabel(row) }}</span
                    >
                  }
                </p>
                @if (row.local; as item) {
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
                } @else {
                  <p class="muted">
                    {{ row.session.host.label }} · {{ row.session.cube.model }} ·
                    <span data-testid="session-attempts">{{
                      attemptCount(row.session.summary.attempts)
                    }}</span>
                    · recorded on another device
                  </p>
                }
                @if (cloudProblem(row); as problem) {
                  <p class="warning" data-testid="session-cloud-problem">
                    Not in the cloud: {{ problem }}
                  </p>
                }
                @if (failure()?.id === row.id) {
                  <p class="error" role="alert" data-testid="row-error">{{ failure()?.message }}</p>
                }
              </div>
              @if (row.local; as item) {
                @if (confirming() === row.id) {
                  <div class="actions" role="group" aria-label="Confirm the deletion">
                    <p>
                      Delete this session and its {{ attemptCount(item.attempts)
                      }}{{
                        row.place === 'both'
                          ? ' from this device? Its index in the cloud stays.'
                          : '?'
                      }}
                    </p>
                    <button type="button" class="danger" (click)="remove(item)">Delete</button>
                    <button type="button" (click)="confirming.set(null)">Cancel</button>
                  </div>
                } @else {
                  <div class="actions">
                    <button type="button" (click)="download(item)">Export</button>
                    <button type="button" (click)="confirming.set(row.id)">Delete…</button>
                  </div>
                }
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

    .place {
      margin-left: var(--space-2);
      padding: 0 var(--space-2);
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 400;

      &[data-place='cloud'] {
        border-color: var(--accent);
        color: var(--accent);
      }

      &[data-place='both'] {
        border-color: var(--ok);
        color: var(--ok);
      }

      &[data-pending] {
        border-style: dashed;
      }
    }

    .cloud {
      display: grid;
      gap: var(--space-2);
      margin-bottom: var(--space-4);

      .note {
        margin: 0;
      }
    }

    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
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
  private readonly auth = inject(AuthService);
  private readonly index = inject(SessionIndexService);
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
  /** The cloud's sessions, once read; null signed out and while they are read (T3.1). */
  private readonly cloud = signal<CloudRead<CloudSession> | null>(null);
  /** Why the cloud's sessions could not be read. */
  protected readonly cloudError = signal<string | null>(null);
  /** The host label the rows are filtered by; null for every device. */
  protected readonly device = signal<string | null>(null);

  /** An account is signed in: the cloud's sessions are listed too. */
  protected readonly signedIn = computed(() => this.auth.cloud() !== null);
  /** This device's sessions, the current one as the timer has it now. */
  private readonly localItems = computed(() => {
    const list = this.list();
    return list === null
      ? []
      : withCurrent(list.sessions, this.session.session(), this.session.attempts());
  });
  /** Every session: this device's, and, signed in, the cloud's, merged by id, newest first. */
  protected readonly rows = computed((): MergedSession[] => {
    const local = this.localItems();
    if (!this.signedIn()) {
      return local.map((item) => ({
        id: item.session.id,
        session: item.session,
        place: 'device',
        local: item,
        cloud: null,
      }));
    }
    return mergeSessions(local, this.cloud()?.entries ?? [], this.index.written());
  });
  protected readonly devices = computed(() => hostLabels(this.rows()));
  protected readonly shownRows = computed(() => {
    const device = this.device();
    return device === null
      ? this.rows()
      : this.rows().filter((row) => row.session.host.label === device);
  });
  /** What the page says of the cloud's listing, when there is something to say. */
  protected readonly cloudStatus = computed(() => {
    const cloud = this.cloud();
    if (cloud === null) {
      return this.cloudError() === null ? "Reading your cloud's sessions…" : null;
    }
    const parts: string[] = [];
    if (cloud.fromCache) {
      parts.push("Offline: your cloud's sessions as this device last read them.");
    }
    if (cloud.entries.length + cloud.unreadable.length >= CLOUD_SESSIONS_LISTED) {
      parts.push(`The cloud's ${String(CLOUD_SESSIONS_LISTED)} newest sessions are listed.`);
    }
    if (cloud.unreadable.length > 0) {
      const count = cloud.unreadable.length;
      parts.push(
        `${String(count)} of the cloud's sessions could not be read (${cloud.unreadable[0].reason})`,
      );
    }
    return parts.length === 0 ? null : parts.join(' ');
  });

  /** Incremented by every read of the cloud: a slower, older one then knows it lost. */
  private cloudReads = 0;

  constructor() {
    void this.load();
    // The cloud's sessions, read again when an account signs in, and dropped when it signs out.
    effect(() => {
      const account = this.auth.cloud();
      untracked(() => {
        if (account === null) {
          this.cloudReads++;
          this.cloud.set(null);
          this.cloudError.set(null);
          this.device.set(null);
        } else {
          void this.loadCloud();
        }
      });
    });
  }

  protected when(ms: number): string {
    return WHEN.format(ms);
  }

  protected attemptCount(count: number): string {
    return `${String(count)} ${count === 1 ? 'attempt' : 'attempts'}`;
  }

  /** "2 clips, 5.3 MB"; "2 clips in the cloud" once uploaded and deleted here (T3.3). */
  protected clipsText(item: SessionListItem): string {
    return clipsSummary(item.clips, item.clipBytes, item.cloudClips);
  }

  protected describe(problem: StorageProblem): string {
    return describeProblem(problem);
  }

  protected placeLabel(row: MergedSession): string {
    return PLACE_LABELS[row.place];
  }

  /** The badge's title: what the place means for the session. */
  protected placeTitle(row: MergedSession): string {
    switch (row.place) {
      case 'device':
        return isSimulated(row.session)
          ? 'A demo session (the fake cube): it stays on this device.'
          : 'On this device only: not in your cloud index yet.';
      case 'cloud':
        return `In your cloud index, recorded on ${row.session.host.label}: its clips and moves are on that device.`;
      case 'both':
        return this.waiting(row)
          ? 'On this device and in your cloud index; some of its changes wait to be sent.'
          : 'On this device and in your cloud index.';
    }
  }

  /**
   * Writes of this device to the session's documents wait to be sent (offline): this page load's are
   * not confirmed yet, or, for a session this page load has not written, the cloud's listing said so.
   */
  protected waiting(row: MergedSession): boolean {
    return (
      this.index.waiting().has(row.id) ||
      (row.cloud?.pending === true && !this.index.written().has(row.id))
    );
  }

  /**
   * Why a session of this device is not in the cloud: the refusal of this page load, or the last
   * one its notes keep (`cloud: …`); null when it is there, or signed out.
   */
  protected cloudProblem(row: MergedSession): string | null {
    if (!this.signedIn() || row.place !== 'device') {
      return null;
    }
    return this.index.failures().get(row.id) ?? lastCloudNote(row.session.notes);
  }

  protected filterBy(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    this.device.set(value === '' ? null : value);
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

  private async loadCloud(): Promise<void> {
    const read = ++this.cloudReads;
    this.cloudError.set(null);
    try {
      const cloud = await this.index.cloudSessions(CLOUD_SESSIONS_LISTED);
      if (read === this.cloudReads) {
        this.cloud.set(cloud);
      }
    } catch (error: unknown) {
      if (read === this.cloudReads) {
        this.cloud.set(null);
        this.cloudError.set(`Your cloud's sessions could not be read: ${errorMessage(error)}`);
      }
    }
  }
}
