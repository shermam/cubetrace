import { Component, input } from '@angular/core';

import type { StatusPart } from './remote-status';

/**
 * A phone's status line as spans (T5.1, `remoteStatusLine`): each part's label muted and its value in
 * its tone's colour (green good, amber warn, red bad), the recording word in the host's `rec` style
 * (a red dot while it records), the parts apart by " · ", and each part's meaning as its title. With
 * `short`, the parts' short words alone (a tile's caption). The Timer page's line and the Cameras
 * list's report use it, so that the two read alike.
 */
@Component({
  selector: 'app-status-parts',
  template: `
    @for (part of parts(); track part.key; let first = $first) {
      @if (!first) {
        <span class="separator" aria-hidden="true">{{ ' · ' }}</span>
      }
      <span
        class="part"
        [attr.data-testid]="testId() === '' ? null : testId() + '-' + part.key"
        [attr.data-key]="part.key"
        [attr.data-tone]="part.tone"
        [title]="part.title"
      >
        @if (short()) {
          <span class="value">{{ part.short ?? part.value }}</span>
        } @else {
          @if (part.key === 'recording' && part.tone === 'plain') {
            <span class="dot" aria-hidden="true"></span>
          }
          @if (part.label !== '') {
            <span class="label">{{ part.label + ' ' }}</span>
          }
          <span class="value">{{ part.value }}</span>
        }
      </span>
    }
  `,
  styles: `
    .part {
      white-space: nowrap;
    }

    [data-key='sharpness'] .value {
      font-family: var(--font-mono);
    }

    [data-tone='ok'] .value {
      color: var(--ok);
    }

    [data-tone='warn'] .value {
      color: var(--warn);
    }

    [data-tone='bad'] .value {
      color: var(--danger);
    }

    [data-key='recording'][data-tone='plain'] {
      color: var(--text);
    }

    .dot {
      display: inline-block;
      width: 0.5rem;
      height: 0.5rem;
      margin-right: var(--space-1);
      border-radius: 50%;
      background: var(--danger);
    }
  `,
})
export class StatusParts {
  readonly parts = input.required<readonly StatusPart[]>();
  /** The parts' short words alone, for a tile's caption. */
  readonly short = input(false);
  /** Each part's test id is this and its key (`remote-status-fps`); none when empty. */
  readonly testId = input('');
}
