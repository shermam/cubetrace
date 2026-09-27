import { Component } from '@angular/core';
import { coreVersion } from '@cubetrace/core';

/** `/`: the timer. Placeholder until T1.6; shows the core library's version string. */
@Component({
  selector: 'app-timer-page',
  template: `
    <h1>Timer</h1>
    <p>Scramble, timer and CFOP breakdown arrive with T1.6.</p>
    <p class="version" data-testid="core-version">{{ coreVersion }}</p>
  `,
  styles: `
    .version {
      font-family: ui-monospace, monospace;
      opacity: 0.7;
    }
  `,
})
export class TimerPage {
  protected readonly coreVersion = coreVersion();
}
