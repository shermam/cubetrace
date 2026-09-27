import { Component } from '@angular/core';
import { coreVersion } from '@cubetrace/core';

/**
 * `/`: the timer. Placeholder until T1.6, which fills the three regions of its responsive
 * layout: stacked on a phone (scramble, time, breakdown and solves); on wider screens the
 * scramble and the time on the left and the breakdown and solves on the right. It also shows
 * the core library's version string.
 */
@Component({
  selector: 'app-timer-page',
  template: `
    <h1>Timer</h1>
    <div class="timer-layout">
      <section class="scramble" aria-label="Scramble">
        <p class="placeholder">The scramble and its picture arrive with T1.6.</p>
      </section>
      <section class="clock" aria-label="Time">
        <p class="time">0.00</p>
      </section>
      <section class="solves" aria-label="Breakdown and solves">
        <p class="placeholder">The CFOP breakdown and the solve list arrive with T1.6.</p>
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

    .solves {
      grid-area: solves;
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
}
