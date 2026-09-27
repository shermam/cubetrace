import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  CONTROL_GROUPS,
  FrameRateMeter,
  applyControls,
  browserLumaSampler,
  buildConstraints,
  cameraInfo,
  clampFraming,
  controlValuesOf,
  controlsOf,
  facingFromLabel,
  facingOf,
  fallbackChoice,
  fitControls,
  framingFor,
  isFullFrame,
  snapshot,
  watchFrames,
  type CameraChoice,
  type CameraFacing,
  type ControlName,
  type ControlValues,
  type FrameSize,
  type FramingRect,
  type JsonObject,
  type LumaSampler,
  type MeteringMode,
} from '@cubetrace/capture';
import type { CameraInfo } from '@cubetrace/core';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import {
  CAMERA_RESOLUTION_SIZE,
  SettingsService,
  type CameraFrameRate,
  type CameraResolution,
} from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import {
  CAMERA_ENDED,
  NO_CAMERA_API,
  describeCameraError,
  describeFallback,
} from './camera-errors';
import { SharpnessSchedule } from './sharpness-schedule';

/**
 * `off`: closed, as the user left it. `starting`: asking for the camera (the permission prompt
 * included). `on`: the stream is live. `error`: it could not be opened, or it stopped; `error`
 * says why.
 */
export type CameraStatus = 'off' | 'starting' | 'on' | 'error';

/** A camera of this device, for the picker. */
export interface CameraDevice {
  readonly deviceId: string;
  /** The browser's label, such as "camera 1, facing front". */
  readonly label: string;
  /** What the picker shows: "Front camera" and "Rear camera" on phones, else the label. */
  readonly name: string;
  readonly facing: CameraFacing;
}

/** Draws the preview's frames for the sharpness meter; the unit tests give a fake canvas. */
export const LUMA_SAMPLER = new InjectionToken<LumaSampler<CanvasImageSource>>('LUMA_SAMPLER', {
  providedIn: 'root',
  factory: browserLumaSampler,
});

/**
 * A camera that fails as busy is asked again once after this long: it may be this app's own camera,
 * still closing after a switch.
 */
const BUSY_RETRY_MS = 500;

/** How often the measured frame rate is updated, in seconds of the camera's clock. */
const FPS_UPDATE_SECONDS = 0.5;

/** The controls that set a group's mode (see @cubetrace/capture's CONTROL_GROUPS). */
const MODE_CONTROLS: readonly ControlName[] = ['exposureMode', 'focusMode', 'whiteBalanceMode'];

/** The choice for a camera and the resolution and frame rate asked for in Settings. */
export function modeChoice(
  deviceId: string | null,
  resolution: CameraResolution,
  rate: CameraFrameRate,
): CameraChoice {
  return {
    deviceId,
    ...CAMERA_RESOLUTION_SIZE[resolution],
    fps: rate === '30' ? 30 : 60,
    ...(rate === '60' ? { exactFps: true } : {}),
  };
}

/**
 * The picker's cameras: the video inputs that have an id (before the permission, Chrome lists one
 * without), named "Front camera" and "Rear camera" where the label says so; two of one name are
 * told apart by their labels.
 */
export function cameraDevices(list: readonly MediaDeviceInfo[]): CameraDevice[] {
  const inputs = list.filter((device) => device.kind === 'videoinput' && device.deviceId !== '');
  const named = inputs.map((device, index) => {
    const facing = facingFromLabel(device.label);
    const name =
      facing === 'user'
        ? 'Front camera'
        : facing === 'environment'
          ? 'Rear camera'
          : device.label !== ''
            ? device.label
            : `Camera ${String(index + 1)}`;
    return { deviceId: device.deviceId, label: device.label, name, facing };
  });
  return named.map((device) =>
    named.filter((other) => other.name === device.name).length > 1 && device.label !== device.name
      ? { ...device, name: `${device.name} (${device.label})` }
      : device,
  );
}

/**
 * The host's own camera (docs/PLAN.md, T2.1): the cameras of this device, the one chosen (per host
 * label, in Settings), opened at the resolution and frame rate that Settings asks for, with fallbacks
 * that say what they did (a camera that is gone, a frame rate it does not have, a mode it cannot
 * start in); its settings and capabilities as the track reports them, its manual controls (applied,
 * and kept per camera label in Settings), the frame rate and frame size measured on the preview,
 * the sharpness meter and the framing rectangle (kept per camera label and frame size). "Camera
 * on" is a setting: the camera opens again when the Timer page loads, and stays open across pages,
 * like the cube's connection. `cameraInfo()` is the session's `cameras[]` entry (T2.4 stores it).
 *
 * The browser is read through BROWSER_GLOBALS (`navigator.mediaDevices`), which the unit tests
 * fake; the frames are measured on the preview `<video>` that the Camera preview beside the clock
 * (T2.7) hands to `watchPreview`.
 */
@Injectable({ providedIn: 'root' })
export class CameraService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly prefs = inject(SettingsService);
  private readonly sampler = inject(LUMA_SAMPLER);
  private readonly media = mediaDevicesOf(this.globals);

  private readonly devicesSignal = signal<readonly CameraDevice[]>([]);
  private readonly statusSignal = signal<CameraStatus>('off');
  private readonly errorSignal = signal<string | null>(null);
  private readonly noticeSignal = signal<string | null>(null);
  private readonly streamSignal = signal<MediaStream | null>(null);
  private readonly labelSignal = signal('');
  private readonly settingsSignal = signal<JsonObject | null>(null);
  /** The settings as the camera opened, before any control: its automatic modes. */
  private readonly openingSettingsSignal = signal<JsonObject | null>(null);
  private readonly capabilitiesSignal = signal<JsonObject | null>(null);
  private readonly sharpnessSignal = signal<number | null>(null);
  private readonly sharpnessSamplesSignal = signal(0);
  private readonly frameSizeSignal = signal<FrameSize | null>(null);
  private readonly measuredFpsSignal = signal<number | null>(null);
  private readonly frameProblemSignal = signal<string | null>(null);
  private readonly busySignal = signal(false);
  private readonly framingEditingSignal = signal(false);

  /** This device's cameras (see `cameraDevices`). */
  readonly devices = this.devicesSignal.asReadonly();
  readonly status = this.statusSignal.asReadonly();
  /** Why the camera is not on, in plain words; null unless `status` is `error`. */
  readonly error = this.errorSignal.asReadonly();
  /** What the camera did otherwise than asked, or a control it refused; null when nothing. */
  readonly notice = this.noticeSignal.asReadonly();
  /** The camera's stream while it is on (video only), for the preview and the capture pipeline. */
  readonly stream = this.streamSignal.asReadonly();
  /** The open camera's label, such as "camera 1, facing front"; empty while none is open. */
  readonly label = this.labelSignal.asReadonly();
  /** The open camera's `getSettings()` as JSON (see @cubetrace/capture's `snapshot`). */
  readonly settings = this.settingsSignal.asReadonly();
  /** The open camera's `getCapabilities()` as JSON. */
  readonly capabilities = this.capabilitiesSignal.asReadonly();
  /**
   * The manual controls the open camera has; null while none is open. The modes include those the
   * camera opened in: an automatic focus that a camera does not list stays one to go back to after
   * a switch to manual (the ThinkPhone's front camera).
   */
  readonly controls = computed(() => {
    const capabilities = this.capabilitiesSignal();
    const opening = this.openingSettingsSignal();
    return capabilities === null ? null : controlsOf(capabilities, opening ?? undefined);
  });
  /** The controls' current values, as the camera reports them. */
  readonly values = computed<ControlValues>(() => {
    const settings = this.settingsSignal();
    return settings === null ? {} : controlValuesOf(settings);
  });
  /** A control is being applied (or the camera reopened for it). */
  readonly busy = this.busySignal.asReadonly();
  /** The camera chosen on this host: the open one, or the one that opens next. */
  readonly selectedId = computed(
    () => this.prefs.cameraPickFor(this.prefs.hostLabel())?.deviceId ?? null,
  );
  readonly facing = computed(() => {
    const settings = this.settingsSignal();
    return settings === null ? 'unknown' : facingOf(settings, this.labelSignal());
  });
  /** The preview is mirrored, like a mirror, for a front camera; the frames never are. */
  readonly mirrored = computed(() => this.facing() === 'user');
  /**
   * The size of the frames as they arrive, measured on the preview; the track's settings until
   * then. A phone held upright delivers portrait frames although its settings may say 1920×1080.
   */
  readonly frameSize = computed<FrameSize | null>(() => {
    const measured = this.frameSizeSignal();
    if (measured !== null) {
      return measured;
    }
    const width = this.settingsSignal()?.['width'];
    const height = this.settingsSignal()?.['height'];
    return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? { width, height }
      : null;
  });
  /**
   * The frame rate the camera really delivers, measured over a second of its own clock on the
   * preview; null until then. The track may claim more (docs/DEVICES.md).
   */
  readonly measuredFps = this.measuredFpsSignal.asReadonly();
  /** Why the preview's frames cannot be measured here (no `requestVideoFrameCallback`). */
  readonly frameProblem = this.frameProblemSignal.asReadonly();
  /** The framing rectangle in frame pixels: stored for this camera and frame size, else full. */
  readonly framing = computed<FramingRect | null>(() => {
    const size = this.frameSize();
    const label = this.labelSignal();
    return size === null ? null : framingFor(this.prefs.cameraFramingsOf(label), size);
  });
  /**
   * The framing rectangle is being edited in Camera settings (Framing → Edit), or is asked to be: the
   * sync check's "Edit the framing" (T2.8) opens the editor from under the preview.
   */
  readonly framingEditing = this.framingEditingSignal.asReadonly();
  /** The last sharpness measured (variance of the Laplacian); null before the first. */
  readonly sharpness = this.sharpnessSignal.asReadonly();
  /** How many times the sharpness was measured since the camera opened. */
  readonly sharpnessSamples = this.sharpnessSamplesSignal.asReadonly();
  /** The last sharpness measured is at least the threshold of Settings. */
  readonly sharpnessGood = computed(() => {
    const value = this.sharpnessSignal();
    return value !== null && value >= this.prefs.sharpnessThreshold();
  });

  private track: MediaStreamTrack | null = null;
  private opened: MediaStream | null = null;
  /** The choice that opened the camera, after any fallback. */
  private choice: CameraChoice | null = null;
  private forgetTrack: (() => void) | null = null;
  /** Incremented by every open and stop: a slower, older attempt then knows it lost. */
  private generation = 0;
  /** Controls are applied one at a time. */
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    const destroyRef = inject(DestroyRef);
    const media = this.media;
    if (media !== null) {
      const onDeviceChange = (): void => {
        void this.refreshDevices();
      };
      media.addEventListener('devicechange', onDeviceChange);
      destroyRef.onDestroy(() => {
        media.removeEventListener('devicechange', onDeviceChange);
      });
    }
    destroyRef.onDestroy(() => {
      this.generation++;
      this.close();
    });
    void this.refreshDevices();
    if (this.prefs.cameraOn()) {
      void this.open();
    }
    // A new resolution or frame rate in Settings applies at once to a camera that is on.
    let mode = `${this.prefs.cameraResolution()} ${this.prefs.cameraFrameRate()}`;
    effect(() => {
      const next = `${this.prefs.cameraResolution()} ${this.prefs.cameraFrameRate()}`;
      untracked(() => {
        if (next !== mode) {
          mode = next;
          if (this.statusSignal() !== 'off') {
            void this.open();
          }
        }
      });
    });
  }

  /** Lists this device's cameras again (names appear once the camera is allowed). */
  async refreshDevices(): Promise<void> {
    if (this.media === null) {
      return;
    }
    try {
      this.devicesSignal.set(cameraDevices(await this.media.enumerateDevices()));
    } catch {
      // The list stays as it was.
    }
  }

  /** Turns the camera on (the permission prompt, the first time) and keeps it on across loads. */
  async start(): Promise<void> {
    this.prefs.setCameraOn(true);
    await this.open();
  }

  /** Turns the camera off, and keeps it off across loads. */
  stop(): void {
    this.prefs.setCameraOn(false);
    this.generation++;
    this.close();
    this.statusSignal.set('off');
    this.errorSignal.set(null);
    this.noticeSignal.set(null);
  }

  /** Chooses the camera `deviceId` on this host; a camera that is on switches to it. */
  async select(deviceId: string): Promise<void> {
    const device = this.devicesSignal().find((candidate) => candidate.deviceId === deviceId);
    if (device === undefined) {
      return;
    }
    this.prefs.setCameraPick(this.prefs.hostLabel(), device.deviceId, device.label);
    if (this.statusSignal() !== 'off') {
      await this.open();
    }
  }

  /**
   * Sets one control of the open camera, and keeps the choice for this camera (except the torch).
   * A mode alone switches its group: `manual` holds the values the camera had chosen; an automatic
   * mode forgets the group's kept values. A value (an exposure time, a distance…) switches its
   * group to manual. When the camera does not go back to an automatic mode by a constraint (the
   * ThinkPhone's front camera lists only manual focus), it is reopened: a new capture starts in the
   * camera's automatic modes, with the other choices kept for it applied again.
   */
  async setControl(name: ControlName, value: MeteringMode | number | boolean): Promise<void> {
    const track = this.track;
    const controls = this.controls();
    if (track === null || controls === null || this.statusSignal() !== 'on') {
      return;
    }
    const group = CONTROL_GROUPS.find((names) => names.includes(name)) ?? [name];
    const modeName = group.find((member) => MODE_CONTROLS.includes(member));
    // What the camera takes: its modes, and numbers in their ranges and on their steps.
    const change = fitControls(
      modeName === undefined || modeName === name
        ? { [name]: value }
        : { [modeName]: 'manual', [name]: value },
      controls,
    );
    const toAuto = name === modeName && value !== 'manual';
    const kept = Object.entries(this.prefs.cameraControlsFor(track.label)).filter(
      ([key]) => !toAuto || !group.includes(key as ControlName),
    );
    this.prefs.setCameraControls(track.label, {
      ...(Object.fromEntries(kept) as ControlValues),
      ...(toAuto ? {} : change),
    });
    this.busySignal.set(true);
    try {
      await this.serially(async () => {
        if (track !== this.track) {
          return;
        }
        try {
          await applyControls(track, change);
        } catch (error: unknown) {
          this.noticeSignal.set(`The camera refused the change (${errorMessage(error)}).`);
        }
        if (track !== this.track) {
          return;
        }
        this.takeSnapshot(track);
        if (toAuto && this.values()[name] === 'manual') {
          await this.open();
        }
      });
    } finally {
      this.busySignal.set(false);
    }
  }

  /** Forgets the manual controls kept for the open camera and reopens it, all automatic. */
  async resetControls(): Promise<void> {
    const track = this.track;
    if (track === null) {
      return;
    }
    this.prefs.setCameraControls(track.label, {});
    this.busySignal.set(true);
    try {
      await this.serially(() => this.open());
    } finally {
      this.busySignal.set(false);
    }
  }

  /** Opens (true) or closes the framing rectangle's editor of Camera settings. */
  setFramingEditing(editing: boolean): void {
    this.framingEditingSignal.set(editing);
  }

  /** Keeps `rect` (frame pixels, clamped) as the framing of the open camera at its frame size. */
  setFraming(rect: FramingRect): void {
    const size = this.frameSize();
    const label = this.labelSignal();
    if (size === null || this.track === null) {
      return;
    }
    this.prefs.setCameraFraming(label, size, clampFraming(rect, size));
  }

  /**
   * The session's `cameras[]` entry for the open camera (@cubetrace/core's `CameraInfo`: label,
   * facing, device label, settings, capabilities, constraints, the framing rectangle as `crop`, null
   * for the whole frame, and `mode: 'full'`); null while the camera is not on.
   */
  cameraInfo(): CameraInfo | null {
    const track = this.track;
    const choice = this.choice;
    const rect = this.framing();
    const size = this.frameSize();
    if (track === null || choice === null || this.statusSignal() !== 'on') {
      return null;
    }
    const crop = rect === null || size === null || isFullFrame(rect, size) ? null : rect;
    return cameraInfo(this.prefs.hostLabel(), choice, track, crop);
  }

  /**
   * Measures the frames that `video` (the preview, playing `stream`) presents, until the returned
   * function is called: their size, the frame rate over a second of the camera's clock, and the
   * sharpness of the framing rectangle at most twice a second, none while `held()` says so (see
   * `SharpnessSchedule`: the Camera preview holds it during a solve).
   */
  watchPreview(video: HTMLVideoElement, held: () => boolean = () => false): () => void {
    if (typeof member(video, 'requestVideoFrameCallback') !== 'function') {
      this.frameProblemSignal.set(
        'This browser cannot measure the frames (no requestVideoFrameCallback).',
      );
      return () => undefined;
    }
    this.frameProblemSignal.set(null);
    const meter = new FrameRateMeter();
    const schedule = new SharpnessSchedule();
    let shownAt = Number.NEGATIVE_INFINITY;
    return watchFrames(video, (metadata) => {
      const size = this.frameSizeSignal();
      if (size?.width !== metadata.width || size.height !== metadata.height) {
        if (metadata.width > 0 && metadata.height > 0) {
          this.frameSizeSignal.set({ width: metadata.width, height: metadata.height });
        }
      }
      meter.add(metadata);
      if (metadata.mediaTime < shownAt || metadata.mediaTime - shownAt >= FPS_UPDATE_SECONDS) {
        const fps = meter.fps();
        if (fps !== null) {
          shownAt = metadata.mediaTime;
          this.measuredFpsSignal.set(fps);
        }
      }
      if (schedule.due(metadata.mediaTime * 1000, held())) {
        this.measureSharpness(video);
      }
    });
  }

  private measureSharpness(video: HTMLVideoElement): void {
    const region = this.framing();
    if (region === null) {
      return;
    }
    let value: number | null;
    try {
      value = this.sampler.measure(video, region);
    } catch {
      return; // A frame that cannot be drawn (the stream is changing): the next one will do.
    }
    if (value !== null) {
      this.sharpnessSignal.set(value);
      this.sharpnessSamplesSignal.update((count) => count + 1);
    }
  }

  /**
   * Opens the chosen camera in the mode of Settings, closing the one that is open; each failure
   * that `fallbackChoice` knows a way around tries that way, and the notice says what it did.
   */
  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.close();
    this.statusSignal.set('starting');
    this.errorSignal.set(null);
    this.noticeSignal.set(null);
    const media = this.media;
    if (media === null) {
      this.fail(generation, NO_CAMERA_API);
      return;
    }
    const deviceId = await this.chosenDeviceId();
    if (generation !== this.generation) {
      return;
    }
    let choice = modeChoice(deviceId, this.prefs.cameraResolution(), this.prefs.cameraFrameRate());
    const notes: string[] = [];
    let retriedBusy = false;
    for (;;) {
      let stream: MediaStream;
      try {
        stream = await media.getUserMedia(buildConstraints(choice));
      } catch (error: unknown) {
        if (generation !== this.generation) {
          return;
        }
        if (!retriedBusy && member(error, 'name') === 'NotReadableError') {
          retriedBusy = true;
          await this.wait(BUSY_RETRY_MS);
          if (generation !== this.generation) {
            return;
          }
          continue;
        }
        const next = fallbackChoice(choice, error);
        if (next === null) {
          this.fail(generation, describeCameraError(error));
          return;
        }
        notes.push(describeFallback(next.why, choice));
        choice = next.choice;
        continue;
      }
      if (generation !== this.generation) {
        stopStream(stream);
        return;
      }
      await this.adopt(generation, stream, choice, notes);
      return;
    }
  }

  /**
   * The camera chosen on this host: its stored id when this device lists it, else the camera with
   * its label (ids change when site data is cleared), else the stored id anyway (before the
   * permission, the list has no ids; an id that is gone falls back to the default camera). Null
   * when none was chosen: the default camera, the front one on a phone.
   */
  private async chosenDeviceId(): Promise<string | null> {
    const pick = this.prefs.cameraPickFor(this.prefs.hostLabel());
    if (pick === null) {
      return null;
    }
    await this.refreshDevices();
    const devices = this.devicesSignal();
    if (devices.some((device) => device.deviceId === pick.deviceId)) {
      return pick.deviceId;
    }
    const sameLabel = devices.find((device) => pick.label !== '' && device.label === pick.label);
    return sameLabel?.deviceId ?? pick.deviceId;
  }

  /** Takes an open stream: applies the controls kept for its camera and shows it. */
  private async adopt(
    generation: number,
    stream: MediaStream,
    choice: CameraChoice,
    notes: readonly string[],
  ): Promise<void> {
    const track = stream.getVideoTracks().at(0);
    if (track === undefined) {
      stopStream(stream);
      this.fail(generation, 'The camera sent no video.');
      return;
    }
    this.opened = stream;
    this.track = track;
    this.choice = choice;
    const onEnded = (): void => {
      if (this.track === track) {
        this.fail(this.generation, CAMERA_ENDED);
      }
    };
    track.addEventListener('ended', onEnded);
    this.forgetTrack = () => {
      track.removeEventListener('ended', onEnded);
    };
    this.labelSignal.set(track.label);
    this.takeSnapshot(track);
    this.openingSettingsSignal.set(this.settingsSignal());
    const deviceId = track.getSettings().deviceId;
    if (typeof deviceId === 'string' && deviceId !== '') {
      this.prefs.setCameraPick(this.prefs.hostLabel(), deviceId, track.label);
    }
    const messages = [...notes];
    const kept = this.prefs.cameraControlsFor(track.label);
    const controls = this.controls();
    if (controls !== null && Object.keys(kept).length > 0) {
      try {
        await applyControls(track, fitControls(kept, controls));
      } catch (error: unknown) {
        messages.push(`The camera refused the settings kept for it (${errorMessage(error)}).`);
      }
      if (generation !== this.generation) {
        return;
      }
      this.takeSnapshot(track);
    }
    this.streamSignal.set(stream);
    this.statusSignal.set('on');
    this.noticeSignal.set(messages.length > 0 ? messages.join(' ') : null);
    void this.refreshDevices();
  }

  private takeSnapshot(track: MediaStreamTrack): void {
    const { settings, capabilities } = snapshot(track);
    this.settingsSignal.set(settings);
    this.capabilitiesSignal.set(capabilities);
  }

  /** Closes the camera that is open, and forgets what was measured on it. */
  private close(): void {
    this.forgetTrack?.();
    this.forgetTrack = null;
    if (this.opened !== null) {
      stopStream(this.opened);
    }
    this.opened = null;
    this.track = null;
    this.choice = null;
    this.streamSignal.set(null);
    this.labelSignal.set('');
    this.settingsSignal.set(null);
    this.openingSettingsSignal.set(null);
    this.capabilitiesSignal.set(null);
    this.sharpnessSignal.set(null);
    this.sharpnessSamplesSignal.set(0);
    this.frameSizeSignal.set(null);
    this.measuredFpsSignal.set(null);
  }

  private fail(generation: number, message: string): void {
    if (generation !== this.generation) {
      return;
    }
    this.close();
    this.statusSignal.set('error');
    this.errorSignal.set(message);
  }

  /** Runs `task` after the ones before it. */
  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private wait(ms: number): Promise<void> {
    const setTimer =
      this.globals.setTimeout ??
      ((callback: () => void, delay: number) => setTimeout(callback, delay));
    return new Promise((resolve) => {
      setTimer(resolve, ms);
    });
  }
}

/** `navigator.mediaDevices` when it can list and open cameras; null otherwise. */
function mediaDevicesOf(globals: BrowserGlobals): MediaDevices | null {
  const media = globals.navigator?.mediaDevices as unknown;
  return typeof member(media, 'getUserMedia') === 'function' &&
    typeof member(media, 'enumerateDevices') === 'function'
    ? (media as MediaDevices)
    : null;
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (Reflect.get(value, key) as unknown)
    : undefined;
}
