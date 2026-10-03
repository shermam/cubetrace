// The signaling documents of a remote camera in Firestore (docs/DATA-MODEL.md §10, docs/RTC.md,
// docs/PLAN.md T4.0): `sessions/{id}/peers/{peerId}`, one per phone that joins a session as a camera,
// holding the WebRTC offer the phone makes and the answer the host gives, with the ICE candidates of
// each side in `callerCandidates/{id}` and `calleeCandidates/{id}` under it (the FirebaseRTC pattern
// on the modular SDK); and `pairing`, the field of the session's document (`sessions/{id}`) through
// which the host publishes the hash of the one-time pairing token of its QR code. They are the
// account's own: the rules open them to the session's owner alone, and they are never in the dataset.

/** `pairing` of a session's document: the pairing token the host shows, hashed, and until when. */
export interface SessionPairing {
  /** SHA-256 of the token as the QR carries it (normalized upper case), as 64 lowercase hex digits. */
  tokenHash: string;
  /** Until when the host takes the token, in ms since 1970 (the host's clock). */
  expiresMs: number;
}

/** A session description as `RTCSessionDescriptionInit` has it: an offer or an answer, with its SDP. */
export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

/**
 * Where a peer's pairing is: `offered`, the phone wrote its offer and waits; `answered`, the host
 * answered; `closed`, the phone left (the host deletes the documents of a peer it is done with).
 */
export type PeerState = 'offered' | 'answered' | 'closed';

/** Every {@link PeerState}, in the order a peer goes through them. */
export const PEER_STATES: readonly PeerState[] = ['offered', 'answered', 'closed'];

/** `sessions/{id}/peers/{peerId}`, schema version 1 (docs/DATA-MODEL.md §10). */
export interface CloudPeer {
  schema: 1;
  /** The uid of the account that owns the session, which both devices are signed in to. */
  owner: string;
  /** What the peer is to the session; phase 4 has cameras only. */
  role: 'camera';
  /** When the phone wrote the document, on its clock. */
  createdMs: number;
  /** The hash of the pairing token the phone presents ({@link SessionPairing.tokenHash}). */
  tokenHash: string;
  /** The phone's offer (it is the caller); null before an ICE restart's new offer is written. */
  offer: SessionDescription | null;
  /** The host's answer (it is the callee); null until it answers. */
  answer: SessionDescription | null;
  state: PeerState;
}

/**
 * `sessions/{id}/peers/{peerId}/callerCandidates/{id}` and `calleeCandidates/{id}`: one ICE candidate
 * as `RTCIceCandidateInit` has it, with when it was written.
 */
export interface CloudCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  /** When the device wrote it, on its clock. */
  createdMs: number;
}

/** The side of the connection whose candidates a collection holds: the phone calls, the host answers. */
export type CandidateSide = 'caller' | 'callee';

/** The subcollection of a peer that holds each side's candidates. */
export const CANDIDATE_COLLECTIONS: Readonly<Record<CandidateSide, string>> = {
  caller: 'callerCandidates',
  callee: 'calleeCandidates',
};

/** The most characters of an SDP the rules take (a typical one has one to three thousand). */
export const SDP_MAX_LENGTH = 20_000;

/** The most characters of a candidate the rules take (a typical one has about a hundred). */
export const CANDIDATE_MAX_LENGTH = 1_000;

/** A SHA-256 digest as hex, as {@link SessionPairing.tokenHash} and {@link CloudPeer.tokenHash} hold it. */
export const TOKEN_HASH = /^[0-9a-f]{64}$/u;

/** What the phone writes to join a session. */
export interface CloudPeerInput {
  owner: string;
  createdMs: number;
  tokenHash: string;
  offer: SessionDescription;
}

/** `sessions/{id}/peers/{peerId}` as the phone creates it: the offer, waiting for the answer. */
export function cloudPeer(input: CloudPeerInput): CloudPeer {
  return {
    schema: 1,
    owner: input.owner,
    role: 'camera',
    createdMs: input.createdMs,
    tokenHash: input.tokenHash,
    offer: { type: input.offer.type, sdp: input.offer.sdp },
    answer: null,
    state: 'offered',
  };
}

/** A candidate's document from `RTCIceCandidateInit` (fields the browser leaves out are null). */
export function cloudCandidate(
  candidate: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null },
  createdMs: number,
): CloudCandidate {
  return {
    candidate: candidate.candidate ?? '',
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    createdMs,
  };
}
