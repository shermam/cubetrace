import type { Signal } from '@angular/core';
import type {
  CameraControls,
  ControlDrift,
  ControlName,
  ControlValue,
  ControlValues,
} from '@cubetrace/capture';

import { exposureText, focusText, isoText, temperatureText, zoomText } from './camera-format';

/**
 * A camera's manual controls as the controls panel (`app-camera-controls`, T2.1) shows and changes
 * them (docs/PLAN.md T5.2): the open camera of this device (`CameraService.controlsSource`), or a
 * phone's over the connection (`RemoteControlsSource`, the Cameras section's, from the phone's last
 * `controls` message and its answers to `set-controls`). The panel is the same component over either.
 */
export interface ControlsSource {
  /** The controls the camera has (`@cubetrace/capture`'s `controlsOf`); null while there is none. */
  readonly controls: Signal<CameraControls | null>;
  /** What the camera's settings say of them. */
  readonly values: Signal<ControlValues>;
  /**
   * What the app applied (the controls kept for the camera and those set since; the mode each other
   * group opened in), which the watchdog holds the camera to (`ControlsWatch`).
   */
  readonly applied: Signal<ControlValues>;
  /** The controls the camera changed by itself, as the watchdog saw them; empty when none. */
  readonly drift: Signal<readonly ControlDrift[]>;
  /** A change is in flight: the panel's controls wait for it. */
  readonly busy: Signal<boolean>;
  /** Why the last change did not take (a phone that did not answer, a value refused); null when it did. */
  readonly error: Signal<string | null>;
  /** Sets one control: a mode alone switches its group, a value switches its group to manual. */
  set(name: ControlName, value: ControlValue): Promise<void>;
  /** Reset to auto: every control automatic again, the kept ones forgotten. */
  reset(): Promise<void>;
  /**
   * A slider of the panel is held or moved (true), or let go (false): the watchdog skips its readings
   * meanwhile and for a second after (`ControlsWatch`), so that a value on its way is not a drift.
   */
  adjusting(active: boolean): void;
}

/** How each control is named in the words about it. */
export const CONTROL_WORD: Readonly<Record<ControlName, string>> = {
  exposureMode: 'exposure',
  exposureTime: 'exposure time',
  iso: 'ISO',
  focusMode: 'focus',
  focusDistance: 'focus distance',
  whiteBalanceMode: 'white balance',
  colorTemperature: 'colour temperature',
  zoom: 'zoom',
  torch: 'torch',
};

/**
 * A control's value in words: a mode as the camera calls it (`manual`, `continuous`, `single-shot`,
 * `none`), a number as the panel shows it, the torch on or off.
 */
export function controlValueText(name: ControlName, value: ControlValue): string {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  if (typeof value === 'string') {
    return value;
  }
  switch (name) {
    case 'exposureTime':
      return exposureText(value);
    case 'iso':
      return isoText(value);
    case 'focusDistance':
      return focusText(value);
    case 'colorTemperature':
      return temperatureText(value);
    case 'zoom':
      return zoomText(value);
    default:
      return String(value);
  }
}

/** "focus went manual", and `where` after it: "focus went manual on the phone". */
export function driftWords(drift: ControlDrift, where = ''): string {
  const words = `${CONTROL_WORD[drift.name]} went ${controlValueText(drift.name, drift.actual)}`;
  return where === '' ? words : `${words} ${where}`;
}

/** "The camera set the focus to manual by itself." */
export function driftSentence(drift: ControlDrift): string {
  return `The camera set the ${CONTROL_WORD[drift.name]} to ${controlValueText(drift.name, drift.actual)} by itself.`;
}

/** "The camera keeps setting the focus to manual: set it by hand." */
export function gaveUpSentence(drift: ControlDrift): string {
  return `The camera keeps setting the ${CONTROL_WORD[drift.name]} to ${controlValueText(drift.name, drift.actual)}: set it by hand.`;
}

/**
 * The drifts as an event's facts (an event's facts nest one level only, docs/DIAGNOSTICS.md): each
 * control's name with its expected and actual values, `{focusMode: 'continuous → manual'}`.
 */
export function driftFacts(drift: readonly ControlDrift[]): Record<string, string> {
  return Object.fromEntries(
    drift.map((d) => [d.name, `${String(d.expected)} → ${String(d.actual)}`]),
  );
}
