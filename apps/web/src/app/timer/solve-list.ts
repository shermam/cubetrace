import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AttemptRecord } from '@cubetrace/core';

/**
 * An attempt as the list shows it: its record, or its document in the session index (T3.1), which
 * has everything but the moves.
 */
export type ListedAttempt = Omit<AttemptRecord, 'moves'>;

/**
 * An attempt's upload as its row says it (T3.3): `waiting` (its clips are still to come), `pending`,
 * `uploading`, `done` or `failed`, and the words.
 */
export interface UploadBadge {
  readonly state: 'waiting' | 'pending' | 'uploading' | 'done' | 'failed';
  readonly text: string;
}

import { sessionStats } from '../session/session-stats';
import { clipsText } from '../shared/clips-text';
import { formatTime } from '../shared/format-time';
import { attemptPhases, barSegments, type BarSegment } from './breakdown';
import { ClipViewing } from './clip-viewing';
import { PhaseBar } from './phase-bar';

/** A solve as the list shows it. */
interface SolveRow {
  readonly index: number;
  readonly status: 'solved' | 'dnf';
  readonly time: string;
  /** The eight phases, as parts of the solve's own time; empty for a DNF. */
  readonly segments: readonly BarSegment[];
  /** `DNF`; `Corrected` (the scramble went off its path and back); `No replay` (a resync). */
  readonly flags: readonly string[];
  /**
   * Its clips (T2.4): "2 clips, 5.3 MB", or "2 clips in the cloud" once they were deleted from the
   * device after their upload (T3.3); null without one.
   */
  readonly clips: string | null;
  /** None of its clips is on this device any more (T3.3). */
  readonly inCloud: boolean;
  /**
   * Which of its clips begin later than asked, their start older than the capture's buffer (T2.9):
   * "The scramble clip begins late: …"; null when none does.
   */
  readonly late: string | null;
}

/** What the mark of a clip that begins late says (T2.9). */
export function lateText(segments: readonly string[]): string | null {
  if (segments.length === 0) {
    return null;
  }
  return segments.length === 1
    ? `The ${segments[0]} clip begins later than asked: its start was older than the 90 s kept in memory.`
    : 'Both clips begin later than asked: their starts were older than the 90 s kept in memory.';
}

function solveRow(attempt: ListedAttempt): SolveRow {
  const { status, timeMs, scrambleCorrected, replayOk } = attempt.result;
  const phases = attemptPhases(attempt);
  const total = phases.reduce((sum, p) => sum + Math.max(0, p.ms), 0);
  const flags: string[] = [];
  if (status === 'dnf') {
    flags.push('DNF');
  }
  if (scrambleCorrected) {
    flags.push('Corrected');
  }
  if (status === 'solved' && !replayOk) {
    flags.push('No replay');
  }
  return {
    index: attempt.index,
    status,
    time: status === 'solved' && timeMs !== null ? formatTime(timeMs) : 'DNF',
    segments: status === 'solved' ? barSegments(phases, total) : [],
    flags,
    clips: clipsText(attempt.video),
    inCloud: attempt.video.length > 0 && attempt.video.every((clip) => clip.local === false),
    late: lateText(attempt.video.filter((clip) => clip.truncatedStart).map((clip) => clip.segment)),
  };
}

/**
 * The session's solves, newest first (docs/PLAN.md, T1.6b): number, time, the eight phases as a
 * mini bar, flags, and a badge with the attempt's clips (T2.4) that opens them (`ClipViewing`);
 * above them the session's count, mean, best, ao5 and ao12 (unless `showStats` is false). With a
 * `limit` (the Timer page's 12, T2.7), only the newest ones, and under them how many the session
 * has, with "See all", the session's page (`sessionId`). A session of the cloud's index alone (T3.1)
 * lists its attempts without their moves, and its clip badges open nothing (`playable` false). A
 * clip badge says "in the cloud" for clips deleted from the device once uploaded, and with `uploads`
 * (the session's page, T3.3) each row says its attempt's upload.
 */
@Component({
  selector: 'app-solve-list',
  imports: [PhaseBar, RouterLink],
  template: `
    <h2>Solves</h2>
    @if (showStats()) {
      <dl class="stats" data-testid="session-stats">
        <div>
          <dt>Solves</dt>
          <dd data-testid="stat-count">{{ stats().count }}</dd>
        </div>
        <div>
          <dt>Mean</dt>
          <dd data-testid="stat-mean">{{ stats().mean }}</dd>
        </div>
        <div>
          <dt>Best</dt>
          <dd data-testid="stat-best">{{ stats().best }}</dd>
        </div>
        <div>
          <dt>ao5</dt>
          <dd data-testid="stat-ao5">{{ stats().ao5 }}</dd>
        </div>
        <div>
          <dt>ao12</dt>
          <dd data-testid="stat-ao12">{{ stats().ao12 }}</dd>
        </div>
      </dl>
    }
    @if (rows().length === 0) {
      <p class="muted">No solves in this session yet.</p>
    } @else {
      <ol class="list" data-testid="solve-list" aria-label="Solves, newest first">
        @for (row of rows(); track row.index) {
          <li data-testid="solve-row" [attr.data-index]="row.index" [attr.data-status]="row.status">
            <span class="index">#{{ row.index }}</span>
            <span class="time" data-testid="solve-time">{{ row.time }}</span>
            <app-phase-bar
              [segments]="row.segments"
              [label]="'Phases of solve ' + row.index"
              [height]="8"
              [gap]="1"
              [radius]="2"
            />
            <span class="flags">
              @for (flag of row.flags; track flag) {
                <span class="flag" [class.dnf]="flag === 'DNF'">{{ flag }}</span>
              }
              @if (uploads()?.get(row.index); as upload) {
                <span
                  class="flag upload"
                  data-testid="upload-badge"
                  [attr.data-state]="upload.state"
                  [title]="'Upload: ' + upload.text"
                  >{{ upload.text }}</span
                >
              }
              @if (row.clips; as clips) {
                @if (playable()) {
                  <button
                    type="button"
                    class="clips"
                    data-testid="clip-badge"
                    [class.cloud]="row.inCloud"
                    [attr.data-cloud]="row.inCloud ? '' : null"
                    [attr.aria-label]="
                      'The clips of attempt ' +
                      row.index +
                      ': ' +
                      clips +
                      (row.late ? '. ' + row.late : '')
                    "
                    [attr.title]="row.late"
                    (click)="viewer.open(row.index)"
                  >
                    {{ clips }}
                    @if (row.late) {
                      <span class="late" data-testid="clip-late" aria-hidden="true">· late</span>
                    }
                  </button>
                } @else {
                  <span
                    class="clips elsewhere"
                    data-testid="clip-badge"
                    title="The clips are on the device that recorded them."
                    >{{ clips }}</span
                  >
                }
              }
            </span>
          </li>
        }
      </ol>
      @if (footer(); as footer) {
        <p class="footer" data-testid="solve-list-footer">
          {{ footer.count }} ·
          <a [routerLink]="footer.link" data-testid="solve-list-all">See all</a>
        </p>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-3);
    }

    h2,
    p,
    dl,
    dd {
      margin: 0;
    }

    .muted {
      color: var(--text-muted);
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: var(--space-2);
      text-align: center;

      dt {
        color: var(--text-muted);
        font-size: 0.75rem;
      }

      dd {
        font-family: var(--font-mono);
        font-variant-numeric: tabular-nums;
      }
    }

    .list {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li {
      display: grid;
      grid-template-columns: 3.5rem 5rem minmax(2rem, 1fr) auto;
      gap: var(--space-2);
      align-items: center;
      padding: var(--space-1) 0;
      border-bottom: 1px solid var(--line);
      font-variant-numeric: tabular-nums;
    }

    .index {
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .time {
      font-family: var(--font-mono);
      text-align: end;
    }

    .flags {
      display: flex;
      gap: var(--space-1);
      justify-content: flex-end;
      min-width: 0;
    }

    .flag {
      padding: 0 var(--space-1);
      border-radius: 0.25rem;
      background: var(--surface-raised);
      color: var(--text-muted);
      font-size: 0.6875rem;

      &.dnf {
        color: var(--danger);
      }
    }

    .footer {
      color: var(--text-muted);
      font-size: 0.875rem;
      text-align: end;
    }

    .clips {
      padding: 0 var(--space-1);
      border: 1px solid var(--line);
      border-radius: 0.25rem;
      background: var(--surface-raised);
      color: var(--accent);
      font-size: 0.6875rem;
      white-space: nowrap;
    }

    .late {
      color: var(--warn);
    }

    .elsewhere,
    .clips.cloud {
      color: var(--text-muted);
    }

    .upload {
      white-space: nowrap;

      &[data-state='done'] {
        color: var(--ok);
      }

      &[data-state='uploading'] {
        color: var(--accent);
      }

      &[data-state='failed'] {
        color: var(--danger);
      }
    }
  `,
})
export class SolveList {
  /** The session's attempts, by index. */
  readonly attempts = input.required<readonly ListedAttempt[]>();
  /**
   * The clip badges open the clip viewer: the clips are on this device. False for a session of the
   * cloud's index alone (T3.1), whose clips are on the device that recorded them.
   */
  readonly playable = input(true);
  /** Show only the newest this many, with the footer; null (the default) shows them all. */
  readonly limit = input<number | null>(null);
  /** The session, whose page the footer's "See all" opens; no footer without it. */
  readonly sessionId = input<string | null>(null);
  /** The statistics above the list: count, mean, best, ao5 and ao12. */
  readonly showStats = input(true);
  /** Each attempt's upload, by index (T3.3); null (the default) says nothing of the uploads. */
  readonly uploads = input<ReadonlyMap<number, UploadBadge> | null>(null);
  protected readonly viewer = inject(ClipViewing);

  protected readonly stats = computed(() => sessionStats(this.attempts()));
  protected readonly rows = computed(() => newest(this.attempts(), this.limit()).map(solveRow));
  /** "15 solves in this session", and the session's page; null without a limit or a session. */
  protected readonly footer = computed(() => {
    const id = this.sessionId();
    const count = this.attempts().length;
    return this.limit() === null || id === null || count === 0
      ? null
      : {
          count: `${String(count)} ${count === 1 ? 'solve' : 'solves'} in this session`,
          link: ['/sessions', id],
        };
  });
}

/** The newest `limit` attempts (all of them for null), newest first. */
export function newest<T extends ListedAttempt>(
  attempts: readonly T[],
  limit: number | null,
): readonly T[] {
  const shown = limit === null ? attempts : attempts.slice(Math.max(0, attempts.length - limit));
  return [...shown].reverse();
}
