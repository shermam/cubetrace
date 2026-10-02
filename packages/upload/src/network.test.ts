import { describe, expect, it } from 'vitest';

import { networkHold } from './network';

describe('networkHold', () => {
  it('holds everything offline', () => {
    expect(networkHold({ online: false }, false)).toBe('offline');
    expect(networkHold({ online: false, type: 'wifi' }, true)).toBe('offline');
    expect(networkHold({ online: true, type: 'none' }, false)).toBe('offline');
  });

  it('holds nothing online without Wi-Fi only', () => {
    expect(networkHold({ online: true }, false)).toBeNull();
    expect(networkHold({ online: true, type: 'cellular', effectiveType: '2g' }, false)).toBeNull();
  });

  it('with Wi-Fi only, goes on Wi-Fi and a cable, and holds on mobile data', () => {
    expect(networkHold({ online: true, type: 'wifi', effectiveType: '4g' }, true)).toBeNull();
    expect(networkHold({ online: true, type: 'ethernet' }, true)).toBeNull();
    for (const type of ['cellular', 'bluetooth', 'wimax']) {
      expect(networkHold({ online: true, type, effectiveType: '4g' }, true), type).toBe('not-wifi');
    }
  });

  it('with Wi-Fi only and no type said, takes a slow link for mobile data', () => {
    for (const effectiveType of ['slow-2g', '2g', '3g']) {
      expect(networkHold({ online: true, effectiveType }, true), effectiveType).toBe('not-wifi');
      expect(networkHold({ online: true, type: 'unknown', effectiveType }, true)).toBe('not-wifi');
    }
    expect(networkHold({ online: true, effectiveType: '4g' }, true)).toBeNull();
    expect(networkHold({ online: true, type: 'other', effectiveType: '4g' }, true)).toBeNull();
    expect(networkHold({ online: true }, true)).toBeNull();
  });
});
