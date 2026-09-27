import { TestBed } from '@angular/core/testing';
import { convertToParamMap } from '@angular/router';
import { formatMove, parseMove } from '@cubetrace/core';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeFetch } from '../device/fake-browser';
import { DEMO_FILE } from './cube-testing';
import {
  DEMO_SOLVES_URL,
  DemoSolves,
  chooseDemo,
  demoRequestFrom,
  parseDemoIndex,
  parseDemoSolves,
  parseDemoSpeed,
  scrambleSchedule,
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

  it('reads ?demo and ?speed from the query, and nothing without ?demo', () => {
    expect(demoRequestFrom(convertToParamMap({ demo: '3', speed: '20' }))).toEqual({
      demo: '3',
      speed: '20',
    });
    expect(demoRequestFrom(convertToParamMap({ demo: '' }))).toEqual({ demo: '', speed: null });
    expect(demoRequestFrom(convertToParamMap({ speed: '20' }))).toBeNull();
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
  it('turns the scramble at one move per 100 ms', () => {
    const [solve] = parseDemoSolves({
      solves: [{ ...DEMO_FILE.solves[0], scramble: "R U2 F'" }],
    });

    expect(scrambleSchedule(solve).map((x) => [formatMove(x.m), x.ms])).toEqual([
      ['R', 0],
      ['U2', 100],
      ["F'", 200],
    ]);
  });
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
