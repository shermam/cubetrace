import { Component, computed, inject, input } from '@angular/core';
import type { AttemptRecord } from '@cubetrace/core';

import { sessionStats } from '../session/session-stats';
import { formatBytes } from '../shared/format-bytes';
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
  /** Its clips (T2.4): "2 clips, 5.3 MB"; null without one. */
  readonly clips: string | null;
}

function solveRow(attempt: AttemptRecord): SolveRow {
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
  const bytes = attempt.video.reduce((sum, clip) => sum + clip.bytes, 0);
  const count = attempt.video.length;
  return {
    index: attempt.index,
    status,
    time: status === 'solved' && timeMs !== null ? formatTime(timeMs) : 'DNF',
    segments: status === 'solved' ? barSegments(phases, total) : [],
    flags,
    clips:
      count === 0
        ? null
        : `${String(count)} ${count === 1 ? 'clip' : 'clips'}, ${formatBytes(bytes)}`,
  };
}

/**
 * The session's solves, newest first (docs/PLAN.md, T1.6b): number, time, the eight phases as a
 * mini bar, flags, and a badge with the attempt's clips (T2.4) that opens them (`ClipViewing`);
 * above them the session's count, mean, best, ao5 and ao12.
 */
@Component({
  selector: 'app-solve-list',
  imports: [PhaseBar],
  template: `
    <h2>Solves</h2>
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
              @if (row.clips; as clips) {
                <button
                  type="button"
                  class="clips"
                  data-testid="clip-badge"
                  [attr.aria-label]="'The clips of attempt ' + row.index + ': ' + clips"
                  (click)="viewer.open(row.index)"
                >
                  {{ clips }}
                </button>
              }
            </span>
          </li>
        }
      </ol>
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

    .clips {
      padding: 0 var(--space-1);
      border: 1px solid var(--line);
      border-radius: 0.25rem;
      background: var(--surface-raised);
      color: var(--accent);
      font-size: 0.6875rem;
      white-space: nowrap;
    }
  `,
})
export class SolveList {
  /** The session's attempts, by index. */
  readonly attempts = input.required<readonly AttemptRecord[]>();
  protected readonly viewer = inject(ClipViewing);

  protected readonly stats = computed(() => sessionStats(this.attempts()));
  protected readonly rows = computed(() => [...this.attempts()].reverse().map(solveRow));
}
