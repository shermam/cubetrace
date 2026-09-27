// The words for a failed connection, under the connect button and in the connect dialog
// (docs/PLAN.md, T1.6a: "errors in plain words"). The messages matched below are Chrome's (Web
// Bluetooth), the GAN driver's (gan-web-bluetooth/src/gan-smart-cube.js) and @cubetrace/gan's
// (packages/gan/src/connection.ts).

/** What was known about the MAC address when the connection failed. */
export interface MacContext {
  /** The address cubetrace gave the driver (stored in Settings or typed), if any. */
  readonly mac: string | null;
  /** The user closed the MAC prompt without an address. */
  readonly cancelled: boolean;
}

/** One sentence or two about why connecting a GAN cube failed, and what to do. */
export function describeConnectError(error: unknown, macContext: MacContext): string {
  const name = stringMember(error, 'name') ?? '';
  const message = stringMember(error, 'message') ?? String(error);
  if (name === 'NotFoundError' && /cancel/i.test(message)) {
    return "No cube was chosen: pick the cube in Chrome's list of devices to connect it.";
  }
  if (name === 'NotFoundError' && /adapter/i.test(message)) {
    return 'Bluetooth is off or missing on this device: turn it on and try again.';
  }
  if (name === 'SecurityError') {
    return `Chrome refused Bluetooth to this page (${message}): it needs an https:// page and a click on Connect.`;
  }
  if (name === 'NotAllowedError') {
    return `Chrome blocked Bluetooth for this site (${message}): allow it in the site settings and try again.`;
  }
  if (/Unable to determine cube MAC address/i.test(message)) {
    return macContext.cancelled
      ? "Not connected: the cube's MAC address is needed to talk to it, and none was given."
      : "Not connected: Chrome could not read the cube's MAC address. Turn on the Chrome flag that lets it, or type the address when asked.";
  }
  if (/did not report its state/i.test(message)) {
    const check =
      macContext.mac === null
        ? ''
        : ` If it is, check its MAC address: ${macContext.mac} may not be this cube's (Settings, Cube MAC addresses).`;
    return `The cube did not send its state: is it on and nearby?${check}`;
  }
  if (/disconnected before reporting its state/i.test(message)) {
    return 'The cube disconnected before sending its state: is it on, charged and nearby?';
  }
  if (/Can't find target BLE services/i.test(message)) {
    return 'That device is not a GAN cube that cubetrace can talk to.';
  }
  if (name === 'NetworkError') {
    return `The cube could not be reached (${message}): is it on and nearby?`;
  }
  return message === '' ? 'The cube could not be connected.' : message;
}

/** `value[key]` when it is a string (errors and DOMExceptions alike). */
function stringMember(value: unknown, key: 'name' | 'message'): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }
  const member: unknown = Reflect.get(value, key);
  return typeof member === 'string' ? member : null;
}
