import { Injectable, computed, inject, signal } from '@angular/core';
import { normalizeMac } from '@cubetrace/gan';

import { DEMO_SPEED_DEFAULT, isDemoSpeed } from '../cube/demo';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { errorMessage } from '../shared/error-message';

/** The `localStorage` key of the settings (one JSON object). */
export const SETTINGS_STORAGE_KEY = 'cubetrace.settings';

/** A cube's MAC address, stored under the Bluetooth name the cube advertises. */
export interface CubeMac {
  /** As Chrome's device list shows it, such as `GAN12ui_AB12`; matched ignoring case. */
  readonly name: string;
  /** Normalized: `AB:12:CD:34:EF:56`. */
  readonly mac: string;
}

/** The outcome of storing a cube's MAC address: the stored entry, or why it was refused. */
export type CubeMacResult =
  { readonly ok: true; readonly entry: CubeMac } | { readonly ok: false; readonly error: string };

/** What `localStorage` holds; every field is checked on reading and falls back on its own. */
interface StoredSettings {
  /** Null: the default label of this device. */
  readonly hostLabel: string | null;
  readonly cubeMacs: readonly CubeMac[];
  readonly demoSpeed: number;
  readonly inspection: boolean;
  readonly autoAdvance: boolean;
}

const DEFAULTS: StoredSettings = {
  hostLabel: null,
  cubeMacs: [],
  demoSpeed: DEMO_SPEED_DEFAULT,
  inspection: false,
  autoAdvance: true,
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
 * sessions record, the cubes' MAC addresses by Bluetooth name, the demo speed, inspection and
 * auto-advance. Signals, kept in `localStorage` (through BROWSER_GLOBALS) as one JSON object that
 * is written on every change. Where the browser blocks storage the settings last until the page
 * closes, and `saveError` says so.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly storage = storageOf(this.globals);
  private readonly stored = signal<StoredSettings>(readSettings(this.storage));
  private readonly saveErrorSignal = signal<string | null>(null);

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
  /** Why the last change could not be stored; null when it was. */
  readonly saveError = this.saveErrorSignal.asReadonly();

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
   * the entry called `replacing`, when one is being edited). Refuses an empty name or a text that
   * is not a MAC address.
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
    const entry: CubeMac = { name: trimmed, mac: normalized };
    const gone = new Set([trimmed.toLowerCase(), replacing?.trim().toLowerCase()]);
    const others = this.stored().cubeMacs.filter((e) => !gone.has(e.name.toLowerCase()));
    this.update({ cubeMacs: sortByName([...others, entry]) });
    return { ok: true, entry };
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

function readSettings(storage: Storage | null): StoredSettings {
  let parsed: unknown;
  try {
    const text = storage?.getItem(SETTINGS_STORAGE_KEY) ?? null;
    if (text === null) {
      return DEFAULTS;
    }
    parsed = JSON.parse(text);
  } catch {
    return DEFAULTS;
  }
  const hostLabel = member(parsed, 'hostLabel');
  const demoSpeed = member(parsed, 'demoSpeed');
  const inspection = member(parsed, 'inspection');
  const autoAdvance = member(parsed, 'autoAdvance');
  return {
    hostLabel:
      typeof hostLabel === 'string' && hostLabel.trim() !== ''
        ? hostLabel.trim()
        : DEFAULTS.hostLabel,
    cubeMacs: readCubeMacs(member(parsed, 'cubeMacs')),
    demoSpeed:
      typeof demoSpeed === 'number' && isDemoSpeed(demoSpeed) ? demoSpeed : DEFAULTS.demoSpeed,
    inspection: typeof inspection === 'boolean' ? inspection : DEFAULTS.inspection,
    autoAdvance: typeof autoAdvance === 'boolean' ? autoAdvance : DEFAULTS.autoAdvance,
  };
}

/** The valid entries of a stored list, normalized; anything else is dropped. */
function readCubeMacs(value: unknown): CubeMac[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byName = new Map<string, CubeMac>();
  for (const item of value as unknown[]) {
    const name = member(item, 'name');
    const mac = member(item, 'mac');
    const normalized = typeof mac === 'string' ? normalizeMac(mac) : null;
    if (typeof name === 'string' && name.trim() !== '' && normalized !== null) {
      byName.set(name.trim().toLowerCase(), { name: name.trim(), mac: normalized });
    }
  }
  return sortByName(Array.from(byName.values()));
}

/** Writes the settings; returns why that failed, or null. */
function writeSettings(storage: Storage | null, settings: StoredSettings): string | null {
  if (storage === null) {
    return 'This browser does not let cubetrace store its settings: they last until the page closes.';
  }
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ version: 1, ...settings }));
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
