// The attempt state machine (docs/PLAN.md T1.4, docs/ARCHITECTURE.md): the cube's moves in, the
// events of docs/DATA-MODEL.md §3 and the record of §7 (attempt.json) out. Pure and synchronous:
// every time comes from the caller, so that recorded solves can be replayed through it.
import type { Facelets } from './cube';
import { SOLVED, applyMove, applyMoves, assertFacelets, isSolved } from './cube';
import type { Face, Move } from './notation';
import { formatMove, formatMoves, parseMoves, quarterTurns } from './notation';
import type { PhaseRecord, TimedMove } from './phases';
import { detectPhases } from './phases';
import type { ScrambleProgress } from './scramble';
import { ScrambleTracker, scrambleTarget } from './scramble';
import { UUID_V4 } from './session';

/**
 * Where an attempt is: following the scramble, armed (the cube is at the scramble's target and the
 * next move starts the solve), solving, or over, solved or DNF.
 */
export type AttemptState = 'scrambling' | 'armed' | 'solving' | 'solved' | 'dnf';

/** A face turn reported by the cube, with both clocks (docs/DATA-MODEL.md §1). */
export interface CubeMoveInput {
  m: Move;
  /** The cube's own clock. */
  cubeMs: number;
  /** The host clock when the move's Bluetooth packet arrived. */
  hostMs: number;
}

export interface AttemptOptions {
  /** The id of the session (a UUID v4). */
  session: string;
  /** The attempt's 1-based position in its session. */
  index: number;
  /** The scramble, in our notation (docs/DATA-MODEL.md §2), as `generateScramble` returns it. */
  scramble: string;
  /** Host time when the scramble was shown: the `scrambleShown` event. */
  scrambleShownMs: number;
  /** Forces the cross face of the phase detector instead of detecting it (docs/DATA-MODEL.md §4). */
  crossFace?: Face;
  /**
   * The cube's state when the attempt begins, which must be solved (default {@link SOLVED}): the
   * scramble is applied to a solved cube.
   */
  start?: Facelets;
}

/** The part of the attempt a move belongs to (docs/DATA-MODEL.md §3). */
export type MovePhase = 'scramble' | 'solve';

/** One entry of `moves` in attempt.json. */
export interface AttemptMove {
  /** The face turn in our notation, such as `U'`. */
  m: string;
  hostMs: number;
  cubeMs: number;
  phase: MovePhase;
}

/** The events of docs/DATA-MODEL.md §3, in host ms; null when they did not happen. */
export interface AttemptEvents {
  scrambleShown: number;
  scrambleStart: number | null;
  scrambleDone: number | null;
  pickup: number | null;
  solveStart: number | null;
  solveEnd: number | null;
}

/** `result` in attempt.json. */
export interface AttemptResult {
  /** `solveEnd − solveStart`; null on a DNF. */
  timeMs: number | null;
  /** `solveStart − (pickup ?? scrambleDone)`; null if the solve did not start. */
  inspectionMs: number | null;
  /** Quarter turns of the solve's moves (a half turn counts two). */
  movesQtm: number;
  /** `movesQtm / (timeMs / 1000)`, rounded to two decimals; null without a time. */
  tps: number | null;
  status: 'solved' | 'dnf';
  /** The solve's moves take `scrambledFacelets` to solved in the simulator. */
  replayOk: boolean;
  /** The cube left the scramble's path at some point of the scramble. */
  scrambleCorrected: boolean;
  /** Quarter turns made during the scramble beyond the scramble's own (`ScrambleProgress.extraMoves`). */
  scrambleExtraMoves: number;
}

/** A phase as attempt.json records it: a {@link PhaseRecord} without its index into the moves. */
export type AttemptPhase = Omit<PhaseRecord, 'endMoveIndex'>;

/** attempt.json, schema version 1 (docs/DATA-MODEL.md §7). */
export interface AttemptRecord {
  schema: 1;
  session: string;
  index: number;
  scramble: string;
  /** The scramble's target, from solved: the state at `scrambleDone`, where the solve starts. */
  scrambledFacelets: Facelets;
  /** The face whose cross completed first; null if none did. */
  crossFace: Face | null;
  events: AttemptEvents;
  /** Every move the cube reported during the attempt, in order, corrections included. */
  moves: AttemptMove[];
  result: AttemptResult;
  /** The phases completed, in order: all eight for a solve the moves replay. */
  phases: AttemptPhase[];
  /** Phase 2: the video segments. Always empty in phase 1. */
  video: [];
}

/**
 * One attempt, from the scramble shown on a solved cube to solved or DNF (docs/DATA-MODEL.md §3):
 * while `scrambling`, every move goes to a {@link ScrambleTracker}; when the cube reaches the
 * scramble's target the attempt is `armed` (`scrambleDone`); the next move is `solveStart` and the
 * attempt is `solving` until the cube is solved (`solveEnd`). Moves after `solved` or `dnf` are
 * ignored: the caller starts the next attempt with a new machine. {@link toRecord} then gives
 * attempt.json, with the phases of the solve (`detectPhases` on the solve's moves in host time).
 */
export class AttemptMachine {
  readonly #session: string;
  readonly #index: number;
  readonly #scramble: string;
  readonly #crossFace: Face | undefined;
  readonly #tracker: ScrambleTracker;
  /** The scramble's target, where the solve starts. */
  readonly #scrambled: Facelets;
  #state: AttemptState = 'scrambling';
  #facelets: Facelets = SOLVED;
  readonly #events: AttemptEvents;
  readonly #moves: AttemptMove[] = [];
  /** The solve's moves, in host time. */
  readonly #solveMoves: TimedMove[] = [];
  #scrambleCorrected = false;
  /** The tracker's `extraMoves` at `scrambleDone`. */
  #scrambleExtraMoves: number | null = null;
  #dnfMs: number | null = null;

  /**
   * Throws if the session is not a UUID v4, the index is not a positive integer, the scramble is
   * not in our notation (a `NotationError`) or leaves the cube solved, or `start` is not solved.
   */
  constructor(opts: AttemptOptions) {
    if (!UUID_V4.test(opts.session)) {
      throw new Error(`The session is a lowercase UUID v4, got "${opts.session}".`);
    }
    if (!Number.isInteger(opts.index) || opts.index < 1) {
      throw new RangeError(`An attempt's index is a positive integer, got ${String(opts.index)}.`);
    }
    const start = opts.start ?? SOLVED;
    assertFacelets(start);
    if (!isSolved(start)) {
      throw new Error('An attempt starts with the cube solved: the scramble is applied to it.');
    }
    this.#session = opts.session;
    this.#index = opts.index;
    this.#scramble = formatMoves(parseMoves(opts.scramble));
    this.#crossFace = opts.crossFace;
    this.#tracker = new ScrambleTracker(this.#scramble);
    this.#scrambled = scrambleTarget(this.#scramble);
    if (isSolved(this.#scrambled)) {
      throw new Error(`The scramble "${this.#scramble}" leaves the cube solved.`);
    }
    this.#events = {
      scrambleShown: opts.scrambleShownMs,
      scrambleStart: null,
      scrambleDone: null,
      pickup: null,
      solveStart: null,
      solveEnd: null,
    };
  }

  get state(): AttemptState {
    return this.#state;
  }

  /** The progress through the scramble; after `scrambleDone`, the progress there. */
  get scrambleProgress(): ScrambleProgress {
    return this.#tracker.progress;
  }

  /** The cube's state as the machine knows it: the start state plus every move seen. */
  get facelets(): Facelets {
    return this.#facelets;
  }

  /** The events so far (a copy), for the caller's timer display. */
  get events(): AttemptEvents {
    return { ...this.#events };
  }

  /** When {@link markDnf} ended the attempt; null otherwise. Not part of attempt.json. */
  get dnfMs(): number | null {
    return this.#dnfMs;
  }

  /** Takes one move of the cube and returns the state after it. */
  onMove(input: CubeMoveInput): AttemptState {
    const move: TimedMove = { m: { face: input.m.face, turns: input.m.turns }, ms: input.hostMs };
    switch (this.#state) {
      case 'scrambling': {
        this.#events.scrambleStart ??= input.hostMs;
        this.#record(input, 'scramble');
        const progress = this.#tracker.onMove(move.m);
        this.#facelets = this.#tracker.state;
        this.#afterScramble(progress, input.hostMs);
        break;
      }
      case 'armed':
        // The first move after scrambleDone starts the solve (docs/DATA-MODEL.md §3).
        this.#events.solveStart = input.hostMs;
        this.#state = 'solving';
        this.#solveMove(input, move);
        break;
      case 'solving':
        this.#solveMove(input, move);
        break;
      case 'solved':
      case 'dnf':
        break;
    }
    return this.#state;
  }

  /**
   * A pickup of the cube (from its gyroscope), while `armed`: inspection is then measured from it
   * instead of from `scrambleDone`. The first one counts; calls in any other state are ignored.
   */
  onPickup(hostMs: number): void {
    if (this.#state === 'armed') {
      this.#events.pickup ??= hostMs;
    }
  }

  /**
   * Compares the state the cube reports with the state the machine knows (a desync check). On a
   * mismatch the caller decides; {@link resync} adopts the reported state.
   */
  onFacelets(reported: Facelets): { consistent: boolean } {
    return { consistent: reported === this.#facelets };
  }

  /**
   * Adopts the state the cube reports, after moves went unseen. While scrambling, the tracker
   * continues from it (`ScrambleTracker.setState`), and the attempt is armed if it is the target.
   * While armed, a state other than the target means the solve started unseen: the attempt is then
   * solving. While solving, the attempt is solved if the state is. The unseen moves are not
   * recorded, so a solve that went through a resync does not replay (`replayOk` false).
   *
   * @param hostMs when the cube reported the state, used as the time of an event the adopted state
   *   completes (`scrambleDone`, `solveStart`, `solveEnd`); by default the last move's time.
   */
  resync(reported: Facelets, hostMs?: number): void {
    assertFacelets(reported);
    if (reported === this.#facelets) {
      return;
    }
    const at = hostMs ?? this.#moves.at(-1)?.hostMs ?? this.#events.scrambleShown;
    switch (this.#state) {
      case 'scrambling': {
        const progress = this.#tracker.setState(reported);
        this.#facelets = reported;
        this.#afterScramble(progress, at);
        break;
      }
      case 'armed':
        this.#events.solveStart = at;
        this.#state = 'solving';
        this.#adoptWhileSolving(reported, at);
        break;
      case 'solving':
        this.#adoptWhileSolving(reported, at);
        break;
      case 'solved':
      case 'dnf':
        break;
    }
  }

  /** Ends the attempt as a DNF, from any state before `solved`; ignored once it is over. */
  markDnf(hostMs: number): void {
    if (this.#state !== 'solved' && this.#state !== 'dnf') {
      this.#state = 'dnf';
      this.#dnfMs = hostMs;
    }
  }

  /**
   * attempt.json (docs/DATA-MODEL.md §7) of the attempt, which must be over (solved or DNF: call
   * {@link markDnf} to end it otherwise); throws before that. `video` is empty (phase 2).
   */
  toRecord(): AttemptRecord {
    if (this.#state !== 'solved' && this.#state !== 'dnf') {
      throw new Error(`The attempt is ${this.#state}: only a solved or DNF attempt has a record.`);
    }
    const solved = this.#state === 'solved';
    const solveMoves = this.#solveMoves.map(({ m }) => m);
    const report = detectPhases(
      this.#scrambled,
      this.#solveMoves,
      this.#crossFace === undefined ? {} : { crossFace: this.#crossFace },
    );
    const { scrambleDone, pickup, solveStart, solveEnd } = this.#events;
    const timeMs =
      solved && solveStart !== null && solveEnd !== null ? solveEnd - solveStart : null;
    const inspectionStart = pickup ?? scrambleDone;
    const movesQtm = quarterTurns(solveMoves);
    return {
      schema: 1,
      session: this.#session,
      index: this.#index,
      scramble: this.#scramble,
      scrambledFacelets: this.#scrambled,
      crossFace: report.crossFace,
      events: { ...this.#events },
      moves: this.#moves.map((m) => ({ ...m })),
      result: {
        timeMs,
        inspectionMs:
          solveStart !== null && inspectionStart !== null ? solveStart - inspectionStart : null,
        movesQtm,
        tps: timeMs !== null && timeMs > 0 ? roundTo2(movesQtm / (timeMs / 1000)) : null,
        status: solved ? 'solved' : 'dnf',
        replayOk: isSolved(applyMoves(this.#scrambled, solveMoves)),
        scrambleCorrected: this.#scrambleCorrected,
        scrambleExtraMoves: this.#scrambleExtraMoves ?? this.#tracker.progress.extraMoves,
      },
      phases: report.phases.map(toAttemptPhase),
      video: [],
    };
  }

  #record(input: CubeMoveInput, phase: MovePhase): void {
    this.#moves.push({ m: formatMove(input.m), hostMs: input.hostMs, cubeMs: input.cubeMs, phase });
  }

  /** After the tracker took a move or a state: a divergence is a correction; the target arms. */
  #afterScramble(progress: ScrambleProgress, hostMs: number): void {
    if (progress.diverged) {
      this.#scrambleCorrected = true;
    }
    if (progress.done) {
      this.#state = 'armed';
      this.#events.scrambleDone = hostMs;
      this.#scrambleExtraMoves = progress.extraMoves;
    }
  }

  #solveMove(input: CubeMoveInput, move: TimedMove): void {
    this.#record(input, 'solve');
    this.#solveMoves.push(move);
    this.#adoptWhileSolving(applyMove(this.#facelets, move.m), input.hostMs);
  }

  #adoptWhileSolving(facelets: Facelets, hostMs: number): void {
    this.#facelets = facelets;
    if (isSolved(facelets)) {
      this.#state = 'solved';
      this.#events.solveEnd = hostMs;
    }
  }
}

function roundTo2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** A phase for attempt.json, its fields in the order of docs/DATA-MODEL.md §7. */
function toAttemptPhase(p: PhaseRecord): AttemptPhase {
  const { name, slot, startMs, endMs, moves, recognitionMs, executionMs } = p;
  return slot === undefined
    ? { name, startMs, endMs, moves, recognitionMs, executionMs }
    : { name, slot, startMs, endMs, moves, recognitionMs, executionMs };
}
