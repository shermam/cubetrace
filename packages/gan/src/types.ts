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
  /**
   * True on the event of `resetToSolved()`: the state is solved because the cube was told so, not
   * because it reported it. A listener that only follows the state treats it as any report; the
   * timer drops its attempt under way instead of taking the state as the end of a solve.
   */
  reset?: true;
}

/**
 * Orientation from the gyroscope, for cubes that have one. The cube's frame, as the driver states
 * it: right-handed, +X through the red face, +Y through the blue face, +Z through the white face;
 * the yaw has an arbitrary reference and drifts (docs/DATA-MODEL.md §11).
 */
export interface CubeGyroEvent {
  type: 'gyro';
  /** Unit quaternion `[x, y, z, w]` (scalar last), in the cube's frame as the driver reports it. */
  q: [number, number, number, number];
  /**
   * The angular velocity per axis as the cube reports it, raw integers (the Gen2 cubes, such as
   * the GAN 12 ui and the GAN 356 i3, send 4-bit signed values, −7 to 7, per packet); absent when
   * the cube gives none.
   */
  v?: readonly [number, number, number];
  hostMs: number;
}

/** Battery level, in percent (0–100), and when the cube reported it, on the host clock. */
export interface CubeBatteryEvent {
  type: 'battery';
  level: number;
  hostMs: number;
}

/** What the cube says it is; the fields of `cube` in `session.json` (docs/DATA-MODEL.md §6). */
export interface CubeHardwareEvent {
  type: 'hardware';
  model: string;
  hardware: string;
  firmware: string;
  gyro: boolean;
  /** The production date, as the cube's hardware message has it (Gen4 cubes); absent when it does not say. */
  productDate?: string;
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
   * facelets report adopted, and the solved state after `resetToSolved()`; for the fake cube, its
   * simulated state.
   */
  readonly facelets: Facelets;
  /** Asks the cube for its state; the answer arrives as a `facelets` event. */
  requestFacelets(): Promise<void>;
  /**
   * Tells the cube that it is solved ("Mark as solved"), for when its own state and the physical
   * cube went apart (turns made while it was asleep or disconnected), with the cube solved in the
   * solver's hands. `facelets` becomes `SOLVED` and a `facelets` event with `reset: true` says so,
   * so that every listener resyncs. A GAN cube gets the driver's `REQUEST_RESET` first and is then
   * asked for its state: its answer, a normal `facelets` event, confirms the reset, or brings the
   * cube's own state if it disagrees. Rejects once disconnected.
   */
  resetToSolved(): Promise<void>;
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
