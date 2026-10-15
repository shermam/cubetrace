import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type {
  ControlDrift,
  ControlName,
  ControlValue,
  ControlValues,
  FrameSize,
  FramingRect,
} from '@cubetrace/capture';
import type { CameraIdentity, CameraInfo } from '@cubetrace/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SettingsService } from '../settings/settings-service';
import type { ControlsSource } from './controls-source';
import type { DriftOutcome } from './controls-watch';
import {
  HostCamera,
  LUMA_SAMPLER,
  cameraDevices,
  mediaDevicesOf,
  type CameraDevice,
  type CameraRole,
  type CameraStatus,
} from './host-camera';

// The camera's vocabulary, which lives with the camera (`HostCamera`, T5.5), exported here as before.
export {
  ADJUSTING_QUIET_MS,
  LUMA_SAMPLER,
  cameraDevices,
  modeChoice,
  openingApplied,
  type CameraDevice,
  type CameraRole,
  type CameraStatus,
} from './host-camera';

/**
 * The host's own camera (docs/PLAN.md, T2.1): the cameras of this device, the one chosen (per host
 * label, in Settings), opened at the resolution and frame rate that Settings asks for, with fallbacks
 * that say what they did (a camera that is gone, a frame rate it does not have, a mode it cannot
 * start in); its settings and capabilities as the track reports them, its manual controls (applied,
 * and kept per camera in Settings, by the browser's name for it), the frame rate and frame size
 * measured on the preview, the sharpness meter and the framing rectangle (kept by the same name and
 * the frame size). "Camera on" is a setting: the camera opens again when the Timer page loads, and
 * stays open across pages, like the cube's connection. `cameraInfo()` is the session's `cameras[]`
 * entry (T2.4 stores it, under the label the session gives the device: T2.14). The camera itself is
 * a `HostCamera` (T5.5), whose signals this service gives.
 *
 * The browser is read through BROWSER_GLOBALS (`navigator.mediaDevices`), which the unit tests
 * fake; the frames are measured on the preview `<video>` that the Camera preview beside the clock
 * (T2.7) hands to `watchPreview`.
 */
@Injectable({ providedIn: 'root' })
export class CameraService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly prefs = inject(SettingsService);
  private readonly media = mediaDevicesOf(this.globals);

  private readonly devicesSignal = signal<readonly CameraDevice[]>([]);
  private readonly roleSignal = signal<CameraRole>('host');

  /** The camera, as the role has it. */
  private readonly camera = new HostCamera(
    {
      globals: this.globals,
      prefs: this.prefs,
      diagnostics: inject(DiagnosticsService),
      sampler: inject(LUMA_SAMPLER),
      media: this.media,
      refreshDevices: () => this.refreshDevices(),
    },
    {
      role: () => this.roleSignal(),
      device: () => this.chosenDeviceId(),
      facing: () => (this.roleSignal() === 'camera-device' ? 'environment' : 'user'),
      mode: () => ({
        resolution: this.prefs.cameraResolution(),
        frameRate: this.prefs.cameraFrameRate(),
      }),
      fallBackToDefault: true,
      opened: (deviceId, label) => {
        this.prefs.setCameraPick(this.pickHost(), deviceId, label);
      },
    },
  );
  /** The camera the facade gives; null when there is none. */
  private readonly current: Signal<HostCamera | null> = signal(this.camera).asReadonly();

  /** This device's cameras (see `cameraDevices`). */
  readonly devices = this.devicesSignal.asReadonly();
  readonly status = computed<CameraStatus>(() => this.current()?.status() ?? 'off');
  /** Why the camera is not on, in plain words; null unless `status` is `error`. */
  readonly error = computed(() => this.current()?.error() ?? null);
  /** What the camera did otherwise than asked, or a control it refused; null when nothing. */
  readonly notice = computed(() => this.current()?.notice() ?? null);
  /** The camera's stream while it is on (video only), for the preview and the capture pipeline. */
  readonly stream = computed(() => this.current()?.stream() ?? null);
  /** The open camera's label, such as "camera 1, facing front"; empty while none is open. */
  readonly label = computed(() => this.current()?.label() ?? '');
  /**
   * The open camera's device id (`MediaDeviceInfo.deviceId`, from its track's settings), which
   * tells two cameras of one name apart in a session (T2.14) and is never recorded; null while none
   * is open, or when the browser gives none.
   */
  readonly deviceId = computed(() => this.current()?.deviceId() ?? null);
  /** The open camera's `getSettings()` as JSON (see @cubetrace/capture's `snapshot`). */
  readonly settings = computed(() => this.current()?.settings() ?? null);
  /** The open camera's `getCapabilities()` as JSON. */
  readonly capabilities = computed(() => this.current()?.capabilities() ?? null);
  /** The manual controls the open camera has; null while none is open (`HostCamera.controls`). */
  readonly controls = computed(() => this.current()?.controls() ?? null);
  /** The controls' current values, as the camera reports them. */
  readonly values = computed<ControlValues>(() => this.current()?.values() ?? {});
  /** A control is being applied (or the camera reopened for it). */
  readonly busy = computed(() => this.current()?.busy() ?? false);
  /** The role the camera plays (T4.1): the host's own, or a camera device's. */
  readonly role = this.roleSignal.asReadonly();
  /** What the app applied to the open camera (T5.2, `HostCamera.applied`). */
  readonly applied = computed<ControlValues>(() => this.current()?.applied() ?? {});
  /** What the open camera changed by itself (T5.2, `HostCamera.drift`). */
  readonly drift = computed<readonly ControlDrift[]>(() => this.current()?.drift() ?? []);
  /** The last drift the watchdog saw and what became of it, for the words. */
  readonly driftOutcome = computed<DriftOutcome | null>(
    () => this.current()?.driftOutcome() ?? null,
  );
  /**
   * The open camera's controls as the controls panel takes them (T5.2: the panel is a view over a
   * `ControlsSource`, this device's camera here, a phone's in the Cameras section); its error is
   * always null, since `notice` already says what the camera refused.
   */
  readonly controlsSource: ControlsSource = {
    controls: this.controls,
    values: this.values,
    applied: this.applied,
    drift: this.drift,
    busy: this.busy,
    error: signal<string | null>(null).asReadonly(),
    set: async (name, value) => {
      await this.setControl(name, value);
    },
    reset: () => this.resetControls(),
    adjusting: (active) => {
      this.adjusting(active);
    },
  };
  /**
   * Under which name Settings keep the camera chosen: the host label for the host's own camera, and
   * the host label marked for the camera device, whose choice is its own (the rear camera, where the
   * host's Timer page would take the front one).
   */
  private readonly pickHost = computed(() =>
    this.roleSignal() === 'host' ? this.prefs.hostLabel() : `${this.prefs.hostLabel()} (camera)`,
  );
  /** The camera chosen on this host, for the role: the open one, or the one that opens next. */
  readonly selectedId = computed(() => this.prefs.cameraPickFor(this.pickHost())?.deviceId ?? null);
  readonly facing = computed(() => this.current()?.facing() ?? 'unknown');
  /** The preview is mirrored, like a mirror, for a front camera; the frames never are. */
  readonly mirrored = computed(() => this.current()?.mirrored() ?? false);
  /** The open camera as a session tells it from its other cameras (T2.14, `HostCamera.identity`). */
  readonly identity = computed<CameraIdentity | null>(() => this.current()?.identity() ?? null);
  /** The size of the frames as they arrive (`HostCamera.frameSize`). */
  readonly frameSize = computed<FrameSize | null>(() => this.current()?.frameSize() ?? null);
  /** The frame rate the camera really delivers, measured on the preview; null until then. */
  readonly measuredFps = computed(() => this.current()?.measuredFps() ?? null);
  /** Why the preview's frames cannot be measured here (no `requestVideoFrameCallback`). */
  readonly frameProblem = computed(() => this.current()?.frameProblem() ?? null);
  /** The framing rectangle in frame pixels: stored for this camera and frame size, else full. */
  readonly framing = computed<FramingRect | null>(() => this.current()?.framing() ?? null);
  /** The framing rectangle is being edited in Camera settings, or is asked to be (T2.8). */
  readonly framingEditing = computed(() => this.current()?.framingEditing() ?? false);
  /** The last sharpness measured (variance of the Laplacian); null before the first. */
  readonly sharpness = computed(() => this.current()?.sharpness() ?? null);
  /** How many times the sharpness was measured since the camera opened. */
  readonly sharpnessSamples = computed(() => this.current()?.sharpnessSamples() ?? 0);
  /** The last sharpness measured is at least the threshold of Settings. */
  readonly sharpnessGood = computed(() => this.current()?.sharpnessGood() ?? false);

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
      this.camera.destroy();
    });
    void this.refreshDevices();
    if (this.prefs.cameraOn()) {
      void this.camera.open();
    }
    // A new resolution or frame rate in Settings applies at once to a camera that is on.
    let mode = this.camera.modeKey();
    effect(() => {
      const next = this.camera.modeKey();
      untracked(() => {
        if (next !== mode) {
          mode = next;
          if (this.camera.status() !== 'off') {
            void this.camera.open();
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
    await this.camera.open();
  }

  /** Turns the camera off, and keeps it off across loads. */
  stop(): void {
    this.prefs.setCameraOn(false);
    this.camera.stop();
  }

  /** Chooses the camera `deviceId` on this host, for the role; a camera that is on switches to it. */
  async select(deviceId: string): Promise<void> {
    const device = this.devicesSignal().find((candidate) => candidate.deviceId === deviceId);
    if (device === undefined) {
      return;
    }
    this.prefs.setCameraPick(this.pickHost(), device.deviceId, device.label);
    if (this.camera.status() !== 'off') {
      await this.camera.open();
    }
  }

  /**
   * Sets the role the camera plays (T4.1): the Camera page makes it the camera device's while it is
   * shown, and the host's again when it goes. A camera that is on opens again with the role's choice.
   */
  async setRole(role: CameraRole): Promise<void> {
    if (this.roleSignal() === role) {
      return;
    }
    this.roleSignal.set(role);
    if (this.camera.status() !== 'off') {
      await this.camera.open();
    }
  }

  /** Sets one control of the open camera (`HostCamera.setControl`); null while none is open. */
  async setControl(name: ControlName, value: ControlValue): Promise<string | null> {
    return (await this.current()?.setControl(name, value)) ?? null;
  }

  /** A slider of a controls panel is held or moved, or let go (`HostCamera.adjusting`). */
  adjusting(active: boolean): void {
    this.current()?.adjusting(active);
  }

  /** Forgets the manual controls kept for the open camera and reopens it, all automatic. */
  async resetControls(): Promise<void> {
    await this.current()?.resetControls();
  }

  /** Opens (true) or closes the framing rectangle's editor of Camera settings. */
  setFramingEditing(editing: boolean): void {
    this.current()?.setFramingEditing(editing);
  }

  /** Keeps `rect` (frame pixels, clamped) as the framing of the open camera at its frame size. */
  setFraming(rect: FramingRect): void {
    this.current()?.setFraming(rect);
  }

  /** The session's `cameras[]` entry for the open camera; null while it is not on. */
  cameraInfo(): CameraInfo | null {
    return this.current()?.cameraInfo() ?? null;
  }

  /** Measures the frames that `video` presents (`HostCamera.watchPreview`), until the returned function is called. */
  watchPreview(video: HTMLVideoElement, held: () => boolean = () => false): () => void {
    return this.current()?.watchPreview(video, held) ?? (() => undefined);
  }

  /**
   * The camera chosen on this host for the role: its stored id when this device lists it, else the
   * camera with its label (ids change when site data is cleared), else the stored id anyway (before
   * the permission, the list has no ids; an id that is gone falls back to the default camera). Null
   * when none was chosen: the default camera, the front one on a phone (the rear one for the camera
   * device).
   */
  private async chosenDeviceId(): Promise<string | null> {
    const pick = this.prefs.cameraPickFor(this.pickHost());
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
}
