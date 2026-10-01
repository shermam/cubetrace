import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { CloudAttempt } from '@cubetrace/core';

import { AuthService } from '../auth/auth-service';
import { SessionIndexService, type CloudEntry, type CloudProblem } from '../cloud/session-index';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { formatBytes } from '../shared/format-bytes';
import { qaSummary, type QaSummary } from './qa-summary';

/** The newest sessions of the index whose attempts the QA view counts. */
export const QA_SESSIONS = 50;

/** How many sessions' attempts are read at once. */
const PARALLEL_READS = 6;

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** What one reading of the index gave. */
interface QaRead {
  readonly summary: QaSummary;
  readonly sessions: number;
  /** The documents that could not be read (another version's), sessions and attempts. */
  readonly unreadable: readonly CloudProblem[];
  /** Some of it came from this device's cache: the server was out of reach. */
  readonly fromCache: boolean;
  /** The host time of the reading. */
  readonly readMs: number;
}

/**
 * `/qa` (docs/PLAN.md T3.1), linked from the Sessions page signed in: the attempts of the account's
 * cloud index (its {@link QA_SESSIONS} newest sessions), every device's, by day and device, with their
 * clips, the bytes the clips take, and the bytes of their files uploaded and pending; when this device
 * last synced (the last write of the index the server confirmed) and what still waits to be sent.
 * Plain tables, read once, and again with Refresh.
 */
@Component({
  selector: 'app-qa-page',
  imports: [RouterLink],
  template: `
    <p class="back"><a routerLink="/sessions">Sessions</a></p>
    <h1>QA</h1>
    @if (!signedIn()) {
      <p class="muted" data-testid="qa-signed-out">
        The QA view reads your cloud index: sign in (Settings → Account) to see it.
      </p>
    } @else {
      <p class="muted note">
        The attempts in your cloud index, every device's, by day and device, from its
        {{ sessionsCounted }} newest sessions. Recorded: what the clips take. Uploaded and pending:
        the files of the attempts (their records, clips and frame times), uploaded or not yet.
      </p>
      <p data-testid="qa-sync">{{ syncText() }}</p>
      <div class="read">
        <p class="muted" data-testid="qa-read">{{ readText() }}</p>
        <button type="button" data-testid="qa-refresh" [disabled]="reading()" (click)="refresh()">
          Refresh
        </button>
      </div>
      @if (error(); as error) {
        <p class="error" role="alert" data-testid="qa-error">{{ error }}</p>
      }
      @if (read(); as read) {
        @if (read.summary.rows.length === 0) {
          <p class="muted" data-testid="qa-empty">No attempt in your cloud index yet.</p>
        } @else {
          <div class="table">
            <table data-testid="qa-table">
              <caption>
                Attempts by day and device
              </caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Device</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Clips</th>
                  <th scope="col">Recorded</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Pending</th>
                </tr>
              </thead>
              <tbody>
                @for (row of read.summary.rows; track row.day + row.device) {
                  <tr
                    data-testid="qa-row"
                    [attr.data-day]="row.day"
                    [attr.data-device]="row.device"
                  >
                    <td>{{ day(row.day) }}</td>
                    <td>{{ row.device }}</td>
                    <td class="number" data-testid="qa-attempts">{{ row.attempts }}</td>
                    <td class="number" data-testid="qa-clips">{{ row.clips }}</td>
                    <td class="number" data-testid="qa-recorded">{{ bytes(row.recordedBytes) }}</td>
                    <td class="number" data-testid="qa-uploaded">{{ bytes(row.uploadedBytes) }}</td>
                    <td class="number" data-testid="qa-pending">{{ bytes(row.pendingBytes) }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr data-testid="qa-total">
                  <th scope="row" colspan="2">Total</th>
                  <td class="number" data-testid="qa-attempts">
                    {{ read.summary.total.attempts }}
                  </td>
                  <td class="number" data-testid="qa-clips">{{ read.summary.total.clips }}</td>
                  <td class="number" data-testid="qa-recorded">
                    {{ bytes(read.summary.total.recordedBytes) }}
                  </td>
                  <td class="number" data-testid="qa-uploaded">
                    {{ bytes(read.summary.total.uploadedBytes) }}
                  </td>
                  <td class="number" data-testid="qa-pending">
                    {{ bytes(read.summary.total.pendingBytes) }}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        }
        @if (read.unreadable.length > 0) {
          <p class="warning" data-testid="qa-unreadable">
            Left out, {{ read.unreadable.length }} documents that could not be read:
            {{ read.unreadable[0].reason }}
          </p>
        }
      }
    }
  `,
  styles: `
    p {
      margin: 0;
    }

    .back {
      margin-bottom: var(--space-2);
      font-size: 0.875rem;

      a::before {
        content: '‹ ';
      }
    }

    .muted {
      color: var(--text-muted);
    }

    .note {
      margin-bottom: var(--space-3);
      font-size: 0.875rem;
    }

    .error {
      color: var(--danger);
    }

    .warning {
      margin-top: var(--space-3);
      color: var(--warn);
    }

    .read {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
      margin: var(--space-2) 0 var(--space-4);
    }

    /* A wide table scrolls by itself on a phone rather than widen the page. */
    .table {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }

    caption {
      margin-bottom: var(--space-2);
      color: var(--text-muted);
      font-size: 0.875rem;
      text-align: start;
    }

    th,
    td {
      padding: var(--space-1) var(--space-2);
      border-bottom: 1px solid var(--line);
      text-align: start;
      white-space: nowrap;
    }

    thead th {
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 400;
    }

    .number {
      text-align: end;
    }

    tfoot {
      font-weight: 600;
    }
  `,
})
export class QaPage {
  private readonly auth = inject(AuthService);
  private readonly index = inject(SessionIndexService);
  private readonly settings = inject(SettingsService);
  private readonly globals = inject(BROWSER_GLOBALS);

  protected readonly sessionsCounted = QA_SESSIONS;
  protected readonly signedIn = computed(() => this.auth.cloud() !== null);
  protected readonly read = signal<QaRead | null>(null);
  protected readonly reading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** When this device last synced, and what still waits to be sent. */
  protected readonly syncText = computed(() => {
    const label = this.settings.hostLabel();
    const last = this.index.lastSync();
    const waiting = this.index.unconfirmed();
    const synced =
      last === null
        ? `This device (${label}) has not synced with your cloud index yet`
        : `This device (${label}) last synced at ${TIME.format(last)}`;
    const queue =
      waiting === 0
        ? 'nothing of this page waits to be sent'
        : `${String(waiting)} ${waiting === 1 ? 'write waits' : 'writes wait'} to be sent`;
    return `${synced}; ${queue}.`;
  });

  /** When the tables were read, and from where. */
  protected readonly readText = computed(() => {
    const read = this.read();
    if (read === null) {
      return this.reading() ? 'Reading your cloud index…' : '';
    }
    const unsent = read.summary.total.unsent;
    const where = read.fromCache
      ? `Offline: read from this device's copy of your cloud index at ${TIME.format(read.readMs)}`
      : `Read from your cloud index at ${TIME.format(read.readMs)}`;
    const held =
      unsent === 0
        ? ''
        : `; ${String(unsent)} of its attempts ${unsent === 1 ? 'holds' : 'hold'} changes of this ` +
          'device not sent yet';
    return `${where} (${String(read.sessions)} sessions)${held}.`;
  });

  /** Incremented by every reading: a slower, older one then knows it lost. */
  private reads = 0;

  constructor() {
    // Read when an account is there (it may still be loading as the page opens), dropped without.
    effect(() => {
      const signedIn = this.signedIn();
      untracked(() => {
        if (signedIn) {
          void this.load();
        } else {
          this.reads++;
          this.read.set(null);
          this.error.set(null);
        }
      });
    });
  }

  protected refresh(): void {
    void this.load();
  }

  protected bytes(count: number): string {
    return formatBytes(count);
  }

  /** `2026-10-01` as the viewer writes a date. */
  protected day(key: string): string {
    const [year, month, date] = key.split('-').map(Number);
    return DAY.format(new Date(year, month - 1, date));
  }

  private async load(): Promise<void> {
    const reading = ++this.reads;
    this.reading.set(true);
    this.error.set(null);
    try {
      const sessions = await this.index.cloudSessions(QA_SESSIONS);
      if (sessions === null) {
        return;
      }
      const attempts: CloudEntry<CloudAttempt>[] = [];
      const unreadable: CloudProblem[] = [...sessions.unreadable];
      let fromCache = sessions.fromCache;
      const ids = sessions.entries.map((entry) => entry.id);
      for (let start = 0; start < ids.length; start += PARALLEL_READS) {
        const reads = await Promise.all(
          ids.slice(start, start + PARALLEL_READS).map((id) => this.index.cloudAttempts(id)),
        );
        for (const read of reads) {
          attempts.push(...(read?.entries ?? []));
          unreadable.push(...(read?.unreadable ?? []));
          fromCache ||= read?.fromCache === true;
        }
      }
      if (reading === this.reads) {
        this.read.set({
          summary: qaSummary(attempts),
          sessions: ids.length,
          unreadable,
          fromCache,
          readMs: hostNow(this.globals),
        });
      }
    } catch (error: unknown) {
      if (reading === this.reads) {
        this.error.set(`Your cloud index could not be read: ${errorMessage(error)}`);
      }
    } finally {
      if (reading === this.reads) {
        this.reading.set(false);
      }
    }
  }
}
