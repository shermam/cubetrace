import { TestBed } from '@angular/core/testing';

import { ready, setup, turn } from '../session/session-harness';
import { TWISTY_LOADER } from './scramble-view';
import { ScrambleView } from './scramble-view';

describe('ScrambleView', () => {
  const noPicture = { provide: TWISTY_LOADER, useValue: () => Promise.resolve() };

  function query(element: HTMLElement, testId: string): HTMLElement | null {
    return element.querySelector(`[data-testid="${testId}"]`);
  }

  it('shows the next scramble, with its picture, before a cube is connected', async () => {
    const s = setup({ providers: [noPicture] });
    await s.service.whenReady();
    s.service.prepare();
    const fixture = TestBed.createComponent(ScrambleView);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('h2')?.textContent).toBe('Next scramble');
    expect(query(element, 'scramble')?.textContent).toBe('R U F');
    const picture = query(element, 'scramble-picture');
    expect(picture?.tagName).toBe('TWISTY-PLAYER');
    expect(picture?.getAttribute('experimental-setup-alg')).toBe('R U F');
    expect(picture?.getAttribute('visualization')).toBe('2D');
    expect(picture?.getAttribute('control-panel')).toBe('none');
    expect(query(element, 'scramble-progress')).toBeNull();
  });

  it('follows the scramble: k / n, then the undo moves, greyed out as they are made', async () => {
    const s = setup({ providers: [noPicture] });
    const fake = await ready(s);
    const fixture = TestBed.createComponent(ScrambleView);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const undo = (): string[][] =>
      Array.from(element.querySelectorAll('[data-testid="undo"] li'), (li) => [
        li.textContent,
        li.classList.contains('done') ? 'done' : '',
      ]);

    expect(element.querySelector('h2')?.textContent).toBe('Scramble');
    expect(query(element, 'scramble-progress')?.textContent.trim()).toBe('0 / 3');
    turn(s, fake, 'R');
    await fixture.whenStable();
    expect(query(element, 'scramble-progress')?.textContent.trim()).toBe('1 / 3');

    turn(s, fake, 'D B');
    await fixture.whenStable();
    expect(undo()).toEqual([
      ["B'", ''],
      ["D'", ''],
    ]);
    turn(s, fake, "B'");
    await fixture.whenStable();
    expect(undo()).toEqual([
      ["B'", 'done'],
      ["D'", ''],
    ]);
    turn(s, fake, "D'");
    await fixture.whenStable();
    expect(query(element, 'undo')).toBeNull();
    expect(query(element, 'scramble-progress')?.textContent.trim()).toBe('1 / 3');
  });

  it('keeps the text when the picture cannot load', async () => {
    const s = setup({
      providers: [{ provide: TWISTY_LOADER, useValue: () => Promise.reject(new Error('offline')) }],
    });
    await s.service.whenReady();
    s.service.prepare();
    const fixture = TestBed.createComponent(ScrambleView);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(query(element, 'scramble')?.textContent).toBe('R U F');
    expect(query(element, 'scramble-picture')).toBeNull();
  });
});
