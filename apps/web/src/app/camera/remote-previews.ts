import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { framingPercent } from '@cubetrace/capture';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { RemoteCameraRegistry, type RemoteCameraEntry } from './remote-camera-registry';
import { showStream } from './video';

/**
 * One remote camera's picture (T4.3): its live preview's video while the track flows (unmuted), the
 * latest thumbnail of the Cameras list otherwise, and its framing rectangle over it, in percent of
 * its frames, so that the cube can be kept inside it from the host.
 */
@Component({
  selector: 'app-remote-picture',
  host: { '[attr.data-live]': 'live()' },
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
  `,
})
export class RemotePicture {
  readonly camera = input.required<RemoteCameraEntry>();
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
  protected readonly box = computed(() => {
    const { framing, frame } = this.camera();
    return framing === null || frame === null ? null : framingPercent(framing, frame);
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

/**
 * The live pictures of the host's remote cameras on the Timer page (T4.3, issue #60), over its own
 * preview: a small tile per phone in the picture's top right corner, so that the cube is kept in each
 * phone's frame while solving, without looking away from the clock. A tap on a tile swaps it with
 * the main picture (the phone's picture over the whole box, this device's in a tile); a tap on that
 * tile swaps back. Without this device's camera, the first phone's picture is the main one. Each
 * picture is the phone's live preview while it flows, its latest thumbnail otherwise
 * (`RemotePicture`). Loaded with the preview only once a phone is paired: the code of a session
 * without one is not downloaded.
 */
@Component({
  selector: 'app-remote-previews',
  imports: [RemotePicture],
  template: `
    @if (main(); as camera) {
      <div class="main" data-testid="remote-preview-main" [attr.data-label]="camera.label">
        <app-remote-picture [camera]="camera" />
        <span class="caption">{{ camera.label }}</span>
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
          <span class="caption">{{ camera.label ?? camera.name }}</span>
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      container-type: size;
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
    }

    .main .caption {
      top: var(--space-1);
      bottom: auto;
      left: var(--space-1);
      border-radius: var(--radius);
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
  /** This device's camera's stream, for its tile once a phone's is the main picture; null when off. */
  readonly local = input<MediaStream | null>(null);
  /** This device's picture is mirrored (a front camera), as its preview is. */
  readonly mirrored = input(false);
  /** This device's frames' proportions. */
  readonly localAspect = input(16 / 9);

  private readonly registry = inject(RemoteCameraRegistry);
  private readonly localVideo = viewChild<ElementRef<HTMLVideoElement>>('localVideo');
  /** The camera chosen as the main picture; null for this device's own. */
  private readonly chosen = signal<string | null>(null);

  /** The phones paired, with a camera. */
  private readonly cameras = computed(() =>
    this.registry.cameras().filter((camera) => camera.label !== null),
  );
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

  constructor() {
    effect((onCleanup) => {
      const video = this.localVideo()?.nativeElement;
      const stream = this.local();
      if (video === undefined || stream === null) {
        return;
      }
      onCleanup(showStream(video, stream));
    });
  }

  /** A tap: the phone `id` as the main picture, or this device's own (null). */
  protected show(id: string | null): void {
    this.chosen.set(id);
  }

  protected aspectOf(camera: RemoteCameraEntry): number {
    return camera.frame === null ? 16 / 9 : camera.frame.width / camera.frame.height;
  }
}
