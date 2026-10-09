import {
  Component,
  computed,
  effect,
  inject,
  input,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { framingPercent } from '@cubetrace/capture';

import { StorageService } from '../device/storage-service';
import { SessionService } from '../session/session-service';
import { SettingsService, type RemotePictures } from '../settings/settings-service';
import { fpsText, sharpnessText } from './camera-format';
import { CameraService } from './camera-service';
import { driftWords } from './controls-source';
import { RecordingService } from './recording-service';
import { RemoteCameraRegistry } from './remote-camera-registry';
import { RemotePreviews } from './remote-previews';
import { SyncCheck } from './sync-check';
import { showStream } from './video';

/** What the recording is doing, as the preview's status line says it. */
export type RecordingWord = 'idle' | 'starting' | 'recording' | 'saving' | 'stopped';

/**
 * The camera's picture beside the clock on the Timer page (docs/PLAN.md, T2.7), there whenever the
 * camera is on, whatever the attempt is doing, so that the solver sees that the cube is in frame:
 * a box of 16:9 (the frames fit inside it, a phone's upright ones between black bars), mirrored for
 * a front camera like the Camera settings' picture, with the framing rectangle drawn on it (it is
 * moved and resized in Camera settings), and under it one line: the frame rate measured, the
 * sharpness (green when good, amber when soft), what the recording is doing, how full storage
 * is and, in red, a mode the camera changed by itself (T5.2: "focus went manual"). It measures the frames for `CameraService` (`watchPreview`), holding the sharpness meter while
 * an attempt is armed or solving, so that drawing a frame never delays a move of the solve. Under
 * them, the sync check (T2.5, `SyncCheck`): its countdown and its result are where the solver looks
 * while turning the cube in front of the camera. On a phone with the scramble over the picture
 * (`overlay`, T2.13), the Timer page pins it at the top of the window: the picture fills the width
 * it is given at the frames' proportions, up to 42% of the window's height, its line sits over its
 * top left corner, and the sync check is the Timer page's to show, under the time, out of the
 * pinned part. Since T4.3 the phones paired as remote cameras show with it (`RemotePreviews`, issue
 * #60: the thumbnail at the bottom of Camera settings was too far from the preview to keep the cube in
 * a phone's frame), their code loaded only once a phone is paired, in one of two layouts
 * (`pictures`, "Pictures from phones", T5.1): `equal`, each phone's picture in a cell of its own as
 * large as this device's, with the phone's status line under it, the cells under one another in a
 * grid whose columns the Timer page sets (`--picture-columns`: two where its column is wide enough
 * beside the clock; the host's class `many` says there are two pictures or more), without this
 * device's own cell while its camera is off; `tiles` (T4.3), a small tile each over the top right
 * corner of this device's picture, which a tap swaps with the main picture, the first phone's picture
 * the main one without this device's camera. A phone's overlay always has tiles.
 */
@Component({
  selector: 'app-camera-preview',
  imports: [RemotePreviews, SyncCheck],
  host: {
    '[class.shown]': 'shown()',
    '[class.overlay]': 'overlay()',
    '[class.equal]': 'equal()',
    '[class.many]': 'many()',
    '[attr.data-pictures]': "equal() ? 'equal' : 'tiles'",
  },
  template: `
    @if (shown()) {
      <!-- With equal pictures, a grid of cells: this device's and each phone's (T5.1). Otherwise its
           wrappers are no boxes at all: the box and the line are the host's items, as before. -->
      <div class="cells" data-testid="camera-cells">
        @if (ownCell()) {
          <div class="cell" data-testid="camera-cell">
            <div
              class="box"
              data-testid="camera-preview-box"
              [attr.data-status]="camera.status()"
              [style.--aspect]="aspect()"
            >
              @if (camera.stream()) {
                <div class="frame" [class.mirrored]="camera.mirrored()">
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
              } @else if (camera.status() === 'error') {
                <p class="message">The camera is not working: Camera settings says why.</p>
              }
              @if (!equal()) {
                @defer (when remotes()) {
                  @if (remotes()) {
                    <app-remote-previews
                      layout="tiles"
                      [local]="camera.stream()"
                      [mirrored]="camera.mirrored()"
                      [localAspect]="aspect()"
                    />
                  }
                }
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
                <span
                  class="rec"
                  data-testid="camera-status-recording"
                  [attr.data-status]="recording()"
                >
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
                @for (words of drift(); track words) {
                  ·
                  <span class="drift" data-testid="camera-status-drift">{{ words }}</span>
                }
              </p>
            }
          </div>
        }
        @if (equal()) {
          @defer (when remotes()) {
            @if (remotes()) {
              <app-remote-previews layout="equal" />
            }
          }
        }
      </div>
      @if (!overlay()) {
        <app-sync-check />
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

    /* Without equal pictures, no boxes: the box and the line are the host's items (T4.3's layout). */
    .cells,
    .cell {
      display: contents;
    }

    /* Equal pictures (T5.1): a cell each, the box and its line, in as many columns as the Timer page
       gives (one by default), all of one width: the boxes are the same size. */
    :host(.equal) {
      .cells {
        display: grid;
        grid-template-columns: repeat(var(--picture-columns, 1), minmax(0, 1fr));
        gap: var(--space-2);
        align-items: start;
      }

      .cell {
        display: grid;
        gap: var(--space-1);
        align-content: start;
        min-width: 0;
      }
    }

    /* A fixed box of 16:9; the frames keep their proportions inside it (the framing rectangle is
       drawn in percent of them). */
    .box {
      position: relative;
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

    .drift {
      color: var(--danger);
    }

    /* Pinned at the top of a phone's Timer page, the scramble over its lower part (T2.13): the
       frames' proportions rather than 16:9, so that nothing but a phone's upright frames needs bars,
       and the line over the picture, small and on a dark ground of its own. */
    :host(.overlay.shown) {
      display: block;
      position: relative;
    }

    :host(.overlay) {
      .box {
        aspect-ratio: var(--aspect);
        max-height: 42svh;
        border-radius: 0;
      }

      /* Above the scramble. */
      .message {
        align-self: start;
      }

      .status {
        position: absolute;
        top: var(--space-2);
        left: var(--space-2);
        max-width: calc(100% - 2 * var(--space-2));
        padding: 0 var(--space-2);
        border-radius: var(--radius);
        background: rgb(0 0 0 / 55%);
        color: rgb(255 255 255 / 85%);
        font-size: 0.75rem;
      }
    }
  `,
})
export class CameraPreview {
  /** Pinned at the top of a phone's Timer page with the scramble over it (T2.13). */
  readonly overlay = input(false);
  /**
   * How the phones' pictures show (T5.1, the Timer page's `remotePicturesLayout`): as large as this
   * device's own, in cells, or as tiles over it; tiles in the overlay whatever this says.
   */
  readonly pictures = input<RemotePictures>('tiles');
  protected readonly camera = inject(CameraService);
  protected readonly storage = inject(StorageService);
  private readonly recorder = inject(RecordingService);
  private readonly session = inject(SessionService);
  private readonly prefs = inject(SettingsService);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  private readonly registry = inject(RemoteCameraRegistry);

  /** A phone paired as a remote camera has a camera (T4.3): its tile shows over the picture. */
  protected readonly remotes = computed(() =>
    this.registry.cameras().some((camera) => camera.label !== null),
  );
  /** While the camera is wanted (on, opening, or not working), or a phone's picture is there. */
  protected readonly shown = computed(() => this.camera.status() !== 'off' || this.remotes());
  /** The phones' pictures in cells as large as this device's own (T5.1). */
  protected readonly equal = computed(() => this.pictures() === 'equal' && !this.overlay());
  /**
   * This device's own cell: with tiles, always (its box holds the main picture, a phone's without
   * this device's camera); with equal pictures, while its camera is wanted.
   */
  protected readonly ownCell = computed(() => !this.equal() || this.camera.status() !== 'off');
  /** Two pictures or more in cells: the Timer page sets them side by side where it is wide. */
  protected readonly many = computed(() => {
    if (!this.equal()) {
      return false;
    }
    const phones = this.registry.cameras().filter((camera) => camera.label !== null).length;
    return (this.ownCell() ? 1 : 0) + phones > 1;
  });
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
  /**
   * What the camera changed by itself and still differs (T5.2, the watchdog): "focus went manual",
   * in red, a part per control, as a phone's line says its own.
   */
  protected readonly drift = computed(() => this.camera.drift().map((drift) => driftWords(drift)));
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
