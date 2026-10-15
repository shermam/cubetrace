import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FAKE_FACETIME,
  FAKE_PHONE_FRONT,
  FAKE_PHONE_REAR,
  FakeLocalStorage,
  FakeMediaDevices,
  mediaError,
  settle,
  type FakeCamera,
} from '../device/fake-browser';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import {
  DEFAULT_CAMERA,
  SETTINGS_STORAGE_KEY,
  SettingsService,
} from '../settings/settings-service';
import { CAMERA_NOT_CONNECTED } from './camera-errors';
import { CameraService } from './camera-service';
import { WATCH_INTERVAL_MS } from './controls-watch';
import { HostCamerasService } from './host-cameras-service';

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Mobile Safari/537.36';

/** A USB webcam beside the laptop's own camera: its name, its id and a 720p30 mode. */
const USB_WEBCAM: FakeCamera = {
  ...FAKE_FACETIME,
  deviceId: 'usb-webcam',
  label: 'Logitech Webcam C930e (046d:0843)',
};

describe('HostCamerasService', () => {
  let media: FakeMediaDevices;
  let storage: FakeLocalStorage;
  let events: [string, Record<string, unknown>][];

  /** The service as after a page load, with these cameras and these stored settings. */
  function load(
    options: {
      cameras?: readonly FakeCamera[];
      stored?: object;
      granted?: boolean;
      userAgent?: string;
      keepMedia?: boolean;
    } = {},
  ): HostCamerasService {
    TestBed.resetTestingModule();
    if (options.keepMedia !== true) {
      media = new FakeMediaDevices(options.cameras ?? [FAKE_FACETIME, USB_WEBCAM]);
      media.granted = options.granted ?? true;
    }
    if (options.stored !== undefined) {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(options.stored));
    }
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: { mediaDevices: media, userAgent: options.userAgent ?? MAC },
            localStorage: storage,
            // The watchdog's readings (T5.2) never come.
            setTimeout: (callback: () => void, ms: number) => {
              if (ms < WATCH_INTERVAL_MS) {
                queueMicrotask(callback);
              }
              return 0;
            },
          },
        },
      ],
    });
    events = [];
    vi.spyOn(TestBed.inject(DiagnosticsService), 'record').mockImplementation((kind, data = {}) => {
      events.push([kind, { ...data }]);
    });
    return TestBed.inject(HostCamerasService);
  }

  function settings(): SettingsService {
    return TestBed.inject(SettingsService);
  }

  /** Runs the effects and lets the openings they ask for finish. */
  async function update(): Promise<void> {
    TestBed.tick();
    await settle();
    TestBed.tick();
    await settle();
  }

  function device(hosts: HostCamerasService, label: string) {
    const found = hosts.devices().find((candidate) => candidate.label === label);
    if (found === undefined) {
      throw new Error(`No device ${label}.`);
    }
    return found;
  }

  beforeEach(() => {
    storage = new FakeLocalStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns on the cameras switched on, each its own, in the order of the device list', async () => {
    const hosts = load();
    await update();
    expect(hosts.cameras()).toEqual([]);
    expect(hosts.devices().map((camera) => camera.label)).toEqual([
      'FaceTime HD Camera (3A71:F4B5)',
      'Logitech Webcam C930e (046d:0843)',
    ]);

    // The USB webcam first, then the FaceTime camera: listed in the device list's order.
    await hosts.setOn(device(hosts, USB_WEBCAM.label), true);
    await hosts.setOn(device(hosts, FAKE_FACETIME.label), true);
    await update();
    expect(settings().camerasOn()).toEqual([USB_WEBCAM.label, FAKE_FACETIME.label]);
    expect(hosts.cameras().map((camera) => camera.label())).toEqual([
      FAKE_FACETIME.label,
      USB_WEBCAM.label,
    ]);
    expect(hosts.cameras().map((camera) => camera.status())).toEqual(['on', 'on']);
    expect(hosts.primary()?.deviceId()).toBe('facetime');
    expect(media.requests.map((request) => request.video)).toEqual([
      expect.objectContaining({ deviceId: { exact: 'usb-webcam' } }),
      expect.objectContaining({ deviceId: { exact: 'facetime' } }),
    ]);
    expect(media.liveTracks()).toHaveLength(2);
    expect(hosts.isOn(device(hosts, USB_WEBCAM.label))).toBe(true);
    // Each its own identity: the same own label, two devices (T2.14).
    expect(hosts.cameras().map((camera) => camera.identity())).toEqual([
      { label: 'laptop', deviceLabel: FAKE_FACETIME.label, deviceId: 'facetime' },
      { label: 'laptop', deviceLabel: USB_WEBCAM.label, deviceId: 'usb-webcam' },
    ]);
    expect(
      events.filter(([kind]) => kind === 'camera.on').map(([, data]) => data['label']),
    ).toEqual([USB_WEBCAM.label, FAKE_FACETIME.label]);

    // The FaceTime camera off: the webcam goes on, the first camera now.
    const [facetime, webcam] = hosts.cameras();
    await hosts.setOn(device(hosts, FAKE_FACETIME.label), false);
    await update();
    expect(hosts.cameras()).toEqual([webcam]);
    expect(facetime.status()).toBe('off');
    expect(webcam.status()).toBe('on');
    expect(media.liveTracks().map((track) => track.label)).toEqual([USB_WEBCAM.label]);
    expect(events.filter(([kind]) => kind === 'camera.off')).toEqual([
      ['camera.off', { label: FAKE_FACETIME.label }],
    ]);
    expect(hosts.primary()).toBe(webcam);

    // Off: all of them, kept off across a reload.
    hosts.turnOff();
    await update();
    expect(hosts.cameras()).toEqual([]);
    expect(media.liveTracks()).toEqual([]);
    load({ keepMedia: true });
    await update();
    expect(media.liveTracks()).toEqual([]);
  });

  it('opens the cameras on as the page loads, each in its own mode, again when its mode changes', async () => {
    let hosts = load({
      stored: {
        camerasOn: [FAKE_FACETIME.label, USB_WEBCAM.label],
        cameraModes: [{ camera: USB_WEBCAM.label, resolution: '720p', frameRate: '30' }],
      },
    });
    await update();
    expect(hosts.cameras().map((camera) => camera.status())).toEqual(['on', 'on']);
    expect(media.requests.map((request) => request.video)).toEqual([
      expect.objectContaining({
        deviceId: { exact: 'facetime' },
        width: { ideal: 1920 },
        frameRate: { ideal: 60 },
      }),
      expect.objectContaining({
        deviceId: { exact: 'usb-webcam' },
        width: { ideal: 1280 },
        frameRate: { ideal: 30 },
      }),
    ]);

    // Its own mode changed: that camera alone opens again.
    settings().setCameraMode(USB_WEBCAM.label, { resolution: '1080p', frameRate: '30' });
    await update();
    expect(media.requests).toHaveLength(3);
    expect(media.requests[2].video).toMatchObject({
      deviceId: { exact: 'usb-webcam' },
      width: { ideal: 1920 },
    });
    // Settings' mode: the camera without its own opens again; the other keeps its own.
    settings().setCameraResolution('720p');
    await update();
    expect(media.requests).toHaveLength(4);
    expect(media.requests[3].video).toMatchObject({
      deviceId: { exact: 'facetime' },
      width: { ideal: 1280 },
    });
    expect(hosts.cameras().map((camera) => camera.status())).toEqual(['on', 'on']);

    // A reload: both on again.
    hosts = load({ keepMedia: true });
    await update();
    expect(hosts.cameras().map((camera) => camera.label())).toEqual([
      FAKE_FACETIME.label,
      USB_WEBCAM.label,
    ]);
  });

  it('turns on the first device, or the default camera before the browser names them, named once open', async () => {
    // Before the permission the browser names no camera: the default one opens, and its name is kept.
    let hosts = load({ granted: false });
    await update();
    expect(hosts.devices()).toEqual([]);
    await hosts.turnOn();
    expect(settings().camerasOn()).toEqual([FAKE_FACETIME.label]);
    expect(media.requests[0].video).toMatchObject({ facingMode: { ideal: 'user' } });
    await update();
    expect(hosts.cameras().map((camera) => camera.label())).toEqual([FAKE_FACETIME.label]);
    // Named now: the second one beside it, by its id.
    await hosts.setOn(device(hosts, USB_WEBCAM.label), true);
    await update();
    expect(hosts.cameras().map((camera) => camera.status())).toEqual(['on', 'on']);
    expect(media.requests).toHaveLength(2);

    // Named from the start: the first device facing the user (a phone's front camera).
    storage.clear();
    hosts = load({ cameras: [FAKE_PHONE_REAR, FAKE_PHONE_FRONT], userAgent: ANDROID });
    await update();
    await hosts.turnOn();
    expect(settings().camerasOn()).toEqual([FAKE_PHONE_FRONT.label]);
    expect(media.requests[0].video).toMatchObject({ deviceId: { exact: 'phone-front' } });

    // Stored as the default camera (settings from before T5.5), the names known: the first device.
    storage.clear();
    hosts = load({ stored: { camerasOn: [DEFAULT_CAMERA] } });
    await update();
    expect(settings().camerasOn()).toEqual([FAKE_FACETIME.label]);
    expect(hosts.cameras().map((camera) => camera.deviceId())).toEqual(['facetime']);
  });

  it('leaves a camera on that is not connected closed, and opens it when it is plugged in', async () => {
    const hosts = load({
      cameras: [FAKE_FACETIME],
      stored: { camerasOn: [FAKE_FACETIME.label, USB_WEBCAM.label] },
    });
    await update();
    expect(hosts.cameras().map((camera) => camera.label())).toEqual([FAKE_FACETIME.label]);
    expect(media.requests).toHaveLength(1);

    media.setCameras([FAKE_FACETIME, USB_WEBCAM]);
    await update();
    expect(hosts.cameras().map((camera) => camera.label())).toEqual([
      FAKE_FACETIME.label,
      USB_WEBCAM.label,
    ]);
    expect(media.requests[1].video).toMatchObject({ deviceId: { exact: 'usb-webcam' } });
  });

  it('says a camera gone as it opens is not connected, and opens no other camera in its place', async () => {
    const hosts = load();
    await update();
    media.failures.push(mediaError('OverconstrainedError', '', 'deviceId'));
    await hosts.setOn(device(hosts, USB_WEBCAM.label), true);
    const [webcam] = hosts.cameras();
    expect(webcam.status()).toBe('error');
    expect(webcam.error()).toBe(CAMERA_NOT_CONNECTED);
    expect(media.requests).toHaveLength(1);
    expect(media.liveTracks()).toEqual([]);
  });

  it("closes the host's cameras for the camera device page, and opens them again after it", async () => {
    const hosts = load({ stored: { camerasOn: [FAKE_FACETIME.label, USB_WEBCAM.label] } });
    await update();
    const camera = TestBed.inject(CameraService);
    expect(camera.status()).toBe('on');

    await camera.setRole('camera-device');
    expect(hosts.suspended()).toBe(true);
    expect(hosts.cameras()).toEqual([]);
    // The page's camera, its own (the rear one by default), opened as the host's was on.
    expect(camera.status()).toBe('on');
    expect(media.liveTracks()).toHaveLength(1);
    expect(settings().camerasOn()).toEqual([FAKE_FACETIME.label, USB_WEBCAM.label]);

    await camera.setRole('host');
    await update();
    expect(hosts.suspended()).toBe(false);
    expect(hosts.cameras().map((one) => one.status())).toEqual(['on', 'on']);
    expect(media.liveTracks()).toHaveLength(2);
  });
});
