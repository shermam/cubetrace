import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS, type BrowserGlobals } from './browser-globals';
import { BrowserSupportService, findMissingApis } from './browser-support-service';
import { FakeStorageManager, FakeVideoEncoder } from './fake-browser';

// Navigators as the browsers expose them (Web Bluetooth is not in TypeScript's DOM types).
const storage = new FakeStorageManager({});
const withBluetooth = { bluetooth: {}, storage };
const withoutBluetooth = { storage };

const chrome: BrowserGlobals = { navigator: withBluetooth, VideoEncoder: FakeVideoEncoder };
const firefox: BrowserGlobals = { navigator: withoutBluetooth, VideoEncoder: FakeVideoEncoder };
const oldSafari: BrowserGlobals = { navigator: withoutBluetooth };

describe('findMissingApis', () => {
  it('finds nothing missing in Chrome', () => {
    expect(findMissingApis(chrome)).toEqual([]);
  });

  it('finds Web Bluetooth missing in Firefox', () => {
    expect(findMissingApis(firefox).map((api) => api.id)).toEqual(['web-bluetooth']);
  });

  it('finds Web Bluetooth and WebCodecs missing in an older Safari', () => {
    expect(findMissingApis(oldSafari).map((api) => api.id)).toEqual(['web-bluetooth', 'webcodecs']);
  });

  it('finds everything missing without a navigator', () => {
    expect(findMissingApis({}).map((api) => api.id)).toEqual([
      'web-bluetooth',
      'opfs',
      'webcodecs',
    ]);
  });
});

describe('BrowserSupportService', () => {
  it('tells which APIs this browser has', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: firefox }],
    });
    const support = TestBed.inject(BrowserSupportService);

    expect(support.has('web-bluetooth')).toBe(false);
    expect(support.has('opfs')).toBe(true);
    expect(support.has('webcodecs')).toBe(true);
  });
});
