import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
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
import { HostCamerasService } from './host-cameras-service';
import {
  HostCamera,
  LUMA_SAMPLER,
  mediaDevicesOf,
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
 * This device's camera where a single one is meant (docs/PLAN.md T2.1; since T5.5 a facade): in the
 * `host` role, the first of the host's cameras (`HostCamerasService.primary`, the cameras of the
 * laptop turned on, each a `HostCamera`), which a phone's pinned picture shows (T2.13) and whose
 * clips have the microphone's sound; in the `camera-device` role (T4.1: a phone filming for another
 * host, on its Camera page), the camera of that page, a `HostCamera` of its own: the camera chosen
 * for the role (kept per host label in Settings, the rear one by default), while the host's cameras
 * are closed (`HostCamerasService.suspend`). The signals are those of that camera: its status, its
 * stream, its settings and capabilities, its manual controls and their watchdog (T5.2), the frame
 * rate, frame size and sharpness measured on its preview, its framing rectangle; `cameraInfo()` is
 * the session's `cameras[]` entry (T2.4 stores it, under the label the session gives the device:
 * T2.14). Turn on and Turn off are the host's (`HostCamerasService.turnOn`, kept across loads) or the
 * Camera page's.
 *
 * The browser is read through BROWSER_GLOBALS (`navigator.mediaDevices`), which the unit tests
 * fake; the frames are measured on the preview `<video>` that the Camera preview beside the clock
 * (T2.7) or the Camera page hands to `watchPreview`.
 */
@Injectable({ providedIn: 'root' })
export class CameraService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly prefs = inject(SettingsService);
  private readonly hosts = inject(HostCamerasService);

  private readonly roleSignal = signal<CameraRole>('host');

  /** The camera device's camera (T4.1): the one chosen for the role, the rear one by default. */
  private readonly deviceCamera = new HostCamera(
    {
      globals: this.globals,
      prefs: this.prefs,
      diagnostics: inject(DiagnosticsService),
      sampler: inject(LUMA_SAMPLER),
      media: mediaDevicesOf(this.globals),
      refreshDevices: () => this.refreshDevices(),
    },
    {
      role: () => 'camera-device',
      device: () => this.chosenDeviceId(),
      facing: () => 'environment',
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
  /** The camera the facade gives, as the role has it; null when there is none. */
  private readonly current = computed<HostCamera | null>(() =>
    this.roleSignal() === 'host' ? this.hosts.primary() : this.deviceCamera,
  );

  /** This device's cameras (see `cameraDevices`). */
  readonly devices = this.hosts.devices;
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
  /**
   * The camera chosen for the role: the camera device's (kept per host label), or the device of the
   * host's first camera on.
   */
  readonly selectedId = computed(() =>
    this.roleSignal() === 'host'
      ? (this.hosts.primary()?.deviceId() ?? null)
      : (this.prefs.cameraPickFor(this.pickHost())?.deviceId ?? null),
  );
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
    inject(DestroyRef).onDestroy(() => {
      this.deviceCamera.destroy();
    });
    // A new resolution or frame rate in Settings applies at once to the camera device's camera on
    // (the host's cameras follow their own: HostCamerasService).
    let mode = this.deviceCamera.modeKey();
    effect(() => {
      const next = this.deviceCamera.modeKey();
      untracked(() => {
        if (next !== mode) {
          mode = next;
          if (this.deviceCamera.status() !== 'off') {
            void this.deviceCamera.open();
          }
        }
      });
    });
  }

  /** Lists this device's cameras again (names appear once a camera is allowed). */
  refreshDevices(): Promise<void> {
    return this.hosts.refreshDevices();
  }

  /**
   * Turns the camera on (the permission prompt, the first time): the host's (the first device, with
   * none on; kept on across loads), or the camera device's.
   */
  async start(): Promise<void> {
    if (this.roleSignal() === 'host') {
      await this.hosts.turnOn();
    } else {
      await this.deviceCamera.open();
    }
  }

  /** Turns the camera off: the host's cameras (kept off across loads), or the camera device's. */
  stop(): void {
    if (this.roleSignal() === 'host') {
      this.hosts.turnOff();
    } else {
      this.deviceCamera.stop();
    }
  }

  /**
   * Chooses the camera `deviceId` for the role: the camera device's (kept for it; one that is on
   * switches to it), or the host's camera alone on.
   */
  async select(deviceId: string): Promise<void> {
    const device = this.devices().find((candidate) => candidate.deviceId === deviceId);
    if (device === undefined) {
      return;
    }
    if (this.roleSignal() === 'host') {
      await this.hosts.only(device.deviceId);
      return;
    }
    this.prefs.setCameraPick(this.pickHost(), device.deviceId, device.label);
    if (this.deviceCamera.status() !== 'off') {
      await this.deviceCamera.open();
    }
  }

  /**
   * Sets the role the camera plays (T4.1): the Camera page makes it the camera device's while it is
   * shown, and the host's again when it goes. The host's cameras are closed meanwhile; a camera that
   * was on opens with the role's choice.
   */
  async setRole(role: CameraRole): Promise<void> {
    if (this.roleSignal() === role) {
      return;
    }
    const wasOn = this.status() !== 'off';
    this.roleSignal.set(role);
    if (role === 'camera-device') {
      await this.hosts.suspend(true);
      if (wasOn) {
        await this.deviceCamera.open();
      }
    } else {
      this.deviceCamera.stop();
      await this.hosts.suspend(false);
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
   * The camera chosen for the camera device: its stored id when this device lists it, else the
   * camera with its label (ids change when site data is cleared), else the stored id anyway (before
   * the permission, the list has no ids; an id that is gone falls back to the default camera). Null
   * when none was chosen: the default camera, the rear one.
   */
  private async chosenDeviceId(): Promise<string | null> {
    const pick = this.prefs.cameraPickFor(this.pickHost());
    if (pick === null) {
      return null;
    }
    await this.refreshDevices();
    const devices = this.devices();
    if (devices.some((device) => device.deviceId === pick.deviceId)) {
      return pick.deviceId;
    }
    const sameLabel = devices.find((device) => pick.label !== '' && device.label === pick.label);
    return sameLabel?.deviceId ?? pick.deviceId;
  }
}
