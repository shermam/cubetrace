import type { CameraChoice, CameraFallback } from '@cubetrace/capture';

// The words for a camera that did not open, or opened in another mode than the one asked for
// (docs/PLAN.md, T2.1: "permission and device errors in plain words"). The names matched are
// getUserMedia's DOMExceptions in Chrome, plus the older names some Chromium builds still use.

/** Where the browser has no `navigator.mediaDevices` (an http:// page, or a browser without it). */
export const NO_CAMERA_API =
  'This browser cannot use a camera here: cubetrace needs Chrome, on its https:// address.';

/** When the camera stops while it is on. */
export const CAMERA_ENDED =
  'The camera stopped: it was unplugged, or another app took it. Turn it on again when it is back.';

/** One sentence or two about why the camera could not be opened, and what to do. */
export function describeCameraError(error: unknown): string {
  const name = stringMember(error, 'name') ?? '';
  const message = stringMember(error, 'message') ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return /system/i.test(message)
        ? 'The system does not let Chrome use the camera: allow Chrome in its privacy settings ' +
            '(on a Mac: System Settings, Privacy & Security, Camera), then turn the camera on again.'
        : 'The camera permission was denied: allow the camera for this site (the camera icon in ' +
            'the address bar, or the site settings), then turn the camera on again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found: connect one, then turn the camera on again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return (
        'The camera is in use by another app, or could not start: close the other app (a video ' +
        'call, the camera app), then turn the camera on again.'
      );
    case 'OverconstrainedError': {
      const constraint = stringMember(error, 'constraint');
      return (
        'The camera cannot deliver what was asked' +
        (constraint ? ` (${constraint})` : '') +
        ': choose another resolution or frame rate in Settings.'
      );
    }
    case 'AbortError':
      return 'The camera could not start: turn it on again.';
    case 'SecurityError':
      return 'The browser blocks the camera on this page: cubetrace needs its https:// address.';
    default: {
      const detail = message !== '' ? message : name !== '' ? name : String(error);
      return `The camera could not start (${detail}).`;
    }
  }
}

/** Why the camera opened otherwise than asked (`fallbackChoice`), with what `tried` asked for. */
export function describeFallback(why: CameraFallback, tried: CameraChoice): string {
  const size = `${String(tried.width ?? 1920)}×${String(tried.height ?? 1080)}`;
  const fps = String(tried.fps ?? 60);
  switch (why) {
    case 'device':
      return 'The camera chosen before is not connected: the default camera is on instead.';
    case 'frame-rate':
      return `This camera has no mode at exactly ${fps} fps at ${size}: it opened at its best rate.`;
    case 'mode':
      return `The camera could not start at ${size}, ${fps} fps: it opened at 1280×720, 30 fps.`;
  }
}

/** `value[key]` when it is a string (errors and DOMExceptions alike). */
function stringMember(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }
  const member: unknown = Reflect.get(value, key);
  return typeof member === 'string' ? member : null;
}
