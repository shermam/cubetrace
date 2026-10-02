// The fake cube: the cube of development, demos and CI (docs/PLAN.md, T1.5). It replays timed
// moves (the fixtures) on their own schedule, takes scripted turns, and simulates its state with
// @cubetrace/core. Same contract as a GAN cube (CubeConnection), no Bluetooth.
import { SOLVED, applyMove, assertFacelets, type Facelets, type Move } from '@cubetrace/core';

import { CubeEventHub } from './hub';
import type { CubeConnection, CubeHardwareEvent } from './types';

export interface FakeCubeOptions {
  /** The state the cube starts in; solved by default. */
  start?: Facelets;
  /** `play()` divides the gaps between moves by this; 1 (real time) by default. */
  speed?: number;
  /** The host clock, in ms; `performance.timeOrigin + performance.now()` by default. */
  now?: () => number;
  /**
   * The cube reports a gyroscope (`hardware.gyro` true) and emits `gyro` events at
   * {@link FAKE_GYRO_HZ} while connected: a steady rotation of {@link FAKE_GYRO_DEG_PER_S} about
   * its white axis while a `play()` turns it, with the velocity {@link FAKE_GYRO_VELOCITY}; still,
   * with a velocity of zero, otherwise. Off by default (T3.7: the whole record of the cube, which
   * the end-to-end suite and the demo exercise with it on).
   */
  gyro?: boolean;
}

/** A move and when it happens, in ms on any clock (the fixtures use the cube's). */
export interface ScheduledMove {
  m: Move;
  ms: number;
}

/** What the fake cube reports as its hardware. */
export const FAKE_CUBE_HARDWARE: Readonly<CubeHardwareEvent> = {
  type: 'hardware',
  model: 'Fake cube',
  hardware: 'simulated',
  firmware: 'simulated',
  gyro: false,
};

/** The fake cube's battery level, in percent. */
export const FAKE_CUBE_BATTERY = 100;

/** How often the fake cube's gyroscope reports, when it has one (`FakeCubeOptions.gyro`). */
export const FAKE_GYRO_HZ = 50;

/** How fast the fake cube turns about its white axis while a replay turns it, degrees per second. */
export const FAKE_GYRO_DEG_PER_S = 30;

/** The angular velocity the fake cube reports while it turns (raw integers, as a Gen2 cube's). */
export const FAKE_GYRO_VELOCITY: readonly [number, number, number] = [0, 0, 2];

function disconnectedError(): Error {
  return new Error('The fake cube is disconnected.');
}

/**
 * A simulated cube. Its clock (`cubeMs`) starts at 0 when it is created and runs `speed` times
 * as fast as the host clock, so a fixture played at any speed keeps its own cube timings: the
 * first move of each `play()` is stamped with that clock and every later move adds its own gap
 * from the schedule. `cubeMs` never goes back. Every move is its own Bluetooth packet
 * (`packetLast: true`) and carries a move counter like a GAN cube's (`serial`: 1 for the first
 * move, wrapping after 255 to 0). On creation it reports its hardware and a full battery, which
 * `events$` replays to every new subscriber. With `gyro` on, it has a gyroscope (see
 * `FakeCubeOptions.gyro`): a timer at {@link FAKE_GYRO_HZ} emits its orientation, which turns
 * while a replay turns the cube and holds otherwise, until it is disconnected.
 */
export class FakeCube implements CubeConnection {
  readonly kind = 'fake';
  private readonly hub = new CubeEventHub();
  readonly events$ = this.hub.events$;
  private readonly speed: number;
  private readonly now: () => number;
  private readonly createdMs: number;
  private state: Facelets;
  private lastCubeMs = 0;
  private serial = 0;
  /** The end of the last `play()` queued; plays run one after the other. */
  private plays: Promise<void> = Promise.resolve();
  /** Cancels the play in progress, if any. */
  private stopPlay: (() => void) | undefined;
  /** How many times `stop()` was called: a play queued before a stop does not start. */
  private stops = 0;
  /** The gyroscope's timer, while the cube has one and is connected. */
  private gyroTimer: ReturnType<typeof setInterval> | undefined;
  /** The gyroscope's orientation: the angle turned about the white axis so far, in radians. */
  private gyroAngle = 0;
  /** The host time of the gyroscope's last report. */
  private gyroAtMs = 0;
  /** Plays under way: the cube turns, as far as its gyroscope says, while there is one. */
  private playing = 0;

  constructor(opts: FakeCubeOptions = {}) {
    const start = opts.start ?? SOLVED;
    assertFacelets(start);
    const speed = opts.speed ?? 1;
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(
        `The fake cube's speed must be a positive number, got ${String(speed)}.`,
      );
    }
    this.state = start;
    this.speed = speed;
    this.now = opts.now ?? (() => performance.timeOrigin + performance.now());
    this.createdMs = this.now();
    this.hub.emit({ ...FAKE_CUBE_HARDWARE, gyro: opts.gyro === true });
    this.hub.emit({ type: 'battery', level: FAKE_CUBE_BATTERY, hostMs: this.createdMs });
    if (opts.gyro === true) {
      this.gyroAtMs = this.createdMs;
      this.gyroTimer = setInterval(() => {
        this.tickGyro();
      }, 1000 / FAKE_GYRO_HZ);
    }
  }

  /** The simulated state, updated before each move event is emitted. */
  get facelets(): Facelets {
    return this.state;
  }

  /**
   * Emits `moves` on their schedule: the first one at once (on a zero-delay timer), each later
   * one `(ms − first ms) / speed` host milliseconds after the play started. Plays queue: a
   * second `play()` starts when the first has finished. Resolves when the last move has been
   * emitted, or early if the cube is stopped or disconnected meanwhile. Rejects if the schedule
   * goes back in time or the cube is already disconnected.
   */
  play(moves: readonly ScheduledMove[]): Promise<void> {
    if (this.hub.closed) {
      return Promise.reject(disconnectedError());
    }
    for (const [i, move] of moves.entries()) {
      if (!Number.isFinite(move.ms)) {
        return Promise.reject(
          new RangeError(`play(): move ${String(i)} has no finite time (${String(move.ms)}).`),
        );
      }
      if (i > 0 && move.ms < moves[i - 1].ms) {
        return Promise.reject(
          new RangeError(
            `play(): move ${String(i)} at ${String(move.ms)} ms comes before move ` +
              `${String(i - 1)} at ${String(moves[i - 1].ms)} ms; a schedule never goes back.`,
          ),
        );
      }
    }
    const stops = this.stops;
    const played = this.plays.then(() =>
      stops === this.stops ? this.schedule(moves) : Promise.resolve(),
    );
    this.plays = played;
    return played;
  }

  /**
   * Stops the play in progress and drops the queued ones: their promises resolve at once and no
   * more of their moves come. The cube stays connected, in the state its last move left it; a
   * later `play()` runs as usual.
   */
  stop(): void {
    this.stops++;
    this.stopPlay?.();
  }

  /** One move, now (synchronously): for scripted scenarios. Throws once disconnected. */
  turn(m: Move): void {
    if (this.hub.closed) {
      throw disconnectedError();
    }
    this.emitMove(m, this.clock());
  }

  /** Emits a `facelets` event with the simulated state. */
  requestFacelets(): Promise<void> {
    if (this.hub.closed) {
      return Promise.reject(disconnectedError());
    }
    this.hub.emit({ type: 'facelets', facelets: this.state, hostMs: this.now() });
    return Promise.resolve();
  }

  /**
   * Sets the simulated state to solved and emits a `facelets` event that says so, with
   * `reset: true`, as a GAN cube's `resetToSolved()` does (without the confirming report: the
   * fake cube's state is the one it reports). A play in progress goes on from the solved state,
   * as a solver's hands would; `stop()` stops it. Rejects once disconnected.
   */
  resetToSolved(): Promise<void> {
    if (this.hub.closed) {
      return Promise.reject(disconnectedError());
    }
    this.state = SOLVED;
    this.hub.emit({ type: 'facelets', facelets: SOLVED, hostMs: this.now(), reset: true });
    return Promise.resolve();
  }

  /** Emits a `battery` event. */
  requestBattery(): Promise<void> {
    if (this.hub.closed) {
      return Promise.reject(disconnectedError());
    }
    this.hub.emit({ type: 'battery', level: FAKE_CUBE_BATTERY, hostMs: this.now() });
    return Promise.resolve();
  }

  /**
   * Stops any play and the gyroscope, emits `disconnected` with `reason` and completes `events$`.
   * The reason can simulate a cube that goes away (turned off, out of range). Idempotent.
   */
  disconnect(reason = 'Disconnected on request.'): Promise<void> {
    this.stopPlay?.();
    if (this.gyroTimer !== undefined) {
      clearInterval(this.gyroTimer);
      this.gyroTimer = undefined;
    }
    this.hub.emit({ type: 'disconnected', reason });
    return Promise.resolve();
  }

  private schedule(moves: readonly ScheduledMove[]): Promise<void> {
    if (moves.length === 0 || this.hub.closed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const first = moves[0].ms;
      let base: number | undefined;
      this.playing++;
      let finished = false;
      const finish = (): void => {
        if (!finished) {
          finished = true;
          this.playing--;
        }
        this.stopPlay = undefined;
        resolve();
      };
      // One timer per move, all set now: timers with equal delays run in the order they were
      // set, and late timers do not push the later moves back.
      const timers = moves.map((move, i) =>
        setTimeout(
          () => {
            base ??= this.clock();
            this.emitMove(move.m, base + (move.ms - first));
            if (i === moves.length - 1) {
              finish();
            }
          },
          (move.ms - first) / this.speed,
        ),
      );
      this.stopPlay = () => {
        timers.forEach(clearTimeout);
        finish();
      };
    });
  }

  /** The fake cube's clock now. */
  private clock(): number {
    return Math.round((this.now() - this.createdMs) * this.speed);
  }

  /**
   * One report of the gyroscope: the orientation turned on by the host time since the last report
   * while a play turns the cube, as a unit quaternion about the white (+Z) axis, with the velocity
   * of a turning cube or a still one.
   */
  private tickGyro(): void {
    if (this.hub.closed) {
      return;
    }
    const nowMs = this.now();
    const turning = this.playing > 0;
    if (turning) {
      this.gyroAngle += ((nowMs - this.gyroAtMs) / 1000) * ((FAKE_GYRO_DEG_PER_S * Math.PI) / 180);
    }
    this.gyroAtMs = nowMs;
    const half = this.gyroAngle / 2;
    this.hub.emit({
      type: 'gyro',
      q: [0, 0, Math.sin(half), Math.cos(half)],
      v: turning ? FAKE_GYRO_VELOCITY : [0, 0, 0],
      hostMs: nowMs,
    });
  }

  private emitMove(m: Move, cubeMs: number): void {
    this.lastCubeMs = Math.max(this.lastCubeMs, cubeMs);
    this.state = applyMove(this.state, m);
    this.serial = (this.serial + 1) & 0xff;
    this.hub.emit({
      type: 'move',
      m,
      cubeMs: this.lastCubeMs,
      hostMs: this.now(),
      serial: this.serial,
      packetLast: true,
    });
  }
}
