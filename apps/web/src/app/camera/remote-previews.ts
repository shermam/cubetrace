import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { framingPercent } from '@cubetrace/capture';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { SettingsService, type RemotePictures } from '../settings/settings-service';
import { RemoteCameraRegistry, type RemoteCameraEntry } from './remote-camera-registry';
import { remoteStatusLine, shortParts, type StatusPart } from './remote-status';
import { StatusParts } from './status-parts';
import { showStream } from './video';

/**
 * One remote camera's picture (T4.3): its live preview's video while the track flows (unmuted), the
 * latest thumbnail of the Cameras list otherwise, and its framing rectangle over it, in percent of
 * its frames, so that the cube can be kept inside it from the host. `full`, in a cell as large as the
 * host's own picture (T5.1), the rectangle is drawn as on the host's own, the rest of the frame
 * dimmed, and around the whole frame when the phone's rectangle is the whole frame.
 */
@Component({
  selector: 'app-remote-picture',
  host: { '[attr.data-live]': 'live()', '[class.full]': 'full()' },
  template: `
    <div class="frame" [style.--aspect]="aspect()">
      @if (stream()) {
        <video
          #video
          muted
          playsinline
          [class.hidden]="!live()"
          [attr.aria-label]="'Live picture of ' + camera().name"
          data-testid="remote-picture-video"
        ></video>
      }
      @if (!live()) {
        @if (camera().thumbnail; as url) {
          <img
            [src]="url"
            [alt]="'The latest picture of ' + camera().name"
            data-testid="remote-picture-thumbnail"
          />
        } @else {
          <span class="none" data-testid="remote-picture-none">no picture yet</span>
        }
      }
      @if (box(); as area) {
        <div
          class="framing"
          aria-hidden="true"
          data-testid="remote-picture-framing"
          [style.left.%]="area.left"
          [style.top.%]="area.top"
          [style.width.%]="area.width"
          [style.height.%]="area.height"
        ></div>
      }
    </div>
  `,
  styles: `
    :host {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      container-type: size;
      background: #000;
    }

    .frame {
      position: relative;
      width: min(100cqw, calc(100cqh * var(--aspect)));
      aspect-ratio: var(--aspect);
      overflow: hidden;
    }

    video,
    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .hidden {
      position: absolute;
      opacity: 0;
    }

    .none {
      display: grid;
      place-items: center;
      height: 100%;
      color: rgb(255 255 255 / 70%);
      font-size: 0.75rem;
    }

    .framing {
      position: absolute;
      border: 1px solid var(--accent);
      pointer-events: none;
    }

    /* As the host's own picture draws it (CameraPreview). */
    :host(.full) .framing {
      border-width: 2px;
      box-shadow: 0 0 0 100vmax rgb(0 0 0 / 35%);
    }
  `,
})
export class RemotePicture {
  readonly camera = input.required<RemoteCameraEntry>();
  /** In a cell as large as the host's own picture (T5.1): the framing drawn as there. */
  readonly full = input(false);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly flowing = signal(false);

  /** The live track, the same object as long as the connection is. */
  private readonly track = computed(() => this.camera().preview);
  /** A stream of the track for the video element; null without one (or a browser without streams). */
  protected readonly stream = computed(() => {
    const track = this.track();
    const Stream = this.globals.MediaStream;
    return track === null || Stream === undefined ? null : new Stream([track]);
  });
  /** The track flows: unmuted and live. */
  protected readonly live = computed(() => this.stream() !== null && this.flowing());
  /** The frames' proportions as the phone reports them, 16:9 until then. */
  protected readonly aspect = computed(() => {
    const frame = this.camera().frame;
    return frame === null ? 16 / 9 : frame.width / frame.height;
  });
  /** The framing rectangle in percent; the whole frame, drawn, in a full cell (as the host's own). */
  protected readonly box = computed(() => {
    const { framing, frame } = this.camera();
    if (frame === null) {
      return null;
    }
    if (framing === null) {
      return this.full() ? { left: 0, top: 0, width: 100, height: 100 } : null;
    }
    return framingPercent(framing, frame);
  });

  constructor() {
    effect((onCleanup) => {
      const track = this.track();
      if (track === null) {
        this.flowing.set(false);
        return;
      }
      const update = (): void => {
        this.flowing.set(!track.muted && track.readyState === 'live');
      };
      update();
      track.addEventListener('mute', update);
      track.addEventListener('unmute', update);
      track.addEventListener('ended', update);
      onCleanup(() => {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      });
    });
    effect((onCleanup) => {
      const video = this.video()?.nativeElement;
      const stream = this.stream();
      if (video === undefined || stream === null) {
        return;
      }
      onCleanup(showStream(video, stream));
    });
  }
}

/** How often the status lines look at the clock: a report that stops is said within a second. */
export const STATUS_TICK_MS = 1000;

/**
 * The live pictures of the host's remote cameras on the Timer page, in one of two layouts
 * ("Pictures from phones", T5.1, `remotePicturesLayout`):
 *
 * - `equal`: each phone's picture in a cell as large as the host's own (a box of 16:9, a phone's
 *   upright frames between bars, its framing rectangle drawn as on the host's), its label over the
 *   corner, and under it its status line, the twin of the host's own (`remoteStatusLine`: the frame
 *   rate, the sharpness against this device's threshold, the recording, the battery, the health, the
 *   connection, a report that stopped), so that a soft focus, a dropped frame rate, a low battery or
 *   a hot phone is seen at a glance. The host is `display: contents`: its cells are items of
 *   `CameraPreview`'s grid, beside the host's own, which the Timer page sets side by side where it is
 *   wide enough (issue: the owner's phone was "a tiny picture-in-picture image" on 2026-10-09).
 * - `tiles` (T4.3, issue #60), over the host's preview: a small tile per phone in the picture's top
 *   right corner, its caption saying in short what is wrong; a tap swaps it with the main picture
 *   (the phone's picture over the whole box, this device's in a tile); a tap on that tile swaps
 *   back. Without this device's camera, the first phone's picture is the main one.
 *
 * Each picture is the phone's live preview while it flows, its latest thumbnail otherwise
 * (`RemotePicture`). Loaded with the preview only once a phone is paired: the code of a session
 * without one is not downloaded.
 */
@Component({
  selector: 'app-remote-previews',
  imports: [RemotePicture, StatusParts],
  host: { '[class.equal]': "layout() === 'equal'" },
  template: `
    @if (layout() === 'equal') {
      @for (camera of cameras(); track camera.id) {
        <div class="cell" data-testid="remote-preview-cell" [attr.data-label]="camera.label">
          <div class="box" data-testid="remote-preview-box">
            <app-remote-picture [camera]="camera" [full]="true" />
            <span class="caption">{{ camera.label }}</span>
          </div>
          <p class="status" data-testid="remote-status" [attr.data-label]="camera.label">
            <app-status-parts [parts]="lineOf(camera)" testId="remote-status" />
          </p>
        </div>
      }
    } @else {
      @if (main(); as camera) {
        <div class="main" data-testid="remote-preview-main" [attr.data-label]="camera.label">
          <app-remote-picture [camera]="camera" />
          <span class="caption" data-testid="remote-caption">
            {{ camera.label }}
            @if (shortOf(camera); as parts) {
              <span aria-hidden="true">{{ ' · ' }}</span>
              <app-status-parts [parts]="parts" [short]="true" testId="remote-caption" />
            }
          </span>
        </div>
      }
      <div class="tiles">
        @if (main() !== null && local()) {
          <button
            type="button"
            class="tile"
            data-testid="remote-preview-local"
            aria-label="Show this device's camera as the main picture"
            [style.--aspect]="localAspect()"
            (click)="show(null)"
          >
            <span class="local" [class.mirrored]="mirrored()">
              <video #localVideo muted playsinline></video>
            </span>
          </button>
        }
        @for (camera of tiles(); track camera.id) {
          <button
            type="button"
            class="tile"
            data-testid="remote-preview-tile"
            [attr.data-label]="camera.label"
            [attr.aria-label]="'Show ' + (camera.label ?? camera.name) + ' as the main picture'"
            [style.--aspect]="aspectOf(camera)"
            (click)="show(camera.id)"
          >
            <app-remote-picture [camera]="camera" />
            <span class="caption" data-testid="remote-caption">
              {{ camera.label ?? camera.name }}
              @if (shortOf(camera); as parts) {
                <span aria-hidden="true">{{ ' · ' }}</span>
                <app-status-parts [parts]="parts" [short]="true" testId="remote-caption" />
              }
            </span>
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      container-type: size;
    }

    /* The cells join CameraPreview's grid, beside its own (T5.1). */
    :host(.equal) {
      display: contents;
    }

    .cell {
      display: grid;
      gap: var(--space-1);
      align-content: start;
      min-width: 0;
    }

    /* The box of the host's own picture (CameraPreview): 16:9, the frames inside it. */
    .box {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border-radius: var(--radius);
      background: #000;
    }

    .status {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
    }

    .main {
      position: absolute;
      inset: 0;
      pointer-events: auto;
    }

    .tiles {
      position: absolute;
      top: var(--space-1);
      right: var(--space-1);
      display: flex;
      flex-direction: row-reverse;
      gap: var(--space-1);
      max-width: calc(100% - 2 * var(--space-1));
    }

    .tile {
      position: relative;
      height: 34cqh;
      aspect-ratio: var(--aspect);
      max-width: 40cqw;
      padding: 0;
      overflow: hidden;
      border: 1px solid rgb(255 255 255 / 70%);
      border-radius: var(--radius);
      background: #000;
      cursor: pointer;
      pointer-events: auto;
    }

    .caption {
      position: absolute;
      bottom: 0;
      left: 0;
      padding: 0 var(--space-1);
      background: rgb(0 0 0 / 55%);
      color: rgb(255 255 255 / 90%);
      font-size: 0.6875rem;
      line-height: 1.5;
      text-align: left;
    }

    .main .caption,
    .box .caption {
      top: var(--space-1);
      bottom: auto;
      left: var(--space-1);
      border-radius: var(--radius);
    }

    .box app-remote-picture {
      position: absolute;
      inset: 0;
    }

    .local {
      display: block;
      width: 100%;
      height: 100%;

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
  `,
})
export class RemotePreviews {
  /** `equal` (cells beside the host's own) or `tiles` (over it), as the Timer page decides (T5.1). */
  readonly layout = input<RemotePictures>('tiles');
  /** This device's camera's stream, for its tile once a phone's is the main picture; null when off. */
  readonly local = input<MediaStream | null>(null);
  /** This device's picture is mirrored (a front camera), as its preview is. */
  readonly mirrored = input(false);
  /** This device's frames' proportions. */
  readonly localAspect = input(16 / 9);

  private readonly registry = inject(RemoteCameraRegistry);
  private readonly settings = inject(SettingsService);
  private readonly timers = inject(RTC_TIMERS);
  private readonly localVideo = viewChild<ElementRef<HTMLVideoElement>>('localVideo');
  /** The camera chosen as the main picture; null for this device's own. */
  private readonly chosen = signal<string | null>(null);
  /** The host clock, once a second while a phone is shown: how old each report is (T5.1). */
  private readonly now = signal(this.timers.now());

  /** The phones paired, with a camera. */
  protected readonly cameras = computed(() =>
    this.registry.cameras().filter((camera) => camera.label !== null),
  );
  /** A phone is shown: the status lines' clock runs. */
  private readonly shown = computed(() => this.cameras().length > 0);
  /** The phone shown as the main picture: the one chosen, or the first without a camera here. */
  protected readonly main = computed<RemoteCameraEntry | null>(() => {
    const cameras = this.cameras();
    const id = this.chosen();
    const chosen = id === null ? undefined : cameras.find((camera) => camera.id === id);
    if (chosen !== undefined) {
      return chosen;
    }
    return this.local() === null ? (cameras.at(0) ?? null) : null;
  });
  /** The phones in tiles: all but the main picture's. */
  protected readonly tiles = computed(() => {
    const main = this.main();
    return this.cameras().filter((camera) => camera.id !== main?.id);
  });
  /** Each phone's status line, by its id. */
  private readonly lines = computed(() => {
    const nowMs = this.now();
    const sharpnessThreshold = this.settings.sharpnessThreshold();
    return new Map(
      this.cameras().map((camera) => [
        camera.id,
        remoteStatusLine({
          report: camera.report,
          reportMs: camera.reportMs,
          nowMs,
          state: camera.state,
          sinceMs: camera.sinceMs,
          converged: camera.converged,
          sharpnessThreshold,
        }),
      ]),
    );
  });

  constructor() {
    effect((onCleanup) => {
      const video = this.localVideo()?.nativeElement;
      const stream = this.local();
      if (video === undefined || stream === null) {
        return;
      }
      onCleanup(showStream(video, stream));
    });
    // The clock of the status lines, while a phone is shown.
    effect((onCleanup) => {
      if (!this.shown()) {
        return;
      }
      let timer: unknown = null;
      const tick = (): void => {
        this.now.set(this.timers.now());
        timer = this.timers.setTimeout(tick, STATUS_TICK_MS);
      };
      untracked(tick);
      onCleanup(() => {
        if (timer !== null) {
          this.timers.clearTimeout(timer);
        }
      });
    });
  }

  /** A tap: the phone `id` as the main picture, or this device's own (null). */
  protected show(id: string | null): void {
    this.chosen.set(id);
  }

  protected aspectOf(camera: RemoteCameraEntry): number {
    return camera.frame === null ? 16 / 9 : camera.frame.width / camera.frame.height;
  }

  /** The status line under the phone's picture. */
  protected lineOf(camera: RemoteCameraEntry): readonly StatusPart[] {
    return this.lines().get(camera.id) ?? [];
  }

  /** A tile's caption after the label: what is wrong, in short; null when nothing is. */
  protected shortOf(camera: RemoteCameraEntry): readonly StatusPart[] | null {
    const parts = shortParts(this.lineOf(camera));
    return parts.length === 0 ? null : parts;
  }
}
