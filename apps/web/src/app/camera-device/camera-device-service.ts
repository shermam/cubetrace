import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { isFullFrame } from '@cubetrace/capture';
import { parseSessionPairing, type CameraInfo } from '@cubetrace/core';
import {
  MessageLink,
  PAIRING_TTL_MS,
  PROTOCOL_VERSION,
  answerPings,
  checkPairing,
  hashToken,
  parsePairingInput,
  type DeviceInfo,
  type Hello,
  type PairingCheck,
  type PairingInput,
  type ThermalHint,
  type Transport,
} from '@cubetrace/rtc';

import { APP_BUILD } from '../../environments/version';
import { AuthService, type CloudAccount } from '../auth/auth-service';
import { CameraService } from '../camera/camera-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { WakeLockService } from '../device/wake-lock-service';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { thisDevice } from '../rtc/device-info';
import { helloOrClose } from '../rtc/hello';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { SESSION_SIGNALING, type SessionSignaling } from '../rtc/session-signaling';
import { TRANSPORT_CONNECTOR } from '../rtc/transport-connector';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { watchBattery, type BatteryState } from './battery';
import { CameraDeviceCapture } from './camera-device-capture';
import { CameraDeviceClips } from './camera-device-clips';
import { CameraDevicePreview } from './camera-device-preview';
import { CameraDeviceSync } from './camera-device-sync';
import { THUMBNAIL_GRABBER } from './thumbnail-grabber';

/**
 * Where the camera device is: `idle` (no code yet), `signed-out` (a code, waiting for the account),
 * `checking` (the code against the session), `refused` (the code is not taken, or the host never
 * answered within the pairing's ten minutes: `problem` says why), `joining` (the connection is being
 * made; a first call that failed is made again every few seconds, `problem` saying why, T4.2b),
 * `connected`, `reconnecting` (the connection ended; it calls again for five minutes), `left` (Leave,
 * or the host let it go: `problem` says), `host-gone` (five minutes of calling with no answer).
 */
export type CameraDeviceState =
  | 'idle'
  | 'signed-out'
  | 'checking'
  | 'refused'
  | 'joining'
  | 'connected'
  | 'reconnecting'
  | 'left'
  | 'host-gone';

/** The clock sync as the host reports it back (`clock`, docs/RTC.md §1). */
export interface DeviceClock {
  readonly converged: boolean;
  readonly offsetMs: number;
  readonly rttMs: number;
  /** When it came, on this device's clock. */
  readonly receivedMs: number;
}

/** The pairing as the Camera page took it: the session (found, when the code came alone) and the token. */
export interface Joined {
  readonly sessionId: string;
  readonly token: string;
}

/** How often the camera device sends its `state` and a `thumbnail`. */
export const REPORT_INTERVAL_MS = 2000;

/** The thumbnail's longer side, in pixels (docs/RTC.md §1: at most 320). */
export const THUMBNAIL_PX = 320;

/**
 * How long the camera device waits for the host's `hello` once the channel is open (10 s until
 * T4.2b). The phone says hello the moment its channel opens and the host answers it at once (T4.2b:
 * a host that spoke first could lose its hello, `RemoteCamerasService.connectPeer` says how), and a
 * build of another protocol version says hello all the same (and is refused at once), so the wait
 * only catches a host page that says nothing, for which 5 s more change nothing, or one starved of
 * CPU, which gets half as long again (a hello missed costs a call again, T4.2b, no longer the
 * pairing).
 */
export const HELLO_TIMEOUT_MS = 15_000;

/** How long it keeps calling after its connection ended before it says the host is gone. */
export const RECONNECT_WINDOW_MS = 5 * 60_000;

/** How long it waits between two calls that failed. */
export const RETRY_DELAY_MS = 3000;

/** How long `leave` has to go out before the connection is closed (`RTCPeerConnection.close` drops what is queued). */
export const LEAVE_GRACE_MS = 250;

/** How many of the account's newest sessions are looked at for a code typed without its session. */
const SESSIONS_SEARCHED = 20;

/** Under this share of the camera's nominal frame rate, the state's thermal hint says throttled. */
const THROTTLED_SHARE = 0.8;

/** Why a pairing is refused, in plain words. */
export const REFUSAL_TEXT: Readonly<Record<Exclude<PairingCheck, 'ok'>, string>> = {
  'no-session':
    'No session takes this code: it belongs to a session this account has no document of, or the code is mistyped.',
  'no-pairing': 'This code was used already, or the host closed it: ask for a new QR code.',
  expired: 'This code expired: ask the host to show a new QR code.',
  'wrong-token': 'This code is not the one the host shows: check it, or scan the QR code.',
};

/**
 * The phone as a camera of another device's session (docs/PLAN.md T4.1, docs/RTC.md): the Camera
 * page's service. Given a code (the QR's URL, or the token typed: `join`), with the account signed
 * in (the pairing's documents are its own; signed out it waits for the sign-in and keeps the
 * code), it finds the session (named in the URL, or the newest of the account's sessions whose
 * pairing holds the token's hash), checks the pairing (`checkPairing`), calls (`call`, the
 * connector: `WebRtcTransport.connect` as the caller; a first call that fails is made again with
 * the same token every few seconds for the pairing's ten minutes, T4.2b) and, once the channel is
 * open, exchanges `hello` with the host (its device and build, and the phone's camera as its own
 * session.json would describe it, sent again when the camera changes), answers the pings
 * (`answerPings`), sends its `state` and a `thumbnail` of the preview every 2 s, and shows what
 * the host measures of the clock (`clock`). It holds the wake lock while joined (the Camera page
 * keeps the pipeline running, `CameraDeviceCapture`, the ring buffer from the moment it opens) and
 * reconnects by itself: the transport restarts ICE on a failure; once it ends, the service calls
 * again with the same token every few seconds for five minutes (the host answers a camera it lists
 * as reconnecting), then says the host is gone. Leave sends `leave`, closes the connection once
 * the word is out, and lets the wake lock go; the page going (`pagehide`) says `leave` as far as
 * there is time. It never shows the timer and never starts a session of its own. The host's cuts
 * and the clips they make go through `CameraDeviceClips` (T4.2), which each connection is handed
 * to: the clips staged for the session are offered first; and so do the host's sync check of this
 * camera (`CameraDeviceSync`, T4.3: the frames' motion measured and sent) and the live preview
 * (`CameraDevicePreview`, T4.3: the camera's track over the connection while the host asks for it).
 */
@Injectable({ providedIn: 'root' })
export class CameraDeviceService {
  private readonly auth = inject(AuthService);
  private readonly camera = inject(CameraService);
  private readonly capture = inject(CameraDeviceCapture);
  /** The host's cuts and the clips sent (T4.2). */
  private readonly clips = inject(CameraDeviceClips);
  /** The host's sync check of this camera, and the live preview (T4.3). */
  private readonly syncCheck = inject(CameraDeviceSync);
  private readonly livePreview = inject(CameraDevicePreview);
  private readonly settings = inject(SettingsService);
  private readonly wakeLock = inject(WakeLockService);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly timers = inject(RTC_TIMERS);
  private readonly makeSignaling = inject(SESSION_SIGNALING);
  private readonly connect = inject(TRANSPORT_CONNECTOR);
  private readonly grabber = inject(THUMBNAIL_GRABBER);

  private readonly stateSignal = signal<CameraDeviceState>('idle');
  private readonly inputSignal = signal<PairingInput | null>(null);
  private readonly joinedSignal = signal<Joined | null>(null);
  private readonly hostSignal = signal<Hello | null>(null);
  private readonly clockSignal = signal<DeviceClock | null>(null);
  private readonly problemSignal = signal<string | null>(null);
  private readonly sinceSignal = signal(0);
  private readonly pingsSignal = signal(0);
  private readonly batterySignal = signal<BatteryState | null>(null);
  private readonly reportsSignal = signal(0);

  /** See {@link CameraDeviceState}. */
  readonly state = this.stateSignal.asReadonly();
  /** The code given, kept across the sign-in and a failure; null before one. */
  readonly input = this.inputSignal.asReadonly();
  /** The session joined and the token, once the code was taken. */
  readonly joined = this.joinedSignal.asReadonly();
  /** The host, as its `hello` named it; null until the first connection. */
  readonly host = this.hostSignal.asReadonly();
  /** The host's device, for the page. */
  readonly hostDevice = computed<DeviceInfo | null>(() => this.hostSignal()?.device ?? null);
  /** The clock sync as the host last reported it; null before the first report. */
  readonly clock = this.clockSignal.asReadonly();
  /**
   * Why the state is `refused`, `left` or `host-gone`, or why the first call is made again while
   * `joining` (T4.2b); null otherwise.
   */
  readonly problem = this.problemSignal.asReadonly();
  /** When the current state began, on this device's clock. */
  readonly since = this.sinceSignal.asReadonly();
  /** The pings answered over the current connection. */
  readonly pings = this.pingsSignal.asReadonly();
  /** The `state` messages sent over the current connection. */
  readonly reports = this.reportsSignal.asReadonly();
  /** The phone's battery, when the browser says. */
  readonly battery = this.batterySignal.asReadonly();
  /** The clips cut for the host that it has not answered for (T4.2), staged on this phone. */
  readonly pendingClips = computed(() => this.clips.pending());
  /** The thermal hint of the next `state`: throttled when the frame rate dropped under 80% of the nominal. */
  readonly thermal = computed<ThermalHint>(() => {
    const fps = this.camera.measuredFps();
    const nominal = this.camera.settings()?.['frameRate'];
    if (fps === null || typeof nominal !== 'number' || nominal <= 0) {
      return null;
    }
    return fps < THROTTLED_SHARE * nominal ? 'throttled' : 'ok';
  });

  private link: MessageLink | null = null;
  private transport: Transport | null = null;
  private offs: (() => void)[] = [];
  /** Each join and each leave has a number: an older call's outcome is not the current one's. */
  private generation = 0;
  private reportTimer: unknown = null;
  private retryTimer: unknown = null;
  private preview: HTMLVideoElement | null = null;
  private lockHeld = false;
  /** When the current connection opened, on this device's clock. */
  private connectedMs = 0;
  /**
   * Until when a first call that failed is made again (T4.2b): the pairing's ten minutes from the
   * check, which the host's own wait for the camera it took the token for outlasts.
   */
  private joinUntilMs = 0;
  private unwatchBattery: (() => void) | null = null;
  private lastHello = '';
  /** The operations under way, for the tests to wait on. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor() {
    // The clips staged more than a day ago go (T4.2).
    this.clips.start();
    // Signed in with a code waiting: the join goes on.
    effect(() => {
      const account = this.auth.cloud();
      untracked(() => {
        if (account !== null && this.stateSignal() === 'signed-out') {
          this.track(this.start());
        }
      });
    });
    // The camera changed while connected: the host gets the new description.
    effect(() => {
      const hello = JSON.stringify(this.hello());
      untracked(() => {
        if (this.stateSignal() === 'connected' && hello !== this.lastHello) {
          this.lastHello = hello;
          this.link?.trySend(this.hello());
        }
      });
    });
    // The page goes: `leave` as far as there is time; the browser closes the connection itself, and
    // closing it here would drop the word.
    const onPageHide = (): void => {
      this.end('the page closed', 0, false);
    };
    this.globals.addEventListener?.('pagehide', onPageHide);
    inject(DestroyRef).onDestroy(() => {
      this.globals.removeEventListener?.('pagehide', onPageHide);
      this.end('the page closed', 0);
      this.unwatchBattery?.();
    });
  }

  /**
   * Takes a code: the QR's URL, or a token typed by hand. False, with `problem`, when the text is
   * neither; true when the join begins (or waits for the sign-in).
   */
  typed(text: string): boolean {
    const input = parsePairingInput(text);
    if (input === null) {
      this.problemSignal.set(
        'That is not a code: type the 8 characters under the QR code, or paste its link.',
      );
      return false;
    }
    this.join(input);
    return true;
  }

  /** Joins the session of `input` (the QR's URL, or a token alone), as far as the account allows. */
  join(input: PairingInput): void {
    this.end('a new code', LEAVE_GRACE_MS);
    this.inputSignal.set(input);
    this.joinedSignal.set(null);
    this.problemSignal.set(null);
    this.track(this.start());
  }

  /** Leaves the session: `leave` to the host, the connection closed, the pipeline let go. */
  leave(): void {
    if (this.stateSignal() === 'idle' || this.stateSignal() === 'left') {
      return;
    }
    this.end('the user left', LEAVE_GRACE_MS);
    this.setState('left', 'You left the session. Scan a new QR code to join again.');
  }

  /** Forgets the code and the outcome: the page shows the field again. */
  reset(): void {
    this.end('a new code', LEAVE_GRACE_MS);
    this.inputSignal.set(null);
    this.joinedSignal.set(null);
    this.hostSignal.set(null);
    this.clockSignal.set(null);
    this.setState('idle', null);
  }

  /** The preview `<video>` the thumbnails are taken from; null when the page has none. */
  setPreview(video: HTMLVideoElement | null): void {
    this.preview = video;
  }

  /** Resolves once the operations under way have settled, for the tests. */
  async whenIdle(): Promise<void> {
    let last: Promise<unknown> | null = null;
    while (last !== this.pending) {
      last = this.pending;
      await last;
    }
  }

  // ---- The join ----

  private async start(): Promise<void> {
    const input = this.inputSignal();
    if (input === null) {
      return;
    }
    const account = this.auth.cloud();
    if (account === null) {
      this.setState('signed-out', null);
      return;
    }
    const generation = ++this.generation;
    this.setState('checking', null);
    this.unwatchBattery ??= watchBattery(this.globals.navigator, (battery) => {
      this.batterySignal.set(battery);
    });
    let sessionId: string | null;
    try {
      sessionId = input.sessionId ?? (await this.findSession(account, input.token));
    } catch (error: unknown) {
      this.refuse('session', `The account's sessions could not be read: ${errorMessage(error)}`);
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    if (sessionId === null) {
      this.refuse('session', REFUSAL_TEXT['no-session']);
      return;
    }
    const signaling = this.makeSignaling(account, sessionId);
    let check: PairingCheck;
    try {
      check = await signaling.checkPairing(input.token);
    } catch (error: unknown) {
      this.refuse('check', `The code could not be checked: ${errorMessage(error)}`);
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    if (check !== 'ok') {
      this.refuse('check', REFUSAL_TEXT[check]);
      return;
    }
    this.joinedSignal.set({ sessionId, token: input.token });
    // The clips staged for this session are offered first over each connection; others' go.
    this.clips.join(sessionId);
    this.hold();
    this.setState('joining', null);
    this.joinUntilMs = this.timers.now() + PAIRING_TTL_MS;
    await this.call(signaling, await hashToken(input.token), generation, false);
  }

  /**
   * The newest of the account's sessions whose pairing holds the token's hash and has not expired:
   * a code typed without its link names no session.
   */
  private async findSession(account: CloudAccount, token: string): Promise<string | null> {
    const hash = await hashToken(token);
    const listing = await account.backend.listSessions(account.uid, SESSIONS_SEARCHED);
    const now = this.timers.now();
    for (const document of listing.documents) {
      const data: unknown = document.data;
      let pairing;
      try {
        pairing = parseSessionPairing(
          typeof data === 'object' && data !== null ? Reflect.get(data, 'pairing') : undefined,
        );
      } catch {
        continue;
      }
      if (checkPairing(pairing, hash, now) === null) {
        return document.id;
      }
    }
    return null;
  }

  /** One call: the connection, the hellos, the handlers; a failure while reconnecting tries again. */
  private async call(
    signaling: SessionSignaling,
    tokenHash: string,
    generation: number,
    again: boolean,
  ): Promise<void> {
    const started = this.timers.now();
    const peer = signaling.call({ tokenHash });
    let transport: Transport;
    try {
      transport = await this.connect(peer);
    } catch (error: unknown) {
      if (generation !== this.generation) {
        return;
      }
      this.failed('connect', errorMessage(error));
      this.retry(signaling, tokenHash, generation, again, started, errorMessage(error));
      return;
    }
    if (generation !== this.generation) {
      transport.close('superseded');
      return;
    }
    const link = new MessageLink(transport);
    this.transport = transport;
    this.link = link;
    this.lastHello = JSON.stringify(this.hello());
    link.send(this.hello());
    let hello: Hello;
    try {
      hello = await this.withTimeout(
        helloOrClose(link, 'host'),
        HELLO_TIMEOUT_MS,
        'the host sent no hello',
      );
    } catch (error: unknown) {
      if (generation !== this.generation) {
        return;
      }
      this.failed('hello', errorMessage(error));
      this.closeConnection('no hello');
      this.retry(signaling, tokenHash, generation, again, started, errorMessage(error));
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    if (hello.v !== PROTOCOL_VERSION || hello.role !== 'host') {
      const reason =
        hello.v !== PROTOCOL_VERSION
          ? `the host runs protocol version ${String(hello.v)}, this phone ${String(PROTOCOL_VERSION)}: update the app on both`
          : `the peer is a ${hello.role}, not a host`;
      link.trySend({ type: 'leave', reason });
      this.failed('version', reason);
      this.generation++;
      this.closeConnection('version', LEAVE_GRACE_MS);
      this.setState('refused', `The host could not be joined: ${reason}.`);
      return;
    }
    const now = this.timers.now();
    this.connectedMs = now;
    this.pingsSignal.set(0);
    this.reportsSignal.set(0);
    this.hostSignal.set(hello);
    this.setState('connected', null);
    this.offs.push(
      answerPings(link, () => this.timers.now()),
      link.on('ping', () => {
        this.pingsSignal.update((count) => count + 1);
      }),
      link.on('clock', (message) => {
        this.clockSignal.set({
          converged: message.converged,
          offsetMs: message.offsetMs,
          rttMs: message.rttMs,
          receivedMs: this.timers.now(),
        });
      }),
      link.on('leave', (message) => {
        this.hostLeft(generation, message.reason);
      }),
      link.onError((error) => {
        console.warn(`cubetrace: camera device: a frame was not a message: ${error.message}`);
      }),
      transport.onStateChange((state, reason) => {
        if (state === 'closed' || state === 'failed') {
          this.disconnected(signaling, tokenHash, generation, reason ?? state);
        }
      }),
      // The host's cuts, and the clips staged: offered first (T4.2).
      this.clips.attach(link),
      // The host's sync check of this camera, and the live preview when the host asks for it (T4.3).
      this.syncCheck.attach(link),
      this.livePreview.attach(link, transport),
    );
    this.startReporting();
    const facts = {
      host: hello.device.label,
      platform: hello.device.platform,
      session: this.joinedSignal()?.sessionId ?? null,
      ms: Math.round(now - started),
    };
    if (!again) {
      this.diagnostics.record('rtc.paired', {
        ...facts,
        version: hello.app.version,
        commit: hello.app.commit,
      });
    }
    this.diagnostics.record('rtc.connected', { ...facts, reconnection: again });
  }

  /**
   * The call failed: again in a moment while the window lasts, else the host is gone. A first call
   * is made again too (T4.2b), with the same token, until the pairing's ten minutes are up: the code
   * was good when checked, and the host, which may have taken it for this call already, answers this
   * phone's calls until it connects; a missed deadline (a hello the other side's busy page sent
   * late) is a call again, not a lost pairing.
   */
  private retry(
    signaling: SessionSignaling,
    tokenHash: string,
    generation: number,
    again: boolean,
    failedAt: number,
    reason: string,
  ): void {
    if (!again) {
      if (this.timers.now() + RETRY_DELAY_MS >= this.joinUntilMs) {
        this.generation++;
        this.unhold();
        this.setState('refused', `The host could not be reached: ${reason}.`);
        return;
      }
      this.problemSignal.set(`The host did not answer yet (${reason}): calling again.`);
      this.retryTimer = this.timers.setTimeout(() => {
        this.retryTimer = null;
        if (generation === this.generation && this.stateSignal() === 'joining') {
          void this.call(signaling, tokenHash, generation, false);
        }
      }, RETRY_DELAY_MS);
      return;
    }
    if (this.timers.now() - this.sinceSignal() >= RECONNECT_WINDOW_MS) {
      this.gone(failedAt);
      return;
    }
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (generation === this.generation && this.stateSignal() === 'reconnecting') {
        void this.call(signaling, tokenHash, generation, true);
      }
    }, RETRY_DELAY_MS);
  }

  /** The connection ended without a `leave`: it calls again, for five minutes. */
  private disconnected(
    signaling: SessionSignaling,
    tokenHash: string,
    generation: number,
    reason: string,
  ): void {
    if (generation !== this.generation) {
      return;
    }
    const now = this.timers.now();
    this.diagnostics.record('rtc.disconnected', {
      host: this.hostSignal()?.device.label ?? null,
      reason,
      durationMs: Math.round(now - this.connectedMs),
    });
    this.closeConnection(reason);
    if (this.stateSignal() !== 'reconnecting') {
      this.setState('reconnecting', null);
    }
    const next = ++this.generation;
    void this.call(signaling, tokenHash, next, true);
  }

  /** Five minutes of calling with no answer. */
  private gone(sinceMs: number): void {
    this.generation++;
    this.diagnostics.record('rtc.disconnected', {
      host: this.hostSignal()?.device.label ?? null,
      reason: 'gave up: no answer in five minutes',
      durationMs: Math.round(this.timers.now() - sinceMs),
    });
    this.unhold();
    this.setState(
      'host-gone',
      'The host is gone: it did not answer for five minutes. Ask it to show a new QR code.',
    );
  }

  /** The host said `leave`: Remove, or the session ended. */
  private hostLeft(generation: number, reason: string): void {
    if (generation !== this.generation) {
      return;
    }
    this.diagnostics.record('rtc.disconnected', {
      host: this.hostSignal()?.device.label ?? null,
      reason: `host left: ${reason}`,
      durationMs: Math.round(this.timers.now() - this.connectedMs),
    });
    this.generation++;
    this.closeConnection('the host left');
    this.unhold();
    this.setState('left', `The host let this camera go: ${reason}`);
  }

  /**
   * Ends everything on this device's initiative: `leave` when connected, the connection closed after
   * `graceMs` (or left to the browser, when `close` is false: the page is going).
   */
  private end(reason: string, graceMs: number, close = true): void {
    const state = this.stateSignal();
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.link !== null && state === 'connected') {
      this.link.trySend({ type: 'leave', reason });
      this.diagnostics.record('rtc.disconnected', {
        host: this.hostSignal()?.device.label ?? null,
        reason,
        durationMs: Math.round(this.timers.now() - this.connectedMs),
      });
    }
    this.generation++;
    this.closeConnection(reason, graceMs, close);
    this.unhold();
  }

  private closeConnection(reason: string, graceMs = 0, close = true): void {
    this.stopReporting();
    for (const off of this.offs) {
      off();
    }
    this.offs = [];
    this.link?.detach();
    this.link = null;
    const transport = this.transport;
    this.transport = null;
    if (transport === null || !close) {
      return;
    }
    if (graceMs <= 0) {
      transport.close(reason);
    } else {
      this.timers.setTimeout(() => {
        transport.close(reason);
      }, graceMs);
    }
  }

  private refuse(step: string, message: string): void {
    this.failed(step, message);
    this.setState('refused', message);
  }

  private failed(step: string, reason: string): void {
    console.warn(`cubetrace: camera device: ${step} failed: ${reason}`);
    this.diagnostics.record('rtc.failed', { step, reason });
  }

  private setState(state: CameraDeviceState, problem: string | null): void {
    this.stateSignal.set(state);
    this.problemSignal.set(problem);
    this.sinceSignal.set(this.timers.now());
  }

  // ---- The hello, the state and the thumbnails ----

  /** This device's `hello`: its device and build, and its camera as it is now. */
  private hello(): Hello {
    const info = this.camera.cameraInfo();
    const camera: CameraInfo | null =
      info === null ? null : { ...info, microphone: this.capture.microphone() };
    return {
      type: 'hello',
      v: PROTOCOL_VERSION,
      role: 'camera',
      device: thisDevice(this.settings, this.globals),
      app: APP_BUILD,
      camera,
    };
  }

  private startReporting(): void {
    this.stopReporting();
    const tick = (): void => {
      this.reportTimer = this.timers.setTimeout(tick, REPORT_INTERVAL_MS);
      this.report();
    };
    tick();
  }

  private stopReporting(): void {
    if (this.reportTimer !== null) {
      this.timers.clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
  }

  /** The `state` now, and a `thumbnail` of the preview when there is one. */
  private report(): void {
    const link = this.link;
    if (link === null || !link.open) {
      return;
    }
    const rect = this.camera.framing();
    const size = this.camera.frameSize();
    const sent = link.trySend({
      type: 'state',
      remoteMs: this.timers.now(),
      recording: this.capture.status() === 'recording',
      framing:
        rect === null || size === null || isFullFrame(rect, size)
          ? null
          : { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      frame: size,
      fps: this.camera.measuredFps(),
      sharpness: this.camera.sharpness(),
      battery: this.batterySignal(),
      thermal: this.thermal(),
      pendingClips: this.clips.pending(),
    });
    if (sent) {
      this.reportsSignal.update((count) => count + 1);
    }
    const preview = this.preview;
    if (preview === null) {
      return;
    }
    this.track(
      this.grabber.grab(preview, THUMBNAIL_PX).then(
        (grabbed) => {
          if (grabbed !== null && this.link === link) {
            link.trySend({
              type: 'thumbnail',
              remoteMs: this.timers.now(),
              width: grabbed.width,
              height: grabbed.height,
              jpeg: grabbed.jpeg,
            });
          }
        },
        () => undefined,
      ),
    );
  }

  // ---- The wake lock ----

  private hold(): void {
    if (!this.lockHeld && !this.wakeLock.wanted()) {
      this.lockHeld = true;
      void this.wakeLock.request();
    }
  }

  private unhold(): void {
    if (this.lockHeld) {
      this.lockHeld = false;
      void this.wakeLock.release();
    }
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
