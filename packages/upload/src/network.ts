// Whether the network lets the queue upload now (docs/PLAN.md T3.3): online, and, with "Wi-Fi only",
// on Wi-Fi as far as the browser tells. Chrome on Android says the connection's type
// (`navigator.connection.type`: `wifi`, `cellular`, `ethernet`, …) and fires `change` on the
// connection when it changes; desktop Chrome has `navigator.connection` without a type (Settings
// hides "Wi-Fi only" there).

/** What the browser says of the network now. */
export interface ConnectionInfo {
  /** `navigator.onLine`: false when the device has no network at all. */
  readonly online: boolean;
  /** `navigator.connection.type`, where the browser has it. */
  readonly type?: string | undefined;
  /** `navigator.connection.effectiveType` (`slow-2g`, `2g`, `3g`, `4g`), where it has it. */
  readonly effectiveType?: string | undefined;
}

/** Why the network keeps the queue from uploading: `offline`, or `not-wifi` under "Wi-Fi only". */
export type NetworkHold = 'offline' | 'not-wifi';

/** The types that are Wi-Fi as far as "Wi-Fi only" is concerned: Wi-Fi, and a cable. */
const WIFI_TYPES: readonly string[] = ['wifi', 'ethernet'];

/** The types that are mobile data or another metered link. */
const METERED_TYPES: readonly string[] = ['cellular', 'bluetooth', 'wimax'];

/** The effective types that only mobile data gives: anything but a fast link. */
const SLOW_TYPES: readonly string[] = ['slow-2g', '2g', '3g'];

/**
 * What keeps the queue from uploading on `connection`, or null when nothing does. Offline (the
 * browser says so, or the connection's type is `none`), nothing uploads. With `wifiOnly`, it uploads
 * on Wi-Fi or Ethernet, not on mobile data (`cellular`, and Bluetooth and WiMAX); when the browser
 * gives no type, or `unknown` or `other`, the effective type decides: a slow link (`slow-2g`, `2g`,
 * `3g`) is taken for mobile data, a fast one, or none said, for Wi-Fi.
 */
export function networkHold(connection: ConnectionInfo, wifiOnly: boolean): NetworkHold | null {
  if (!connection.online || connection.type === 'none') {
    return 'offline';
  }
  if (!wifiOnly) {
    return null;
  }
  const type = connection.type;
  if (type !== undefined && WIFI_TYPES.includes(type)) {
    return null;
  }
  if (type !== undefined && METERED_TYPES.includes(type)) {
    return 'not-wifi';
  }
  const effective = connection.effectiveType;
  return effective !== undefined && SLOW_TYPES.includes(effective) ? 'not-wifi' : null;
}
