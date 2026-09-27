// Demo mode (docs/PLAN.md, T1.6a): the fake cube replays one of the first 30 solves of
// fixtures/solves.json, its scramble first and then its solution, so the app can be seen and
// tested without a cube; `?misscramble=` adds a wrong turn and its undo to the scramble (T1.9, for
// the end-to-end suite and to try the undo guidance). The solves are a slim copy of the fixtures that
// scripts/write-demo-solves.mts writes to public/demo/solves.json before every build and dev
// server; the app fetches it only when a demo starts, so it is not in any bundle, and the service
// worker does not prefetch it (ngsw-config.json caches JavaScript, CSS, images and fonts only).
import { Injectable, inject } from '@angular/core';
import {
  FACE_ORDER,
  assertFacelets,
  inverse,
  opposite,
  parseMove,
  parseMoves,
  type Face,
  type Facelets,
  type Move,
} from '@cubetrace/core';
import type { ScheduledMove } from '@cubetrace/gan';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { errorMessage } from '../shared/error-message';

/** A recorded solve that the demo cube replays. */
export interface DemoSolve {
  /** Its position in the demo file, 0 to 29: the value of `?demo=`. */
  readonly index: number;
  /** The WCA scramble, from a solved cube. */
  readonly scramble: string;
  /** The state the scramble leads to. */
  readonly scrambledFacelets: Facelets;
  /** The solution as the cube reported it, on the cube's clock (ms from its first move). */
  readonly moves: readonly ScheduledMove[];
  /** The solve's time as recorded, in ms. */
  readonly timeMs: number;
}

/**
 * A demo as the page's address asks for it: the raw values of `?demo=`, `?speed=` and
 * `?misscramble=`.
 */
export interface DemoRequest {
  readonly demo: string | null;
  readonly speed: string | null;
  /** The scramble move after which the demo cube goes wrong once; absent or null: it does not. */
  readonly misscramble?: string | null;
}

/** No preference: a random demo solve at the speed from Settings. */
export const ANY_DEMO: DemoRequest = { demo: null, speed: null };

/** Where the demo solves are served, relative to the app's base URL. */
export const DEMO_SOLVES_URL = 'demo/solves.json';

/** The fixtures do not time the scramble: the demo turns it at one move per 100 ms. */
export const DEMO_SCRAMBLE_GAP_MS = 100;

/**
 * How long a mis-scramble's wrong turn stays before the demo cube undoes it, in ms of the replay's
 * own clock (divided by the speed, like every gap): the time a solver takes to read the undo
 * guidance.
 */
export const DEMO_MISSCRAMBLE_PAUSE_MS = 1000;

/** Replay speeds: 1 is real time; the fake cube divides every gap between moves by it. */
export const DEMO_SPEED_DEFAULT = 1;
export const DEMO_SPEED_MIN = 0.1;
export const DEMO_SPEED_MAX = 100;

/** Whether `speed` is a replay speed the demo accepts. */
export function isDemoSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= DEMO_SPEED_MIN && speed <= DEMO_SPEED_MAX;
}

/** `?speed=`: a number from 0.1 to 100; null when it is missing or anything else. */
export function parseDemoSpeed(text: string | null): number | null {
  if (text === null || text.trim() === '') {
    return null;
  }
  const speed = Number(text);
  return isDemoSpeed(speed) ? speed : null;
}

/** `?demo=`: a whole number below `count`; null when it is missing or anything else. */
export function parseDemoIndex(text: string | null, count: number): number | null {
  if (text === null || !/^\s*\d+\s*$/.test(text)) {
    return null;
  }
  const index = Number(text);
  return index < count ? index : null;
}

/**
 * `?misscramble=`: the scramble move (1-based) after which the demo cube makes a wrong turn, a whole
 * number from 1; null when it is missing or anything else. {@link demoParts} ignores a move that the
 * scramble does not have, or its last one (a wrong turn there would start the solve).
 */
export function parseDemoMisscramble(text: string | null): number | null {
  if (text === null || !/^\s*\d+\s*$/.test(text)) {
    return null;
  }
  const after = Number(text);
  return after >= 1 ? after : null;
}

/** The demo that `query` (the page's query parameters) asks for; null without `?demo`. */
export function demoRequestFrom(query: {
  has(name: string): boolean;
  get(name: string): string | null;
}): DemoRequest | null {
  return query.has('demo')
    ? { demo: query.get('demo'), speed: query.get('speed'), misscramble: query.get('misscramble') }
    : null;
}

/**
 * Which of `count` demo solves to play, and how fast: the requested solve and speed when they are
 * valid; otherwise a random solve (`random` returns a number in [0, 1), as `Math.random`) and
 * `fallbackSpeed` (the Settings value), or 1 if that is not a valid speed either.
 */
export function chooseDemo(
  request: DemoRequest,
  count: number,
  fallbackSpeed: number,
  random: () => number = Math.random,
): { index: number; speed: number } {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('There are no demo solves to choose from.');
  }
  const index =
    parseDemoIndex(request.demo, count) ??
    Math.min(count - 1, Math.max(0, Math.floor(random() * count)));
  const speed =
    parseDemoSpeed(request.speed) ??
    (isDemoSpeed(fallbackSpeed) ? fallbackSpeed : DEMO_SPEED_DEFAULT);
  return { index, speed };
}

/** The scramble as timed moves for `FakeCube.play()`, one per 100 ms. */
export function scrambleSchedule(solve: DemoSolve): ScheduledMove[] {
  return timed(parseMoves(solve.scramble));
}

/** `moves` one per 100 ms, from 0. */
function timed(moves: readonly Move[]): ScheduledMove[] {
  return moves.map((m, i) => ({ m, ms: i * DEMO_SCRAMBLE_GAP_MS }));
}

/**
 * The wrong turn of a mis-scramble after move `after` (1-based) of `scramble`: a clockwise quarter
 * turn of the first face, in the order U R F D L B, that neither move `after` nor move `after + 1`
 * turns, nor the face opposite to either. So it cannot pass for a step along the scramble (half of
 * a half turn, or the next move of an opposite pair made first): the cube is off the scramble's path
 * until the turn is undone, and one quarter turn undone costs 2 extra moves (docs/DATA-MODEL.md §3).
 * Throws unless `after` is from 1 to one less than the number of moves.
 */
export function misscrambleMove(scramble: readonly Move[], after: number): Move {
  if (!Number.isInteger(after) || after < 1 || after >= scramble.length) {
    throw new RangeError(
      `A wrong turn after move ${String(after)} of a ${String(scramble.length)}-move scramble ` +
        'needs a move before it and one after it.',
    );
  }
  const neighbours = [scramble[after - 1].face, scramble[after].face];
  const taken = new Set<Face>([...neighbours, ...neighbours.map(opposite)]);
  // Two moves turn faces of at most two axes: a face of the third one is always free.
  const face = FACE_ORDER.find((f) => !taken.has(f)) ?? 'U';
  return { face, turns: 1 };
}

/**
 * One part of a demo replay: moves for one `FakeCube.play()`, started `pauseMs` after the previous
 * part has ended (in ms of the replay's own clock, divided by the speed like every gap).
 */
export interface DemoPart {
  readonly pauseMs: number;
  readonly moves: readonly ScheduledMove[];
}

/**
 * What the demo cube plays, part after part: the scramble at one move per 100 ms
 * ({@link scrambleSchedule}), then the solution on its recorded timings. With `misscramble` k, the
 * scramble goes wrong after its move k: 100 ms later the cube makes {@link misscrambleMove}, and
 * {@link DEMO_MISSCRAMBLE_PAUSE_MS} after that its inverse, then the rest of the scramble. k must be
 * from 1 to one less than the number of scramble moves; any other value is ignored.
 *
 * The wrong turn ends a part, and its inverse starts the next one on a timer set once the wrong
 * turn has been emitted: after the app took it in and scheduled the page's update (Angular schedules
 * change detection on a zero-delay timer, or the next animation frame, when a signal changes). So
 * the page shows the undo guidance before the inverse arrives, however fast the replay and however
 * late its timers fire. The end-to-end suite relies on it, and on the same order for the armed
 * attempt, which the solution, a part of its own, follows.
 */
export function demoParts(solve: DemoSolve, misscramble: number | null = null): DemoPart[] {
  const scramble = parseMoves(solve.scramble);
  const solution: DemoPart = { pauseMs: 0, moves: solve.moves };
  if (
    misscramble === null ||
    !Number.isInteger(misscramble) ||
    misscramble < 1 ||
    misscramble >= scramble.length
  ) {
    return [{ pauseMs: 0, moves: timed(scramble) }, solution];
  }
  const wrong = misscrambleMove(scramble, misscramble);
  return [
    { pauseMs: 0, moves: timed([...scramble.slice(0, misscramble), wrong]) },
    {
      pauseMs: DEMO_MISSCRAMBLE_PAUSE_MS,
      moves: timed([inverse(wrong), ...scramble.slice(misscramble)]),
    },
    solution,
  ];
}

/**
 * Reads the demo file (`{ "solves": [{ scramble, scrambled_facelets, moves: [{ m, ms }],
 * time_ms }] }`, as scripts/write-demo-solves.mts writes it). Throws, naming the solve, on
 * anything the fake cube could not replay.
 */
export function parseDemoSolves(json: unknown): DemoSolve[] {
  const solves = member(json, 'solves');
  if (!Array.isArray(solves) || solves.length === 0) {
    throw new Error('The demo file has no "solves".');
  }
  return solves.map((raw: unknown, index) => {
    try {
      return parseDemoSolve(raw, index);
    } catch (error: unknown) {
      throw new Error(`Demo solve ${String(index)}: ${errorMessage(error)}`, { cause: error });
    }
  });
}

function parseDemoSolve(raw: unknown, index: number): DemoSolve {
  const scramble = text(member(raw, 'scramble'), 'scramble');
  parseMoves(scramble);
  const scrambledFacelets = text(member(raw, 'scrambled_facelets'), 'scrambled_facelets');
  assertFacelets(scrambledFacelets);
  const timeMs = member(raw, 'time_ms');
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs < 0) {
    throw new Error('"time_ms" is not a duration.');
  }
  const rawMoves = member(raw, 'moves');
  if (!Array.isArray(rawMoves) || rawMoves.length === 0) {
    throw new Error('"moves" is not a list of moves.');
  }
  const moves = rawMoves.map((move: unknown, i): ScheduledMove => {
    const ms = member(move, 'ms');
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      throw new Error(`move ${String(i)} has no time.`);
    }
    return { m: parseMove(text(member(move, 'm'), `move ${String(i)}`)), ms };
  });
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].ms < moves[i - 1].ms) {
      throw new Error(`move ${String(i)} comes before move ${String(i - 1)}.`);
    }
  }
  return { index, scramble, scrambledFacelets, moves, timeMs };
}

function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (Reflect.get(value, key) as unknown) : null;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new Error(`"${what}" is not text.`);
  }
  return value;
}

/**
 * The demo solves, fetched from {@link DEMO_SOLVES_URL} the first time a demo starts and kept
 * for the next ones. A failed download is tried again on the next call.
 */
@Injectable({ providedIn: 'root' })
export class DemoSolves {
  private readonly globals = inject(BROWSER_GLOBALS);
  private loaded: Promise<readonly DemoSolve[]> | null = null;

  load(): Promise<readonly DemoSolve[]> {
    this.loaded ??= this.download().catch((error: unknown) => {
      this.loaded = null;
      throw error;
    });
    return this.loaded;
  }

  private async download(): Promise<readonly DemoSolve[]> {
    if (this.globals.fetch === undefined) {
      throw new Error('this browser cannot download files (no fetch).');
    }
    const response = await this.globals.fetch(DEMO_SOLVES_URL);
    if (!response.ok) {
      throw new Error(`${DEMO_SOLVES_URL} answered HTTP ${String(response.status)}.`);
    }
    const json: unknown = await response.json();
    return parseDemoSolves(json);
  }
}
