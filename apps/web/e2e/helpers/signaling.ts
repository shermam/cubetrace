import type { Page } from '@playwright/test';

// A fake of the remote cameras' signaling for the end-to-end suite (docs/RTC.md §5, docs/PLAN.md
// T4.1): two pages of one browser pair over a `BroadcastChannel` named after the session instead of
// Firestore, so that the fast suite needs no emulator. The dev server's app takes it through
// `window.cubetraceE2eSignaling` (src/app/rtc/session-signaling.ts, development builds only), a
// function of the session id and the uid that gives what the host's and the phone's services need of
// `FirestoreSignaling`: the host publishes a pairing (kept in its page) and watches for offers, the
// phone checks the pairing (a question over the channel, which the host's page answers) and calls;
// the offer, the answer and the ICE candidates of each peer go over the channel, as the FirebaseRTC
// documents would, and `close` tells the other side. The real `RTCPeerConnection` runs over it, on
// the loopback interface. The cloud suite pairs through the Firestore emulator instead.

/** The window property the app reads. */
const FLAG = 'cubetraceE2eSignaling';

/** How long a phone waits for the host's page to answer a pairing check before it says no session. */
const CHECK_TIMEOUT_MS = 2000;

/**
 * Installs the fake before the app's scripts run, on every page load of `page` (call it before
 * `page.goto`), on the host's page and on the phone's.
 */
export async function fakeSignaling(page: Page): Promise<void> {
  await page.addInitScript(
    ({ flag, checkTimeoutMs }) => {
      type Role = 'caller' | 'callee';
      type Description = { type: 'offer' | 'answer'; sdp: string };
      type Candidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
      type Wire =
        | { kind: 'check'; id: string; tokenHash: string }
        | { kind: 'pairing'; id: string; result: string }
        | {
            kind: 'offer';
            peerId: string;
            tokenHash: string;
            sdp: string;
            owner: string;
            createdMs: number;
          }
        | { kind: 'answer'; peerId: string; sdp: string }
        | { kind: 'candidate'; peerId: string; side: Role; candidate: Candidate }
        | { kind: 'closed'; peerId: string; by: Role };
      interface Peer {
        tokenHash: string;
        owner: string;
        createdMs: number;
        offers: Description[];
        answers: Description[];
        candidates: { caller: Candidate[]; callee: Candidate[] };
        closedBy: Set<Role>;
      }

      const hash = async (token: string): Promise<string> => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      };

      // The pairings this page published, by session, and the sessions it hosts (it published a
      // pairing at some point): what the page answers checks with. Shared by the page's instances
      // (the phone's service makes one per join, and a `BroadcastChannel` also reaches the other
      // channels of its own page), so that a stale instance never answers for the current one, and
      // each check is answered once.
      const pairings = new Map<string, { tokenHash: string; expiresMs: number } | null>();
      const hosting = new Set<string>();
      const answered = new Set<string>();

      const make = (sessionId: string, uid: string) => {
        const channel = new BroadcastChannel(`cubetrace-e2e-signaling:${sessionId}`);
        // Everything heard on the channel, by peer, so that a side that subscribes late gets what
        // came before (the candidates the phone trickles right after its offer).
        const peers = new Map<string, Peer>();
        const listeners = new Set<(message: Wire) => void>();
        const peerOf = (peerId: string): Peer => {
          let peer = peers.get(peerId);
          if (peer === undefined) {
            peer = {
              tokenHash: '',
              owner: '',
              createdMs: 0,
              offers: [],
              answers: [],
              candidates: { caller: [], callee: [] },
              closedBy: new Set(),
            };
            peers.set(peerId, peer);
          }
          return peer;
        };
        const record = (message: Wire): void => {
          switch (message.kind) {
            case 'offer': {
              const peer = peerOf(message.peerId);
              peer.tokenHash = message.tokenHash;
              peer.owner = message.owner;
              peer.createdMs = message.createdMs;
              peer.offers.push({ type: 'offer', sdp: message.sdp });
              break;
            }
            case 'answer':
              peerOf(message.peerId).answers.push({ type: 'answer', sdp: message.sdp });
              break;
            case 'candidate':
              peerOf(message.peerId).candidates[message.side].push(message.candidate);
              break;
            case 'closed':
              peerOf(message.peerId).closedBy.add(message.by);
              break;
            default:
              break;
          }
        };
        const tell = (message: Wire): void => {
          for (const listener of [...listeners]) {
            listener(message);
          }
        };
        channel.onmessage = (event: MessageEvent<Wire>) => {
          const message = event.data;
          record(message);
          // The host's page answers the phone's question about the pairing, once.
          if (message.kind === 'check' && hosting.has(sessionId) && !answered.has(message.id)) {
            answered.add(message.id);
            const pairing = pairings.get(sessionId) ?? null;
            const result =
              pairing === null
                ? 'no-pairing'
                : Date.now() >= pairing.expiresMs
                  ? 'expired'
                  : pairing.tokenHash === message.tokenHash
                    ? 'ok'
                    : 'wrong-token';
            channel.postMessage({ kind: 'pairing', id: message.id, result });
          }
          tell(message);
        };
        const post = (message: Wire): void => {
          record(message);
          channel.postMessage(message);
        };

        /** One side of one peer connection over the channel. */
        const peerSignaling = (role: Role, peerId: string, tokenHash: string) => {
          const other: Role = role === 'caller' ? 'callee' : 'caller';
          let closed = false;
          return {
            role,
            peerId,
            sendDescription(description: Description): Promise<void> {
              post(
                role === 'caller'
                  ? {
                      kind: 'offer',
                      peerId,
                      tokenHash,
                      sdp: description.sdp,
                      owner: uid,
                      createdMs: Date.now(),
                    }
                  : { kind: 'answer', peerId, sdp: description.sdp },
              );
              return Promise.resolve();
            },
            sendCandidate(candidate: Candidate): Promise<void> {
              post({ kind: 'candidate', peerId, side: role, candidate });
              return Promise.resolve();
            },
            onDescription(next: (description: Description) => void): () => void {
              const known = role === 'caller' ? peerOf(peerId).answers : peerOf(peerId).offers;
              let delivered = known.length;
              const latest = known.at(-1);
              if (latest !== undefined) {
                queueMicrotask(() => {
                  next(latest);
                });
              }
              const handler = (message: Wire): void => {
                if (
                  (message.kind === 'offer' || message.kind === 'answer') &&
                  message.peerId === peerId &&
                  message.kind === (role === 'caller' ? 'answer' : 'offer')
                ) {
                  const list = role === 'caller' ? peerOf(peerId).answers : peerOf(peerId).offers;
                  for (const description of list.slice(delivered)) {
                    next(description);
                  }
                  delivered = list.length;
                }
              };
              listeners.add(handler);
              return () => {
                listeners.delete(handler);
              };
            },
            onCandidate(next: (candidate: Candidate) => void): () => void {
              const known = peerOf(peerId).candidates[other];
              let delivered = 0;
              const deliver = (): void => {
                const list = peerOf(peerId).candidates[other];
                for (const candidate of list.slice(delivered)) {
                  next(candidate);
                }
                delivered = list.length;
              };
              if (known.length > 0) {
                queueMicrotask(deliver);
              }
              const handler = (message: Wire): void => {
                if (
                  message.kind === 'candidate' &&
                  message.peerId === peerId &&
                  message.side === other
                ) {
                  deliver();
                }
              };
              listeners.add(handler);
              return () => {
                listeners.delete(handler);
              };
            },
            onClosed(next: (reason: string) => void): () => void {
              if (peerOf(peerId).closedBy.has(other)) {
                queueMicrotask(() => {
                  next('the other side left');
                });
              }
              const handler = (message: Wire): void => {
                if (
                  message.kind === 'closed' &&
                  message.peerId === peerId &&
                  message.by === other
                ) {
                  next(message.by === 'callee' ? 'the documents are gone' : 'the other side left');
                }
              };
              listeners.add(handler);
              return () => {
                listeners.delete(handler);
              };
            },
            onError(): () => void {
              return () => undefined;
            },
            close(): Promise<void> {
              if (!closed) {
                closed = true;
                post({ kind: 'closed', peerId, by: role });
              }
              return Promise.resolve();
            },
          };
        };

        return {
          sessionId,
          async publishPairing(
            token: string,
            ttlMs = 10 * 60_000,
          ): Promise<{ tokenHash: string; expiresMs: number }> {
            const pairing = { tokenHash: await hash(token), expiresMs: Date.now() + ttlMs };
            hosting.add(sessionId);
            pairings.set(sessionId, pairing);
            return pairing;
          },
          closePairing(): Promise<void> {
            pairings.set(sessionId, null);
            return Promise.resolve();
          },
          watchOffers(next: (offer: unknown) => void): () => void {
            const seen = new Set<string>();
            const handler = (message: Wire): void => {
              if (message.kind !== 'offer' || seen.has(message.peerId)) {
                return;
              }
              seen.add(message.peerId);
              next({
                peerId: message.peerId,
                peer: {
                  schema: 1,
                  owner: message.owner,
                  role: 'camera',
                  createdMs: message.createdMs,
                  tokenHash: message.tokenHash,
                  offer: { type: 'offer', sdp: message.sdp },
                  answer: null,
                  state: 'offered',
                },
                signaling: peerSignaling('callee', message.peerId, message.tokenHash),
              });
            };
            listeners.add(handler);
            return () => {
              listeners.delete(handler);
            };
          },
          async checkPairing(token: string): Promise<string> {
            const tokenHash = await hash(token);
            const id = crypto.randomUUID();
            return new Promise<string>((resolve) => {
              const handler = (message: Wire): void => {
                if (message.kind === 'pairing' && message.id === id) {
                  clearTimeout(timer);
                  listeners.delete(handler);
                  resolve(message.result);
                }
              };
              const timer = setTimeout(() => {
                listeners.delete(handler);
                resolve('no-session');
              }, checkTimeoutMs);
              listeners.add(handler);
              channel.postMessage({ kind: 'check', id, tokenHash });
            });
          },
          call(options: { tokenHash: string; peerId?: string }) {
            return peerSignaling(
              'caller',
              options.peerId ?? crypto.randomUUID(),
              options.tokenHash,
            );
          },
        };
      };
      Reflect.set(window, flag, make);
    },
    { flag: FLAG, checkTimeoutMs: CHECK_TIMEOUT_MS },
  );
}
