import { Injectable, computed, inject, signal } from '@angular/core';
// Types only: the camera code stays out of the chunks that load SettingsService on every page.
import type {
  ControlValues,
  FrameSize,
  FramingRect,
  StoredFraming,
  VideoQuality,
} from '@cubetrace/capture';
import type { MicrophoneProcessing } from '@cubetrace/core';
import { normalizeMac } from '@cubetrace/gan';

import { DEMO_SPEED_DEFAULT, isDemoSpeed } from '../cube/demo';
import { BROWSER_GLOBALS, hostNow, type BrowserGlobals } from '../device/browser-globals';
import { networkConnection } from '../device/network-connection';
import { errorMessage } from '../shared/error-message';

/** The `localStorage` key of the settings (one JSON object). */
export const SETTINGS_STORAGE_KEY = 'cubetrace.settings';

/** A cube's MAC address, stored under the Bluetooth name the cube advertises. */
export interface CubeMac {
  /** As Chrome's device list shows it, such as `GAN12ui_AB12`; matched ignoring case. */
  readonly name: string;
  /** Normalized: `AB:12:CD:34:EF:56`. */
  readonly mac: string;
  /**
   * When the entry last changed, in ms on the host clock of the device that changed it, so that a
   * merge with the account's list keeps the newest copy of each entry (T3.4). The entries stored
   * before T3.4 got the time they were first read.
   */
  readonly updatedMs: number;
}

/** The outcome of storing a cube's MAC address: the stored entry, or why it was refused. */
export type CubeMacResult =
  { readonly ok: true; readonly entry: CubeMac } | { readonly ok: false; readonly error: string };

/** A cube is disconnected after this many minutes without a turn, by default (T1.14). */
export const IDLE_DISCONNECT_DEFAULT_MINUTES = 5;

/** The longest idle time the setting accepts, in minutes; 0 turns the idle disconnection off. */
export const IDLE_DISCONNECT_MAX_MINUTES = 60;

/** Whether `minutes` is a value of the idle disconnection setting: a whole number from 0 to 60. */
export function isIdleDisconnectMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= IDLE_DISCONNECT_MAX_MINUTES;
}

/** The frame size the camera is asked for (Settings, Camera). */
export type CameraResolution = '1080p' | '720p';

/**
 * The frame rate the camera is asked for: `best`, ideally 60 (the camera's best rate); `60`, exactly
 * 60 (a camera without a 60 fps mode then opens at its best rate, and Camera settings say so);
 * `30`, ideally 30.
 */
export type CameraFrameRate = 'best' | '60' | '30';

export const CAMERA_RESOLUTIONS: readonly CameraResolution[] = ['1080p', '720p'];
export const CAMERA_FRAME_RATES: readonly CameraFrameRate[] = ['best', '60', '30'];

/** How the resolutions read in Settings and in the Timer page's Camera settings. */
export const CAMERA_RESOLUTION_TEXT: Readonly<Record<CameraResolution, string>> = {
  '1080p': '1920×1080',
  '720p': '1280×720',
};

/** The frame size each resolution asks the camera for. */
export const CAMERA_RESOLUTION_SIZE: Readonly<Record<CameraResolution, FrameSize>> = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
};

/** How the frame rates read in Settings and in the Timer page's Camera settings. */
export const CAMERA_FRAME_RATE_TEXT: Readonly<Record<CameraFrameRate, string>> = {
  best: 'Best (asks for 60 fps)',
  '60': 'Exactly 60 fps',
  '30': '30 fps',
};

/**
 * The video qualities (T2.10): the recording's bitrate, 4, 8 or 12 Mbps at 1920×1080 and 30 fps
 * (@cubetrace/capture's `videoBitrate`). Standard by default: the 8 Mbps of the first recordings
 * took 35–42 MB per attempt, two days of the owner's solves to fill the browser's storage
 * (docs/DEVICES.md, "First recordings").
 */
export const VIDEO_QUALITIES: readonly VideoQuality[] = ['standard', 'high', 'maximum'];

/**
 * How the video qualities are named in Settings and in the Timer page's Camera settings, where each
 * is followed by its bitrate and the size of an attempt at it (camera/video-quality.ts).
 */
export const VIDEO_QUALITY_TEXT: Readonly<Record<VideoQuality, string>> = {
  standard: 'Standard',
  high: 'High',
  maximum: 'Maximum',
};

/**
 * How the recording asks for the microphone (T2.12): Raw, the default, with the browser's voice
 * processing off, so that the clips keep the cube's clicks (with Chrome's defaults the ThinkPhone's
 * clips had a TV's voices and no click: docs/DEVICES.md, "Audio"); Voice, the browser's defaults,
 * for speech.
 */
export const MICROPHONE_PROCESSINGS: readonly MicrophoneProcessing[] = ['raw', 'voice'];

/** How the microphone's choices read in Settings and in the Timer page's Camera settings. */
export const MICROPHONE_PROCESSING_TEXT: Readonly<Record<MicrophoneProcessing, string>> = {
  raw: 'Raw',
  voice: 'Voice',
};

/** The line of help next to the microphone's choice, in Settings and in Camera settings. */
export const MICROPHONE_HINT =
  "Raw keeps the cube's clicks; Voice lets the browser suppress noise for speech.";

/**
 * The sharpness meter says "good" from this value up, by default: calibrated on Chrome's fake camera
 * (@cubetrace/capture's SHARPNESS_THRESHOLD_DEFAULT, repeated here so that this file imports no
 * camera code).
 */
export const SHARPNESS_THRESHOLD_DEFAULT = 20;

/** The largest sharpness threshold the setting accepts. */
export const SHARPNESS_THRESHOLD_MAX = 100_000;

/** Whether `threshold` is a value of the sharpness setting: a number above 0, up to the maximum. */
export function isSharpnessThreshold(threshold: number): boolean {
  return Number.isFinite(threshold) && threshold > 0 && threshold <= SHARPNESS_THRESHOLD_MAX;
}

/** The camera chosen on a host, by its host label: its device id and its label. */
export interface CameraPick {
  readonly host: string;
  readonly deviceId: string;
  readonly label: string;
}

/**
 * The manual controls chosen for a camera, by the browser's name for it (`MediaStreamTrack.label`:
 * the device's, not its label in a session, T2.14); the torch is not kept.
 */
interface CameraControlsEntry {
  readonly camera: string;
  readonly values: ControlValues;
}

/** A framing rectangle of a camera, by the browser's name for it, for frames of one size. */
interface CameraFramingEntry extends StoredFraming {
  readonly camera: string;
}

/** At most this many framing rectangles are kept (cameras × frame sizes); the oldest go first. */
const MAX_FRAMINGS = 24;
/** At most this many cameras keep their manual controls, and hosts their chosen camera. */
const MAX_CAMERA_ENTRIES = 12;

/**
 * The version of what `localStorage` holds: 2 since T3.4, whose cube entries have `updatedMs` (1
 * had none). Written, not read: every field is checked on its own.
 */
const SETTINGS_VERSION = 2;

/** What `localStorage` holds; every field is checked on reading and falls back on its own. */
interface StoredSettings {
  /** Null: the default label of this device. */
  readonly hostLabel: string | null;
  readonly cubeMacs: readonly CubeMac[];
  readonly demoSpeed: number;
  readonly inspection: boolean;
  readonly autoAdvance: boolean;
  /** On a phone, the scramble over the camera's picture, both pinned at the top (T2.13). */
  readonly scrambleOverPicture: boolean;
  readonly idleDisconnectMinutes: number;
  readonly cameraOn: boolean;
  readonly cameraResolution: CameraResolution;
  readonly cameraFrameRate: CameraFrameRate;
  readonly sharpnessThreshold: number;
  readonly recordAudio: boolean;
  readonly microphoneProcessing: MicrophoneProcessing;
  readonly videoQuality: VideoQuality;
  /** Whether the Timer page's Camera settings are open; null until they were opened or closed. */
  readonly cameraSettingsOpen: boolean | null;
  readonly cameraPicks: readonly CameraPick[];
  readonly cameraControls: readonly CameraControlsEntry[];
  readonly cameraFramings: readonly CameraFramingEntry[];
  /** T3.3: the sessions of this device are uploaded while an account is signed in. */
  readonly uploadSessions: boolean;
  /** T3.3: uploads wait off Wi-Fi; null: this device's default (on for a phone). */
  readonly wifiOnly: boolean | null;
  /** T3.3: uploaded clips stay on this device; null: this device's default (on for a laptop). */
  readonly keepLocalCopies: boolean | null;
}

const DEFAULTS: StoredSettings = {
  hostLabel: null,
  cubeMacs: [],
  demoSpeed: DEMO_SPEED_DEFAULT,
  inspection: false,
  autoAdvance: true,
  scrambleOverPicture: true,
  idleDisconnectMinutes: IDLE_DISCONNECT_DEFAULT_MINUTES,
  cameraOn: false,
  cameraResolution: '1080p',
  cameraFrameRate: 'best',
  sharpnessThreshold: SHARPNESS_THRESHOLD_DEFAULT,
  recordAudio: true,
  microphoneProcessing: 'raw',
  videoQuality: 'standard',
  cameraSettingsOpen: null,
  cameraPicks: [],
  cameraControls: [],
  cameraFramings: [],
  uploadSessions: true,
  wifiOnly: null,
  keepLocalCopies: null,
};

/** Why `text` is not a MAC address (the words the connect dialog uses too). */
export function macAddressProblem(text: string): string {
  return (
    `"${text.trim()}" is not a MAC address: type six hex bytes, such as AB:12:CD:34:EF:56 ` +
    '(colons, dashes or nothing between them).'
  );
}

/**
 * The settings the timer and the cube connection need (docs/PLAN.md, T1.6a): the host label that
 * sessions record, the cubes' MAC addresses by Bluetooth name, the idle disconnection (T1.14), the
 * demo speed, inspection, auto-advance and, on a phone, the scramble over the camera's picture
 * (T2.13); and the camera's (T2.1): on or off, the resolution and frame rate asked for, the
 * sharpness threshold, the camera chosen on each host (by host label), and per camera (by its
 * label) the manual controls chosen and the framing rectangles; and whether the recording has the
 * microphone's audio (T2.4, on by default, as the design has it), how it asks for the microphone
 * (T2.12, Raw by default), its video quality (T2.10, Standard by default), and whether the Timer
 * page's Camera settings are open (T2.7); and the uploads' (T3.3): whether the sessions are uploaded
 * while an account is signed in, on Wi-Fi only (a phone's default, where the browser tells Wi-Fi from
 * mobile data), and whether the uploaded clips stay on the device (a laptop's default). Signals, kept
 * in `localStorage` (through BROWSER_GLOBALS) as one JSON object that is written on every change.
 * Where the browser blocks storage the settings last until the page closes, and `saveError` says so.
 * Signed in, the cube list is kept in sync with the account's by CubeSyncService (T3.4), which is
 * why each entry has the time it last changed.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly storage = storageOf(this.globals);
  /** What `localStorage` held as the page loaded; cube entries stored before T3.4 dated now. */
  private readonly loaded = readSettings(this.storage, hostNow(this.globals));
  private readonly stored = signal<StoredSettings>(this.loaded.settings);
  private readonly saveErrorSignal = signal<string | null>(null);

  /** This device is a phone, as its browser says: the uploads' defaults follow it (T3.3). */
  readonly isPhone = hostPlatform(this.globals.navigator).mobile;
  /**
   * The browser says the network's type (`navigator.connection.type`: Chrome on Android), so that
   * "Wi-Fi only" can be honoured; Settings shows it only then (T3.3).
   */
  readonly networkTypeKnown = networkConnection(this.globals.navigator)?.type !== undefined;

  /** The label of this device when none is set: its platform, such as "macOS laptop". */
  readonly defaultHostLabel = defaultHostLabel(this.globals.navigator);
  /** The label that the user typed; null while the default applies. */
  readonly customHostLabel = computed(() => this.stored().hostLabel);
  /** The label that sessions record: the typed one, else the default. */
  readonly hostLabel = computed(() => this.stored().hostLabel ?? this.defaultHostLabel);
  /** Sorted by name. */
  readonly cubeMacs = computed(() => this.stored().cubeMacs);
  /** The demo cube's replay speed (1 is real time). */
  readonly demoSpeed = computed(() => this.stored().demoSpeed);
  /** A 15-second WCA inspection before each solve. */
  readonly inspection = computed(() => this.stored().inspection);
  /** The next scramble appears by itself after a solve. */
  readonly autoAdvance = computed(() => this.stored().autoAdvance);
  /**
   * On a phone, the camera's picture and the scramble over it stay pinned at the top of the Timer
   * page, the scramble alone while the camera is off (T2.13); on by default. Off: T2.7's layout.
   */
  readonly scrambleOverPicture = computed(() => this.stored().scrambleOverPicture);
  /**
   * A connected cube is disconnected after this many minutes without a turn, to save its battery;
   * 0: never. A whole number from 0 to 60, 5 by default.
   */
  readonly idleDisconnectMinutes = computed(() => this.stored().idleDisconnectMinutes);
  /** The camera is on: the Timer page opens it when it loads. */
  readonly cameraOn = computed(() => this.stored().cameraOn);
  readonly cameraResolution = computed(() => this.stored().cameraResolution);
  readonly cameraFrameRate = computed(() => this.stored().cameraFrameRate);
  /** The sharpness meter says "good" from this value up. */
  readonly sharpnessThreshold = computed(() => this.stored().sharpnessThreshold);
  /** The clips have the microphone's audio with the video (T2.4); on by default. */
  readonly recordAudio = computed(() => this.stored().recordAudio);
  /**
   * How the recording asks for the microphone (T2.12): Raw by default, the browser's voice
   * processing off; Voice, the browser's defaults.
   */
  readonly microphoneProcessing = computed(() => this.stored().microphoneProcessing);
  /** The recording's bitrate (T2.10); Standard, 4 Mbps at 1080p30, by default. */
  readonly videoQuality = computed(() => this.stored().videoQuality);
  /**
   * Whether the Camera settings of the Timer page are open (T2.7): as they were left, or null
   * before they were first opened or closed.
   */
  readonly cameraSettingsOpen = computed(() => this.stored().cameraSettingsOpen);
  /** The framing rectangles of every camera, oldest first. */
  readonly cameraFramings = computed(() => this.stored().cameraFramings);
  /**
   * "Upload sessions" (T3.3): while an account is signed in, the sessions of this device go to its
   * bucket (demo sessions never do); on by default.
   */
  readonly uploadSessions = computed(() => this.stored().uploadSessions);
  /**
   * "Wi-Fi only" as set, else this device's default: on for a phone. Shown, and honoured, only where
   * the browser says the network's type ({@link networkTypeKnown}).
   */
  readonly wifiOnlySetting = computed(() => this.stored().wifiOnly ?? this.isPhone);
  /** Whether uploads wait off Wi-Fi now: the setting, where the network's type is known. */
  readonly wifiOnly = computed(() => this.networkTypeKnown && this.wifiOnlySetting());
  /**
   * "Keep local copies" as set, else this device's default: on for a laptop, off for a phone, whose
   * storage the clips fill (T3.3). Off, an attempt's clips are deleted once all its files are
   * uploaded; its attempt.json and frames files stay.
   */
  readonly keepLocalCopies = computed(() => this.stored().keepLocalCopies ?? !this.isPhone);
  /** Why the last change could not be stored; null when it was. */
  readonly saveError = this.saveErrorSignal.asReadonly();

  constructor() {
    if (this.loaded.migrated) {
      // The cube entries stored before T3.4 keep the time they got now: read again later, they must
      // not look newer than the copies on the account's other devices.
      this.saveErrorSignal.set(writeSettings(this.storage, this.stored()));
    }
  }

  /** Sets the host label; an empty one restores the default. */
  setHostLabel(label: string): void {
    const trimmed = label.trim();
    this.update({ hostLabel: trimmed === '' ? null : trimmed });
  }

  /** The stored MAC address of the cube called `name`, or null. */
  macFor(name: string | null | undefined): string | null {
    const key = name?.trim().toLowerCase() ?? '';
    if (key === '') {
      return null;
    }
    return this.stored().cubeMacs.find((entry) => entry.name.toLowerCase() === key)?.mac ?? null;
  }

  /**
   * Stores `mac` for the cube called `name` (replacing an entry of that name, ignoring case, and
   * the entry called `replacing`, when one is being edited), changed now: later than the entry it
   * replaces, even when that one came from a device whose clock is ahead. Refuses an empty name or
   * a text that is not a MAC address.
   */
  saveCubeMac(name: string, mac: string, replacing?: string): CubeMacResult {
    const trimmed = name.trim();
    if (trimmed === '') {
      return {
        ok: false,
        error: "Type the cube's name, as Chrome's device list shows it (such as GAN12ui_AB12).",
      };
    }
    const normalized = normalizeMac(mac);
    if (normalized === null) {
      return { ok: false, error: macAddressProblem(mac) };
    }
    const gone = new Set([trimmed.toLowerCase(), replacing?.trim().toLowerCase()]);
    const replaced = this.stored().cubeMacs.filter((e) => gone.has(e.name.toLowerCase()));
    const updatedMs = Math.max(hostNow(this.globals), ...replaced.map((e) => e.updatedMs + 1));
    const entry: CubeMac = { name: trimmed, mac: normalized, updatedMs };
    const others = this.stored().cubeMacs.filter((e) => !gone.has(e.name.toLowerCase()));
    this.update({ cubeMacs: sortByName([...others, entry]) });
    return { ok: true, entry };
  }

  /**
   * Sets the cube list as a merge with the account's left it (T3.4, CubeSyncService): every entry
   * with its own `updatedMs`, the account's copies among them. The user's changes go through
   * saveCubeMac and removeCubeMac.
   */
  setCubeMacs(entries: readonly CubeMac[]): void {
    this.update({ cubeMacs: readCubeMacs(entries, 0).entries });
  }

  /** Forgets the MAC address of the cube called `name`. */
  removeCubeMac(name: string): void {
    const key = name.trim().toLowerCase();
    this.update({
      cubeMacs: this.stored().cubeMacs.filter((entry) => entry.name.toLowerCase() !== key),
    });
  }

  /** Sets the demo speed; returns false, changing nothing, when it is not from 0.1 to 100. */
  setDemoSpeed(speed: number): boolean {
    if (!isDemoSpeed(speed)) {
      return false;
    }
    this.update({ demoSpeed: speed });
    return true;
  }

  setInspection(on: boolean): void {
    this.update({ inspection: on });
  }

  setAutoAdvance(on: boolean): void {
    this.update({ autoAdvance: on });
  }

  setScrambleOverPicture(on: boolean): void {
    if (on !== this.stored().scrambleOverPicture) {
      this.update({ scrambleOverPicture: on });
    }
  }

  /** Sets the idle disconnection; returns false, changing nothing, unless it is 0 to 60 minutes. */
  setIdleDisconnectMinutes(minutes: number): boolean {
    if (!isIdleDisconnectMinutes(minutes)) {
      return false;
    }
    this.update({ idleDisconnectMinutes: minutes });
    return true;
  }

  setCameraOn(on: boolean): void {
    if (on !== this.stored().cameraOn) {
      this.update({ cameraOn: on });
    }
  }

  setCameraResolution(resolution: CameraResolution): void {
    this.update({ cameraResolution: resolution });
  }

  setCameraFrameRate(rate: CameraFrameRate): void {
    this.update({ cameraFrameRate: rate });
  }

  setRecordAudio(on: boolean): void {
    if (on !== this.stored().recordAudio) {
      this.update({ recordAudio: on });
    }
  }

  setMicrophoneProcessing(processing: MicrophoneProcessing): void {
    if (processing !== this.stored().microphoneProcessing) {
      this.update({ microphoneProcessing: processing });
    }
  }

  setVideoQuality(quality: VideoQuality): void {
    if (quality !== this.stored().videoQuality) {
      this.update({ videoQuality: quality });
    }
  }

  setCameraSettingsOpen(open: boolean): void {
    if (open !== this.stored().cameraSettingsOpen) {
      this.update({ cameraSettingsOpen: open });
    }
  }

  setUploadSessions(on: boolean): void {
    if (on !== this.stored().uploadSessions) {
      this.update({ uploadSessions: on });
    }
  }

  setWifiOnly(on: boolean): void {
    if (on !== this.stored().wifiOnly) {
      this.update({ wifiOnly: on });
    }
  }

  setKeepLocalCopies(on: boolean): void {
    if (on !== this.stored().keepLocalCopies) {
      this.update({ keepLocalCopies: on });
    }
  }

  /** Sets the sharpness threshold; returns false, changing nothing, unless it is above 0. */
  setSharpnessThreshold(threshold: number): boolean {
    if (!isSharpnessThreshold(threshold)) {
      return false;
    }
    this.update({ sharpnessThreshold: threshold });
    return true;
  }

  /** The camera chosen on the host labelled `host`, or null. */
  cameraPickFor(host: string): CameraPick | null {
    return this.stored().cameraPicks.find((pick) => pick.host === host) ?? null;
  }

  /** Remembers the camera chosen on the host labelled `host`. */
  setCameraPick(host: string, deviceId: string, label: string): void {
    const current = this.cameraPickFor(host);
    if (current?.deviceId === deviceId && current.label === label) {
      return;
    }
    const others = this.stored().cameraPicks.filter((pick) => pick.host !== host);
    this.update({ cameraPicks: [...others, { host, deviceId, label }].slice(-MAX_CAMERA_ENTRIES) });
  }

  /** The manual controls chosen for the camera labelled `camera` (empty: all automatic). */
  cameraControlsFor(camera: string): ControlValues {
    return this.stored().cameraControls.find((entry) => entry.camera === camera)?.values ?? {};
  }

  /** Keeps the manual controls chosen for the camera labelled `camera`; empty values forget them. */
  setCameraControls(camera: string, values: ControlValues): void {
    // The torch is a light for the moment: it is never switched on by itself at the next start.
    const kept = Object.fromEntries(
      Object.entries(values).filter(([name, value]) => name !== 'torch' && value !== undefined),
    ) as ControlValues;
    const others = this.stored().cameraControls.filter((entry) => entry.camera !== camera);
    const entries = Object.keys(kept).length === 0 ? others : [...others, { camera, values: kept }];
    this.update({ cameraControls: entries.slice(-MAX_CAMERA_ENTRIES) });
  }

  /** The framing rectangles kept for the camera labelled `camera`, oldest first. */
  cameraFramingsOf(camera: string): readonly StoredFraming[] {
    return this.stored().cameraFramings.filter((entry) => entry.camera === camera);
  }

  /** Keeps `rect` as the framing of the camera labelled `camera` for frames of `size`. */
  setCameraFraming(camera: string, size: FrameSize, rect: FramingRect): void {
    const others = this.stored().cameraFramings.filter(
      (entry) =>
        entry.camera !== camera || entry.width !== size.width || entry.height !== size.height,
    );
    const entry: CameraFramingEntry = {
      camera,
      width: size.width,
      height: size.height,
      rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    };
    this.update({ cameraFramings: [...others, entry].slice(-MAX_FRAMINGS) });
  }

  private update(change: Partial<StoredSettings>): void {
    const next = { ...this.stored(), ...change };
    this.stored.set(next);
    this.saveErrorSignal.set(writeSettings(this.storage, next));
  }
}

/** `localStorage`, or null where the browser has none or refuses it to this page. */
function storageOf(globals: BrowserGlobals): Storage | null {
  try {
    return globals.localStorage ?? null;
  } catch {
    // Chrome throws a SecurityError on reading `localStorage` when site data is blocked.
    return null;
  }
}

/**
 * The settings stored, each field read on its own; `migrated` when cube entries stored before T3.4,
 * without `updatedMs`, got `nowMs`, which must then be written back.
 */
function readSettings(
  storage: Storage | null,
  nowMs: number,
): { settings: StoredSettings; migrated: boolean } {
  let parsed: unknown;
  try {
    const text = storage?.getItem(SETTINGS_STORAGE_KEY) ?? null;
    if (text === null) {
      return { settings: DEFAULTS, migrated: false };
    }
    parsed = JSON.parse(text);
  } catch {
    return { settings: DEFAULTS, migrated: false };
  }
  const hostLabel = member(parsed, 'hostLabel');
  const demoSpeed = member(parsed, 'demoSpeed');
  const inspection = member(parsed, 'inspection');
  const autoAdvance = member(parsed, 'autoAdvance');
  const scrambleOverPicture = member(parsed, 'scrambleOverPicture');
  const idleDisconnectMinutes = member(parsed, 'idleDisconnectMinutes');
  const cameraOn = member(parsed, 'cameraOn');
  const cameraResolution = member(parsed, 'cameraResolution');
  const cameraFrameRate = member(parsed, 'cameraFrameRate');
  const sharpnessThreshold = member(parsed, 'sharpnessThreshold');
  const recordAudio = member(parsed, 'recordAudio');
  const microphoneProcessing = member(parsed, 'microphoneProcessing');
  const videoQuality = member(parsed, 'videoQuality');
  const cameraSettingsOpen = member(parsed, 'cameraSettingsOpen');
  const uploadSessions = member(parsed, 'uploadSessions');
  const wifiOnly = member(parsed, 'wifiOnly');
  const keepLocalCopies = member(parsed, 'keepLocalCopies');
  const cubeMacs = readCubeMacs(member(parsed, 'cubeMacs'), nowMs);
  const settings: StoredSettings = {
    hostLabel:
      typeof hostLabel === 'string' && hostLabel.trim() !== ''
        ? hostLabel.trim()
        : DEFAULTS.hostLabel,
    cubeMacs: cubeMacs.entries,
    demoSpeed:
      typeof demoSpeed === 'number' && isDemoSpeed(demoSpeed) ? demoSpeed : DEFAULTS.demoSpeed,
    inspection: typeof inspection === 'boolean' ? inspection : DEFAULTS.inspection,
    autoAdvance: typeof autoAdvance === 'boolean' ? autoAdvance : DEFAULTS.autoAdvance,
    // Settings stored before T2.13 have none: on, as for a new device.
    scrambleOverPicture:
      typeof scrambleOverPicture === 'boolean' ? scrambleOverPicture : DEFAULTS.scrambleOverPicture,
    idleDisconnectMinutes:
      typeof idleDisconnectMinutes === 'number' && isIdleDisconnectMinutes(idleDisconnectMinutes)
        ? idleDisconnectMinutes
        : DEFAULTS.idleDisconnectMinutes,
    cameraOn: typeof cameraOn === 'boolean' ? cameraOn : DEFAULTS.cameraOn,
    cameraResolution:
      CAMERA_RESOLUTIONS.find((r) => r === cameraResolution) ?? DEFAULTS.cameraResolution,
    cameraFrameRate:
      CAMERA_FRAME_RATES.find((r) => r === cameraFrameRate) ?? DEFAULTS.cameraFrameRate,
    sharpnessThreshold:
      typeof sharpnessThreshold === 'number' && isSharpnessThreshold(sharpnessThreshold)
        ? sharpnessThreshold
        : DEFAULTS.sharpnessThreshold,
    recordAudio: typeof recordAudio === 'boolean' ? recordAudio : DEFAULTS.recordAudio,
    // Settings stored before T2.12 have none: Raw, as for a new device.
    microphoneProcessing:
      MICROPHONE_PROCESSINGS.find((p) => p === microphoneProcessing) ??
      DEFAULTS.microphoneProcessing,
    // Settings stored before T2.10 have none: Standard, as for a new device.
    videoQuality: VIDEO_QUALITIES.find((q) => q === videoQuality) ?? DEFAULTS.videoQuality,
    cameraSettingsOpen:
      typeof cameraSettingsOpen === 'boolean' ? cameraSettingsOpen : DEFAULTS.cameraSettingsOpen,
    cameraPicks: readList(member(parsed, 'cameraPicks'), readCameraPick).slice(-MAX_CAMERA_ENTRIES),
    cameraControls: readList(member(parsed, 'cameraControls'), readCameraControls).slice(
      -MAX_CAMERA_ENTRIES,
    ),
    cameraFramings: readList(member(parsed, 'cameraFramings'), readCameraFraming).slice(
      -MAX_FRAMINGS,
    ),
    // Settings stored before T3.3 have none: uploads on, and the device's defaults.
    uploadSessions: typeof uploadSessions === 'boolean' ? uploadSessions : DEFAULTS.uploadSessions,
    wifiOnly: typeof wifiOnly === 'boolean' ? wifiOnly : DEFAULTS.wifiOnly,
    keepLocalCopies:
      typeof keepLocalCopies === 'boolean' ? keepLocalCopies : DEFAULTS.keepLocalCopies,
  };
  return { settings, migrated: cubeMacs.migrated };
}

/** The entries of a stored list that `read` accepts; anything else is dropped. */
function readList<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as unknown[]).flatMap((item) => {
    const entry = read(item);
    return entry === null ? [] : [entry];
  });
}

function readCameraPick(item: unknown): CameraPick | null {
  const host = member(item, 'host');
  const deviceId = member(item, 'deviceId');
  const label = member(item, 'label');
  return typeof host === 'string' && typeof deviceId === 'string' && deviceId !== ''
    ? { host, deviceId, label: typeof label === 'string' ? label : '' }
    : null;
}

const METERING_MODES: readonly unknown[] = ['none', 'manual', 'single-shot', 'continuous'];
const MODE_CONTROLS: readonly string[] = ['exposureMode', 'focusMode', 'whiteBalanceMode'];
const NUMBER_CONTROLS: readonly string[] = [
  'exposureTime',
  'iso',
  'focusDistance',
  'colorTemperature',
  'zoom',
];

function readCameraControls(item: unknown): CameraControlsEntry | null {
  const camera = member(item, 'camera');
  const stored = member(item, 'values');
  if (typeof camera !== 'string') {
    return null;
  }
  const values: Record<string, unknown> = {};
  for (const name of MODE_CONTROLS) {
    const value = member(stored, name);
    if (METERING_MODES.includes(value)) {
      values[name] = value;
    }
  }
  for (const name of NUMBER_CONTROLS) {
    const value = member(stored, name);
    if (typeof value === 'number' && Number.isFinite(value)) {
      values[name] = value;
    }
  }
  return Object.keys(values).length === 0 ? null : { camera, values };
}

function readCameraFraming(item: unknown): CameraFramingEntry | null {
  const camera = member(item, 'camera');
  const width = member(item, 'width');
  const height = member(item, 'height');
  const rect = member(item, 'rect');
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map((key) => member(rect, key));
  const whole = (value: unknown): value is number => Number.isInteger(value);
  if (
    typeof camera !== 'string' ||
    !whole(width) ||
    !whole(height) ||
    width <= 0 ||
    height <= 0 ||
    !whole(x) ||
    !whole(y) ||
    !whole(w) ||
    !whole(h) ||
    x < 0 ||
    y < 0 ||
    w <= 0 ||
    h <= 0 ||
    x + w > width ||
    y + h > height
  ) {
    return null;
  }
  return { camera, width, height, rect: { x, y, w, h } };
}

/**
 * The valid entries of a stored list, normalized, one per name ignoring case, sorted by name;
 * anything else is dropped. An entry without a valid `updatedMs` (stored before T3.4) gets `nowMs`,
 * and `migrated` says that one did.
 */
function readCubeMacs(value: unknown, nowMs: number): { entries: CubeMac[]; migrated: boolean } {
  if (!Array.isArray(value)) {
    return { entries: [], migrated: false };
  }
  const byName = new Map<string, CubeMac>();
  let migrated = false;
  for (const item of value as unknown[]) {
    const name = member(item, 'name');
    const mac = member(item, 'mac');
    const normalized = typeof mac === 'string' ? normalizeMac(mac) : null;
    if (typeof name === 'string' && name.trim() !== '' && normalized !== null) {
      const stored = member(item, 'updatedMs');
      const known = typeof stored === 'number' && Number.isFinite(stored) && stored >= 0;
      migrated ||= !known;
      byName.set(name.trim().toLowerCase(), {
        name: name.trim(),
        mac: normalized,
        updatedMs: known ? stored : nowMs,
      });
    }
  }
  return { entries: sortByName(Array.from(byName.values())), migrated };
}

/** Writes the settings; returns why that failed, or null. */
function writeSettings(storage: Storage | null, settings: StoredSettings): string | null {
  if (storage === null) {
    return 'This browser does not let cubetrace store its settings: they last until the page closes.';
  }
  try {
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, ...settings }),
    );
    return null;
  } catch (error: unknown) {
    return `The settings could not be saved (${errorMessage(error)}): they last until the page closes.`;
  }
}

function sortByName(entries: readonly CubeMac[]): CubeMac[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (Reflect.get(value, key) as unknown) : null;
}

/**
 * This device's platform (such as `macOS` or `Android`; empty when unknown) and whether it is a
 * phone, for `host` in session.json: from the user-agent client hints (Chrome) or else the
 * user-agent string.
 */
export function hostPlatform(navigator: Partial<Navigator> | undefined): {
  platform: string;
  mobile: boolean;
} {
  const hints = member(navigator, 'userAgentData');
  const hintedPlatform = member(hints, 'platform');
  const hintedMobile = member(hints, 'mobile');
  const userAgent = typeof navigator?.userAgent === 'string' ? navigator.userAgent : '';
  const platform =
    typeof hintedPlatform === 'string' && hintedPlatform !== ''
      ? hintedPlatform
      : platformFromUserAgent(userAgent);
  const mobile = typeof hintedMobile === 'boolean' ? hintedMobile : /Mobi/.test(userAgent);
  return { platform, mobile };
}

/**
 * A short name for this device from its platform, such as "macOS laptop" or "Android phone":
 * from the user-agent client hints (Chrome) or else the user-agent string.
 */
export function defaultHostLabel(navigator: Partial<Navigator> | undefined): string {
  const { platform, mobile } = hostPlatform(navigator);
  const userAgent = typeof navigator?.userAgent === 'string' ? navigator.userAgent : '';
  switch (platform) {
    case 'Android':
      return mobile ? 'Android phone' : 'Android tablet';
    case 'iOS':
      return mobile && !/iPad/.test(userAgent) ? 'iPhone' : 'iPad';
    case 'Chrome OS':
    case 'Chromium OS':
      return 'Chromebook';
    case 'macOS':
    case 'Windows':
    case 'Linux':
      return `${platform} laptop`;
    default:
      return mobile ? 'Phone' : 'Laptop';
  }
}

function platformFromUserAgent(userAgent: string): string {
  if (/Android/.test(userAgent)) {
    return 'Android';
  }
  if (/iPhone|iPad|iPod/.test(userAgent)) {
    return 'iOS';
  }
  if (/CrOS/.test(userAgent)) {
    return 'Chrome OS';
  }
  if (/Macintosh|Mac OS X/.test(userAgent)) {
    return 'macOS';
  }
  if (/Windows/.test(userAgent)) {
    return 'Windows';
  }
  return /Linux/.test(userAgent) ? 'Linux' : '';
}
