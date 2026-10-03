// The signaling of a peer connection (docs/RTC.md, docs/DATA-MODEL.md §10, docs/PLAN.md T4.0): how
// the phone's offer, the host's answer and both sides' ICE candidates reach the other device before
// the data channel exists. The FirebaseRTC pattern on Firestore: the phone (the caller) creates
// `sessions/{id}/peers/{peerId}` with its offer; the host (the callee) watches the session's peers,
// answers in the same document, and each side adds its candidates to its subcollection and watches
// the other's. The Firestore calls themselves are the account backend's (the app's
// `AccountBackend`, which implements SignalingBackend); an in-memory backend stands in for it in the
// tests, where MemorySignaling joins the two sides. Plain TypeScript: no browser API.
import {
  cloudCandidate,
  cloudPeer,
  parseCloudCandidate,
  parseCloudPeer,
  parseSessionPairing,
  type CandidateSide,
  type CloudCandidate,
  type CloudPeer,
  type SessionDescription,
  type SessionPairing,
} from '@cubetrace/core';

import { PAIRING_TTL_MS, checkPairing, hashToken, pairingOf, type PairingRefusal } from './pairing';
import { REAL_TIMERS } from './transport';

/** Which side of the connection a signaling channel is: the phone calls, the host answers. */
export type SignalingRole = 'caller' | 'callee';

/** An ICE candidate as the browser gives and takes it (`RTCIceCandidateInit`). */
export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * One peer connection's signaling path, for one role: the way a description and the candidates
 * reach the other side, and the other side's reach this one. A WebRtcTransport is made with one.
 */
export interface Signaling {
  readonly role: SignalingRole;
  readonly peerId: string;
  /** Sends this side's description: the offer (the caller's) or the answer (the callee's). */
  sendDescription(description: SessionDescription): Promise<void>;
  sendCandidate(candidate: IceCandidate): Promise<void>;
  /**
   * Calls `next` with the other side's description: the one known when `next` subscribes, if any,
   * and each new one (an ICE restart's new offer, its new answer).
   */
  onDescription(next: (description: SessionDescription) => void): () => void;
  /** Calls `next` with each of the other side's candidates, the ones already there first. */
  onCandidate(next: (candidate: IceCandidate) => void): () => void;
  /** Calls `next` once when the other side closed the pairing, or the documents are gone. */
  onClosed(next: (reason: string) => void): () => void;
  /** Calls `next` with each error of the backend's watchers. */
  onError(next: (error: unknown) => void): () => void;
  /** Ends this side's part: the caller marks the peer closed, the callee deletes its documents. */
  close(): Promise<void>;
}

/** A document as the backend gives it: its id and its fields, unchecked. */
export interface SignalingDocument {
  readonly id: string;
  readonly data: unknown;
}

/**
 * The few Firestore calls the signaling makes, which the app's AccountBackend implements with the
 * SDK (docs/DATA-MODEL.md §10 has the documents) and {@link MemorySignalingBackend} in memory.
 * Every watcher calls `next` with the current documents once it has them, then at each change,
 * until the returned function is called; `error` when it cannot (the rules, the network).
 */
export interface SignalingBackend {
  /** `sessions/{id}`; null when there is none. */
  getSession(sessionId: string): Promise<SignalingDocument | null>;
  /** Merges `pairing` into `sessions/{id}` (null closes the pairing). */
  writePairing(sessionId: string, pairing: SessionPairing | null): Promise<void>;
  /** Creates `sessions/{id}/peers/{peerId}` whole. */
  createPeer(sessionId: string, peerId: string, peer: CloudPeer): Promise<void>;
  /** Changes the given fields of `sessions/{id}/peers/{peerId}`, which must exist. */
  updatePeer(sessionId: string, peerId: string, fields: Partial<CloudPeer>): Promise<void>;
  /** Deletes `sessions/{id}/peers/{peerId}` with both of its candidate collections. */
  deletePeer(sessionId: string, peerId: string): Promise<void>;
  /** The peers of the session owned by `uid` (`where('owner', '==', uid)`), as they change. */
  watchPeers(
    sessionId: string,
    uid: string,
    next: (peers: readonly SignalingDocument[]) => void,
    error: (error: unknown) => void,
  ): () => void;
  /** One peer's document as it changes; null once it is deleted. */
  watchPeer(
    sessionId: string,
    peerId: string,
    next: (peer: SignalingDocument | null) => void,
    error: (error: unknown) => void,
  ): () => void;
  /** Adds a candidate to the peer's collection of `side`, under an id of the backend's choosing. */
  addCandidate(
    sessionId: string,
    peerId: string,
    side: CandidateSide,
    candidate: CloudCandidate,
  ): Promise<void>;
  /** The candidates of `side` of the peer, every one so far, as they are added. */
  watchCandidates(
    sessionId: string,
    peerId: string,
    side: CandidateSide,
    next: (candidates: readonly SignalingDocument[]) => void,
    error: (error: unknown) => void,
  ): () => void;
}

/** A phone's offer as the host's watcher gives it: the peer document, and the host's side of it. */
export interface IncomingOffer {
  readonly peerId: string;
  readonly peer: CloudPeer;
  /** The host's (callee's) signaling with this peer. */
  readonly signaling: Signaling;
}

/** What {@link FirestoreSignaling.checkPairing} says of a token: taken, or why not. */
export type PairingCheck = 'ok' | 'no-session' | PairingRefusal;

/**
 * The signaling of one session over a backend, for either device: the host publishes the pairing
 * and watches for offers; the phone checks the pairing and calls. Each call gives a {@link Signaling}
 * for one peer connection.
 */
export class FirestoreSignaling {
  readonly #backend: SignalingBackend;
  readonly #sessionId: string;
  readonly #uid: string;
  readonly #now: () => number;

  constructor(
    backend: SignalingBackend,
    options: { sessionId: string; uid: string; now?: () => number },
  ) {
    this.#backend = backend;
    this.#sessionId = options.sessionId;
    this.#uid = options.uid;
    this.#now = options.now ?? (() => REAL_TIMERS.now());
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  // ---- The host ----

  /** Publishes the hash of `token` in the session's document, good for `ttlMs`; gives the pairing. */
  async publishPairing(token: string, ttlMs: number = PAIRING_TTL_MS): Promise<SessionPairing> {
    const pairing = await pairingOf(token, this.#now(), ttlMs);
    await this.#backend.writePairing(this.#sessionId, pairing);
    return pairing;
  }

  /** Closes the pairing: no token is taken until the next `publishPairing`. */
  closePairing(): Promise<void> {
    return this.#backend.writePairing(this.#sessionId, null);
  }

  /**
   * Watches the session's peers and calls `next` once for each peer that offers (a document in the
   * `offered` state with an offer), with the host's side of its signaling; the host checks the
   * peer's `tokenHash` against its pairing before answering. A document that is not a peer is
   * reported to `error` and skipped.
   */
  watchOffers(next: (offer: IncomingOffer) => void, error: (error: unknown) => void): () => void {
    const seen = new Set<string>();
    return this.#backend.watchPeers(
      this.#sessionId,
      this.#uid,
      (documents) => {
        for (const document of documents) {
          if (seen.has(document.id)) {
            continue;
          }
          let peer: CloudPeer;
          try {
            peer = parseCloudPeer(document.data);
          } catch (problem: unknown) {
            seen.add(document.id);
            error(problem);
            continue;
          }
          if (peer.state !== 'offered' || peer.offer === null) {
            continue;
          }
          seen.add(document.id);
          next({ peerId: document.id, peer, signaling: this.#channel('callee', document.id) });
        }
      },
      error,
    );
  }

  // ---- The phone ----

  /**
   * Whether the session takes `token` now: its document's `pairing` must hold the token's hash and
   * not have expired. Only `pairing` is read of the document (a record of another version still
   * pairs); one that is not a pairing counts as none.
   */
  async checkPairing(token: string): Promise<PairingCheck> {
    const document = await this.#backend.getSession(this.#sessionId);
    if (document === null) {
      return 'no-session';
    }
    const data: unknown = document.data;
    let pairing: SessionPairing | null;
    try {
      pairing = parseSessionPairing(
        typeof data === 'object' && data !== null ? Reflect.get(data, 'pairing') : undefined,
      );
    } catch {
      pairing = null;
    }
    return checkPairing(pairing, await hashToken(token), this.#now()) ?? 'ok';
  }

  /**
   * The phone's side of a new peer connection: its first `sendDescription` creates the peer document
   * with the offer and the token's hash, a later one (an ICE restart) replaces the offer.
   */
  call(options: { tokenHash: string; peerId?: string }): Signaling {
    return this.#channel('caller', options.peerId ?? crypto.randomUUID(), options.tokenHash);
  }

  #channel(role: SignalingRole, peerId: string, tokenHash = ''): Signaling {
    return new PeerSignaling(
      this.#backend,
      this.#sessionId,
      this.#uid,
      role,
      peerId,
      tokenHash,
      this.#now,
    );
  }
}

/** One side's signaling with one peer, over the backend. */
class PeerSignaling implements Signaling {
  readonly #backend: SignalingBackend;
  readonly #sessionId: string;
  readonly #uid: string;
  readonly #tokenHash: string;
  readonly #now: () => number;
  #created = false;
  /** `close` was called. */
  #closed = false;
  /** The other side ended it (left, or deleted the documents): the watchers are off. */
  #ended = false;
  /** The other side's last description delivered, by its SDP, so that a change is told from an echo. */
  #lastRemoteSdp: string | null = null;
  #remote: SessionDescription | null = null;
  readonly #seenCandidates = new Set<string>();
  readonly #candidates: IceCandidate[] = [];
  readonly #descriptionHandlers = new Set<(description: SessionDescription) => void>();
  readonly #candidateHandlers = new Set<(candidate: IceCandidate) => void>();
  readonly #closedHandlers = new Set<(reason: string) => void>();
  readonly #errorHandlers = new Set<(error: unknown) => void>();
  #watching: (() => void)[] | null = null;

  constructor(
    backend: SignalingBackend,
    sessionId: string,
    uid: string,
    readonly role: SignalingRole,
    readonly peerId: string,
    tokenHash: string,
    now: () => number,
  ) {
    this.#backend = backend;
    this.#sessionId = sessionId;
    this.#uid = uid;
    this.#tokenHash = tokenHash;
    this.#now = now;
    // The callee has a document to watch from the start; the caller once it has written its offer.
    if (role === 'callee') {
      this.#watch();
    }
  }

  async sendDescription(description: SessionDescription): Promise<void> {
    const { sessionId, peerId } = { sessionId: this.#sessionId, peerId: this.peerId };
    if (this.role === 'caller') {
      if (description.type !== 'offer') {
        throw new Error('The caller sends offers.');
      }
      if (!this.#created) {
        this.#created = true;
        await this.#backend.createPeer(
          sessionId,
          peerId,
          cloudPeer({
            owner: this.#uid,
            createdMs: this.#now(),
            tokenHash: this.#tokenHash,
            offer: description,
          }),
        );
        this.#watch();
        return;
      }
      // An ICE restart: the new offer replaces the old, and the old answer goes.
      await this.#backend.updatePeer(sessionId, peerId, {
        offer: { type: 'offer', sdp: description.sdp },
        answer: null,
        state: 'offered',
      });
      return;
    }
    if (description.type !== 'answer') {
      throw new Error('The callee sends answers.');
    }
    await this.#backend.updatePeer(sessionId, peerId, {
      answer: { type: 'answer', sdp: description.sdp },
      state: 'answered',
    });
  }

  sendCandidate(candidate: IceCandidate): Promise<void> {
    return this.#backend.addCandidate(
      this.#sessionId,
      this.peerId,
      this.role,
      cloudCandidate(candidate, this.#now()),
    );
  }

  onDescription(next: (description: SessionDescription) => void): () => void {
    this.#descriptionHandlers.add(next);
    const known = this.#remote;
    if (known !== null) {
      queueMicrotask(() => {
        if (this.#descriptionHandlers.has(next)) {
          next(known);
        }
      });
    }
    return () => {
      this.#descriptionHandlers.delete(next);
    };
  }

  onCandidate(next: (candidate: IceCandidate) => void): () => void {
    this.#candidateHandlers.add(next);
    const known = [...this.#candidates];
    if (known.length > 0) {
      queueMicrotask(() => {
        for (const candidate of known) {
          if (this.#candidateHandlers.has(next)) {
            next(candidate);
          }
        }
      });
    }
    return () => {
      this.#candidateHandlers.delete(next);
    };
  }

  onClosed(next: (reason: string) => void): () => void {
    this.#closedHandlers.add(next);
    return () => {
      this.#closedHandlers.delete(next);
    };
  }

  onError(next: (error: unknown) => void): () => void {
    this.#errorHandlers.add(next);
    return () => {
      this.#errorHandlers.delete(next);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unwatch();
    if (this.role === 'callee') {
      // The host is done with the peer, whether it left or not: its documents go.
      await this.#backend.deletePeer(this.#sessionId, this.peerId);
    } else if (this.#created && !this.#ended) {
      try {
        await this.#backend.updatePeer(this.#sessionId, this.peerId, { state: 'closed' });
      } catch {
        // The host deleted the documents already: nothing to mark.
      }
    }
  }

  #watch(): void {
    if (this.#watching !== null) {
      return;
    }
    const otherSide: CandidateSide = this.role === 'caller' ? 'callee' : 'caller';
    const error = (problem: unknown): void => {
      for (const handler of [...this.#errorHandlers]) {
        handler(problem);
      }
    };
    this.#watching = [
      this.#backend.watchPeer(
        this.#sessionId,
        this.peerId,
        (document) => {
          this.#peerChanged(document);
        },
        error,
      ),
      this.#backend.watchCandidates(
        this.#sessionId,
        this.peerId,
        otherSide,
        (documents) => {
          for (const document of documents) {
            if (this.#seenCandidates.has(document.id)) {
              continue;
            }
            this.#seenCandidates.add(document.id);
            let candidate: CloudCandidate;
            try {
              candidate = parseCloudCandidate(document.data);
            } catch (problem: unknown) {
              error(problem);
              continue;
            }
            const { candidate: line, sdpMid, sdpMLineIndex } = candidate;
            const init: IceCandidate = { candidate: line, sdpMid, sdpMLineIndex };
            this.#candidates.push(init);
            for (const handler of [...this.#candidateHandlers]) {
              handler(init);
            }
          }
        },
        error,
      ),
    ];
  }

  #unwatch(): void {
    for (const off of this.#watching ?? []) {
      off();
    }
    this.#watching = null;
  }

  #peerChanged(document: SignalingDocument | null): void {
    if (this.#closed || this.#ended) {
      return;
    }
    if (document === null) {
      this.#end('the documents are gone');
      return;
    }
    let peer: CloudPeer;
    try {
      peer = parseCloudPeer(document.data);
    } catch (problem: unknown) {
      for (const handler of [...this.#errorHandlers]) {
        handler(problem);
      }
      return;
    }
    if (peer.state === 'closed') {
      this.#end('the other side left');
      return;
    }
    const remote = this.role === 'caller' ? peer.answer : peer.offer;
    if (remote !== null && remote.sdp !== this.#lastRemoteSdp) {
      this.#lastRemoteSdp = remote.sdp;
      this.#remote = remote;
      for (const handler of [...this.#descriptionHandlers]) {
        handler(remote);
      }
    }
  }

  #end(reason: string): void {
    this.#ended = true;
    this.#unwatch();
    for (const handler of [...this.#closedHandlers]) {
      handler(reason);
    }
  }
}

type Watcher<T> = (value: T) => void;

/**
 * A {@link SignalingBackend} in memory: the documents in maps, the watchers told asynchronously (as
 * Firestore's snapshots come), the writes listed for the tests. Two FirestoreSignaling over one
 * backend are two devices of one account.
 */
export class MemorySignalingBackend implements SignalingBackend {
  /** `sessions/{id}`, by id: whatever a test seeds, plus the pairing written. */
  readonly sessions = new Map<string, Record<string, unknown>>();
  /** `sessions/{id}/peers/{peerId}`, by session id then peer id. */
  readonly peers = new Map<string, Map<string, CloudPeer>>();
  /** The candidates, by `sessionId/peerId/side`, then by document id. */
  readonly candidates = new Map<string, Map<string, CloudCandidate>>();
  /** Every write, in order: `pairing <session>`, `create <session>/<peer>`, `update …`, `delete …`, `candidate <session>/<peer>/<side>`. */
  readonly writes: string[] = [];
  /** Set: every write fails with it (the rules refuse it, the network is gone). */
  writeError: Error | null = null;
  /** Set: every watcher reports it instead of its documents (the rules refuse the read). */
  readError: Error | null = null;
  readonly #peerWatchers = new Map<string, Set<Watcher<readonly SignalingDocument[]>>>();
  readonly #oneWatchers = new Map<string, Set<Watcher<SignalingDocument | null>>>();
  readonly #candidateWatchers = new Map<string, Set<Watcher<readonly SignalingDocument[]>>>();
  #nextCandidate = 1;

  /** Seeds `sessions/{id}` (a test's session document). */
  seedSession(sessionId: string, data: Record<string, unknown>): void {
    this.sessions.set(sessionId, structuredClone(data));
  }

  getSession(sessionId: string): Promise<SignalingDocument | null> {
    const data = this.sessions.get(sessionId);
    return Promise.resolve(
      data === undefined ? null : { id: sessionId, data: structuredClone(data) },
    );
  }

  writePairing(sessionId: string, pairing: SessionPairing | null): Promise<void> {
    return this.#write(`pairing ${sessionId}`, () => {
      const session = this.sessions.get(sessionId);
      if (session === undefined) {
        throw new Error(`No session ${sessionId} to write the pairing into.`);
      }
      session['pairing'] = pairing === null ? null : { ...pairing };
    });
  }

  createPeer(sessionId: string, peerId: string, peer: CloudPeer): Promise<void> {
    return this.#write(`create ${sessionId}/${peerId}`, () => {
      let peers = this.peers.get(sessionId);
      if (peers === undefined) {
        peers = new Map();
        this.peers.set(sessionId, peers);
      }
      if (peers.has(peerId)) {
        throw new Error(`The peer ${peerId} exists.`);
      }
      peers.set(peerId, structuredClone(peer));
      this.#firePeer(sessionId, peerId);
    });
  }

  updatePeer(sessionId: string, peerId: string, fields: Partial<CloudPeer>): Promise<void> {
    return this.#write(
      `update ${sessionId}/${peerId} ${Object.keys(fields).sort().join(',')}`,
      () => {
        const peer = this.peers.get(sessionId)?.get(peerId);
        if (peer === undefined) {
          throw new Error(`No peer ${peerId} to update.`);
        }
        Object.assign(peer, structuredClone(fields));
        this.#firePeer(sessionId, peerId);
      },
    );
  }

  deletePeer(sessionId: string, peerId: string): Promise<void> {
    return this.#write(`delete ${sessionId}/${peerId}`, () => {
      this.peers.get(sessionId)?.delete(peerId);
      for (const side of ['caller', 'callee'] as const) {
        this.candidates.delete(`${sessionId}/${peerId}/${side}`);
      }
      this.#firePeer(sessionId, peerId);
    });
  }

  watchPeers(
    sessionId: string,
    uid: string,
    next: Watcher<readonly SignalingDocument[]>,
    error: (error: unknown) => void,
  ): () => void {
    const own: Watcher<readonly SignalingDocument[]> = (documents) => {
      next(documents.filter((document) => (document.data as CloudPeer).owner === uid));
    };
    return this.#subscribe(this.#peerWatchers, sessionId, own, error, () =>
      this.#peersOf(sessionId),
    );
  }

  watchPeer(
    sessionId: string,
    peerId: string,
    next: Watcher<SignalingDocument | null>,
    error: (error: unknown) => void,
  ): () => void {
    return this.#subscribe(this.#oneWatchers, `${sessionId}/${peerId}`, next, error, () =>
      this.#peerOf(sessionId, peerId),
    );
  }

  addCandidate(
    sessionId: string,
    peerId: string,
    side: CandidateSide,
    candidate: CloudCandidate,
  ): Promise<void> {
    const key = `${sessionId}/${peerId}/${side}`;
    return this.#write(`candidate ${key}`, () => {
      if (this.peers.get(sessionId)?.get(peerId) === undefined) {
        throw new Error(`No peer ${peerId} to add a candidate to.`);
      }
      let candidates = this.candidates.get(key);
      if (candidates === undefined) {
        candidates = new Map();
        this.candidates.set(key, candidates);
      }
      candidates.set(`c${String(this.#nextCandidate++)}`, structuredClone(candidate));
      this.#fire(this.#candidateWatchers, key, () => this.#candidatesOf(key));
    });
  }

  watchCandidates(
    sessionId: string,
    peerId: string,
    side: CandidateSide,
    next: Watcher<readonly SignalingDocument[]>,
    error: (error: unknown) => void,
  ): () => void {
    const key = `${sessionId}/${peerId}/${side}`;
    return this.#subscribe(this.#candidateWatchers, key, next, error, () =>
      this.#candidatesOf(key),
    );
  }

  #write(what: string, apply: () => void): Promise<void> {
    if (this.writeError !== null) {
      return Promise.reject(this.writeError);
    }
    try {
      apply();
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.writes.push(what);
    return Promise.resolve();
  }

  #peersOf(sessionId: string): SignalingDocument[] {
    return [...(this.peers.get(sessionId) ?? new Map<string, CloudPeer>())].map(([id, peer]) => ({
      id,
      data: structuredClone(peer),
    }));
  }

  #peerOf(sessionId: string, peerId: string): SignalingDocument | null {
    const peer = this.peers.get(sessionId)?.get(peerId);
    return peer === undefined ? null : { id: peerId, data: structuredClone(peer) };
  }

  #candidatesOf(key: string): SignalingDocument[] {
    return [...(this.candidates.get(key) ?? new Map<string, CloudCandidate>())].map(
      ([id, candidate]) => ({ id, data: structuredClone(candidate) }),
    );
  }

  #firePeer(sessionId: string, peerId: string): void {
    this.#fire(this.#peerWatchers, sessionId, () => this.#peersOf(sessionId));
    this.#fire(this.#oneWatchers, `${sessionId}/${peerId}`, () => this.#peerOf(sessionId, peerId));
  }

  #subscribe<T>(
    watchers: Map<string, Set<Watcher<T>>>,
    key: string,
    next: Watcher<T>,
    error: (error: unknown) => void,
    current: () => T,
  ): () => void {
    const refused = this.readError;
    if (refused !== null) {
      queueMicrotask(() => {
        error(refused);
      });
      return () => undefined;
    }
    let set = watchers.get(key);
    if (set === undefined) {
      set = new Set();
      watchers.set(key, set);
    }
    set.add(next);
    queueMicrotask(() => {
      if (set.has(next)) {
        next(current());
      }
    });
    return () => {
      set.delete(next);
    };
  }

  #fire<T>(watchers: Map<string, Set<Watcher<T>>>, key: string, current: () => T): void {
    const set = watchers.get(key);
    if (set === undefined) {
      return;
    }
    queueMicrotask(() => {
      const value = current();
      for (const watcher of [...set]) {
        if (set.has(watcher)) {
          watcher(value);
        }
      }
    });
  }
}

/**
 * The two sides of a session's signaling joined in memory: a host and a camera device of one
 * account over one {@link MemorySignalingBackend}, for the tests.
 */
export class MemorySignaling {
  readonly backend = new MemorySignalingBackend();

  constructor(
    readonly sessionId: string,
    readonly uid = 'ada-uid',
    readonly now: () => number = () => REAL_TIMERS.now(),
  ) {
    this.backend.seedSession(sessionId, { schema: 2, id: sessionId, owner: uid });
  }

  /** The host's signaling of the session. */
  host(): FirestoreSignaling {
    return new FirestoreSignaling(this.backend, {
      sessionId: this.sessionId,
      uid: this.uid,
      now: this.now,
    });
  }

  /** A camera device's signaling of the session, signed in to the same account. */
  camera(): FirestoreSignaling {
    return this.host();
  }
}
