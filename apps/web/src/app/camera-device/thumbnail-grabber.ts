import { DOCUMENT, InjectionToken, inject } from '@angular/core';

/** A thumbnail of the preview: a JPEG and its size. */
export interface GrabbedThumbnail {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Takes a small JPEG of a `<video>`'s current frame; the unit tests give a fake. */
export interface ThumbnailGrabber {
  /** The frame scaled so that its longer side is at most `maxPx`; null when it cannot be drawn. */
  grab(video: HTMLVideoElement, maxPx: number): Promise<GrabbedThumbnail | null>;
}

/** The JPEG's quality, 0 to 1: a thumbnail of 320 px takes about 10 kB at 0.6. */
const JPEG_QUALITY = 0.6;

/**
 * The grabber on a canvas: `drawImage` of the video, scaled, then `toBlob('image/jpeg')`. One canvas,
 * reused.
 */
export function canvasGrabber(document: Document): ThumbnailGrabber {
  let canvas: HTMLCanvasElement | null = null;
  return {
    async grab(video, maxPx) {
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        return null;
      }
      const scale = Math.min(1, maxPx / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      canvas ??= document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) {
        return null;
      }
      try {
        context.drawImage(video, 0, 0, width, height);
      } catch {
        return null;
      }
      const target = canvas;
      const blob = await new Promise<Blob | null>((resolve) => {
        target.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      });
      if (blob === null) {
        return null;
      }
      return { jpeg: new Uint8Array(await blob.arrayBuffer()), width, height };
    },
  };
}

export const THUMBNAIL_GRABBER = new InjectionToken<ThumbnailGrabber>('THUMBNAIL_GRABBER', {
  providedIn: 'root',
  factory: () => canvasGrabber(inject(DOCUMENT)),
});
