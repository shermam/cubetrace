import { Component, computed, inject } from '@angular/core';

import { RecordingService } from './recording-service';
import { SYNC_TURNS } from './sync-run';
import { SyncService, type SyncBlock } from './sync-service';

/**
 * What the panel shows: a check under way; a check due, waiting for a framing rectangle around the
 * cube (`framing`) or for Start once there is one (`ready`); how the last one went; or nothing yet.
 */
type PanelState = 'running' | 'framing' | 'ready' | 'passed' | 'failed' | 'idle';

/** Why a check cannot be started, for the title of its button and the line beside it. */
const BLOCKED: Readonly<Record<SyncBlock, string>> = {
  'not-recording': 'Once the camera records (a session under way).',
  'no-cube': 'Once a cube is connected.',
  loading: 'Once the session is loaded.',
  scrambling: "Before the scramble's first turn, or after the solve.",
  solving: 'After the solve.',
  running: 'A check is under way.',
};

/**
 * The sync check under the camera's preview (docs/PLAN.md, T2.5, T2.8 and T2.11): while the framing
 * rectangle is the whole frame or most of it, a check that is due first asks for a rectangle around
 * the cube (with "Edit the framing", which opens Camera settings to the editor, and "Start anyway");
 * while a check runs, what to do (the cube held still, one face flicked with one finger and flicked
 * back after a second, five times), "Hold still…" for its first second, how long it waits for the
 * first turn, then the turns made out of ten and how many the camera saw; then the camera's lag
 * behind the cube, or why the check failed, with Retry and "Download check data" (a small link after
 * a success); "Later" hides it. Hidden, one line says the lag this session has for the camera, with
 * "Sync check" to run one. Wherever a check cannot be started, the reason is written beside its
 * button. The logic is `SyncService`'s; this only shows it.
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
          @case ('framing') {
            <p class="ask" data-testid="sync-framing">
              Draw the framing rectangle around the cube first (Camera settings → Framing → Edit):
              the check looks for motion inside it.
            </p>
          }
          @case ('ready') {
            <p class="ask" data-testid="sync-ready">
              The framing rectangle is set: start the check with the cube in it.
            </p>
          }
          @case ('running') {
            @if (sync.run(); as run) {
              <p class="ask">
                Hold the cube still inside the rectangle. With one finger, flick one face; keep your
                other hand and the cube still; after a second, flick it back. Five times.
              </p>
              <p
                class="count"
                data-testid="sync-count"
                [attr.data-frames]="run.frames()"
                [attr.data-moves]="run.moves()"
                [attr.data-matched]="run.matched()"
              >
                @if (run.holding()) {
                  <span class="seconds" data-testid="sync-hold">Hold still…</span>
                  wait a second before the first turn
                } @else if (run.moves() === 0) {
                  <span class="seconds" data-testid="sync-seconds">{{ run.secondsLeft() }} s</span>
                  for the first turn
                } @else {
                  <span class="progress" data-testid="sync-progress">{{ progress() }}</span>
                  · {{ seen() }}
                }
              </p>
              <p class="hint">
                Any face will do. The timer waits meanwhile: the attempt begins again, with its
                scramble, once the check ends and the cube is solved and still.
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
            <p class="hint">
              If it keeps failing, download the check's data and attach it to an issue: it holds
              what the camera saw around each turn.
            </p>
          }
        }
        <div class="actions">
          @switch (state()) {
            @case ('framing') {
              <button
                type="button"
                class="primary"
                data-testid="sync-edit-framing"
                (click)="sync.editFraming()"
              >
                Edit the framing
              </button>
              <button
                type="button"
                data-testid="sync-anyway"
                [disabled]="blocked()"
                [title]="blockedText()"
                (click)="sync.startAnyway()"
              >
                Start anyway
              </button>
            }
            @case ('ready') {
              <button
                type="button"
                class="primary"
                data-testid="sync-go"
                [disabled]="blocked()"
                [title]="blockedText()"
                (click)="sync.start()"
              >
                Start
              </button>
            }
            @case ('failed') {
              <button
                type="button"
                class="primary"
                data-testid="sync-retry"
                [disabled]="blocked()"
                [title]="blockedText()"
                (click)="sync.start()"
              >
                Retry
              </button>
              <button type="button" data-testid="sync-download" (click)="sync.downloadReport()">
                Download check data
              </button>
            }
            @case ('passed') {
              <button
                type="button"
                data-testid="sync-again"
                [disabled]="blocked()"
                [title]="blockedText()"
                (click)="sync.start()"
              >
                Check again
              </button>
            }
          }
          <button type="button" data-testid="sync-later" (click)="sync.later()">
            {{ state() === 'passed' ? 'Close' : 'Later' }}
          </button>
          @if (state() === 'passed') {
            <button
              type="button"
              class="link"
              data-testid="sync-download"
              (click)="sync.downloadReport()"
            >
              Download check data
            </button>
          }
        </div>
        @if (blocked() && state() !== 'running') {
          <p class="why" data-testid="sync-why">{{ blockedText() }}</p>
        }
        @if (sync.notice(); as notice) {
          <p class="notice" role="status" data-testid="sync-notice">{{ notice }}</p>
        }
      </section>
    } @else if (lineShown()) {
      <p class="line" data-testid="sync-line">
        <span>{{ line() }}</span>
        <button
          type="button"
          class="link"
          data-testid="sync-start"
          [disabled]="blocked()"
          [title]="blockedText()"
          (click)="sync.start()"
        >
          Sync check
        </button>
        @if (blocked()) {
          <span class="why" data-testid="sync-why">{{ blockedText() }}</span>
        }
        @if (sync.notice(); as notice) {
          <span class="notice" role="status" data-testid="sync-notice">{{ notice }}</span>
        }
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

    .seconds,
    .progress {
      font-weight: 600;
    }

    .line,
    .count,
    .hint,
    .why {
      color: var(--text-muted);
    }

    .hint,
    .why,
    .notice {
      font-size: 0.75rem;
    }

    .line .why,
    .line .notice {
      display: block;
    }

    .passed {
      color: var(--ok);
    }

    .error {
      color: var(--danger);
    }

    .notice {
      color: var(--warn);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
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

    .actions .link {
      margin-left: 0;
      font-size: 0.75rem;
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
    if (this.sync.waiting()) {
      return this.sync.framingWide() ? 'framing' : 'ready';
    }
    const result = this.sync.result();
    if (result === null) {
      return 'idle';
    }
    return result.outcome.ok ? 'passed' : 'failed';
  });
  /** "Turn 3 of 10" once the turns have begun. */
  protected readonly progress = computed(() => {
    const moves = this.sync.run()?.moves() ?? 0;
    return `Turn ${String(Math.min(moves, SYNC_TURNS))} of ${String(SYNC_TURNS)}`;
  });
  /** "2 seen by the camera", and what to do once the ten turns are made. */
  protected readonly seen = computed(() => {
    const run = this.sync.run();
    const seen = `${String(run?.matched() ?? 0)} seen by the camera`;
    return (run?.moves() ?? 0) >= SYNC_TURNS ? `${seen}; hold the cube still` : seen;
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
  /** A check cannot be started now (one that runs aside). */
  protected readonly blocked = computed(() => this.sync.blocked() !== null);
  protected readonly blockedText = computed(() => {
    const blocked = this.sync.blocked();
    return blocked === null ? '' : BLOCKED[blocked];
  });
}

/**
 * "Camera lags the cube by 41 ms (±12)": the offset and, after ±, the spread of the check's lags (the
 * range of the lags kept, `clapperboardResidualMs`), in whole ms.
 */
function lagText(offsetMs: number, spreadMs: number): string {
  const offset = Math.round(offsetMs);
  const lag =
    offset >= 0
      ? `Camera lags the cube by ${String(offset)} ms`
      : `Camera is ahead of the cube by ${String(-offset)} ms`;
  return `${lag} (±${String(Math.round(spreadMs))})`;
}
