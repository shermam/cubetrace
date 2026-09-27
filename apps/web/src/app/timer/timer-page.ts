import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { coreVersion, generateScramble } from '@cubetrace/core';

import { CubeService } from '../cube/cube-service';
import { demoRequestFrom } from '../cube/demo';
import { LiveCubePanel } from '../cube/live-cube-panel';

/**
 * `/`: the timer. Placeholder until T1.6b, which fills the three regions of its responsive
 * layout: stacked on a phone (scramble, time, breakdown and solves); on wider screens the
 * scramble and the time on the left and the breakdown and solves on the right. It also shows
 * the core library's version string, a scramble from cubing.js as text (T1.2), and the live cube
 * panel (T1.6a). `?demo=<index>&speed=<n>` connects the demo cube on load.
 */
@Component({
  selector: 'app-timer-page',
  imports: [LiveCubePanel],
  template: `
    <h1>Timer</h1>
    <div class="timer-layout">
      <section class="scramble" aria-label="Scramble">
        @if (scramble(); as moves) {
          <p class="moves" data-testid="scramble">{{ moves }}</p>
        } @else if (scrambleError(); as message) {
          <p class="error" role="alert">No scramble: {{ message }}</p>
        } @else {
          <p class="placeholder">Generating a scramble…</p>
        }
        <p class="placeholder">Its picture arrives with T1.6b.</p>
      </section>
      <section class="clock" aria-label="Time">
        <p class="time">0.00</p>
      </section>
      <section class="solves" aria-label="Breakdown and solves">
        <app-live-cube-panel />
        <p class="placeholder">The CFOP breakdown and the solve list arrive with T1.6b.</p>
      </section>
    </div>
    <p class="version" data-testid="core-version">{{ coreVersion }}</p>
  `,
  styles: `
    @use '../../styles/layout';

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

    .moves {
      margin: 0 0 var(--space-2);
      font-family: var(--font-mono);
      font-size: 1.25rem;
      word-spacing: 0.25em;
    }

    .error {
      margin: 0 0 var(--space-2);
      color: var(--danger);
    }

    .solves {
      grid-area: solves;
      display: grid;
      gap: var(--space-4);
    }

    /* The time scales with the width of its region, so "1:23.45" fits a phone and a laptop. */
    .clock {
      grid-area: clock;
      container-type: inline-size;
      text-align: center;
    }

    .time {
      margin: 0;
      font-family: var(--font-mono);
      font-size: clamp(3rem, 18cqi, 9rem);
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }

    .placeholder,
    .version {
      margin: 0;
      color: var(--text-muted);
    }

    .version {
      margin-top: var(--space-4);
      font-family: var(--font-mono);
      font-size: 0.875rem;
    }
  `,
})
export class TimerPage {
  protected readonly coreVersion = coreVersion();
  protected readonly scramble = signal<string | null>(null);
  protected readonly scrambleError = signal<string | null>(null);

  constructor() {
    const demo = demoRequestFrom(inject(ActivatedRoute).snapshot.queryParamMap);
    if (demo !== null) {
      inject(CubeService).autoStartDemo(demo);
    }
    generateScramble().then(
      (scramble) => {
        this.scramble.set(scramble);
      },
      (error: unknown) => {
        this.scrambleError.set(error instanceof Error ? error.message : String(error));
      },
    );
  }
}
