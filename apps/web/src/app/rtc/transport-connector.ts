import { InjectionToken } from '@angular/core';
import { WebRtcTransport, type Signaling, type Transport } from '@cubetrace/rtc';

/**
 * Makes the connection of one peer over its signaling, for the signaling's role, and resolves with
 * the transport once its data channel is open (docs/RTC.md §2); rejects when it could not be made.
 */
export type TransportConnector = (signaling: Signaling) => Promise<Transport>;

/**
 * The connector: `WebRtcTransport.connect` (an `RTCPeerConnection` with Google's STUN server, one
 * reliable ordered data channel, ICE restart on failure). The unit tests of the services give one
 * that joins `MemoryTransport` pairs.
 */
export const TRANSPORT_CONNECTOR = new InjectionToken<TransportConnector>('TRANSPORT_CONNECTOR', {
  providedIn: 'root',
  factory: () => (signaling) => WebRtcTransport.connect({ signaling }),
});
