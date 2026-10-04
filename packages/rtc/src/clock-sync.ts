// The clock sync's messages over a link (docs/RTC.md §4): the host pings (every 500 ms until the fit
// has converged, for a minute at most, then every 2 s) and feeds each round trip to core's
// RemoteClockFit, the camera device answers at once with its own clock. The maths is core's; this is
// the plumbing both roles share.
import { RemoteClockFit } from '@cubetrace/core';

import type { MessageLink } from './link';
import { REAL_TIMERS, type Timers } from './transport';

/** How often the host pings once the fit has converged (or after {@link FAST_PINGS_MS}). */
export const PING_INTERVAL_MS = 2000;

/**
 * How often it pings until then (T4.2b): four times as often, so that the fit has the ten samples
 * of least round trip it keeps out of twenty in about ten seconds, rather than out of five in the
 * first minute at 2 s. Two small messages each way a second, against the megabytes of a clip.
 */
export const FAST_PING_INTERVAL_MS = 500;

/**
 * The fast pings last at most this long from the start (T4.2b): a link that has not converged in a
 * minute (a phone in Wi-Fi power saving, a busy network) is pinged at the steady rate, the window of
 * two minutes then holding the minute of fast pings and a minute at 2 s.
 */
export const FAST_PINGS_MS = 60_000;

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
 * answer came as `t4`. It pings every {@link FAST_PING_INTERVAL_MS} from its start until an answer
 * leaves the fit converged, or for {@link FAST_PINGS_MS} at most, then every
 * {@link PING_INTERVAL_MS} (T4.2b): a new connection's fit converges in about ten seconds, and one
 * kept across a reconnection, converged still, goes back to the steady rate at its first answer. An
 * answer whose `t1` was not this pinger's (an old one, after a reconnection) is ignored.
 */
export class ClockPinger {
  readonly #link: MessageLink;
  readonly #fit: RemoteClockFit;
  readonly #timers: Timers;
  readonly #intervalMs: number;
  readonly #fastIntervalMs: number;
  readonly #fastMs: number;
  readonly #outstanding = new Set<number>();
  readonly #sampleHandlers = new Set<(fit: RemoteClockFit) => void>();
  #timer: unknown = null;
  #off: (() => void) | null = null;
  #pings = 0;
  #pongs = 0;
  /** When `start` was called, on the timers' clock; null before. */
  #startedMs: number | null = null;
  /** An answer left the fit converged since `start`: the steady rate from then on. */
  #settled = false;

  /**
   * @param options.intervalMs the steady interval (default {@link PING_INTERVAL_MS}).
   * @param options.fastIntervalMs the interval until the fit converges (default
   *   {@link FAST_PING_INTERVAL_MS}).
   * @param options.fastMs how long the fast pings last at most (default {@link FAST_PINGS_MS}; 0
   *   pings at the steady interval from the start).
   */
  constructor(
    link: MessageLink,
    fit: RemoteClockFit = new RemoteClockFit(),
    options: {
      timers?: Timers;
      intervalMs?: number;
      fastIntervalMs?: number;
      fastMs?: number;
    } = {},
  ) {
    this.#link = link;
    this.#fit = fit;
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#intervalMs = options.intervalMs ?? PING_INTERVAL_MS;
    this.#fastIntervalMs = options.fastIntervalMs ?? FAST_PING_INTERVAL_MS;
    this.#fastMs = options.fastMs ?? FAST_PINGS_MS;
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

  /** The interval of the next ping: fast until the fit converged, or the fast pings' time is up. */
  get intervalMs(): number {
    const elapsed = this.#startedMs === null ? 0 : this.#timers.now() - this.#startedMs;
    return this.#settled || elapsed >= this.#fastMs ? this.#intervalMs : this.#fastIntervalMs;
  }

  /** Calls `next` with the fit after each answer. */
  onSample(next: (fit: RemoteClockFit) => void): () => void {
    this.#sampleHandlers.add(next);
    return () => {
      this.#sampleHandlers.delete(next);
    };
  }

  /** Sends the first ping now and one every interval ({@link intervalMs}), until `stop`. */
  start(): void {
    if (this.#off !== null) {
      return;
    }
    this.#startedMs = this.#timers.now();
    this.#settled = false;
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
      this.#settled ||= this.#fit.converged;
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
    }, this.intervalMs);
  }
}
