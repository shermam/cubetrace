import { TestBed } from '@angular/core/testing';
import { LumaSampler, type Canvas2D } from '@cubetrace/capture';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import {
  FAKE_FACETIME,
  FAKE_PHONE_FRONT,
  FAKE_PHONE_REAR,
  FAKE_WEBCAM,
  FakeLocalStorage,
  FakeMediaDevices,
  FakeVideoFrames,
  mediaError,
  settle,
  type FakeCamera,
} from '../device/fake-browser';
import { SETTINGS_STORAGE_KEY, SettingsService } from '../settings/settings-service';
import { CAMERA_ENDED, NO_CAMERA_API } from './camera-errors';
import { CameraService, LUMA_SAMPLER, cameraDevices } from './camera-service';

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Mobile Safari/537.36';

/** A canvas that paints what `paint` says and records how it was drawn to. */
class PatternCanvas implements Canvas2D<CanvasImageSource> {
  readonly draws: number[][] = [];
  paint: (x: number, y: number) => number = () => 0;

  drawImage(_source: CanvasImageSource, ...args: number[]): void {
    this.draws.push(args);
  }

  getImageData(_sx: number, _sy: number, sw: number, sh: number): { data: Uint8ClampedArray } {
    const data = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const value = this.paint(x, y);
        data.set([value, value, value, 255], (y * sw + x) * 4);
      }
    }
    return { data };
  }
}

/** Squares of 20 pixels, dark and light: sharp. */
const checkers = (x: number, y: number): number =>
  (Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? 40 : 220;

describe('CameraService', () => {
  let media: FakeMediaDevices;
  let storage: FakeLocalStorage;
  let canvas: PatternCanvas;

  /** A service as after a page load, with these cameras and these stored settings. */
  function load(
    options: {
      cameras?: readonly FakeCamera[];
      stored?: object;
      userAgent?: string;
      granted?: boolean;
      globals?: BrowserGlobals;
      keepMedia?: boolean;
    } = {},
  ): CameraService {
    TestBed.resetTestingModule();
    if (options.keepMedia !== true) {
      media = new FakeMediaDevices(options.cameras ?? [FAKE_WEBCAM]);
      media.granted = options.granted ?? false;
    }
    if (options.stored !== undefined) {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(options.stored));
    }
    canvas = new PatternCanvas();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: options.globals ?? {
            navigator: { mediaDevices: media, userAgent: options.userAgent ?? MAC },
            localStorage: storage,
            setTimeout: (callback: () => void) => {
              queueMicrotask(callback);
              return 0;
            },
          },
        },
        { provide: LUMA_SAMPLER, useValue: new LumaSampler<CanvasImageSource>(() => canvas) },
      ],
    });
    return TestBed.inject(CameraService);
  }

  function settings(): SettingsService {
    return TestBed.inject(SettingsService);
  }

  beforeEach(() => {
    storage = new FakeLocalStorage();
  });

  it('lists no camera by name before the permission, then front and rear on a phone', async () => {
    const camera = load({ cameras: [FAKE_PHONE_FRONT, FAKE_PHONE_REAR], userAgent: ANDROID });
    await settle();
    expect(camera.devices()).toEqual([]);

    await camera.start();
    await settle();
    expect(camera.devices()).toEqual([
      {
        deviceId: 'phone-front',
        label: 'camera 1, facing front',
        name: 'Front camera',
        facing: 'user',
      },
      {
        deviceId: 'phone-rear',
        label: 'camera 0, facing back',
        name: 'Rear camera',
        facing: 'environment',
      },
    ]);
  });

  it('names cameras by label, numbered when unnamed, told apart when two share a name', () => {
    const info = (deviceId: string, label: string, kind: MediaDeviceKind = 'videoinput') => ({
      deviceId,
      label,
      kind,
      groupId: '',
      toJSON: () => ({}),
    });
    expect(
      cameraDevices([
        info('a', 'camera 0, facing back'),
        info('b', 'camera 2, facing back'),
        info('c', ''),
        info('d', 'FaceTime HD Camera'),
        info('e', 'Built-in Microphone', 'audioinput'),
        info('', ''),
      ]).map((device) => device.name),
    ).toEqual([
      'Rear camera (camera 0, facing back)',
      'Rear camera (camera 2, facing back)',
      'Camera 3',
      'FaceTime HD Camera',
    ]);
  });

  it('turns on: the front camera at 1920×1080, ideally 60 fps, remembered for this host', async () => {
    const camera = load();
    media.hold();
    const starting = camera.start();
    await settle();
    expect(camera.status()).toBe('starting');
    expect(camera.stream()).toBeNull();

    media.release();
    await starting;
    expect(camera.status()).toBe('on');
    expect(camera.error()).toBeNull();
    expect(camera.notice()).toBeNull();
    expect(media.requests).toEqual([
      {
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      },
    ]);
    expect(camera.stream()?.getVideoTracks()).toEqual([media.tracks[0]]);
    expect(camera.label()).toBe('fake_device_0');
    expect(camera.settings()).toMatchObject({ width: 1920, height: 1080, frameRate: 20 });
    expect(camera.settings()).not.toHaveProperty('deviceId');
    expect(camera.controls()?.exposureModes).toEqual(['continuous', 'manual']);
    expect(camera.frameSize()).toEqual({ width: 1920, height: 1080 });
    expect(camera.mirrored()).toBe(false);
    expect(settings().cameraOn()).toBe(true);
    expect(settings().cameraPickFor('macOS laptop')).toEqual({
      host: 'macOS laptop',
      deviceId: 'fake-webcam',
      label: 'fake_device_0',
    });
  });

  it('turns off and stays off after a reload; turned on, it opens again when the page loads', async () => {
    let camera = load();
    await camera.start();
    const track = media.tracks[0];

    camera.stop();
    expect(camera.status()).toBe('off');
    expect(camera.stream()).toBeNull();
    expect(track.readyState).toBe('ended');
    expect(settings().cameraOn()).toBe(false);

    camera = load();
    await settle();
    expect(camera.status()).toBe('off');
    expect(media.requests).toEqual([]);

    settings().setCameraOn(true);
    camera = load();
    await settle();
    expect(camera.status()).toBe('on');
    expect(media.liveTracks()).toHaveLength(1);
  });

  it('opens the camera chosen on this host, by its id, else by its label', async () => {
    const cameras = [FAKE_PHONE_FRONT, FAKE_PHONE_REAR];
    const pick = { host: 'Android phone', deviceId: 'phone-rear', label: 'camera 0, facing back' };
    let camera = load({
      cameras,
      granted: true,
      userAgent: ANDROID,
      stored: { cameraPicks: [pick] },
    });
    await camera.start();
    expect(media.requests[0].video).toMatchObject({ deviceId: { exact: 'phone-rear' } });
    expect(camera.label()).toBe('camera 0, facing back');
    expect(camera.facing()).toBe('environment');

    // Site data cleared: the ids changed, the label did not.
    camera = load({
      cameras,
      granted: true,
      userAgent: ANDROID,
      stored: { cameraPicks: [{ ...pick, deviceId: 'old-id' }] },
    });
    await camera.start();
    expect(media.requests[0].video).toMatchObject({ deviceId: { exact: 'phone-rear' } });
    expect(camera.notice()).toBeNull();
  });

  it('opens the default camera when the chosen one is gone, and says so', async () => {
    const camera = load({
      stored: { cameraPicks: [{ host: 'macOS laptop', deviceId: 'usb-cam', label: 'USB cam' }] },
    });
    await camera.start();

    expect(media.requests.map((request) => request.video)).toEqual([
      expect.objectContaining({ deviceId: { exact: 'usb-cam' } }),
      expect.objectContaining({ facingMode: { ideal: 'user' } }),
    ]);
    expect(camera.status()).toBe('on');
    expect(camera.notice()).toBe(
      'The camera chosen before is not connected: the default camera is on instead.',
    );
    expect(settings().cameraPickFor('macOS laptop')?.deviceId).toBe('fake-webcam');
  });

  it('asks for exactly 60 fps when Settings says so; without it, the best rate, and says so', async () => {
    const camera = load({ cameras: [FAKE_FACETIME], stored: { cameraFrameRate: '60' } });
    await camera.start();

    expect(media.requests.map((request) => request.video)).toEqual([
      expect.objectContaining({ frameRate: { exact: 60 } }),
      expect.objectContaining({ frameRate: { ideal: 60 } }),
    ]);
    expect(camera.status()).toBe('on');
    expect(camera.notice()).toBe(
      'This camera has no mode at exactly 60 fps at 1920×1080: it opened at its best rate.',
    );
  });

  it('asks for 1280×720 at 30 fps when Settings says so', async () => {
    const camera = load({ stored: { cameraResolution: '720p', cameraFrameRate: '30' } });
    await camera.start();
    expect(media.requests[0].video).toMatchObject({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  });

  it('a busy camera: asked again once, then at 1280×720, 30 fps, which it says', async () => {
    const camera = load();
    media.failures.push(
      mediaError('NotReadableError', 'Could not start video source'),
      mediaError('NotReadableError', 'Could not start video source'),
    );
    await camera.start();

    expect(media.requests.map((request) => request.video)).toEqual([
      expect.objectContaining({ width: { ideal: 1920 } }),
      expect.objectContaining({ width: { ideal: 1920 } }),
      expect.objectContaining({ width: { ideal: 1280 }, frameRate: { ideal: 30 } }),
    ]);
    expect(camera.status()).toBe('on');
    expect(camera.notice()).toBe(
      'The camera could not start at 1920×1080, 60 fps: it opened at 1280×720, 30 fps.',
    );
  });

  it('says in plain words why the camera did not open', async () => {
    const cases: [unknown, RegExp][] = [
      [mediaError('NotAllowedError', 'Permission denied'), /^The camera permission was denied/],
      [mediaError('NotAllowedError', 'Permission denied by system'), /Privacy & Security/],
      [mediaError('NotFoundError', 'Requested device not found'), /^No camera was found/],
      [mediaError('SecurityError'), /https/],
      [new TypeError('bad'), /^The camera could not start \(bad\)\.$/],
    ];
    for (const [error, text] of cases) {
      const camera = load();
      media.failures.push(error);
      await camera.start();
      expect(camera.status()).toBe('error');
      expect(camera.error()).toMatch(text);
      expect(camera.stream()).toBeNull();
    }

    const busy = load();
    media.failures.push(...Array.from({ length: 4 }, () => mediaError('NotReadableError')));
    await busy.start();
    expect(busy.error()).toMatch(/^The camera is in use by another app, or could not start/);

    const none = load({ globals: { navigator: {}, localStorage: storage } });
    await none.start();
    expect(none.status()).toBe('error');
    expect(none.error()).toBe(NO_CAMERA_API);
  });

  it('switches to the camera chosen while on; one chosen while off opens next time', async () => {
    const camera = load({ cameras: [FAKE_PHONE_FRONT, FAKE_PHONE_REAR], userAgent: ANDROID });
    await camera.start();
    await settle();
    expect(camera.label()).toBe('camera 1, facing front');
    expect(camera.mirrored()).toBe(true);
    const front = media.tracks[0];

    await camera.select('phone-rear');
    expect(front.readyState).toBe('ended');
    expect(camera.label()).toBe('camera 0, facing back');
    expect(camera.mirrored()).toBe(false);
    expect(camera.selectedId()).toBe('phone-rear');

    camera.stop();
    await camera.select('phone-front');
    expect(camera.status()).toBe('off');
    expect(media.requests).toHaveLength(2);
    await camera.start();
    expect(media.requests[2].video).toMatchObject({ deviceId: { exact: 'phone-front' } });
  });

  it('opens again with a new resolution or frame rate from Settings', async () => {
    const camera = load();
    await camera.start();
    settings().setCameraResolution('720p');
    TestBed.tick();
    await settle();
    expect(media.requests).toHaveLength(2);
    expect(media.requests[1].video).toMatchObject({ width: { ideal: 1280 } });
    expect(camera.status()).toBe('on');

    camera.stop();
    settings().setCameraFrameRate('30');
    TestBed.tick();
    await settle();
    expect(media.requests).toHaveLength(2);
  });

  it('says so when the camera stops while on', async () => {
    const camera = load();
    await camera.start();
    media.tracks[0].end();
    expect(camera.status()).toBe('error');
    expect(camera.error()).toBe(CAMERA_ENDED);
    expect(camera.stream()).toBeNull();
    expect(settings().cameraOn()).toBe(true);
  });

  it('sets manual exposure, keeps it for the camera and applies it again when it opens', async () => {
    let camera = load({ cameras: [FAKE_PHONE_REAR], userAgent: ANDROID });
    await camera.start();
    const track = media.tracks[0];

    await camera.setControl('exposureMode', 'manual');
    // On the camera's steps, counted from its minimum of 0.832.
    await camera.setControl('exposureTime', 20.04);
    await camera.setControl('torch', true);
    expect(track.applied).toEqual([
      { advanced: [{ exposureMode: 'manual' }] },
      { advanced: [{ exposureMode: 'manual', exposureTime: 20.032 }] },
      { advanced: [{ torch: true }] },
    ]);
    expect(camera.values()).toMatchObject({
      exposureMode: 'manual',
      exposureTime: 20.032,
      torch: true,
    });
    expect(settings().cameraControlsFor('camera 0, facing back')).toEqual({
      exposureMode: 'manual',
      exposureTime: 20.032,
    });
    expect(camera.busy()).toBe(false);

    camera = load({ keepMedia: true, userAgent: ANDROID });
    await camera.start();
    expect(media.tracks[1].applied).toEqual([
      { advanced: [{ exposureMode: 'manual', exposureTime: 20.032 }] },
    ]);
    expect(camera.values()).toMatchObject({
      exposureMode: 'manual',
      exposureTime: 20.032,
      torch: false,
    });
  });

  it('back to auto forgets the group; a camera that stays manual is opened again', async () => {
    const camera = load({ cameras: [FAKE_PHONE_REAR], userAgent: ANDROID });
    await camera.start();
    await camera.setControl('exposureMode', 'manual');
    await camera.setControl('zoom', 2);
    await camera.setControl('exposureMode', 'continuous');
    expect(camera.values()).toMatchObject({ exposureMode: 'continuous', zoom: 2 });
    expect(settings().cameraControlsFor('camera 0, facing back')).toEqual({ zoom: 2 });
    expect(media.tracks).toHaveLength(1);

    // The front camera lists only manual focus: "continuous" is refused by constraint.
    const front = load({ cameras: [FAKE_PHONE_FRONT], userAgent: ANDROID });
    await front.start();
    await front.setControl('focusDistance', 0.5);
    expect(front.values()).toMatchObject({ focusMode: 'manual', focusDistance: 0.5 });
    // Automatic focus, which it opened in, stays one to choose.
    expect(front.controls()?.focusModes).toEqual(['continuous', 'manual']);
    await front.setControl('focusMode', 'continuous');
    expect(media.tracks).toHaveLength(2);
    expect(media.tracks[0].readyState).toBe('ended');
    expect(front.values()).toMatchObject({ focusMode: 'continuous' });
    expect(settings().cameraControlsFor('camera 1, facing front')).toEqual({});
    expect(front.status()).toBe('on');
  });

  it('Reset to auto forgets the controls kept for the camera and opens it again', async () => {
    const camera = load({ cameras: [FAKE_PHONE_REAR], userAgent: ANDROID });
    await camera.start();
    await camera.setControl('whiteBalanceMode', 'manual');
    await camera.setControl('colorTemperature', 4460);
    expect(camera.values()).toMatchObject({ whiteBalanceMode: 'manual', colorTemperature: 4450 });

    await camera.resetControls();
    expect(media.tracks).toHaveLength(2);
    expect(media.tracks[1].applied).toEqual([]);
    expect(camera.values()).toMatchObject({ whiteBalanceMode: 'continuous', colorTemperature: 0 });
    expect(settings().cameraControlsFor('camera 0, facing back')).toEqual({});
  });

  it('says so when the camera refuses a control', async () => {
    const camera = load({ cameras: [FAKE_PHONE_REAR], userAgent: ANDROID });
    await camera.start();
    media.tracks[0].refuseWith = mediaError('OperationError', 'Could not set zoom');
    await camera.setControl('zoom', 3);
    expect(camera.notice()).toBe('The camera refused the change (Could not set zoom).');
    expect(camera.values().zoom).toBe(1);
  });

  it('measures the preview: its frames, the real frame rate, and the sharpness twice a second', async () => {
    const camera = load({ cameras: [FAKE_PHONE_REAR], userAgent: ANDROID });
    await camera.start();
    const video = document.createElement('video');
    const frames = new FakeVideoFrames();
    frames.install(video);
    canvas.paint = checkers;

    // Frames 40 ms apart (25 fps): the first is measured, then one every 13 frames (520 ms).
    const stop = camera.watchPreview(video);
    expect(camera.sharpness()).toBeNull();
    frames.present(1, 40, 1080, 1920);
    expect(camera.frameSize()).toEqual({ width: 1080, height: 1920 });
    expect(canvas.draws).toEqual([[0, 0, 1080, 1920, 0, 0, 160, 284]]);
    expect(camera.sharpness()).toBeGreaterThan(1000);
    expect(camera.sharpnessSamples()).toBe(1);
    expect(camera.sharpnessGood()).toBe(true);

    frames.present(12, 40, 1080, 1920);
    expect(camera.sharpnessSamples()).toBe(1);
    frames.present(1, 40, 1080, 1920);
    expect(camera.sharpnessSamples()).toBe(2);
    // The track claims 60 fps; the frames come every 40 ms.
    frames.present(37, 40, 1080, 1920);
    expect(camera.settings()?.['frameRate']).toBe(60);
    expect(camera.measuredFps()).toBeCloseTo(25, 6);
    // 51 frames, 2 s: four measurements.
    expect(camera.sharpnessSamples()).toBe(4);

    canvas.paint = () => 128;
    frames.present(13, 40, 1080, 1920);
    expect(camera.sharpness()).toBe(0);
    expect(camera.sharpnessGood()).toBe(false);
    expect(camera.sharpnessSamples()).toBe(5);

    stop();
    expect(frames.waiting).toBe(0);
    frames.present(13, 40);
    expect(camera.sharpnessSamples()).toBe(5);

    expect(camera.watchPreview(document.createElement('video'))).toEqual(expect.any(Function));
    expect(camera.frameProblem()).toBe(
      'This browser cannot measure the frames (no requestVideoFrameCallback).',
    );
  });

  it('measures no sharpness while it is held, and again once it is not', async () => {
    const camera = load();
    await camera.start();
    const video = document.createElement('video');
    const frames = new FakeVideoFrames();
    frames.install(video);
    canvas.paint = checkers;
    let held = false;

    camera.watchPreview(video, () => held);
    frames.present(1, 40);
    expect(camera.sharpnessSamples()).toBe(1);
    held = true;
    // 4 s of frames while held (a solve): none measured; the frame rate and size still are.
    frames.present(100, 40);
    expect(camera.sharpnessSamples()).toBe(1);
    expect(camera.measuredFps()).toBeCloseTo(25, 6);
    held = false;
    frames.present(1, 40);
    expect(camera.sharpnessSamples()).toBe(2);
  });

  it('keeps the framing rectangle per camera and frame size; the full frame by default', async () => {
    let camera = load();
    await camera.start();
    expect(camera.framing()).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });

    camera.setFraming({ x: -50, y: 100, w: 800, h: 600 });
    expect(camera.framing()).toEqual({ x: 0, y: 100, w: 800, h: 600 });
    expect(settings().cameraFramingsOf('fake_device_0')).toEqual([
      {
        camera: 'fake_device_0',
        width: 1920,
        height: 1080,
        rect: { x: 0, y: 100, w: 800, h: 600 },
      },
    ]);

    // The sharpness is measured on the rectangle.
    const video = document.createElement('video');
    const frames = new FakeVideoFrames();
    frames.install(video);
    camera.watchPreview(video);
    frames.present(1);
    expect(canvas.draws.at(-1)).toEqual([0, 100, 800, 600, 0, 0, 160, 120]);

    camera = load({ keepMedia: true });
    await camera.start();
    expect(camera.framing()).toEqual({ x: 0, y: 100, w: 800, h: 600 });
  });

  it("builds the session's camera entry while on, and none while off", async () => {
    const camera = load();
    expect(camera.cameraInfo()).toBeNull();
    await camera.start();
    // The whole frame is no crop.
    expect(camera.cameraInfo()?.crop).toBeNull();
    camera.setFraming({ x: 480, y: 270, w: 960, h: 540 });

    expect(camera.cameraInfo()).toEqual({
      label: 'laptop',
      local: true,
      facing: 'unknown',
      deviceLabel: 'fake_device_0',
      settings: camera.settings(),
      capabilities: camera.capabilities(),
      constraints: {
        facingMode: { ideal: 'user' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
      crop: { x: 480, y: 270, w: 960, h: 540 },
      mode: 'full',
    });

    const phone = load({ cameras: [FAKE_PHONE_FRONT], userAgent: ANDROID });
    await phone.start();
    expect(phone.cameraInfo()).toMatchObject({ label: 'phone-front', facing: 'user' });
  });
});
