import { Component, DestroyRef, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { CameraPanel } from '../camera/camera-panel';
import { CameraPreview } from '../camera/camera-preview';
import { SyncCheck } from '../camera/sync-check';
import { ConnectDialogService } from '../connect/connect-dialog-service';
import { CubeService } from '../cube/cube-service';
import { demoRequestFrom } from '../cube/demo';
import { LiveCubePanel } from '../cube/live-cube-panel';
import { SessionService } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { BreakdownChart } from './breakdown-chart';
import { ClipViewer } from './clip-viewer';
import { ClipViewing } from './clip-viewing';
import { ScrambleView } from './scramble-view';
import { SolveList } from './solve-list';
import { TimerClock } from './timer-clock';
import { TWO_COLUMNS_QUERY, timerLayout, windowMatches } from './timer-layout';

/** The Timer page lists this many solves, the newest; the session's page has them all (T2.7). */
export const TIMER_SOLVES = 12;

/**
 * `/`: the timer (docs/PLAN.md, T1.6b; laid out for the camera by T2.7 and, on a phone, T2.13). On
 * a phone, one column: the scramble, the time, the breakdown, the last solves, then the collapsible
 * Cube section (T1.6a) and Camera settings (T2.1). With the camera on, its picture is pinned at the
 * top of the window with the scramble over its lower part, so that both stay in view as the page
 * scrolls, and the sync check comes under the time; with the camera off, the scramble alone is
 * pinned; with Scramble over the picture off (Settings → Timer), nothing is pinned and the camera's
 * preview comes under the time, as T2.7 had it (`TimerLayout`). On wider screens the scramble and,
 * under it, the time with the camera's preview beside it (so that the scramble, the time and the
 * picture are in view together), then the two sections; on the right the breakdown, the session's
 * statistics and its last {@link TIMER_SOLVES} solves, with "See all" to the session's page. The
 * camera's preview and settings are chunks of their own, loaded after the page (which does not wait
 * for them); they record the clips (T2.4). A solve's clip badge opens its clips in the clip viewer,
 * a chunk of its own too. The keys: `Esc` marks a DNF, `Delete` deletes the last attempt, `N` skips
 * the scramble (or starts the next attempt), except while typing or while a dialog is open.
 * `?demo=<index>&speed=<n>` connects the demo cube once the stored session has been read, so that
 * its first attempt continues it.
 */
@Component({
  selector: 'app-timer-page',
  imports: [
    BreakdownChart,
    CameraPanel,
    CameraPreview,
    ClipViewer,
    LiveCubePanel,
    ScrambleView,
    SolveList,
    SyncCheck,
    TimerClock,
  ],
  host: { '(document:keydown)': 'onKeydown($event)' },
  template: `
    <!-- The navigation says where this is; the space goes to the scramble, the time and the camera. -->
    <h1 class="visually-hidden">Timer</h1>
    <div class="timer-layout" data-testid="timer-layout" [attr.data-layout]="layout()">
      <!-- The scramble; on a phone, pinned at the top of the window, over the camera's picture
           while the camera is on (T2.13). -->
      <div class="stage" data-testid="timer-stage">
        <section class="scramble" aria-label="Scramble">
          <app-scramble-view [overPicture]="overlay()" />
        </section>
        @if (overlay()) {
          @defer (on immediate) {
            <app-camera-preview [overlay]="true" />
          } @placeholder {
            <div class="picture-placeholder"></div>
          }
        }
      </div>
      <div class="live">
        <div class="live-row">
          <section class="clock" aria-label="Time">
            <app-timer-clock />
          </section>
          @if (!overlay()) {
            @defer (on immediate) {
              <app-camera-preview />
            }
          }
        </div>
        @if (overlay()) {
          <!-- Under the time, out of the pinned part: elsewhere it is under the preview. -->
          @defer (on immediate) {
            <app-sync-check />
          }
        }
      </div>
      <section class="solves" aria-label="Breakdown and solves">
        <app-breakdown-chart [attempts]="session.attempts()" />
        <app-solve-list
          [attempts]="session.attempts()"
          [limit]="solves"
          [sessionId]="session.session()?.id ?? null"
        />
      </section>
      <div class="sections">
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
          <p class="camera-loading"><span class="title">Camera settings</span></p>
        }
      </div>
    </div>
    @if (viewed(); as attempt) {
      @defer (on immediate) {
        <app-clip-viewer [attempt]="attempt" />
      }
    }
  `,
  styles: `
    @use '../../styles/layout';

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    /* A phone keeps its spacing tight, so that the scramble, the time and the preview fit its
       screen together. */
    .timer-layout {
      --section-gap: var(--space-3);
      --section-padding: var(--space-3);

      display: grid;
      grid-template-areas: 'scramble' 'live' 'solves' 'sections';
      gap: var(--section-gap);

      @include layout.from(layout.$two-columns) {
        --section-gap: var(--space-4);
        --section-padding: var(--space-4);

        grid-template-columns: minmax(0, 1fr) minmax(0, 22rem);
        /* The left column keeps its heights when the right-hand one is the taller. */
        grid-template-rows: auto auto 1fr;
        grid-template-areas: 'scramble solves' 'live solves' 'sections solves';
        align-items: start;
      }
    }

    section,
    .sections > details,
    .sections > app-camera-panel,
    .camera-loading {
      min-width: 0;
      padding: var(--section-padding);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }

    .stage {
      grid-area: scramble;
      min-width: 0;
    }

    /* On a phone (T2.13), the scramble stays in view: pinned at the top of the window, over the rest,
       from edge to edge on the page's background, so that nothing shows through beside it. */
    [data-layout='pinned'] > .stage,
    [data-layout='overlay'] > .stage {
      position: sticky;
      top: 0;
      z-index: 2;
      margin-inline: calc(-1 * var(--gutter));
      background: var(--bg);
    }

    /* The scramble's card where T2.7 has it; pinned, with a band of the background above and under
       it. */
    [data-layout='pinned'] > .stage {
      margin-block: calc(-1 * var(--gutter)) calc(-1 * var(--space-2));
      padding: var(--gutter) var(--gutter) var(--space-2);
    }

    /* The camera's picture from edge to edge, the scramble over its lower part on a dark strip
       through which the picture still shows, as tall as its lines. */
    [data-layout='overlay'] > .stage {
      display: grid;

      > * {
        grid-area: 1 / 1;
        min-width: 0;
      }

      > .scramble {
        z-index: 1;
        align-self: end;
        padding: var(--space-2) var(--gutter);
        border: 0;
        border-top: 1px solid rgb(255 255 255 / 35%);
        border-radius: 0;
        background: rgb(0 0 0 / 60%);
        color: #fff;
        text-shadow: 0 1px 2px rgb(0 0 0 / 90%);
      }
    }

    /* Where the picture comes once its code has loaded: the box it opens in. */
    .picture-placeholder {
      aspect-ratio: 16 / 9;
      max-height: 42svh;
      background: #000;
    }

    /* Only while it shows something (empty, it holds comments alone). */
    .live app-sync-check:not(:empty) {
      display: block;
      margin-top: var(--section-gap);
    }

    /* The time and, beside it where the column is wide enough (under it otherwise), the camera's
       preview: a box of 16:9 that is 15rem (240 px) high at most. */
    .live {
      grid-area: live;
      container: live / inline-size;
    }

    .live-row {
      display: flex;
      flex-direction: column;
      gap: var(--section-gap);
    }

    app-camera-preview {
      width: 100%;
      max-width: calc(15rem * 16 / 9);
    }

    @container live (min-width: 46rem) {
      .live-row {
        flex-direction: row;
        align-items: flex-start;
      }

      .clock {
        flex: 1 1 0;
      }

      app-camera-preview {
        flex: none;
        width: calc(15rem * 16 / 9);
      }
    }

    .solves {
      grid-area: solves;
      display: grid;
      gap: var(--space-5);
    }

    .sections {
      grid-area: sections;
      display: grid;
      gap: var(--section-gap);
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

    /* Where Camera settings appear once their code has loaded. */
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
  protected readonly solves = TIMER_SOLVES;
  private readonly settings = inject(SettingsService);
  private readonly wide = windowMatches(TWO_COLUMNS_QUERY);
  /**
   * T2.7's columns on a wide window; on a phone, the scramble pinned, over the camera's picture
   * while the camera is on (T2.13). "Camera on" is the setting, which the camera follows as soon as
   * its code has loaded, so that the layout does not wait for that code.
   */
  protected readonly layout = computed(() =>
    timerLayout(this.wide(), this.settings.cameraOn(), this.settings.scrambleOverPicture()),
  );
  protected readonly overlay = computed(() => this.layout() === 'overlay');
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
