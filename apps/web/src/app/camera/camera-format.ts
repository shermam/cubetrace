import {
  snapToRange,
  type ControlRange,
  type FrameSize,
  type FramingRect,
  type JsonObject,
  type MeteringMode,
} from '@cubetrace/capture';

// Text and slider arithmetic for the Camera section of the Timer page (docs/PLAN.md, T2.1).

/** How a mode reads in the controls. */
export function modeLabel(mode: MeteringMode): string {
  switch (mode) {
    case 'continuous':
      return 'Auto';
    case 'single-shot':
      return 'Auto (once)';
    case 'manual':
      return 'Manual';
    case 'none':
      return 'Off';
  }
}

/**
 * An exposure time given in the constraint's units of 100 µs, in milliseconds and as a shutter
 * speed: 309.2 is "31 ms (1/32 s)", 20 is "2.0 ms (1/500 s)".
 */
export function exposureText(units: number): string {
  const ms = units / 10;
  const shown = ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
  if (units <= 0) {
    return `${shown} ms`;
  }
  const shutter =
    units >= 10_000
      ? `${(units / 10_000).toFixed(1)} s`
      : `1/${String(Math.round(10_000 / units))} s`;
  return `${shown} ms (${shutter})`;
}

export function isoText(iso: number): string {
  return String(Math.round(iso));
}

export function focusText(distance: number): string {
  return distance.toFixed(2);
}

/** A colour temperature; 0, which a camera on automatic white balance reports, reads "auto". */
export function temperatureText(kelvin: number): string {
  return kelvin > 0 ? `${String(Math.round(kelvin))} K` : 'auto';
}

export function zoomText(zoom: number): string {
  return `${zoom.toFixed(1)}×`;
}

/** Positions of a control's slider: 0 to this. */
export const SLIDER_STEPS = 1000;

/**
 * Whether a control's slider is logarithmic: exposure time and ISO, whose useful values bunch at
 * the low end of their ranges (1/500 s is 20 in a range that goes to 2880), when their minimum is
 * above 0.
 */
export function logarithmic(range: ControlRange, name: string): boolean {
  return (name === 'exposureTime' || name === 'iso') && range.min > 0;
}

/** The slider position of `value` in `range`. */
export function toSlider(value: number, range: ControlRange, log: boolean): number {
  const inside = Math.min(range.max, Math.max(range.min, value));
  const fraction = log
    ? Math.log(inside / range.min) / Math.log(range.max / range.min)
    : (inside - range.min) / (range.max - range.min);
  return Math.round(fraction * SLIDER_STEPS);
}

/** The value at slider `position` in `range`, on the range's steps. */
export function fromSlider(position: number, range: ControlRange, log: boolean): number {
  const fraction = Math.min(1, Math.max(0, position / SLIDER_STEPS));
  const value = log
    ? range.min * Math.pow(range.max / range.min, fraction)
    : range.min + fraction * (range.max - range.min);
  return snapToRange(value, range);
}

/** "1920×1080" */
export function sizeText(size: FrameSize): string {
  return `${String(size.width)}×${String(size.height)}`;
}

/**
 * What the track says it delivers, from its settings: "1920×1080 at 60 fps"; null when the
 * settings have no size.
 */
export function trackText(settings: JsonObject | null): string | null {
  const width = settings?.['width'];
  const height = settings?.['height'];
  const rate = settings?.['frameRate'];
  if (typeof width !== 'number' || typeof height !== 'number') {
    return null;
  }
  const fps = typeof rate === 'number' ? ` at ${String(Math.round(rate))} fps` : '';
  return `${sizeText({ width, height })}${fps}`;
}

/** A measured frame rate: "30.0 fps". */
export function fpsText(fps: number): string {
  return `${fps.toFixed(1)} fps`;
}

/** The framing rectangle: "480, 270, 960×540", or "full frame". */
export function framingText(rect: FramingRect, size: FrameSize): string {
  const full = rect.x === 0 && rect.y === 0 && rect.w === size.width && rect.h === size.height;
  return full
    ? `full frame, ${sizeText(size)}`
    : `${String(rect.x)}, ${String(rect.y)}, ${String(rect.w)}×${String(rect.h)}`;
}

/** A sharpness value as shown: whole numbers from 10 up, one decimal below. */
export function sharpnessText(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * The sharpness meter's bar, 0 to 1 on a logarithmic scale up to 10 times the threshold, so that
 * both a covered lens (near 0) and a sharp scene (hundreds) move it; the threshold sits a bit past
 * the middle.
 */
export function sharpnessBar(value: number, threshold: number): number {
  const top = Math.log1p(10 * threshold);
  return Math.min(1, Math.max(0, Math.log1p(Math.max(0, value)) / top));
}
