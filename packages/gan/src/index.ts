// Public API of @cubetrace/gan: one typed event stream for the app, whether the cube is a GAN cube
// over Web Bluetooth or the fake cube (docs/PLAN.md, T1.5). Plain TypeScript: no Angular.
export type {
  BluetoothSupport,
  CubeBatteryEvent,
  CubeConnection,
  CubeDisconnectedEvent,
  CubeEvent,
  CubeFaceletsEvent,
  CubeGyroEvent,
  CubeHardwareEvent,
  CubeMoveEvent,
  MacProvider,
} from './types';
export {
  FACELETS_RETRY_MS,
  FIRST_FACELETS_TIMEOUT_MS,
  connectGanCube,
  normalizeMac,
} from './connection';
export { MAC_FLAG_URL, checkBluetoothSupport } from './support';
export type { FakeCubeOptions, ScheduledMove } from './fake';
export { FAKE_CUBE_BATTERY, FAKE_CUBE_HARDWARE, FakeCube } from './fake';
