// The contract between the cube sources (a GAN cube over Web Bluetooth, the fake cube) and the
// app: one typed event stream (docs/PLAN.md, T1.5). Every time is host milliseconds
// (`performance.timeOrigin + performance.now()`); the cube's own clock is kept alongside as
// `cubeMs`, never substituted (docs/DATA-MODEL.md §1).
import type { Facelets, Move } from '@cubetrace/core';
import type { Observable } from 'rxjs';

/** A face turn reported by the cube. */
export interface CubeMoveEvent {
  type: 'move';
  m: Move;
  /** The cube's own clock, in ms, as the driver delivers it. */
  cubeMs: number;
  /** Host clock, in ms, when the Bluetooth packet that carried the move arrived. */
  hostMs: number;
  /** The cube's move counter (0–255, wrapping), when the source has one. */
  serial?: number;
  /**
   * True for the newest move of its Bluetooth packet, the one whose arrival `hostMs` measures.
   * The older moves of a packet share its `hostMs` although they happened earlier, so only
   * `packetLast` moves are good samples for the cube clock fit (`CubeClockFit` in T1.4).
   */
  packetLast: boolean;
}

/** The whole cube state as the cube reports it (a desync check is a string comparison). */
export interface CubeFaceletsEvent {
  type: 'facelets';
  facelets: Facelets;
  hostMs: number;
}

/** Orientation from the gyroscope, for cubes that have one. */
export interface CubeGyroEvent {
  type: 'gyro';
  /** Unit quaternion `[x, y, z, w]` (scalar last), in the cube's frame as the driver reports it. */
  q: [number, number, number, number];
  hostMs: number;
}

/** Battery level, in percent (0–100). */
export interface CubeBatteryEvent {
  type: 'battery';
  level: number;
}

/** What the cube says it is; the fields of `cube` in `session.json` (docs/DATA-MODEL.md §6). */
export interface CubeHardwareEvent {
  type: 'hardware';
  model: string;
  hardware: string;
  firmware: string;
  gyro: boolean;
}

/** The connection is over; `events$` completes right after this event. */
export interface CubeDisconnectedEvent {
  type: 'disconnected';
  reason?: string;
}

export type CubeEvent =
  | CubeMoveEvent
  | CubeFaceletsEvent
  | CubeGyroEvent
  | CubeBatteryEvent
  | CubeHardwareEvent
  | CubeDisconnectedEvent;

/** A connected cube, real (`connectGanCube`) or simulated (`FakeCube`). */
export interface CubeConnection {
  /**
   * Hot stream of the cube's events. A new subscriber first receives the latest `hardware`,
   * `battery` and `disconnected` events, if any (they describe the cube rather than a moment),
   * then live events; moves, facelets and gyro readings are never replayed. The stream
   * completes after `disconnected`.
   */
  readonly events$: Observable<CubeEvent>;
  /**
   * The cube state as this connection knows it: for a GAN cube, the first facelets the cube
   * reported (the connect promise resolves with them), then every move applied and every later
   * facelets report adopted; for the fake cube, its simulated state.
   */
  readonly facelets: Facelets;
  /** Asks the cube for its state; the answer arrives as a `facelets` event. */
  requestFacelets(): Promise<void>;
  /** Asks the cube for its battery level; the answer arrives as a `battery` event. */
  requestBattery(): Promise<void>;
  /** Closes the connection: emits `disconnected` and completes `events$`. Idempotent. */
  disconnect(): Promise<void>;
  readonly kind: 'gan' | 'fake';
}

/**
 * Supplies the cube's MAC address, which the GAN protocol needs to derive its encryption key.
 * The driver calls it first with `isFallback: false` (return `null` to let the driver try to
 * read the MAC from the cube's advertisements) and, if that fails, once more with
 * `isFallback: true` (the last chance; typically ask the user). Accepted: twelve hex digits with
 * any `:`, `-` or whitespace between them, such as `AB:12:CD:34:EF:56` or `ab12cd34ef56`.
 */
export type MacProvider = (
  device: { name?: string; id: string },
  isFallback: boolean,
) => Promise<string | null>;

/** What this browser can do for a GAN cube (`checkBluetoothSupport`). */
export interface BluetoothSupport {
  /** Web Bluetooth and everything the driver needs are present. */
  available: boolean;
  /** The MAC address can be read from the cube's advertisements, so the user never types it. */
  canReadMacAutomatically: boolean;
  /** One or two sentences for the connect dialog. */
  hint: string;
  /** The `chrome://flags` entry that enables reading the MAC automatically, when it is off. */
  flagUrl?: string;
}
