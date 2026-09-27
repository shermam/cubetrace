import { Component, computed, effect, inject, viewChild, type ElementRef } from '@angular/core';
import { framingPercent } from '@cubetrace/capture';

import { StorageService } from '../device/storage-service';
import { SessionService } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { fpsText, sharpnessText } from './camera-format';
import { CameraService } from './camera-service';
import { RecordingService } from './recording-service';
import { showStream } from './video';

/** What the recording is doing, as the preview's status line says it. */
export type RecordingWord = 'idle' | 'starting' | 'recording' | 'saving' | 'stopped';

/**
 * The camera's picture beside the clock on the Timer page (docs/PLAN.md, T2.7), there whenever the
 * camera is on, whatever the attempt is doing, so that the solver sees that the cube is in frame:
 * a box of 16:9 (the frames fit inside it, a phone's upright ones between black bars), mirrored for
 * a front camera like the Camera settings' picture, with the framing rectangle drawn on it (it is
 * moved and resized in Camera settings), and under it one line: the frame rate measured, the
 * sharpness (green when good, amber when soft), what the recording is doing and how full storage
 * is. It measures the frames for `CameraService` (`watchPreview`), holding the sharpness meter while
 * an attempt is armed or solving, so that drawing a frame never delays a move of the solve.
 */
@Component({
  selector: 'app-camera-preview',
  host: { '[class.shown]': 'shown()' },
  template: `
    @if (shown()) {
      <div class="box" data-testid="camera-preview-box" [attr.data-status]="camera.status()">
        @if (camera.stream()) {
          <div class="frame" [class.mirrored]="camera.mirrored()" [style.--aspect]="aspect()">
            <video
              #video
              muted
              playsinline
              aria-label="Camera preview"
              data-testid="camera-preview"
            ></video>
            @if (box(); as area) {
              <div
                class="framing"
                aria-hidden="true"
                data-testid="camera-preview-framing"
                [style.left.%]="area.left"
                [style.top.%]="area.top"
                [style.width.%]="area.width"
                [style.height.%]="area.height"
              ></div>
            }
          </div>
        } @else if (camera.status() === 'starting') {
          <p class="message">Opening the camera…</p>
        } @else {
          <p class="message">The camera is not working: Camera settings says why.</p>
        }
      </div>
      @if (camera.stream()) {
        <!-- One line (it wraps on the narrowest phones), its parts kept whole. -->
        <p class="status" data-testid="camera-status">
          <span data-testid="camera-status-fps">{{ fps() }}</span> ·
          <span
            data-testid="camera-status-sharpness"
            [attr.data-good]="camera.sharpnessGood()"
            [title]="sharpnessTitle()"
            >sharpness
            <span class="value" [class.good]="camera.sharpnessGood()" [class.soft]="soft()">{{
              sharpness()
            }}</span></span
          >
          ·
          <span class="rec" data-testid="camera-status-recording" [attr.data-status]="recording()">
            @if (recording() === 'recording') {
              <span class="dot" aria-hidden="true"></span>
            }
            {{ recording() }}</span
          >
          @if (storagePercent(); as percent) {
            ·
            <span data-testid="camera-status-storage" [attr.data-level]="storage.level()"
              >storage {{ percent }}</span
            >
          }
        </p>
      }
    }
  `,
  styles: `
    :host {
      display: none;
    }

    :host(.shown) {
      display: grid;
      gap: var(--space-1);
      align-content: start;
    }

    p {
      margin: 0;
    }

    /* A fixed box of 16:9; the frames keep their proportions inside it (the framing rectangle is
       drawn in percent of them). */
    .box {
      display: grid;
      place-items: center;
      width: 100%;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border-radius: var(--radius);
      background: #000;
      container-type: size;
    }

    .frame {
      position: relative;
      width: min(100cqw, calc(100cqh * var(--aspect)));
      aspect-ratio: var(--aspect);
      overflow: hidden;

      &.mirrored {
        transform: scaleX(-1);
      }
    }

    video {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .framing {
      position: absolute;
      border: 2px solid var(--accent);
      /* Dims what lies outside the rectangle. */
      box-shadow: 0 0 0 100vmax rgb(0 0 0 / 35%);
      pointer-events: none;
    }

    .message {
      padding: var(--space-3);
      color: var(--text-muted);
      font-size: 0.875rem;
      text-align: center;
    }

    .status {
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;

      > span {
        white-space: nowrap;
      }
    }

    .value {
      font-family: var(--font-mono);

      &.good {
        color: var(--ok);
      }

      &.soft {
        color: var(--warn);
      }
    }

    .dot {
      display: inline-block;
      width: 0.5rem;
      height: 0.5rem;
      margin-right: var(--space-1);
      border-radius: 50%;
      background: var(--danger);
    }

    .rec {
      &[data-status='recording'],
      &[data-status='saving'] {
        color: var(--text);
      }

      &[data-status='stopped'] {
        color: var(--danger);
      }
    }

    [data-level='warn'] {
      color: var(--warn);
    }

    [data-level='full'] {
      color: var(--danger);
    }
  `,
})
export class CameraPreview {
  protected readonly camera = inject(CameraService);
  protected readonly storage = inject(StorageService);
  private readonly recorder = inject(RecordingService);
  private readonly session = inject(SessionService);
  private readonly prefs = inject(SettingsService);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  /** While the camera is wanted: on, opening, or not working. */
  protected readonly shown = computed(() => this.camera.status() !== 'off');
  /** The sharpness meter waits while the time of a move is the solve's. */
  private readonly held = computed(() => {
    const phase = this.session.phase();
    return phase === 'armed' || phase === 'solving';
  });
  /** The frames' proportions, 16:9 until they are known. */
  protected readonly aspect = computed(() => {
    const size = this.camera.frameSize();
    return size === null ? 16 / 9 : size.width / size.height;
  });
  /** The framing rectangle, in percent of the frame. */
  protected readonly box = computed(() => {
    const rect = this.camera.framing();
    const size = this.camera.frameSize();
    return rect === null || size === null ? null : framingPercent(rect, size);
  });
  protected readonly fps = computed(() => {
    const fps = this.camera.measuredFps();
    return fps === null ? '– fps' : fpsText(fps);
  });
  protected readonly sharpness = computed(() => {
    const value = this.camera.sharpness();
    return value === null ? '–' : sharpnessText(value);
  });
  protected readonly soft = computed(
    () => this.camera.sharpness() !== null && !this.camera.sharpnessGood(),
  );
  protected readonly sharpnessTitle = computed(() => {
    const threshold = String(this.prefs.sharpnessThreshold());
    if (this.camera.sharpness() === null) {
      return 'Sharpness of the framing rectangle: not measured yet.';
    }
    return this.camera.sharpnessGood()
      ? `Sharpness of the framing rectangle: good (${threshold} or more, Settings).`
      : `Sharpness of the framing rectangle: soft (under ${threshold}, Settings).`;
  });
  protected readonly recording = computed((): RecordingWord => {
    if (this.recorder.savingClips() > 0) {
      return 'saving';
    }
    switch (this.recorder.status()) {
      case 'off':
        return 'idle';
      case 'starting':
        return 'starting';
      case 'recording':
        return 'recording';
      case 'error':
        return 'stopped';
    }
  });
  /** "12%": whole percents, down, as the storage meter says it; null while unknown. */
  protected readonly storagePercent = computed(() => {
    const percent = this.storage.percent();
    return percent === null ? null : `${String(Math.floor(percent))}%`;
  });

  constructor() {
    // The preview plays the camera's stream, and the service measures its frames.
    effect((onCleanup) => {
      const video = this.video()?.nativeElement;
      const stream = this.camera.stream();
      if (video === undefined || stream === null) {
        return;
      }
      const release = showStream(video, stream);
      const stop = this.camera.watchPreview(video, () => this.held());
      onCleanup(() => {
        stop();
        release();
      });
    });
  }
}
