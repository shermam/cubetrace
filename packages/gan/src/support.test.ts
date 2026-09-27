// The support check on hand-built navigators, and on Node's own (Node 21+), which has no Bluetooth.
import { describe, expect, it } from 'vitest';

import { MAC_FLAG_URL, checkBluetoothSupport } from './index';

/** A `navigator` whose `bluetooth` has exactly the given members. */
function navigatorWith(bluetooth: Record<string, unknown>): Navigator {
  return { bluetooth } as unknown as Navigator;
}

const noop = (): void => undefined;

describe('checkBluetoothSupport', () => {
  it('without a navigator: not available, with a hint', () => {
    const support = checkBluetoothSupport(undefined);
    expect(support.available).toBe(false);
    expect(support.canReadMacAutomatically).toBe(false);
    expect(support.hint).toMatch(/Chrome/);
    expect(support.flagUrl).toBeUndefined();
  });

  it('with a navigator that has no bluetooth (Firefox, Safari, Node): not available', () => {
    for (const nav of [{} as Navigator, globalThis.navigator, navigatorWith({})]) {
      const support = checkBluetoothSupport(nav);
      expect(support.available).toBe(false);
      expect(support.canReadMacAutomatically).toBe(false);
      expect(support.hint).toMatch(/cannot connect to a Bluetooth cube/);
      expect(support.flagUrl).toBeUndefined();
    }
  });

  it('without the Observable API that the driver needs: not available, update Chrome', () => {
    const support = checkBluetoothSupport(navigatorWith({ requestDevice: noop, getDevices: noop }));
    expect(support.available).toBe(false);
    expect(support.hint).toMatch(/Update Chrome/);
  });

  it('with bluetooth but without getDevices: available, the MAC is typed, the flag is named', () => {
    const support = checkBluetoothSupport(navigatorWith({ requestDevice: noop, when: noop }));
    expect(support).toEqual({
      available: true,
      canReadMacAutomatically: false,
      hint: expect.stringContaining(MAC_FLAG_URL) as unknown,
      flagUrl: 'chrome://flags/#enable-web-bluetooth-new-permissions-backend',
    });
    expect(support.hint).toMatch(/type the address/);
  });

  it('with getDevices (the flag is on): the MAC is read automatically', () => {
    const support = checkBluetoothSupport(
      navigatorWith({ requestDevice: noop, when: noop, getDevices: noop }),
    );
    expect(support.available).toBe(true);
    expect(support.canReadMacAutomatically).toBe(true);
    expect(support.flagUrl).toBeUndefined();
    expect(support.hint).toMatch(/automatically/);
  });
});
