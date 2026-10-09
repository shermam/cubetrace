import type { CameraInfo, CropRect } from '@cubetrace/core';

/**
 * The camera (docs/PLAN.md, T2.1): the constraints that open the chosen camera, snapshots of what
 * its track says it is and does, the manual controls it has and applying them, where it faces, the
 * frame rate it really delivers, and the session's `cameras[]` entry (@cubetrace/core's `CameraInfo`,
 * docs/DATA-MODEL.md §6).
 * Plain TypeScript over the MediaStreamTrack API (tracks are parameters; no browser global is read),
 * tested in Node against the owner's probe reports in docs/devices/.
 *
 * The manual controls are the Image Capture ones that Chrome adds to a camera track's capabilities,
 * settings and constraints: exposure, focus and white balance, each with a mode (`continuous` is
 * automatic, `manual` holds a value), zoom and the torch. TypeScript's DOM types do not describe
 * them, so they are read from the dictionaries as unknown values and checked.
 */

/** JSON, as session.json stores the snapshots. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

/**
 * Where a camera faces: `user` towards the solver (a phone's front camera), `environment` away
 * from them (a rear camera), `unknown` when neither the track nor the label says (laptop webcams).
 */
export type CameraFacing = 'user' | 'environment' | 'unknown';

/** How a control is driven (the Image Capture spec's `MeteringMode`). */
export type MeteringMode = 'none' | 'manual' | 'single-shot' | 'continuous';

/** What the solver chose: the camera, and the mode to ask it for. */
export interface CameraChoice {
  /** `MediaDeviceInfo.deviceId`; null for the browser's default (the front camera on a phone). */
  readonly deviceId: string | null;
  /** The frame size to ask for (ideally): 1920 × 1080 by default. */
  readonly width?: number;
  readonly height?: number;
  /** The frame rate to ask for: ideally 60 by default. */
  readonly fps?: number;
  /**
   * Ask for exactly `fps`: a camera without that rate then fails with an OverconstrainedError on
   * `frameRate` instead of opening at its best rate. Both of the ThinkPhone's cameras say 60 when
   * asked for 60 ideally and deliver 30 (docs/DEVICES.md); asking exactly is how to learn whether
   * they have 60 at all.
   */
  readonly exactFps?: boolean;
  /**
   * Which way the browser's default camera should face when none was chosen (`deviceId` null): the
   * front one by default (it faces a solver who reads the screen); the camera device of phase 4
   * asks for the rear one, which films the desk (T4.1). Ignored when a camera is chosen.
   */
  readonly facing?: 'user' | 'environment';
}

/** What the camera is asked for by default: 1920 × 1080, ideally at 60 fps. */
export const DEFAULT_MODE = { width: 1920, height: 1080, fps: 60 } as const;

/** The lower mode tried when a camera cannot start in the one asked for. */
export const FALLBACK_MODE = { width: 1280, height: 720, fps: 30 } as const;

/** The video constraints of `choice`; no audio (the microphone is not the camera panel's). */
export function buildConstraints(choice: CameraChoice): {
  readonly video: MediaTrackConstraints;
  readonly audio: false;
} {
  const fps = choice.fps ?? DEFAULT_MODE.fps;
  return {
    video: {
      // The default camera of a phone is its front one, which faces a solver who reads the screen,
      // unless the choice says which way it should face (the camera device asks for the rear one).
      ...(choice.deviceId === null
        ? { facingMode: { ideal: choice.facing ?? 'user' } }
        : { deviceId: { exact: choice.deviceId } }),
      width: { ideal: choice.width ?? DEFAULT_MODE.width },
      height: { ideal: choice.height ?? DEFAULT_MODE.height },
      frameRate: choice.exactFps === true ? { exact: fps } : { ideal: fps },
    },
    audio: false,
  };
}

/** Why `fallbackChoice` chose a lower rung. */
export type CameraFallback = 'device' | 'frame-rate' | 'mode';

/**
 * What to ask for next when `getUserMedia(buildConstraints(choice))` failed with `error`, and why;
 * null when nothing else is worth trying, and the error is the one to tell the user:
 * - `device`: the chosen camera is not there any more (an OverconstrainedError on `deviceId`, as
 *   Chrome reports an unknown id, or a NotFoundError): the default camera;
 * - `frame-rate`: the camera has no mode at exactly the rate asked for (an OverconstrainedError on
 *   `frameRate`): the same rate, ideally, which opens the camera at its best rate;
 * - `mode`: the camera could not start (a NotReadableError or an AbortError) in a mode above
 *   1280 × 720 at 30 fps: that mode.
 * A camera in use by another app also fails with a NotReadableError, so the caller retries once
 * first, in case it was this app's own camera still closing.
 */
export function fallbackChoice(
  choice: CameraChoice,
  error: unknown,
): { readonly choice: CameraChoice; readonly why: CameraFallback } | null {
  const name = stringMember(error, 'name');
  const constraint = stringMember(error, 'constraint');
  if (
    choice.deviceId !== null &&
    ((name === 'OverconstrainedError' && constraint === 'deviceId') || name === 'NotFoundError')
  ) {
    return { choice: { ...choice, deviceId: null }, why: 'device' };
  }
  if (name === 'OverconstrainedError' && constraint === 'frameRate' && choice.exactFps === true) {
    return { choice: { ...choice, exactFps: false }, why: 'frame-rate' };
  }
  const above =
    (choice.width ?? DEFAULT_MODE.width) > FALLBACK_MODE.width ||
    (choice.height ?? DEFAULT_MODE.height) > FALLBACK_MODE.height ||
    (choice.fps ?? DEFAULT_MODE.fps) > FALLBACK_MODE.fps ||
    choice.exactFps === true;
  if ((name === 'NotReadableError' || name === 'AbortError') && above) {
    return { choice: { deviceId: choice.deviceId, ...FALLBACK_MODE }, why: 'mode' };
  }
  return null;
}

/** A camera track's settings and capabilities as JSON (see `snapshot`). */
export interface CameraSnapshot {
  readonly settings: JsonObject;
  readonly capabilities: JsonObject;
}

/** The part of a track that `snapshot` reads. */
export interface SnapshotSource {
  getSettings(): MediaTrackSettings;
  getCapabilities(): MediaTrackCapabilities;
}

/**
 * The track's `getSettings()` and `getCapabilities()` as plain JSON: every key the browser reports
 * (the Image Capture ones included) with its value when it is JSON (a number only when finite),
 * ranges as `{min, max, step?}`, except `deviceId` and `groupId`: hashed identifiers of this
 * browser's installation, which say nothing about the pictures (the probes in docs/devices/ have
 * them redacted for the same reason).
 */
export function snapshot(track: SnapshotSource): CameraSnapshot {
  return {
    settings: jsonObject(track.getSettings()),
    capabilities: jsonObject(track.getCapabilities()),
  };
}

/** Keys left out of snapshots and constraints: identifiers of the installation (see `snapshot`). */
const PRIVATE_KEYS: ReadonlySet<string> = new Set(['deviceId', 'groupId']);

function jsonObject(dictionary: object): JsonObject {
  const result: Record<string, Json> = {};
  for (const [key, value] of Object.entries(dictionary)) {
    const json = toJson(value);
    if (json !== undefined && !PRIVATE_KEYS.has(key)) {
      result[key] = json;
    }
  }
  return result;
}

function toJson(value: unknown): Json | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item) => {
      const json = toJson(item);
      return json === undefined ? [] : [json];
    });
  }
  if (typeof value === 'object') {
    const range = rangeOf(value);
    if (range === null) {
      return jsonObject(value);
    }
    const { min, max, step } = range;
    return step === undefined ? { min, max } : { min, max, step };
  }
  return undefined;
}

/** A numeric range of a capability, in its own units. */
export interface ControlRange {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

/**
 * `{min, max, step?}` of a capability's range with finite `min` and `max` (and `step` when it is a
 * positive number); null for anything else.
 */
function rangeOf(value: unknown): ControlRange | null {
  const min = member(value, 'min');
  const max = member(value, 'max');
  const step = member(value, 'step');
  if (typeof min !== 'number' || typeof max !== 'number') {
    return null;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }
  return typeof step === 'number' && Number.isFinite(step) && step > 0
    ? { min, max, step }
    : { min, max };
}

/**
 * The manual controls a camera has: the modes of exposure, focus and white balance, and the ranges
 * of the values each mode holds. An empty mode list or a null range means the camera does not have
 * that control; a range whose minimum is not below its maximum is no control either.
 */
export interface CameraControls {
  readonly exposureModes: readonly MeteringMode[];
  /** In units of 100 µs, as the constraint takes it (20 is 2 ms, a 1/500 s shutter). */
  readonly exposureTime: ControlRange | null;
  readonly iso: ControlRange | null;
  readonly focusModes: readonly MeteringMode[];
  /** In metres, by the Image Capture spec. */
  readonly focusDistance: ControlRange | null;
  readonly whiteBalanceModes: readonly MeteringMode[];
  /** In kelvin. */
  readonly colorTemperature: ControlRange | null;
  readonly zoom: ControlRange | null;
  readonly torch: boolean;
}

/** The metering modes, in the order the controls list them: continuous, single-shot, manual, none. */
export const METERING_MODES: readonly MeteringMode[] = [
  'continuous',
  'single-shot',
  'manual',
  'none',
];

/**
 * The manual controls in `capabilities` (a track's `getCapabilities()` or its snapshot). The modes
 * also include the one `settings` reports, when given: the ThinkPhone's front camera lists only
 * `manual` focus while its setting is `continuous` (docs/devices/), so it does have an automatic
 * focus to go back to. Modes come in a fixed order: continuous, single-shot, manual, none.
 */
export function controlsOf(capabilities: object, settings?: object): CameraControls {
  const modes = (key: string): readonly MeteringMode[] => {
    const listed = member(capabilities, key);
    const found = new Set<unknown>(Array.isArray(listed) ? (listed as unknown[]) : []);
    if (settings !== undefined && found.size > 0) {
      found.add(member(settings, key));
    }
    return METERING_MODES.filter((mode) => found.has(mode));
  };
  const range = (key: string): ControlRange | null => {
    const found = rangeOf(member(capabilities, key));
    return found !== null && found.min < found.max ? found : null;
  };
  const torch = member(capabilities, 'torch');
  return {
    exposureModes: modes('exposureMode'),
    exposureTime: range('exposureTime'),
    iso: range('iso'),
    focusModes: modes('focusMode'),
    focusDistance: range('focusDistance'),
    whiteBalanceModes: modes('whiteBalanceMode'),
    colorTemperature: range('colorTemperature'),
    zoom: range('zoom'),
    // Chrome reports `torch: true`; the spec's older form is a list of the booleans allowed.
    torch: torch === true || (Array.isArray(torch) && (torch as unknown[]).includes(true)),
  };
}

/** Whether the camera has any control at all (the MacBook's FaceTime camera has none). */
export function hasControls(controls: CameraControls): boolean {
  return (
    controls.exposureModes.length > 0 ||
    controls.exposureTime !== null ||
    controls.iso !== null ||
    controls.focusModes.length > 0 ||
    controls.focusDistance !== null ||
    controls.whiteBalanceModes.length > 0 ||
    controls.colorTemperature !== null ||
    controls.zoom !== null ||
    controls.torch
  );
}

/** The automatic mode among `modes`: `continuous`, else `single-shot`; null if neither. */
export function autoModeOf(modes: readonly MeteringMode[]): MeteringMode | null {
  return modes.find((mode) => mode === 'continuous' || mode === 'single-shot') ?? null;
}

/** Values of the manual controls, as `applyControls` takes them and Settings keeps them. */
export interface ControlValues {
  readonly exposureMode?: MeteringMode;
  /** In units of 100 µs. */
  readonly exposureTime?: number;
  readonly iso?: number;
  readonly focusMode?: MeteringMode;
  readonly focusDistance?: number;
  readonly whiteBalanceMode?: MeteringMode;
  readonly colorTemperature?: number;
  readonly zoom?: number;
  readonly torch?: boolean;
}

export type ControlName = keyof ControlValues;

/** A value of one control: a mode, a number in the control's units, or the torch. */
export type ControlValue = MeteringMode | number | boolean;

/** The controls grouped as they are applied: a group the camera refuses leaves the others alone. */
export const CONTROL_GROUPS: readonly (readonly ControlName[])[] = [
  ['exposureMode', 'exposureTime', 'iso'],
  ['focusMode', 'focusDistance'],
  ['whiteBalanceMode', 'colorTemperature'],
  ['zoom'],
  ['torch'],
];

/** Every control, in the order of their groups. */
export const CONTROL_NAMES: readonly ControlName[] = CONTROL_GROUPS.flat();

/** The controls that set a group's mode. */
export type ModeControl = 'exposureMode' | 'focusMode' | 'whiteBalanceMode';

const MODE_CONTROLS: ReadonlySet<ControlName> = new Set<ModeControl>([
  'exposureMode',
  'focusMode',
  'whiteBalanceMode',
]);

/** The controls of the group of `name` (`focusDistance`: focusMode and focusDistance). */
export function controlGroupOf(name: ControlName): readonly ControlName[] {
  return CONTROL_GROUPS.find((group) => group.includes(name)) ?? [name];
}

/** The control that sets the mode of `name`'s group; null for zoom and the torch, which have none. */
export function modeControlOf(name: ControlName): ModeControl | null {
  const mode = controlGroupOf(name).find((member) => MODE_CONTROLS.has(member));
  return (mode as ModeControl | undefined) ?? null;
}

/** The modes a camera lists for the group of `mode` (its `CameraControls` list). */
export function modesOf(controls: CameraControls, mode: ModeControl): readonly MeteringMode[] {
  switch (mode) {
    case 'exposureMode':
      return controls.exposureModes;
    case 'focusMode':
      return controls.focusModes;
    case 'whiteBalanceMode':
      return controls.whiteBalanceModes;
  }
}

/**
 * A control the camera changed by itself (docs/PLAN.md T5.2, the watchdog of the app's
 * `ControlsWatch`): its name, the value the app expects (what it applied, or the mode the camera
 * opened in where it applied nothing) and the value the track's settings say now. The focus that went
 * manual by itself on 2026-10-09 is `{name: 'focusMode', expected: 'continuous', actual: 'manual'}`.
 */
export interface ControlDrift {
  readonly name: ControlName;
  readonly expected: ControlValue;
  readonly actual: ControlValue;
}

/** The controls' values in a track's settings (or their snapshot). */
export function controlValuesOf(settings: object): ControlValues {
  const values: Partial<Record<ControlName, unknown>> = {};
  for (const name of CONTROL_GROUPS.flat()) {
    const value = member(settings, name);
    if (isControlValue(name, value)) {
      values[name] = value;
    }
  }
  return values as ControlValues;
}

/** Whether `value` is a value of the control `name`. */
export function isControlValue(name: ControlName, value: unknown): boolean {
  if (MODE_CONTROLS.has(name)) {
    return METERING_MODES.includes(value as MeteringMode);
  }
  if (name === 'torch') {
    return typeof value === 'boolean';
  }
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * `values` reduced to what `controls` has: modes the camera lists, numbers moved into their range
 * and onto its steps, the torch where there is one. A value outside its range would otherwise make
 * the camera ignore its whole group.
 */
export function fitControls(values: ControlValues, controls: CameraControls): ControlValues {
  const fitted: Partial<Record<ControlName, MeteringMode | number | boolean>> = {};
  const mode = (value: MeteringMode | undefined, modes: readonly MeteringMode[]) =>
    value !== undefined && modes.includes(value) ? value : undefined;
  const number = (value: number | undefined, range: ControlRange | null) =>
    value !== undefined && range !== null ? snapToRange(value, range) : undefined;
  const candidates: Record<ControlName, MeteringMode | number | boolean | undefined> = {
    exposureMode: mode(values.exposureMode, controls.exposureModes),
    exposureTime: number(values.exposureTime, controls.exposureTime),
    iso: number(values.iso, controls.iso),
    focusMode: mode(values.focusMode, controls.focusModes),
    focusDistance: number(values.focusDistance, controls.focusDistance),
    whiteBalanceMode: mode(values.whiteBalanceMode, controls.whiteBalanceModes),
    colorTemperature: number(values.colorTemperature, controls.colorTemperature),
    zoom: number(values.zoom, controls.zoom),
    torch: controls.torch ? values.torch : undefined,
  };
  for (const [name, value] of Object.entries(candidates) as [ControlName, unknown][]) {
    if (value !== undefined) {
      fitted[name] = value as MeteringMode | number | boolean;
    }
  }
  return fitted as ControlValues;
}

/** `value` inside `range` and on its steps (counted from its minimum). */
export function snapToRange(value: number, range: ControlRange): number {
  const inside = Math.min(range.max, Math.max(range.min, value));
  if (range.step === undefined) {
    return inside;
  }
  const steps = Math.round((inside - range.min) / range.step);
  // Rounding to the step's decimals keeps 0.1-steps from reading 0.30000000000000004.
  const snapped = Math.min(range.max, range.min + steps * range.step);
  return Number(snapped.toFixed(decimalsOf(range.step) + decimalsOf(range.min)));
}

function decimalsOf(value: number): number {
  const text = String(value);
  const point = text.indexOf('.');
  return point === -1 || text.includes('e') ? 0 : Math.min(10, text.length - point - 1);
}

/** An advanced constraint set of Image Capture controls. */
export type ControlConstraintSet = MediaTrackConstraintSet & Partial<Record<ControlName, unknown>>;

/**
 * The advanced constraint sets for `values`: one per group of `CONTROL_GROUPS` that has a value.
 * Chrome applies each set it can satisfy and skips the others without an error, so a group the
 * camera refuses does not take the rest with it.
 */
export function controlConstraints(values: ControlValues): ControlConstraintSet[] {
  const sets: ControlConstraintSet[] = [];
  for (const group of CONTROL_GROUPS) {
    const set: Partial<Record<ControlName, unknown>> = {};
    for (const name of group) {
      if (values[name] !== undefined) {
        set[name] = values[name];
      }
    }
    if (Object.keys(set).length > 0) {
      sets.push(set);
    }
  }
  return sets;
}

/** The part of a track that `applyControls` uses. */
export interface ControlTarget {
  applyConstraints(constraints?: MediaTrackConstraints): Promise<void>;
}

/**
 * Sets the controls in `values` on the track with `applyConstraints({advanced: [...]})`, one
 * constraint set per group. Only Image Capture constraints are sent, which Chrome applies to the
 * camera without touching the track's size or frame rate. Values the camera cannot take are skipped
 * by the camera; pass them through `fitControls` first. Rejects as `applyConstraints` does.
 */
export async function applyControls(track: ControlTarget, values: ControlValues): Promise<void> {
  const advanced = controlConstraints(values);
  if (advanced.length > 0) {
    await track.applyConstraints({ advanced });
  }
}

/**
 * Where the camera faces: the track's `facingMode` setting when it says `user` or `environment`,
 * else the label (Android's cameras are labelled "camera 1, facing front" and "camera 0, facing
 * back"; some laptops' "… Front" and "… Rear"), else `unknown`.
 */
export function facingOf(settings: object, label: string): CameraFacing {
  const facing = member(settings, 'facingMode');
  if (facing === 'user' || facing === 'environment') {
    return facing;
  }
  return facingFromLabel(label);
}

/** Where a camera faces by its label alone (see `facingOf`). */
export function facingFromLabel(label: string): CameraFacing {
  if (/\bfront\b/i.test(label)) {
    return 'user';
  }
  if (/\b(back|rear)\b/i.test(label)) {
    return 'environment';
  }
  return 'unknown';
}

/**
 * The camera's own short label: `phone` when the host label says phone (the default labels of
 * phones all do: "Android phone", "iPhone", "Phone"), `laptop` otherwise, followed by `-front` or
 * `-rear` when the facing is known: `laptop`, `phone-front`, `phone-rear`. Lowercase words joined
 * by hyphens, as the camera labels that name clip files must be. Two cameras of a host can have one
 * own label (a laptop's built-in camera and a USB webcam): in a session each device gets a label of
 * its own from it, `laptop` for the first and `laptop-2` for another (@cubetrace/core's `labelFor`,
 * docs/PLAN.md T2.14).
 */
export function cameraLabel(hostLabel: string, facing: CameraFacing): string {
  const base = /phone/i.test(hostLabel) ? 'phone' : 'laptop';
  switch (facing) {
    case 'user':
      return `${base}-front`;
    case 'environment':
      return `${base}-rear`;
    case 'unknown':
      return base;
  }
}

/** The part of a track that `cameraInfo` reads. */
export interface CameraTrack extends SnapshotSource {
  readonly label: string;
}

/**
 * The session's entry (`session.json` `cameras[]`) for the camera open on `track`, which `choice`
 * opened, on the host labelled `hostLabel`: a camera of this device (`local`), its facing, its own
 * label (`cameraLabel`, which the session makes one per device: T2.14) and the browser's, its
 * settings and capabilities (`snapshot`), the constraints it was asked for (without the device id),
 * `crop`, the framing rectangle in frame pixels (null for the whole frame), and `mode: 'full'`: in
 * phase 2 the video keeps the whole frame. Its `microphone` is null: the recording, which opens the
 * microphone, puts its own (T2.12).
 */
export function cameraInfo(
  hostLabel: string,
  choice: CameraChoice,
  track: CameraTrack,
  crop: CropRect | null,
): CameraInfo {
  const { settings, capabilities } = snapshot(track);
  const facing = facingOf(settings, track.label);
  return {
    label: cameraLabel(hostLabel, facing),
    local: true,
    facing,
    deviceLabel: track.label,
    settings,
    capabilities,
    constraints: jsonObject(buildConstraints(choice).video),
    crop: crop === null ? null : { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    mode: 'full',
    microphone: null,
  };
}

/** What `FrameRateMeter` reads of a `requestVideoFrameCallback` callback's metadata. */
export interface FrameTimes {
  /** The frame's time on the camera's own clock, in seconds. */
  readonly mediaTime: number;
  /** Frames presented so far, including those no callback saw. */
  readonly presentedFrames?: number;
}

/**
 * The frame rate the camera really delivers, which may not be the one its track claims (both of the
 * ThinkPhone's cameras say 60 and deliver 30, docs/DEVICES.md): the frames presented over the last
 * second of the camera's own clock (`mediaTime`), divided by the time they span. Fed with every
 * `requestVideoFrameCallback`; frames that no callback saw still count through `presentedFrames`.
 */
export class FrameRateMeter {
  private readonly samples: { readonly seconds: number; readonly frame: number }[] = [];
  private callbacks = 0;

  /** `windowSeconds`: the span measured over; `minSeconds`: the shortest span that gives a rate. */
  constructor(
    private readonly windowSeconds = 1,
    private readonly minSeconds = 0.75,
  ) {}

  add(times: FrameTimes): void {
    const last = this.samples.at(-1);
    if (last !== undefined) {
      const frame = times.presentedFrames ?? this.callbacks + 1;
      if (times.mediaTime < last.seconds || frame < last.frame) {
        // A new stream in the same player: its clock starts again.
        this.reset();
      } else if (times.mediaTime === last.seconds || frame === last.frame) {
        return; // The same frame again.
      }
    }
    this.callbacks++;
    this.samples.push({ seconds: times.mediaTime, frame: times.presentedFrames ?? this.callbacks });
    // Keep the frames of the last window, plus the one just before it.
    while (
      this.samples.length > 2 &&
      times.mediaTime - this.samples[1].seconds >= this.windowSeconds
    ) {
      this.samples.shift();
    }
  }

  /** Frames per second over the last second; null until frames span `minSeconds`. */
  fps(): number | null {
    const first = this.samples.at(0);
    const last = this.samples.at(-1);
    if (first === undefined || last === undefined) {
      return null;
    }
    const span = last.seconds - first.seconds;
    return span >= this.minSeconds ? (last.frame - first.frame) / span : null;
  }

  reset(): void {
    this.samples.length = 0;
    this.callbacks = 0;
  }
}

/** The part of a `<video>` that `watchFrames` uses. */
export interface FrameCallbacks<Metadata> {
  requestVideoFrameCallback(callback: (now: number, metadata: Metadata) => void): number;
  cancelVideoFrameCallback(handle: number): void;
}

/**
 * Calls `onFrame` with the metadata of every frame the `<video>` presents, through
 * `requestVideoFrameCallback`, until the returned function is called.
 */
export function watchFrames<Metadata>(
  video: FrameCallbacks<Metadata>,
  onFrame: (metadata: Metadata) => void,
): () => void {
  let handle: number | null = null;
  let stopped = false;
  // `onFrame` may stop the watch, so each callback asks for the next one only afterwards.
  const schedule = (): void => {
    if (!stopped) {
      handle = video.requestVideoFrameCallback(frame);
    }
  };
  const frame = (_now: number, metadata: Metadata): void => {
    handle = null;
    if (!stopped) {
      onFrame(metadata);
      schedule();
    }
  };
  schedule();
  return () => {
    stopped = true;
    if (handle !== null) {
      video.cancelVideoFrameCallback(handle);
      handle = null;
    }
  };
}

function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (Reflect.get(value, key) as unknown)
    : undefined;
}

function stringMember(value: unknown, key: string): string | null {
  const found = member(value, key);
  return typeof found === 'string' ? found : null;
}
