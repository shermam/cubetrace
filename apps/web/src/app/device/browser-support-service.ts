import { Injectable, inject } from '@angular/core';

import { BROWSER_GLOBALS, type BrowserGlobals } from './browser-globals';

/** A browser API the app needs, and what for. */
export interface RequiredApi {
  readonly id: 'web-bluetooth' | 'opfs' | 'webcodecs';
  readonly name: string;
  readonly usedFor: string;
}

/**
 * The required APIs this browser lacks: Web Bluetooth (the cube), the origin private file
 * system (sessions) and WebCodecs (video, from phase 2). Chrome on Android, macOS and Windows
 * has them all; Firefox and Safari lack at least Web Bluetooth.
 */
export function findMissingApis(globals: BrowserGlobals): RequiredApi[] {
  const nav = globals.navigator;
  const missing: RequiredApi[] = [];
  if (!nav || !('bluetooth' in nav)) {
    missing.push({ id: 'web-bluetooth', name: 'Web Bluetooth', usedFor: 'connecting the cube' });
  }
  if (typeof nav?.storage?.getDirectory !== 'function') {
    missing.push({
      id: 'opfs',
      name: 'the origin private file system',
      usedFor: 'saving sessions',
    });
  }
  if (typeof globals.VideoEncoder !== 'function') {
    missing.push({ id: 'webcodecs', name: 'WebCodecs', usedFor: 'recording video' });
  }
  return missing;
}

/** Which required browser APIs are missing here, checked once at start-up. */
@Injectable({ providedIn: 'root' })
export class BrowserSupportService {
  /** Empty in Chrome on Android, macOS and Windows. */
  readonly missing: readonly RequiredApi[] = findMissingApis(inject(BROWSER_GLOBALS));

  /** Whether this browser has the API. */
  has(id: RequiredApi['id']): boolean {
    return !this.missing.some((api) => api.id === id);
  }
}
