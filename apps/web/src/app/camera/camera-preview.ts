import { Component, computed, inject, input } from '@angular/core';
import { framingPercent } from '@cubetrace/capture';

import { StorageService } from '../device/storage-service';
import { SessionService } from '../session/session-service';
import { SettingsService, type RemotePictures } from '../settings/settings-service';
import { cameraName } from '../shared/camera-name';
import { fpsText, sharpnessText } from './camera-format';
import { CameraVideo } from './camera-video';
import { driftWords } from './controls-source';
import type { HostCamera } from './host-camera';
import { HostCamerasService } from './host-cameras-service';
import {
  MOTION_LAG_LIMIT_MS,
  latencyWords,
  motionLagOff,
  motionLagWords,
  solveClipOf,
} from './latency-words';
import { RecordingService } from './recording-service';
import { RemoteCameraRegistry } from './remote-camera-registry';
import { RemotePreviews } from './remote-previews';
import { SyncCheck } from './sync-check';

/** What the recording is doing, as the preview's status line says it. */
export type RecordingWord = 'idle' | 'starting' | 'recording' | 'saving' | 'stopped';

/** A framing rectangle in percent of the frame, as the preview draws it. */
interface FramingBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One of the host's cameras as its cell shows it (T5.5: a cell per camera). */
interface CellView {
  readonly camera: HostCamera;
  /** Its label in the session (`laptop`, `laptop-2`); null while it is not open. */
  readonly label: string | null;
  /** Its name on its picture: "laptop-2 · FaceTime HD Camera". */
  readonly name: string;
  /** Its frames' proportions, 16:9 until they are known. */
  readonly aspect: number;
  /** Its framing rectangle in percent of the frame. */
  readonly box: FramingBox | null;
  readonly fps: string;
  readonly sharpness: string;
  readonly good: boolean;
  readonly soft: boolean;
  readonly sharpnessTitle: string;
  readonly recording: RecordingWord;
  /** What its camera changed by itself (T5.2), a part each, in red. */
  readonly drift: readonly string[];
  /** Its capture latency's drift from its check (T5.3), "latency +75 ms"; null otherwise. */
  readonly latency: string | null;
  /** Its recording started again for its drifting latency (T5.3). */
  readonly restarted: boolean;
  /** Its last solve clip's motion lag far from its check's (T5.3); null otherwise. */
  readonly motionLag: string | null;
  /** It records under 80% of its frame rate with several cameras (T5.5): "encodes 21 of 30 fps". */
  readonly load: string | null;
}

/**
 * The cameras' pictures beside the clock on the Timer page (docs/PLAN.md, T2.7), there whenever a
 * camera is on, whatever the attempt is doing, so that the solver sees that the cube is in frame:
 * since T5.5 a cell for each of the host's cameras (`HostCamerasService.cameras`: the laptop's
 * built-in camera and a USB webcam), each a box of 16:9 (the frames fit inside it, a phone's upright
 * ones between black bars), mirrored for a front camera like the Camera settings' picture, with its
 * framing rectangle drawn on it (it is moved and resized in Camera settings), its name over its
 * corner when there are several pictures ("laptop-2 · FaceTime HD Camera"), and under it one line:
 * the frame rate measured, the sharpness (green when good, amber when soft), what its recording is
 * doing, how full storage is and, in red, a mode the camera changed by itself (T5.2: "focus went
 * manual"); in amber, the capture latency's drift from the camera's sync check (T5.3: `latency +75
 * ms`), `restarted` when the recording started again for it, the last solve clip's motion lag when
 * it sits more than 30 ms from the check's (T5.3: `motion lag 133 ms (check 58)`), and the frames
 * it encodes when they are under 80% of its rate with several cameras recording (T5.5: `encodes 21
 * of 30 fps`). Each picture measures its camera's frames (`CameraVideo`), holding the sharpness
 * meter while an attempt is armed or solving, so that drawing a frame never delays a move of the
 * solve. Under them, the sync check (T2.5, `SyncCheck`), a line per camera: its countdown and its
 * result are where the solver looks while turning the cube in front of the cameras. On a phone with
 * the scramble over the picture (`overlay`, T2.13), the Timer page pins the first camera's picture
 * at the top of the window: the picture fills the width it is given at the frames' proportions, up
 * to 42% of the window's height, its line sits over its top left corner, and the sync check is the
 * Timer page's to show, under the time, out of the pinned part. Since T4.3 the phones paired as
 * remote cameras show with them (`RemotePreviews`, issue #60), their code loaded only once a phone is
 * paired, in one of two layouts (`pictures`, "Pictures from phones", T5.1): `equal`, each phone's
 * picture in a cell of its own as large as the host's, after the host's cameras' cells, with the
 * phone's status line under it, the cells in a grid whose columns the Timer page sets
 * (`--picture-columns`: two where its column is wide enough beside the clock; the host's class
 * `many` says there are two pictures or more); `tiles` (T4.3), a small tile each over the top right
 * corner of the first camera's picture, which a tap swaps with the main picture, the first phone's
 * picture the main one without a camera of the host's own. A phone's overlay always has tiles.
 */
@Component({
  selector: 'app-camera-preview',
  imports: [CameraVideo, RemotePreviews, SyncCheck],
  host: {
    '[class.shown]': 'shown()',
    '[class.overlay]': 'overlay()',
    '[class.equal]': 'equal()',
    '[class.many]': 'many()',
    '[attr.data-pictures]': "equal() ? 'equal' : 'tiles'",
  },
  template: `
    @if (shown()) {
      <!-- With equal pictures, a grid of cells: one per camera of this device (T5.5), then each
           phone's (T5.1). Otherwise its wrappers are no boxes at all: the boxes and the lines are
           the host's items, as before. -->
      <div class="cells" data-testid="camera-cells">
        @for (cell of cells(); track cell.camera; let first = $first) {
          <div class="cell" data-testid="camera-cell" [attr.data-label]="cell.label">
            <div
              class="box"
              data-testid="camera-preview-box"
              [attr.data-status]="cell.camera.status()"
              [style.--aspect]="cell.aspect"
            >
              @if (cell.camera.stream()) {
                <div class="frame" [class.mirrored]="cell.camera.mirrored()">
                  <video
                    muted
                    playsinline
                    aria-label="Camera preview"
                    data-testid="camera-preview"
                    [appCameraVideo]="cell.camera"
                    [held]="held"
                  ></video>
                  @if (cell.box; as area) {
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
              } @else if (cell.camera.status() === 'starting') {
                <p class="message">Opening the camera…</p>
              } @else if (cell.camera.status() === 'error') {
                <p class="message">The camera is not working: Camera settings says why.</p>
              }
              @if (captioned()) {
                <span class="caption" data-testid="camera-preview-name">{{ cell.name }}</span>
              }
              @if (first && !equal()) {
                @defer (when remotes()) {
                  @if (remotes()) {
                    <app-remote-previews
                      layout="tiles"
                      [local]="cell.camera.stream()"
                      [mirrored]="cell.camera.mirrored()"
                      [localAspect]="cell.aspect"
                    />
                  }
                }
              }
            </div>
            @if (cell.camera.stream()) {
              <!-- One line (it wraps on the narrowest phones), its parts kept whole. -->
              <p class="status" data-testid="camera-status" [attr.data-label]="cell.label">
                <span data-testid="camera-status-fps">{{ cell.fps }}</span> ·
                <span
                  data-testid="camera-status-sharpness"
                  [attr.data-good]="cell.good"
                  [title]="cell.sharpnessTitle"
                  >sharpness
                  <span class="value" [class.good]="cell.good" [class.soft]="cell.soft">{{
                    cell.sharpness
                  }}</span></span
                >
                ·
                <span
                  class="rec"
                  data-testid="camera-status-recording"
                  [attr.data-status]="cell.recording"
                >
                  @if (cell.recording === 'recording') {
                    <span class="dot" aria-hidden="true"></span>
                  }
                  {{ cell.recording }}</span
                >
                @if (storagePercent(); as percent) {
                  ·
                  <span data-testid="camera-status-storage" [attr.data-level]="storage.level()"
                    >storage {{ percent }}</span
                  >
                }
                @for (words of cell.drift; track $index) {
                  ·
                  <span class="drift" data-testid="camera-status-drift">{{ words }}</span>
                }
                @if (cell.latency; as words) {
                  ·
                  <span
                    class="warn"
                    data-testid="camera-status-latency"
                    title="The camera's frames reach the recording this much later than when its sync check ran, for 5 s and more: the clips' labels would be late by as much. A sync check measures the lag again."
                    >{{ words }}</span
                  >
                }
                @if (cell.restarted) {
                  ·
                  <span
                    class="warn"
                    data-testid="camera-status-restarted"
                    title="The recording started again after the last solve: its latency had drifted for a whole attempt (Settings → Camera)."
                    >restarted</span
                  >
                }
                @if (cell.motionLag; as words) {
                  ·
                  <span
                    class="warn"
                    data-testid="camera-status-motion-lag"
                    [title]="motionLagTitle"
                    >{{ words }}</span
                  >
                }
                @if (cell.load; as words) {
                  ·
                  <span class="warn" data-testid="camera-status-load" [title]="loadTitle">{{
                    words
                  }}</span>
                }
              </p>
            }
          </div>
        } @empty {
          @if (!equal()) {
            <!-- No camera of this device: the box of the main picture, a phone's (T4.3). -->
            <div class="cell" data-testid="camera-cell">
              <div class="box" data-testid="camera-preview-box" data-status="off">
                @defer (when remotes()) {
                  @if (remotes()) {
                    <app-remote-previews layout="tiles" [local]="null" />
                  }
                }
              </div>
            </div>
          }
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

    /* A camera's name over its picture's corner, as a phone's picture has its own (T5.5). */
    .caption {
      position: absolute;
      top: var(--space-1);
      left: var(--space-1);
      padding: 0 var(--space-1);
      border-radius: var(--radius);
      background: rgb(0 0 0 / 55%);
      color: rgb(255 255 255 / 90%);
      font-size: 0.6875rem;
      line-height: 1.5;
      pointer-events: none;
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

    .warn {
      color: var(--warn);
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
  protected readonly storage = inject(StorageService);
  private readonly hosts = inject(HostCamerasService);
  private readonly recorder = inject(RecordingService);
  private readonly session = inject(SessionService);
  private readonly prefs = inject(SettingsService);
  private readonly registry = inject(RemoteCameraRegistry);

  /** A phone paired as a remote camera has a camera (T4.3): its picture shows with the host's. */
  protected readonly remotes = computed(() =>
    this.registry.cameras().some((camera) => camera.label !== null),
  );
  /** The phones' pictures in cells as large as this device's own (T5.1). */
  protected readonly equal = computed(() => this.pictures() === 'equal' && !this.overlay());
  /** The cameras of this device that show: all of them, the first one alone in the overlay. */
  private readonly cameras = computed(() => {
    const cameras = this.hosts.cameras();
    return this.overlay() ? cameras.slice(0, 1) : cameras;
  });
  /** While a camera of this device is wanted (on, opening, or not working), or a phone's picture is there. */
  protected readonly shown = computed(() => this.cameras().length > 0 || this.remotes());
  /** Two pictures or more in cells: the Timer page sets them side by side where it is wide. */
  protected readonly many = computed(() => {
    if (!this.equal()) {
      return false;
    }
    const phones = this.registry.cameras().filter((camera) => camera.label !== null).length;
    return this.cameras().length + phones > 1;
  });
  /** The pictures are named (T5.5): this device's cameras when there are two pictures or more. */
  protected readonly captioned = computed(
    () =>
      this.cameras().length > 1 || (this.equal() && this.remotes() && this.cameras().length > 0),
  );
  /** The sharpness meter waits while the time of a move is the solve's. */
  protected readonly held = (): boolean => {
    const phase = this.session.phase();
    return phase === 'armed' || phase === 'solving';
  };
  /** "12%": whole percents, down, as the storage meter says it; null while unknown. */
  protected readonly storagePercent = computed(() => {
    const percent = this.storage.percent();
    return percent === null ? null : `${String(Math.floor(percent))}%`;
  });
  /** Each camera's cell, in the cameras' order. */
  protected readonly cells = computed<readonly CellView[]>(() => {
    const threshold = this.prefs.sharpnessThreshold();
    const last = this.session.lastResult();
    const devices = this.hosts.devices();
    return this.cameras().map((camera) => {
      const label = this.recorder.labelOf(camera);
      const recording = this.recorder.recordingOf(camera);
      const size = camera.frameSize();
      const rect = camera.framing();
      const fps = camera.measuredFps();
      const sharpness = camera.sharpness();
      const good = camera.sharpnessGood();
      const device = devices.find((one) => one.deviceId === camera.deviceId());
      const drift = recording?.latencyDrift() ?? null;
      const off = motionLagOff(solveClipOf(last, label));
      const load = recording?.load() ?? null;
      return {
        camera,
        label,
        name: cameraName(label ?? 'camera', device?.name ?? camera.label()),
        aspect: size === null ? 16 / 9 : size.width / size.height,
        box: rect === null || size === null ? null : framingPercent(rect, size),
        fps: fps === null ? '– fps' : fpsText(fps),
        sharpness: sharpness === null ? '–' : sharpnessText(sharpness),
        good,
        soft: sharpness !== null && !good,
        sharpnessTitle:
          sharpness === null
            ? 'Sharpness of the framing rectangle: not measured yet.'
            : good
              ? `Sharpness of the framing rectangle: good (${String(threshold)} or more, Settings).`
              : `Sharpness of the framing rectangle: soft (under ${String(threshold)}, Settings).`,
        recording: recordingWord(recording?.status() ?? 'off', (recording?.savingClips() ?? 0) > 0),
        drift: camera.drift().map((one) => driftWords(one)),
        latency: drift === null ? null : latencyWords(drift),
        restarted: (recording?.restarted() ?? null) !== null,
        motionLag: off === null ? null : motionLagWords(off),
        load:
          load === null
            ? null
            : `encodes ${String(Math.round(load.encodedFps))} of ${String(Math.round(load.nominalFps))} fps`,
      };
    });
  });
  protected readonly motionLagTitle =
    `In the last solve the camera's picture lagged the cube by this much by the motion around its ` +
    `turns, more than ${String(MOTION_LAG_LIMIT_MS)} ms from its sync check's: the clip keeps both. ` +
    'A sync check measures the lag again.';
  protected readonly loadTitle =
    'This camera records fewer frames than its rate while several cameras record (for 10 s and ' +
    'more): the laptop may not encode them all. Turn one off, or lower its resolution (Camera settings).';
}

/** What a camera's recording is doing, as its line says it. */
function recordingWord(
  status: 'off' | 'starting' | 'recording' | 'error',
  saving: boolean,
): RecordingWord {
  if (saving) {
    return 'saving';
  }
  switch (status) {
    case 'off':
      return 'idle';
    case 'starting':
      return 'starting';
    case 'recording':
      return 'recording';
    case 'error':
      return 'stopped';
  }
}
