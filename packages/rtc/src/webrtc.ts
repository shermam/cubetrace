// The transport over a real peer connection (docs/RTC.md, docs/PLAN.md T4.0): an RTCPeerConnection
// with Google's public STUN server and no TURN (the two devices are on one Wi-Fi), one reliable
// ordered data channel, and the offer, the answer and the candidates exchanged through a Signaling.
// Either role: the caller (the phone) makes the channel and the offer; the callee (the host) takes
// the offer, answers, and receives the channel. When the connection fails, the caller restarts ICE,
// which brings a new offer through the same signaling, and the callee answers it. This file alone in
// the package touches the browser's WebRTC API: the unit tests never load it (the end-to-end suite
// of T4.1 covers it), and the fakes stand in for it everywhere else.
import type { SessionDescription } from '@cubetrace/core';

import type { WireFrame } from './protocol';
import type { Signaling } from './signaling';
import { REAL_TIMERS, type Timers, type Transport, type TransportState } from './transport';

/** Google's public STUN server, the one ICE server (docs/PLAN.md, phase 4's decisions). */
export const STUN_SERVERS: readonly string[] = ['stun:stun.l.google.com:19302'];

/** The data channel's label. */
export const DATA_CHANNEL_LABEL = 'cubetrace';

/** How long `connect` waits for the channel to open before it gives up. */
export const CONNECT_TIMEOUT_MS = 30_000;

export interface WebRtcTransportOptions {
  signaling: Signaling;
  /** The peer connection's configuration; by default the STUN server above. */
  configuration?: RTCConfiguration;
  /** Makes the peer connection; `new RTCPeerConnection(configuration)` by default. */
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  timers?: Timers;
  timeoutMs?: number;
}

/**
 * A {@link Transport} over an RTCDataChannel. {@link WebRtcTransport.connect} runs the signaling
 * dance for the signaling's role and resolves once the channel is open.
 */
export class WebRtcTransport implements Transport {
  readonly #pc: RTCPeerConnection;
  readonly #signaling: Signaling;
  readonly #timers: Timers;
  #channel: RTCDataChannel | null = null;
  #state: TransportState = 'connecting';
  #reason: string | null = null;
  /** Candidates that came before the remote description, held until it is set. */
  #heldCandidates: RTCIceCandidateInit[] = [];
  #remoteSet = false;
  readonly #frameHandlers = new Set<(frame: WireFrame) => void>();
  readonly #lowHandlers = new Set<() => void>();
  readonly #stateHandlers = new Set<(state: TransportState, reason: string | null) => void>();
  readonly #off: (() => void)[] = [];
  /** Settles `connect`. */
  #opened: (() => void) | null = null;
  #failed: ((error: Error) => void) | null = null;

  private constructor(options: WebRtcTransportOptions) {
    const configuration = options.configuration ?? {
      iceServers: [{ urls: [...STUN_SERVERS] }],
    };
    this.#pc = (options.createPeerConnection ?? ((c) => new RTCPeerConnection(c)))(configuration);
    this.#signaling = options.signaling;
    this.#timers = options.timers ?? REAL_TIMERS;
  }

  /**
   * Connects for the signaling's role and resolves with the transport once its data channel is open;
   * rejects when the connection failed or closed before, or after `timeoutMs`.
   */
  static connect(options: WebRtcTransportOptions): Promise<WebRtcTransport> {
    const transport = new WebRtcTransport(options);
    return transport.#connect(options.timeoutMs ?? CONNECT_TIMEOUT_MS);
  }

  get state(): TransportState {
    return this.#state;
  }

  /** The peer connection, for the preview track of T4.3 and the diagnostics. */
  get peerConnection(): RTCPeerConnection {
    return this.#pc;
  }

  get bufferedAmount(): number {
    return this.#channel?.bufferedAmount ?? 0;
  }

  get bufferedAmountLowThreshold(): number {
    return this.#channel?.bufferedAmountLowThreshold ?? 0;
  }

  set bufferedAmountLowThreshold(value: number) {
    if (this.#channel !== null) {
      this.#channel.bufferedAmountLowThreshold = value;
    }
  }

  get maxMessageSize(): number | null {
    const size = this.#pc.sctp?.maxMessageSize;
    return size === undefined || !Number.isFinite(size) || size <= 0 ? null : size;
  }

  send(frame: WireFrame): void {
    if (this.#state !== 'open' || this.#channel === null) {
      throw new Error(`The transport is ${this.#state}.`);
    }
    if (typeof frame === 'string') {
      this.#channel.send(frame);
    } else {
      // A copy whose buffer is exactly the frame, as the channel takes a whole buffer.
      this.#channel.send(frame.slice().buffer);
    }
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
    this.#end('closed', reason);
  }

  async #connect(timeoutMs: number): Promise<WebRtcTransport> {
    const pc = this.#pc;
    const signaling = this.#signaling;
    const opened = new Promise<void>((resolve, reject) => {
      this.#opened = resolve;
      this.#failed = reject;
    });
    const timer = this.#timers.setTimeout(() => {
      this.#end('failed', `the connection did not open within ${String(timeoutMs / 1000)} s`);
    }, timeoutMs);
    pc.onicecandidate = (event) => {
      if (event.candidate !== null) {
        const { candidate, sdpMid, sdpMLineIndex } = event.candidate.toJSON();
        void signaling
          .sendCandidate({
            candidate: candidate ?? '',
            sdpMid: sdpMid ?? null,
            sdpMLineIndex: sdpMLineIndex ?? null,
          })
          .catch((error: unknown) => {
            this.#end('failed', `a candidate could not be sent: ${String(error)}`);
          });
      }
    };
    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'failed':
          if (signaling.role === 'caller') {
            // An ICE restart: a new offer through the signaling, which the callee answers.
            pc.restartIce();
          }
          break;
        case 'closed':
          this.#end('closed', 'the peer connection closed');
          break;
        default:
          break;
      }
    };
    if (signaling.role === 'caller') {
      this.#attach(pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));
      pc.onnegotiationneeded = () => {
        void this.#offer();
      };
    } else {
      pc.ondatachannel = (event) => {
        this.#attach(event.channel);
      };
    }
    this.#off.push(
      signaling.onDescription((description) => {
        void this.#remoteDescription(description);
      }),
      signaling.onCandidate((candidate) => {
        void this.#remoteCandidate(candidate);
      }),
      signaling.onClosed((reason) => {
        this.#end('closed', `the signaling closed: ${reason}`);
      }),
    );
    try {
      await opened;
    } finally {
      this.#timers.clearTimeout(timer);
    }
    return this;
  }

  /** The caller's offer: made, set, sent. */
  async #offer(): Promise<void> {
    try {
      const offer = await this.#pc.createOffer();
      await this.#pc.setLocalDescription(offer);
      await this.#signaling.sendDescription({ type: 'offer', sdp: offer.sdp ?? '' });
    } catch (error: unknown) {
      this.#end('failed', `the offer could not be made: ${String(error)}`);
    }
  }

  /** The other side's description: the callee answers an offer, the caller takes the answer. */
  async #remoteDescription(description: SessionDescription): Promise<void> {
    try {
      await this.#pc.setRemoteDescription(description);
      this.#remoteSet = true;
      const held = this.#heldCandidates;
      this.#heldCandidates = [];
      for (const candidate of held) {
        await this.#pc.addIceCandidate(candidate);
      }
      if (description.type === 'offer') {
        const answer = await this.#pc.createAnswer();
        await this.#pc.setLocalDescription(answer);
        await this.#signaling.sendDescription({ type: 'answer', sdp: answer.sdp ?? '' });
      }
    } catch (error: unknown) {
      this.#end('failed', `the ${description.type} could not be taken: ${String(error)}`);
    }
  }

  async #remoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.#remoteSet) {
      this.#heldCandidates.push(candidate);
      return;
    }
    try {
      await this.#pc.addIceCandidate(candidate);
    } catch {
      // A candidate of an older session description after an ICE restart: harmless.
    }
  }

  #attach(channel: RTCDataChannel): void {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      this.#setState('open', null);
      this.#opened?.();
    };
    channel.onclose = () => {
      this.#end('closed', 'the data channel closed');
    };
    channel.onerror = (event) => {
      const error: unknown = Reflect.get(event, 'error');
      this.#end('failed', `the data channel failed: ${String(error)}`);
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      const frame: WireFrame | null =
        typeof data === 'string' ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
      if (frame === null) {
        return;
      }
      for (const handler of [...this.#frameHandlers]) {
        handler(frame);
      }
    };
    channel.onbufferedamountlow = () => {
      for (const handler of [...this.#lowHandlers]) {
        handler();
      }
    };
  }

  #setState(state: TransportState, reason: string | null): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#reason = reason;
    for (const handler of [...this.#stateHandlers]) {
      handler(state, reason);
    }
  }

  #end(state: 'closed' | 'failed', reason: string): void {
    if (this.#state === 'closed' || this.#state === 'failed') {
      return;
    }
    for (const off of this.#off) {
      off();
    }
    this.#off.length = 0;
    this.#channel?.close();
    this.#pc.close();
    this.#setState(state, reason);
    this.#failed?.(new Error(`The connection ${state}: ${reason}.`));
    this.#opened = null;
    this.#failed = null;
    void this.#signaling.close().catch(() => undefined);
  }

  /** Why the transport closed or failed; null while it has not. */
  get reason(): string | null {
    return this.#reason;
  }
}
