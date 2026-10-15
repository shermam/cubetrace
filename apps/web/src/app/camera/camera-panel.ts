import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { fullFrame } from '@cubetrace/capture';

import { AuthService } from '../auth/auth-service';
import { SessionService } from '../session/session-service';
import {
  CAMERA_FRAME_RATES,
  CAMERA_FRAME_RATE_TEXT,
  CAMERA_RESOLUTIONS,
  CAMERA_RESOLUTION_TEXT,
  DEFAULT_CAMERA,
  MICROPHONE_HINT,
  MICROPHONE_PROCESSINGS,
  MICROPHONE_PROCESSING_TEXT,
  SettingsService,
  VIDEO_QUALITIES,
  type CameraMode,
} from '../settings/settings-service';
import { cameraName } from '../shared/camera-name';
import { fpsText, framingText, sizeText, trackText } from './camera-format';
import { CameraControls } from './camera-controls';
import { CameraService } from './camera-service';
import { outcomeSentences } from './controls-source';
import { FramingEditor } from './framing-editor';
import type { CameraDevice, HostCamera } from './host-camera';
import { HostCamerasService } from './host-cameras-service';
import { PAIRING_BLOCK_TEXT } from './pairing-block';
import { RecordingPanel } from './recording-panel';
import { RecordingService } from './recording-service';
import { RemoteCameras } from './remote-cameras';
import { SharpnessMeter } from './sharpness-meter';
import { videoQualityOptions } from './video-quality';

/**
 * A camera of the laptop as Camera settings list it (T5.5): its switch, its resolution and frame
 * rate; a camera on that is not connected is listed too, to be turned off.
 */
interface DeviceRow {
  /** The browser's name for it, by which Settings keep it. */
  readonly label: string;
  /** What the list shows: "FaceTime HD Camera", "Front camera". */
  readonly name: string;
  /** The device, while it is connected. */
  readonly device: CameraDevice | null;
  readonly on: boolean;
  /** The resolution and the frame rate it is asked for. */
  readonly mode: CameraMode;
}

/** A camera of the host that is on, as its block of Camera settings says it. */
interface CameraBlock {
  readonly camera: HostCamera;
  /** Its name: its label in the session and the browser's name ("laptop-2 · FaceTime HD Camera"). */
  readonly name: string;
  /** What the track claims: "1920×1080 at 60 fps". */
  readonly track: string;
  /** What the preview measures: "30.0 fps, frames 1080×1920". */
  readonly measured: string;
  readonly framing: string;
  /** What the watchdog of its modes saw last (T5.2); `bad` unless it was set back. */
  readonly drift: { readonly sentences: readonly string[]; readonly bad: boolean } | null;
}

/**
 * The Camera settings of the Timer page (docs/PLAN.md, T2.1; a disclosure since T2.7, whose
 * `CameraPreview` shows the pictures beside the clock): since T5.5 every camera of this device with a
 * switch of its own (the laptop's built-in camera and a USB webcam together, front and rear on a
 * phone) and its own resolution and frame rate (kept per camera; Settings' for a camera without its
 * own), Turn on / Turn off for all of them (kept across loads), and for each camera on a block of its
 * own: what the track claims next to what its preview measures (a phone may claim 60 fps and deliver
 * 30), its framing rectangle, which Edit shows over a larger picture of the camera (mirrored for a
 * front camera, like a mirror; the frames are not; drag the rectangle to move it, drag a corner to
 * resize it, by mouse or touch; the arrow keys move it and Shift + arrows resize it; kept per camera),
 * its sharpness meter, its manual controls, and in plain words why it did not open or opened
 * otherwise than asked; then the video quality (T2.10), audio and microphone (raw or voice, T2.12) of
 * Settings, whose sound goes with the first camera's clips; below them, the recording (T2.4,
 * `RecordingPanel`), which this panel's `RecordingService` runs from the moment the Timer page loads
 * it.
 *
 * Closed at first; the first time a camera is on it opens by itself, so that its controls are found,
 * and from then on it stays as it was left (Settings keeps it). The larger picture (`FramingEditor`)
 * is there only while a camera's framing is edited and the panel is open: a second picture of the
 * camera costs the page some work on every frame. Since T4.1 the panel ends with the Cameras section
 * (`RemoteCameras`, the phones that film for this host), a deferred block loaded when Add camera is
 * first pressed (`addRequests`, which the section reads to start the pairing as it appears), so that
 * a session without remote cameras downloads nothing of it.
 */
@Component({
  selector: 'app-camera-panel',
  imports: [CameraControls, FramingEditor, RecordingPanel, RemoteCameras, SharpnessMeter],
  templateUrl: './camera-panel.html',
  styleUrl: './camera-panel.scss',
})
export class CameraPanel {
  protected readonly camera = inject(CameraService);
  protected readonly hosts = inject(HostCamerasService);
  private readonly recording = inject(RecordingService);
  protected readonly prefs = inject(SettingsService);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionService);

  /** How many times Add camera was pressed on the placeholder, before the Cameras section loaded. */
  protected readonly addRequests = signal(0);
  /** Why Add camera cannot pair now, before the Cameras section loaded; null when it can. */
  protected readonly addBlocked = computed(() => {
    if (this.auth.cloud() === null) {
      return PAIRING_BLOCK_TEXT['signed-out'];
    }
    return this.session.session() === null ? PAIRING_BLOCK_TEXT['no-session'] : null;
  });

  /** Whether the disclosure is open: as it was left, closed before it ever was opened. */
  protected readonly open = signal(this.prefs.cameraSettingsOpen() ?? false);
  /**
   * A camera's framing rectangle is being edited, over the larger picture: by its Edit here, or by
   * the sync check's "Edit the framing" under the preview (T2.8), which opens these settings to it.
   */
  protected readonly editing = computed(() =>
    this.hosts.cameras().some((camera) => camera.framingEditing()),
  );
  protected readonly resolutions = CAMERA_RESOLUTIONS.map((value) => ({
    value,
    label: CAMERA_RESOLUTION_TEXT[value],
  }));
  protected readonly frameRates = CAMERA_FRAME_RATES.map((value) => ({
    value,
    label: CAMERA_FRAME_RATE_TEXT[value],
  }));
  /**
   * Each quality with its bitrate and size per attempt at the resolution and frame rate of the
   * first camera (Settings' without one).
   */
  protected readonly qualities = computed(() => {
    const label = this.hosts.primary()?.label() ?? DEFAULT_CAMERA;
    const mode = this.prefs.cameraModeFor(label);
    return videoQualityOptions(mode.resolution, mode.frameRate);
  });
  protected readonly microphoneProcessings = MICROPHONE_PROCESSINGS.map((value) => ({
    value,
    label: MICROPHONE_PROCESSING_TEXT[value],
  }));
  protected readonly microphoneHint = MICROPHONE_HINT;

  /** Several cameras of this device are on (T5.5): each block is named. */
  protected readonly several = computed(() => this.hosts.cameras().length > 1);
  /** This device's cameras, each with its switch and mode; those on but unplugged after them. */
  protected readonly rows = computed<readonly DeviceRow[]>(() => {
    const on = this.prefs.camerasOn();
    const devices = this.hosts.devices().filter((device) => device.label !== '');
    const listed: DeviceRow[] = devices.map((device) => ({
      label: device.label,
      name: device.name,
      device,
      on: on.includes(device.label),
      mode: this.prefs.cameraModeFor(device.label),
    }));
    const gone: DeviceRow[] = on
      .filter(
        (label) => label !== DEFAULT_CAMERA && !devices.some((device) => device.label === label),
      )
      .map((label) => ({
        label,
        name: `${label} (not connected)`,
        device: null,
        on: true,
        mode: this.prefs.cameraModeFor(label),
      }));
    return [...listed, ...gone];
  });
  /** Each camera on, as its block says it. */
  protected readonly blocks = computed<readonly CameraBlock[]>(() => {
    const devices = this.hosts.devices();
    return this.hosts.cameras().map((camera) => {
      const device = devices.find((one) => one.deviceId === camera.deviceId());
      const label = this.recording.labelOf(camera);
      const problem = camera.frameProblem();
      const fps = camera.measuredFps();
      const size = camera.frameSize();
      const rect = camera.framing();
      const outcome = camera.driftOutcome();
      return {
        camera,
        name: cameraName(label ?? 'camera', device?.name ?? camera.label()),
        track: trackText(camera.settings()) ?? 'unknown',
        measured:
          problem ??
          (fps === null
            ? 'measuring…'
            : `${fpsText(fps)}${size === null ? '' : `, frames ${sizeText(size)}`}`),
        framing: rect === null || size === null ? '' : framingText(rect, size),
        drift:
          outcome === null
            ? null
            : { sentences: outcomeSentences(outcome), bad: !outcome.reapplied },
      };
    });
  });
  /** Some camera of this device shows its picture. */
  protected readonly anyStream = computed(() =>
    this.hosts.cameras().some((camera) => camera.stream() !== null),
  );

  protected readonly summary = computed(() => {
    const cameras = this.hosts.cameras();
    const recording = this.recording.status() === 'recording';
    if (cameras.length > 1) {
      const on = cameras.filter((camera) => camera.status() === 'on').length;
      return [
        `${String(on)} of ${String(cameras.length)} cameras on`,
        recording ? 'recording' : null,
      ]
        .filter((part) => part !== null)
        .join(' · ');
    }
    switch (this.camera.status()) {
      case 'off':
        return 'Off';
      case 'starting':
        return 'Starting…';
      case 'error':
        return 'Not working';
      case 'on': {
        const size = this.camera.frameSize();
        const fps = this.camera.measuredFps();
        const parts = [
          size === null ? null : sizeText(size),
          fps === null ? null : fpsText(fps),
          recording ? 'recording' : null,
        ];
        return parts.filter((part) => part !== null).join(' · ') || 'On';
      }
    }
  });
  protected readonly threshold = this.prefs.sharpnessThreshold;

  constructor() {
    // The first time a camera is on (on this device), the settings open by themselves.
    effect(() => {
      if (this.camera.status() !== 'off' && this.prefs.cameraSettingsOpen() === null) {
        untracked(() => {
          this.setOpen(true);
        });
      }
    });
    // Asked to edit a framing from elsewhere (the sync check): the settings open to the editor.
    effect(() => {
      if (this.editing() && !untracked(() => this.open())) {
        untracked(() => {
          this.setOpen(true);
        });
      }
    });
    // Leaving the page closes the editors, as it was before the editor could be asked for.
    inject(DestroyRef).onDestroy(() => {
      for (const camera of this.hosts.cameras()) {
        camera.setFramingEditing(false);
      }
    });
  }

  /** Edit or Done: the framing rectangle's editor of `camera` opened or closed. */
  protected toggleEditing(camera: HostCamera): void {
    camera.setFramingEditing(!camera.framingEditing());
  }

  /** The disclosure was opened or closed: kept for the next loads. */
  protected setOpen(open: boolean): void {
    this.open.set(open);
    this.prefs.setCameraSettingsOpen(open);
  }

  /** A camera's switch: on beside the others, or off; one not connected is forgotten. */
  protected setOn(row: DeviceRow, on: boolean): void {
    if (row.device === null) {
      this.hosts.forget(row.label);
    } else {
      void this.hosts.setOn(row.device, on);
    }
  }

  protected setResolution(row: DeviceRow, value: string): void {
    const resolution = CAMERA_RESOLUTIONS.find((option) => option === value);
    if (resolution !== undefined) {
      this.prefs.setCameraMode(row.label, { ...row.mode, resolution });
    }
  }

  protected setFrameRate(row: DeviceRow, value: string): void {
    const frameRate = CAMERA_FRAME_RATES.find((option) => option === value);
    if (frameRate !== undefined) {
      this.prefs.setCameraMode(row.label, { ...row.mode, frameRate });
    }
  }

  protected setVideoQuality(value: string): void {
    const quality = VIDEO_QUALITIES.find((option) => option === value);
    if (quality !== undefined) {
      this.prefs.setVideoQuality(quality);
    }
  }

  protected setMicrophoneProcessing(value: string): void {
    const processing = MICROPHONE_PROCESSINGS.find((option) => option === value);
    if (processing !== undefined) {
      this.prefs.setMicrophoneProcessing(processing);
    }
  }

  /** Turn on (the first camera, with none on) or Turn off (all of them). */
  protected toggle(): void {
    if (this.prefs.cameraOn()) {
      this.camera.stop();
    } else {
      void this.camera.start();
    }
  }

  protected wholeFrame(camera: HostCamera): void {
    const size = camera.frameSize();
    if (size !== null) {
      camera.setFraming(fullFrame(size));
    }
  }
}
