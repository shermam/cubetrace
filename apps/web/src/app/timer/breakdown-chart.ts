import { Component, computed, input } from '@angular/core';
import { PHASE_NAMES, phaseAverages, type AttemptRecord } from '@cubetrace/core';

import { formatTime } from '../shared/format-time';
import {
  PHASE_COLOURS,
  PHASE_LABELS,
  attemptPhases,
  averagePhases,
  averagedSolves,
  breakdownBars,
} from './breakdown';
import { PhaseBar } from './phase-bar';

/** A row of the numbers table: a phase's time and moves in the last solve and on average. */
interface NumbersRow {
  readonly label: string;
  readonly last: string;
  readonly average: string;
}

/**
 * The CFOP breakdown (docs/PLAN.md, T1.6b): the last solve and the session average as stacked
 * bars of the eight phases on one scale, a legend, and the same numbers as a table.
 */
@Component({
  selector: 'app-breakdown-chart',
  imports: [PhaseBar],
  template: `
    <h2>Breakdown</h2>
    @if (bars().length === 0) {
      <p class="muted">The CFOP breakdown appears after the first solve.</p>
    } @else {
      @for (bar of bars(); track bar.key) {
        <div class="bar" [attr.data-testid]="'breakdown-' + bar.key">
          <p class="bar-label">
            <span>{{ bar.label }}</span
            ><span class="total">{{ bar.total }}</span>
          </p>
          <app-phase-bar [segments]="bar.segments" [label]="bar.label + ', ' + bar.total" />
        </div>
      }
      <ul class="legend" aria-label="Phases">
        @for (name of phases; track name) {
          <li><span class="swatch" [style.background]="colours[name]"></span>{{ labels[name] }}</li>
        }
      </ul>
      <details>
        <summary>Numbers</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Phase</th>
              <th scope="col">Last solve</th>
              <th scope="col">Average</th>
            </tr>
          </thead>
          <tbody>
            @for (row of numbers(); track row.label) {
              <tr>
                <th scope="row">{{ row.label }}</th>
                <td>{{ row.last }}</td>
                <td>{{ row.average }}</td>
              </tr>
            }
          </tbody>
        </table>
      </details>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-3);
    }

    h2,
    p {
      margin: 0;
    }

    .muted {
      color: var(--text-muted);
    }

    .bar {
      display: grid;
      gap: var(--space-1);
    }

    .bar-label {
      display: flex;
      justify-content: space-between;
      gap: var(--space-2);
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .total {
      color: var(--text);
      font-family: var(--font-mono);
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-3);
      margin: 0;
      padding: 0;
      font-size: 0.8125rem;
      list-style: none;

      li {
        display: inline-flex;
        gap: var(--space-1);
        align-items: center;
      }
    }

    .swatch {
      width: 0.625rem;
      height: 0.625rem;
      border-radius: 2px;
    }

    summary {
      color: var(--text-muted);
      font-size: 0.875rem;
      cursor: pointer;
    }

    table {
      margin-top: var(--space-2);
      border-collapse: collapse;
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
    }

    th,
    td {
      padding: 0.125rem var(--space-2);
      text-align: end;
    }

    th[scope='row'],
    th:first-child {
      text-align: start;
    }
  `,
})
export class BreakdownChart {
  /** The session's attempts, by index. */
  readonly attempts = input.required<readonly AttemptRecord[]>();

  protected readonly phases = PHASE_NAMES;
  protected readonly labels = PHASE_LABELS;
  protected readonly colours = PHASE_COLOURS;

  private readonly lastSolve = computed(
    () =>
      this.attempts()
        .filter((a) => a.result.status === 'solved')
        .at(-1) ?? null,
  );
  private readonly averages = computed(() => phaseAverages(this.attempts()));

  protected readonly bars = computed(() =>
    breakdownBars(this.lastSolve(), this.averages(), averagedSolves(this.attempts())),
  );

  protected readonly numbers = computed((): NumbersRow[] => {
    const last = this.lastSolve();
    const lastPhases = last === null ? [] : attemptPhases(last);
    const averages = this.averages();
    const averageList = averages === null ? [] : averagePhases(averages);
    return PHASE_NAMES.map((name) => {
      const own = lastPhases.find((p) => p.name === name);
      const mean = averageList.find((p) => p.name === name);
      return {
        label: PHASE_LABELS[name],
        last: own === undefined ? '–' : `${formatTime(own.ms)} · ${String(own.moves)}`,
        average: mean === undefined ? '–' : `${formatTime(mean.ms)} · ${mean.moves.toFixed(1)}`,
      };
    });
  });
}
