// Demo mode (docs/PLAN.md, T1.6a): the fake cube replays one of the first 30 solves of
// fixtures/solves.json, its scramble first and then its solution, so the app can be seen and
// tested without a cube. The solves are a slim copy of the fixtures that
// scripts/write-demo-solves.mts writes to public/demo/solves.json before every build and dev
// server; the app fetches it only when a demo starts, so it is not in any bundle, and the service
// worker does not prefetch it (ngsw-config.json caches JavaScript, CSS, images and fonts only).
import { Injectable, inject } from '@angular/core';
import { assertFacelets, parseMove, parseMoves, type Facelets } from '@cubetrace/core';
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

/** A demo as the page's address asks for it: the raw `?demo=` and `?speed=` values. */
export interface DemoRequest {
  readonly demo: string | null;
  readonly speed: string | null;
}

/** No preference: a random demo solve at the speed from Settings. */
export const ANY_DEMO: DemoRequest = { demo: null, speed: null };

/** Where the demo solves are served, relative to the app's base URL. */
export const DEMO_SOLVES_URL = 'demo/solves.json';

/** The fixtures do not time the scramble: the demo turns it at one move per 100 ms. */
export const DEMO_SCRAMBLE_GAP_MS = 100;

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

/** The demo that `query` (the page's query parameters) asks for; null without `?demo`. */
export function demoRequestFrom(query: {
  has(name: string): boolean;
  get(name: string): string | null;
}): DemoRequest | null {
  return query.has('demo') ? { demo: query.get('demo'), speed: query.get('speed') } : null;
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
  return parseMoves(solve.scramble).map((m, i) => ({ m, ms: i * DEMO_SCRAMBLE_GAP_MS }));
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
