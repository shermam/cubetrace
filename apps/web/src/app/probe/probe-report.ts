import { analyzeFrames, type FrameSample, type FrameTiming } from './frame-timing';
import {
  describeError,
  guard,
  guardSync,
  invoke,
  isBoolean,
  isNumber,
  isObject,
  isString,
  member,
  read,
  toJson,
  toJsonObject,
  withTimeout,
} from './probe-guards';
import { isAbsent, type JsonObject, type JsonValue, type Probed } from './probe-types';

/**
 * The device probe (docs/PLAN.md, T1.8): what this browser can do with its cameras, video
 * encoders, storage and Bluetooth, as one JSON report for docs/DEVICES.md.
 *
 * Plain TypeScript, no Angular. The global scope is a parameter and every API is read from it
 * as `unknown` and checked before use, so a browser without an API gets a `{ missing }` value
 * and an API that throws gets an `{ error }` value; `runProbe` itself never throws. Unit tests
 * hand it a scope without any of the APIs.
 */

/** The global scope the probe reads: `window` in the app, a partial fake in unit tests. */
export type ProbeScope = object;

/** Length of the frame-timing measurement unless `?seconds=` says otherwise. */
export const DEFAULT_WINDOW_SECONDS = 10;

/** Frames of the first second are left out of the timing: exposure and pipeline settle. */
export const WARMUP_MS = 1000;

/** The camera permission prompt waits for a person. */
const PERMISSION_TIMEOUT_MS = 120_000;
/** Opening a camera takes a few seconds on some phones. */
const OPEN_TIMEOUT_MS = 15_000;
/** The measurement ends early when no frame arrives for this long (hidden tab, stalled camera). */
const STALL_MS = 3000;
/** A camera that was open a moment ago (for the permission) may still be closing: retry once. */
const BUSY_ERRORS: readonly string[] = ['NotReadableError', 'AbortError'];
const BUSY_RETRY_MS = 500;

const HIGH_ENTROPY_HINTS = [
  'platform',
  'platformVersion',
  'model',
  'architecture',
  'bitness',
  'fullVersionList',
];

/** H.264 High and Main profiles, level 4.0, at 1080p30 and 1080p60, platform encoder or any. */
const ENCODER_CONFIGS = ['avc1.640028', 'avc1.4d0028'].flatMap((codec) =>
  [30, 60].flatMap((framerate) =>
    (['prefer-hardware', 'no-preference'] as const).map((hardwareAcceleration) => ({
      codec,
      width: 1920,
      height: 1080,
      framerate,
      hardwareAcceleration,
    })),
  ),
);

/** The inline worker: reports which capture APIs exist inside a dedicated worker. */
const WORKER_SOURCE = `postMessage({
  MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor === 'function',
  VideoEncoder: typeof VideoEncoder === 'function',
});`;

export interface ProbeReport {
  /** ISO 8601, when the probe finished. */
  readonly generatedAt: string;
  /** Typed by the owner, e.g. "thinkphone-rear". */
  readonly label: string;
  readonly device: Probed<DeviceSection>;
  readonly camera: Probed<CameraSection>;
  /** `MediaStreamTrack.getCapabilities()`, every key, raw. */
  readonly capabilities: Probed<JsonObject>;
  /** `MediaStreamTrack.getSettings()`, every key, raw. */
  readonly settings: Probed<JsonObject>;
  readonly timing: Probed<TimingSection>;
  readonly encoders: Probed<EncodersSection>;
  readonly worker: Probed<WorkerSection>;
  readonly storage: Probed<StorageSection>;
  readonly bluetooth: Probed<BluetoothSection>;
  readonly hints: Probed<HintsSection>;
}

export type SectionKey = Exclude<keyof ProbeReport, 'generatedAt' | 'label'>;

/** The sections known so far while the probe runs. */
export type PartialReport = Partial<Pick<ProbeReport, SectionKey>>;

export interface DeviceSection {
  readonly screen: Probed<ScreenInfo>;
  readonly devicePixelRatio: Probed<number>;
  readonly hardwareConcurrency: Probed<number>;
  readonly deviceMemory: Probed<number>;
  readonly secureContext: Probed<boolean>;
}

export interface ScreenInfo {
  readonly width: Probed<number>;
  readonly height: Probed<number>;
  readonly availWidth: Probed<number>;
  readonly availHeight: Probed<number>;
  readonly colorDepth: Probed<number>;
  readonly orientation: Probed<string>;
}

export interface VideoInput {
  readonly deviceId: string;
  readonly label: string;
  readonly groupId: string;
}

export interface CameraList {
  readonly videoInputs: readonly VideoInput[];
}

export interface CameraSection extends CameraList {
  readonly selected: Probed<VideoInput>;
  /** The video constraints that opened the camera: the first rung of the ladder that worked. */
  readonly requested: Probed<JsonValue>;
  /** Earlier rungs that failed, with their errors. */
  readonly failedAttempts: readonly FailedAttempt[];
  readonly trackLabel: Probed<string>;
}

export interface FailedAttempt {
  readonly requested: JsonValue;
  readonly error: string;
}

export interface TimingSection extends FrameTiming {
  readonly warmupMs: number;
  readonly windowMs: number;
  /** False when frames stopped before the window ended (a hidden tab, a stalled camera). */
  readonly completed: boolean;
  /** `getVideoPlaybackQuality()` counters over the window. */
  readonly playbackQuality: Probed<PlaybackQuality>;
}

export interface PlaybackQuality {
  readonly totalVideoFrames: number;
  readonly droppedVideoFrames: number;
}

export interface EncoderCheck {
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly hardwareAcceleration: HardwareAcceleration;
  readonly supported: Probed<boolean>;
}

export interface EncodersSection {
  readonly results: readonly EncoderCheck[];
}

export interface ApiPresence {
  readonly MediaStreamTrackProcessor: boolean;
  readonly VideoEncoder: boolean;
}

export interface WorkerSection {
  readonly inWorker: Probed<ApiPresence>;
  /** For comparison: the capture pipeline creates the track processor on the main thread. */
  readonly onMainThread: Probed<ApiPresence>;
}

export interface StorageSection {
  readonly estimate: Probed<JsonObject>;
  readonly persisted: Probed<boolean>;
}

export interface BluetoothSection {
  readonly navigatorBluetooth: boolean;
  readonly getDevices: boolean;
  readonly watchAdvertisements: boolean;
  /** `navigator.bluetooth.getAvailability()`: whether a Bluetooth adapter is there. */
  readonly availability: Probed<boolean>;
}

export interface HintsSection {
  readonly userAgent: Probed<string>;
  /** `navigator.userAgentData.getHighEntropyValues(...)`, raw. */
  readonly userAgentData: Probed<JsonObject>;
}

export interface ProbeOptions {
  readonly label: string;
  /** The camera to measure; the first video input when absent or unknown. */
  readonly deviceId?: string;
  /** Length of the frame-timing measurement. */
  readonly seconds: number;
  readonly warmupMs?: number;
  /** The element the camera plays in; its `requestVideoFrameCallback` does the measuring. */
  readonly video?: HTMLVideoElement;
  /** Aborting ends the measurement early and releases the camera. */
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** Called as the steps finish, with a status line and the sections known so far. */
  readonly onProgress?: (status: string, sections: PartialReport) => void;
}

/** Runs every step and assembles the report. Never throws. */
export async function runProbe(scope: ProbeScope, options: ProbeOptions): Promise<ProbeReport> {
  let known: PartialReport = {};
  const show = (status: string, sections: PartialReport): void => {
    known = { ...known, ...sections };
    try {
      options.onProgress?.(status, known);
    } catch {
      // A failing progress display must not stop the probe.
    }
  };

  const device = guardSync(() => probeDevice(scope));
  const hints = await guard(() => probeHints(scope));
  const bluetooth = await guard(() => probeBluetooth(scope));
  const storage = await guard(() => probeStorage(scope));
  show('Checking the video encoders…', { device, hints, bluetooth, storage });
  const encoders = await guard(() => probeEncoders(scope));
  show('Starting a worker…', { encoders });
  const worker = await guard(() => probeWorker(scope));
  show('Asking for the camera…', { worker });
  const camera = await probeCamera(scope, options, show).catch((error: unknown): CameraSections => {
    const skipped = { skipped: 'the camera step failed' };
    return {
      camera: { error: describeError(error) },
      capabilities: skipped,
      settings: skipped,
      timing: skipped,
    };
  });

  return {
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    label: options.label.trim(),
    device,
    camera: camera.camera,
    capabilities: camera.capabilities,
    settings: camera.settings,
    timing: camera.timing,
    encoders,
    worker,
    storage,
    bluetooth,
    hints,
  };
}

/** Asks for the camera permission when needed and lists the video inputs with their labels. */
export async function listCameras(scope: ProbeScope): Promise<Probed<CameraList>> {
  return guard(async () => {
    const devices = mediaDevicesOf(scope);
    return isAbsent(devices) ? devices : { videoInputs: await listVideoInputs(devices) };
  });
}

/** The `?seconds=` query parameter: 1 to 60 seconds, the default otherwise. */
export function parseWindowSeconds(parameter: string | null): number {
  const seconds = parameter === null || parameter.trim() === '' ? Number.NaN : Number(parameter);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 60
    ? seconds
    : DEFAULT_WINDOW_SECONDS;
}

// --- Steps ---------------------------------------------------------------------------------

function probeDevice(scope: ProbeScope): DeviceSection {
  const nav = member(scope, 'navigator');
  const screen = member(scope, 'screen');
  return {
    screen: isObject(screen)
      ? {
          width: read(() => member(screen, 'width'), isNumber, 'screen.width'),
          height: read(() => member(screen, 'height'), isNumber, 'screen.height'),
          availWidth: read(() => member(screen, 'availWidth'), isNumber, 'screen.availWidth'),
          availHeight: read(() => member(screen, 'availHeight'), isNumber, 'screen.availHeight'),
          colorDepth: read(() => member(screen, 'colorDepth'), isNumber, 'screen.colorDepth'),
          orientation: read(
            () => member(member(screen, 'orientation'), 'type'),
            isString,
            'screen.orientation',
          ),
        }
      : { missing: 'screen' },
    devicePixelRatio: read(() => member(scope, 'devicePixelRatio'), isNumber, 'devicePixelRatio'),
    hardwareConcurrency: read(
      () => member(nav, 'hardwareConcurrency'),
      isNumber,
      'navigator.hardwareConcurrency',
    ),
    deviceMemory: read(() => member(nav, 'deviceMemory'), isNumber, 'navigator.deviceMemory'),
    secureContext: read(() => member(scope, 'isSecureContext'), isBoolean, 'isSecureContext'),
  };
}

async function probeHints(scope: ProbeScope): Promise<HintsSection> {
  const nav = member(scope, 'navigator');
  return {
    userAgent: read(() => member(nav, 'userAgent'), isString, 'navigator.userAgent'),
    userAgentData: await guard(async () => {
      const data = member(nav, 'userAgentData');
      if (!isObject(data)) {
        return { missing: 'navigator.userAgentData' };
      }
      const call = invoke(data, 'getHighEntropyValues', [HIGH_ENTROPY_HINTS]);
      if (!call) {
        return { missing: 'navigator.userAgentData.getHighEntropyValues' };
      }
      return toJsonObject(await withTimeout(call.result, 'getHighEntropyValues()'));
    }),
  };
}

async function probeBluetooth(scope: ProbeScope): Promise<BluetoothSection> {
  const bluetooth = member(member(scope, 'navigator'), 'bluetooth');
  const present = isObject(bluetooth);
  const devicePrototype = member(member(scope, 'BluetoothDevice'), 'prototype');
  return {
    navigatorBluetooth: present,
    getDevices: present && typeof member(bluetooth, 'getDevices') === 'function',
    watchAdvertisements: typeof member(devicePrototype, 'watchAdvertisements') === 'function',
    availability: await guard(async () => {
      if (!present) {
        return { missing: 'navigator.bluetooth' };
      }
      const call = invoke(bluetooth, 'getAvailability');
      if (!call) {
        return { missing: 'navigator.bluetooth.getAvailability' };
      }
      const available = await withTimeout(call.result, 'navigator.bluetooth.getAvailability()');
      return isBoolean(available) ? available : { error: 'getAvailability() gave no boolean' };
    }),
  };
}

async function probeStorage(scope: ProbeScope): Promise<Probed<StorageSection>> {
  const storage = member(member(scope, 'navigator'), 'storage');
  if (!isObject(storage)) {
    return { missing: 'navigator.storage' };
  }
  return {
    estimate: await guard(async () => {
      const call = invoke(storage, 'estimate');
      return call
        ? toJsonObject(await withTimeout(call.result, 'navigator.storage.estimate()'))
        : { missing: 'navigator.storage.estimate' };
    }),
    persisted: await guard(async () => {
      const call = invoke(storage, 'persisted');
      if (!call) {
        return { missing: 'navigator.storage.persisted' };
      }
      const persisted = await withTimeout(call.result, 'navigator.storage.persisted()');
      return isBoolean(persisted) ? persisted : { error: 'persisted() gave no boolean' };
    }),
  };
}

async function probeEncoders(scope: ProbeScope): Promise<Probed<EncodersSection>> {
  const encoder = member(scope, 'VideoEncoder');
  if (typeof encoder !== 'function') {
    return { missing: 'VideoEncoder' };
  }
  const results: EncoderCheck[] = [];
  for (const config of ENCODER_CONFIGS) {
    const supported = await guard(async () => {
      const call = invoke(encoder, 'isConfigSupported', [config]);
      if (!call) {
        return { missing: 'VideoEncoder.isConfigSupported' };
      }
      const support = await withTimeout(call.result, 'VideoEncoder.isConfigSupported()');
      return member(support, 'supported') === true;
    });
    results.push({ ...config, supported });
  }
  return { results };
}

async function probeWorker(scope: ProbeScope): Promise<WorkerSection> {
  return {
    inWorker: await guard(() => presenceInWorker(scope)),
    onMainThread: guardSync(() => presence(scope)),
  };
}

function presence(scope: unknown): ApiPresence {
  return {
    MediaStreamTrackProcessor: typeof member(scope, 'MediaStreamTrackProcessor') === 'function',
    VideoEncoder: typeof member(scope, 'VideoEncoder') === 'function',
  };
}

async function presenceInWorker(scope: ProbeScope): Promise<Probed<ApiPresence>> {
  const WorkerClass = member(scope, 'Worker');
  const BlobClass = member(scope, 'Blob');
  const urls = member(scope, 'URL');
  if (typeof WorkerClass !== 'function') {
    return { missing: 'Worker' };
  }
  if (
    typeof BlobClass !== 'function' ||
    typeof member(urls, 'createObjectURL') !== 'function' ||
    typeof member(urls, 'revokeObjectURL') !== 'function'
  ) {
    return { missing: 'Blob or URL.createObjectURL' };
  }
  const blobUrls = urls as typeof URL;
  const source = blobUrls.createObjectURL(
    new (BlobClass as typeof Blob)([WORKER_SOURCE], { type: 'text/javascript' }),
  );
  let worker: Worker | undefined;
  try {
    const started = new (WorkerClass as typeof Worker)(source);
    worker = started;
    const reply = new Promise<unknown>((resolve, reject) => {
      started.onmessage = (event: MessageEvent<unknown>) => {
        resolve(event.data);
      };
      started.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        reject(new Error(event.message || 'the worker did not start'));
      };
    });
    const answer = await withTimeout(reply, 'the worker');
    return {
      MediaStreamTrackProcessor: member(answer, 'MediaStreamTrackProcessor') === true,
      VideoEncoder: member(answer, 'VideoEncoder') === true,
    };
  } finally {
    worker?.terminate();
    blobUrls.revokeObjectURL(source);
  }
}

interface CameraSections {
  readonly camera: Probed<CameraSection>;
  readonly capabilities: Probed<JsonObject>;
  readonly settings: Probed<JsonObject>;
  readonly timing: Probed<TimingSection>;
}

async function probeCamera(
  scope: ProbeScope,
  options: ProbeOptions,
  show: (status: string, sections: PartialReport) => void,
): Promise<CameraSections> {
  const skipped = (why: string, camera: Probed<CameraSection>): CameraSections => {
    const sections = {
      camera,
      capabilities: { skipped: why },
      settings: { skipped: why },
      timing: { skipped: why },
    };
    show('No camera to measure.', sections);
    return sections;
  };

  const devices = guardSync(() => mediaDevicesOf(scope));
  if (isAbsent(devices)) {
    return skipped('no camera API', devices);
  }
  const listed = await guard(async () => ({ videoInputs: await listVideoInputs(devices) }));
  if (isAbsent(listed)) {
    return skipped('the camera could not be listed', listed);
  }
  const { videoInputs } = listed;
  const chosen =
    videoInputs.find((input) => input.deviceId === options.deviceId) ?? videoInputs.at(0);
  const selected = chosen ?? { skipped: 'no video input' };
  if (options.signal?.aborted) {
    return skipped('stopped', {
      videoInputs,
      selected,
      requested: { skipped: 'stopped' },
      failedAttempts: [],
      trackLabel: { skipped: 'stopped' },
    });
  }

  show(`Opening ${chosen && chosen.label !== '' ? chosen.label : 'the camera'}…`, {});
  const opened = await openCamera(devices, chosen?.deviceId);
  if (!opened.ok) {
    return skipped('the camera did not open', {
      videoInputs,
      selected,
      requested: { error: 'every attempt failed (failedAttempts)' },
      failedAttempts: opened.failedAttempts,
      trackLabel: { skipped: 'the camera did not open' },
    });
  }

  const { stream } = opened;
  try {
    const track = stream.getVideoTracks().at(0);
    const camera: CameraSection = {
      videoInputs,
      selected,
      requested: opened.requested,
      failedAttempts: opened.failedAttempts,
      trackLabel: track ? track.label : { error: 'the stream has no video track' },
    };
    const settings = guardSync(() => rawTrackDictionary(track, 'getSettings'));
    const capabilities = guardSync(() => rawTrackDictionary(track, 'getCapabilities'));
    const seconds = String(options.seconds);
    show(`Measuring frame timing for ${seconds} s…`, { camera, settings, capabilities });
    const timing = await guard(() => measureTiming(scope, stream, options));
    return { camera, capabilities, settings, timing };
  } finally {
    stopStream(stream);
    if (options.video?.srcObject === stream) {
      options.video.srcObject = null;
    }
  }
}

function mediaDevicesOf(scope: ProbeScope): Probed<MediaDevices> {
  const devices = member(member(scope, 'navigator'), 'mediaDevices');
  if (!isObject(devices)) {
    return { missing: 'navigator.mediaDevices' };
  }
  for (const method of ['enumerateDevices', 'getUserMedia']) {
    if (typeof member(devices, method) !== 'function') {
      return { missing: `navigator.mediaDevices.${method}` };
    }
  }
  return devices as MediaDevices;
}

/** Lists the video inputs, first asking for the camera when their labels are still hidden. */
async function listVideoInputs(devices: MediaDevices): Promise<VideoInput[]> {
  const list = async (): Promise<VideoInput[]> =>
    (await withTimeout(devices.enumerateDevices(), 'enumerateDevices()'))
      .filter((device) => device.kind === 'videoinput')
      .map(({ deviceId, label, groupId }) => ({ deviceId, label, groupId }));
  const before = await list();
  if (before.length > 0 && before.every((input) => input.label !== '')) {
    return before;
  }
  const stream = await withTimeout(
    devices.getUserMedia({ video: true, audio: false }),
    'the camera permission',
    PERMISSION_TIMEOUT_MS,
    stopStream,
  );
  stopStream(stream);
  return list();
}

type Opened =
  | {
      readonly ok: true;
      readonly stream: MediaStream;
      readonly requested: JsonValue;
      readonly failedAttempts: readonly FailedAttempt[];
    }
  | { readonly ok: false; readonly failedAttempts: readonly FailedAttempt[] };

/** Opens the camera at 1920x1080 and ideally 60 fps, falling back to any mode, then any camera. */
async function openCamera(devices: MediaDevices, deviceId: string | undefined): Promise<Opened> {
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  const ladder: (MediaTrackConstraints | true)[] = [
    { ...device, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
    ...(deviceId ? [device] : []),
    true,
  ];
  const failedAttempts: FailedAttempt[] = [];
  for (const video of ladder) {
    const requested = toJson(video);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const stream = await withTimeout(
          devices.getUserMedia({ video, audio: false }),
          'getUserMedia()',
          OPEN_TIMEOUT_MS,
          stopStream,
        );
        return { ok: true, stream, requested, failedAttempts };
      } catch (error: unknown) {
        failedAttempts.push({ requested, error: describeError(error) });
        const name = member(error, 'name');
        if (attempt === 2 || !isString(name) || !BUSY_ERRORS.includes(name)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      }
    }
  }
  return { ok: false, failedAttempts };
}

/** `track.getSettings()` or `track.getCapabilities()`, every key, raw. */
function rawTrackDictionary(
  track: MediaStreamTrack | undefined,
  method: 'getSettings' | 'getCapabilities',
): Probed<JsonObject> {
  if (!track) {
    return { skipped: 'the stream has no video track' };
  }
  const call = invoke(track, method);
  return call ? toJsonObject(call.result) : { missing: `MediaStreamTrack.${method}` };
}

async function measureTiming(
  scope: ProbeScope,
  stream: MediaStream,
  options: ProbeOptions,
): Promise<Probed<TimingSection>> {
  const { video } = options;
  if (!video) {
    return { skipped: 'no video element to play the camera in' };
  }
  if (typeof member(video, 'requestVideoFrameCallback') !== 'function') {
    return { missing: 'HTMLVideoElement.requestVideoFrameCallback' };
  }
  const timeline = member(scope, 'performance');
  if (typeof member(timeline, 'now') !== 'function') {
    return { missing: 'performance.now' };
  }
  const clock = timeline as Performance;
  const windowMs = Math.round(options.seconds * 1000);
  const warmupMs = options.warmupMs ?? WARMUP_MS;

  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await withTimeout(video.play(), 'video.play()', OPEN_TIMEOUT_MS);
  const run = await collectFrames(
    video,
    () => clock.now(),
    windowMs,
    warmupMs,
    options.signal,
    () => playbackQuality(video),
  );
  if (options.signal?.aborted) {
    return { skipped: 'stopped' };
  }
  const timing = analyzeFrames(run.samples);
  if (isAbsent(timing)) {
    return run.samples.length === 0
      ? { error: `no video frame within ${String(STALL_MS)} ms` }
      : timing;
  }
  return {
    warmupMs,
    windowMs,
    completed: run.completed,
    ...timing,
    playbackQuality: qualityDifference(run.atStart, playbackQuality(video)),
  };
}

interface FrameRun<T> {
  readonly samples: readonly FrameSample[];
  readonly completed: boolean;
  /** What `atWindowStart` returned at the first frame of the window. */
  readonly atStart: T | undefined;
}

/** Collects `requestVideoFrameCallback` samples: a warm-up, then the window. */
function collectFrames<T>(
  video: HTMLVideoElement,
  now: () => number,
  windowMs: number,
  warmupMs: number,
  signal: AbortSignal | undefined,
  atWindowStart: () => T,
): Promise<FrameRun<T>> {
  return new Promise((resolve) => {
    const samples: FrameSample[] = [];
    let atStart: T | undefined;
    let firstAt: number | undefined;
    let startAt: number | undefined;
    let handle: number | undefined;
    let stall: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const finish = (completed: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(stall);
      signal?.removeEventListener('abort', onAbort);
      if (handle !== undefined) {
        video.cancelVideoFrameCallback(handle);
      }
      resolve({ samples, completed, atStart });
    };
    const onAbort = (): void => {
      finish(false);
    };
    const watch = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        finish(false);
      }, STALL_MS);
    };
    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      handle = undefined;
      if (done) {
        return;
      }
      const at = now();
      firstAt ??= at;
      if (at - firstAt >= warmupMs) {
        if (startAt === undefined) {
          startAt = at;
          atStart = atWindowStart();
        }
        samples.push({
          at,
          captureTime: metadata.captureTime,
          mediaTime: metadata.mediaTime,
          presentedFrames: metadata.presentedFrames,
          width: metadata.width,
          height: metadata.height,
        });
        if (at - startAt >= windowMs) {
          finish(true);
          return;
        }
      }
      watch();
      handle = video.requestVideoFrameCallback(onFrame);
    };

    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener('abort', onAbort);
    watch();
    handle = video.requestVideoFrameCallback(onFrame);
  });
}

function playbackQuality(video: HTMLVideoElement): Probed<PlaybackQuality> {
  return guardSync(() => {
    const call = invoke(video, 'getVideoPlaybackQuality');
    if (!call) {
      return { missing: 'HTMLVideoElement.getVideoPlaybackQuality' };
    }
    const total = member(call.result, 'totalVideoFrames');
    const dropped = member(call.result, 'droppedVideoFrames');
    return isNumber(total) && isNumber(dropped)
      ? { totalVideoFrames: total, droppedVideoFrames: dropped }
      : { error: 'getVideoPlaybackQuality() gave no frame counts' };
  });
}

function qualityDifference(
  before: Probed<PlaybackQuality> | undefined,
  after: Probed<PlaybackQuality>,
): Probed<PlaybackQuality> {
  if (isAbsent(after)) {
    return after;
  }
  if (before === undefined || isAbsent(before)) {
    return before ?? { skipped: 'no frame in the window' };
  }
  return {
    totalVideoFrames: after.totalVideoFrames - before.totalVideoFrames,
    droppedVideoFrames: after.droppedVideoFrames - before.droppedVideoFrames,
  };
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
