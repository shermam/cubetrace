import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { ClapperboardFrame, ControlDrift, MotionMeterInfo } from '@cubetrace/capture';
import {
  RemoteClockFit,
  type AppBuild,
  type CameraClock,
  type CameraInfo,
  type RemoteClockParams,
  type RemoteClockRecord,
} from '@cubetrace/core';
import {
  ClockPinger,
  MessageLink,
  PAIRING_TTL_MS,
  PROTOCOL_VERSION,
  generateToken,
  pairingUrl,
  type CameraState,
  type DeviceInfo,
  type Hello,
  type IncomingOffer,
  type Signaling,
  type Thumbnail,
  type Transport,
} from '@cubetrace/rtc';

import { APP_BUILD } from '../../environments/version';
import { AuthService, type CloudAccount } from '../auth/auth-service';
import { SessionIndexService } from '../cloud/session-index';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { thisDevice } from '../rtc/device-info';
import { e2eRemote } from '../rtc/e2e-remote';
import { helloOrClose } from '../rtc/hello';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { SESSION_SIGNALING, type SessionSignaling } from '../rtc/session-signaling';
import { TRANSPORT_CONNECTOR } from '../rtc/transport-connector';
import { SessionService } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import type { PairingBlock } from './pairing-block';
import { RemoteCameraRegistry, type RemoteCameraEntry } from './remote-camera-registry';
import { RemoteControlsSource } from './remote-controls-source';
import { RemoteCutsService, type CutCamera } from './remote-cuts-service';
import { clockEstimate } from './remote-estimate';

/**
 * Where a remote camera is: `connecting` (its offer is answered, the channel not open yet; or its
 * first connection failed and the host waits for the phone to call again with its token, T4.2b, for
 * the pairing's ten minutes), `connected` (the channel is open and `hello` exchanged), `reconnecting`
 * (the connection ended without a `leave`: the phone calls again, the host waits
 * {@link RECONNECT_WINDOW_MS}), `finishing` (its session ended while clips of it were still to come:
 * the host keeps the connection until they are in, {@link FINISH_WAIT_MS} at most, T4.2b).
 */
export type RemoteCameraState = 'connecting' | 'connected' | 'reconnecting' | 'finishing';

/** The clock sync of a remote camera as the host measures it (docs/RTC.md §4). */
export interface RemoteSync {
  readonly converged: boolean;
  /** The phone's clock minus the host's, in ms. */
  readonly offsetMs: number;
  /** The least round trip of the samples kept, in ms. */
  readonly rttMs: number;
  readonly driftPpm: number;
  readonly samples: number;
  readonly residualP95Ms: number;
}

/** The latest thumbnail of a remote camera: a JPEG as an object URL, when the browser makes one. */
export interface RemoteThumbnail {
  /** `blob:` URL of the JPEG; null where the browser has no `URL.createObjectURL` (the tests). */
  readonly url: string | null;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** When the picture was taken, on the phone's clock. */
  readonly remoteMs: number;
  /** When it came, on the host clock. */
  readonly receivedMs: number;
}

/** A remote camera as the Cameras list shows it (docs/PLAN.md T4.1). */
export interface RemoteCamera {
  /** The id of the peer document it paired with: its name in the list, kept across reconnections. */
  readonly id: string;
  /** The peer document of its current (or last) connection. */
  readonly peerId: string;
  /** The hash of the token it paired with, which it presents again when it calls back. */
  readonly tokenHash: string;
  /** The phone, as its `hello` named it. */
  readonly device: DeviceInfo;
  readonly app: AppBuild;
  /** The phone's camera, as its `hello` described it; null until it has one open. */
  readonly camera: CameraInfo | null;
  /** Its label in the session (`phone-rear`, `phone-rear-2`); null without a session or a camera. */
  readonly label: string | null;
  readonly state: RemoteCameraState;
  /** When the current state began, on the host clock. */
  readonly sinceMs: number;
  /** When it first connected, on the host clock. */
  readonly pairedMs: number;
  /** The phone's last `state` message, and when it came. */
  readonly report: CameraState | null;
  readonly reportMs: number | null;
  readonly thumbnail: RemoteThumbnail | null;
  /** The clock sync; null before the first answer. */
  readonly sync: RemoteSync | null;
  /** While `finishing`, how many clips of the session that ended are still to come; 0 otherwise. */
  readonly clipsLeft: number;
  /** The session it was paired in, which it films. */
  readonly session: string;
  /**
   * The live preview's track (T4.3) of its current connection, once the phone's offer brought one;
   * null otherwise. It flows while the host asks for it ("Live preview from phones") and the phone
   * sends it: muted while it does not.
   */
  readonly preview: MediaStreamTrack | null;
  /**
   * What the phone's camera changed by itself, as its last `controls` says (T5.2, its watchdog):
   * "focus went manual on the phone" on its line; empty when nothing.
   */
  readonly drift: readonly ControlDrift[];
}

/** A pairing the host shows: the token, the QR's URL and until when the token is taken. */
export interface Pairing {
  readonly token: string;
  readonly tokenHash: string;
  readonly url: string;
  readonly expiresMs: number;
}

/**
 * How long the host waits for the phone's `hello` once the channel is open (10 s until T4.2b; the
 * phone's wait is as long, `camera-device-service.ts` says why). A wait over, or the connection
 * closed first, before the first hello is no longer the end of the pairing: the phone calls again
 * with its token, which is answered while it has not connected (T4.2b). The host says its own hello
 * once the phone's came, never before (`connectPeer` says why).
 */
export const HELLO_TIMEOUT_MS = 15_000;

/** How long a camera that lost its connection stays listed as reconnecting before it is removed. */
export const RECONNECT_WINDOW_MS = 5 * 60_000;

/**
 * How long a camera stays connected once its session ended, at most, for the clips of the session
 * still to come (T4.2b, follow-up (l): New session right after a solve let the phone go before its
 * last clips came). The phone's clip is ready about a second after its window's end, which is a
 * second and a half after the solve, and a transfer took 1.8 s at the median and 8 s at most on the
 * owner's Wi-Fi (2026-10-04): 15 s covers the slowest with room, and a phone that does not answer
 * holds the leave no longer than that. The end-to-end suite shortens it (`E2eRemote.finishWaitMs`).
 */
export const FINISH_WAIT_MS = 15_000;

/**
 * How often the clock sync goes into the diagnostics while the camera is connected (`rtc.clock`,
 * `minute` while converged, with the fit's record into the session too; `syncing` before, T4.2b,
 * so that a link that never converges still says how it behaves).
 */
export const CLOCK_RECORD_MS = 60_000;

/**
 * How long a `leave` has to go out before the connection is closed: `RTCPeerConnection.close` drops
 * what the channel still holds, and a word the phone never hears leaves it reconnecting.
 */
export const LEAVE_GRACE_MS = 250;

/** The host's side of one peer: the connection, the pinger and the fit, and the camera's row. */
interface Peer {
  camera: RemoteCamera;
  /** The session it was paired in, which it films: its clips are that session's. */
  readonly sessionId: string;
  /** The fit of the phone's clock, kept across its reconnections. */
  readonly fit: RemoteClockFit;
  transport: Transport | null;
  /** The signaling of the current connection, whose close deletes the peer document. */
  signaling: Signaling | null;
  link: MessageLink | null;
  pinger: ClockPinger | null;
  /** Stops the handlers of the current connection. */
  offs: (() => void)[];
  /** Each connection of the peer has a number: an older one's end is not the newer one's. */
  generation: number;
  /** Whether the fit had converged at its last answer, for the convergence and withdrawal events. */
  converged: boolean;
  removalTimer: unknown;
  recordTimer: unknown;
  /** While `finishing`: the end of the wait, and what stops watching its clips still to come. */
  finishing: { timer: unknown; off: () => void } | null;
  /** The phone's camera controls (T5.2), its panel's source in the Cameras section. */
  readonly controls: RemoteControlsSource;
}

/**
 * The remote cameras of the host (docs/PLAN.md T4.1, docs/RTC.md): the phones paired to the session
 * under way, which film it from other angles. Add camera publishes a pairing (a token, its hash in
 * the session's document in Firestore for ten minutes, the QR code's URL) and watches for the
 * phone's offer; the first peer that presents the token is answered (`TRANSPORT_CONNECTOR`, the
 * real `WebRtcTransport` or the tests' memory pairs) and the pairing closed, so that the token is
 * taken once. Over the channel the host sends its `hello`, takes the phone's (its device, its build
 * and its camera), pings (`ClockPinger`, one `RemoteClockFit` per phone: every 500 ms until the fit
 * converges, then every 2 s) and tells the phone what it measures (`clock`), and keeps the phone's
 * `state` and `thumbnail` for the list. The camera goes into the session's `cameras[]` with
 * `local: false` and `remote` naming the device, under the label the session gives it
 * (`SessionService.putCamera`), and its clock fit into `clock.cameras[label].remote` when the fit
 * converges and every minute after (the diagnostics' `rtc.clock` every minute of the connection,
 * converged or not). A phone whose first connection fails is listed as connecting while it calls
 * again with its token, for the pairing's ten minutes (T4.2b); one whose connection ends without a
 * `leave` is listed as reconnecting for five minutes, during which its call with the same token is
 * answered again; then it is removed; a phone that leaves, or a camera the host removes (`leave`
 * sent, the peer document deleted), goes at once. Its entry stays in the session: the session
 * records what filmed it. Everything ends when the session does (a camera with clips of it still to
 * come once they are in, 15 s at most: `finishing`, T4.2b), or the page goes (`pagehide`, best
 * effort). The pairing's documents are the account's own: Add camera needs the account signed in,
 * and a session under way (its document in the index: `indexForPairing`, a demo session's too).
 * Each connection is handed to `RemoteCutsService` (T4.2), which asks the phone for each attempt's
 * clips and takes them into the attempt's folder; a camera taken off the list gives up its clips
 * still to come.
 */
@Injectable({ providedIn: 'root' })
export class RemoteCamerasService {
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionService);
  private readonly index = inject(SessionIndexService);
  private readonly settings = inject(SettingsService);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly document = inject(DOCUMENT);
  private readonly timers = inject(RTC_TIMERS);
  private readonly makeSignaling = inject(SESSION_SIGNALING);
  private readonly connect = inject(TRANSPORT_CONNECTOR);
  /** The cuts and the clips of the cameras (T4.2), which follow the connections made here. */
  private readonly cuts = inject(RemoteCutsService);
  /** Where the Timer page's preview area and the sync check find the cameras (T4.3). */
  private readonly registry = inject(RemoteCameraRegistry);
  /** The wait for a camera's last clips at its session's end; shorter in the end-to-end suite. */
  private readonly finishWaitMs = e2eRemote(this.globals).finishWaitMs ?? FINISH_WAIT_MS;

  private readonly pairingSignal = signal<Pairing | null>(null);
  private readonly pairingErrorSignal = signal<string | null>(null);
  private readonly publishingSignal = signal(false);
  private readonly camerasSignal = signal<readonly RemoteCamera[]>([]);

  /** The pairing shown now (the QR code); null when none is open. */
  readonly pairing = this.pairingSignal.asReadonly();
  /** Why the last Add camera, or the pairing, failed; null when nothing did. */
  readonly pairingError = this.pairingErrorSignal.asReadonly();
  /** Add camera is publishing the pairing. */
  readonly publishing = this.publishingSignal.asReadonly();
  /** The remote cameras, in the order they paired. */
  readonly cameras = this.camerasSignal.asReadonly();
  /** Why Add camera cannot pair now; null when it can. */
  readonly blocked = computed<PairingBlock | null>(() => {
    if (this.auth.cloud() === null) {
      return 'signed-out';
    }
    return this.session.session() === null ? 'no-session' : null;
  });

  private readonly peers = new Map<string, Peer>();
  /** The session's signaling, made for the account and session of the pairing. */
  private signaling: {
    account: CloudAccount;
    sessionId: string;
    signaling: SessionSignaling;
  } | null = null;
  private unwatch: (() => void) | null = null;
  private expiryTimer: unknown = null;
  /** The operations under way, for the tests to wait on. */
  private pending: Promise<unknown> = Promise.resolve();
  /** The number of the next sync check of a camera (`sync-start`), for this page. */
  private nextCheck = 1;

  constructor() {
    // The cameras for the Timer page's preview area and for the sync check (T4.3).
    this.registry.provide({
      cameras: computed(() => this.camerasSignal().map(entryOf)),
      watchMotion: (id, onSample, onError, onMeter) =>
        this.watchMotion(id, onSample, onError, onMeter),
      resetDrift: (id) => {
        void this.peers.get(id)?.controls.resetDrift();
      },
      clockRecord: (id) => {
        const fit = this.peers.get(id)?.fit;
        const estimate = fit === undefined ? null : clockEstimate(fit);
        return estimate === null ? null : { ...estimate.params, converged: estimate.converged };
      },
    });
    // "Live preview from phones" changed: every phone connected is told (T4.3).
    effect(() => {
      const on = this.settings.livePreviewFromPhones();
      untracked(() => {
        for (const peer of this.peers.values()) {
          if (peer.camera.state === 'connected' || peer.camera.state === 'finishing') {
            peer.link?.trySend({ type: 'preview', on });
          }
        }
      });
    });
    // The session ended, or another began: the cameras of the old one go (once their last clips are
    // in, T4.2b), and so does its pairing.
    let sessionId = this.session.session()?.id ?? null;
    effect(() => {
      const next = this.session.session()?.id ?? null;
      untracked(() => {
        if (next !== sessionId) {
          sessionId = next;
          this.sessionEnded();
        }
      });
    });
    // The page goes: the phones are told and the documents deleted, as far as there is time; the
    // browser closes the connections itself (closing them here would drop the word). The clips still
    // to come are not given up: the phones keep them, and offer them to the page that pairs them next.
    const onPageHide = (): void => {
      this.endAll('the host page closed', 0, false, false);
    };
    this.globals.addEventListener?.('pagehide', onPageHide);
    inject(DestroyRef).onDestroy(() => {
      this.globals.removeEventListener?.('pagehide', onPageHide);
      this.endAll('the host page closed', 0, true, false);
    });
  }

  /**
   * Publishes a new pairing for the session under way and shows its QR code: the first phone that
   * presents the token within ten minutes is answered. Nothing without an account or a session
   * (`blocked`); a pairing already open is replaced.
   */
  async addCamera(): Promise<void> {
    const account = this.auth.cloud();
    const session = this.session.session();
    if (account === null || session === null) {
      this.pairingErrorSignal.set(
        account === null
          ? 'Sign in first: the pairing goes through your account.'
          : 'Connect the cube first: a camera joins the session under way.',
      );
      return;
    }
    this.publishingSignal.set(true);
    this.pairingErrorSignal.set(null);
    const task = (async (): Promise<void> => {
      try {
        await this.index.indexForPairing(session);
        const signaling = this.signalingFor(account, session.id);
        const token = generateToken();
        const published = await signaling.publishPairing(token);
        this.clearExpiry();
        this.pairingSignal.set({
          token,
          tokenHash: published.tokenHash,
          url: pairingUrl(this.document.baseURI, session.id, token),
          expiresMs: published.expiresMs,
        });
        this.expiryTimer = this.timers.setTimeout(
          () => {
            void this.expirePairing();
          },
          Math.max(0, published.expiresMs - this.timers.now()),
        );
        this.watch(signaling);
      } catch (error: unknown) {
        this.pairingErrorSignal.set(`The pairing could not be published: ${errorMessage(error)}`);
        this.diagnostics.record('rtc.failed', { step: 'pairing', reason: errorMessage(error) });
      } finally {
        this.publishingSignal.set(false);
      }
    })();
    this.track(task);
    await task;
  }

  /** Takes the QR code down: the token is not taken any more. */
  async cancelPairing(): Promise<void> {
    if (this.pairingSignal() === null) {
      return;
    }
    this.clearExpiry();
    this.pairingSignal.set(null);
    const signaling = this.signaling?.signaling;
    if (signaling !== undefined) {
      const task = signaling.closePairing().catch(() => undefined);
      this.track(task);
      await task;
    }
  }

  /**
   * Removes a camera: the phone is told (`leave`), the connection closed and the peer document
   * deleted; its entry stays in the session.
   */
  remove(id: string): void {
    const peer = this.peers.get(id);
    if (peer === undefined) {
      return;
    }
    this.end(peer, 'removed by the host', 'The host removed this camera.', LEAVE_GRACE_MS);
  }

  /**
   * The camera controls of the phone `id` (T5.2), for its panel in the Cameras section; null when it
   * is not listed.
   */
  controlsOf(id: string): RemoteControlsSource | null {
    return this.peers.get(id)?.controls ?? null;
  }

  /** Resolves once the operations under way (pairings, connections) have settled, for the tests. */
  async whenIdle(): Promise<void> {
    let last: Promise<unknown> | null = null;
    while (last !== this.pending) {
      last = this.pending;
      await last;
    }
  }

  // ---- The pairing ----

  private signalingFor(account: CloudAccount, sessionId: string): SessionSignaling {
    const known = this.signaling;
    if (known !== null && known.account === account && known.sessionId === sessionId) {
      return known.signaling;
    }
    this.unwatch?.();
    this.unwatch = null;
    const signaling = this.makeSignaling(account, sessionId);
    this.signaling = { account, sessionId, signaling };
    return signaling;
  }

  private watch(signaling: SessionSignaling): void {
    if (this.unwatch !== null) {
      return;
    }
    this.unwatch = signaling.watchOffers(
      (offer) => {
        this.track(this.onOffer(offer, signaling.sessionId));
      },
      (error) => {
        const reason = errorMessage(error);
        console.warn(`cubetrace: remote cameras: the offers could not be watched: ${reason}`);
        if (this.pairingSignal() !== null) {
          this.pairingErrorSignal.set(`The pairing cannot hear the phone: ${reason}`);
        }
        this.diagnostics.record('rtc.failed', { step: 'watch', reason });
      },
    );
  }

  private async expirePairing(): Promise<void> {
    this.expiryTimer = null;
    if (this.pairingSignal() === null) {
      return;
    }
    this.pairingSignal.set(null);
    this.pairingErrorSignal.set('The code expired: Add camera shows a new one.');
    await this.signaling?.signaling.closePairing().catch(() => undefined);
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      this.timers.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * A phone offers: the one the pairing waits for (its token, before it expires) is answered and the
   * pairing closed; a camera of the list calling again with its token is answered again, after its
   * connection ended (reconnecting) or before it ever had one (connecting: its first call failed,
   * T4.2b); anything else is a stale or a wrong call, whose documents go.
   */
  private async onOffer(offer: IncomingOffer, sessionId: string): Promise<void> {
    const now = this.timers.now();
    const back = [...this.peers.values()].find(
      (peer) =>
        peer.camera.tokenHash === offer.peer.tokenHash &&
        (peer.camera.state === 'reconnecting' || peer.camera.state === 'connecting'),
    );
    if (back !== undefined) {
      await this.connectPeer(back, offer, back.camera.state === 'reconnecting');
      return;
    }
    const pairing = this.pairingSignal();
    if (
      pairing === null ||
      offer.peer.tokenHash !== pairing.tokenHash ||
      now >= pairing.expiresMs
    ) {
      console.warn(
        `cubetrace: remote cameras: a call that presents no open token (peer ${offer.peerId}); its documents go.`,
      );
      await offer.signaling.close().catch(() => undefined);
      return;
    }
    // The token is taken: no second phone pairs with it.
    this.clearExpiry();
    this.pairingSignal.set(null);
    void this.signaling?.signaling.closePairing().catch(() => undefined);
    const peer: Peer = {
      camera: {
        id: offer.peerId,
        peerId: offer.peerId,
        tokenHash: offer.peer.tokenHash,
        device: { label: 'phone', platform: '' },
        app: { version: '', commit: '' },
        camera: null,
        label: null,
        state: 'connecting',
        sinceMs: now,
        pairedMs: now,
        report: null,
        reportMs: null,
        thumbnail: null,
        sync: null,
        clipsLeft: 0,
        session: sessionId,
        preview: null,
        drift: [],
      },
      sessionId,
      fit: new RemoteClockFit(),
      transport: null,
      signaling: null,
      link: null,
      pinger: null,
      offs: [],
      generation: 0,
      converged: false,
      removalTimer: null,
      recordTimer: null,
      finishing: null,
      controls: new RemoteControlsSource({
        timers: this.timers,
        onOutcome: (outcome) => {
          this.diagnostics.record('remote.controls', {
            camera: peer.camera.label,
            peer: peer.camera.device.label,
            set: outcome.set,
            outcome: outcome.outcome,
            message: outcome.message,
            ms: outcome.ms,
          });
        },
        onReport: (report) => {
          if (JSON.stringify(report.drift) !== JSON.stringify(peer.camera.drift)) {
            this.patch(peer, { drift: report.drift });
          }
        },
      }),
    };
    this.peers.set(peer.camera.id, peer);
    this.camerasSignal.update((cameras) => [...cameras, peer.camera]);
    // The token is the phone's for the pairing's ten minutes: its calls are answered until it
    // connects (a first connection that failed is called again, T4.2b), then it goes.
    peer.removalTimer = this.timers.setTimeout(() => {
      peer.removalTimer = null;
      if (peer.camera.state === 'connecting') {
        this.drop(peer, 'the connection could not be made');
      }
    }, PAIRING_TTL_MS);
    await this.connectPeer(peer, offer, false);
  }

  // ---- The connection ----

  /**
   * Answers `offer` for `peer`: the channel, the hellos, the pings; a failure says why. A first
   * connection that fails leaves the camera connecting, its token answered again until the pairing's
   * ten minutes are up (T4.2b); one made again after a drop leaves it reconnecting.
   */
  private async connectPeer(peer: Peer, offer: IncomingOffer, again: boolean): Promise<void> {
    const generation = ++peer.generation;
    // A connection still up (the phone thought it dead first) makes way for the new one.
    this.detach(peer, 'replaced by a new connection');
    peer.signaling = offer.signaling;
    this.patch(peer, { peerId: offer.peerId });
    const started = this.timers.now();
    let transport: Transport;
    try {
      transport = await this.connect(offer.signaling);
    } catch (error: unknown) {
      // A call that a newer one replaced fails quietly.
      if (generation === peer.generation) {
        this.failed(peer, 'connect', errorMessage(error));
      }
      return;
    }
    if (generation !== peer.generation || !this.peers.has(peer.camera.id)) {
      transport.close('superseded');
      return;
    }
    const link = new MessageLink(transport);
    peer.transport = transport;
    peer.link = link;
    // The host speaks second (T4.2b): its hello answers the phone's. The hello the host sent the
    // moment its channel opened now and then never reached the phone's page, while the frames after
    // it did (7 of about 115 hello exchanges in the end-to-end runs while T4.2b was tested, and most
    // likely PR #62's refusal in CI): it had gone out before the phone's page had its own channel
    // open, as far as the clocks tell. The phone says hello once its channel is open, so whatever the
    // host sends after the phone's hello finds the phone's channel open.
    let hello: Hello;
    try {
      hello = await this.withTimeout(
        helloOrClose(link, 'phone'),
        HELLO_TIMEOUT_MS,
        'the phone sent no hello',
      );
    } catch (error: unknown) {
      transport.close('no hello');
      if (generation === peer.generation) {
        this.failed(peer, 'hello', errorMessage(error));
        if (peer.transport === transport) {
          peer.transport = null;
          peer.link = null;
          link.detach();
        }
      }
      return;
    }
    if (generation !== peer.generation) {
      return;
    }
    // Before a refusal too, so that the phone says which versions disagree.
    link.trySend(this.hello());
    if (hello.v !== PROTOCOL_VERSION || hello.role !== 'camera') {
      const reason =
        hello.v !== PROTOCOL_VERSION
          ? `the phone runs protocol version ${String(hello.v)}, this host ${String(PROTOCOL_VERSION)}: update the app on both`
          : `the peer is a ${hello.role}, not a camera`;
      link.trySend({ type: 'leave', reason });
      this.failed(peer, 'version', reason);
      this.closeAfter(transport, 'version', LEAVE_GRACE_MS);
      this.drop(peer, reason);
      return;
    }
    const now = this.timers.now();
    this.clearRemoval(peer);
    this.patch(peer, {
      device: hello.device,
      app: hello.app,
      camera: hello.camera,
      state: 'connected',
      sinceMs: now,
      ...(again ? {} : { pairedMs: now }),
    });
    this.putEntry(peer);
    // Whether the phone sends its live picture (T4.3): "Live preview from phones"; the track its
    // offer brought, for the Timer page's preview area.
    link.trySend({ type: 'preview', on: this.settings.livePreviewFromPhones() });
    const preview = transport.preview;
    if (preview !== undefined) {
      peer.offs.push(
        preview.onTrack((track) => {
          if (peer.transport === transport) {
            this.patch(peer, { preview: track });
          }
        }),
      );
    }
    peer.offs.push(
      link.on('hello', (message) => {
        if (message.v === PROTOCOL_VERSION) {
          this.patch(peer, { device: message.device, app: message.app, camera: message.camera });
          this.putEntry(peer);
          // Another camera, or none: its controls come with it (T5.2).
          peer.controls.cameraChanged(message.camera !== null);
          if (message.camera === null && peer.camera.drift.length > 0) {
            this.patch(peer, { drift: [] });
          }
        }
      }),
      link.on('state', (message) => {
        this.patch(peer, { report: message, reportMs: this.timers.now() });
      }),
      link.on('thumbnail', (message) => {
        this.thumbnail(peer, message);
      }),
      link.on('leave', (message) => {
        this.left(peer, message.reason);
      }),
      link.onError((error) => {
        console.warn(`cubetrace: remote cameras: a frame was not a message: ${error.message}`);
      }),
      transport.onStateChange((state, reason) => {
        if (state === 'closed' || state === 'failed') {
          this.disconnected(peer, generation, reason ?? state);
        }
      }),
      // The phone's camera controls (T5.2): its `controls`, and its answers to the panel's changes.
      peer.controls.attach(link, hello.camera !== null),
    );
    const pinger = new ClockPinger(link, peer.fit, { timers: this.timers });
    peer.pinger = pinger;
    peer.offs.push(
      pinger.onSample((fit) => {
        this.sampled(peer, fit);
      }),
    );
    pinger.start();
    this.scheduleRecord(peer);
    // The clips (T4.2): the cuts it has not answered go now, its offers and files are taken.
    const camera: CutCamera = {
      id: peer.camera.id,
      session: peer.sessionId,
      label: () => peer.camera.label,
      peer: () => peer.camera.device.label,
      fit: peer.fit,
      onSample: (next) =>
        pinger.onSample(() => {
          next();
        }),
      recordClock: (record) => {
        const label = peer.camera.label;
        const known = label === null ? undefined : this.session.session()?.clock.cameras[label];
        if (known?.remote === undefined) {
          this.putClock(peer, record);
        }
      },
    };
    peer.offs.push(this.cuts.connected(camera, link));
    const facts = {
      peer: hello.device.label,
      platform: hello.device.platform,
      camera: peer.camera.label,
      ms: Math.round(now - started),
    };
    if (!again) {
      this.diagnostics.record('rtc.paired', {
        ...facts,
        facing: hello.camera?.facing ?? null,
        deviceLabel: hello.camera?.deviceLabel ?? null,
        version: hello.app.version,
        commit: hello.app.commit,
      });
    }
    this.diagnostics.record('rtc.connected', { ...facts, reconnection: again });
  }

  /** The host's `hello`: its device and build, and no camera (the host's own is not the phone's). */
  private hello(): Hello {
    return {
      type: 'hello',
      v: PROTOCOL_VERSION,
      role: 'host',
      device: thisDevice(this.settings, this.globals),
      app: APP_BUILD,
      camera: null,
    };
  }

  /** The phone said `leave`: the camera goes at once; its documents too. */
  private left(peer: Peer, reason: string): void {
    this.diagnostics.record('rtc.disconnected', {
      peer: peer.camera.device.label,
      camera: peer.camera.label,
      reason: `left: ${reason}`,
      durationMs: Math.round(this.timers.now() - peer.camera.sinceMs),
      connectedMs: Math.round(this.timers.now() - peer.camera.pairedMs),
    });
    peer.generation++;
    this.detach(peer, 'the phone left');
    this.drop(peer, `it left: ${reason}`);
  }

  /** The connection ended without a `leave`: the camera waits for the phone to call again. */
  private disconnected(peer: Peer, generation: number, reason: string): void {
    if (generation !== peer.generation || !this.peers.has(peer.camera.id)) {
      return;
    }
    const now = this.timers.now();
    this.diagnostics.record('rtc.disconnected', {
      peer: peer.camera.device.label,
      camera: peer.camera.label,
      reason,
      durationMs: Math.round(now - peer.camera.sinceMs),
      connectedMs: Math.round(now - peer.camera.pairedMs),
    });
    peer.generation++;
    this.detach(peer, reason);
    if (peer.finishing !== null) {
      // Its session is over: no call of it is answered any more, and its last clips are given up.
      this.drop(peer, `the connection ended before its last clips came (${reason})`);
      return;
    }
    this.patch(peer, { state: 'reconnecting', sinceMs: now });
    if (peer.removalTimer === null) {
      peer.removalTimer = this.timers.setTimeout(() => {
        peer.removalTimer = null;
        this.diagnostics.record('rtc.disconnected', {
          peer: peer.camera.device.label,
          camera: peer.camera.label,
          reason: 'gave up: the phone did not come back within five minutes',
          durationMs: RECONNECT_WINDOW_MS,
          connectedMs: Math.round(this.timers.now() - peer.camera.pairedMs),
        });
        this.drop(peer, 'it did not come back within five minutes');
      }, RECONNECT_WINDOW_MS);
    }
  }

  /**
   * Ends the peer on the host's initiative: `leave`, the connection closed once the word is out
   * (`graceMs`), the camera gone from the list. When the page is going (`close` false), the
   * connection is left to the browser and the documents deleted at once, as far as there is time.
   * `giveUp` false keeps its clips still to come from being given up (the page goes).
   */
  private end(
    peer: Peer,
    why: string,
    message: string,
    graceMs: number,
    close = true,
    giveUp = true,
  ): void {
    const now = this.timers.now();
    peer.link?.trySend({ type: 'leave', reason: message });
    this.diagnostics.record('rtc.disconnected', {
      peer: peer.camera.device.label,
      camera: peer.camera.label,
      reason: why,
      durationMs: Math.round(now - peer.camera.sinceMs),
      connectedMs: Math.round(now - peer.camera.pairedMs),
    });
    peer.generation++;
    const transport = peer.transport;
    const signaling = peer.signaling;
    peer.transport = null;
    this.detach(peer, why);
    if (transport !== null) {
      if (close) {
        this.closeAfter(transport, why, graceMs);
      } else {
        void signaling?.close().catch(() => undefined);
      }
    }
    this.drop(peer, why, giveUp);
  }

  /** Closes `transport` after `graceMs`, so that a `leave` just sent goes out first. */
  private closeAfter(transport: Transport, reason: string, graceMs: number): void {
    if (graceMs <= 0) {
      transport.close(reason);
      return;
    }
    this.timers.setTimeout(() => {
      transport.close(reason);
    }, graceMs);
  }

  /** Stops the connection's handlers and pinger and closes its transport (which deletes the peer document). */
  private detach(peer: Peer, reason: string): void {
    for (const off of peer.offs) {
      off();
    }
    peer.offs = [];
    peer.pinger?.stop();
    peer.pinger = null;
    peer.link?.detach();
    peer.link = null;
    peer.transport?.close(reason);
    peer.transport = null;
    peer.signaling = null;
    this.clearRecord(peer);
    if (peer.camera.preview !== null && this.peers.get(peer.camera.id) === peer) {
      this.patch(peer, { preview: null });
    }
  }

  /**
   * Takes the camera off the list; its session entry stays. Its clips still to come are given up
   * (`RemoteCutsService.gone`), with `reason`, unless `giveUp` is false.
   */
  private drop(peer: Peer, reason: string, giveUp = true): void {
    this.stopFinishing(peer);
    this.cuts.gone(peer.camera.id, reason, giveUp);
    this.clearRemoval(peer);
    this.clearRecord(peer);
    const url = peer.camera.thumbnail?.url;
    if (url !== null && url !== undefined) {
      this.globals.URL?.revokeObjectURL(url);
    }
    this.peers.delete(peer.camera.id);
    this.camerasSignal.update((cameras) =>
      cameras.filter((camera) => camera.id !== peer.camera.id),
    );
  }

  private endAll(reason: string, graceMs = LEAVE_GRACE_MS, close = true, giveUp = true): void {
    for (const peer of [...this.peers.values()]) {
      this.end(peer, reason, `The host let the camera go: ${reason}.`, graceMs, close, giveUp);
    }
    this.closeSession();
  }

  /**
   * The session ended (New session, its deletion): a camera connected with clips of it still to come
   * stays until they are in, {@link FINISH_WAIT_MS} at most (T4.2b), the others go at once, as does
   * the pairing. A camera already finishing (a session before) goes on waiting for its own.
   */
  private sessionEnded(): void {
    for (const peer of [...this.peers.values()]) {
      if (peer.finishing !== null) {
        continue;
      }
      const left =
        peer.camera.state === 'connected' && peer.link !== null
          ? this.cuts.pendingOf(peer.camera.id)
          : 0;
      if (left > 0) {
        this.finish(peer, left);
      } else {
        this.end(
          peer,
          'the session ended',
          'The host let the camera go: the session ended.',
          LEAVE_GRACE_MS,
        );
      }
    }
    this.closeSession();
  }

  /** The pairing closed and the offers no longer watched: the session's signaling is let go. */
  private closeSession(): void {
    this.clearExpiry();
    if (this.pairingSignal() !== null) {
      this.pairingSignal.set(null);
      void this.signaling?.signaling.closePairing().catch(() => undefined);
    }
    this.unwatch?.();
    this.unwatch = null;
    this.signaling = null;
  }

  /**
   * Keeps `peer` connected after its session ended, for its `left` clips still to come (T4.2b): the
   * list says so, and the host says `leave` once they are stored, refused or given up (a turn later,
   * so that the last file's acknowledgement goes first), or when {@link FINISH_WAIT_MS} is up, which
   * gives up those still to come. Remove lets it go at once; its connection ending, too.
   */
  private finish(peer: Peer, left: number): void {
    const id = peer.camera.id;
    const leave = (why: string): void => {
      if (this.peers.get(id) === peer) {
        this.end(peer, why, 'The host let the camera go: the session ended.', LEAVE_GRACE_MS);
      }
    };
    this.clearRecord(peer);
    this.patch(peer, { state: 'finishing', sinceMs: this.timers.now(), clipsLeft: left });
    const off = this.cuts.watchPending(id, (pending) => {
      if (pending > 0) {
        this.patch(peer, { clipsLeft: pending });
        return;
      }
      this.stopFinishing(peer);
      this.patch(peer, { clipsLeft: 0 });
      this.timers.setTimeout(() => {
        leave('the session ended');
      }, 0);
    });
    const timer = this.timers.setTimeout(() => {
      this.stopFinishing(peer);
      leave(
        `the session ended; its last clips did not come within ${String(Math.round(this.finishWaitMs / 1000))} s`,
      );
    }, this.finishWaitMs);
    peer.finishing = { timer, off };
  }

  /** Stops waiting for a finishing camera's last clips. */
  private stopFinishing(peer: Peer): void {
    const finishing = peer.finishing;
    if (finishing !== null) {
      peer.finishing = null;
      this.timers.clearTimeout(finishing.timer);
      finishing.off();
    }
  }

  private failed(peer: Peer, step: string, reason: string): void {
    console.warn(
      `cubetrace: remote cameras: ${step} failed for ${peer.camera.device.label}: ${reason}`,
    );
    this.diagnostics.record('rtc.failed', { step, reason, peer: peer.camera.device.label });
  }

  // ---- The clock sync ----

  /**
   * An answer came: the sync shown and sent back; the event and the record at convergence, the event
   * at a withdrawal (the minute's are {@link scheduleRecord}'s); nothing recorded of a camera whose
   * session ended (finishing).
   */
  private sampled(peer: Peer, fit: RemoteClockFit): void {
    const params = fit.params;
    const converged = fit.converged;
    this.patch(peer, {
      sync: {
        converged,
        offsetMs: params.offsetMs,
        rttMs: params.rttMs,
        driftPpm: params.driftPpm,
        samples: params.samples,
        residualP95Ms: params.residualP95Ms,
      },
    });
    peer.link?.trySend({
      type: 'clock',
      converged,
      offsetMs: params.offsetMs,
      rttMs: params.rttMs,
    });
    if (peer.finishing !== null) {
      return;
    }
    if (converged && !peer.converged) {
      peer.converged = true;
      this.recordClock(peer, params, 'converged');
      this.putClock(peer, { ...params, converged: true });
    } else if (!converged && peer.converged) {
      peer.converged = false;
      this.recordClock(peer, params, 'withdrawn');
    }
  }

  /**
   * Once a minute while the camera is connected: `rtc.clock` with the sync as it is (`minute`, and the
   * fit's record into the session, while converged; `syncing` before, once the fit has an answer).
   */
  private scheduleRecord(peer: Peer): void {
    this.clearRecord(peer);
    peer.recordTimer = this.timers.setTimeout(() => {
      peer.recordTimer = null;
      if (peer.camera.state !== 'connected') {
        return;
      }
      if (peer.fit.samples > 0) {
        const params = peer.fit.params;
        this.recordClock(peer, params, peer.converged ? 'minute' : 'syncing');
        if (peer.converged) {
          this.putClock(peer, { ...params, converged: true });
        }
      }
      this.scheduleRecord(peer);
    }, CLOCK_RECORD_MS);
  }

  private clearRecord(peer: Peer): void {
    if (peer.recordTimer !== null) {
      this.timers.clearTimeout(peer.recordTimer);
      peer.recordTimer = null;
    }
  }

  private clearRemoval(peer: Peer): void {
    if (peer.removalTimer !== null) {
      this.timers.clearTimeout(peer.removalTimer);
      peer.removalTimer = null;
    }
  }

  /**
   * The `rtc.clock` event: the fit's record, and the window's round trips (T4.2b: their median and
   * 95th percentile, how many it holds and the share kept), which say how the link behaves whether
   * the fit converged or not; and the phone's last report (T5.1, `reportFacts`), so that the minute's
   * events give a phone's health over a session.
   */
  private recordClock(peer: Peer, params: RemoteClockParams, why: string): void {
    const window = peer.fit.window;
    this.diagnostics.record('rtc.clock', {
      peer: peer.camera.device.label,
      camera: peer.camera.label,
      why,
      converged: peer.converged,
      offsetMs: params.offsetMs,
      rttMs: params.rttMs,
      driftPpm: params.driftPpm,
      samples: params.samples,
      residualP95Ms: params.residualP95Ms,
      windowSamples: window.samples,
      keptShare: window.samples === 0 ? null : round2(window.kept / window.samples),
      rttP50Ms: round1(window.rttP50Ms),
      rttP95Ms: round1(window.rttP95Ms),
      report: reportFacts(peer.camera, this.timers.now(), this.settings.sharpnessThreshold()),
    });
  }

  /**
   * The fit's record into the session's `clock.cameras[label].remote`, beside the lag of a sync
   * check of the camera there may be (T4.3: its `offsetMs`, residual and samples, kept as they are; 0
   * until a check measures them): at convergence and every minute after (`converged` true), and,
   * before that, the estimate a first cut relied on (T4.2, `converged` false, through
   * `RemoteCutsService`).
   */
  private putClock(peer: Peer, params: RemoteClockRecord): void {
    const label = peer.camera.label;
    const session = this.session.session();
    if (label === null || session === null || session.id !== peer.sessionId) {
      return;
    }
    const existing = session.clock.cameras[label] as CameraClock | undefined;
    const clock: CameraClock = {
      offsetMs: existing?.offsetMs ?? 0,
      rttMs: params.rttMs,
      driftPpm: params.driftPpm,
      clapperboardResidualMs: existing?.clapperboardResidualMs ?? 0,
      clapperboardSamples: existing?.clapperboardSamples ?? 0,
      ...(existing?.samples === undefined ? {} : { samples: existing.samples }),
      remote: params,
    };
    this.session.putCameraClock(label, clock);
  }

  // ---- The sync check (T4.3) ----

  /**
   * The phone `id` measures the motion of its frames for a sync check (`sync-start`), and each frame
   * of its `sync-motion` is given to `onSample` with its times on the host clock: its arrival and its
   * reception by the phone's page converted by the clock estimate of the moment its batch came (frozen
   * then, as a clip's is at its cut), its own timestamp kept; how its worker reads them to `onMeter`.
   * The phone's `sync-error`, or the connection's end, ends it with `onError`. Returns the stop, which
   * says `sync-stop`; null when the camera is not connected, or its clock sync has had no answer.
   */
  private watchMotion(
    id: string,
    onSample: (sample: ClapperboardFrame) => void,
    onError: (message: string) => void,
    onMeter: (meter: MotionMeterInfo) => void,
  ): (() => void) | null {
    const peer = this.peers.get(id);
    const link = peer?.link ?? null;
    if (
      peer === undefined ||
      link === null ||
      !link.open ||
      peer.camera.state !== 'connected' ||
      peer.fit.samples === 0
    ) {
      return null;
    }
    const check = this.nextCheck++;
    let watching = true;
    const offs: (() => void)[] = [];
    const end = (): void => {
      watching = false;
      for (const off of offs) {
        off();
      }
    };
    offs.push(
      link.on('sync-motion', (message) => {
        const estimate = clockEstimate(peer.fit);
        if (message.id !== check || estimate === null) {
          return;
        }
        for (const frame of message.frames) {
          onSample({
            timestampUs: frame.timestampUs,
            arrivalHostMs: estimate.toHostMs(frame.arrivalMs),
            receivedHostMs: estimate.toHostMs(frame.receivedMs),
            mean: frame.mean,
            changed: frame.changed,
            costMs: frame.costMs,
          });
        }
      }),
      link.on('sync-meter', (message) => {
        if (message.id === check) {
          onMeter({ ...message.meter, region: { ...message.meter.region } });
        }
      }),
      link.on('sync-error', (message) => {
        if (message.id === check) {
          end();
          onError(`the phone: ${message.message}`);
        }
      }),
      link.transport.onStateChange((state) => {
        if (watching && (state === 'closed' || state === 'failed')) {
          end();
          onError("the phone's connection ended");
        }
      }),
    );
    link.send({ type: 'sync-start', id: check });
    return () => {
      if (watching) {
        end();
        link.trySend({ type: 'sync-stop', id: check });
      }
    };
  }

  // ---- The session's entry, the state and the thumbnails ----

  /**
   * The phone's camera into the session's `cameras[]`, remote, under the label the session gives it
   * (one per device: the phone's host label tells two phones apart).
   */
  private putEntry(peer: Peer): void {
    const camera = peer.camera.camera;
    const session = this.session.session();
    if (camera === null || session === null || session.id !== peer.sessionId) {
      return;
    }
    const entry: CameraInfo = {
      ...camera,
      local: false,
      remote: { label: peer.camera.device.label, platform: peer.camera.device.platform },
    };
    const saved = this.session.putCamera(
      entry,
      session.audio,
      `remote:${peer.camera.device.label}`,
    );
    this.patch(peer, { label: saved?.label ?? null });
  }

  private thumbnail(peer: Peer, message: Thumbnail): void {
    const previous = peer.camera.thumbnail?.url;
    if (previous !== null && previous !== undefined) {
      this.globals.URL?.revokeObjectURL(previous);
    }
    const url =
      this.globals.URL?.createObjectURL(new Blob([message.jpeg.slice()], { type: 'image/jpeg' })) ??
      null;
    this.patch(peer, {
      thumbnail: {
        url,
        width: message.width,
        height: message.height,
        bytes: message.jpeg.length,
        remoteMs: message.remoteMs,
        receivedMs: this.timers.now(),
      },
    });
  }

  private patch(peer: Peer, changes: Partial<RemoteCamera>): void {
    peer.camera = { ...peer.camera, ...changes };
    const camera = peer.camera;
    this.camerasSignal.update((cameras) =>
      cameras.map((known) => (known.id === camera.id ? camera : known)),
    );
  }

  private track(task: Promise<unknown>): void {
    this.pending = Promise.allSettled([this.pending, task]);
  }

  private withTimeout<T>(task: Promise<T>, ms: number, why: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        reject(new Error(why));
      }, ms);
      task.then(
        (value) => {
          this.timers.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.timers.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}

/** A camera of the list as the Timer page's preview area and the sync check see it (T4.3). */
function entryOf(camera: RemoteCamera): RemoteCameraEntry {
  return {
    id: camera.id,
    name: camera.device.label,
    label: camera.label,
    session: camera.session,
    state: camera.state,
    sinceMs: camera.sinceMs,
    synced: camera.sync !== null,
    converged: camera.sync?.converged ?? false,
    recording: camera.report?.recording ?? false,
    framing: camera.report?.framing ?? null,
    frame: camera.report?.frame ?? null,
    deviceLabel: camera.camera?.deviceLabel ?? '',
    preview: camera.preview,
    thumbnail: camera.thumbnail?.url ?? null,
    report: camera.report,
    reportMs: camera.reportMs,
    drift: camera.drift,
  };
}

/**
 * The phone's last report as the `rtc.clock` event carries it (T5.1, docs/DIAGNOSTICS.md): its frame
 * rate and sharpness (to a tenth), whether that is soft by this host's threshold, whether it records,
 * its battery (an event's facts nest one level only: the level, to a hundredth, and the charging side
 * by side), the frame rate's thermal hint, the Compute Pressure state and its source, and how old the
 * report is; null before the first.
 */
export function reportFacts(
  camera: Pick<RemoteCamera, 'report' | 'reportMs'>,
  nowMs: number,
  sharpnessThreshold: number,
): Record<string, string | number | boolean | null> | null {
  const report = camera.report;
  if (report === null) {
    return null;
  }
  return {
    fps: report.fps === null ? null : round1(report.fps),
    sharpness: report.sharpness === null ? null : round1(report.sharpness),
    soft: report.sharpness === null ? null : report.sharpness < sharpnessThreshold,
    recording: report.recording,
    batteryLevel: report.battery === null ? null : round2(report.battery.level),
    batteryCharging: report.battery?.charging ?? null,
    thermal: report.thermal,
    pressure: report.pressure,
    pressureSource: report.pressureSource,
    ageMs: camera.reportMs === null ? null : Math.round(nowMs - camera.reportMs),
  };
}

/** `value` to a tenth. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `value` to a hundredth. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
