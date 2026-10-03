import { TestBed } from '@angular/core/testing';
import type { CameraInfo, CloudEvent } from '@cubetrace/core';
import {
  FirestoreSignaling,
  MessageLink,
  PROTOCOL_VERSION,
  answerPings,
  hashToken,
  type Clock,
  type Message,
} from '@cubetrace/rtc';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY, AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { bluetoothNavigator } from '../cube/cube-testing';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { MemoryConnector, rtcTimers } from '../rtc/rtc-testing';
import { TRANSPORT_CONNECTOR } from '../rtc/transport-connector';
import { inverse, ready, setup, turn, type Setup } from '../session/session-harness';
import {
  CLOCK_RECORD_MS,
  HELLO_TIMEOUT_MS,
  LEAVE_GRACE_MS,
  RECONNECT_WINDOW_MS,
  RemoteCamerasService,
} from './remote-cameras-service';

/** The phone's rear camera, as its own session.json would describe it. */
const PHONE_CAMERA: CameraInfo = {
  label: 'phone-rear',
  local: true,
  facing: 'environment',
  deviceLabel: 'camera 0, facing back',
  settings: { width: 1080, height: 1920, frameRate: 30 },
  capabilities: {},
  constraints: {},
  crop: null,
  mode: 'full',
  microphone: null,
};

/** A small JPEG's first and last bytes. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);

interface Rig {
  readonly s: Setup;
  readonly backend: FakeAccountBackend;
  readonly connector: MemoryConnector;
  readonly service: RemoteCamerasService;
}

/**
 * A phone that joins the session (the camera device's side of docs/RTC.md, as T4.1's Camera page
 * does it): it checks the pairing, calls, says hello, answers the pings, and sends what the test
 * asks; what the host sends it is in `received`.
 */
class Phone {
  readonly received: Message[] = [];
  link: MessageLink | null = null;
  /** The token it joined with, and the peer document of its call. */
  token = '';
  peerId = '';
  private readonly signaling: FirestoreSignaling;

  constructor(
    private readonly r: Rig,
    readonly label = 'ThinkPhone',
    /** The phone's clock minus the host's. */
    private readonly offsetMs = 1234.5,
  ) {
    this.signaling = new FirestoreSignaling(r.backend, {
      sessionId: r.s.service.session()?.id ?? '',
      uid: ADA.uid,
      now: () => r.s.perf.hostMs,
    });
  }

  /** Whether the session takes `token` now. */
  check(token: string): Promise<string> {
    return this.signaling.checkPairing(token);
  }

  /** Calls with `token`, connects, and once the channel is open says hello and answers the pings. */
  async join(token: string): Promise<void> {
    this.token = token;
    const signaling = this.signaling.call({ tokenHash: await hashToken(token) });
    this.peerId = signaling.peerId;
    const transport = await this.r.connector.connect(signaling);
    const link = new MessageLink(transport);
    this.link = link;
    link.onMessage((message) => {
      this.received.push(message);
    });
    answerPings(link, () => this.r.s.perf.hostMs + this.offsetMs);
    link.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      role: 'camera',
      device: { label: this.label, platform: 'Android' },
      app: { version: '0.4.0', commit: 'abc1234' },
      camera: PHONE_CAMERA,
    });
  }

  sendState(changes: { recording?: boolean; fps?: number | null } = {}): void {
    this.link?.send({
      type: 'state',
      remoteMs: this.r.s.perf.hostMs + this.offsetMs,
      recording: changes.recording ?? true,
      framing: { x: 100, y: 200, w: 800, h: 600 },
      frame: { width: 1080, height: 1920 },
      fps: changes.fps === undefined ? 29.9 : changes.fps,
      sharpness: 41.2,
      battery: { level: 0.83, charging: true },
      thermal: 'ok',
      pendingClips: 0,
    });
  }

  sendThumbnail(): void {
    this.link?.send({
      type: 'thumbnail',
      remoteMs: this.r.s.perf.hostMs + this.offsetMs,
      width: 180,
      height: 320,
      jpeg: JPEG,
    });
  }

  /** Says `leave`; the channel closes once it is out (`drop`, after the test let it go). */
  leave(reason = 'the user left'): void {
    this.link?.send({ type: 'leave', reason });
  }

  /** The connection drops without a word (the Wi-Fi went). */
  drop(): void {
    this.link?.close('the network went');
  }

  /** The messages of `type` received. */
  of<T extends Message['type']>(type: T): Extract<Message, { type: T }>[] {
    return this.received.filter((message) => message.type === type) as Extract<
      Message,
      { type: T }
    >[];
  }
}

describe('RemoteCamerasService', () => {
  let r: Rig;

  /** The timer with a session under way, signed in, and the service, with memory connections. */
  async function rig(options: { signedIn?: boolean; session?: boolean } = {}): Promise<Rig> {
    TestBed.resetTestingModule();
    const backend = new FakeAccountBackend();
    const localStorage = new FakeLocalStorage();
    if (options.signedIn !== false) {
      backend.user = ADA;
      localStorage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    }
    let connector: MemoryConnector | null = null;
    const s = setup({
      localStorage,
      navigator: bluetoothNavigator(true),
      providers: [
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        {
          provide: TRANSPORT_CONNECTOR,
          useValue: (signaling: Parameters<MemoryConnector['connect']>[0]) => {
            if (connector === null) {
              throw new Error('No connector yet.');
            }
            return connector.connect(signaling);
          },
        },
      ],
    });
    connector = new MemoryConnector({ delayMs: 4, timers: rtcTimers(s.perf, s.timers) });
    const service = TestBed.inject(RemoteCamerasService);
    TestBed.inject(AuthService);
    await settle();
    if (options.session !== false) {
      await ready(s);
    }
    await pump(s, 0);
    return { s, backend, connector, service };
  }

  /**
   * Moves the clock `ms` forward in `rounds` steps, running the timers due and letting the effects
   * and promises run after each: a message that answers a message needs a step of its own.
   */
  async function pump(s: Setup, ms: number, rounds = 4): Promise<void> {
    for (let k = 0; k < rounds; k++) {
      s.timers.advance(ms / rounds);
      await settle();
      await settle();
      TestBed.tick();
    }
  }

  /** Lets `ms` pass in steps of 1 s, pumping each. */
  async function pass(s: Setup, ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 1000) {
      await pump(s, Math.min(1000, left), 2);
    }
  }

  /** The events written to the account, after the diagnostics' batch delay. */
  async function events(): Promise<CloudEvent[]> {
    await pump(r.s, 5000);
    return r.backend.events.map((entry) => entry.write.event);
  }

  function kinds(all: CloudEvent[]): string[] {
    return all.map((event) => event.kind).filter((kind) => kind.startsWith('rtc.'));
  }

  /** Add camera, and the phone joins with its token: the connection made and the hellos exchanged. */
  async function paired(phone?: Phone): Promise<Phone> {
    await r.service.addCamera();
    const token = r.service.pairing()?.token ?? '';
    const joiner = phone ?? new Phone(r);
    const joining = joiner.join(token);
    await pump(r.s, 0);
    await joining;
    await pump(r.s, 10);
    return joiner;
  }

  beforeEach(async () => {
    r = await rig();
  });

  it('refuses Add camera signed out, and without a session', async () => {
    r = await rig({ signedIn: false });
    expect(r.service.blocked()).toBe('signed-out');
    await r.service.addCamera();
    expect(r.service.pairing()).toBeNull();
    expect(r.service.pairingError()).toMatch(/^Sign in first/);

    r = await rig({ session: false });
    expect(r.service.blocked()).toBe('no-session');
    await r.service.addCamera();
    expect(r.service.pairing()).toBeNull();
    expect(r.service.pairingError()).toMatch(/^Connect the cube first/);
  });

  it('publishes a pairing: a token of 8 characters, its hash in the session document for 10 minutes, the QR code’s URL', async () => {
    expect(r.service.blocked()).toBeNull();
    await r.service.addCamera();
    const pairing = r.service.pairing();
    const sessionId = r.s.service.session()?.id ?? '';
    expect(pairing?.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(pairing?.url).toBe(
      new URL(`camera?session=${sessionId}&token=${pairing?.token ?? ''}`, document.baseURI).href,
    );
    expect(pairing?.expiresMs).toBe(r.s.perf.hostMs + 10 * 60_000);
    // The demo session's document went to the index for it, with the pairing.
    const indexed = r.backend.sessionDocument(sessionId);
    expect(indexed?.id).toBe(sessionId);
    expect(indexed?.pairing).toEqual({
      tokenHash: await hashToken(pairing?.token ?? ''),
      expiresMs: pairing?.expiresMs,
    });
    expect(r.backend.indexWrites).toEqual([
      `sessions/${sessionId}`,
      `sessions/${sessionId} pairing`,
    ]);
    // The phone takes it; a wrong token or a typo does not.
    const phone = new Phone(r);
    expect(await phone.check(pairing?.token ?? '')).toBe('ok');
    expect(await phone.check('ABCDEFGH')).toBe('wrong-token');

    // Add camera again replaces it; Cancel takes it down.
    await r.service.addCamera();
    expect(r.service.pairing()?.token).not.toBe(pairing?.token);
    await r.service.cancelPairing();
    expect(r.service.pairing()).toBeNull();
    expect(r.backend.sessionDocument(sessionId)?.pairing).toBeNull();
  });

  it('expires the pairing after 10 minutes, and says so', async () => {
    await r.service.addCamera();
    await pass(r.s, 10 * 60_000);
    expect(r.service.pairing()).toBeNull();
    expect(r.service.pairingError()).toMatch(/^The code expired/);
    const sessionId = r.s.service.session()?.id ?? '';
    expect(r.backend.sessionDocument(sessionId)?.pairing).toBeNull();
  });

  it('answers the first phone that presents the token, closes the pairing, exchanges hellos and lists the camera in the session with `remote`', async () => {
    const phone = await paired();
    expect(r.service.pairing()).toBeNull();
    const sessionId = r.s.service.session()?.id ?? '';
    expect(r.backend.sessionDocument(sessionId)?.pairing).toBeNull();
    expect(r.connector.connections.map((c) => c.role).sort()).toEqual(['callee', 'caller']);

    const cameras = r.service.cameras();
    expect(cameras).toHaveLength(1);
    const camera = cameras[0];
    expect(camera.state).toBe('connected');
    expect(camera.device).toEqual({ label: 'ThinkPhone', platform: 'Android' });
    expect(camera.app).toEqual({ version: '0.4.0', commit: 'abc1234' });
    expect(camera.camera).toEqual(PHONE_CAMERA);
    expect(camera.label).toBe('phone-rear');
    // The host's hello came first, then the pings.
    const hello = phone.of('hello');
    expect(hello).toHaveLength(1);
    expect(hello[0]).toMatchObject({ v: PROTOCOL_VERSION, role: 'host', camera: null });
    expect(hello[0].device.label).toBe(r.s.settings.hostLabel());
    expect(phone.of('ping').length).toBeGreaterThanOrEqual(1);

    // The session's entry: the phone's camera, remote, under the label the session gives it.
    const entry = r.s.service.session()?.cameras.find((c) => c.label === 'phone-rear');
    expect(entry).toEqual({
      ...PHONE_CAMERA,
      local: false,
      remote: { label: 'ThinkPhone', platform: 'Android' },
    });

    const all = await events();
    expect(kinds(all)).toEqual(['rtc.paired', 'rtc.connected']);
    expect(all.find((e) => e.kind === 'rtc.paired')?.data).toMatchObject({
      peer: 'ThinkPhone',
      platform: 'Android',
      camera: 'phone-rear',
      facing: 'environment',
      version: '0.4.0',
    });
    expect(all.find((e) => e.kind === 'rtc.connected')?.data).toMatchObject({
      peer: 'ThinkPhone',
      reconnection: false,
    });
  });

  it('refuses a second phone with the token once taken, and a wrong token: their documents go', async () => {
    await r.service.addCamera();
    const token = r.service.pairing()?.token ?? '';
    const first = new Phone(r, 'ThinkPhone');
    const joining = first.join(token);
    await pump(r.s, 0);
    await joining;
    await pump(r.s, 10);
    expect(r.service.cameras()).toHaveLength(1);

    // A second phone with the same token: no answer; the host deletes its offer.
    const second = new Phone(r, 'Pixel', 50);
    expect(await second.check(token)).toBe('no-pairing');
    // Its outcome is caught at once: the rejection comes while the test still pumps.
    const stray = second.join(token).then(
      () => 'connected',
      (error: unknown) => `failed: ${String(error)}`,
    );
    await pump(r.s, 50);
    const deletes = r.backend.signaling.writes.filter((write) => write.startsWith('delete '));
    expect(deletes).toHaveLength(1);
    expect(r.service.cameras()).toHaveLength(1);
    expect(r.connector.connections.map((c) => c.role).sort()).toEqual(['callee', 'caller']);
    // Its connection never completes: the documents gone end it.
    expect(await stray).toMatch(/^failed: .*the signaling closed: the documents are gone/);
  });

  it('pings every 2 s, tells the phone the clock sync, and once it converges records it in the session and the diagnostics, and once a minute after', async () => {
    const phone = await paired();
    await pass(r.s, 4000);
    const pings = phone.of('ping').length;
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(pings).toBeLessThanOrEqual(4);
    // One clock per answer taken (the last answer may still be on its way).
    let clocks = phone.of('clock');
    expect(clocks.length).toBeGreaterThanOrEqual(pings - 1);
    expect(clocks.length).toBeLessThanOrEqual(pings);
    expect(clocks.at(-1)).toMatchObject<Partial<Clock>>({ converged: false });
    expect(Math.abs((clocks.at(-1)?.offsetMs ?? 0) - 1234.5)).toBeLessThan(1);
    expect(r.service.cameras()[0].sync).toMatchObject({ converged: false, samples: clocks.length });
    expect(r.s.service.session()?.clock.cameras['phone-rear']).toBeUndefined();

    // Ten samples over ten seconds: converged.
    await pass(r.s, 20_000);
    clocks = phone.of('clock');
    expect(clocks.at(-1)?.converged).toBe(true);
    expect(clocks.at(-1)?.rttMs).toBeCloseTo(8, 0);
    const sync = r.service.cameras()[0].sync;
    expect(sync?.converged).toBe(true);
    expect(Math.abs((sync?.offsetMs ?? 0) - 1234.5)).toBeLessThan(1);
    // The record, written as the fit converged (the samples of that moment).
    const clock = r.s.service.session()?.clock.cameras['phone-rear'];
    expect(clock).toMatchObject({ offsetMs: 0, clapperboardSamples: 0, driftPpm: 0 });
    expect(clock?.rttMs).toBeCloseTo(8, 0);
    expect(clock?.remote?.samples).toBeGreaterThanOrEqual(10);
    expect(clock?.remote?.samples).toBeLessThanOrEqual(sync?.samples ?? 0);
    expect(Math.abs((clock?.remote?.offsetMs ?? 0) - 1234.5)).toBeLessThan(1);

    let all = await events();
    const recorded = all.filter((e) => e.kind === 'rtc.clock');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].data).toMatchObject({
      why: 'converged',
      converged: true,
      camera: 'phone-rear',
    });

    // A minute later, again, with the samples of the minute.
    await pass(r.s, CLOCK_RECORD_MS);
    all = await events();
    const again = all.filter((e) => e.kind === 'rtc.clock');
    expect(again).toHaveLength(2);
    expect(again[1].data).toMatchObject({ why: 'minute', converged: true });
    const minute = r.s.service.session()?.clock.cameras['phone-rear'].remote;
    expect(minute?.samples).toBeGreaterThanOrEqual(30);
    expect(minute?.samples).toBe(again[1].data['samples']);
  });

  it('keeps the phone’s state and its latest thumbnail', async () => {
    const phone = await paired();
    phone.sendState();
    phone.sendThumbnail();
    await pump(r.s, 10);
    const camera = r.service.cameras()[0];
    expect(camera.report).toMatchObject({ recording: true, fps: 29.9, sharpness: 41.2 });
    // When it came: 4 ms after it was sent, on the host clock.
    expect(camera.reportMs).toBe(r.s.perf.hostMs - 6);
    // jsdom makes no object URL; the picture's facts are kept all the same.
    expect(camera.thumbnail).toMatchObject({
      url: null,
      width: 180,
      height: 320,
      bytes: JPEG.length,
    });
    phone.sendState({ fps: 20 });
    await pump(r.s, 10);
    expect(r.service.cameras()[0].report?.fps).toBe(20);
  });

  it('removes a phone that leaves at once, keeps its entry in the session, and deletes its documents', async () => {
    const phone = await paired();
    phone.leave('the user left');
    await pump(r.s, 10);
    phone.drop();
    await pump(r.s, 10);
    expect(r.service.cameras()).toEqual([]);
    expect(r.s.service.session()?.cameras.map((c) => c.label)).toEqual(['phone-rear']);
    expect(r.backend.signaling.writes.filter((w) => w.startsWith('delete '))).toHaveLength(1);
    const all = await events();
    expect(kinds(all)).toEqual(['rtc.paired', 'rtc.connected', 'rtc.disconnected']);
    expect(all.at(-1)?.data).toMatchObject({ reason: 'left: the user left', camera: 'phone-rear' });
  });

  it('lists a phone whose connection dropped as reconnecting, answers its call again with the same token, keeps the fit, and removes it after five minutes away', async () => {
    const phone = await paired();
    await pass(r.s, 6000);
    const samples = r.service.cameras()[0].sync?.samples ?? 0;
    expect(samples).toBeGreaterThanOrEqual(3);
    phone.drop();
    await pump(r.s, 10);
    let camera = r.service.cameras()[0];
    expect(camera.state).toBe('reconnecting');
    expect(camera.label).toBe('phone-rear');

    // The phone calls again with the token it paired with: answered, the same camera, the fit kept.
    const back = new Phone(r);
    const token = r.service.pairing()?.token ?? '';
    expect(token).toBe('');
    const joining = back.join(phone.token);
    await pump(r.s, 0);
    await joining;
    await pump(r.s, 10);
    camera = r.service.cameras()[0];
    expect(camera.state).toBe('connected');
    expect(camera.id).toBe(phone.peerId);
    expect(camera.peerId).toBe(back.peerId);
    await pass(r.s, 2000);
    expect(r.service.cameras()[0].sync?.samples).toBeGreaterThan(samples);
    expect(r.service.cameras()).toHaveLength(1);
    let all = await events();
    expect(kinds(all)).toEqual([
      'rtc.paired',
      'rtc.connected',
      'rtc.disconnected',
      'rtc.connected',
    ]);
    expect(all.at(-1)?.data).toMatchObject({ reconnection: true });

    // Dropped again and not back within five minutes: removed.
    back.drop();
    await pump(r.s, 10);
    expect(r.service.cameras()[0].state).toBe('reconnecting');
    await pass(r.s, RECONNECT_WINDOW_MS - 1000);
    expect(r.service.cameras()).toHaveLength(1);
    await pass(r.s, 2000);
    expect(r.service.cameras()).toEqual([]);
    all = await events();
    expect(all.filter((e) => e.kind === 'rtc.disconnected').at(-1)?.data['reason']).toMatch(
      /^gave up/,
    );
  });

  it('Remove tells the phone, closes the connection and deletes the documents; the entry stays in the session', async () => {
    const phone = await paired();
    r.service.remove(r.service.cameras()[0].id);
    expect(r.service.cameras()).toEqual([]);
    await pump(r.s, 10);
    const left = phone.of('leave');
    expect(left).toHaveLength(1);
    expect(left[0].reason).toBe('The host removed this camera.');
    // The connection closes once the word is out.
    expect(phone.link?.state).toBe('open');
    await pump(r.s, LEAVE_GRACE_MS);
    expect(phone.link?.state).toBe('closed');
    expect(r.backend.signaling.writes.filter((w) => w.startsWith('delete '))).toHaveLength(1);
    expect(r.s.service.session()?.cameras.map((c) => c.label)).toEqual(['phone-rear']);
  });

  it('lets every camera go when the session ends, with the pairing', async () => {
    const fake = await ready(r.s);
    const phone = await paired();
    await r.service.addCamera();
    expect(r.service.pairing()).not.toBeNull();
    // A solve, so that the session has an attempt and New session may close it.
    turn(r.s, fake, 'R U F');
    await pump(r.s, 1000);
    turn(r.s, fake, inverse('R U F'), 500);
    await pump(r.s, 1000);
    expect(r.s.service.attempts()).toHaveLength(1);
    r.s.service.newSession();
    await pump(r.s, 20);
    expect(r.service.cameras()).toEqual([]);
    expect(r.service.pairing()).toBeNull();
    expect(phone.received.map((m) => m.type).filter((t) => t !== 'ping' && t !== 'clock')).toEqual([
      'hello',
      'leave',
    ]);
    await pump(r.s, LEAVE_GRACE_MS);
    expect(phone.link?.state).toBe('closed');
  });

  it('gives a phone of another protocol version up, with the reason', async () => {
    await r.service.addCamera();
    const token = r.service.pairing()?.token ?? '';
    const phone = new Phone(r);
    const signaling = new FirestoreSignaling(r.backend, {
      sessionId: r.s.service.session()?.id ?? '',
      uid: ADA.uid,
      now: () => r.s.perf.hostMs,
    }).call({ tokenHash: await hashToken(token) });
    const connecting = r.connector.connect(signaling);
    await pump(r.s, 0);
    const transport = await connecting;
    const link = new MessageLink(transport);
    link.onMessage((message) => phone.received.push(message));
    link.send({
      type: 'hello',
      v: 2,
      role: 'camera',
      device: { label: 'ThinkPhone', platform: 'Android' },
      app: { version: '0.5.0', commit: 'def5678' },
      camera: null,
    });
    await pump(r.s, 20);
    expect(r.service.cameras()).toEqual([]);
    await pump(r.s, 20);
    expect(phone.of('leave')[0]?.reason).toMatch(/protocol version 2/);
    await pump(r.s, LEAVE_GRACE_MS);
    expect(transport.state).toBe('closed');
    const all = await events();
    expect(all.find((e) => e.kind === 'rtc.failed')?.data).toMatchObject({ step: 'version' });
  });

  it('gives a phone up that never says hello', async () => {
    await r.service.addCamera();
    const token = r.service.pairing()?.token ?? '';
    const signaling = new FirestoreSignaling(r.backend, {
      sessionId: r.s.service.session()?.id ?? '',
      uid: ADA.uid,
      now: () => r.s.perf.hostMs,
    }).call({ tokenHash: await hashToken(token) });
    const connecting = r.connector.connect(signaling);
    await pump(r.s, 0);
    const transport = await connecting;
    expect(r.service.cameras()).toHaveLength(1);
    expect(r.service.cameras()[0].state).toBe('connecting');
    await pass(r.s, HELLO_TIMEOUT_MS + 1000);
    expect(r.service.cameras()).toEqual([]);
    expect(transport.state).toBe('closed');
    const all = await events();
    expect(all.find((e) => e.kind === 'rtc.failed')?.data).toMatchObject({ step: 'hello' });
  });
});
