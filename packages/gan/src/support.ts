// What this browser can do for a GAN cube, for the connect dialog (docs/PLAN.md, T1.5).
import type { BluetoothSupport } from './types';

/**
 * The Chrome flag that exposes `navigator.bluetooth.getDevices()` and
 * `BluetoothDevice.watchAdvertisements()`, the API the driver reads the cube's MAC address with.
 * In Chromium both are "experimental" features switched on by this flag (on Android and desktop)
 * or by `#enable-experimental-web-platform-features`, the one the driver author's sample app
 * names; this one turns on nothing else (docs/TOOLCHAIN.md, "GAN driver").
 */
export const MAC_FLAG_URL = 'chrome://flags/#enable-web-bluetooth-new-permissions-backend';

const NO_BLUETOOTH =
  'This browser cannot connect to a Bluetooth cube. Use Chrome on Android, macOS, Windows or ' +
  'ChromeOS, on an https:// page (Chrome on Linux also needs ' +
  'chrome://flags/#enable-experimental-web-platform-features). The demo cube works anywhere.';

const NO_OBSERVABLE =
  'This version of Chrome is too old for the cube driver, which needs the Observable API ' +
  '(EventTarget.when). Update Chrome and reload.';

const MAC_AUTOMATIC =
  "Bluetooth is ready; the cube's MAC address will be read automatically when it connects.";

const MAC_MANUAL =
  `Bluetooth is ready, but Chrome cannot read the cube's MAC address by itself. Enable ` +
  `${MAC_FLAG_URL} and restart Chrome, or type the address when asked (six hex bytes such as ` +
  'AB:12:CD:34:EF:56; chrome://bluetooth-internals lists nearby devices with their addresses).';

/**
 * Checks `nav` (the page's `navigator`) for Web Bluetooth (`navigator.bluetooth.requestDevice`),
 * for the Observable API that the driver fork is written with (`when()` on every EventTarget,
 * `navigator.bluetooth` included), and for `navigator.bluetooth.getDevices`, which Chrome exposes
 * together with `watchAdvertisements()`, the API that reads the MAC address. Takes a partial
 * navigator too, such as the app's `BROWSER_GLOBALS.navigator`.
 */
export function checkBluetoothSupport(nav: Partial<Navigator> | undefined): BluetoothSupport {
  const bluetooth: unknown = nav !== undefined && 'bluetooth' in nav ? nav.bluetooth : undefined;
  if (
    typeof bluetooth !== 'object' ||
    bluetooth === null ||
    !('requestDevice' in bluetooth) ||
    typeof bluetooth.requestDevice !== 'function'
  ) {
    return { available: false, canReadMacAutomatically: false, hint: NO_BLUETOOTH };
  }
  if (!('when' in bluetooth) || typeof bluetooth.when !== 'function') {
    return { available: false, canReadMacAutomatically: false, hint: NO_OBSERVABLE };
  }
  if ('getDevices' in bluetooth && typeof bluetooth.getDevices === 'function') {
    return { available: true, canReadMacAutomatically: true, hint: MAC_AUTOMATIC };
  }
  return {
    available: true,
    canReadMacAutomatically: false,
    hint: MAC_MANUAL,
    flagUrl: MAC_FLAG_URL,
  };
}
