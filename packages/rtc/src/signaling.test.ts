import type { SessionDescription } from '@cubetrace/core';
import { describe, expect, it } from 'vitest';

import {
  FirestoreSignaling,
  MemorySignaling,
  hashToken,
  type IceCandidate,
  type IncomingOffer,
  type Signaling,
} from './index';

const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const OFFER: SessionDescription = { type: 'offer', sdp: 'v=0\r\no=phone 1 1 IN IP4 0.0.0.0\r\n' };
const ANSWER: SessionDescription = { type: 'answer', sdp: 'v=0\r\no=host 2 2 IN IP4 0.0.0.0\r\n' };
const candidate = (n: number): IceCandidate => ({
  candidate: `candidate:${String(n)} 1 udp 2122260223 192.168.0.${String(n)} 5000${String(n)} typ host`,
  sdpMid: '0',
  sdpMLineIndex: 0,
});

/** Lets the backend's microtasks (its snapshots) run. */
async function flush(): Promise<void> {
  for (let k = 0; k < 10; k++) {
    await Promise.resolve();
  }
}

/** The two devices of one account over one in-memory backend, with the clock stopped at `now`. */
function devices(now = 1_790_000_000_000): {
  memory: MemorySignaling;
  host: FirestoreSignaling;
  phone: FirestoreSignaling;
  clock: { now: number };
} {
  const clock = { now };
  const memory = new MemorySignaling(SESSION, 'ada-uid', () => clock.now);
  return { memory, host: memory.host(), phone: memory.camera(), clock };
}

/** The offers the host's watcher gives, as they come. */
function watchOffers(host: FirestoreSignaling): {
  offers: IncomingOffer[];
  errors: unknown[];
  stop: () => void;
} {
  const offers: IncomingOffer[] = [];
  const errors: unknown[] = [];
  const stop = host.watchOffers(
    (offer) => offers.push(offer),
    (error) => errors.push(error),
  );
  return { offers, errors, stop };
}

/** What a side's signaling reports, collected. */
function listen(signaling: Signaling): {
  descriptions: SessionDescription[];
  candidates: IceCandidate[];
  closed: string[];
  errors: unknown[];
} {
  const out = {
    descriptions: [] as SessionDescription[],
    candidates: [] as IceCandidate[],
    closed: [] as string[],
    errors: [] as unknown[],
  };
  signaling.onDescription((d) => out.descriptions.push(d));
  signaling.onCandidate((c) => out.candidates.push(c));
  signaling.onClosed((reason) => out.closed.push(reason));
  signaling.onError((error) => out.errors.push(error));
  return out;
}

describe('the pairing over the signaling', () => {
  it("publishes the token's hash in the session's document, which the phone checks, and closes it", async () => {
    const { memory, host, phone, clock } = devices();
    expect(await phone.checkPairing('7R2KQ9WX')).toBe('no-pairing');
    const pairing = await host.publishPairing('7R2KQ9WX');
    expect(pairing).toEqual({
      tokenHash: await hashToken('7R2KQ9WX'),
      expiresMs: clock.now + 600_000,
    });
    expect(memory.backend.sessions.get(SESSION)?.['pairing']).toEqual(pairing);
    expect(memory.backend.writes).toEqual([`pairing ${SESSION}`]);
    expect(await phone.checkPairing('7R2KQ9WX')).toBe('ok');
    expect(await phone.checkPairing('7R2KQ9WY')).toBe('wrong-token');
    clock.now += 600_000;
    expect(await phone.checkPairing('7R2KQ9WX')).toBe('expired');
    clock.now -= 1;
    expect(await phone.checkPairing('7R2KQ9WX')).toBe('ok');
    await host.closePairing();
    expect(memory.backend.sessions.get(SESSION)?.['pairing']).toBeNull();
    expect(await phone.checkPairing('7R2KQ9WX')).toBe('no-pairing');
    // A session the account does not have.
    const elsewhere = new FirestoreSignaling(memory.backend, {
      sessionId: 'other',
      uid: 'ada-uid',
    });
    expect(await elsewhere.checkPairing('7R2KQ9WX')).toBe('no-session');
    expect(host.sessionId).toBe(SESSION);
  });
});

describe('the offer, the answer and the candidates over MemorySignaling', () => {
  it('runs the sequence: the phone offers, the host answers, each side gets the other’s candidates', async () => {
    const { memory, host, phone, clock } = devices();
    const tokenHash = await hashToken('7R2KQ9WX');
    const watching = watchOffers(host);
    await flush();
    expect(watching.offers).toEqual([]);

    // The phone's side: the document is created with the offer.
    const caller = phone.call({ tokenHash, peerId: 'peer-1' });
    const callerSide = listen(caller);
    expect(caller.role).toBe('caller');
    expect(caller.peerId).toBe('peer-1');
    await caller.sendDescription(OFFER);
    await caller.sendCandidate(candidate(1));
    await flush();
    expect(memory.backend.peers.get(SESSION)?.get('peer-1')).toEqual({
      schema: 1,
      owner: 'ada-uid',
      role: 'camera',
      createdMs: clock.now,
      tokenHash,
      offer: OFFER,
      answer: null,
      state: 'offered',
    });

    // The host's side: the offer comes with the callee's signaling, and the candidate already there.
    expect(watching.offers).toHaveLength(1);
    const [incoming] = watching.offers;
    expect(incoming.peerId).toBe('peer-1');
    expect(incoming.peer.tokenHash).toBe(tokenHash);
    expect(incoming.peer.offer).toEqual(OFFER);
    const callee = incoming.signaling;
    expect(callee.role).toBe('callee');
    const calleeSide = listen(callee);
    await flush();
    expect(calleeSide.descriptions).toEqual([OFFER]);
    expect(calleeSide.candidates).toEqual([candidate(1)]);
    await callee.sendDescription(ANSWER);
    await callee.sendCandidate(candidate(2));
    await caller.sendCandidate(candidate(3));
    await flush();
    expect(memory.backend.peers.get(SESSION)?.get('peer-1')).toMatchObject({
      answer: ANSWER,
      state: 'answered',
    });
    expect(callerSide.descriptions).toEqual([ANSWER]);
    expect(callerSide.candidates).toEqual([candidate(2)]);
    expect(calleeSide.candidates).toEqual([candidate(1), candidate(3)]);
    // A second listener on each side gets what is known already.
    const late = listen(callee);
    await flush();
    expect(late.descriptions).toEqual([OFFER]);
    expect(late.candidates).toEqual([candidate(1), candidate(3)]);
    expect(watching.offers).toHaveLength(1);
    expect(callerSide.errors).toEqual([]);
    expect(calleeSide.errors).toEqual([]);
    expect(watching.errors).toEqual([]);
    expect(memory.backend.writes).toEqual([
      `create ${SESSION}/peer-1`,
      `candidate ${SESSION}/peer-1/caller`,
      `update ${SESSION}/peer-1 answer,state`,
      `candidate ${SESSION}/peer-1/callee`,
      `candidate ${SESSION}/peer-1/caller`,
    ]);
    watching.stop();
  });

  it('carries an ICE restart: a new offer replaces the old one and is answered again', async () => {
    const { memory, host, phone } = devices();
    const tokenHash = await hashToken('7R2KQ9WX');
    const watching = watchOffers(host);
    const caller = phone.call({ tokenHash, peerId: 'peer-1' });
    const callerSide = listen(caller);
    await caller.sendDescription(OFFER);
    await flush();
    const callee = watching.offers[0].signaling;
    const calleeSide = listen(callee);
    await callee.sendDescription(ANSWER);
    await flush();
    const restart: SessionDescription = {
      type: 'offer',
      sdp: `${OFFER.sdp}a=ice-options:trickle\r\n`,
    };
    await caller.sendDescription(restart);
    await flush();
    expect(memory.backend.peers.get(SESSION)?.get('peer-1')).toMatchObject({
      offer: restart,
      answer: null,
      state: 'offered',
    });
    expect(calleeSide.descriptions).toEqual([OFFER, restart]);
    const again: SessionDescription = {
      type: 'answer',
      sdp: `${ANSWER.sdp}a=ice-options:trickle\r\n`,
    };
    await callee.sendDescription(again);
    await flush();
    expect(callerSide.descriptions).toEqual([ANSWER, again]);
    // The same answer written again is no new description.
    await callee.sendDescription(again);
    await flush();
    expect(callerSide.descriptions).toHaveLength(2);
    // The host's watcher does not take the restarted offer for a new peer.
    expect(watching.offers).toHaveLength(1);
  });

  it('refuses the wrong kind of description for a role', async () => {
    const { host, phone } = devices();
    const caller = phone.call({ tokenHash: await hashToken('7R2KQ9WX') });
    await expect(caller.sendDescription(ANSWER)).rejects.toThrow('The caller sends offers.');
    const watching = watchOffers(host);
    await caller.sendDescription(OFFER);
    await flush();
    await expect(watching.offers[0].signaling.sendDescription(OFFER)).rejects.toThrow(
      'The callee sends answers.',
    );
  });

  it('tells each side when the other closes: the phone leaves, or the host deletes the documents', async () => {
    const { memory, host, phone } = devices();
    const tokenHash = await hashToken('7R2KQ9WX');
    const watching = watchOffers(host);
    // The phone leaves: its document says closed, and the host hears it.
    const caller = phone.call({ tokenHash, peerId: 'peer-1' });
    await caller.sendDescription(OFFER);
    await flush();
    const callee = watching.offers[0].signaling;
    const calleeSide = listen(callee);
    await caller.close();
    await flush();
    expect(memory.backend.peers.get(SESSION)?.get('peer-1')?.state).toBe('closed');
    expect(calleeSide.closed).toEqual(['the other side left']);
    // Then the host deletes the documents, candidates included.
    await caller.sendCandidate(candidate(1)).catch(() => undefined);
    await callee.close();
    expect(memory.backend.peers.get(SESSION)?.has('peer-1')).toBe(false);
    expect([...memory.backend.candidates.keys()].filter((key) => key.includes('peer-1'))).toEqual(
      [],
    );
    // The host removes a camera: the documents go, and the phone hears it.
    const second = phone.call({ tokenHash, peerId: 'peer-2' });
    const secondSide = listen(second);
    await second.sendDescription(OFFER);
    await flush();
    await watching.offers[1].signaling.close();
    await flush();
    expect(secondSide.closed).toEqual(['the documents are gone']);
    // Closing again, or marking a deleted document, is harmless.
    await second.close();
    await watching.offers[1].signaling.close();
    expect(memory.backend.writes.filter((write) => write.startsWith('delete'))).toEqual([
      `delete ${SESSION}/peer-1`,
      `delete ${SESSION}/peer-2`,
    ]);
    // A caller that never offered has nothing to close.
    await phone.call({ tokenHash }).close();
  });

  it('skips documents that are not peers, reporting them, and reports the backend’s refusals', async () => {
    const { memory, host, phone } = devices();
    const tokenHash = await hashToken('7R2KQ9WX');
    memory.backend.peers.set(
      SESSION,
      new Map([['junk', { schema: 2, owner: 'ada-uid' } as never]]),
    );
    const watching = watchOffers(host);
    await flush();
    expect(watching.offers).toEqual([]);
    expect(watching.errors).toHaveLength(1);
    expect(String(watching.errors[0])).toMatch(/schema must be 1/);
    // A peer of another account is not the host's business.
    memory.backend.peers.get(SESSION)?.set('bobs', {
      schema: 1,
      owner: 'bob-uid',
      role: 'camera',
      createdMs: 1,
      tokenHash,
      offer: OFFER,
      answer: null,
      state: 'offered',
    });
    const caller = phone.call({ tokenHash, peerId: 'peer-1' });
    await caller.sendDescription(OFFER);
    await flush();
    expect(watching.offers.map((offer) => offer.peerId)).toEqual(['peer-1']);
    // The rules refuse a write: the promise rejects, the documents stay.
    memory.backend.writeError = new Error('Missing or insufficient permissions.');
    await expect(caller.sendCandidate(candidate(1))).rejects.toThrow(
      'Missing or insufficient permissions.',
    );
    await expect(host.publishPairing('7R2KQ9WX')).rejects.toThrow('permissions');
    memory.backend.writeError = null;
    // The rules refuse a read: the watchers report it.
    memory.backend.readError = new Error('permission-denied');
    const refused = watchOffers(host);
    const late = phone.call({ tokenHash, peerId: 'peer-9' });
    const lateSide = listen(late);
    await late.sendDescription(OFFER);
    await flush();
    expect(refused.errors).toEqual([new Error('permission-denied')]);
    expect(lateSide.errors).toEqual([
      new Error('permission-denied'),
      new Error('permission-denied'),
    ]);
  });

  it('gives each caller a peer id of its own by default', async () => {
    const { phone } = devices();
    const tokenHash = await hashToken('7R2KQ9WX');
    const ids = new Set([phone.call({ tokenHash }).peerId, phone.call({ tokenHash }).peerId]);
    expect(ids.size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
