import { Component, computed, inject } from '@angular/core';

import { ConnectDialogService } from '../connect/connect-dialog-service';
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
 * (Delete) and New session. The keys are handled by the timer page.
 */
@Component({
  selector: 'app-timer-clock',
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
    <p class="attempt">
      <span data-testid="attempt-index">Attempt {{ session.index() }}</span>
      @if (session.session() !== null) {
        ·
        <span data-testid="save-status" [attr.data-saving]="session.saving()">{{
          session.saving() ? 'Saving…' : 'Saved'
        }}</span>
      }
    </p>
    @if (session.phase() === 'no-cube') {
      <button type="button" class="primary" data-testid="timer-connect" (click)="dialogs.open()">
        Connect a cube
      </button>
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
    .attempt,
    .muted {
      color: var(--text-muted);
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
  protected readonly dialogs = inject(ConnectDialogService);
  private readonly settings = inject(SettingsService);

  protected readonly display = this.session.display;

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
