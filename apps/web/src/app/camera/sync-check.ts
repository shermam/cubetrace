import { Component, computed, inject } from '@angular/core';

import { RecordingService } from './recording-service';
import { SyncService, type SyncBlock } from './sync-service';

/** What the panel shows: a check under way, how the last one went, or nothing yet. */
type PanelState = 'running' | 'passed' | 'failed' | 'idle';

/** Why "Sync check" cannot be pressed, for its title. */
const BLOCKED: Readonly<Record<SyncBlock, string>> = {
  'not-recording': 'Once the camera records (a session under way).',
  'no-cube': 'Once a cube is connected.',
  scrambling: "Before the scramble's first turn, or after the solve.",
  solving: 'After the solve.',
  running: 'A check is under way.',
};

/**
 * The sync check's part of the Camera section (docs/PLAN.md, T2.5): while a check runs, what to do
 * (one face turned and turned back, five times, with pauses), a countdown and how many turns and
 * motion onsets it has seen; then the camera's lag behind the cube, or why the check failed, with
 * Retry; "Later" hides it.
 * Hidden, one line says the lag this session has for the camera, with "Sync check" to run one. The
 * logic is `SyncService`'s; this only shows it.
 */
@Component({
  selector: 'app-sync-check',
  template: `
    @if (sync.visible()) {
      <section
        class="sync"
        aria-labelledby="sync-heading"
        data-testid="sync-check"
        [attr.data-state]="state()"
      >
        <h3 id="sync-heading">Sync check</h3>
        @switch (state()) {
          @case ('running') {
            @if (sync.run(); as run) {
              <p class="ask">Turn one face, pause, turn it back; repeat five times.</p>
              <p
                class="count"
                data-testid="sync-count"
                [attr.data-frames]="run.frames()"
                [attr.data-moves]="run.moves()"
                [attr.data-onsets]="run.onsets()"
              >
                <span class="seconds" data-testid="sync-seconds">{{ run.secondsLeft() }} s</span>
                {{ counts() }}
              </p>
              <p class="hint">
                Any face, with the cube in the framing rectangle and a pause of about a second after
                every turn. The timer waits meanwhile: the attempt begins again, with its scramble,
                once the check ends and the cube is solved.
              </p>
            }
          }
          @case ('passed') {
            <p class="passed" role="status" data-testid="sync-result">{{ passed() }}</p>
          }
          @case ('failed') {
            <p class="error" role="alert" data-testid="sync-failure" [attr.data-reason]="reason()">
              {{ failed() }}
            </p>
          }
        }
        <div class="actions">
          @if (state() === 'failed') {
            <button
              type="button"
              class="primary"
              data-testid="sync-retry"
              [disabled]="sync.blocked() !== null"
              [title]="blockedText()"
              (click)="sync.start()"
            >
              Retry
            </button>
          } @else if (state() === 'passed') {
            <button
              type="button"
              data-testid="sync-again"
              [disabled]="sync.blocked() !== null"
              [title]="blockedText()"
              (click)="sync.start()"
            >
              Check again
            </button>
          }
          <button type="button" data-testid="sync-later" (click)="sync.later()">
            {{ state() === 'passed' ? 'Close' : 'Later' }}
          </button>
        </div>
      </section>
    } @else if (lineShown()) {
      <p class="line" data-testid="sync-line">
        <span>{{ line() }}</span>
        <button
          type="button"
          class="link"
          data-testid="sync-start"
          [disabled]="sync.blocked() !== null"
          [title]="blockedText()"
          (click)="sync.start()"
        >
          Sync check
        </button>
      </p>
    }
  `,
  styles: `
    .sync {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--bg);
    }

    h3 {
      margin: 0;
      font-size: 1rem;
    }

    p {
      margin: 0;
    }

    .count,
    .line {
      font-size: 0.875rem;
      font-variant-numeric: tabular-nums;
    }

    .seconds {
      margin-right: var(--space-2);
      font-weight: 600;
    }

    .line,
    .count,
    .hint {
      color: var(--text-muted);
    }

    .hint {
      font-size: 0.75rem;
    }

    .passed {
      color: var(--ok);
    }

    .error {
      color: var(--danger);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .link {
      margin-left: var(--space-2);
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent);
      text-decoration: underline;
    }
  `,
})
export class SyncCheck {
  protected readonly sync = inject(SyncService);
  private readonly recording = inject(RecordingService);

  protected readonly state = computed<PanelState>(() => {
    if (this.sync.run()?.state() === 'running') {
      return 'running';
    }
    const result = this.sync.result();
    if (result === null) {
      return 'idle';
    }
    return result.outcome.ok ? 'passed' : 'failed';
  });
  /** "3 turns, 2 motion onsets" while a check runs. */
  protected readonly counts = computed(() => {
    const run = this.sync.run();
    if (run === null) {
      return '';
    }
    const moves = run.moves();
    const onsets = run.onsets();
    return (
      `${String(moves)} ${moves === 1 ? 'turn' : 'turns'}, ` +
      `${String(onsets)} motion ${onsets === 1 ? 'onset' : 'onsets'}`
    );
  });
  /** "Camera lags the cube by 38 ms (±7); was 41 ms." */
  protected readonly passed = computed(() => {
    const result = this.sync.result();
    if (result === null || !result.outcome.ok) {
      return '';
    }
    const { offsetMs, clapperboardResidualMs } = result.outcome;
    const was =
      result.previousOffsetMs === null
        ? ''
        : `; was ${String(Math.round(result.previousOffsetMs))} ms`;
    const kept = result.saved ? '' : ' No session was under way to keep it in.';
    return `${lagText(offsetMs, clapperboardResidualMs)}${was}.${kept}`;
  });
  protected readonly failed = computed(() => {
    const outcome = this.sync.result()?.outcome;
    return outcome === undefined || outcome.ok ? '' : `Sync check failed: ${outcome.message}.`;
  });
  protected readonly reason = computed(() => {
    const outcome = this.sync.result()?.outcome;
    return outcome === undefined || outcome.ok ? null : outcome.reason;
  });
  /** The line while the panel is hidden: with the camera recording, or a lag to show. */
  protected readonly lineShown = computed(
    () =>
      this.sync.label() !== null &&
      (this.recording.status() === 'recording' || this.sync.stored() !== null),
  );
  protected readonly line = computed(() => {
    const stored = this.sync.stored();
    return stored === null
      ? 'Sync: this camera has no check in this session.'
      : `Sync: ${lagText(stored.offsetMs, stored.clapperboardResidualMs).toLowerCase()}.`;
  });
  protected readonly blockedText = computed(() => {
    const blocked = this.sync.blocked();
    return blocked === null ? '' : BLOCKED[blocked];
  });
}

/**
 * "Camera lags the cube by 41 ms (±12)": the offset and, after ±, the spread of the check's lags
 * (95th minus 5th percentile, `clapperboardResidualMs`), in whole ms.
 */
function lagText(offsetMs: number, spreadMs: number): string {
  const offset = Math.round(offsetMs);
  const lag =
    offset >= 0
      ? `Camera lags the cube by ${String(offset)} ms`
      : `Camera is ahead of the cube by ${String(-offset)} ms`;
  return `${lag} (±${String(Math.round(spreadMs))})`;
}
