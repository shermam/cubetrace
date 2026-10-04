// Fakes of the connection for the unit tests of the remote cameras' services (T4.1): a connector
// that joins the host's and the phone's `connect` in memory after a stand-in for the SDP dance over
// the signaling, and the timers of the tests as @cubetrace/rtc's `Timers`. Nothing in the app
// imports this file, so it is not in the bundle.
import {
  CONNECT_TIMEOUT_MS,
  MemoryTransport,
  REAL_TIMERS,
  type MemoryLinkOptions,
  type Signaling,
  type Timers,
} from '@cubetrace/rtc';

import type { FakePerformance, FakeTimers } from '../device/fake-browser';
import type { TransportConnector } from './transport-connector';

/** The test's clock and timers (fake-browser.ts) as the connection's `Timers`. */
export function rtcTimers(perf: FakePerformance, timers: FakeTimers): Timers {
  return {
    now: () => perf.hostMs,
    setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      timers.clearTimeout(handle as number);
    },
  };
}

/** A connection made through {@link MemoryConnector}: which peer, which role, its end. */
export interface MemoryConnection {
  readonly peerId: string;
  readonly role: Signaling['role'];
  readonly transport: MemoryTransport;
}

/**
 * Joins the two sides of each peer connection in memory, as `WebRtcTransport.connect` would over
 * the network: the caller sends its offer through its signaling and waits for the answer, the callee
 * takes the offer and answers, and each side resolves with its end of a `MemoryTransport` pair of the
 * peer (made by whichever side comes first); a side that waits longer than `WebRtcTransport`'s
 * timeout (30 s, on the options' timers) fails, as a connection that could not be made. `failNext`
 * makes the next `connect` reject at once (the next of `failRole`'s, when it is set).
 */
export class MemoryConnector {
  readonly connections: MemoryConnection[] = [];
  /** The next `connect` rejects with this, once. */
  failNext: Error | null = null;
  /** Only the next `connect` of this role rejects with {@link failNext}; null: whichever comes. */
  failRole: Signaling['role'] | null = null;
  private readonly pairs = new Map<string, MemoryTransport[]>();

  constructor(private readonly options: MemoryLinkOptions = {}) {}

  readonly connect: TransportConnector = async (signaling) => {
    const failure = this.failNext;
    if (failure !== null && (this.failRole === null || this.failRole === signaling.role)) {
      this.failNext = null;
      await signaling.close();
      throw failure;
    }
    // The other side closed the documents before the connection was made, or never answered: it
    // fails, as WebRtcTransport's does.
    const timers = this.options.timers ?? REAL_TIMERS;
    let timer: unknown = null;
    const closed = new Promise<never>((_, reject) => {
      signaling.onClosed((reason) => {
        reject(new Error(`The connection closed: the signaling closed: ${reason}.`));
      });
      timer = timers.setTimeout(() => {
        void signaling.close().catch(() => undefined);
        reject(
          new Error(
            `The connection failed: the connection did not open within ${String(CONNECT_TIMEOUT_MS / 1000)} s.`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
    });
    // A closing after the connection was made is the transport's business, not a rejection nobody hears.
    closed.catch(() => undefined);
    const settled = (): void => {
      timers.clearTimeout(timer);
    };
    try {
      await this.dance(signaling, closed);
    } finally {
      settled();
    }
    const transport = this.end(signaling.peerId);
    const connection = { peerId: signaling.peerId, role: signaling.role, transport };
    this.connections.push(connection);
    // The transport closes its signaling when it ends, as WebRtcTransport does.
    transport.onStateChange((state) => {
      if (state === 'closed' || state === 'failed') {
        void signaling.close().catch(() => undefined);
      }
    });
    return transport;
  };

  /** The offer and the answer over the signaling, for the role; `closed` ends it early. */
  private async dance(signaling: Signaling, closed: Promise<never>): Promise<void> {
    if (signaling.role === 'caller') {
      const answered = new Promise<void>((resolve) => {
        const off = signaling.onDescription((description) => {
          if (description.type === 'answer') {
            off();
            resolve();
          }
        });
      });
      await signaling.sendDescription({ type: 'offer', sdp: `v=0 offer of ${signaling.peerId}` });
      await signaling
        .sendCandidate({
          candidate: 'candidate:1 1 udp 1 10.0.0.2 1 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        })
        .catch(() => undefined);
      await Promise.race([answered, closed]);
    } else {
      await Promise.race([
        new Promise<void>((resolve) => {
          const off = signaling.onDescription((description) => {
            if (description.type === 'offer') {
              off();
              resolve();
            }
          });
        }),
        closed,
      ]);
      await signaling.sendDescription({ type: 'answer', sdp: `v=0 answer to ${signaling.peerId}` });
      await signaling
        .sendCandidate({
          candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        })
        .catch(() => undefined);
    }
  }

  /** The last connection made for `role`. */
  last(role: Signaling['role']): MemoryConnection {
    const found = [...this.connections].reverse().find((connection) => connection.role === role);
    if (found === undefined) {
      throw new Error(`No ${role} connected.`);
    }
    return found;
  }

  private end(peerId: string): MemoryTransport {
    let ends = this.pairs.get(peerId);
    if (ends === undefined || ends.length === 0) {
      ends = MemoryTransport.pair(this.options);
      this.pairs.set(peerId, ends);
    }
    const end = ends.shift();
    if (end === undefined) {
      throw new Error(`Both ends of ${peerId} are taken.`);
    }
    return end;
  }
}
