import { TestBed } from '@angular/core/testing';

import { CameraService } from '../camera/camera-service';
import { CAPTURE_STARTER } from '../camera/recording-service';
import { FakeCaptureStarter, statsOf } from '../camera/recording-testing';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FAKE_PHONE_FRONT,
  FAKE_PHONE_REAR,
  FakeLocalStorage,
  FakeMediaDevices,
  FakeStorageManager,
  mediaError,
  settle,
} from '../device/fake-browser';
import { StorageService } from '../device/storage-service';
import { SettingsService } from '../settings/settings-service';
import { CameraDeviceCapture } from './camera-device-capture';

const ANDROID = 'Mozilla/5.0 (Linux; Android 16; K) Chrome/155.0.0.0 Mobile Safari/537.36';

describe('CameraDeviceCapture', () => {
  let media: FakeMediaDevices;
  let starter: FakeCaptureStarter;
  let storage: FakeStorageManager;

  function rig(options: { supported?: boolean; usage?: number } = {}): {
    capture: CameraDeviceCapture;
    camera: CameraService;
    settings: SettingsService;
  } {
    TestBed.resetTestingModule();
    media = new FakeMediaDevices([FAKE_PHONE_FRONT, FAKE_PHONE_REAR]);
    starter = new FakeCaptureStarter();
    starter.supported = options.supported ?? true;
    storage = new FakeStorageManager({ usage: options.usage ?? 0, quota: 100 });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: { userAgent: ANDROID, mediaDevices: media, storage },
            localStorage: new FakeLocalStorage(),
          },
        },
        { provide: CAPTURE_STARTER, useValue: starter },
      ],
    });
    return {
      capture: TestBed.inject(CameraDeviceCapture),
      camera: TestBed.inject(CameraService),
      settings: TestBed.inject(SettingsService),
    };
  }

  async function sync(capture: CameraDeviceCapture): Promise<void> {
    TestBed.tick();
    await capture.settled();
    await settle();
    TestBed.tick();
  }

  it('runs the pipeline on the camera while the page wants it, with the microphone raw, and stops when it lets go', async () => {
    const { capture, camera } = rig();
    expect(capture.status()).toBe('off');
    capture.setWanted(true);
    await sync(capture);
    // No stream yet: nothing runs.
    expect(starter.started).toEqual([]);
    expect(capture.status()).toBe('off');

    await camera.setRole('camera-device');
    await camera.start();
    await sync(capture);
    expect(starter.started).toHaveLength(1);
    const pipeline = starter.last;
    expect(pipeline.video.label).toBe('camera 0, facing back');
    expect(pipeline.audio?.kind).toBe('audio');
    expect(pipeline.config).toEqual({ audio: true, quality: 'standard' });
    expect(media.requests.at(-1)).toMatchObject({ audio: { echoCancellation: false } });
    expect(capture.status()).toBe('starting');
    expect(capture.microphone()).toMatchObject({ processing: 'raw', echoCancellation: false });
    pipeline.emitStats(statsOf(2));
    expect(capture.status()).toBe('recording');
    expect(capture.stats()?.bufferSeconds).toBe(2);

    capture.setWanted(false);
    await sync(capture);
    expect(pipeline.stopped).toBe(true);
    expect(capture.status()).toBe('off');
    expect(media.audioTracks[0].readyState).toBe('ended');
    // The camera stays on: the page decides that.
    expect(camera.status()).toBe('on');
  });

  it('starts again when the camera or the settings change, and records without audio when Record audio is off', async () => {
    const { capture, camera, settings } = rig();
    capture.setWanted(true);
    await camera.setRole('camera-device');
    await camera.start();
    await sync(capture);
    const first = starter.last;
    await camera.select(FAKE_PHONE_FRONT.deviceId);
    await sync(capture);
    expect(first.stopped).toBe(true);
    expect(starter.started).toHaveLength(2);
    expect(starter.last.video.label).toBe('camera 1, facing front');

    settings.setRecordAudio(false);
    await sync(capture);
    expect(starter.started).toHaveLength(3);
    expect(starter.last.audio).toBeNull();
    expect(starter.last.config.audio).toBe(false);
    expect(capture.microphone()).toBeNull();
  });

  it('says when the microphone cannot be had, and records the video anyway', async () => {
    const { capture, camera } = rig();
    media.microphoneFailures.push(mediaError('NotAllowedError'));
    capture.setWanted(true);
    await camera.setRole('camera-device');
    await camera.start();
    await sync(capture);
    expect(starter.last.audio).toBeNull();
    expect(capture.notices()).toEqual([
      'Recording without audio: the microphone was not allowed (Chrome asks once; the site settings can change it).',
    ]);
  });

  it('does not record where the browser lacks the capture APIs, nor when storage is full, and says so', async () => {
    let r = rig({ supported: false });
    r.capture.setWanted(true);
    await r.camera.setRole('camera-device');
    await r.camera.start();
    await sync(r.capture);
    expect(starter.started).toEqual([]);
    expect(r.capture.status()).toBe('error');
    expect(r.capture.error()).toMatch(/^This browser cannot record video/);

    r = rig({ usage: 96 });
    r.capture.setWanted(true);
    await r.camera.setRole('camera-device');
    await r.camera.start();
    await TestBed.inject(StorageService).refresh();
    await sync(r.capture);
    expect(starter.started).toEqual([]);
    expect(r.capture.status()).toBe('error');
    expect(r.capture.error()).toMatch(/^Storage is 95% full/);
  });
});
