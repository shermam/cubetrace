import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  type ElementRef,
} from '@angular/core';
import {
  dragFraming,
  framingPercent,
  fullFrame,
  grabAt,
  previewDeltaToFrame,
  previewToFrame,
  type FrameSize,
  type FramingGrab,
  type FramingHandle,
  type FramingRect,
  type PreviewBox,
} from '@cubetrace/capture';

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
import {
  fpsText,
  framingText,
  sharpnessBar,
  sharpnessText,
  sizeText,
  trackText,
} from './camera-format';
import { CameraControls } from './camera-controls';
import { CameraService } from './camera-service';
import { RecordingPanel } from './recording-panel';
import { RecordingService } from './recording-service';
import { showStream } from './video';
import { videoQualityOptions } from './video-quality';

/** A corner is taken hold of within this many CSS pixels of it (a finger's width). */
const HANDLE_REACH_PX = 24;

/** The arrow keys move the framing rectangle by this fraction of the frame's shorter side. */
const KEY_STEP_FRACTION = 0.02;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** A drag of the framing rectangle under way. */
interface Drag {
  readonly pointerId: number;
  readonly grab: FramingGrab;
  /** Where the pointer went down, in client pixels. */
  readonly x: number;
  readonly y: number;
  readonly rect: FramingRect;
  readonly box: PreviewBox;
  readonly size: FrameSize;
}

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
 * found, and from then on it stays as it was left (Settings keeps it). The larger picture is there
 * only while the framing is edited and the panel is open: a second picture of the camera costs the
 * page some work on every frame.
 */
@Component({
  selector: 'app-camera-panel',
  imports: [CameraControls, RecordingPanel],
  templateUrl: './camera-panel.html',
  styleUrl: './camera-panel.scss',
})
export class CameraPanel {
  protected readonly camera = inject(CameraService);
  private readonly recording = inject(RecordingService);
  protected readonly prefs = inject(SettingsService);
  private readonly picture = viewChild<ElementRef<HTMLVideoElement>>('picture');
  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  /** The rectangle while it is dragged; the stored one otherwise. */
  private readonly draft = signal<FramingRect | null>(null);
  private drag: Drag | null = null;

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

  protected readonly rect = computed(() => this.draft() ?? this.camera.framing());
  /** The rectangle over the larger picture, in percent of the frame. */
  protected readonly box = computed(() => {
    const rect = this.rect();
    const size = this.camera.frameSize();
    return rect === null || size === null ? null : framingPercent(rect, size);
  });
  /** The larger picture's proportions: the frames', 16:9 until they are known. */
  protected readonly aspect = computed(() => {
    const size = this.camera.frameSize();
    return size === null ? 16 / 9 : size.width / size.height;
  });
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
    const rect = this.rect();
    const size = this.camera.frameSize();
    return rect === null || size === null ? '' : framingText(rect, size);
  });
  protected readonly threshold = this.prefs.sharpnessThreshold;
  protected readonly sharpnessValue = computed(() => {
    const value = this.camera.sharpness();
    return value === null ? '–' : sharpnessText(value);
  });
  protected readonly bar = computed(() =>
    sharpnessBar(this.camera.sharpness() ?? 0, this.threshold()),
  );
  protected readonly thresholdBar = computed(() =>
    sharpnessBar(this.threshold(), this.threshold()),
  );
  protected readonly verdict = computed(() => {
    if (this.camera.sharpness() === null) {
      return '';
    }
    return this.camera.sharpnessGood() ? 'good' : 'soft';
  });

  constructor() {
    // The first time the camera is on (on this device), the settings open by themselves.
    effect(() => {
      if (this.camera.status() !== 'off' && this.prefs.cameraSettingsOpen() === null) {
        untracked(() => {
          this.setOpen(true);
        });
      }
    });
    // The picture for framing plays the camera's stream; the preview beside the clock measures it.
    effect((onCleanup) => {
      const video = this.picture()?.nativeElement;
      const stream = this.camera.stream();
      if (video !== undefined && stream !== null) {
        onCleanup(showStream(video, stream));
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
    // The editor's picture scrolled into view when it appears, so that the rectangle is at hand.
    effect(() => {
      const frame = this.frame()?.nativeElement;
      if (frame !== undefined && typeof frame.scrollIntoView === 'function') {
        frame.scrollIntoView({ block: 'nearest' });
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

  /** A pointer goes down on the rectangle: a corner resizes it, the inside moves it. */
  protected grab(event: PointerEvent): void {
    const rect = this.rect();
    const size = this.camera.frameSize();
    const frame = this.frame()?.nativeElement;
    if (rect === null || size === null || frame === undefined || event.button > 0) {
      return;
    }
    const bounds = frame.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }
    const box: PreviewBox = {
      width: bounds.width,
      height: bounds.height,
      mirrored: this.camera.mirrored(),
    };
    const point = previewToFrame(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      box,
      size,
    );
    const handle = handleOf(event.target);
    const reach = (HANDLE_REACH_PX / bounds.width) * size.width;
    const grab = handle ?? grabAt(rect, point, reach) ?? 'move';
    this.drag = {
      pointerId: event.pointerId,
      grab,
      x: event.clientX,
      y: event.clientY,
      rect,
      box,
      size,
    };
    this.draft.set(rect);
    const target = event.currentTarget;
    if (target instanceof Element) {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // No pointer capture (jsdom); the moves still arrive while the pointer stays on it.
      }
    }
    event.preventDefault();
  }

  protected move(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointerId) {
      return;
    }
    const delta = previewDeltaToFrame(
      { x: event.clientX - drag.x, y: event.clientY - drag.y },
      drag.box,
      drag.size,
    );
    this.draft.set(dragFraming(drag.rect, drag.grab, delta, drag.size));
  }

  /** The pointer goes up: the rectangle is kept; a cancelled drag puts it back. */
  protected release(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointerId) {
      return;
    }
    this.drag = null;
    const rect = this.draft();
    this.draft.set(null);
    if (rect !== null && event.type === 'pointerup') {
      this.camera.setFraming(rect);
    }
  }

  /** The arrow keys move the rectangle the way they point; with Shift they resize it. */
  protected nudge(event: KeyboardEvent): void {
    const arrow = ARROWS[event.key] as readonly [number, number] | undefined;
    const rect = this.rect();
    const size = this.camera.frameSize();
    if (arrow === undefined || rect === null || size === null) {
      return;
    }
    const step = Math.max(1, Math.round(Math.min(size.width, size.height) * KEY_STEP_FRACTION));
    const [x, y] = arrow;
    const next = event.shiftKey
      ? dragFraming(rect, 'se', { x: x * step, y: y * step }, size)
      : dragFraming(
          rect,
          'move',
          { x: (this.camera.mirrored() ? -x : x) * step, y: y * step },
          size,
        );
    this.camera.setFraming(next);
    event.preventDefault();
  }
}

/** The corner a handle element stands for (`data-handle`), if the pointer went down on one. */
function handleOf(target: EventTarget | null): FramingHandle | null {
  const handle = target instanceof HTMLElement ? target.dataset['handle'] : undefined;
  return handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se' ? handle : null;
}
