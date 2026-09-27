import { Component, input } from '@angular/core';
import { FACE_ORDER, type Face, type Facelets } from '@cubetrace/core';

/** Where each face sits in the unfolded cube: U above F, then L F R B in a row, D below F. */
const FACE_ORIGIN: Readonly<Record<Face, readonly [row: number, column: number]>> = {
  U: [0, 3],
  L: [3, 0],
  F: [3, 3],
  R: [3, 6],
  B: [3, 9],
  D: [6, 3],
};

/**
 * The grid cell of each of the 54 facelets, in Kociemba order. Each face is in reading order seen
 * from outside, with U's top row next to B, D's next to F and the side faces' next to U
 * (docs/DATA-MODEL.md §2), which is exactly how the faces lie in this unfolding.
 */
const CELLS: readonly { readonly row: string; readonly column: string }[] = Array.from(
  { length: 54 },
  (_, i) => {
    const [row, column] = FACE_ORIGIN[FACE_ORDER[Math.floor(i / 9)]];
    const k = i % 9;
    return { row: String(row + Math.floor(k / 3) + 1), column: String(column + (k % 3) + 1) };
  },
);

/**
 * A cube state as a 2D net of its 54 stickers in the standard colours (U white, R red, F green,
 * D yellow, L orange, B blue). It draws what it is given; `data-facelets` carries the string.
 */
@Component({
  selector: 'app-cube-net',
  template: `
    <div
      class="net"
      role="img"
      aria-label="The cube unfolded: U on top, then L, F, R and B, and D at the bottom"
      data-testid="cube-net"
      [attr.data-facelets]="facelets()"
    >
      @for (cell of cells; track $index) {
        <span
          class="sticker"
          [style.grid-row]="cell.row"
          [style.grid-column]="cell.column"
          [attr.data-colour]="facelets().charAt($index)"
        ></span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      max-width: 18rem;
    }

    .net {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      grid-template-rows: repeat(9, minmax(0, 1fr));
      gap: 2px;
      aspect-ratio: 12 / 9;
    }

    .sticker {
      border-radius: 2px;
      background: var(--surface-raised);
    }

    [data-colour='U'] {
      background: #f5f5f5;
    }

    [data-colour='R'] {
      background: #e53935;
    }

    [data-colour='F'] {
      background: #43a047;
    }

    [data-colour='D'] {
      background: #fdd835;
    }

    [data-colour='L'] {
      background: #fb8c00;
    }

    [data-colour='B'] {
      background: #1e88e5;
    }
  `,
})
export class CubeNet {
  /** A 54-character Kociemba facelet string. */
  readonly facelets = input.required<Facelets>();
  protected readonly cells = CELLS;
}
