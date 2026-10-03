import {
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import {
  dragFraming,
  framingPercent,
  grabAt,
  previewDeltaToFrame,
  previewToFrame,
  type FrameSize,
  type FramingGrab,
  type FramingHandle,
  type FramingRect,
  type PreviewBox,
} from '@cubetrace/capture';

import { CameraService } from './camera-service';
import { showStream } from './video';

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
 * The framing rectangle's editor (docs/PLAN.md, T2.1): a larger picture of the camera (mirrored for a
 * front camera, like a mirror; the frames are not) with the rectangle over it; drag the rectangle to
 * move it, drag a corner to resize it, by mouse or touch; the arrow keys move it and Shift + arrows
 * resize it; the rectangle is kept per camera and frame size (`CameraService.setFraming`). Camera
 * settings show it while the framing is edited (T2.1), and the Camera page of a phone that films for
 * a host too (T4.1). The picture is a second `<video>` of the stream, which costs the page some work
 * on every frame: it is there only while the editor is.
 */
@Component({
  selector: 'app-framing-editor',
  template: `
    <div
      #frame
      class="frame"
      data-testid="camera-frame"
      [class.mirrored]="camera.mirrored()"
      [style.--aspect]="aspect()"
    >
      <video
        #picture
        muted
        playsinline
        aria-label="Camera picture, with the framing rectangle"
        data-testid="camera-framing-video"
      ></video>
      @if (box(); as area) {
        <div
          class="framing"
          role="group"
          tabindex="0"
          aria-label="Framing rectangle: drag it to move it, drag a corner to resize it; arrow keys move it, Shift and arrow keys resize it"
          data-testid="camera-framing"
          [style.left.%]="area.left"
          [style.top.%]="area.top"
          [style.width.%]="area.width"
          [style.height.%]="area.height"
          (pointerdown)="grab($event)"
          (pointermove)="move($event)"
          (pointerup)="release($event)"
          (pointercancel)="release($event)"
          (keydown)="nudge($event)"
        >
          <span class="handle nw" data-handle="nw"></span>
          <span class="handle ne" data-handle="ne"></span>
          <span class="handle sw" data-handle="sw"></span>
          <span class="handle se" data-handle="se"></span>
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    /* The picture keeps the frames' proportions (the framing rectangle is drawn in percent of it)
       and at most 60% of the window's height; a front camera's picture is mirrored, rectangle
       included. */
    .frame {
      position: relative;
      width: min(100%, calc(60vh * var(--aspect)));
      aspect-ratio: var(--aspect);
      overflow: hidden;
      border-radius: var(--radius);
      background: #000;

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
      cursor: move;
      /* Drags on the rectangle move it rather than scroll the page. */
      touch-action: none;
    }

    .handle {
      position: absolute;
      width: 1.25rem;
      height: 1.25rem;
      border: 2px solid var(--bg);
      border-radius: 50%;
      background: var(--accent);
      transform: translate(-50%, -50%);
    }

    .nw {
      top: 0;
      left: 0;
      cursor: nwse-resize;
    }

    .ne {
      top: 0;
      left: 100%;
      cursor: nesw-resize;
    }

    .sw {
      top: 100%;
      left: 0;
      cursor: nesw-resize;
    }

    .se {
      top: 100%;
      left: 100%;
      cursor: nwse-resize;
    }
  `,
})
export class FramingEditor {
  protected readonly camera = inject(CameraService);
  private readonly picture = viewChild<ElementRef<HTMLVideoElement>>('picture');
  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  /** The rectangle while it is dragged; the stored one otherwise. */
  private readonly draft = signal<FramingRect | null>(null);
  private drag: Drag | null = null;

  /** The rectangle shown: the one dragged, else the camera's. */
  readonly rect = computed(() => this.draft() ?? this.camera.framing());
  /** The rectangle over the picture, in percent of the frame. */
  protected readonly box = computed(() => {
    const rect = this.rect();
    const size = this.camera.frameSize();
    return rect === null || size === null ? null : framingPercent(rect, size);
  });
  /** The picture's proportions: the frames', 16:9 until they are known. */
  protected readonly aspect = computed(() => {
    const size = this.camera.frameSize();
    return size === null ? 16 / 9 : size.width / size.height;
  });

  constructor() {
    // The picture plays the camera's stream (the preview beside the clock measures it).
    effect((onCleanup) => {
      const video = this.picture()?.nativeElement;
      const stream = this.camera.stream();
      if (video !== undefined && stream !== null) {
        onCleanup(showStream(video, stream));
      }
    });
    // The picture scrolled into view when it appears, so that the rectangle is at hand.
    effect(() => {
      const frame = this.frame()?.nativeElement;
      if (frame !== undefined && typeof frame.scrollIntoView === 'function') {
        frame.scrollIntoView({ block: 'nearest' });
      }
    });
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
