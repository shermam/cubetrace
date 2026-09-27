import { signal } from '@angular/core';
import {
  SYNC_CHECK_MS,
  detectClapperboard,
  percentile,
  type ClapperboardAnalysis,
  type ClapperboardResult,
  type FramingRect,
  type MotionSample,
} from '@cubetrace/capture';
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
 * A check ends early once all its turns are matched, the spread is within the limit and a second
 * has passed since the last turn and the last onset: it has what it asked for.
 */
export const SYNC_EARLY_MATCHES = SYNC_TURNS;
export const SYNC_EARLY_QUIET_MS = 1000;

/** Starts measuring the camera's motion in `rect`; returns the stop, or null without a capture. */
export type MotionWatch = (
  rect: FramingRect | null,
  onSample: (sample: MotionSample) => void,
  onError: (message: string) => void,
) => (() => void) | null;

export interface SyncRunOptions {
  /** The capture's `watchMotion` (the recording's, or the capture lab's). */
  readonly watch: MotionWatch;
  /** The framing rectangle in frame pixels, or null for the whole frame. */
  readonly rect: FramingRect | null;
  /**
   * The cube's events (`CubeService.events$`): the host times of its moves are taken, and its
   * disconnection ends the check, at once (before another connection can begin).
   */
  readonly events$: Observable<CubeEvent>;
  /** How long it watches, ms; `SYNC_CHECK_MS` (20 s) by default. */
  readonly durationMs?: number;
  /** The host clock and its timers (BROWSER_GLOBALS in the app; fakes in the tests). */
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => number;
  readonly clearTimeout: (handle: number) => void;
  /**
   * Called once when the check ends, at once (within the call that ends it, even during the
   * construction when the camera does not record): with the outcome, or null when cancelled.
   */
  readonly onEnd?: (outcome: SyncOutcome | null) => void;
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

/** `running`, then `done` with an outcome, or `cancelled` without one. */
export type SyncRunState = 'running' | 'done' | 'cancelled';

/**
 * One sync check (docs/PLAN.md, T2.5): for `durationMs` it collects the motion of the camera's
 * frames (the capture worker's `sync-sample`s) and the host times of the cube's moves, updating a
 * countdown and the counts of frames, moves and onsets four times a second, then runs the
 * clapperboard (@cubetrace/capture's `detectClapperboard`) on them. It ends early once its ten
 * turns (`SYNC_TURNS`) are matched within the spread and a second has passed since the last one.
 * The Timer page's check (`SyncService`) and the capture lab's run it.
 */
export class SyncRun {
  private readonly stateSignal = signal<SyncRunState>('running');
  private readonly secondsLeftSignal = signal(0);
  private readonly framesSignal = signal(0);
  private readonly movesSignal = signal(0);
  private readonly onsetsSignal = signal(0);
  private readonly outcomeSignal = signal<SyncOutcome | null>(null);

  readonly state = this.stateSignal.asReadonly();
  /** Seconds until it ends, counted down. */
  readonly secondsLeft = this.secondsLeftSignal.asReadonly();
  /** Frames measured so far. */
  readonly frames = this.framesSignal.asReadonly();
  /** The cube's moves so far. */
  readonly moves = this.movesSignal.asReadonly();
  /** Motion onsets so far. */
  readonly onsets = this.onsetsSignal.asReadonly();
  /** How it ended; null while it runs, and when it was cancelled. */
  readonly outcome = this.outcomeSignal.asReadonly();

  private readonly options: SyncRunOptions;
  private readonly durationMs: number;
  private readonly startMs: number;
  private readonly samples: MotionSample[] = [];
  private readonly moveTimes: number[] = [];
  private stopWatch: (() => void) | null = null;
  private subscription: Subscription | null = null;
  private timer: number | null = null;

  constructor(options: SyncRunOptions) {
    this.options = options;
    this.durationMs = options.durationMs ?? SYNC_CHECK_MS;
    this.startMs = options.now();
    this.secondsLeftSignal.set(Math.ceil(this.durationMs / 1000));
    this.subscription = options.events$.subscribe((event) => {
      if (this.stateSignal() !== 'running') {
        return;
      }
      if (event.type === 'move') {
        this.moveTimes.push(event.hostMs);
        this.movesSignal.set(this.moveTimes.length);
      } else if (event.type === 'disconnected') {
        this.interrupt('the cube disconnected');
      }
    });
    const stop = options.watch(
      options.rect,
      (sample) => {
        if (this.stateSignal() === 'running') {
          this.samples.push(sample);
          this.framesSignal.set(this.samples.length);
        }
      },
      (message) => {
        this.interrupt(`the camera's frames could not be measured (${message})`);
      },
    );
    if (stop === null) {
      this.interrupt('the camera is not recording');
      return;
    }
    if (this.stateSignal() === 'running') {
      this.stopWatch = stop;
      this.schedule();
    } else {
      stop();
    }
  }

  /** Ends the check without an outcome ("Later"). */
  cancel(): void {
    if (this.stateSignal() !== 'running') {
      return;
    }
    this.release();
    this.stateSignal.set('cancelled');
    this.options.onEnd?.(null);
  }

  /** Ends the check as failed, for `message` (the recording stopped, say). */
  interrupt(message: string): void {
    if (this.stateSignal() !== 'running') {
      return;
    }
    const result = detectClapperboard(this.samples, this.moveTimes);
    this.end({ ok: false, reason: 'interrupted', message, analysis: result.analysis });
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
    this.secondsLeftSignal.set(Math.max(0, Math.ceil((this.durationMs - elapsed) / 1000)));
    const result = detectClapperboard(this.samples, this.moveTimes);
    this.onsetsSignal.set(result.analysis.onsets.length);
    if (elapsed >= this.durationMs || this.complete(result, now)) {
      this.end(result);
      return;
    }
    this.schedule();
  }

  /** All the turns matched within the spread, and a second of stillness since. */
  private complete(result: ClapperboardResult, now: number): boolean {
    if (!result.ok || result.clapperboardSamples < SYNC_EARLY_MATCHES) {
      return false;
    }
    const lastMove = this.moveTimes.at(-1) ?? 0;
    const lastOnset = result.analysis.onsets.at(-1) ?? 0;
    return now - Math.max(lastMove, lastOnset) >= SYNC_EARLY_QUIET_MS;
  }

  private end(result: ClapperboardResult | SyncInterrupted): void {
    this.release();
    const outcome: SyncOutcome = {
      ...result,
      cost: costOf(this.samples),
      durationMs: Math.round(this.options.now() - this.startMs),
    };
    this.onsetsSignal.set(outcome.analysis.onsets.length);
    this.secondsLeftSignal.set(0);
    this.outcomeSignal.set(outcome);
    this.stateSignal.set('done');
    this.options.onEnd?.(outcome);
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
