import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { fullFrame } from '@cubetrace/capture';

import {
  CAMERA_FRAME_RATES,
  CAMERA_FRAME_RATE_TEXT,
  CAMERA_RESOLUTIONS,
  CAMERA_RESOLUTION_TEXT,
  MICROPHONE_HINT,
  MICROPHONE_PROCESSINGS,
  MICROPHONE_PROCESSING_TEXT,
  SettingsService,
  VIDEO_QUALITIES,
} from '../settings/settings-service';
import { AuthService } from '../auth/auth-service';
import { SessionService } from '../session/session-service';
import { fpsText, framingText, sizeText, trackText } from './camera-format';
import { CameraControls } from './camera-controls';
import { CameraService } from './camera-service';
import { FramingEditor } from './framing-editor';
import { PAIRING_BLOCK_TEXT } from './pairing-block';
import { RecordingPanel } from './recording-panel';
import { RecordingService } from './recording-service';
import { RemoteCameras } from './remote-cameras';
import { SharpnessMeter } from './sharpness-meter';
import { videoQualityOptions } from './video-quality';

/**
 * The Camera settings of the Timer page (docs/PLAN.md, T2.1; a disclosure since T2.7, whose
 * `CameraPreview` shows the picture beside the clock): the cameras of this device to choose from
 * (front and rear on a phone), Turn on / Turn off (kept across loads), what the track claims next to
 * what the preview measures (a phone may claim 60 fps and deliver 30), the framing rectangle, which
 * Edit shows over a larger picture of the camera (mirrored for a front camera, like a mirror; the
 * frames are not; drag the rectangle to move it, drag a corner to resize it, by mouse or touch; the
 * arrow keys move it and Shift + arrows resize it; kept per camera), the sharpness meter, the
 * camera's manual controls, the resolution, frame rate, video quality (T2.10), audio and microphone
 * (raw or voice, T2.12) of Settings, and in plain words why the camera did not open or opened
 * otherwise than asked; below them, the recording (T2.4, `RecordingPanel`), which this panel's
 * `RecordingService` runs from the moment the Timer page loads it.
 *
 * Closed at first; the first time the camera is on it opens by itself, so that its controls are
 * found, and from then on it stays as it was left (Settings keeps it). The larger picture
 * (`FramingEditor`) is there only while the framing is edited and the panel is open: a second picture
 * of the camera costs the page some work on every frame. Since T4.1 the panel ends with the Cameras
 * section (`RemoteCameras`, the phones that film for this host), a deferred block loaded when Add
 * camera is first pressed (`addRequests`, which the section reads to start the pairing as it
 * appears), so that a session without remote cameras downloads nothing of it.
 */
@Component({
  selector: 'app-camera-panel',
  imports: [CameraControls, FramingEditor, RecordingPanel, RemoteCameras, SharpnessMeter],
  templateUrl: './camera-panel.html',
  styleUrl: './camera-panel.scss',
})
export class CameraPanel {
  protected readonly camera = inject(CameraService);
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
   * The framing rectangle is being edited, over the larger picture: by Edit here, or by the sync
   * check's "Edit the framing" under the preview (T2.8), which opens these settings to it.
   */
  protected readonly editing = this.camera.framingEditing;
  protected readonly resolutions = CAMERA_RESOLUTIONS.map((value) => ({
    value,
    label: CAMERA_RESOLUTION_TEXT[value],
  }));
  protected readonly frameRates = CAMERA_FRAME_RATES.map((value) => ({
    value,
    label: CAMERA_FRAME_RATE_TEXT[value],
  }));
  /** Each quality with its bitrate and size per attempt at the resolution and frame rate chosen. */
  protected readonly qualities = computed(() =>
    videoQualityOptions(this.prefs.cameraResolution(), this.prefs.cameraFrameRate()),
  );
  protected readonly microphoneProcessings = MICROPHONE_PROCESSINGS.map((value) => ({
    value,
    label: MICROPHONE_PROCESSING_TEXT[value],
  }));
  protected readonly microphoneHint = MICROPHONE_HINT;

  protected readonly summary = computed(() => {
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
          this.recording.status() === 'recording' ? 'recording' : null,
        ];
        return parts.filter((part) => part !== null).join(' · ') || 'On';
      }
    }
  });
  /** What the track claims: "1920×1080 at 60 fps". */
  protected readonly track = computed(() => trackText(this.camera.settings()) ?? 'unknown');
  /** What the preview measures: "30.0 fps, frames 1080×1920". */
  protected readonly measured = computed(() => {
    const problem = this.camera.frameProblem();
    if (problem !== null) {
      return problem;
    }
    const fps = this.camera.measuredFps();
    const size = this.camera.frameSize();
    return fps === null
      ? 'measuring…'
      : `${fpsText(fps)}${size === null ? '' : `, frames ${sizeText(size)}`}`;
  });
  protected readonly framingLine = computed(() => {
    const rect = this.camera.framing();
    const size = this.camera.frameSize();
    return rect === null || size === null ? '' : framingText(rect, size);
  });
  protected readonly threshold = this.prefs.sharpnessThreshold;

  constructor() {
    // The first time the camera is on (on this device), the settings open by themselves.
    effect(() => {
      if (this.camera.status() !== 'off' && this.prefs.cameraSettingsOpen() === null) {
        untracked(() => {
          this.setOpen(true);
        });
      }
    });
    // Asked to edit the framing from elsewhere (the sync check): the settings open to the editor.
    effect(() => {
      if (this.camera.framingEditing() && !untracked(() => this.open())) {
        untracked(() => {
          this.setOpen(true);
        });
      }
    });
    // Leaving the page closes the editor, as it was before the editor could be asked for.
    inject(DestroyRef).onDestroy(() => {
      this.camera.setFramingEditing(false);
    });
  }

  /** Edit or Done: the framing rectangle's editor opened or closed. */
  protected toggleEditing(): void {
    this.camera.setFramingEditing(!this.editing());
  }

  /** The disclosure was opened or closed: kept for the next loads. */
  protected setOpen(open: boolean): void {
    this.open.set(open);
    this.prefs.setCameraSettingsOpen(open);
  }

  protected setResolution(value: string): void {
    const resolution = CAMERA_RESOLUTIONS.find((option) => option === value);
    if (resolution !== undefined) {
      this.prefs.setCameraResolution(resolution);
    }
  }

  protected setFrameRate(value: string): void {
    const rate = CAMERA_FRAME_RATES.find((option) => option === value);
    if (rate !== undefined) {
      this.prefs.setCameraFrameRate(rate);
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

  protected toggle(): void {
    if (this.camera.status() === 'off') {
      void this.camera.start();
    } else {
      this.camera.stop();
    }
  }

  protected select(deviceId: string): void {
    void this.camera.select(deviceId);
  }

  protected wholeFrame(): void {
    const size = this.camera.frameSize();
    if (size !== null) {
      this.camera.setFraming(fullFrame(size));
    }
  }
}
