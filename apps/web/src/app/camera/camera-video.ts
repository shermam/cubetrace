import { Directive, ElementRef, effect, inject, input } from '@angular/core';

import type { HostCamera } from './host-camera';
import { showStream } from './video';

/**
 * A `<video>` that plays a camera of this device (T5.5: one per picture of the host's cameras) and
 * measures its frames for it (`HostCamera.watchPreview`: their size, the frame rate, the sharpness
 * of the framing rectangle, none while `held` says so), from when the camera's stream is there until
 * it goes, the camera changes or the element goes.
 */
@Directive({ selector: 'video[appCameraVideo]' })
export class CameraVideo {
  /** The camera it plays. */
  readonly appCameraVideo = input.required<HostCamera>();
  /** Whether the sharpness meter waits now (a solve under way: drawing a frame would delay a move). */
  readonly held = input<() => boolean>(() => false);
  private readonly element = inject<ElementRef<HTMLVideoElement>>(ElementRef);

  constructor() {
    effect((onCleanup) => {
      const camera = this.appCameraVideo();
      const stream = camera.stream();
      if (stream === null) {
        return;
      }
      const video = this.element.nativeElement;
      const release = showStream(video, stream);
      const held = this.held();
      const stop = camera.watchPreview(video, held);
      onCleanup(() => {
        stop();
        release();
      });
    });
  }
}
