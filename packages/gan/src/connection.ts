// A GAN cube over Web Bluetooth: the driver fork's events as CubeEvent (docs/PLAN.md, T1.5).
// Everything that touches the driver goes through the types of driver.ts, so the tests run the
// whole connection against a hand-built driver; the browser part is in docs/MANUAL-TESTS.md.
import { applyMove, assertFacelets, parseMove, type Facelets, type Move } from '@cubetrace/core';

import {
  loadGanDriver,
  type ConnectGanDriver,
  type GanDriverCommand,
  type GanDriverConnection,
  type GanDriverDevice,
  type GanDriverEvent,
} from './driver';
import { CubeEventHub } from './hub';
import type { CubeConnection, CubeEvent, CubeMoveEvent, MacProvider } from './types';

/** How long connecting waits for the cube's first facelets report before giving up. */
export const FIRST_FACELETS_TIMEOUT_MS = 5000;

/** When the facelets request is sent again if the cube has not answered yet. */
export const FACELETS_RETRY_MS = 1500;

/**
 * Connects a GAN smart cube: opens Chrome's device picker, obtains the MAC address (from
 * `macProvider` or, when the browser allows it, from the cube's advertisements), connects, asks
 * for the cube's state and resolves once the first valid facelets report has arrived; that state
 * is the connection's `facelets`. Subscribe to `events$` right after the promise resolves (in the
 * same task, as `await` does) and no move is missed. Rejects if the user cancels the picker, if
 * no MAC address is found, or if the cube does not report its state within
 * {@link FIRST_FACELETS_TIMEOUT_MS} (a wrong MAC address shows up this way).
 */
export async function connectGanCube(opts: { macProvider: MacProvider }): Promise<CubeConnection> {
  const connect = await loadGanDriver();
  return openGanConnection(opts, { connect, toHostMs: driverTimeToHost() });
}

/** What {@link openGanConnection} needs besides the MAC provider; the tests pass fakes. */
export interface GanConnectionDeps {
  /** The driver's `connectGanCube`. */
  connect: ConnectGanDriver;
  /** Converts the driver's timestamps to host milliseconds. */
  toHostMs: (driverMs: number) => number;
  /** Default {@link FIRST_FACELETS_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Default {@link FACELETS_RETRY_MS}. */
  retryMs?: number;
}

/** {@link connectGanCube} with its dependencies injected. */
export async function openGanConnection(
  opts: { macProvider: MacProvider },
  deps: GanConnectionDeps,
): Promise<CubeConnection> {
  let device: GanDriverDevice | undefined;
  const driver = await deps.connect(async (d, isFallbackCall) => {
    device = d;
    const name = typeof d.name === 'string' ? d.name : undefined;
    const text = await opts.macProvider({ name, id: d.id }, isFallbackCall === true);
    if (text === null || text.trim() === '') {
      return null;
    }
    const mac = normalizeMac(text);
    if (mac === null) {
      throw new Error(
        `"${text}" is not a MAC address: six hex bytes are expected, such as AB:12:CD:34:EF:56.`,
      );
    }
    return mac;
  });
  const connection = new GanCubeConnection(driver, device, deps.toHostMs);
  await connection.open(
    deps.timeoutMs ?? FIRST_FACELETS_TIMEOUT_MS,
    deps.retryMs ?? FACELETS_RETRY_MS,
  );
  return connection;
}

/**
 * The driver stamps its events with its own `now()`: `Math.floor(performance.now())` when it runs
 * in a window, `Date.now()` elsewhere (the fork's src/utils.js). Both become host milliseconds
 * (docs/DATA-MODEL.md §1); in a window the result is up to 1 ms early because of the floor.
 */
export function driverTimeToHost(): (driverMs: number) => number {
  if (typeof window === 'undefined') {
    return (driverMs) => driverMs;
  }
  const origin = performance.timeOrigin;
  return (driverMs) => origin + driverMs;
}

/**
 * The MAC address in the form the driver expects (`"AB:12:CD:34:EF:56"`), from twelve hex digits
 * in either case with any `:`, `-` or whitespace between them; `null` if `text` is not one.
 */
export function normalizeMac(text: string): string | null {
  const hex = text.replace(/[\s:-]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(hex)) {
    return null;
  }
  return Array.from({ length: 6 }, (_, i) => hex.slice(2 * i, 2 * i + 2).toUpperCase()).join(':');
}

/** Printable ASCII only: the driver reads names from fixed-length byte fields, maybe padded. */
function printable(text: string | undefined): string {
  return Array.from(text ?? '')
    .filter((c) => c >= ' ' && c <= '~')
    .join('')
    .trim();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Maps the driver's events to {@link CubeEvent}, or to `null` for an event that must be dropped
 * (with a console warning when it is malformed). Stateful: a move that the driver recovered
 * without a cube timestamp (Gen3/Gen4 cubes only) keeps the cube clock where the previous move
 * left it, so `cubeMs` never goes back.
 */
export class GanEventMapper {
  private lastCubeMs = 0;

  constructor(
    private readonly toHostMs: (driverMs: number) => number,
    /** The Bluetooth name, the model when the cube does not say it. */
    private readonly deviceName = '',
  ) {}

  map(e: GanDriverEvent): CubeEvent | null {
    switch (e.type) {
      case 'MOVE':
        return this.move(e);
      case 'FACELETS':
        try {
          assertFacelets(e.facelets);
        } catch (err) {
          console.warn(
            `GAN cube: dropped a facelets report that is not a cube state. ${messageOf(err)}`,
          );
          return null;
        }
        return { type: 'facelets', facelets: e.facelets, hostMs: this.toHostMs(e.timestamp) };
      case 'GYRO': {
        const { x, y, z, w } = e.quaternion;
        return { type: 'gyro', q: [x, y, z, w], hostMs: this.toHostMs(e.timestamp) };
      }
      case 'BATTERY':
        return { type: 'battery', level: e.batteryLevel };
      case 'HARDWARE':
        return {
          type: 'hardware',
          model: printable(e.hardwareName) || this.deviceName,
          hardware: printable(e.hardwareVersion),
          firmware: printable(e.softwareVersion),
          gyro: e.gyroSupported === true,
        };
      case 'DISCONNECT':
        return { type: 'disconnected', reason: 'The cube closed the connection.' };
      default:
        // An event type that this wrapper does not know (a newer driver): ignore it.
        return null;
    }
  }

  private move(e: Extract<GanDriverEvent, { type: 'MOVE' }>): CubeMoveEvent | null {
    let m: Move;
    try {
      m = parseMove(e.move);
    } catch (err) {
      console.warn(`GAN cube: dropped a move that is not a face turn. ${messageOf(err)}`);
      return null;
    }
    const cubeMs = e.cubeTimestamp ?? this.lastCubeMs;
    this.lastCubeMs = cubeMs;
    return {
      type: 'move',
      m,
      cubeMs,
      // All the moves of one Bluetooth message share its arrival time; only the newest one
      // carries it as localTimestamp (docs/TOOLCHAIN.md, "GAN driver").
      hostMs: this.toHostMs(e.localTimestamp ?? e.timestamp),
      serial: e.serial,
      packetLast: e.localTimestamp !== null,
    };
  }
}

function hasUnsubscribe(value: unknown): value is { unsubscribe(): void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'unsubscribe' in value &&
    typeof value.unsubscribe === 'function'
  );
}

/** A connected GAN cube. Created by {@link openGanConnection}, usable once `open` resolves. */
class GanCubeConnection implements CubeConnection {
  readonly kind = 'gan';
  private readonly hub = new CubeEventHub();
  readonly events$ = this.hub.events$;
  private readonly mapper: GanEventMapper;
  /** Null until the first facelets report. */
  private state: Facelets | null = null;
  private readonly abort = new AbortController();
  private subscription: { unsubscribe(): void } | undefined;
  /** Commands go out one at a time: Chrome rejects a GATT write while another is in progress. */
  private commands: Promise<void> = Promise.resolve();
  /** Set while `open` waits for the first facelets report. */
  private opening: { resolve(): void; reject(err: Error): void } | undefined;

  constructor(
    private readonly driver: GanDriverConnection,
    private readonly device: GanDriverDevice | undefined,
    toHostMs: (driverMs: number) => number,
  ) {
    this.mapper = new GanEventMapper(toHostMs, printable(driver.deviceName));
  }

  get facelets(): Facelets {
    if (this.state === null) {
      throw new Error('The cube has not reported its state yet.');
    }
    return this.state;
  }

  requestFacelets(): Promise<void> {
    return this.send({ type: 'REQUEST_FACELETS' });
  }

  requestBattery(): Promise<void> {
    return this.send({ type: 'REQUEST_BATTERY' });
  }

  disconnect(): Promise<void> {
    this.close('Disconnected on request.');
    return Promise.resolve();
  }

  /**
   * Subscribes to the driver (once: see GanDriverConnection.events$), asks for the facelets (the
   * driver ignores moves until the first report), the hardware and the battery, and waits for
   * the first valid facelets report. On failure, closes the connection and rejects.
   */
  open(timeoutMs: number, retryMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const settle = (): void => {
        this.opening = undefined;
        timers.forEach(clearTimeout);
      };
      const fail = (err: Error): void => {
        if (this.opening === undefined) {
          return;
        }
        settle();
        this.close(err.message);
        reject(err);
      };
      this.opening = {
        resolve: () => {
          settle();
          resolve();
        },
        reject: fail,
      };
      const failWith = (what: string) => (err: unknown) => {
        fail(new Error(`${what}: ${messageOf(err)}`));
      };
      timers.push(
        setTimeout(() => {
          this.requestFacelets().catch(failWith('Could not ask the cube for its state'));
        }, retryMs),
        setTimeout(() => {
          fail(
            new Error(
              `The cube did not report its state within ${String(timeoutMs / 1000)} s of ` +
                'connecting. If its MAC address was typed, check it: with a wrong address, ' +
                'nothing the cube sends can be decrypted.',
            ),
          );
        }, timeoutMs),
      );
      try {
        this.subscribeToDriver();
      } catch (err) {
        failWith('Could not listen to the cube')(err);
        return;
      }
      if (this.hub.closed) {
        return; // The driver's stream ended during the subscription; open has already failed.
      }
      this.requestFacelets().catch(failWith('Could not ask the cube for its state'));
      const warn = (err: unknown): void => {
        console.warn(`GAN cube: a request failed. ${messageOf(err)}`);
      };
      this.send({ type: 'REQUEST_HARDWARE' }).catch(warn);
      this.requestBattery().catch(warn);
    });
  }

  private subscribeToDriver(): void {
    const events$ = this.driver.events$;
    if (events$ === undefined) {
      throw new Error('the driver returned a connection without events$');
    }
    const subscription = events$.subscribe(
      {
        next: (e) => {
          this.onDriverEvent(e);
        },
        error: (err: unknown) => {
          this.close(`The cube driver failed: ${messageOf(err)}`);
        },
        // The fork completes its stream when the GATT server disconnects (it emits no DISCONNECT).
        complete: () => {
          this.close('The Bluetooth connection was closed.');
        },
      },
      { signal: this.abort.signal },
    );
    if (hasUnsubscribe(subscription)) {
      this.subscription = subscription;
      if (this.hub.closed) {
        subscription.unsubscribe();
      }
    }
  }

  private onDriverEvent(e: GanDriverEvent): void {
    const event = this.mapper.map(e);
    if (event === null) {
      return;
    }
    switch (event.type) {
      case 'move':
        if (this.state === null) {
          return; // Before the first facelets report; the driver drops these too.
        }
        this.state = applyMove(this.state, event.m);
        break;
      case 'facelets':
        this.state = event.facelets;
        break;
      case 'disconnected':
        this.close(event.reason ?? 'The cube closed the connection.');
        return;
      default:
        break;
    }
    this.hub.emit(event);
    if (event.type === 'facelets') {
      this.opening?.resolve();
    }
  }

  private send(command: GanDriverCommand): Promise<void> {
    const sent = this.commands.then(() => {
      if (this.hub.closed) {
        throw new Error('The cube is disconnected.');
      }
      return this.driver.sendCubeCommand(command);
    });
    this.commands = sent.catch(() => undefined);
    return sent;
  }

  /** Stops listening, closes the Bluetooth link and emits `disconnected`; idempotent. */
  private close(reason: string): void {
    if (this.hub.closed) {
      return;
    }
    this.abort.abort();
    this.subscription?.unsubscribe();
    this.hub.emit({ type: 'disconnected', reason });
    this.opening?.reject(new Error(`The cube disconnected before reporting its state. ${reason}`));
    try {
      if (this.driver.disconnect !== undefined) {
        this.driver.disconnect().catch(() => undefined);
      } else if (this.device?.gatt?.connected === true) {
        this.device.gatt.disconnect();
      }
    } catch (err) {
      console.warn(`GAN cube: could not close the Bluetooth link. ${messageOf(err)}`);
    }
  }
}
