// Fakes of the browser APIs behind the device services, for unit tests (provide them through
// BROWSER_GLOBALS). Nothing in the app imports this file, so it is not in the bundle.

/** A screen wake lock that the fake browser, or the test, can release. */
export class FakeWakeLockSentinel extends EventTarget implements WakeLockSentinel {
  readonly type = 'screen';
  released = false;
  onrelease: WakeLockSentinel['onrelease'] = null;

  release(): Promise<void> {
    if (!this.released) {
      this.released = true;
      this.dispatchEvent(new Event('release'));
    }
    return Promise.resolve();
  }
}

/** `navigator.wakeLock`: grants every request, or refuses with `refuseWith` when it is set. */
export class FakeWakeLock implements WakeLock {
  readonly sentinels: FakeWakeLockSentinel[] = [];
  refuseWith: Error | null = null;

  request(): Promise<WakeLockSentinel> {
    if (this.refuseWith) {
      return Promise.reject(this.refuseWith);
    }
    const sentinel = new FakeWakeLockSentinel();
    this.sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  }

  /** How many locks are held now. */
  held(): number {
    return this.sentinels.filter((sentinel) => !sentinel.released).length;
  }
}

/** `navigator.storage`: `persist()` answers `grant`; `estimate()` reports `usage` and `quota`. */
export class FakeStorageManager implements StorageManager {
  persistent: boolean;
  grant: boolean;
  usage: number;
  quota: number;
  persistCalls = 0;

  constructor(options: { persistent?: boolean; grant?: boolean; usage?: number; quota?: number }) {
    this.persistent = options.persistent ?? false;
    this.grant = options.grant ?? false;
    this.usage = options.usage ?? 0;
    this.quota = options.quota ?? 1e9;
  }

  persisted(): Promise<boolean> {
    return Promise.resolve(this.persistent);
  }

  persist(): Promise<boolean> {
    this.persistCalls++;
    this.persistent ||= this.grant;
    return Promise.resolve(this.persistent);
  }

  estimate(): Promise<StorageEstimate> {
    return Promise.resolve({ usage: this.usage, quota: this.quota });
  }

  getDirectory(): Promise<FileSystemDirectoryHandle> {
    return Promise.reject(new Error('FakeStorageManager has no file system.'));
  }
}

/** Stands in for the `VideoEncoder` constructor, whose presence means WebCodecs is there. */
export class FakeVideoEncoder {
  readonly state = 'unconfigured';
}

/** `localStorage`: an in-memory store; while `failWith` is set, every write throws it. */
export class FakeLocalStorage implements Storage {
  [name: string]: unknown;
  private readonly items = new Map<string, string>();
  failWith: Error | null = null;

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWith) {
      throw this.failWith;
    }
    this.items.set(key, value);
  }
}

/** `navigator.clipboard`, for text: keeps what was written, or refuses with `refuseWith`. */
export class FakeClipboard extends EventTarget implements Clipboard {
  readonly texts: string[] = [];
  refuseWith: Error | null = null;

  read(): Promise<ClipboardItems> {
    return Promise.reject(new Error('FakeClipboard holds text only.'));
  }

  readText(): Promise<string> {
    return Promise.resolve(this.texts.at(-1) ?? '');
  }

  write(): Promise<void> {
    return Promise.reject(new Error('FakeClipboard holds text only.'));
  }

  writeText(text: string): Promise<void> {
    if (this.refuseWith) {
      return Promise.reject(this.refuseWith);
    }
    this.texts.push(text);
    return Promise.resolve();
  }
}

/**
 * `fetch` over a table of URL → JSON body; any other URL answers 404, and `failWith`, when set,
 * makes every request reject (the network is down). `requests` lists the URLs asked for.
 */
export class FakeFetch {
  readonly requests: string[] = [];
  failWith: Error | null = null;

  constructor(private readonly files: Readonly<Record<string, unknown>>) {}

  readonly fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    this.requests.push(url);
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    if (!(url in this.files)) {
      return Promise.resolve(new Response('Not found', { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(this.files[url]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

/**
 * jsdom's `<dialog>` has no `showModal()` or `close()`. These stand-ins do what the tests need:
 * `showModal()` sets `open`; `close()` removes it and fires `close`, as a browser does after a
 * dialog closes (a browser fires it a task later).
 */
export function polyfillDialog(): void {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      if (this.hasAttribute('open')) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      }
    },
  });
}

/**
 * `performance` for the host clock: `timeOrigin` plus the milliseconds that the test has advanced.
 * `hostMs` is the value the app reads as its host time.
 */
export class FakePerformance {
  readonly timeOrigin: number;
  private elapsed = 0;

  constructor(timeOrigin = 1_790_000_000_000) {
    this.timeOrigin = timeOrigin;
  }

  readonly now = (): number => this.elapsed;

  /** The host time now: `timeOrigin + now()`. */
  get hostMs(): number {
    return this.timeOrigin + this.elapsed;
  }

  advance(ms: number): void {
    this.elapsed += ms;
  }
}

/**
 * `setTimeout` and `clearTimeout` on the test's host clock: `advance()` moves the clock (a
 * {@link FakePerformance}) forward and runs each timer that comes due, at its own time, in the
 * order of their times (and of their creation, for equal times). The clock can also be moved
 * without the timers, with the `FakePerformance`'s own `advance()`: they then run at the next
 * `advance()` here.
 */
export class FakeTimers {
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(private readonly clock: FakePerformance) {}

  readonly setTimeout = (callback: () => void, ms = 0): number => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.clock.now() + Math.max(0, ms), callback });
    return handle;
  };

  readonly clearTimeout = (handle: number): void => {
    this.timers.delete(handle);
  };

  /** How many timers wait. */
  get pending(): number {
    return this.timers.size;
  }

  /** Moves the clock `ms` forward, running the timers that come due on the way. */
  advance(ms: number): void {
    const end = this.clock.now() + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (next === null) {
        break;
      }
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.clock.advance(Math.max(0, timer.at - this.clock.now()));
      timer.callback();
    }
    this.clock.advance(Math.max(0, end - this.clock.now()));
  }
}

/**
 * `document`'s visibility: `visibilityState`, which `setVisibility()` changes, firing
 * `visibilitychange` as a browser does when the tab is hidden or shown again.
 */
export class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** `requestAnimationFrame`: callbacks wait until the test runs a frame with `frame()`. */
export class FakeAnimationFrames {
  private nextHandle = 1;
  private readonly pending = new Map<number, FrameRequestCallback>();

  readonly request = (callback: FrameRequestCallback): number => {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return handle;
  };

  readonly cancel = (handle: number): void => {
    this.pending.delete(handle);
  };

  /** How many callbacks wait for the next frame. */
  get waiting(): number {
    return this.pending.size;
  }

  /** Runs the callbacks requested before this frame (those they request wait for the next). */
  frame(timestamp = 0): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) {
      callback(timestamp);
    }
  }
}

/** Lets pending promises and timers run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A camera of {@link FakeMediaDevices}: what its track reports. */
export interface FakeCamera {
  readonly deviceId: string;
  readonly label: string;
  /** `getSettings()`; `deviceId` is added. Image Capture keys such as `exposureMode` included. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** `getCapabilities()`: ranges as `{min, max, step}`, modes as lists. */
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/** A camera like Chrome's fake one (`--use-fake-device-for-media-stream`), 20 fps, manual exposure and focus. */
export const FAKE_WEBCAM: FakeCamera = {
  deviceId: 'fake-webcam',
  label: 'fake_device_0',
  settings: {
    width: 1920,
    height: 1080,
    frameRate: 20,
    aspectRatio: 1920 / 1080,
    resizeMode: 'none',
    exposureMode: 'manual',
    exposureTime: 50,
    focusMode: 'manual',
    focusDistance: 50,
  },
  capabilities: {
    width: { min: 1, max: 3840 },
    height: { min: 1, max: 2160 },
    frameRate: { min: 0, max: 20 },
    facingMode: [],
    resizeMode: ['none', 'crop-and-scale'],
    exposureMode: ['manual', 'continuous'],
    exposureTime: { min: 10, max: 100, step: 5 },
    focusMode: ['manual', 'continuous'],
    focusDistance: { min: 10, max: 100, step: 5 },
  },
};

/** A laptop camera without any control (the MacBook's FaceTime camera, docs/devices/). */
export const FAKE_FACETIME: FakeCamera = {
  deviceId: 'facetime',
  label: 'FaceTime HD Camera (3A71:F4B5)',
  settings: { width: 1920, height: 1080, frameRate: 30, aspectRatio: 1920 / 1080 },
  capabilities: {
    width: { min: 1, max: 1920 },
    height: { min: 1, max: 1920 },
    frameRate: { min: 0, max: 30 },
    facingMode: [],
  },
};

/** The ThinkPhone's rear camera, as probed (docs/devices/): every control and a torch. */
export const FAKE_PHONE_REAR: FakeCamera = {
  deviceId: 'phone-rear',
  label: 'camera 0, facing back',
  settings: {
    width: 1080,
    height: 1920,
    frameRate: 60,
    facingMode: 'environment',
    exposureMode: 'continuous',
    exposureTime: 48.77393,
    iso: 100,
    focusMode: 'continuous',
    focusDistance: 0.1,
    whiteBalanceMode: 'continuous',
    colorTemperature: 0,
    zoom: 1,
    torch: false,
  },
  capabilities: {
    width: { min: 1, max: 4096 },
    height: { min: 1, max: 3072 },
    frameRate: { min: 0, max: 60 },
    facingMode: ['environment'],
    exposureMode: ['continuous', 'manual'],
    exposureTime: { min: 0.832, max: 2880, step: 0.1 },
    iso: { min: 100, max: 1594, step: 1 },
    focusMode: ['manual', 'single-shot', 'continuous'],
    focusDistance: { min: 0.1, max: 8.156, step: 0.01 },
    whiteBalanceMode: ['continuous', 'manual'],
    colorTemperature: { min: 2850, max: 7000, step: 50 },
    zoom: { min: 1, max: 8, step: 0.1 },
    torch: true,
  },
};

/** The ThinkPhone's front camera: its focus lists only "manual" (docs/devices/). */
export const FAKE_PHONE_FRONT: FakeCamera = {
  deviceId: 'phone-front',
  label: 'camera 1, facing front',
  settings: {
    width: 1920,
    height: 1080,
    frameRate: 60,
    facingMode: 'user',
    exposureMode: 'continuous',
    exposureTime: 309.245,
    iso: 100,
    focusMode: 'continuous',
    focusDistance: 0.331,
    whiteBalanceMode: 'continuous',
    colorTemperature: 0,
    zoom: 1,
  },
  capabilities: {
    width: { min: 1, max: 3264 },
    height: { min: 1, max: 2448 },
    frameRate: { min: 0, max: 60 },
    facingMode: ['user'],
    exposureMode: ['continuous', 'manual'],
    exposureTime: { min: 0.5, max: 2501.6, step: 0.1 },
    iso: { min: 100, max: 1594, step: 1 },
    focusMode: ['manual'],
    focusDistance: { min: 0, max: 3.19, step: 0.01 },
    whiteBalanceMode: ['continuous', 'manual'],
    colorTemperature: { min: 2850, max: 7000, step: 50 },
    zoom: { min: 1, max: 8, step: 0.1 },
  },
};

let fakeTrackCount = 0;

/**
 * A camera's video track. Its settings start as the camera's; `applyConstraints` applies each
 * advanced set it can satisfy (modes the camera lists, numbers in range, the torch where there is
 * one), skipping the others as Chrome does, and records the constraints; `refuseWith` makes it
 * reject. `end()` is the camera going away: `readyState` ended and an `ended` event.
 */
export class FakeVideoTrack extends EventTarget implements MediaStreamTrack {
  contentHint = '';
  enabled = true;
  readonly id = `fake-track-${String(++fakeTrackCount)}`;
  readonly kind = 'video';
  readonly label: string;
  readonly muted = false;
  onended: MediaStreamTrack['onended'] = null;
  onmute: MediaStreamTrack['onmute'] = null;
  onunmute: MediaStreamTrack['onunmute'] = null;
  readyState: MediaStreamTrackState = 'live';
  readonly applied: MediaTrackConstraints[] = [];
  refuseWith: Error | null = null;
  /** Modes the camera does not go back to by a constraint, as `focusMode: continuous` on some. */
  sticky: readonly string[] = [];
  private settings: Record<string, unknown>;
  private constraints: MediaTrackConstraints;

  constructor(
    readonly camera: FakeCamera,
    constraints: MediaTrackConstraints = {},
  ) {
    super();
    this.label = camera.label;
    this.settings = { ...camera.settings, deviceId: camera.deviceId };
    this.constraints = constraints;
  }

  applyConstraints(constraints: MediaTrackConstraints = {}): Promise<void> {
    this.applied.push(constraints);
    if (this.refuseWith) {
      return Promise.reject(this.refuseWith);
    }
    this.constraints = constraints;
    for (const set of constraints.advanced ?? []) {
      const entries = Object.entries(set) as [string, unknown][];
      if (entries.every(([key, value]) => this.satisfies(key, value))) {
        Object.assign(this.settings, Object.fromEntries(entries));
      }
    }
    return Promise.resolve();
  }

  clone(): MediaStreamTrack {
    return new FakeVideoTrack(this.camera, this.constraints);
  }

  getCapabilities(): MediaTrackCapabilities {
    return structuredClone(this.camera.capabilities);
  }

  getConstraints(): MediaTrackConstraints {
    return this.constraints;
  }

  getSettings(): MediaTrackSettings {
    return { ...this.settings };
  }

  stop(): void {
    this.readyState = 'ended';
  }

  /** The camera goes away (unplugged, or taken by another app). */
  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }

  private satisfies(key: string, value: unknown): boolean {
    const capability = this.camera.capabilities[key];
    if (key === 'torch') {
      return capability === true && typeof value === 'boolean';
    }
    if (Array.isArray(capability)) {
      return (capability as unknown[]).includes(value) && !this.sticky.includes(String(value));
    }
    const min = (capability as { min?: unknown } | undefined)?.min;
    const max = (capability as { max?: unknown } | undefined)?.max;
    return (
      typeof value === 'number' &&
      typeof min === 'number' &&
      typeof max === 'number' &&
      value >= min &&
      value <= max
    );
  }
}

/** A microphone's audio track (for the recording's audio, T2.4); `stop()` ends it. */
export class FakeAudioTrack extends EventTarget implements MediaStreamTrack {
  contentHint = '';
  enabled = true;
  readonly id = `fake-audio-${String(++fakeTrackCount)}`;
  readonly kind = 'audio';
  readonly label = 'Fake microphone';
  readonly muted = false;
  onended: MediaStreamTrack['onended'] = null;
  onmute: MediaStreamTrack['onmute'] = null;
  onunmute: MediaStreamTrack['onunmute'] = null;
  readyState: MediaStreamTrackState = 'live';

  applyConstraints(): Promise<void> {
    return Promise.resolve();
  }

  clone(): MediaStreamTrack {
    return new FakeAudioTrack();
  }

  getCapabilities(): MediaTrackCapabilities {
    return {};
  }

  getConstraints(): MediaTrackConstraints {
    return {};
  }

  getSettings(): MediaTrackSettings {
    return { sampleRate: 48_000, channelCount: 1 };
  }

  stop(): void {
    this.readyState = 'ended';
  }
}

/** A `MediaStream` of fake tracks. */
export class FakeMediaStream extends EventTarget implements MediaStream {
  readonly id = `fake-stream-${String(++fakeTrackCount)}`;
  onaddtrack: MediaStream['onaddtrack'] = null;
  onremovetrack: MediaStream['onremovetrack'] = null;
  private readonly tracks: MediaStreamTrack[];

  constructor(tracks: readonly MediaStreamTrack[]) {
    super();
    this.tracks = [...tracks];
  }

  get active(): boolean {
    return this.tracks.some((track) => track.readyState === 'live');
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }

  clone(): MediaStream {
    return new FakeMediaStream(this.tracks.map((track) => track.clone()));
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getTrackById(trackId: string): MediaStreamTrack | null {
    return this.tracks.find((track) => track.id === trackId) ?? null;
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'video');
  }

  removeTrack(track: MediaStreamTrack): void {
    const index = this.tracks.indexOf(track);
    if (index >= 0) {
      this.tracks.splice(index, 1);
    }
  }
}

/** An error as `getUserMedia` rejects with: a DOMException `name`, and the constraint at fault. */
export function mediaError(name: string, message = '', constraint?: string): DOMException {
  const error = new DOMException(message, name);
  if (constraint !== undefined) {
    Object.defineProperty(error, 'constraint', { value: constraint });
  }
  return error;
}

/**
 * `navigator.mediaDevices` over a list of fake cameras. Until a `getUserMedia` succeeds (or while
 * `granted` is false), `enumerateDevices` hides the cameras' ids and labels, as Chrome does before
 * the permission. `getUserMedia` fails with the errors queued in `failures` first, one per call; then
 * it opens the camera that `deviceId: {exact}` names (an unknown id: an OverconstrainedError on
 * deviceId) or the first, refusing `frameRate: {exact}` above the camera's rate (an
 * OverconstrainedError on frameRate). `hold` makes it wait (a permission prompt) until `release()`.
 * An audio-only request (`{audio: true}`, the recording's microphone) opens the microphone, or fails
 * with the errors queued in `microphoneFailures`, or as without one when `microphone` is false.
 */
export class FakeMediaDevices extends EventTarget implements MediaDevices {
  ondevicechange: MediaDevices['ondevicechange'] = null;
  granted = false;
  readonly failures: unknown[] = [];
  readonly requests: MediaStreamConstraints[] = [];
  readonly tracks: FakeVideoTrack[] = [];
  /** This device has a microphone. */
  microphone = true;
  readonly microphoneFailures: unknown[] = [];
  readonly audioTracks: FakeAudioTrack[] = [];
  private held: (() => void)[] | null = null;

  constructor(public cameras: readonly FakeCamera[]) {
    super();
  }

  enumerateDevices(): Promise<MediaDeviceInfo[]> {
    const hidden = !this.granted;
    return Promise.resolve(
      (hidden ? this.cameras.slice(0, 1) : this.cameras).map((camera) => ({
        deviceId: hidden ? '' : camera.deviceId,
        groupId: '',
        kind: 'videoinput' as const,
        label: hidden ? '' : camera.label,
        toJSON(): unknown {
          return { ...this };
        },
      })),
    );
  }

  getDisplayMedia(): Promise<MediaStream> {
    return Promise.reject(mediaError('NotSupportedError'));
  }

  getSupportedConstraints(): MediaTrackSupportedConstraints {
    return {};
  }

  async getUserMedia(constraints: MediaStreamConstraints = {}): Promise<MediaStream> {
    this.requests.push(constraints);
    if (this.held !== null) {
      await new Promise<void>((resolve) => {
        this.held?.push(resolve);
      });
    }
    if (constraints.video === undefined && constraints.audio !== undefined) {
      if (this.microphoneFailures.length > 0) {
        throw this.microphoneFailures.shift();
      }
      if (!this.microphone) {
        throw mediaError('NotFoundError', 'Requested device not found');
      }
      const track = new FakeAudioTrack();
      this.audioTracks.push(track);
      return new FakeMediaStream([track]);
    }
    if (this.failures.length > 0) {
      throw this.failures.shift();
    }
    const video = typeof constraints.video === 'object' ? constraints.video : {};
    const wanted = video.deviceId;
    const exactId = typeof wanted === 'object' && !Array.isArray(wanted) ? wanted.exact : undefined;
    const camera =
      exactId === undefined
        ? this.cameras.at(0)
        : this.cameras.find((candidate) => candidate.deviceId === exactId);
    if (camera === undefined) {
      throw exactId === undefined
        ? mediaError('NotFoundError', 'Requested device not found')
        : mediaError('OverconstrainedError', '', 'deviceId');
    }
    const rate = video.frameRate;
    const exactRate = typeof rate === 'object' ? rate.exact : undefined;
    const maxRate = (camera.capabilities['frameRate'] as { max?: number } | undefined)?.max;
    if (exactRate !== undefined && maxRate !== undefined && exactRate > maxRate) {
      throw mediaError('OverconstrainedError', '', 'frameRate');
    }
    this.granted = true;
    const track = new FakeVideoTrack(camera, video);
    this.tracks.push(track);
    return new FakeMediaStream([track]);
  }

  /** Makes `getUserMedia` wait, as for a permission prompt, until `release()`. */
  hold(): void {
    this.held ??= [];
  }

  release(): void {
    const waiting = this.held ?? [];
    this.held = null;
    for (const resolve of waiting) {
      resolve();
    }
  }

  /** Plugs in or unplugs cameras: `devicechange`. */
  setCameras(cameras: readonly FakeCamera[]): void {
    this.cameras = cameras;
    this.dispatchEvent(new Event('devicechange'));
  }

  /** The tracks that are still live. */
  liveTracks(): FakeVideoTrack[] {
    return this.tracks.filter((track) => track.readyState === 'live');
  }
}

/**
 * The `<video>`'s `requestVideoFrameCallback` for tests: `present()` runs the callbacks waiting
 * for the next frame with its metadata. Install it on a `<video>` with `install()`.
 */
export class FakeVideoFrames {
  private next = 1;
  private readonly pending = new Map<number, VideoFrameRequestCallback>();
  private presented = 0;

  readonly requestVideoFrameCallback = (callback: VideoFrameRequestCallback): number => {
    const handle = this.next++;
    this.pending.set(handle, callback);
    return handle;
  };

  readonly cancelVideoFrameCallback = (handle: number): void => {
    this.pending.delete(handle);
  };

  /** How many callbacks wait for the next frame. */
  get waiting(): number {
    return this.pending.size;
  }

  /** Gives `video` this requestVideoFrameCallback, and a frame size. */
  install(video: HTMLVideoElement, width = 1920, height = 1080): void {
    Object.assign(video, {
      requestVideoFrameCallback: this.requestVideoFrameCallback,
      cancelVideoFrameCallback: this.cancelVideoFrameCallback,
    });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
  }

  /** Presents `count` frames `intervalMs` apart on the camera's clock, `width` × `height`. */
  present(count = 1, intervalMs = 50, width = 1920, height = 1080): void {
    for (let i = 0; i < count; i++) {
      this.presented++;
      const metadata: VideoFrameCallbackMetadata = {
        mediaTime: (this.presented * intervalMs) / 1000,
        presentedFrames: this.presented,
        width,
        height,
        expectedDisplayTime: 0,
        presentationTime: 0,
      };
      const callbacks = [...this.pending.values()];
      this.pending.clear();
      for (const callback of callbacks) {
        callback(this.presented * intervalMs, metadata);
      }
    }
  }
}
