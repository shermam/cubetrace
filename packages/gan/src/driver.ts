// The boundary with the GAN driver: the owner's fork of gan-web-bluetooth, a git dependency
// pinned to one commit (docs/TOOLCHAIN.md, "GAN driver"). The fork is plain JavaScript with JSDoc
// and ships no declaration for its entry point, so this module states the part of its API that
// connection.ts relies on, transcribed from the fork's src/types.d.ts at that commit. The tests
// drive connection.ts with hand-built objects of these types; the real driver needs a cube
// (docs/MANUAL-TESTS.md).

/**
 * An event of the driver (`GanCubeEvent`). `timestamp` is the driver's `now()` when the
 * Bluetooth message arrived: `Math.floor(performance.now())` in a window, `Date.now()` elsewhere
 * (the fork's src/utils.js).
 */
export type GanDriverEvent =
  | {
      type: 'MOVE';
      timestamp: number;
      /** The cube's move counter, 0–255, wrapping. */
      serial: number;
      /** 0–5 for U R F D L B. */
      face: number;
      /** 0 clockwise, 1 counter-clockwise. */
      direction: number;
      /** `"R"` or `"R'"`. */
      move: string;
      /**
       * `timestamp` for the newest move of its Bluetooth message; `null` for the older moves of
       * the same message and for moves recovered after being missed.
       */
      localTimestamp: number | null;
      /** The cube's clock; `null` for recovered moves on Gen3/Gen4 cubes. */
      cubeTimestamp: number | null;
    }
  | { type: 'FACELETS'; timestamp: number; serial: number; facelets: string }
  | {
      type: 'GYRO';
      timestamp: number;
      quaternion: { x: number; y: number; z: number; w: number };
      velocity?: { x: number; y: number; z: number };
    }
  | { type: 'BATTERY'; timestamp: number; batteryLevel: number }
  | {
      type: 'HARDWARE';
      timestamp: number;
      hardwareName?: string;
      softwareVersion?: string;
      hardwareVersion?: string;
      productDate?: string;
      gyroSupported?: boolean;
    }
  | { type: 'DISCONNECT'; timestamp: number };

export interface GanDriverObserver<T> {
  next(value: T): void;
  error(err: unknown): void;
  complete(): void;
}

/**
 * The fork's `events$` is a native (WICG) Observable, whose `subscribe` takes the observer and
 * `{ signal }` and returns nothing; upstream's is an RxJS Subject, whose `subscribe` returns a
 * Subscription. Both fit this shape; the tests use an RxJS Subject.
 */
export interface GanDriverSubscribable<T> {
  subscribe(observer: GanDriverObserver<T>, options?: { signal?: AbortSignal }): unknown;
}

export interface GanDriverCommand {
  type: 'REQUEST_FACELETS' | 'REQUEST_HARDWARE' | 'REQUEST_BATTERY' | 'REQUEST_RESET';
}

/** The connection object that the driver's `connectGanCube` resolves with. */
export interface GanDriverConnection {
  readonly deviceName: string;
  readonly deviceMAC: string;
  /**
   * Cold in the fork: every subscription registers its own listener and runs the driver's
   * (stateful) message decoder, so it must be subscribed to exactly once.
   */
  readonly events$?: GanDriverSubscribable<GanDriverEvent>;
  /** Resolves when the command has been written to the cube, not when it answers. */
  sendCubeCommand(command: GanDriverCommand): Promise<void>;
  /** Upstream only: the fork has no `disconnect()`. */
  disconnect?: () => Promise<void>;
}

/** The part of Web Bluetooth's `BluetoothDevice` that the wrapper touches. */
export interface GanDriverDevice {
  readonly id: string;
  /** `null` or absent when the device did not say (the IDL's `DOMString? name`). */
  readonly name?: string | null | undefined;
  readonly gatt?: { readonly connected: boolean; disconnect(): void } | undefined;
}

/** The driver's `MacAddressProvider`. */
export type GanDriverMacProvider = (
  device: GanDriverDevice,
  isFallbackCall?: boolean,
) => Promise<string | null>;

/** The driver's `connectGanCube`: opens the browser's device picker, then connects. */
export type ConnectGanDriver = (
  customMacAddressProvider?: GanDriverMacProvider,
) => Promise<GanDriverConnection>;

/** The loader behind {@link loadGanDriver}, created on its first call. */
let loadDriver: (() => Promise<ConnectGanDriver>) | undefined;

/**
 * Loads the driver on first use, so that it is a chunk of its own that the browser downloads
 * only when it is needed (the support check and the fake cube never need it). Every caller gets
 * the same load: the app starts it as soon as it knows the browser has Web Bluetooth (a preload,
 * T1.14), and `connectGanCube` awaits that same promise, so a click on Connect after the preload
 * has finished does not wait for the download (Chrome opens its device picker only within a few
 * seconds of the click). A failed load is not kept: the next call tries again.
 */
export function loadGanDriver(): Promise<ConnectGanDriver> {
  loadDriver ??= createGanDriverLoader(importGanDriver);
  return loadDriver();
}

/** The dynamic import that makes the driver a chunk of its own. */
function importGanDriver(): Promise<unknown> {
  // @ts-expect-error -- TS7016: the fork is JavaScript without a declaration file; typed above.
  return import('gan-web-bluetooth/src/index.js');
}

/**
 * {@link loadGanDriver} with the import injected (the tests' fake one): a function that imports the
 * module once, however many times it is called and whether or not the import has finished, and
 * resolves with its `connectGanCube`; after a failure, the next call imports again.
 */
export function createGanDriverLoader(
  importModule: () => Promise<unknown>,
): () => Promise<ConnectGanDriver> {
  let load: Promise<ConnectGanDriver> | null = null;
  return () => {
    load ??= importModule()
      .then(connectGanCubeOf)
      .catch((error: unknown) => {
        load = null;
        throw error;
      });
    return load;
  };
}

/** The driver module's `connectGanCube`, checked. */
function connectGanCubeOf(driver: unknown): ConnectGanDriver {
  if (typeof driver !== 'object' || driver === null || !('connectGanCube' in driver)) {
    throw new Error('The GAN driver (gan-web-bluetooth) does not export connectGanCube.');
  }
  const connect = driver.connectGanCube;
  if (typeof connect !== 'function') {
    throw new Error('The GAN driver (gan-web-bluetooth) does not export connectGanCube.');
  }
  return connect as ConnectGanDriver;
}
