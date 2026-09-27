import { Component, computed, inject } from '@angular/core';

import { CubeConnect } from '../connect/cube-connect';
import { CubeService } from '../cube/cube-service';
import { SessionService, type TimerPhase } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';

const STATUS: Readonly<Record<TimerPhase, string>> = {
  loading: 'Loading the session…',
  'no-cube': 'Connect a cube to start.',
  connecting: 'Connecting the cube…',
  'solve-first': 'Solve the cube first: the attempt starts when it is solved.',
  'scramble-wait': 'Generating a scramble…',
  'cube-info': 'Waiting for the cube to say what it is…',
  next: 'Press Next scramble (N) for the next attempt.',
  scrambling: 'Scramble the cube as shown.',
  armed: 'Ready: the timer starts with your first turn.',
  solving: 'Solving…',
  paused: 'The cube disconnected: connect it again to go on with this attempt.',
};

/**
 * The time and the attempt's controls (docs/PLAN.md, T1.6b): what the timer is waiting for, the
 * big time (see `timerDisplay`), the attempt's number, and Skip scramble (N), DNF (Esc), Delete last
 * (Delete) and New session. The keys are handled by the timer page. While the time is a result
 * (solved or DNF), the line under it names that attempt and says whether its record is saved: the
 * attempt's number below it is already the next attempt's with auto-advance. While no cube is
 * connected, "Connect a cube" and "Try the demo" (T1.12), also while an attempt waits for its cube.
 */
@Component({
  selector: 'app-timer-clock',
  imports: [CubeConnect],
  template: `
    <p class="status" role="status" data-testid="timer-status" [attr.data-phase]="session.phase()">
      {{ status() }}
    </p>
    <p
      class="time"
      data-testid="timer"
      [attr.data-kind]="display().kind"
      [class.overtime]="display().overtime"
    >
      {{ display().text }}
    </p>
    <p class="result">
      @if (result(); as result) {
        <span data-testid="result-index">#{{ result.index }}</span> ·
        <span data-testid="save-status" [attr.data-saving]="session.saving()">{{
          result.save
        }}</span>
      }
    </p>
    <p class="attempt">
      <span data-testid="attempt-index">Attempt {{ session.index() }}</span>
    </p>
    @if (showConnect()) {
      <app-cube-connect testId="timer-connect" />
    }
    <div class="actions">
      <button
        type="button"
        data-testid="skip"
        [disabled]="!session.canSkip()"
        (click)="session.advance()"
      >
        {{ session.phase() === 'next' ? 'Next scramble' : 'Skip scramble' }} <kbd>N</kbd>
      </button>
      <button
        type="button"
        data-testid="dnf"
        [disabled]="!session.canDnf()"
        (click)="session.dnf()"
      >
        DNF <kbd>Esc</kbd>
      </button>
      <button
        type="button"
        data-testid="delete-last"
        [disabled]="!session.canDeleteLast()"
        (click)="session.deleteLast()"
      >
        Delete last <kbd>Del</kbd>
      </button>
      <button
        type="button"
        data-testid="new-session"
        [disabled]="!session.canNewSession()"
        (click)="session.newSession()"
      >
        New session
      </button>
    </div>
    @if (session.storageKind === 'memory') {
      <p class="warning" role="alert" data-testid="storage-warning">
        This browser has no origin private file system: sessions are kept only until the page
        closes.
      </p>
    }
    @if (session.saveError(); as error) {
      <p class="warning" role="alert" data-testid="save-error">Not saved: {{ error }}</p>
    }
    @if (session.notice(); as notice) {
      <p class="muted">{{ notice }}</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-2);
      justify-items: center;
      /* The time scales with the width of its region, so "1:23.45" fits a phone and a laptop. */
      container-type: inline-size;
      text-align: center;
    }

    p {
      margin: 0;
    }

    .status,
    .result,
    .attempt,
    .muted {
      color: var(--text-muted);
    }

    .result {
      /* Kept when empty, so that the buttons do not move when a solve starts or ends. */
      min-height: 1lh;
      font-size: 0.875rem;
    }

    .time {
      font-family: var(--font-mono);
      font-size: clamp(3rem, 18cqi, 9rem);
      font-variant-numeric: tabular-nums;
      line-height: 1.1;

      &[data-kind='ready'] {
        color: var(--ok);
      }

      &[data-kind='inspection'] {
        color: var(--warn);
      }

      &[data-kind='paused'] {
        color: var(--text-muted);
      }

      &[data-kind='dnf'],
      &.overtime {
        color: var(--danger);
      }
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      justify-content: center;
    }

    app-cube-connect {
      justify-items: center;
    }

    kbd {
      margin-left: var(--space-1);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 0.75rem;
    }

    .warning {
      color: var(--warn);
    }
  `,
})
export class TimerClock {
  protected readonly session = inject(SessionService);
  private readonly cube = inject(CubeService);
  private readonly settings = inject(SettingsService);

  protected readonly display = this.session.display;

  /** Once the session is read, while no cube is connected (a paused attempt included). */
  protected readonly showConnect = computed(
    () => this.session.phase() !== 'loading' && this.cube.status() !== 'connected',
  );

  /**
   * The attempt whose result the time shows, and whether its record is saved ("Saving…", "Saved",
   * or "Not saved", which the alert below explains); null while the time is not a result.
   */
  protected readonly result = computed((): { index: number; save: string } | null => {
    const kind = this.display().kind;
    const last = this.session.lastResult();
    if ((kind !== 'solved' && kind !== 'dnf') || last === null) {
      return null;
    }
    const save =
      this.session.saveError() !== null ? 'Not saved' : this.session.saving() ? 'Saving…' : 'Saved';
    return { index: last.index, save };
  });

  protected readonly status = computed(() => {
    const phase = this.session.phase();
    const attempt = this.session.attempt();
    if (phase === 'scrambling' && attempt?.progress.diverged) {
      return 'Off the scramble: undo the moves shown.';
    }
    if (phase === 'armed' && this.settings.inspection()) {
      return 'Inspection: the timer starts with your first turn.';
    }
    return STATUS[phase];
  });
}
