import { Component, computed, input } from '@angular/core';

import type { BarSegment } from './breakdown';

/**
 * One stacked bar of phase segments, as inline SVG: each segment in its phase's colour, with its
 * duration and moves as a tooltip, a gap between neighbours and a rounded end. Lengths are percent
 * of the bar's width, so it fills its box at any size.
 */
@Component({
  selector: 'app-phase-bar',
  template: `
    <svg
      role="img"
      width="100%"
      [attr.height]="height()"
      [attr.aria-label]="label()"
      [style.height.px]="height()"
    >
      @for (segment of segments(); track segment.name) {
        <g [attr.data-phase]="segment.name">
          <title>{{ segment.title }}</title>
          <rect
            y="0"
            [attr.x]="segment.x + '%'"
            [attr.width]="segment.width + '%'"
            [attr.height]="height()"
            [attr.rx]="segment.end ? radius() : null"
            [attr.fill]="segment.colour"
          />
          @if (segment.end && radius() > 0) {
            <!-- Square at the start: only the bar's end is rounded. -->
            <rect
              y="0"
              [attr.x]="segment.x + '%'"
              [attr.width]="segment.width / 2 + '%'"
              [attr.height]="height()"
              [attr.fill]="segment.colour"
            />
          }
        </g>
      }
      @for (x of gaps(); track $index) {
        <rect
          class="gap"
          y="0"
          [attr.x]="x + '%'"
          [attr.width]="gap()"
          [attr.height]="height()"
          [attr.transform]="'translate(' + -gap() / 2 + ' 0)'"
        />
      }
    </svg>
  `,
  styles: `
    :host {
      display: block;
    }

    svg {
      display: block;
      width: 100%;
    }

    .gap {
      fill: var(--surface);
    }
  `,
})
export class PhaseBar {
  readonly segments = input.required<readonly BarSegment[]>();
  /** For screen readers: what the bar shows. */
  readonly label = input.required<string>();
  readonly height = input(16);
  /** The gap between segments, in px. */
  readonly gap = input(2);
  /** The radius of the rounded end, in px. */
  readonly radius = input(4);

  /** Where one segment with a length meets the next, in percent. */
  protected readonly gaps = computed(() =>
    this.segments()
      .filter((segment) => segment.width > 0)
      .slice(1)
      .map((segment) => segment.x),
  );
}
