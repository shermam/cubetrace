// Fakes for the tests of this package and of the app's services over it: a clock with timers that
// a test advances by hand, so that a transfer over a MemoryTransport with a 200 ms delay runs in no
// time and always the same way. Nothing in the app imports this file, so it is not in the bundle.
import type { Timers } from './transport';

interface Scheduled {
  at: number;
  seq: number;
  callback: () => void;
}

/** The real timer, kept apart from any fake a test may install on the globals. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/** Lets every microtask run, and the continuations they queue, before going on. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });
}

/**
 * A clock that moves only when told, with timers that fire when it reaches them, in the order of
 * their times (then of their scheduling). `run(task)` drives it: it lets the pending work settle,
 * then fires the next timer, until the task's promise settles.
 */
export class FakeTimers implements Timers {
  #now: number;
  #seq = 0;
  readonly #scheduled: Scheduled[] = [];

  /** @param startMs the clock's reading at the start (a wall clock, as the host clock is). */
  constructor(startMs = 1_790_000_000_000) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const entry: Scheduled = { at: this.#now + Math.max(0, ms), seq: this.#seq++, callback };
    this.#scheduled.push(entry);
    return entry;
  }

  clearTimeout(handle: unknown): void {
    const at = this.#scheduled.indexOf(handle as Scheduled);
    if (at >= 0) {
      this.#scheduled.splice(at, 1);
    }
  }

  /** How many timers wait. */
  get pending(): number {
    return this.#scheduled.length;
  }

  /** Moves the clock to the next timer and fires it; false when none waits. */
  runNext(): boolean {
    const next = this.#next();
    if (next === null) {
      return false;
    }
    this.#scheduled.splice(this.#scheduled.indexOf(next), 1);
    this.#now = Math.max(this.#now, next.at);
    next.callback();
    return true;
  }

  /** Resolves once the clock has moved `ms` further: `await timers.run(timers.wait(100))`. */
  wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  /** Moves the clock forward by `ms`, firing every timer due on the way, in order. */
  advance(ms: number): void {
    const until = this.#now + ms;
    for (let next = this.#next(); next !== null && next.at <= until; next = this.#next()) {
      this.runNext();
    }
    this.#now = until;
  }

  /**
   * Drives the clock until `task` settles: lets the pending promises run, fires the next timer, and
   * so on. Rejects as the task does, or when nothing is left to fire while the task waits.
   */
  async run<T>(task: Promise<T>): Promise<T> {
    type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
    let outcome: Outcome | null = null;
    // Read through a call, so that the loop's checks are not narrowed by the one before them.
    const settledWith = (): Outcome | null => outcome;
    void task.then(
      (value) => {
        outcome = { ok: true, value };
      },
      (error: unknown) => {
        outcome = { ok: false, error };
      },
    );
    for (;;) {
      await settle();
      if (settledWith() !== null) {
        break;
      }
      if (!this.runNext()) {
        await settle();
        if (settledWith() !== null) {
          break;
        }
        throw new Error(
          `Nothing left to run at ${String(this.#now)} ms, and the task has not settled.`,
        );
      }
    }
    const result = settledWith() as Outcome;
    if (result.ok) {
      return result.value;
    }
    throw result.error;
  }

  #next(): Scheduled | null {
    let next: Scheduled | null = null;
    for (const entry of this.#scheduled) {
      if (next === null || entry.at < next.at || (entry.at === next.at && entry.seq < next.seq)) {
        next = entry;
      }
    }
    return next;
  }
}
