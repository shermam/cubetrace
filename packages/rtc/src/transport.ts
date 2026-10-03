// The transport under the protocol (docs/RTC.md): one reliable, ordered channel that carries text
// and binary frames, with the data channel's flow control (`bufferedAmount`, its low threshold and
// the event when it falls under it), behind an interface. WebRtcTransport (webrtc.ts) is the real
// one over an RTCDataChannel; MemoryTransport joins two ends in memory for the tests, with a
// one-way delay, a bandwidth, and a share of frames "lost" and retransmitted late, as a reliable
// channel over a lossy network behaves: a frame is never dropped, but it, and every frame after it,
// arrives later. Plain TypeScript: no browser API.
import type { WireFrame } from './protocol';

/**
 * Where a transport is: `connecting` before the channel is open, `open` while frames flow, `closed`
 * once either side closed it or the connection ended, `failed` when it could not be made.
 */
export type TransportState = 'connecting' | 'open' | 'closed' | 'failed';

/** One end of the channel. */
export interface Transport {
  readonly state: TransportState;
  /** The bytes queued on this end that the channel has not sent yet (`RTCDataChannel.bufferedAmount`). */
  readonly bufferedAmount: number;
  /**
   * The level under which `bufferedAmount` must fall, after being above it, for the low event to
   * fire (`RTCDataChannel.bufferedAmountLowThreshold`).
   */
  bufferedAmountLowThreshold: number;
  /** The most bytes one frame may carry (`RTCSctpTransport.maxMessageSize`); null when unknown. */
  readonly maxMessageSize: number | null;
  /** Queues a frame. Throws when the transport is not open. */
  send(frame: WireFrame): void;
  /** Calls `next` with each frame received, in order, until the returned function is called. */
  onFrame(next: (frame: WireFrame) => void): () => void;
  /** Calls `next` when `bufferedAmount` falls to the threshold or under it, from above. */
  onBufferedAmountLow(next: () => void): () => void;
  /** Calls `next` at each change of `state`, with why when there is a reason. */
  onStateChange(next: (state: TransportState, reason: string | null) => void): () => void;
  /** Closes the channel; frames not yet sent are dropped. */
  close(reason?: string): void;
}

/** The clock and the timers a transport, a pinger or a test runs on (the real ones by default). */
export interface Timers {
  /** The host clock, in ms (`performance.timeOrigin + performance.now()` in the browser). */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The browser's, or Node's, own clock and timers. */
export const REAL_TIMERS: Timers = {
  now: () => performance.timeOrigin + performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** How a {@link MemoryTransport} pair behaves. */
export interface MemoryLinkOptions {
  /** How long a frame takes from one end to the other, in ms. Default 0. */
  delayMs?: number;
  /** Up to this much more, at random, for each frame (the network's jitter), in ms. Default 0. */
  jitterMs?: number;
  /**
   * The share of frames (0 to 1) that the network loses once and the channel sends again: such a
   * frame, and every frame queued after it, arrives `retransmitMs` late. Default 0.
   */
  loss?: number;
  /** How long a retransmission adds, in ms. Default three times the delay, at least 100 ms. */
  retransmitMs?: number;
  /** How fast an end's queue drains into the network, in bytes per second. Default Infinity. */
  bytesPerSecond?: number;
  /** What the ends say the most bytes of one frame is. Default null (unknown). */
  maxMessageSize?: number | null;
  timers?: Timers;
  /** The randomness of the losses; `Math.random` by default. */
  random?: () => number;
}

/** What one end of a {@link MemoryTransport} pair has done, for the tests to check. */
export interface MemoryTransportStats {
  /** Frames and bytes queued by `send`. */
  frames: number;
  bytes: number;
  /** Frames that were lost once and retransmitted late. */
  retransmitted: number;
  /** The most bytes the queue held at once. */
  maxBuffered: number;
}

/** A frame on its way, with when it reaches the other end. */
interface Queued {
  frame: WireFrame;
  bytes: number;
}

/**
 * One end of a channel joined in memory to another ({@link MemoryTransport.pair}): the frames sent
 * here arrive there, in order, after the delay, the bandwidth and the losses of the options. Both
 * ends are open from the start, and closing one closes the other at once, dropping what was on its
 * way (as a connection cut does).
 */
export class MemoryTransport implements Transport {
  /** The frames each end sends go through `transform` first, when a test sets one (null drops a frame). */
  transform: ((frame: WireFrame) => WireFrame | null) | null = null;
  readonly stats: MemoryTransportStats = { frames: 0, bytes: 0, retransmitted: 0, maxBuffered: 0 };
  bufferedAmountLowThreshold = 0;

  #state: TransportState = 'open';
  #peer: MemoryTransport | null = null;
  #bufferedAmount = 0;
  readonly #queue: Queued[] = [];
  #draining = false;
  /** When the last frame handed to the peer reaches it: the next one cannot arrive before. */
  #lastArrivalMs = 0;
  readonly #frameHandlers = new Set<(frame: WireFrame) => void>();
  readonly #lowHandlers = new Set<() => void>();
  readonly #stateHandlers = new Set<(state: TransportState, reason: string | null) => void>();
  readonly #options: Required<Omit<MemoryLinkOptions, 'timers' | 'random'>> & {
    timers: Timers;
    random: () => number;
  };

  private constructor(options: MemoryLinkOptions) {
    const delayMs = options.delayMs ?? 0;
    this.#options = {
      delayMs,
      jitterMs: options.jitterMs ?? 0,
      loss: options.loss ?? 0,
      retransmitMs: options.retransmitMs ?? Math.max(100, 3 * delayMs),
      bytesPerSecond: options.bytesPerSecond ?? Infinity,
      maxMessageSize: options.maxMessageSize ?? null,
      timers: options.timers ?? REAL_TIMERS,
      random: options.random ?? Math.random,
    };
  }

  /** Two ends joined: what one sends, the other receives. */
  static pair(options: MemoryLinkOptions = {}): [MemoryTransport, MemoryTransport] {
    const a = new MemoryTransport(options);
    const b = new MemoryTransport(options);
    a.#peer = b;
    b.#peer = a;
    return [a, b];
  }

  get state(): TransportState {
    return this.#state;
  }

  get bufferedAmount(): number {
    return this.#bufferedAmount;
  }

  get maxMessageSize(): number | null {
    return this.#options.maxMessageSize;
  }

  send(frame: WireFrame): void {
    if (this.#state !== 'open') {
      throw new Error(`The transport is ${this.#state}.`);
    }
    const bytes = typeof frame === 'string' ? new TextEncoder().encode(frame).length : frame.length;
    if (this.#options.maxMessageSize !== null && bytes > this.#options.maxMessageSize) {
      throw new Error(
        `A frame of ${String(bytes)} bytes: the channel takes at most ${String(this.#options.maxMessageSize)}.`,
      );
    }
    this.stats.frames++;
    this.stats.bytes += bytes;
    this.#queue.push({ frame, bytes });
    this.#bufferedAmount += bytes;
    this.stats.maxBuffered = Math.max(this.stats.maxBuffered, this.#bufferedAmount);
    this.#drain();
  }

  onFrame(next: (frame: WireFrame) => void): () => void {
    this.#frameHandlers.add(next);
    return () => {
      this.#frameHandlers.delete(next);
    };
  }

  onBufferedAmountLow(next: () => void): () => void {
    this.#lowHandlers.add(next);
    return () => {
      this.#lowHandlers.delete(next);
    };
  }

  onStateChange(next: (state: TransportState, reason: string | null) => void): () => void {
    this.#stateHandlers.add(next);
    return () => {
      this.#stateHandlers.delete(next);
    };
  }

  close(reason = 'closed'): void {
    if (this.#state !== 'open') {
      return;
    }
    const peer = this.#peer;
    this.#end('closed', reason);
    if (peer !== null) {
      peer.#end('closed', `the other end closed: ${reason}`);
    }
  }

  /** Ends this transport, dropping its queue; the frames on their way never arrive. */
  #end(state: TransportState, reason: string): void {
    if (this.#state !== 'open') {
      return;
    }
    this.#state = state;
    this.#queue.length = 0;
    this.#bufferedAmount = 0;
    for (const handler of [...this.#stateHandlers]) {
      handler(state, reason);
    }
  }

  /** Sends the queue's head into the network after its transmission time, then the next. */
  #drain(): void {
    if (this.#draining || this.#queue.length === 0 || this.#state !== 'open') {
      return;
    }
    this.#draining = true;
    const head = this.#queue[0];
    const { bytesPerSecond, timers } = this.#options;
    const transmitMs = bytesPerSecond === Infinity ? 0 : (head.bytes / bytesPerSecond) * 1000;
    timers.setTimeout(() => {
      this.#draining = false;
      if (this.#state !== 'open' || this.#queue[0] !== head) {
        return;
      }
      this.#queue.shift();
      const before = this.#bufferedAmount;
      this.#bufferedAmount -= head.bytes;
      this.#hand(head);
      this.#drain();
      if (
        before > this.bufferedAmountLowThreshold &&
        this.#bufferedAmount <= this.bufferedAmountLowThreshold
      ) {
        for (const handler of [...this.#lowHandlers]) {
          handler();
        }
      }
    }, transmitMs);
  }

  /** Hands a frame to the network: it reaches the peer after the delay, in order, late when lost. */
  #hand(queued: Queued): void {
    const peer = this.#peer;
    if (peer === null) {
      return;
    }
    const { delayMs, jitterMs, loss, retransmitMs, random, timers } = this.#options;
    const lost = loss > 0 && random() < loss;
    if (lost) {
      this.stats.retransmitted++;
    }
    const jitter = jitterMs > 0 ? random() * jitterMs : 0;
    const now = timers.now();
    const arrival = Math.max(
      this.#lastArrivalMs,
      now + delayMs + jitter + (lost ? retransmitMs : 0),
    );
    this.#lastArrivalMs = arrival;
    const transformed = this.transform === null ? queued.frame : this.transform(queued.frame);
    if (transformed === null) {
      return;
    }
    timers.setTimeout(() => {
      peer.#receive(transformed);
    }, arrival - now);
  }

  #receive(frame: WireFrame): void {
    if (this.#state !== 'open') {
      return;
    }
    for (const handler of [...this.#frameHandlers]) {
      handler(frame);
    }
  }
}
