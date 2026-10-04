import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { parseCloudEvent, type CloudAttempt, type CloudEvent } from '@cubetrace/core';

import { AuthService } from '../auth/auth-service';
import { SessionIndexService, type CloudEntry, type CloudProblem } from '../cloud/session-index';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import {
  SUMMARY_DAYS,
  diagnosticsSummary,
  type DiagnosticsSummary,
} from '../diagnostics/diagnostics-summary';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { formatBytes } from '../shared/format-bytes';
import { qaSummary, type QaCounts, type QaSummary } from './qa-summary';

/** The newest sessions of the index whose attempts the QA view counts. */
export const QA_SESSIONS = 50;

/** The newest diagnostics events of the account the QA view aggregates (T3.9). */
export const QA_EVENTS = 500;

/** How many sessions' attempts are read at once. */
const PARALLEL_READS = 6;

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** What one reading of the account's diagnostics events gave (T3.9). */
interface EventsRead {
  readonly summary: DiagnosticsSummary;
  /** The documents that could not be read (another version's). */
  readonly unreadable: number;
  readonly fromCache: boolean;
  readonly readMs: number;
}

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
 * clips, the bytes the clips take, and the bytes of their files uploaded and pending, and the clips
 * by camera label (T4.2: the host's own camera and each phone's); when this device last synced (the
 * last write of the index the server confirmed) and what still waits to be sent.
 * Then the diagnostics (T3.9, docs/DIAGNOSTICS.md): the account's last {@link QA_EVENTS} events,
 * aggregated here: per device its last start and build, the counts by kind over the last days, and
 * the failures. Plain tables, read once, and again with Refresh.
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
        the files of the attempts (their records, clips, frame times and gyroscope files), uploaded
        or not yet. Gyro: the attempts with a gyroscope file, and the median rate of those files.
        Then the clips by camera: this device's own camera and each phone paired as a camera.
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
                  <th scope="col">Gyro</th>
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
                    <td class="number" data-testid="qa-gyro">{{ gyro(row) }}</td>
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
                  <td class="number" data-testid="qa-gyro">{{ gyro(read.summary.total) }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          @if (read.summary.cameras.length > 0) {
            <div class="table cameras">
              <table data-testid="qa-cameras">
                <caption>
                  Clips by camera
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Camera</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Clips</th>
                    <th scope="col">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  @for (camera of read.summary.cameras; track camera.label) {
                    <tr data-testid="qa-camera" [attr.data-label]="camera.label">
                      <td>{{ camera.label }}</td>
                      <td class="number" data-testid="qa-camera-attempts">
                        {{ camera.attempts }}
                      </td>
                      <td class="number" data-testid="qa-camera-clips">{{ camera.clips }}</td>
                      <td class="number" data-testid="qa-camera-recorded">
                        {{ bytes(camera.recordedBytes) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
        @if (read.unreadable.length > 0) {
          <p class="warning" data-testid="qa-unreadable">
            Left out, {{ read.unreadable.length }} documents that could not be read:
            {{ read.unreadable[0].reason }}
          </p>
        }
      }
      <h2>Diagnostics</h2>
      <p class="muted note">
        The last {{ eventsCounted }} events your devices recorded about the app's own use (Settings
        → Account → Diagnostics): per device its last start and build, the counts by kind over the
        last {{ summaryDays }} days, and the failures among them. The owner's round report reads the
        same events.
      </p>
      <p class="muted" data-testid="diag-read">{{ eventsText() }}</p>
      @if (eventsError(); as error) {
        <p class="error" role="alert" data-testid="diag-error">{{ error }}</p>
      }
      @if (events(); as events) {
        @if (events.summary.total === 0) {
          <p class="muted" data-testid="diag-empty">No event in your account yet.</p>
        } @else {
          <div class="table">
            <table data-testid="diag-devices">
              <caption>
                Devices
              </caption>
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Last start</th>
                  <th scope="col">Build</th>
                  <th scope="col">Last event</th>
                  <th scope="col">Events</th>
                  <th scope="col">Failures</th>
                </tr>
              </thead>
              <tbody>
                @for (device of events.summary.devices; track device.label) {
                  <tr data-testid="diag-device" [attr.data-device]="device.label">
                    <td>{{ device.label }}</td>
                    <td>{{ device.platform }}{{ device.installed ? ', installed' : '' }}</td>
                    <td>{{ device.lastStartMs === null ? '–' : time(device.lastStartMs) }}</td>
                    <td data-testid="diag-build">{{ buildText(device.build) }}</td>
                    <td>{{ time(device.lastMs) }}</td>
                    <td class="number" data-testid="diag-events">{{ device.events }}</td>
                    <td class="number" data-testid="diag-failures">{{ device.failures }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="table">
            <table data-testid="diag-kinds">
              <caption>
                Events by kind, last
                {{
                  summaryDays
                }}
                days
              </caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Count</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of events.summary.kinds; track entry.kind) {
                  <tr data-testid="diag-kind" [attr.data-kind]="entry.kind">
                    <td>
                      <code>{{ entry.kind }}</code>
                    </td>
                    <td class="number">{{ entry.count }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (events.summary.failures.length === 0) {
            <p class="muted" data-testid="diag-no-failures">No failure among them.</p>
          } @else {
            <ul class="failures" data-testid="diag-failure-list">
              @for (failure of events.summary.failures; track failure.tsMs + failure.kind) {
                <li data-testid="diag-failure">
                  {{ time(failure.tsMs) }} · {{ failure.device }} · <code>{{ failure.kind }}</code>
                  @if (failure.attempt !== null) {
                    · attempt {{ failure.attempt }}
                  }
                  @if (failure.message !== '') {
                    : {{ failure.message }}
                  }
                </li>
              }
            </ul>
          }
          @if (events.unreadable > 0) {
            <p class="warning" data-testid="diag-unreadable">
              Left out, {{ events.unreadable }} events that could not be read (another version's).
            </p>
          }
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

    .cameras {
      margin-top: var(--space-4);
    }

    h2 {
      margin: var(--space-5) 0 var(--space-2);
      font-size: 1.125rem;
    }

    .failures {
      margin: var(--space-2) 0 0;
      padding-left: var(--space-4);
      font-size: 0.875rem;

      li + li {
        margin-top: var(--space-1);
      }
    }
  `,
})
export class QaPage {
  private readonly auth = inject(AuthService);
  private readonly index = inject(SessionIndexService);
  private readonly settings = inject(SettingsService);
  private readonly globals = inject(BROWSER_GLOBALS);

  protected readonly sessionsCounted = QA_SESSIONS;
  protected readonly eventsCounted = QA_EVENTS;
  protected readonly summaryDays = SUMMARY_DAYS;
  protected readonly signedIn = computed(() => this.auth.cloud() !== null);
  protected readonly read = signal<QaRead | null>(null);
  protected readonly reading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The diagnostics events read, aggregated (T3.9). */
  protected readonly events = signal<EventsRead | null>(null);
  protected readonly eventsError = signal<string | null>(null);

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

  /** When the events were read, from where, and how many. */
  protected readonly eventsText = computed(() => {
    const events = this.events();
    if (events === null) {
      return this.reading() ? 'Reading your events…' : '';
    }
    const where = events.fromCache
      ? `Offline: read from this device's copy of your account at ${TIME.format(events.readMs)}`
      : `Read from your account at ${TIME.format(events.readMs)}`;
    const span =
      events.summary.oldestMs === null ? '' : `, from ${TIME.format(events.summary.oldestMs)} on`;
    return `${where} (${String(events.summary.total)} events${span}).`;
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
          this.events.set(null);
          this.eventsError.set(null);
        }
      });
    });
  }

  protected refresh(): void {
    void this.load();
  }

  protected time(ms: number): string {
    return TIME.format(ms);
  }

  /** `0.4.0 · abc1234`, or `–` without a start among the events read. */
  protected buildText(build: { version: string; commit: string } | null): string {
    return build === null ? '–' : `${build.version} · ${build.commit}`;
  }

  protected bytes(count: number): string {
    return formatBytes(count);
  }

  /** The attempts with a gyro file, and the median rate of those files: "3 · 49.8 Hz", or "0". */
  protected gyro(counts: QaCounts): string {
    return counts.gyroRateHz === null
      ? String(counts.gyro)
      : `${String(counts.gyro)} · ${String(counts.gyroRateHz)} Hz`;
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
    void this.loadEvents(reading);
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

  /** The account's last {@link QA_EVENTS} events, aggregated; a document of another version is counted. */
  private async loadEvents(reading: number): Promise<void> {
    const account = this.auth.cloud();
    if (account === null) {
      return;
    }
    this.eventsError.set(null);
    try {
      const listing = await account.backend.listEvents(account.uid, QA_EVENTS);
      const events: CloudEvent[] = [];
      let unreadable = 0;
      for (const { data } of listing.documents) {
        try {
          events.push(parseCloudEvent(data));
        } catch {
          unreadable++;
        }
      }
      if (reading === this.reads) {
        const readMs = hostNow(this.globals);
        this.events.set({
          summary: diagnosticsSummary(events, readMs),
          unreadable,
          fromCache: listing.fromCache,
          readMs,
        });
      }
    } catch (error: unknown) {
      if (reading === this.reads) {
        this.eventsError.set(`Your events could not be read: ${errorMessage(error)}`);
      }
    }
  }
}
