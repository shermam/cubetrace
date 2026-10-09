import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { controlValuesOf, controlsOf } from '@cubetrace/capture';
import type { CameraInfo } from '@cubetrace/core';
import type { FakeCube } from '@cubetrace/gan';
import {
  FirestoreSignaling,
  MessageLink,
  PROTOCOL_VERSION,
  answerPings,
  hashToken,
} from '@cubetrace/rtc';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY, AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { bluetoothNavigator } from '../cube/cube-testing';
import { FAKE_PHONE_REAR, FakeLocalStorage, settle } from '../device/fake-browser';
import { MemoryConnector, rtcTimers } from '../rtc/rtc-testing';
import { TRANSPORT_CONNECTOR } from '../rtc/transport-connector';
import { inverse, ready, setup, turn, type Setup } from '../session/session-harness';
import { SettingsService } from '../settings/settings-service';
import { RemoteCameras, tokenText } from './remote-cameras';
import { RemoteCamerasService } from './remote-cameras-service';
import { CONTROLS_WAIT_MS } from './remote-controls-source';

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

describe('RemoteCameras', () => {
  let s: Setup;
  let backend: FakeAccountBackend;
  let connector: MemoryConnector;
  let fixture: ComponentFixture<RemoteCameras>;
  let cube: FakeCube | null = null;

  async function render(options: { signedIn?: boolean; session?: boolean } = {}): Promise<void> {
    TestBed.resetTestingModule();
    backend = new FakeAccountBackend();
    const localStorage = new FakeLocalStorage();
    if (options.signedIn !== false) {
      backend.user = ADA;
      localStorage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    }
    let made: MemoryConnector | null = null;
    s = setup({
      localStorage,
      navigator: bluetoothNavigator(true),
      providers: [
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        {
          provide: TRANSPORT_CONNECTOR,
          useValue: (signaling: Parameters<MemoryConnector['connect']>[0]) => {
            if (made === null) {
              throw new Error('No connector yet.');
            }
            return made.connect(signaling);
          },
        },
      ],
    });
    made = new MemoryConnector({ delayMs: 4, timers: rtcTimers(s.perf, s.timers) });
    connector = made;
    TestBed.inject(AuthService);
    await settle();
    cube = options.session === false ? null : await ready(s);
    fixture = TestBed.createComponent(RemoteCameras);
    await pump(0);
  }

  async function pump(ms: number, rounds = 4): Promise<void> {
    for (let k = 0; k < rounds; k++) {
      s.timers.advance(ms / rounds);
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

  /** A phone that joins with the token shown: the connection, its hello, the pings answered. */
  async function joinPhone(label = 'ThinkPhone'): Promise<MessageLink> {
    const token = TestBed.inject(RemoteCamerasService).pairing()?.token ?? '';
    const signaling = new FirestoreSignaling(backend, {
      sessionId: s.service.session()?.id ?? '',
      uid: ADA.uid,
      now: () => s.perf.hostMs,
    }).call({ tokenHash: await hashToken(token) });
    const connecting = connector.connect(signaling);
    await pump(0);
    const link = new MessageLink(await connecting);
    answerPings(link, () => s.perf.hostMs + 500);
    link.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      role: 'camera',
      device: { label, platform: 'Android' },
      app: { version: '0.4.0', commit: 'abc1234' },
      camera: PHONE_CAMERA,
    });
    await pump(20);
    return link;
  }

  it('says why Add camera cannot pair, signed out or without a session', async () => {
    await render({ signedIn: false });
    expect(text('remote-cameras')).toContain('Cameras');
    expect((element('add-camera') as HTMLButtonElement).disabled).toBe(true);
    expect(text('add-camera-blocked')).toBe(
      'Sign in first: the pairing goes through your account.',
    );
    expect(text('remote-cameras-none')).toBe('No phone is paired.');

    await render({ session: false });
    expect((element('add-camera') as HTMLButtonElement).disabled).toBe(true);
    expect(text('add-camera-blocked')).toBe(
      'Connect the cube first: a camera joins the session under way.',
    );
  });

  it('Add camera shows the QR code, the URL and the code to type; Cancel takes it down', async () => {
    await render();
    expect((element('add-camera') as HTMLButtonElement).disabled).toBe(false);
    element('add-camera')?.click();
    await pump(0);
    const service = TestBed.inject(RemoteCamerasService);
    const pairing = service.pairing();
    expect(pairing).not.toBeNull();
    const svg = element('pairing-qr');
    expect(svg?.tagName.toLowerCase()).toBe('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 49 49');
    expect(svg?.querySelector('path')?.getAttribute('d')?.startsWith('M4 4h1v1h-1z')).toBe(true);
    expect(svg?.getAttribute('aria-label')).toBe(`QR code of ${pairing?.url ?? ''}`);
    expect(text('pairing-url')).toBe(pairing?.url);
    expect(element('pairing-url')?.getAttribute('href')).toBe(pairing?.url);
    expect(text('pairing-token')).toBe(tokenText(pairing?.token ?? ''));
    expect(text('pairing-token')).toMatch(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
    expect(text('pairing-expires')).toBe(
      'Good for 10 min 00 s, for one phone; then Add camera again.',
    );
    expect(element('remote-cameras-none')).toBeNull();

    await pump(61_000);
    expect(text('pairing-expires')).toBe(
      'Good for 8 min 59 s, for one phone; then Add camera again.',
    );
    element('cancel-pairing')?.click();
    await pump(0);
    expect(element('pairing')).toBeNull();
    expect(text('remote-cameras-none')).toBe('No phone is paired.');
  });

  it('starts a pairing for each press of the placeholder’s Add camera (addRequests)', async () => {
    await render();
    fixture.componentRef.setInput('addRequests', 1);
    await pump(0);
    const service = TestBed.inject(RemoteCamerasService);
    const first = service.pairing()?.token;
    expect(first).toBeDefined();
    fixture.componentRef.setInput('addRequests', 2);
    await pump(0);
    expect(service.pairing()?.token).not.toBe(first);
  });

  it('lists a phone that joined: its name, its label, its state, its sync, what it reports, its thumbnail; Remove takes it off', async () => {
    await render();
    element('add-camera')?.click();
    await pump(0);
    const link = await joinPhone();
    expect(element('pairing')).toBeNull();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid="remote-camera"]',
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.getAttribute('data-state')).toBe('connected');
    expect(row.getAttribute('data-label')).toBe('phone-rear');
    expect(text('remote-camera-name')).toBe('ThinkPhone');
    expect(text('remote-camera-label')).toBe('phone-rear');
    expect(text('remote-camera-state')).toMatch(/^connected for \d+ s$/);
    expect(text('remote-camera-sync')).toMatch(/^syncing · \d sample/);
    expect(text('remote-camera-report')).toBe('no report yet');
    expect(text('remote-camera-no-picture')).toBe('no picture yet');

    link.send({
      type: 'state',
      remoteMs: s.perf.hostMs,
      recording: true,
      framing: { x: 100, y: 200, w: 800, h: 600 },
      frame: { width: 1080, height: 1920 },
      fps: 29.9,
      sharpness: 41.2,
      battery: { level: 0.83, charging: true },
      thermal: 'throttled',
      pressure: null,
      pressureSource: null,
      pendingClips: 0,
    });
    await pump(10);
    expect(text('remote-camera-report')).toBe(
      '29.9 fps · sharpness 41 · recording · framing 800×600 · battery 83%, charging · hot: the frame rate dropped',
    );
    // The Timer page's words and colours (T5.1): the sharpness good, the frame rate dropped amber.
    const report = element('remote-camera-report');
    expect(report?.querySelector('[data-key="sharpness"]')?.getAttribute('data-tone')).toBe('ok');
    expect(report?.querySelector('[data-key="thermal"]')?.getAttribute('data-tone')).toBe('warn');
    // Clips the phone still has to send (T4.2).
    link.send({
      type: 'state',
      remoteMs: s.perf.hostMs,
      recording: true,
      framing: null,
      frame: null,
      fps: null,
      sharpness: null,
      battery: null,
      thermal: null,
      pressure: null,
      pressureSource: null,
      pendingClips: 2,
    });
    await pump(10);
    expect(text('remote-camera-report')).toBe(
      '– fps · sharpness – · recording · full frame · 2 clips to send',
    );
    // Over 20 s the sync converges.
    await pump(22_000, 22);
    expect(row.getAttribute('data-converged')).toBe('true');
    expect(text('remote-camera-sync')).toMatch(
      /^synced · round trip [\d.]+ ms · offset 500\.\d ms · drift -?[\d.]+ ppm$/,
    );
    expect(text('remote-camera-state')).toMatch(/^connected for 22 s$/);

    element('remove-camera')?.click();
    await pump(0);
    expect(element('remote-camera')).toBeNull();
    expect(text('remote-cameras-none')).toBe('No phone is paired.');
  });

  it('Record remote cameras is on by default, and its box switches the setting (T4.2)', async () => {
    await render();
    const box = element('record-remote-cameras') as HTMLInputElement;
    const settings = TestBed.inject(SettingsService);
    expect(box.checked).toBe(true);
    expect(settings.recordRemoteCameras()).toBe(true);
    box.click();
    await pump(0);
    expect(settings.recordRemoteCameras()).toBe(false);
    expect(box.checked).toBe(false);
    box.click();
    await pump(0);
    expect(settings.recordRemoteCameras()).toBe(true);
  });

  it('Pictures from phones is the same size by default on a laptop, and its choice switches the setting (T5.1)', async () => {
    await render();
    const select = element('remote-pictures') as HTMLSelectElement;
    const settings = TestBed.inject(SettingsService);
    expect(select.value).toBe('equal');
    expect([...select.options].map((option) => option.textContent.trim())).toEqual([
      'Same size as mine',
      'Small tiles',
    ]);
    select.value = 'tiles';
    select.dispatchEvent(new Event('change'));
    await pump(0);
    expect(settings.remotePictures()).toBe('tiles');
    select.value = 'equal';
    select.dispatchEvent(new Event('change'));
    await pump(0);
    expect(settings.remotePicturesChoice()).toBe('equal');
  });

  it('shows a phone whose connection dropped as reconnecting', async () => {
    await render();
    element('add-camera')?.click();
    await pump(0);
    const link = await joinPhone('Pixel');
    link.close('the network went');
    await pump(10);
    const row = element('remote-camera');
    expect(row?.getAttribute('data-state')).toBe('reconnecting');
    expect(text('remote-camera-state')).toMatch(
      /^reconnecting for \d+ s \(removed after 5 min 00 s away\)$/,
    );
  });

  it("shows a phone that the ended session's last clips keep connected", async () => {
    await render();
    element('add-camera')?.click();
    await pump(0);
    await joinPhone('Pixel');
    // A solve, whose two clips the phone does not send, then New session.
    const fake = cube as FakeCube;
    turn(s, fake, 'R U F');
    await pump(1000);
    turn(s, fake, inverse('R U F'), 500);
    await pump(1000);
    s.service.newSession();
    await pump(20);
    const row = element('remote-camera');
    expect(row?.getAttribute('data-state')).toBe('finishing');
    expect(text('remote-camera-state')).toBe("waiting for the phone's last clips (2)");
  });

  it("puts the phone's camera controls under it: waiting, then the panel over the phone's, its drift on the report; none from a build without them (T5.2)", async () => {
    await render();
    element('add-camera')?.click();
    await pump(0);
    const link = await joinPhone();
    const controls = element('remote-camera-controls') as HTMLDetailsElement;
    expect(controls.querySelector('summary')?.textContent.trim()).toBe('Camera controls');
    expect(text('remote-controls-waiting')).toBe("Waiting for the phone's controls…");
    link.send({
      type: 'controls',
      controls: controlsOf(FAKE_PHONE_REAR.capabilities, FAKE_PHONE_REAR.settings),
      values: controlValuesOf(FAKE_PHONE_REAR.settings),
      applied: { focusMode: 'continuous' },
      drift: [{ name: 'focusMode', expected: 'continuous', actual: 'manual' }],
      remoteMs: s.perf.hostMs,
    });
    await pump(10);
    expect(element('remote-controls-waiting')).toBeNull();
    const legends = Array.from(controls.querySelectorAll('legend'), (legend) =>
      legend.textContent.trim(),
    );
    expect(legends).toEqual(['Exposure', 'Focus', 'White balance', 'Zoom']);
    expect(text('camera-controls-drift')).toBe('The camera set the focus to manual by itself.');
    expect(text('remote-camera-report')).toBe('no report yet · focus went manual on the phone');
    // The panel's change goes to the phone.
    const sent: unknown[] = [];
    link.on('set-controls', (message) => {
      sent.push(message);
    });
    const torch = element('control-torch') as HTMLInputElement;
    torch.click();
    await pump(10);
    expect(sent).toEqual([{ type: 'set-controls', values: { torch: true } }]);
    // A phone of a build without remote controls: said after 5 s.
    element('add-camera')?.click();
    await pump(0);
    await joinPhone('Pixel');
    await pump(CONTROLS_WAIT_MS, 5);
    expect(text('remote-controls-unsupported')).toBe(
      "This phone's build has no remote controls: update cubetrace on it, then pair it again.",
    );
  });
});
