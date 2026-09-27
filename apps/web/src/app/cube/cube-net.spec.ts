import { TestBed } from '@angular/core/testing';
import { SOLVED, applyMoves, parseMoves } from '@cubetrace/core';

import { CubeNet } from './cube-net';

describe('CubeNet', () => {
  async function render(facelets: string): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(CubeNet);
    fixture.componentRef.setInput('facelets', facelets);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  /** The colour letter at a cell of the 12 × 9 grid (1-based, as CSS grid lines). */
  function colourAt(net: HTMLElement, row: number, column: number): string | undefined {
    const sticker = Array.from(net.querySelectorAll<HTMLElement>('.sticker')).find(
      (s) =>
        s.style.gridRow.startsWith(String(row)) && s.style.gridColumn.startsWith(String(column)),
    );
    return sticker?.dataset['colour'];
  }

  it('draws the 54 stickers of a solved cube, one colour per face', async () => {
    const net = await render(SOLVED);

    expect(net.querySelectorAll('.sticker')).toHaveLength(54);
    expect(net.querySelector('[data-testid="cube-net"]')?.getAttribute('data-facelets')).toBe(
      SOLVED,
    );
    // U above F, then L F R B, then D: the centre of each face.
    expect(colourAt(net, 2, 5)).toBe('U');
    expect(colourAt(net, 5, 2)).toBe('L');
    expect(colourAt(net, 5, 5)).toBe('F');
    expect(colourAt(net, 5, 8)).toBe('R');
    expect(colourAt(net, 5, 11)).toBe('B');
    expect(colourAt(net, 8, 5)).toBe('D');
  });

  it('shows an R turn where the faces touch in the net', async () => {
    const net = await render(applyMoves(SOLVED, parseMoves('R')));

    // U's right column shows F's colour, F's shows D's, D's shows B's, and B's left column
    // (next to R in the net) shows U's.
    for (const row of [1, 2, 3]) {
      expect(colourAt(net, row, 6)).toBe('F');
      expect(colourAt(net, row, 4)).toBe('U');
    }
    for (const row of [4, 5, 6]) {
      expect(colourAt(net, row, 6)).toBe('D');
      expect(colourAt(net, row, 10)).toBe('U');
      expect(colourAt(net, row, 12)).toBe('B');
    }
    for (const row of [7, 8, 9]) {
      expect(colourAt(net, row, 6)).toBe('B');
    }
  });
});
