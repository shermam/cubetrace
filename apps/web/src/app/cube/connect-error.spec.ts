import { describeConnectError } from './connect-error';

describe('describeConnectError', () => {
  const noMac = { mac: null, cancelled: false };

  it('says that no cube was chosen when the picker was cancelled', () => {
    const error = new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');

    expect(describeConnectError(error, noMac)).toBe(
      "No cube was chosen: pick the cube in Chrome's list of devices to connect it.",
    );
  });

  it('says that Bluetooth is off', () => {
    const error = new DOMException('Bluetooth adapter not available.', 'NotFoundError');

    expect(describeConnectError(error, noMac)).toBe(
      'Bluetooth is off or missing on this device: turn it on and try again.',
    );
  });

  it('asks whether the cube is on when it sends no state, naming a MAC address it was given', () => {
    const error = new Error(
      'The cube did not report its state within 5 s of connecting. If its MAC address was ' +
        'typed, check it: with a wrong address, nothing the cube sends can be decrypted.',
    );

    expect(describeConnectError(error, noMac)).toBe(
      'The cube did not send its state: is it on and nearby?',
    );
    expect(describeConnectError(error, { mac: 'AB:12:CD:34:EF:56', cancelled: false })).toBe(
      'The cube did not send its state: is it on and nearby? If it is, check its MAC address: ' +
        "AB:12:CD:34:EF:56 may not be this cube's (Settings, Cube MAC addresses).",
    );
  });

  it('explains a missing MAC address, typed or not', () => {
    const error = new Error('Unable to determine cube MAC address, connection is not possible!');

    expect(describeConnectError(error, noMac)).toContain(
      "Chrome could not read the cube's MAC address",
    );
    expect(describeConnectError(error, { mac: null, cancelled: true })).toBe(
      "Not connected: the cube's MAC address is needed to talk to it, and none was given.",
    );
  });

  it('names a text that is not a MAC address', () => {
    const error = new Error(
      '"AB:12" is not a MAC address: six hex bytes are expected, such as AB:12:CD:34:EF:56.',
    );

    expect(describeConnectError(error, noMac)).toBe(error.message);
  });

  it.each([
    [
      new Error(
        'The cube disconnected before reporting its state. The Bluetooth connection was closed.',
      ),
      'The cube disconnected before sending its state: is it on, charged and nearby?',
    ],
    [
      new Error("Can't find target BLE services - wrong or unsupported cube device model"),
      'That device is not a GAN cube that cubetrace can talk to.',
    ],
    [
      new DOMException('Connection failed for unknown reason.', 'NetworkError'),
      'The cube could not be reached (Connection failed for unknown reason.): is it on and nearby?',
    ],
    [
      new DOMException(
        'Must be handling a user gesture to show a permission request.',
        'SecurityError',
      ),
      'Chrome refused Bluetooth to this page (Must be handling a user gesture to show a permission request.): it needs an https:// page and a click on Connect.',
    ],
    [
      new DOMException('Web Bluetooth permission has been blocked.', 'NotAllowedError'),
      'Chrome blocked Bluetooth for this site (Web Bluetooth permission has been blocked.): allow it in the site settings and try again.',
    ],
    ['a string', 'a string'],
    [new Error(''), 'The cube could not be connected.'],
  ])('describes %s', (error, text) => {
    expect(describeConnectError(error, noMac)).toBe(text);
  });
});
