// The attempt state machine (docs/PLAN.md T1.4, docs/ARCHITECTURE.md): the cube's moves in, the
// events of docs/DATA-MODEL.md §3 and the record of §7 (attempt.json, schema version 2) out, with
// the cube clock fit of the attempt's own moves (T2.0). Pure and synchronous: every time comes from
// the caller, so that recorded solves can be replayed through it.
import type { CubeClockParams } from './clock';
import { CubeClockFit } from './clock';
import type { Facelets } from './cube';
import { SOLVED, applyMove, applyMoves, assertFacelets, isSolved } from './cube';
import type { Face, Move } from './notation';
import { formatMove, formatMoves, parseMoves, quarterTurns } from './notation';
import type { PhaseRecord, TimedMove } from './phases';
import { detectPhases } from './phases';
import type { GyroSummary } from './gyro';
import type { ScrambleProgress } from './scramble';
import { ScrambleTracker, scrambleTarget } from './scramble';
import type { AppBuild } from './session';
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
  /**
   * Whether the move is the newest of its Bluetooth packet, the one whose arrival `hostMs`
   * measures (default true): only such moves are samples of the attempt's clock fit.
   */
  packetLast?: boolean;
  /** The cube's move counter (0–255, wrapping), when the source has one (T3.7). */
  serial?: number | null;
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
  /** The build of the app, which the record names as `app` (T3.7); absent, the record names none. */
  app?: AppBuild;
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
  /**
   * The cube's move counter, 0–255, wrapping (T3.7); null for a source without one. Absent from the
   * files written before it existed.
   */
  serial?: number | null;
  /**
   * The move was the newest of its Bluetooth packet, the one whose arrival its `hostMs` measures
   * (T3.7): the older moves of a packet share its time. Absent from the files written before.
   */
  packetLast?: boolean;
}

/**
 * One entry of `resyncs` in attempt.json (T3.7): a state the cube reported that differed from the
 * one the machine knew, and which the machine adopted ({@link AttemptMachine.resync}).
 */
export interface AttemptResync {
  /** When the cube reported it, on the host clock. */
  hostMs: number;
  /** The state adopted. */
  facelets: Facelets;
  /** The attempt's state when the report came, during which moves went unseen. */
  state: Extract<AttemptState, 'scrambling' | 'armed' | 'solving'>;
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

/** The two video clips of an attempt: its scramble and its solve (docs/DATA-MODEL.md §3 and §7). */
export type VideoSegment = 'scramble' | 'solve';

/**
 * A rectangle in whole pixels of a camera's frames, as recorded (after any rotation): the framing
 * rectangle of docs/DATA-MODEL.md §6.
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One entry of `video` in attempt.json: a clip in the attempt's folder (docs/DATA-MODEL.md §7). */
export interface VideoClip {
  /** The camera's label in session.json's `cameras`. */
  camera: string;
  segment: VideoSegment;
  /** The MP4 file, `<camera>.<segment>.mp4`. */
  file: string;
  /** The MP4 file's size. */
  bytes: number;
  /** The video codec string, such as `avc1.640028`. */
  codec: string;
  /** The audio codec string, such as `mp4a.40.2`; null without an audio track. */
  audio: string | null;
  /** Of the encoded frames. */
  width: number;
  height: number;
  /** The camera's framing rectangle when the clip was recorded; null for the whole frame. */
  crop: CropRect | null;
  /** The frame rate the camera's track reported. */
  fpsNominal: number;
  /** The number of frames in the clip. */
  frames: number;
  /** The host time of the clip's first frame: `t0HostMs` of its frames file. */
  firstFrameHostMs: number;
  /** The clip's frame times ({@link FramesJson}), `<camera>.<segment>.frames.json`. */
  framesFile: string;
  /** The camera's lag behind the cube when the clip was recorded; null before a sync check. */
  syncResidualMs: number | null;
  /**
   * The clip begins later than asked, at the oldest keyframe the capture still held: the start
   * asked for was older than its buffer of the last 90 s (docs/PLAN.md T2.9). Optional in the
   * files (those written before it existed have none); `parseAttempt` reads a missing one as false.
   */
  truncatedStart: boolean;
  /**
   * False once the clip's MP4 is no longer on the device that recorded it: the upload queue deleted
   * it after its upload was confirmed (docs/PLAN.md T3.3), and it is in the dataset's bucket; its
   * frames file stays. Absent while the MP4 is there (true means the same), and in the uploaded
   * attempt.json, whose clips are all beside it in the bucket.
   */
  local?: boolean;
}

/**
 * `<camera>.<segment>.frames.json`, schema version 2 (docs/DATA-MODEL.md §9): the frame times of
 * one clip. Frame k is at host time `t0HostMs + dtMs[0] + … + dtMs[k]`.
 */
export interface FramesJson {
  schema: 2;
  camera: string;
  segment: VideoSegment;
  /** The build of the app that wrote the file (T3.7); absent from the files written before. */
  app?: AppBuild;
  /** The host time of the first frame, from the arrival fit. */
  t0HostMs: number;
  /**
   * Per frame, the time since the previous frame, from the frames' own timestamps, in steps of
   * 0.1 ms (the differences of the frame times rounded to 0.1 ms, so that the sums do not drift);
   * 0 for the first frame.
   */
  dtMs: number[];
  /** The indices of the keyframes, increasing, starting with 0. */
  keyframes: number[];
  /** The fit of the frames' arrival host times on their own timestamps that gives `t0HostMs`. */
  arrival: {
    /** The median of arrival host time minus the frame's timestamp, in ms. */
    offsetMs: number;
    /** The 95th percentile of the absolute residuals: the jitter of the arrivals. */
    residualP95Ms: number;
  };
}

/** attempt.json, schema version 2 (docs/DATA-MODEL.md §7). */
export interface AttemptRecord {
  schema: 2;
  session: string;
  index: number;
  /** The build of the app that wrote the record (T3.7); absent from the files written before. */
  app?: AppBuild;
  scramble: string;
  /** The scramble's target, from solved: the state at `scrambleDone`, where the solve starts. */
  scrambledFacelets: Facelets;
  /** The face whose cross completed first; null if none did. */
  crossFace: Face | null;
  events: AttemptEvents;
  /** Every move the cube reported during the attempt, in order, corrections included. */
  moves: AttemptMove[];
  /**
   * The cube clock fit of the attempt's `packetLast` moves, from its first move to `solveEnd` or
   * the DNF: `hostMs ≈ a·cubeMs + b`; null without two of them at different cube times.
   */
  clock: CubeClockParams | null;
  result: AttemptResult;
  /** The phases completed, in order: all eight for a solve the moves replay. */
  phases: AttemptPhase[];
  /** The video clips, one per camera and segment; empty without a camera. */
  video: VideoClip[];
  /**
   * The attempt's gyroscope file, `gyro.json` (T3.7, docs/DATA-MODEL.md §11); null without one (a
   * cube without a gyroscope, no sample in the attempt's window). Absent from the files written
   * before it existed, which read as null.
   */
  gyro: GyroSummary | null;
  /**
   * The states the machine adopted from the cube's reports after moves went unseen (T3.7), in
   * order; empty when none. Absent from the files written before it existed, which read as empty.
   */
  resyncs: AttemptResync[];
}

/**
 * One attempt, from the scramble shown on a solved cube to solved or DNF (docs/DATA-MODEL.md §3):
 * while `scrambling`, every move goes to a {@link ScrambleTracker}; when the cube reaches the
 * scramble's target the attempt is `armed` (`scrambleDone`); the next move is `solveStart` and the
 * attempt is `solving` until the cube is solved (`solveEnd`). Moves after `solved` or `dnf` are
 * ignored: the caller starts the next attempt with a new machine. {@link toRecord} then gives
 * attempt.json, with the phases of the solve (`detectPhases` on the solve's moves in host time) and
 * the cube clock fit of the moves it records (docs/DATA-MODEL.md §7).
 */
export class AttemptMachine {
  readonly #session: string;
  readonly #index: number;
  readonly #scramble: string;
  readonly #app: AppBuild | undefined;
  readonly #crossFace: Face | undefined;
  readonly #tracker: ScrambleTracker;
  /** The scramble's target, where the solve starts. */
  readonly #scrambled: Facelets;
  #state: AttemptState = 'scrambling';
  #facelets: Facelets = SOLVED;
  readonly #events: AttemptEvents;
  readonly #moves: AttemptMove[] = [];
  /** The states adopted from the cube's reports after moves went unseen (T3.7). */
  readonly #resyncs: AttemptResync[] = [];
  /** The solve's moves, in host time. */
  readonly #solveMoves: TimedMove[] = [];
  #scrambleCorrected = false;
  /** The tracker's `extraMoves` at `scrambleDone`. */
  #scrambleExtraMoves: number | null = null;
  #dnfMs: number | null = null;
  /** The cube clock fit of the moves recorded: this attempt's, since the cube's clock drifts. */
  readonly #clock = new CubeClockFit();

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
    this.#app = opts.app === undefined ? undefined : { ...opts.app };
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

  /**
   * Takes one move of the cube and returns the state after it. Throws a RangeError, and takes
   * nothing, if a time is not finite.
   */
  onMove(input: CubeMoveInput): AttemptState {
    if (!Number.isFinite(input.cubeMs) || !Number.isFinite(input.hostMs)) {
      throw new RangeError(
        `A move's times must be finite, got cube ${String(input.cubeMs)} ms and host ${String(input.hostMs)} ms.`,
      );
    }
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
   * recorded, so a solve that went through a resync does not replay (`replayOk` false); the state
   * adopted is, in the record's `resyncs` (T3.7), with the time and the attempt's state then.
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
    const state = this.#state;
    if (state === 'scrambling' || state === 'armed' || state === 'solving') {
      this.#resyncs.push({ hostMs: at, facelets: reported, state });
    }
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
   * {@link markDnf} to end it otherwise); throws before that. `video` is empty and `gyro` null: the
   * caller adds the clips (phase 2) and the gyro file (T3.7).
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
      schema: 2,
      session: this.#session,
      index: this.#index,
      ...(this.#app === undefined ? {} : { app: { ...this.#app } }),
      scramble: this.#scramble,
      scrambledFacelets: this.#scrambled,
      crossFace: report.crossFace,
      events: { ...this.#events },
      moves: this.#moves.map((m) => ({ ...m })),
      clock: this.#clock.hasLine ? this.#clock.params : null,
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
      gyro: null,
      resyncs: this.#resyncs.map((r) => ({ ...r })),
    };
  }

  #record(input: CubeMoveInput, phase: MovePhase): void {
    const packetLast = input.packetLast ?? true;
    this.#moves.push({
      m: formatMove(input.m),
      hostMs: input.hostMs,
      cubeMs: input.cubeMs,
      phase,
      serial: input.serial ?? null,
      packetLast,
    });
    this.#clock.addSample(input.cubeMs, input.hostMs, packetLast);
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
