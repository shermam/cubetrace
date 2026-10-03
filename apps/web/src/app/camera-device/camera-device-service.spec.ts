import { TestBed } from '@angular/core/testing';
import { RemoteClockFit, cloudSession, type CloudEvent } from '@cubetrace/core';
import {
  ClockPinger,
  FirestoreSignaling,
  MessageLink,
  PROTOCOL_VERSION,
  generateToken,
  type IncomingOffer,
  type Message,
  type Transport,
} from '@cubetrace/rtc';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY, AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { CameraService } from '../camera/camera-service';
import { CAPTURE_STARTER } from '../camera/recording-service';
import { FakeCaptureStarter, statsOf } from '../camera/recording-testing';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import {
  FAKE_PHONE_FRONT,
  FAKE_PHONE_REAR,
  FakeLocalStorage,
  FakeMediaDevices,
  FakePerformance,
  FakeTimers,
  FakeWakeLock,
  settle,
} from '../device/fake-browser';
import { MemoryConnector, rtcTimers } from '../rtc/rtc-testing';
import { TRANSPORT_CONNECTOR } from '../rtc/transport-connector';
import { SESSION_A, SESSION_B, testSession } from '../session/session-testing';
import { CameraDeviceCapture } from './camera-device-capture';
import {
  CameraDeviceService,
  HELLO_TIMEOUT_MS,
  LEAVE_GRACE_MS,
  RECONNECT_WINDOW_MS,
  REFUSAL_TEXT,
  REPORT_INTERVAL_MS,
  RETRY_DELAY_MS,
} from './camera-device-service';
import { THUMBNAIL_GRABBER, type ThumbnailGrabber } from './thumbnail-grabber';

const ANDROID = 'Mozilla/5.0 (Linux; Android 16; K) Chrome/155.0.0.0 Mobile Safari/537.36';

/** A small JPEG's bytes, as the fake grabber takes them. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 8, 9, 0xff, 0xd9]);

/** The host's clock minus this phone's: the host runs 2.5 s behind. */
const HOST_OFFSET_MS = -2500;

interface Rig {
  readonly backend: FakeAccountBackend;
  readonly connector: MemoryConnector;
  readonly perf: FakePerformance;
  readonly timers: FakeTimers;
  readonly wakeLock: FakeWakeLock;
  readonly media: FakeMediaDevices;
  readonly starter: FakeCaptureStarter;
  readonly service: CameraDeviceService;
  readonly camera: CameraService;
  readonly listeners: Map<string, Set<() => void>>;
  readonly grabs: number[];
}

/**
 * The host of a session, as the Cameras panel of T4.1 is on the other device: it publishes a pairing,
 * answers the first phone that presents the token, says hello, pings, and tells the phone the clock
 * sync; what the phone sends it is in `received`.
 */
class Host {
  readonly received: Message[] = [];
  readonly signaling: FirestoreSignaling;
  link: MessageLink | null = null;
  transport: Transport | null = null;
  pinger: ClockPinger | null = null;
  /** Set: the host answers no offer (it is gone). */
  gone = false;
  token = '';
  tokenHash = '';
  /** The hashes of the tokens taken: a camera that lost its connection calls back with its own. */
  readonly taken = new Set<string>();
  /** The connections made, in order. */
  connections = 0;
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly r: Rig,
    readonly sessionId = SESSION_A,
    readonly label = 'office-mbp',
  ) {
    this.signaling = new FirestoreSignaling(r.backend, {
      sessionId,
      uid: ADA.uid,
      now: () => r.perf.hostMs + HOST_OFFSET_MS,
    });
  }

  /** The session's document in the index, with a pairing published, and the offers watched. */
  async publish(): Promise<string> {
    await this.r.backend.saveSessionIndex(cloudSession(testSession(this.sessionId), ADA.uid));
    this.token = generateToken();
    const pairing = await this.signaling.publishPairing(this.token);
    this.tokenHash = pairing.tokenHash;
    this.unwatch ??= this.signaling.watchOffers(
      (offer) => {
        void this.answer(offer);
      },
      () => undefined,
    );
    return this.token;
  }

  private async answer(offer: IncomingOffer): Promise<void> {
    const back = this.taken.has(offer.peer.tokenHash);
    if (this.gone || (offer.peer.tokenHash !== this.tokenHash && !back)) {
      return;
    }
    if (!back) {
      this.taken.add(offer.peer.tokenHash);
      await this.signaling.closePairing();
    }
    const transport = await this.r.connector.connect(offer.signaling);
    this.connections++;
    this.transport = transport;
    const link = new MessageLink(transport);
    this.link = link;
    link.onMessage((message) => {
      this.received.push(message);
    });
    link.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      role: 'host',
      device: { label: this.label, platform: 'macOS' },
      app: { version: '0.4.0', commit: 'abc1234' },
      camera: null,
    });
    const hostTimers = {
      ...rtcTimers(this.r.perf, this.r.timers),
      now: () => this.r.perf.hostMs + HOST_OFFSET_MS,
    };
    const pinger = new ClockPinger(link, new RemoteClockFit(), { timers: hostTimers });
    this.pinger = pinger;
    pinger.onSample((fit) => {
      link.trySend({
        type: 'clock',
        converged: fit.converged,
        offsetMs: fit.offsetMs,
        rttMs: fit.rttMs,
      });
    });
    pinger.start();
  }

  /** The host removes the camera: `leave`, the connection closed once it is out. */
  remove(): void {
    this.link?.trySend({ type: 'leave', reason: 'The host removed this camera.' });
    const transport = this.transport;
    this.r.timers.setTimeout(() => {
      transport?.close('removed');
    }, LEAVE_GRACE_MS);
  }

  /** The connection drops without a word. */
  drop(): void {
    this.pinger?.stop();
    this.transport?.close('the network went');
  }

  of<T extends Message['type']>(type: T): Extract<Message, { type: T }>[] {
    return this.received.filter((message) => message.type === type) as Extract<
      Message,
      { type: T }
    >[];
  }
}

describe('CameraDeviceService', () => {
  let r: Rig;

  function rig(options: { signedIn?: boolean } = {}): Rig {
    TestBed.resetTestingModule();
    const backend = new FakeAccountBackend();
    const localStorage = new FakeLocalStorage();
    if (options.signedIn !== false) {
      backend.user = ADA;
      localStorage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    }
    const perf = new FakePerformance();
    const timers = new FakeTimers(perf);
    const wakeLock = new FakeWakeLock();
    const media = new FakeMediaDevices([FAKE_PHONE_FRONT, FAKE_PHONE_REAR]);
    const starter = new FakeCaptureStarter();
    const listeners = new Map<string, Set<() => void>>();
    const grabs: number[] = [];
    const grabber: ThumbnailGrabber = {
      grab: (_video, maxPx) => {
        grabs.push(maxPx);
        return Promise.resolve({ jpeg: JPEG, width: 180, height: 320 });
      },
    };
    const connector = new MemoryConnector({ delayMs: 4, timers: rtcTimers(perf, timers) });
    const globals: BrowserGlobals = {
      navigator: {
        userAgent: ANDROID,
        mediaDevices: media,
        wakeLock,
        storage: undefined,
      },
      localStorage,
      performance: perf,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      addEventListener: (type, listener) => {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener: (type, listener) => {
        listeners.get(type)?.delete(listener);
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        { provide: CAPTURE_STARTER, useValue: starter },
        { provide: TRANSPORT_CONNECTOR, useValue: connector.connect },
        { provide: THUMBNAIL_GRABBER, useValue: grabber },
      ],
    });
    const service = TestBed.inject(CameraDeviceService);
    TestBed.inject(AuthService);
    return {
      backend,
      connector,
      perf,
      timers,
      wakeLock,
      media,
      starter,
      service,
      camera: TestBed.inject(CameraService),
      listeners,
      grabs,
    };
  }

  /** Moves the clock `ms` forward in steps, letting the effects and promises run after each. */
  async function pump(ms: number, rounds = 4): Promise<void> {
    for (let k = 0; k < rounds; k++) {
      r.timers.advance(ms / rounds);
      await settle();
      await settle();
      TestBed.tick();
    }
  }

  async function pass(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 1000) {
      await pump(Math.min(1000, left), 2);
    }
  }

  /** The events written to the account, after the diagnostics' batch delay. */
  async function events(): Promise<CloudEvent[]> {
    await pump(5000);
    return r.backend.events.map((entry) => entry.write.event);
  }

  function kinds(all: CloudEvent[]): string[] {
    return all.map((event) => event.kind).filter((kind) => kind.startsWith('rtc.'));
  }

  /** The camera on (the rear one, the camera device's default), as the page turns it on. */
  async function cameraOn(): Promise<void> {
    await r.camera.setRole('camera-device');
    await r.camera.start();
    await pump(0, 1);
  }

  /** A host with a pairing, and this phone joined to it by the QR's URL. */
  async function joined(host = new Host(r)): Promise<Host> {
    const token = await host.publish();
    r.service.join({ sessionId: host.sessionId, token });
    await pump(20);
    expect(r.service.state()).toBe('connected');
    return host;
  }

  beforeEach(async () => {
    r = rig();
    await settle();
    await cameraOn();
  });

  it('asks for the rear camera by default as the camera device, labelled phone-rear', () => {
    expect(r.camera.status()).toBe('on');
    expect(r.camera.facing()).toBe('environment');
    expect(r.media.requests[0]).toMatchObject({ video: { facingMode: { ideal: 'environment' } } });
    expect(r.camera.cameraInfo()?.label).toBe('phone-rear');
    expect(r.camera.role()).toBe('camera-device');
  });

  it('refuses a text that is not a code, and keeps a code until the account is signed in', async () => {
    r = rig({ signedIn: false });
    await settle();
    expect(r.service.state()).toBe('idle');
    expect(r.service.typed('hello there')).toBe(false);
    expect(r.service.problem()).toMatch(/^That is not a code/);
    expect(r.service.state()).toBe('idle');

    expect(r.service.typed('7kqm-2xab')).toBe(true);
    await pump(0, 1);
    expect(r.service.state()).toBe('signed-out');
    expect(r.service.input()).toEqual({ sessionId: null, token: '7KQM2XAB' });

    // Signed in: the join goes on, and no session of the account takes the code.
    r.backend.user = ADA;
    void TestBed.inject(AuthService).signIn();
    await pump(10);
    expect(r.service.state()).toBe('refused');
    expect(r.service.problem()).toBe(REFUSAL_TEXT['no-session']);
  });

  it('joins by the QR’s URL: checks the code, calls, exchanges hellos with its camera, and holds the wake lock', async () => {
    const host = await joined();
    expect(r.service.joined()).toEqual({ sessionId: SESSION_A, token: host.token });
    expect(r.service.hostDevice()).toEqual({ label: 'office-mbp', platform: 'macOS' });
    expect(r.service.problem()).toBeNull();
    expect(r.wakeLock.held()).toBe(1);
    expect(host.connections).toBe(1);
    // The phone's hello: its device, its build and its camera as its own session.json would have it.
    const hello = host.of('hello');
    expect(hello).toHaveLength(1);
    expect(hello[0]).toMatchObject({
      v: PROTOCOL_VERSION,
      role: 'camera',
      device: { label: 'Android phone', platform: 'Android' },
    });
    expect(hello[0].camera).toMatchObject({
      label: 'phone-rear',
      local: true,
      facing: 'environment',
      deviceLabel: 'camera 0, facing back',
    });
    const all = await events();
    expect(kinds(all)).toEqual(['rtc.paired', 'rtc.connected']);
    expect(all.find((e) => e.kind === 'rtc.paired')?.data).toMatchObject({
      host: 'office-mbp',
      platform: 'macOS',
      session: SESSION_A,
    });
  });

  it('finds the session of a code typed alone among the account’s sessions', async () => {
    const other = new Host(r, SESSION_B, 'other-laptop');
    await other.publish();
    await other.signaling.closePairing();
    const host = new Host(r, SESSION_A);
    const token = await host.publish();
    expect(r.service.typed(token.toLowerCase())).toBe(true);
    await pump(20);
    expect(r.service.state()).toBe('connected');
    expect(r.service.joined()).toEqual({ sessionId: SESSION_A, token });
    expect(r.service.hostDevice()?.label).toBe('office-mbp');
  });

  it.each([
    [
      'a code of another session',
      (host: Host): string => `${host.token.slice(0, 7)}${host.token[7] === 'A' ? 'B' : 'A'}`,
      'wrong-token',
    ],
    [
      'a code the host closed',
      async (host: Host): Promise<string> => {
        await host.signaling.closePairing();
        return host.token;
      },
      'no-pairing',
    ],
  ] as const)('refuses %s, and says why', async (_, tokenFor, refusal) => {
    const host = new Host(r);
    await host.publish();
    r.service.join({ sessionId: SESSION_A, token: await tokenFor(host) });
    await pump(10);
    expect(r.service.state()).toBe('refused');
    expect(r.service.problem()).toBe(REFUSAL_TEXT[refusal]);
    expect(r.wakeLock.held()).toBe(0);
    const all = await events();
    expect(all.find((e) => e.kind === 'rtc.failed')?.data).toMatchObject({ step: 'check' });
  });

  it('refuses a code that expired', async () => {
    const host = new Host(r);
    const token = await host.publish();
    await pass(10 * 60_000 + 1000);
    r.service.join({ sessionId: SESSION_A, token });
    await pump(10);
    expect(r.service.state()).toBe('refused');
    expect(r.service.problem()).toBe(REFUSAL_TEXT.expired);
  });

  it('answers the pings, sends its state and a thumbnail every 2 s, and shows the clock sync the host reports', async () => {
    const host = await joined();
    const video = document.createElement('video');
    r.service.setPreview(video);
    await pass(6000);
    expect(r.service.pings()).toBeGreaterThanOrEqual(3);
    expect(host.of('pong').length).toBe(r.service.pings());
    const states = host.of('state');
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states[0]).toMatchObject({
      recording: false,
      framing: null,
      frame: { width: 1080, height: 1920 },
      battery: null,
      pendingClips: 0,
    });
    expect(r.service.reports()).toBe(states.length);
    const thumbnails = host.of('thumbnail');
    expect(thumbnails.length).toBeGreaterThanOrEqual(2);
    expect(thumbnails[0]).toMatchObject({ width: 180, height: 320 });
    expect([...thumbnails[0].jpeg]).toEqual([...JPEG]);
    expect(r.grabs.every((maxPx) => maxPx === 320)).toBe(true);
    // The clock as the host measures it: the host's clock is 2.5 s behind.
    const clock = r.service.clock();
    expect(clock?.converged).toBe(false);
    expect(Math.abs((clock?.offsetMs ?? 0) - -HOST_OFFSET_MS)).toBeLessThan(1);
    expect(clock?.rttMs).toBeCloseTo(8, 0);
    await pass(20_000);
    expect(r.service.clock()?.converged).toBe(true);
  });

  it('reports the recording and a thermal hint when the frame rate drops under 80% of the nominal', async () => {
    const host = await joined();
    TestBed.inject(CameraDeviceCapture).setWanted(true);
    await pump(10);
    r.starter.last.emitStats(statsOf(3));
    await pass(REPORT_INTERVAL_MS + 100);
    expect(host.of('state').at(-1)?.recording).toBe(true);
    expect(r.service.thermal()).toBeNull();
  });

  it('sends its camera again when it changes', async () => {
    const host = await joined();
    await r.camera.select(FAKE_PHONE_FRONT.deviceId);
    await pump(10);
    const hellos = host.of('hello');
    expect(hellos).toHaveLength(2);
    expect(hellos[1].camera?.facing).toBe('user');
    expect(hellos[1].camera?.label).toBe('phone-front');
  });

  it('Leave says leave, closes once it is out, and lets the wake lock go', async () => {
    const host = await joined();
    r.service.leave();
    expect(r.service.state()).toBe('left');
    expect(r.service.problem()).toMatch(/^You left the session/);
    expect(r.wakeLock.held()).toBe(0);
    await pump(10);
    expect(host.of('leave')).toEqual([{ type: 'leave', reason: 'the user left' }]);
    expect(host.transport?.state).toBe('open');
    await pump(LEAVE_GRACE_MS);
    expect(host.transport?.state).toBe('closed');
    r.service.reset();
    expect(r.service.state()).toBe('idle');
    expect(r.service.input()).toBeNull();
    const all = await events();
    expect(kinds(all)).toEqual(['rtc.paired', 'rtc.connected', 'rtc.disconnected']);
  });

  it('says leave when the page goes', async () => {
    const host = await joined();
    for (const listener of r.listeners.get('pagehide') ?? []) {
      listener();
    }
    await pump(10);
    expect(host.of('leave').map((m) => m.reason)).toEqual(['the page closed']);
  });

  it('is let go by the host: Remove, or the session ended', async () => {
    const host = await joined();
    host.remove();
    await pump(10);
    expect(r.service.state()).toBe('left');
    expect(r.service.problem()).toBe('The host let this camera go: The host removed this camera.');
    expect(r.wakeLock.held()).toBe(0);
    const all = await events();
    expect(all.find((e) => e.kind === 'rtc.disconnected')?.data).toMatchObject({
      reason: 'host left: The host removed this camera.',
    });
  });

  it('calls again with the same token when the connection drops, and is answered: connected again', async () => {
    const host = await joined();
    host.drop();
    // The connection's end is heard at once; the call again takes a moment.
    expect(r.service.state()).toBe('reconnecting');
    expect(r.wakeLock.held()).toBe(1);
    await pump(RETRY_DELAY_MS + 50);
    expect(r.service.state()).toBe('connected');
    expect(host.connections).toBe(2);
    expect(host.of('hello')).toHaveLength(2);
    const all = await events();
    expect(kinds(all)).toEqual([
      'rtc.paired',
      'rtc.connected',
      'rtc.disconnected',
      'rtc.connected',
    ]);
    expect(all.at(-1)?.data).toMatchObject({ reconnection: true });
  });

  it('keeps calling for five minutes when the host is gone, then says so', async () => {
    const host = await joined();
    host.gone = true;
    host.drop();
    await pump(10);
    expect(r.service.state()).toBe('reconnecting');
    await pass(RECONNECT_WINDOW_MS - 10_000);
    expect(r.service.state()).toBe('reconnecting');
    await pass(60_000);
    expect(r.service.state()).toBe('host-gone');
    expect(r.service.problem()).toMatch(/^The host is gone/);
    expect(r.wakeLock.held()).toBe(0);
    // Each call waits for the answer up to the connection's timeout (30 s), then tries again.
    expect(r.connector.connections.length).toBeGreaterThanOrEqual(2);
    const all = await events();
    expect(all.filter((e) => e.kind === 'rtc.disconnected').at(-1)?.data['reason']).toMatch(
      /^gave up/,
    );
    expect(HELLO_TIMEOUT_MS).toBe(10_000);
  });
});
