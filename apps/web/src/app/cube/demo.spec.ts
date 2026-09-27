import { TestBed } from '@angular/core/testing';
import { convertToParamMap } from '@angular/router';
import { ScrambleTracker, formatMove, inverse, parseMove, parseMoves } from '@cubetrace/core';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeFetch } from '../device/fake-browser';
import { DEMO_FILE, demoSolve } from './cube-testing';
import {
  DEMO_HALF_TURN_GAP_MS,
  DEMO_MISSCRAMBLE_PAUSE_MS,
  DEMO_SOLVES_URL,
  DemoSolves,
  chooseDemo,
  demoParts,
  demoRequestFrom,
  misscrambleMove,
  parseDemoIndex,
  parseDemoMisscramble,
  parseDemoSolves,
  parseDemoSpeed,
  scrambleSchedule,
  type DemoPart,
} from './demo';

describe('demo query parameters', () => {
  it.each([
    ['0', 0],
    ['29', 29],
    [' 7 ', 7],
    ['007', 7],
    ['30', null],
    ['-1', null],
    ['1.5', null],
    ['1e1', null],
    ['abc', null],
    ['', null],
    [null, null],
  ])('?demo=%s of 30 solves is %s', (text, index) => {
    expect(parseDemoIndex(text, 30)).toBe(index);
  });

  it.each([
    ['20', 20],
    ['0.5', 0.5],
    ['100', 100],
    ['0.1', 0.1],
    ['0', null],
    ['0.05', null],
    ['-3', null],
    ['101', null],
    ['fast', null],
    ['Infinity', null],
    ['', null],
    [null, null],
  ])('?speed=%s is %s', (text, speed) => {
    expect(parseDemoSpeed(text)).toBe(speed);
  });

  it.each([
    ['5', 5],
    [' 5 ', 5],
    ['1', 1],
    ['007', 7],
    ['0', null],
    ['-1', null],
    ['1.5', null],
    ['five', null],
    ['', null],
    [null, null],
  ])('?misscramble=%s is %s', (text, after) => {
    expect(parseDemoMisscramble(text)).toBe(after);
  });

  it('reads ?demo, ?speed and ?misscramble from the query, and nothing without ?demo', () => {
    expect(demoRequestFrom(convertToParamMap({ demo: '3', speed: '20' }))).toEqual({
      demo: '3',
      speed: '20',
      misscramble: null,
    });
    expect(demoRequestFrom(convertToParamMap({ demo: '3', misscramble: '5' }))).toEqual({
      demo: '3',
      speed: null,
      misscramble: '5',
    });
    expect(demoRequestFrom(convertToParamMap({ demo: '' }))).toEqual({
      demo: '',
      speed: null,
      misscramble: null,
    });
    expect(demoRequestFrom(convertToParamMap({ speed: '20', misscramble: '5' }))).toBeNull();
    expect(demoRequestFrom(convertToParamMap({}))).toBeNull();
  });

  it('plays the requested solve at the requested speed when both are valid', () => {
    expect(chooseDemo({ demo: '3', speed: '20' }, 30, 4, () => 0.5)).toEqual({
      index: 3,
      speed: 20,
    });
  });

  it('falls back to a random solve and the speed from Settings', () => {
    expect(chooseDemo({ demo: null, speed: null }, 30, 4, () => 0.5)).toEqual({
      index: 15,
      speed: 4,
    });
    expect(chooseDemo({ demo: '31', speed: 'fast' }, 30, 2, () => 0.999)).toEqual({
      index: 29,
      speed: 2,
    });
    expect(chooseDemo({ demo: 'x', speed: '0' }, 30, 1, () => 0).index).toBe(0);
  });

  it('uses speed 1 when the Settings speed is not valid either, and needs solves', () => {
    expect(chooseDemo({ demo: '0', speed: null }, 30, 0, () => 0).speed).toBe(1);
    expect(() => chooseDemo({ demo: '0', speed: null }, 0, 1)).toThrow(RangeError);
  });
});

describe('parseDemoSolves', () => {
  function withSolve(change: Record<string, unknown>): unknown {
    return { solves: [{ ...DEMO_FILE.solves[0], ...change }] };
  }

  it('reads the demo file', () => {
    const solves = parseDemoSolves(DEMO_FILE);

    expect(solves).toHaveLength(3);
    expect(solves[1]).toEqual({
      index: 1,
      scramble: "F2 D'",
      scrambledFacelets: expect.stringMatching(/^[URFDLB]{54}$/) as unknown,
      moves: [
        { m: parseMove('D'), ms: 0 },
        { m: parseMove('F'), ms: 90 },
        { m: parseMove('F'), ms: 95 },
      ],
      timeMs: 95,
    });
  });

  it.each([
    ['no solves', { solves: [] }, /no "solves"/],
    ['not an object', 'solves', /no "solves"/],
    [
      'a scramble with a wide move',
      withSolve({ scramble: 'Rw U' }),
      /Demo solve 0: Invalid move "Rw"/,
    ],
    ['bad facelets', withSolve({ scrambled_facelets: 'UUU' }), /Demo solve 0: Invalid facelets/],
    ['a move without time', withSolve({ moves: [{ m: 'R' }] }), /move 0 has no time/],
    ['a move that is not one', withSolve({ moves: [{ m: 'x', ms: 0 }] }), /Invalid move "x"/],
    [
      'moves out of order',
      withSolve({
        moves: [
          { m: 'R', ms: 10 },
          { m: 'U', ms: 5 },
        ],
      }),
      /move 1 comes before move 0/,
    ],
    ['no time', withSolve({ time_ms: '1 s' }), /"time_ms" is not a duration/],
  ])('refuses a file with %s', (_what, json, message) => {
    expect(() => parseDemoSolves(json)).toThrow(message);
  });
});

describe('scrambleSchedule', () => {
  it('turns the scramble at one move per 100 ms, a half turn as two quarter turns 60 ms apart', () => {
    const [solve] = parseDemoSolves({
      solves: [{ ...DEMO_FILE.solves[0], scramble: "R U2 F' D2" }],
    });

    expect(DEMO_HALF_TURN_GAP_MS).toBe(60);
    expect(scrambleSchedule(solve).map((x) => [formatMove(x.m), x.ms])).toEqual([
      ['R', 0],
      ['U', 100],
      ['U', 160],
      ["F'", 200],
      ['D', 300],
      ['D', 360],
    ]);
  });
});

describe('misscrambleMove', () => {
  function wrongTurn(scramble: string, after: number): string {
    return formatMove(misscrambleMove(parseMoves(scramble), after));
  }

  it('turns the first face, in the order U R F D L B, off the axes of the moves around it', () => {
    // Moves 5 and 6 turn L and B: U is the first face of the free axis.
    expect(wrongTurn("R U F D' L2 B R'", 5)).toBe('U');
    expect(wrongTurn('U R F', 1)).toBe('F');
    expect(wrongTurn('D F', 1)).toBe('R');
    // Moves of opposite faces side by side take one axis only.
    expect(wrongTurn('R L U', 1)).toBe('U');
    expect(wrongTurn('U D2 R', 1)).toBe('R');
    expect(wrongTurn("F B' U", 1)).toBe('U');
  });

  it.each([0, 3, 4, 1.5, -1])('needs a move before and after it: not %s of 3 moves', (after) => {
    expect(() => misscrambleMove(parseMoves('R U F'), after)).toThrow(RangeError);
  });

  // Scrambles of the fixtures, with half turns and moves of opposite faces side by side.
  it.each([
    "F2 U2 R B2 D' L B' L' B U2 L2 F2 U F2 U R2 D2 B2 U' L2 D'",
    "U' F L' D2 F R' D' F2 B2 R' B2 R2 U' L2 D' R2 U2 R2 L2 U' R2 U'",
    "R2 U L' U' R L B R F L2 U L2 U2 L2 B2 R2 B2 D L2 D' B2",
    "D' B U' L' U D2 F' B' D2 R D B2 L2 U2 L2 U L2 B2 U' R2 U' L2",
  ])('takes the cube off the path of %s after any move, and its undo costs 2', (scramble) => {
    const moves = parseMoves(scramble);
    for (let after = 1; after < moves.length; after++) {
      const tracker = new ScrambleTracker(scramble);
      for (const m of moves.slice(0, after)) {
        tracker.onMove(m);
      }
      const wrong = misscrambleMove(moves, after);
      expect(wrong.turns).toBe(1);
      expect(tracker.onMove(wrong)).toMatchObject({
        matched: after,
        diverged: true,
        undo: [inverse(wrong)],
      });
      expect(tracker.onMove(inverse(wrong))).toMatchObject({ matched: after, diverged: false });
      for (const m of moves.slice(after)) {
        tracker.onMove(m);
      }
      expect(tracker.progress).toMatchObject({ done: true, extraMoves: 2 });
    }
  });
});

describe('demoParts', () => {
  const [solve] = parseDemoSolves({
    solves: [
      demoSolve("R U F D'", [
        ['D', 0],
        ["F'", 120],
        ["U'", 300],
        ["R'", 450],
      ]),
    ],
  });

  function written(parts: readonly DemoPart[]): { pauseMs: number; moves: string[] }[] {
    return parts.map((part) => ({
      pauseMs: part.pauseMs,
      moves: part.moves.map((x) => `${formatMove(x.m)} @${String(x.ms)}`),
    }));
  }

  const SOLUTION = { pauseMs: 0, moves: ['D @0', "F' @120", "U' @300", "R' @450"] };

  it('plays the scramble one move per 100 ms, then the solution on its own timings', () => {
    expect(written(demoParts(solve))).toEqual([
      { pauseMs: 0, moves: ['R @0', 'U @100', 'F @200', "D' @300"] },
      SOLUTION,
    ]);
  });

  it('with a mis-scramble after move k: the wrong turn, its inverse after a pause, the rest', () => {
    // Moves 2 and 3 turn U and F: the wrong turn is R, which ends the first part.
    expect(written(demoParts(solve, 2))).toEqual([
      { pauseMs: 0, moves: ['R @0', 'U @100', 'R @200'] },
      { pauseMs: DEMO_MISSCRAMBLE_PAUSE_MS, moves: ["R' @0", 'F @100', "D' @200"] },
      SOLUTION,
    ]);
  });

  it.each([0, 4, 9, 1.5, -2])('ignores a mis-scramble after move %s of 4', (after) => {
    expect(demoParts(solve, after)).toEqual(demoParts(solve));
  });

  const [halves] = parseDemoSolves({
    solves: [
      demoSolve('R U2 F D2', [
        ['D2', 0],
        ["F'", 100],
        ['U2', 200],
        ["R'", 300],
      ]),
    ],
  });
  const HALVES_SOLUTION = { pauseMs: 0, moves: ['D2 @0', "F' @100", 'U2 @200', "R' @300"] };

  it('cuts the scramble before the second quarter turn of each half turn, which starts 60 ms after the first', () => {
    expect(written(demoParts(halves))).toEqual([
      { pauseMs: 0, moves: ['R @0', 'U @100'] },
      { pauseMs: 60, moves: ['U @160', 'F @200', 'D @300'] },
      { pauseMs: 60, moves: ['D @360'] },
      HALVES_SOLUTION,
    ]);
  });

  it('with a mis-scramble after a half turn: the same cuts, the wrong turn and its inverse', () => {
    // Moves 2 and 3 turn U and F: the wrong turn is R.
    expect(written(demoParts(halves, 2))).toEqual([
      { pauseMs: 0, moves: ['R @0', 'U @100'] },
      { pauseMs: 60, moves: ['U @160', 'R @200'] },
      { pauseMs: DEMO_MISSCRAMBLE_PAUSE_MS, moves: ["R' @0", 'F @100', 'D @200'] },
      { pauseMs: 60, moves: ['D @260'] },
      HALVES_SOLUTION,
    ]);
  });

  // Scrambles of the fixtures, with half turns and moves of opposite faces side by side.
  it.each([
    "F2 U2 R B2 D' L B' L' B U2 L2 F2 U F2 U R2 D2 B2 U' L2 D'",
    "R2 U L' U' R L B R F L2 U L2 U2 L2 B2 R2 B2 D L2 D' B2",
  ])(
    'ends each part of %s on a half-made turn, the wrong turn or the target, which it reaches',
    (scramble) => {
      const [fixture] = parseDemoSolves({ solves: [demoSolve(scramble, [['R', 0]])] });
      const halfTurns = parseMoves(scramble).flatMap((m, i) => (m.turns === 2 ? [i] : []));
      /** Plays the scramble's parts on a tracker: the partial move after each part (-1: none). */
      const partialAfterEachPart = (misscramble: number | null, extraMoves: number): number[] => {
        const tracker = new ScrambleTracker(scramble);
        const partial = demoParts(fixture, misscramble)
          .slice(0, -1)
          .map((part) => {
            for (const { m } of part.moves) {
              tracker.onMove(m);
            }
            return tracker.progress.moves.indexOf('partial');
          });
        expect(tracker.progress).toMatchObject({ done: true, extraMoves });
        return partial;
      };

      expect(partialAfterEachPart(null, 0)).toEqual([...halfTurns, -1]);
      expect(partialAfterEachPart(5, 2)).toEqual([
        ...halfTurns.filter((i) => i < 5),
        -1,
        ...halfTurns.filter((i) => i >= 5),
        -1,
      ]);
    },
  );
});

describe('DemoSolves', () => {
  function create(globals: BrowserGlobals): DemoSolves {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: globals }],
    });
    return TestBed.inject(DemoSolves);
  }

  it('downloads the demo file once, when first asked', async () => {
    const fetch = new FakeFetch({ [DEMO_SOLVES_URL]: DEMO_FILE });
    const demos = create({ fetch: fetch.fetch });
    expect(fetch.requests).toEqual([]);

    expect(await demos.load()).toHaveLength(3);
    expect(await demos.load()).toHaveLength(3);
    expect(fetch.requests).toEqual([DEMO_SOLVES_URL]);
  });

  it('reports a failed download and tries again next time', async () => {
    const fetch = new FakeFetch({});
    const demos = create({ fetch: fetch.fetch });

    await expect(demos.load()).rejects.toThrow('demo/solves.json answered HTTP 404.');
    fetch.failWith = new TypeError('Failed to fetch');
    await expect(demos.load()).rejects.toThrow('Failed to fetch');
    expect(fetch.requests).toHaveLength(2);
  });

  it('reports a browser without fetch', async () => {
    await expect(create({}).load()).rejects.toThrow('no fetch');
  });
});
