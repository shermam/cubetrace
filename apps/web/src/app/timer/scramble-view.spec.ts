import { TestBed } from '@angular/core/testing';
import { ScrambleTracker, parseMoves, type AttemptState } from '@cubetrace/core';

import { ready, setup, turn } from '../session/session-harness';
import type { AttemptView } from '../session/session-service';
import { NO_UNDO } from '../session/undo-guide';
import { TWISTY_LOADER, scrambleTokens, type ScrambleTokenState } from './scramble-view';
import { ScrambleView } from './scramble-view';

describe('scrambleTokens', () => {
  /** The attempt view of `scramble` in `state`, after `moves` were made on the cube. */
  function attempt(scramble: string, state: AttemptState, moves = ''): AttemptView {
    const tracker = new ScrambleTracker(scramble);
    for (const m of parseMoves(moves)) {
      tracker.onMove(m);
    }
    return {
      index: 1,
      scramble,
      state,
      progress: tracker.progress,
      events: {
        scrambleShown: 0,
        scrambleStart: null,
        scrambleDone: null,
        pickup: null,
        solveStart: null,
        solveEnd: null,
      },
      undo: NO_UNDO,
    };
  }

  function states(scramble: string, view: AttemptView | null): ScrambleTokenState[] {
    const tokens = scrambleTokens(scramble, view);
    expect(tokens.map((token) => token.move).join(' ')).toBe(scramble);
    return tokens.map((token) => token.state);
  }

  it('while scrambling: done, partial (a half turn made halfway) and pending, from the progress', () => {
    expect(states("R U2 F'", attempt("R U2 F'", 'scrambling'))).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(states("R U2 F'", attempt("R U2 F'", 'scrambling', 'R U'))).toEqual([
      'done',
      'partial',
      'pending',
    ]);
    expect(states("R U2 F'", attempt("R U2 F'", 'scrambling', "R U' U'"))).toEqual([
      'done',
      'done',
      'pending',
    ]);
    // A move on the opposite face made first is done before the one ahead of it.
    expect(states("R U D' F", attempt("R U D' F", 'scrambling', "R D'"))).toEqual([
      'done',
      'pending',
      'done',
      'pending',
    ]);
  });

  it('off the scramble: the move where the cube left it is wrong, the rest pending', () => {
    expect(states("R U2 F'", attempt("R U2 F'", 'scrambling', 'R U L'))).toEqual([
      'done',
      'wrong',
      'pending',
    ]);
    expect(states("R U D' F", attempt("R U D' F", 'scrambling', "R D' B"))).toEqual([
      'done',
      'wrong',
      'pending',
      'pending',
    ]);
    // Back on the path: as before the detour.
    expect(states("R U2 F'", attempt("R U2 F'", 'scrambling', "R U L L'"))).toEqual([
      'done',
      'partial',
      'pending',
    ]);
  });

  it('armed: every move done; solving, over, or another scramble: no marks', () => {
    expect(states("R U2 F'", attempt("R U2 F'", 'armed', "R U2 F'"))).toEqual([
      'done',
      'done',
      'done',
    ]);
    for (const state of ['solving', 'solved', 'dnf'] as const) {
      expect(states("R U2 F'", attempt("R U2 F'", state, "R U2 F'")), state).toEqual([
        'pending',
        'pending',
        'pending',
      ]);
    }
    // The next scramble, before its attempt begins.
    expect(states('B D L', null)).toEqual(['pending', 'pending', 'pending']);
    expect(states('B D L', attempt("R U2 F'", 'solved', "R U2 F'"))).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });
});

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

  it('marks each move as the cube makes it, all done once armed, none during the solve', async () => {
    const s = setup({ providers: [noPicture], scrambles: ["L2 D B'", 'R U F'] });
    const fake = await ready(s);
    const fixture = TestBed.createComponent(ScrambleView);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = (): string | undefined => query(element, 'scramble')?.textContent;
    const marks = async (): Promise<string[]> => {
      await fixture.whenStable();
      expect(text()).toBe(s.service.scramble());
      return Array.from(
        element.querySelectorAll('[data-testid="scramble"] .move'),
        (move) => `${move.textContent} ${move.getAttribute('data-state') ?? ''}`,
      );
    };

    expect(text()).toBe("L2 D B'");
    expect(await marks()).toEqual(['L2 pending', 'D pending', "B' pending"]);
    turn(s, fake, 'L');
    expect(await marks()).toEqual(['L2 partial', 'D pending', "B' pending"]);
    turn(s, fake, 'L');
    expect(await marks()).toEqual(['L2 done', 'D pending', "B' pending"]);
    // A wrong turn: red where the cube left the scramble, with the undo guidance as it was.
    turn(s, fake, 'F');
    expect(await marks()).toEqual(['L2 done', 'D wrong', "B' pending"]);
    expect(query(element, 'undo')?.textContent).toContain("F'");
    turn(s, fake, "F'");
    expect(await marks()).toEqual(['L2 done', 'D pending', "B' pending"]);
    expect(query(element, 'undo')).toBeNull();
    // The scramble complete: armed, all done, until the solve's first turn.
    turn(s, fake, "D B'");
    expect(s.service.attempt()?.state).toBe('armed');
    expect(await marks()).toEqual(['L2 done', 'D done', "B' done"]);
    turn(s, fake, 'B');
    expect(s.service.attempt()?.state).toBe('solving');
    expect(await marks()).toEqual(['L2 pending', 'D pending', "B' pending"]);
    // The solve, B D' L2: then the next scramble, unmarked.
    turn(s, fake, "D' L2");
    await fixture.whenStable();
    expect(text()).toBe('R U F');
    expect(await marks()).toEqual(['R pending', 'U pending', 'F pending']);
  });

  it("over the camera's picture: no picture of the cube, the heading, progress and undo as before", async () => {
    const s = setup({ providers: [noPicture] });
    const fake = await ready(s);
    const fixture = TestBed.createComponent(ScrambleView);
    fixture.componentRef.setInput('overPicture', true);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.classList).toContain('over-picture');
    expect(query(element, 'scramble-picture')).toBeNull();
    expect(element.querySelector('h2')?.textContent).toBe('Scramble');
    expect(query(element, 'scramble')?.textContent).toBe('R U F');
    expect(query(element, 'scramble-progress')?.textContent.trim()).toBe('0 / 3');
    turn(s, fake, 'R D');
    await fixture.whenStable();
    expect(query(element, 'scramble-progress')?.textContent.trim()).toBe('1 / 3');
    expect(query(element, 'undo')?.textContent).toContain("D'");
    expect(
      Array.from(element.querySelectorAll('.move'), (move) => move.getAttribute('data-state')),
    ).toEqual(['done', 'wrong', 'pending']);

    // Back in the page's column (a wider window, or the setting off): the picture again.
    fixture.componentRef.setInput('overPicture', false);
    await fixture.whenStable();
    expect(element.classList).not.toContain('over-picture');
    expect(query(element, 'scramble-picture')?.tagName).toBe('TWISTY-PLAYER');
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
