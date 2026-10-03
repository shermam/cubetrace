// The clock sync's messages over a link (docs/RTC.md): the host pings every 2 s and feeds each round
// trip to core's RemoteClockFit, the camera device answers at once with its own clock. The maths is
// core's; this is the plumbing both roles share.
import { RemoteClockFit } from '@cubetrace/core';

import type { MessageLink } from './link';
import { REAL_TIMERS, type Timers } from './transport';

/** How often the host pings. */
export const PING_INTERVAL_MS = 2000;

/**
 * The camera device's side: answers each `ping` with `pong`, carrying the host's `t1` back with its
 * own clock when the ping came (`t2`) and when the answer goes (`t3`). Returns what stops it.
 */
export function answerPings(
  link: MessageLink,
  now: () => number = () => REAL_TIMERS.now(),
): () => void {
  return link.on('ping', (ping) => {
    const t2 = now();
    link.trySend({ type: 'pong', t1: ping.t1, t2, t3: now() });
  });
}

/**
 * The host's side: pings on a timer and adds each answer to the fit, with the host clock when the
 * answer came as `t4`. An answer whose `t1` was not this pinger's (an old one, after a reconnection)
 * is ignored.
 */
export class ClockPinger {
  readonly #link: MessageLink;
  readonly #fit: RemoteClockFit;
  readonly #timers: Timers;
  readonly #intervalMs: number;
  readonly #outstanding = new Set<number>();
  readonly #sampleHandlers = new Set<(fit: RemoteClockFit) => void>();
  #timer: unknown = null;
  #off: (() => void) | null = null;
  #pings = 0;
  #pongs = 0;

  constructor(
    link: MessageLink,
    fit: RemoteClockFit = new RemoteClockFit(),
    options: { timers?: Timers; intervalMs?: number } = {},
  ) {
    this.#link = link;
    this.#fit = fit;
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#intervalMs = options.intervalMs ?? PING_INTERVAL_MS;
  }

  /** The fit the pings feed. */
  get fit(): RemoteClockFit {
    return this.#fit;
  }

  /** Pings sent and answers taken since `start`. */
  get pings(): number {
    return this.#pings;
  }

  get pongs(): number {
    return this.#pongs;
  }

  /** Calls `next` with the fit after each answer. */
  onSample(next: (fit: RemoteClockFit) => void): () => void {
    this.#sampleHandlers.add(next);
    return () => {
      this.#sampleHandlers.delete(next);
    };
  }

  /** Sends the first ping now and one every interval, until `stop`. */
  start(): void {
    if (this.#off !== null) {
      return;
    }
    this.#off = this.#link.on('pong', (pong) => {
      if (!this.#outstanding.delete(pong.t1)) {
        return;
      }
      const t4 = this.#timers.now();
      try {
        this.#fit.addSample(pong.t1, pong.t2, pong.t3, t4);
      } catch {
        // A clock that ran backwards on either side: the sample is dropped.
        return;
      }
      this.#pongs++;
      for (const handler of [...this.#sampleHandlers]) {
        handler(this.#fit);
      }
    });
    this.#ping();
  }

  /** Stops pinging; the fit keeps its samples. */
  stop(): void {
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#off?.();
    this.#off = null;
    this.#outstanding.clear();
  }

  #ping(): void {
    this.#timer = null;
    if (this.#off === null) {
      return;
    }
    const t1 = this.#timers.now();
    if (this.#link.trySend({ type: 'ping', t1 })) {
      this.#pings++;
      this.#outstanding.add(t1);
      // Answers that never come must not pile up: the last few are enough.
      if (this.#outstanding.size > 10) {
        this.#outstanding.delete(this.#outstanding.values().next().value as number);
      }
    }
    this.#timer = this.#timers.setTimeout(() => {
      this.#ping();
    }, this.#intervalMs);
  }
}
