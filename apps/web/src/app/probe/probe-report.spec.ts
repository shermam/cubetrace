import {
  DEFAULT_WINDOW_SECONDS,
  listCameras,
  parseWindowSeconds,
  runProbe,
  type ProbeOptions,
} from './probe-report';

const REPORT_KEYS = [
  'generatedAt',
  'label',
  'device',
  'camera',
  'capabilities',
  'settings',
  'timing',
  'encoders',
  'worker',
  'storage',
  'bluetooth',
  'hints',
];
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const OPTIONS: ProbeOptions = {
  label: ' test ',
  seconds: 1,
  now: () => new Date('2026-09-27T12:00:00Z'),
};

describe('runProbe', () => {
  it('reports every section, each saying what is missing, for a navigator with none of the APIs', async () => {
    const report = await runProbe({ navigator: { userAgent: FIREFOX } }, OPTIONS);

    expect(Object.keys(report)).toEqual(REPORT_KEYS);
    expect(report).toEqual({
      generatedAt: '2026-09-27T12:00:00.000Z',
      label: 'test',
      device: {
        screen: { missing: 'screen' },
        devicePixelRatio: { missing: 'devicePixelRatio' },
        hardwareConcurrency: { missing: 'navigator.hardwareConcurrency' },
        deviceMemory: { missing: 'navigator.deviceMemory' },
        secureContext: { missing: 'isSecureContext' },
      },
      camera: { missing: 'navigator.mediaDevices' },
      capabilities: { skipped: 'no camera API' },
      settings: { skipped: 'no camera API' },
      timing: { skipped: 'no camera API' },
      encoders: { missing: 'VideoEncoder' },
      worker: {
        inWorker: { missing: 'Worker' },
        onMainThread: { MediaStreamTrackProcessor: false, VideoEncoder: false },
      },
      storage: { missing: 'navigator.storage' },
      bluetooth: {
        navigatorBluetooth: false,
        getDevices: false,
        watchAdvertisements: false,
        availability: { missing: 'navigator.bluetooth' },
      },
      hints: { userAgent: FIREFOX, userAgentData: { missing: 'navigator.userAgentData' } },
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('reports what a Firefox-like browser has and marks the Chrome-only APIs missing', async () => {
    // Camera, storage and encoder APIs, no Web Bluetooth, client hints or track processor;
    // the camera permission is refused.
    const scope = {
      navigator: {
        userAgent: FIREFOX,
        hardwareConcurrency: 8,
        mediaDevices: {
          enumerateDevices: () =>
            Promise.resolve([{ kind: 'videoinput', deviceId: '', label: '', groupId: '' }]),
          getUserMedia: () =>
            Promise.reject(new DOMException('The request is not allowed', 'NotAllowedError')),
        },
        storage: {
          estimate: () => Promise.resolve({ quota: 1e9, usage: 42 }),
          persisted: () => Promise.resolve(true),
        },
      },
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
        orientation: { type: 'landscape-primary' },
      },
      devicePixelRatio: 1.25,
      isSecureContext: true,
      VideoEncoder: Object.assign(() => undefined, {
        isConfigSupported: (config: { codec: string }) =>
          Promise.resolve({ supported: config.codec === 'avc1.4d0028', config }),
      }),
    };

    const report = await runProbe(scope, OPTIONS);

    expect(report.device).toEqual({
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
        orientation: 'landscape-primary',
      },
      devicePixelRatio: 1.25,
      hardwareConcurrency: 8,
      deviceMemory: { missing: 'navigator.deviceMemory' },
      secureContext: true,
    });
    expect(report.camera).toEqual({ error: 'NotAllowedError: The request is not allowed' });
    expect(report.timing).toEqual({ skipped: 'the camera could not be listed' });
    expect(report.encoders).toEqual({
      results: [30, 60]
        .flatMap((framerate) =>
          ['prefer-hardware', 'no-preference'].map((hardwareAcceleration) => ({
            codec: 'avc1.640028',
            width: 1920,
            height: 1080,
            framerate,
            hardwareAcceleration,
            supported: false,
          })),
        )
        .concat(
          [30, 60].flatMap((framerate) =>
            ['prefer-hardware', 'no-preference'].map((hardwareAcceleration) => ({
              codec: 'avc1.4d0028',
              width: 1920,
              height: 1080,
              framerate,
              hardwareAcceleration,
              supported: true,
            })),
          ),
        ),
    });
    expect(report.worker).toEqual({
      inWorker: { missing: 'Worker' },
      onMainThread: { MediaStreamTrackProcessor: false, VideoEncoder: true },
    });
    expect(report.storage).toEqual({ estimate: { quota: 1e9, usage: 42 }, persisted: true });
    expect(report.bluetooth).toMatchObject({ navigatorBluetooth: false });
    expect(report.hints).toEqual({
      userAgent: FIREFOX,
      userAgentData: { missing: 'navigator.userAgentData' },
    });
  });

  it('turns APIs that throw or reject into error values, one by one', async () => {
    const scope = {
      navigator: {
        get userAgent(): string {
          throw new TypeError('no user agent');
        },
        userAgentData: { getHighEntropyValues: () => Promise.reject(new Error('no hints')) },
        bluetooth: { getAvailability: () => Promise.reject(new Error('no adapter')) },
        storage: {
          estimate: () => Promise.reject(new DOMException('denied', 'SecurityError')),
          persisted: () => {
            throw new Error('no persistence');
          },
        },
        mediaDevices: {
          enumerateDevices: () => Promise.reject(new Error('no devices')),
          getUserMedia: () => Promise.reject(new Error('no camera')),
        },
      },
      VideoEncoder: Object.assign(() => undefined, {
        isConfigSupported: () => Promise.reject(new TypeError('bad config')),
      }),
      Worker: function BlockedWorker(): never {
        throw new DOMException('blocked', 'SecurityError');
      },
      Blob,
      URL: { createObjectURL: () => 'blob:probe', revokeObjectURL: () => undefined },
    };

    const report = await runProbe(scope, OPTIONS);

    expect(report.hints).toEqual({
      userAgent: { error: 'TypeError: no user agent' },
      userAgentData: { error: 'Error: no hints' },
    });
    expect(report.bluetooth).toEqual({
      navigatorBluetooth: true,
      getDevices: false,
      watchAdvertisements: false,
      availability: { error: 'Error: no adapter' },
    });
    expect(report.storage).toEqual({
      estimate: { error: 'SecurityError: denied' },
      persisted: { error: 'Error: no persistence' },
    });
    expect(report.encoders).toMatchObject({
      results: Array.from({ length: 8 }, () => ({ supported: { error: 'TypeError: bad config' } })),
    });
    expect(report.worker).toMatchObject({ inWorker: { error: 'SecurityError: blocked' } });
    expect(report.camera).toEqual({ error: 'Error: no devices' });
  });

  it('never throws, even when every property of the scope throws', async () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile');
        },
      },
    );
    const onProgress = (): void => {
      throw new Error('the page broke');
    };

    const report = await runProbe(hostile, { ...OPTIONS, onProgress });

    expect(Object.keys(report)).toEqual(REPORT_KEYS);
    for (const key of ['device', 'camera', 'encoders', 'storage', 'bluetooth', 'hints'] as const) {
      expect(report[key]).toEqual({ error: 'Error: hostile' });
    }
    expect(report.worker).toEqual({
      inWorker: { error: 'Error: hostile' },
      onMainThread: { error: 'Error: hostile' },
    });
    expect(report.timing).toEqual({ skipped: 'no camera API' });
  });

  it('falls back down the constraint ladder and measures the frames of the camera it opened', async () => {
    const camera = fakeCamera({ rejectFirst: true });

    const report = await runProbe(camera.scope, {
      ...OPTIONS,
      deviceId: 'rear',
      seconds: 2,
      warmupMs: 0,
      video: camera.video,
    });

    expect(report.camera).toEqual({
      videoInputs: [
        { deviceId: 'front', label: 'Front camera', groupId: 'g-front' },
        { deviceId: 'rear', label: 'Rear camera', groupId: 'g-rear' },
      ],
      selected: { deviceId: 'rear', label: 'Rear camera', groupId: 'g-rear' },
      requested: { deviceId: { exact: 'rear' } },
      failedAttempts: [
        {
          requested: {
            deviceId: { exact: 'rear' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 60 },
          },
          error: 'OverconstrainedError (constraint: frameRate)',
        },
      ],
      trackLabel: 'Rear camera',
    });
    expect(report.settings).toEqual({ width: 1920, height: 1080, frameRate: 30 });
    expect(report.capabilities).toEqual({ frameRate: { min: 1, max: 30 } });
    expect(report.timing).toMatchObject({
      warmupMs: 0,
      windowMs: 2000,
      completed: true,
      frames: 59,
      durationMs: 2000,
      achievedFps: 29,
      captureMinusNowMs: { p50: -5 },
      mediaTimeDeltaMs: { p50: 33.333 },
      callbackMissedFrames: 1,
      droppedFramesEstimate: 1,
      frameSizes: ['1920x1080'],
      playbackQuality: { totalVideoFrames: 59, droppedVideoFrames: 0 },
    });
    expect(camera.video.srcObject).toBeNull();
    expect(camera.stoppedTracks()).toBe(1);
  });

  it('retries the same constraints once when the camera is still busy', async () => {
    const camera = fakeCamera({ busyFirst: true });

    const report = await runProbe(camera.scope, {
      ...OPTIONS,
      deviceId: 'rear',
      warmupMs: 0,
      video: camera.video,
    });

    const preferred = {
      deviceId: { exact: 'rear' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    };
    expect(report.camera).toMatchObject({
      requested: preferred,
      failedAttempts: [
        { requested: preferred, error: 'NotReadableError: Could not start video source' },
      ],
    });
    expect(report.timing).toMatchObject({ completed: true });
  });

  it('stops measuring and releases the camera when aborted', async () => {
    const stop = new AbortController();
    const camera = fakeCamera({
      onFrame: (count) => {
        if (count === 10) {
          stop.abort();
        }
      },
    });

    const report = await runProbe(camera.scope, {
      ...OPTIONS,
      seconds: 60,
      warmupMs: 0,
      video: camera.video,
      signal: stop.signal,
    });

    expect(report.timing).toEqual({ skipped: 'stopped' });
    expect(camera.stoppedTracks()).toBe(1);
  });
});

describe('listCameras', () => {
  it('asks for the camera when the labels are hidden, then lists the video inputs', async () => {
    const camera = fakeCamera({ hiddenLabels: true });

    const list = await listCameras(camera.scope);

    expect(list).toEqual({
      videoInputs: [
        { deviceId: 'front', label: 'Front camera', groupId: 'g-front' },
        { deviceId: 'rear', label: 'Rear camera', groupId: 'g-rear' },
      ],
    });
    expect(camera.requests).toEqual([{ video: true, audio: false }]);
    expect(camera.stoppedTracks()).toBe(1);
  });

  it('says so when there is no camera API', async () => {
    expect(await listCameras({ navigator: {} })).toEqual({ missing: 'navigator.mediaDevices' });
  });
});

describe('parseWindowSeconds', () => {
  it('accepts 1 to 60 seconds and falls back to the default otherwise', () => {
    expect(parseWindowSeconds('2')).toBe(2);
    expect(parseWindowSeconds('1.5')).toBe(1.5);
    expect(parseWindowSeconds('60')).toBe(60);
    for (const wrong of [null, '', ' ', '0', '0.5', '61', 'ten', 'Infinity']) {
      expect(parseWindowSeconds(wrong)).toBe(DEFAULT_WINDOW_SECONDS);
    }
  });
});

interface FakeCameraOptions {
  /** The first getUserMedia call fails with an OverconstrainedError. */
  readonly rejectFirst?: boolean;
  /** The first getUserMedia call fails with a NotReadableError (camera busy). */
  readonly busyFirst?: boolean;
  /** Labels and ids are empty until getUserMedia has been called once. */
  readonly hiddenLabels?: boolean;
  /** Called with the number of each frame callback. */
  readonly onFrame?: (count: number) => void;
}

/**
 * A scope with two cameras and a video element that plays 30 fps frames on a fake clock. The
 * 20th callback comes after a frame the camera dropped, the 40th after a frame the callbacks
 * missed; every frame reaches the callback 5 ms after it reached the browser.
 */
function fakeCamera(options: FakeCameraOptions = {}) {
  let clock = 0;
  let stopped = 0;
  let permitted = options.hiddenLabels !== true;
  const requests: unknown[] = [];
  const track = {
    label: 'Rear camera',
    stop: () => {
      stopped += 1;
    },
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
    getCapabilities: () => ({ frameRate: { min: 1, max: 30 } }),
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const device = (kind: string, deviceId: string, label: string, groupId: string) =>
    permitted ? { kind, deviceId, label, groupId } : { kind, deviceId: '', label: '', groupId: '' };
  const mediaDevices = {
    enumerateDevices: () =>
      Promise.resolve([
        device('audioinput', 'mic', 'Microphone', 'g-front'),
        device('videoinput', 'front', 'Front camera', 'g-front'),
        device('videoinput', 'rear', 'Rear camera', 'g-rear'),
      ]),
    getUserMedia: (constraints: unknown) => {
      requests.push(constraints);
      permitted = true;
      if (options.rejectFirst === true && requests.length === 1) {
        const error = Object.assign(new Error(''), {
          name: 'OverconstrainedError',
          constraint: 'frameRate',
        });
        return Promise.reject(error);
      }
      if (options.busyFirst === true && requests.length === 1) {
        return Promise.reject(new DOMException('Could not start video source', 'NotReadableError'));
      }
      return Promise.resolve(stream);
    },
  };

  let handles = 0;
  let callbacks = 0;
  let frame = 0;
  let presented = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const fake = {
    muted: false,
    playsInline: false,
    srcObject: null as unknown,
    play: () => Promise.resolve(),
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback): number => {
      handles += 1;
      const handle = handles;
      timers.set(
        handle,
        setTimeout(() => {
          timers.delete(handle);
          callbacks += 1;
          const skipped = callbacks === 20 || callbacks === 40 ? 1 : 0;
          frame += 1 + skipped;
          presented += callbacks === 40 ? 2 : 1;
          const captureTime = frame * (1000 / 30);
          clock = captureTime + 5;
          options.onFrame?.(callbacks);
          callback(clock, {
            captureTime,
            expectedDisplayTime: clock + 16,
            presentationTime: clock,
            mediaTime: frame / 30,
            presentedFrames: presented,
            width: 1920,
            height: 1080,
          });
        }, 0),
      );
      return handle;
    },
    cancelVideoFrameCallback: (handle: number) => {
      clearTimeout(timers.get(handle));
      timers.delete(handle);
    },
    getVideoPlaybackQuality: () => ({ totalVideoFrames: presented, droppedVideoFrames: 0 }),
  };

  return {
    scope: { navigator: { mediaDevices }, performance: { now: () => clock } },
    video: fake as unknown as HTMLVideoElement,
    requests,
    stoppedTracks: () => stopped,
  };
}
