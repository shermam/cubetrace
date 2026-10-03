import type { DeviceInfo } from '@cubetrace/rtc';

import type { BrowserGlobals } from '../device/browser-globals';
import { SettingsService, hostPlatform } from '../settings/settings-service';

/**
 * This device as `hello` names it (docs/RTC.md §1), and as a remote camera's `remote` names the
 * device it runs on (docs/DATA-MODEL.md §6): its host label (Settings → This device) and its platform.
 */
export function thisDevice(settings: SettingsService, globals: BrowserGlobals): DeviceInfo {
  return { label: settings.hostLabel(), platform: hostPlatform(globals.navigator).platform };
}

/** A duration for the connection's lines: "4 s", "2 min 05 s", "1 h 02 min". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${String(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)} min ${String(seconds % 60).padStart(2, '0')} s`;
  }
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** An offset or a round trip in ms, signed where it may be negative: "−3,127.4 ms", "9.6 ms". */
export function msText(ms: number, decimals = 1): string {
  const text = Math.abs(ms).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${ms < 0 ? '−' : ''}${text} ms`;
}
