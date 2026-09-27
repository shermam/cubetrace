import { Component, DestroyRef, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { CameraPanel } from '../camera/camera-panel';
import { ConnectDialogService } from '../connect/connect-dialog-service';
import { CubeService } from '../cube/cube-service';
import { demoRequestFrom } from '../cube/demo';
import { LiveCubePanel } from '../cube/live-cube-panel';
import { SessionService } from '../session/session-service';
import { BreakdownChart } from './breakdown-chart';
import { ClipViewer } from './clip-viewer';
import { ClipViewing } from './clip-viewing';
import { ScrambleView } from './scramble-view';
import { SolveList } from './solve-list';
import { TimerClock } from './timer-clock';

/**
 * `/`: the timer (docs/PLAN.md, T1.6b). Stacked on a phone (scramble, time, breakdown and solves);
 * on wider screens the scramble and the time on the left, the breakdown and the solves on the
 * right, with the live cube panel (T1.6a) in a collapsible "Cube" section below them, and the
 * camera panel (T2.1) in a "Camera" section below that, loaded after the page (its code is a chunk
 * of its own, which the page does not wait for, and it records the clips, T2.4). A solve's clip
 * badge opens its clips in the clip viewer, a chunk of its own too. The keys:
 * `Esc` marks a DNF, `Delete` deletes the last attempt, `N` skips the scramble (or starts the next
 * attempt), except while typing or while a dialog is open. `?demo=<index>&speed=<n>` connects the
 * demo cube once the stored session has been read, so that its first attempt continues it.
 */
@Component({
  selector: 'app-timer-page',
  imports: [
    BreakdownChart,
    CameraPanel,
    ClipViewer,
    LiveCubePanel,
    ScrambleView,
    SolveList,
    TimerClock,
  ],
  host: { '(document:keydown)': 'onKeydown($event)' },
  template: `
    <h1>Timer</h1>
    <div class="timer-layout">
      <section class="scramble" aria-label="Scramble">
        <app-scramble-view />
      </section>
      <section class="clock" aria-label="Time">
        <app-timer-clock />
      </section>
      <section class="solves" aria-label="Breakdown and solves">
        <app-breakdown-chart [attempts]="session.attempts()" />
        <app-solve-list [attempts]="session.attempts()" />
        <details class="cube" data-testid="cube-section">
          <summary>
            <h2>Cube</h2>
            <span class="cube-state">{{ cubeState() }}</span>
          </summary>
          <app-live-cube-panel />
        </details>
        @defer (on immediate) {
          <app-camera-panel />
        } @placeholder {
          <p class="camera-loading"><span class="title">Camera</span></p>
        }
      </section>
    </div>
    @if (viewed(); as attempt) {
      @defer (on immediate) {
        <app-clip-viewer [attempt]="attempt" />
      }
    }
  `,
  styles: `
    @use '../../styles/layout';

    h1 {
      margin-bottom: var(--space-3);
    }

    .timer-layout {
      display: grid;
      grid-template-areas: 'scramble' 'clock' 'solves';
      gap: var(--space-4);

      @include layout.from(layout.$two-columns) {
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        /* The scramble keeps its height when the right-hand column is the taller one. */
        grid-template-rows: auto 1fr;
        grid-template-areas: 'scramble solves' 'clock solves';
        align-items: start;
      }
    }

    section {
      min-width: 0;
      padding: var(--space-4);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }

    .scramble {
      grid-area: scramble;
    }

    .clock {
      grid-area: clock;
    }

    .solves {
      grid-area: solves;
      display: grid;
      gap: var(--space-5);
    }

    .cube summary {
      display: flex;
      gap: var(--space-3);
      align-items: baseline;
      cursor: pointer;

      h2 {
        display: inline;
        margin: 0;
      }
    }

    .cube[open] summary {
      margin-bottom: var(--space-3);
    }

    .cube-state {
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    /* Where the Camera section appears once its code has loaded. */
    .camera-loading {
      margin: 0;

      .title {
        font-size: 1.125rem;
        font-weight: 600;
      }
    }
  `,
})
export class TimerPage {
  protected readonly session = inject(SessionService);
  private readonly cube = inject(CubeService);
  private readonly dialogs = inject(ConnectDialogService);
  private readonly viewing = inject(ClipViewing);
  /** The attempt whose clips the viewer shows; null while it is closed. */
  protected readonly viewed = computed(() => {
    const index = this.viewing.index();
    return index === null
      ? null
      : (this.session.attempts().find((attempt) => attempt.index === index) ?? null);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.viewing.close();
    });
    this.session.prepare();
    const demo = demoRequestFrom(inject(ActivatedRoute).snapshot.queryParamMap);
    if (demo !== null) {
      void this.session.whenReady().then(() => {
        this.cube.autoStartDemo(demo);
      });
    }
  }

  /** The Cube section's summary: whether a cube is there, and solved. */
  protected cubeState(): string {
    switch (this.cube.status()) {
      case 'connected':
        return this.cube.solved() ? 'Solved' : 'Not solved';
      case 'connecting':
        return 'Connecting…';
      case 'disconnected':
        return 'No cube';
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (
      this.dialogs.isOpen() ||
      (target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select, dialog') !== null))
    ) {
      return;
    }
    switch (event.key) {
      case 'Escape':
        this.session.dnf();
        break;
      case 'Delete':
        this.session.deleteLast();
        break;
      case 'n':
      case 'N':
        this.session.advance();
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
