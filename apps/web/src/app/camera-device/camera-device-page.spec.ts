import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { cloudSession } from '@cubetrace/core';
import {
  FirestoreSignaling,
  MessageLink,
  PROTOCOL_VERSION,
  generateToken,
  type IncomingOffer,
} from '@cubetrace/rtc';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY, AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { CameraService } from '../camera/camera-service';
import { CAPTURE_STARTER } from '../camera/recording-service';
import { FakeCaptureStarter } from '../camera/recording-testing';
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
import { SESSION_A, testSession } from '../session/session-testing';
import { SettingsService } from '../settings/settings-service';
import { CameraDeviceCapture } from './camera-device-capture';
import { CameraDevicePage } from './camera-device-page';
import { CameraDeviceService } from './camera-device-service';
import { fakePressure, type FakePressure } from './pressure-testing';
import { THUMBNAIL_GRABBER } from './thumbnail-grabber';

const ANDROID = 'Mozilla/5.0 (Linux; Android 16; K) Chrome/155.0.0.0 Mobile Safari/537.36';

describe('CameraDevicePage', () => {
  let backend: FakeAccountBackend;
  let connector: MemoryConnector;
  let perf: FakePerformance;
  let timers: FakeTimers;
  let wakeLock: FakeWakeLock;
  let media: FakeMediaDevices;
  let fixture: ComponentFixture<CameraDevicePage>;

  /** The device's fakes, before the page: a host may publish a pairing into the account first. */
  function prepare(options: { signedIn?: boolean } = {}): FakeLocalStorage {
    TestBed.resetTestingModule();
    backend = new FakeAccountBackend();
    const localStorage = new FakeLocalStorage();
    if (options.signedIn !== false) {
      backend.user = ADA;
      localStorage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    }
    perf = new FakePerformance();
    timers = new FakeTimers(perf);
    wakeLock = new FakeWakeLock();
    media = new FakeMediaDevices([FAKE_PHONE_FRONT, FAKE_PHONE_REAR]);
    connector = new MemoryConnector({ delayMs: 4, timers: rtcTimers(perf, timers) });
    return localStorage;
  }

  async function render(
    options: {
      signedIn?: boolean;
      query?: Record<string, string>;
      prepared?: FakeLocalStorage;
      /** The browser's `PressureObserver` (T5.1); none by default. */
      pressure?: FakePressure;
    } = {},
  ): Promise<void> {
    const localStorage = options.prepared ?? prepare(options);
    // jsdom's <video> does not play.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const globals: BrowserGlobals = {
      navigator: { userAgent: ANDROID, mediaDevices: media, wakeLock },
      localStorage,
      performance: perf,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      PressureObserver: options.pressure?.Observer,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        { provide: CAPTURE_STARTER, useValue: new FakeCaptureStarter() },
        { provide: TRANSPORT_CONNECTOR, useValue: connector.connect },
        {
          provide: THUMBNAIL_GRABBER,
          useValue: { grab: () => Promise.resolve(null) },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(options.query ?? {}) } },
        },
      ],
    });
    TestBed.inject(AuthService);
    await settle();
    fixture = TestBed.createComponent(CameraDevicePage);
    await pump(0);
  }

  async function pump(ms: number, rounds = 4): Promise<void> {
    for (let k = 0; k < rounds; k++) {
      timers.advance(ms / rounds);
      await settle();
      await settle();
      TestBed.tick();
      await fixture.whenStable();
    }
  }

  function element(testId: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`);
  }

  function text(testId: string): string | undefined {
    return element(testId)?.textContent.replace(/\s+/g, ' ').trim();
  }

  /** A host with a pairing published for SESSION_A, answering the first phone that presents the token. */
  async function host(): Promise<{ token: string; link: () => MessageLink | null }> {
    await backend.saveSessionIndex(cloudSession(testSession(SESSION_A), ADA.uid));
    const signaling = new FirestoreSignaling(backend, {
      sessionId: SESSION_A,
      uid: ADA.uid,
      now: () => perf.hostMs,
    });
    const token = generateToken();
    const pairing = await signaling.publishPairing(token);
    let link: MessageLink | null = null;
    signaling.watchOffers(
      (offer: IncomingOffer) => {
        if (offer.peer.tokenHash !== pairing.tokenHash) {
          return;
        }
        void connector.connect(offer.signaling).then((transport) => {
          link = new MessageLink(transport);
          link.send({
            type: 'hello',
            v: PROTOCOL_VERSION,
            role: 'host',
            device: { label: 'office-mbp', platform: 'macOS' },
            app: { version: '0.4.0', commit: 'abc1234' },
            camera: null,
          });
        });
      },
      () => undefined,
    );
    return { token, link: () => link };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns the rear camera on as the camera device and runs the pipeline; shows the code field while idle', async () => {
    await render();
    const camera = TestBed.inject(CameraService);
    expect(camera.role()).toBe('camera-device');
    expect(camera.status()).toBe('on');
    expect(camera.facing()).toBe('environment');
    expect(TestBed.inject(CameraDeviceCapture).wanted()).toBe(true);
    expect(text('device-state')).toBe('Not joined');
    expect(element('device-state')?.getAttribute('data-state')).toBe('idle');
    expect(element('pairing-input')).not.toBeNull();
    expect(element('device-preview')).not.toBeNull();
    expect(element('device-leave')).toBeNull();
    expect(element('device-camera-select')).not.toBeNull();
    expect(text('device-picture-line')).toBe('measuring… · 1080×1920 · starting');

    // A text that is not a code is refused on the spot.
    (element('pairing-input') as HTMLInputElement).value = 'hello';
    element('pairing-input')?.dispatchEvent(new Event('input'));
    element('pairing-join')?.click();
    await pump(0);
    expect(text('device-problem')).toMatch(/^That is not a code/);
    expect(element('device-state')?.getAttribute('data-state')).toBe('idle');
  });

  it('keeps the code and shows Sign in while signed out', async () => {
    await render({ signedIn: false, query: { session: SESSION_A, token: '7KQM2XAB' } });
    expect(element('device-state')?.getAttribute('data-state')).toBe('signed-out');
    expect(text('device-state')).toBe('Sign in to join');
    expect(text('device-sign-in')).toMatch(/^Sign in to join/);
    expect(element('sign-in')).not.toBeNull();
    expect(TestBed.inject(CameraDeviceService).input()).toEqual({
      sessionId: SESSION_A,
      token: '7KQM2XAB',
    });
  });

  it('joins by the URL’s session and token: the pill, the host, the clock, the hints and Leave; Leave then Join again', async () => {
    const prepared = prepare();
    const { token, link } = await host();
    await render({ query: { session: SESSION_A, token }, prepared });
    await pump(20);
    expect(element('device-state')?.getAttribute('data-state')).toBe('connected');
    expect(text('device-state')).toMatch(/^Connected · office-mbp \(macOS\) · \d+ s$/);
    expect(text('device-clock')).toBe('syncing · 0 pings answered');
    expect(text('device-wake-lock')).toBe('Screen on');
    // No clip staged for the host (T4.2).
    expect(text('device-clips')).toBe('each attempt’s clips go to the host as they are cut');
    expect(element('device-clips')?.getAttribute('data-pending')).toBe('0');
    expect(wakeLock.held()).toBe(1);
    expect(element('device-leave')).not.toBeNull();
    expect(element('pairing-input')).toBeNull();
    expect(element('device-battery')).toBeNull();

    link()?.send({ type: 'ping', t1: perf.hostMs });
    link()?.send({ type: 'clock', converged: true, offsetMs: -2500.4, rttMs: 9.6 });
    await pump(10);
    expect(text('device-clock')).toBe('synced · round trip 9.6 ms · offset −2,500.4 ms');
    expect(element('device-clock')?.getAttribute('data-converged')).toBe('true');

    element('device-leave')?.click();
    await pump(0);
    expect(element('device-state')?.getAttribute('data-state')).toBe('left');
    expect(text('device-problem')).toMatch(/^You left the session/);
    expect(text('device-again')).toBe('Join again');
    expect(wakeLock.held()).toBe(0);
    element('device-again')?.click();
    await pump(0);
    expect(element('device-state')?.getAttribute('data-state')).toBe('idle');
    expect(element('pairing-input')).not.toBeNull();
  });

  it("shows the phone's pressure where the browser has the API, warns from fair up, and stops observing when the page goes (T5.1)", async () => {
    const pressure = fakePressure({ sources: ['cpu', 'thermals'] });
    const prepared = prepare();
    const { token } = await host();
    await render({ query: { session: SESSION_A, token }, prepared, pressure });
    await pump(20);
    expect(element('device-state')?.getAttribute('data-state')).toBe('connected');
    expect(pressure.observed.map((call) => call.source)).toEqual(['thermals']);
    // No record yet: nothing said.
    expect(element('device-pressure')).toBeNull();

    pressure.emit('nominal');
    await pump(10);
    expect(text('device-pressure')).toBe('nominal (thermals)');
    expect(element('device-pressure-warning')).toBeNull();
    pressure.emit('fair');
    await pump(10);
    expect(element('device-pressure')?.getAttribute('data-state')).toBe('fair');
    const warning = element('device-pressure-warning');
    expect(warning?.textContent.trim()).toBe('The phone is under fair pressure: it is warming up.');
    expect(warning?.classList).toContain('notice');
    pressure.emit('serious');
    await pump(10);
    expect(text('device-pressure-warning')).toBe(
      'The phone is under serious pressure: it may be hot.',
    );
    expect(element('device-pressure-warning')?.classList).toContain('problem');

    fixture.destroy();
    await settle();
    expect(pressure.disconnected()).toBe(1);
    expect(TestBed.inject(CameraDeviceService).pressure()).toBeNull();
  });

  it('refuses a wrong code with the reason and Try another code', async () => {
    const prepared = prepare();
    await host();
    await render({ query: { session: SESSION_A, token: 'ABCDEFGH' }, prepared });
    await pump(10);
    expect(element('device-state')?.getAttribute('data-state')).toBe('refused');
    expect(text('device-problem')).toMatch(/^This code is not the one the host shows/);
    expect(text('device-again')).toBe('Try another code');
  });

  it("says what its camera changed by itself and whether it was set back, and switches Keep the camera's modes (T5.2)", async () => {
    const prepared = prepare();
    const { token } = await host();
    await render({ query: { session: SESSION_A, token }, prepared });
    await pump(20);
    expect(element('device-drift')).toBeNull();
    const track = media.tracks.at(-1);
    // The focus went manual by itself: set back within two readings, and said for a minute.
    track?.drift({ focusMode: 'manual' });
    await pump(4000, 8);
    expect(text('device-drift')).toBe(
      'The camera set the focus to manual by itself: set back to continuous.',
    );
    expect(element('device-drift')?.classList.contains('notice')).toBe(true);
    await pump(60_000, 30);
    expect(element('device-drift')).toBeNull();

    // Keep the camera's modes off, on the page's own switch: said and left.
    (element('device-camera-settings') as HTMLDetailsElement).open = true;
    await pump(0);
    const keep = element('device-keep-camera-modes') as HTMLInputElement;
    expect(keep.checked).toBe(true);
    keep.click();
    await pump(0);
    expect(TestBed.inject(SettingsService).keepCameraModes()).toBe(false);
    track?.drift({ focusMode: 'manual' });
    await pump(4000, 8);
    expect(text('device-drift')).toBe(
      "The camera set the focus to manual by itself: left so (Keep the camera's modes is off).",
    );
    expect(element('device-drift')?.classList.contains('problem')).toBe(true);
    expect(text('camera-controls-drift')).toBe('The camera set the focus to manual by itself.');
  });

  it('leaves the camera as it found it when the page goes: the host’s role, and off if it was off', async () => {
    await render();
    const camera = TestBed.inject(CameraService);
    expect(TestBed.inject(SettingsService).cameraOn()).toBe(true);
    fixture.destroy();
    await settle();
    await settle();
    expect(camera.role()).toBe('host');
    expect(camera.status()).toBe('off');
    expect(TestBed.inject(CameraDeviceCapture).wanted()).toBe(false);
  });
});
