import { signal } from '@angular/core';
import {
  SYNC_CHECK_MS,
  detectClapperboard,
  percentile,
  type ClapperboardAnalysis,
  type ClapperboardFrame,
  type ClapperboardResult,
  type FramingRect,
  type MotionMeterInfo,
  type MotionSample,
} from '@cubetrace/capture';
import { formatMove } from '@cubetrace/core';
import type { CubeEvent } from '@cubetrace/gan';
import type { Observable, Subscription } from 'rxjs';

/** How often a check updates its countdown and live counts, ms. */
export const SYNC_TICK_MS = 250;

/**
 * A check asks for one face turned and turned back, five times: the cube ends as it began, after
 * this many single turns.
 */
export const SYNC_TURNS = 10;

/**
 * A check asks to hold still for this long after it starts, ms, and counts no turn made before it
 * (T2.11): the detection needs the picture from 900 to 300 ms before a turn, its baseline, and a turn
 * made sooner has none (the owner's second check of issue #38 lost its first turn so).
 */
export const SYNC_HOLD_MS = 1000;

/**
 * Once the turns asked for are made, a check ends when the cube has been still this long, ms: the
 * last turn's motion is in the frames by then (the detection looks 700 ms past a turn).
 */
export const SYNC_EARLY_QUIET_MS = 1000;

/**
 * Starts measuring the camera's motion in `rect`; returns the stop, or null without a capture. A
 * sample may say when its motion reached the page (`receivedHostMs`: a remote camera's, T4.3, on the
 * phone's page, converted); otherwise the check stamps it with the page's clock as it comes.
 */
export type MotionWatch = (
  rect: FramingRect | null,
  onSample: (sample: ClapperboardFrame) => void,
  onError: (message: string) => void,
  onMeter: (meter: MotionMeterInfo) => void,
) => (() => void) | null;

export interface SyncRunOptions {
  /** The capture's `watchMotion` (the recording's, the capture lab's, or a remote camera's, T4.3). */
  readonly watch: MotionWatch;
  /**
   * Why the check ends at once when `watch` gives no stop: by default "the camera is not recording"
   * (a remote camera's says the phone is not connected, T4.3).
   */
  readonly unwatched?: string;
  /** The framing rectangle in frame pixels, or null for the whole frame. */
  readonly rect: FramingRect | null;
  /**
   * The cube's events (`CubeService.events$`): the host times of its moves are taken, and its
   * disconnection ends the check, at once (before another connection can begin).
   */
  readonly events$: Observable<CubeEvent>;
  /**
   * How long it waits, ms (`SYNC_CHECK_MS`, 20 s, by default): for the first turn when it runs until
   * the turns are done (`untilDone`), else in all.
   */
  readonly durationMs?: number;
  /**
   * True (the Timer's check, by default): once the first turn is made, it runs until the
   * `SYNC_TURNS` turns asked for are made and the cube has been still for a second, whatever the
   * time, or until it is cancelled; it never gives up in the middle of what it asked for (T2.8).
   * False (the capture lab's): it watches `durationMs`, ending sooner once the turns asked for are
   * all matched, the check passes, and the cube has been still for a second.
   */
  readonly untilDone?: boolean;
  /** The host clock and its timers (BROWSER_GLOBALS in the app; fakes in the tests). */
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => number;
  readonly clearTimeout: (handle: number) => void;
  /**
   * Called once when the check ends, at once (within the call that ends it, even during the
   * construction when the camera does not record): with the outcome, or null when cancelled, and the
   * check itself.
   */
  readonly onEnd?: (outcome: SyncOutcome | null, run: SyncRun) => void;
}

/** What the camera's frames cost to measure, ms: the capture worker's time per frame. */
export interface MotionCost {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

/** A check that could not go on: recording stopped, or the frames could not be measured. */
export interface SyncInterrupted {
  readonly ok: false;
  readonly reason: 'interrupted';
  /** Why, such as "recording stopped". */
  readonly message: string;
  /** What it had seen until then. */
  readonly analysis: ClapperboardAnalysis;
}

/** How a check ended: the clapperboard's result (the lag, or why there is none), or interrupted. */
export type SyncOutcome = (ClapperboardResult | SyncInterrupted) & {
  /** What measuring the frames cost the capture worker; null without frames. */
  readonly cost: MotionCost | null;
  /** How long it watched, ms. */
  readonly durationMs: number;
};

/** A move of the cube during a check: its host time and the move, such as `U'`. */
export interface SyncMove {
  readonly hostMs: number;
  readonly move: string;
}

/** What a check collected, for its diagnostics (sync-report.ts). */
export interface SyncRunData {
  /** When it started, host ms. */
  readonly startMs: number;
  /** The frames' motion, each with the page's clock when it came (`receivedHostMs`). */
  readonly samples: readonly ClapperboardFrame[];
  readonly moves: readonly SyncMove[];
  /** How the capture worker read the frames; null before the first. */
  readonly meter: MotionMeterInfo | null;
}

/** `running`, then `done` with an outcome, or `cancelled` without one. */
export type SyncRunState = 'running' | 'done' | 'cancelled';

/**
 * One sync check (docs/PLAN.md, T2.5, T2.8 and T2.11): it collects the motion of the camera's frames
 * (the capture worker's `sync-sample`s, each stamped with the page's clock when it came) and the
 * cube's moves, updating a countdown and the counts of frames, turns and turns matched four times a
 * second, and runs the clapperboard (@cubetrace/capture's `detectClapperboard`) on them. It asks to
 * hold still for its first second and counts the turns made after it (`SYNC_HOLD_MS`); the Timer's
 * check waits 20 s from its start for the first turn, then runs until the ten turns asked for
 * (`SYNC_TURNS`) are made and the cube has been still for a second (`untilDone`); the capture lab's
 * watches its time. The Timer page's check (`SyncService`) and the capture lab's run it.
 */
export class SyncRun {
  private readonly stateSignal = signal<SyncRunState>('running');
  private readonly holdingSignal = signal(true);
  private readonly secondsLeftSignal = signal(0);
  private readonly framesSignal = signal(0);
  private readonly movesSignal = signal(0);
  private readonly matchedSignal = signal(0);
  private readonly meterSignal = signal<MotionMeterInfo | null>(null);
  private readonly lastSignal = signal<MotionSample | null>(null);
  private readonly outcomeSignal = signal<SyncOutcome | null>(null);

  readonly state = this.stateSignal.asReadonly();
  /** True for its first second (`SYNC_HOLD_MS`), while it asks to hold still: no turn counts yet. */
  readonly holding = this.holdingSignal.asReadonly();
  /**
   * Seconds until it gives up, counted down: until the first turn when it runs until the turns are
   * done (0 from then on), else until it ends.
   */
  readonly secondsLeft = this.secondsLeftSignal.asReadonly();
  /** Frames measured so far. */
  readonly frames = this.framesSignal.asReadonly();
  /** The turns made so far from `SYNC_HOLD_MS` after the start: the turns it counts. */
  readonly moves = this.movesSignal.asReadonly();
  /** The single turns matched to a motion so far. */
  readonly matched = this.matchedSignal.asReadonly();
  /** How the capture worker reads the frames; null before the first. */
  readonly meter = this.meterSignal.asReadonly();
  /** The latest frame's motion (the capture lab's live bars); null before the first. */
  readonly last = this.lastSignal.asReadonly();
  /** How it ended; null while it runs, and when it was cancelled. */
  readonly outcome = this.outcomeSignal.asReadonly();
  /** Whether it runs until the turns asked for are done (the Timer's check). */
  readonly untilDone: boolean;

  private readonly options: SyncRunOptions;
  private readonly durationMs: number;
  private readonly startMs: number;
  private readonly samples: ClapperboardFrame[] = [];
  /** Every move of the cube during the check, those of its first second too. */
  private readonly moveLog: SyncMove[] = [];
  /** How many of them came from `SYNC_HOLD_MS` after the start. */
  private counted = 0;
  private stopWatch: (() => void) | null = null;
  private subscription: Subscription | null = null;
  private timer: number | null = null;

  constructor(options: SyncRunOptions) {
    this.options = options;
    this.durationMs = options.durationMs ?? SYNC_CHECK_MS;
    this.untilDone = options.untilDone ?? true;
    this.startMs = options.now();
    this.secondsLeftSignal.set(Math.ceil(this.durationMs / 1000));
    this.subscription = options.events$.subscribe((event) => {
      if (this.stateSignal() !== 'running') {
        return;
      }
      if (event.type === 'move') {
        this.moveLog.push({ hostMs: event.hostMs, move: formatMove(event.m) });
        if (event.hostMs >= this.startMs + SYNC_HOLD_MS) {
          this.counted += 1;
          this.movesSignal.set(this.counted);
        }
      } else if (event.type === 'disconnected') {
        this.interrupt('the cube disconnected');
      }
    });
    const stop = options.watch(
      options.rect,
      (sample) => {
        if (this.stateSignal() === 'running') {
          this.samples.push({ ...sample, receivedHostMs: sample.receivedHostMs ?? options.now() });
          this.framesSignal.set(this.samples.length);
          this.lastSignal.set(sample);
        }
      },
      (message) => {
        this.interrupt(`the camera's frames could not be measured (${message})`);
      },
      (meter) => {
        this.meterSignal.set(meter);
      },
    );
    if (stop === null) {
      this.interrupt(options.unwatched ?? 'the camera is not recording');
      return;
    }
    if (this.stateSignal() === 'running') {
      this.stopWatch = stop;
      this.schedule();
    } else {
      stop();
    }
  }

  /** What it collected so far (the frames, the moves, how the frames are read). */
  data(): SyncRunData {
    return {
      startMs: this.startMs,
      samples: [...this.samples],
      moves: [...this.moveLog],
      meter: this.meterSignal(),
    };
  }

  /** Ends the check without an outcome ("Later"). */
  cancel(): void {
    if (this.stateSignal() !== 'running') {
      return;
    }
    this.release();
    this.stateSignal.set('cancelled');
    this.options.onEnd?.(null, this);
  }

  /** Ends the check as failed, for `message` (the recording stopped, say). */
  interrupt(message: string): void {
    if (this.stateSignal() !== 'running') {
      return;
    }
    const result = this.detect();
    this.end({ ok: false, reason: 'interrupted', message, analysis: result.analysis });
  }

  private detect(): ClapperboardResult {
    return detectClapperboard(
      this.samples,
      this.moveLog.map((move) => move.hostMs),
    );
  }

  private schedule(): void {
    this.timer = this.options.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, SYNC_TICK_MS);
  }

  private tick(): void {
    if (this.stateSignal() !== 'running') {
      return;
    }
    const now = this.options.now();
    const elapsed = now - this.startMs;
    this.holdingSignal.set(elapsed < SYNC_HOLD_MS);
    const turning = this.untilDone && this.counted > 0;
    this.secondsLeftSignal.set(
      turning ? 0 : Math.max(0, Math.ceil((this.durationMs - elapsed) / 1000)),
    );
    const result = this.detect();
    this.matchedSignal.set(result.analysis.matched);
    if ((!turning && elapsed >= this.durationMs) || this.complete(result, now)) {
      this.end(result);
      return;
    }
    this.schedule();
  }

  /**
   * Whether it has what it asked for: the turns counted (the Timer's), or all matched and the check
   * passing (the lab's; since T2.11 the spread leaves out a fifth of them), and a second of stillness
   * since the last turn and the middle of the last turn's motion.
   */
  private complete(result: ClapperboardResult, now: number): boolean {
    const done = this.untilDone
      ? this.counted >= SYNC_TURNS
      : result.ok && result.analysis.matched >= SYNC_TURNS;
    if (!done) {
      return false;
    }
    const lastMove = this.moveLog.at(-1)?.hostMs ?? 0;
    const lastEvent = result.analysis.pairs.at(-1)?.onsetHostMs ?? 0;
    return now - Math.max(lastMove, lastEvent) >= SYNC_EARLY_QUIET_MS;
  }

  private end(result: ClapperboardResult | SyncInterrupted): void {
    this.release();
    const outcome: SyncOutcome = {
      ...result,
      cost: costOf(this.samples),
      durationMs: Math.round(this.options.now() - this.startMs),
    };
    this.matchedSignal.set(outcome.analysis.matched);
    this.holdingSignal.set(false);
    this.secondsLeftSignal.set(0);
    this.outcomeSignal.set(outcome);
    this.stateSignal.set('done');
    this.options.onEnd?.(outcome, this);
  }

  private release(): void {
    this.stopWatch?.();
    this.stopWatch = null;
    this.subscription?.unsubscribe();
    this.subscription = null;
    if (this.timer !== null) {
      this.options.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** The median, 95th percentile and maximum of the frames' cost; null without frames. */
function costOf(samples: readonly MotionSample[]): MotionCost | null {
  if (samples.length === 0) {
    return null;
  }
  const costs = samples.map((sample) => sample.costMs).sort((a, b) => a - b);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    medianMs: round(percentile(costs, 0.5)),
    p95Ms: round(percentile(costs, 0.95)),
    maxMs: round(costs[costs.length - 1]),
  };
}
