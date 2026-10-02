// The clip viewer's 3D cube (docs/PLAN.md T3.8), driven through cubing.js's `<twisty-player>`: its
// turns from the clip's moves, added one by one so that they animate or rebuilt at once after a seek,
// its orientation set on the puzzle's three.js object, and, since T3.10, the player's camera orbit
// (where the cube is seen from), requested through the player's model and read back from it after
// the user drags the cube. Plain TypeScript around the few members of the player's API the viewer
// uses, so that the tests drive it with a fake player and the viewer does without the element where
// the browser gave none (the unit tests' jsdom).
import {
  type CubeStep,
  IDENTITY,
  type Quat,
  cubeStep,
  normalizeLongitude,
  sameOrientation,
} from '@cubetrace/core';

/** The puzzle's three.js `Object3D`, as far as the viewer touches it: its rotation. */
export interface PuzzleObject {
  readonly quaternion: { set(x: number, y: number, z: number, w: number): unknown };
}

/** A view of the puzzle that renders when asked: cubing.js's `Twisty3DVantage`. */
export interface Renderable {
  scheduleRender(): void;
}

/**
 * Where the player's camera looks at the cube from (T3.10): cubing.js's orbit coordinates, in
 * degrees. `latitude` 0 is level with the cube, 90 straight above it; `longitude` 0 is in front of
 * it, 90 to its right, 180 (or −180, as cubing.js reports it) behind it.
 */
export interface Orbit {
  readonly latitude: number;
  readonly longitude: number;
}

/** cubing.js's `OrbitCoordinates`: the orbit and the camera's distance. */
export interface OrbitCoordinates extends Orbit {
  readonly distance: number;
}

/**
 * The player's camera orbit as its model keeps it (`experimentalModel.twistySceneModel`, cubing.js's
 * `TwistySceneModel`): `orbitCoordinatesRequest`, which a request is set on (the angles not named
 * keep their values; the model clamps the latitude to its limit and brings the longitude into
 * [−180, 180)), and `orbitCoordinates`, the orbit as it is, which reports each change to its fresh
 * listeners, once at first with the orbit then: the player's own requests and the user's drags
 * alike.
 */
export interface CubePlayerModel {
  readonly twistySceneModel: {
    readonly orbitCoordinatesRequest: { set(request: Partial<OrbitCoordinates>): void };
    readonly orbitCoordinates: {
      get(): Promise<OrbitCoordinates>;
      addFreshListener(listener: (coordinates: OrbitCoordinates) => void): void;
      removeFreshListener(listener: (coordinates: OrbitCoordinates) => void): void;
    };
  };
}

/**
 * The members of cubing.js's `TwistyPlayer` the viewer uses (`node_modules/cubing/dist/lib/cubing/
 * index-*.d.ts`; the properties are setters there, whose getters throw): the alg and its setup, the
 * timestamp into the alg, a move appended with its catch-up animation, the puzzle's 3D object, the
 * vantages that draw it, and the model's orbit (T3.10).
 */
export interface CubePlayer {
  alg: string;
  experimentalSetupAlg: string;
  timestamp: number | 'start' | 'end';
  readonly experimentalModel: CubePlayerModel;
  experimentalAddMove(move: string): void;
  experimentalCurrentThreeJSPuzzleObject(): Promise<PuzzleObject>;
  experimentalCurrentVantages(): Promise<Iterable<Renderable>>;
}

/**
 * `element` as a {@link CubePlayer}, once `cubing/twisty` has defined `<twisty-player>` and upgraded
 * it; null for an element without the API (the element before the chunk loaded, or a browser's
 * unknown element).
 */
export function cubePlayerOf(element: object): CubePlayer | null {
  const candidate = element as Partial<CubePlayer>;
  const model: unknown = candidate.experimentalModel;
  return typeof candidate.experimentalAddMove === 'function' &&
    typeof candidate.experimentalCurrentThreeJSPuzzleObject === 'function' &&
    typeof candidate.experimentalCurrentVantages === 'function' &&
    typeof model === 'object' &&
    model !== null &&
    typeof Reflect.get(model, 'twistySceneModel') === 'object'
    ? (element as CubePlayer)
    : null;
}

/**
 * Two orbits are the same within `tolerance` degrees of latitude and of longitude (−180 and 180
 * being one longitude).
 */
export function sameOrbit(a: Orbit, b: Orbit, tolerance: number): boolean {
  const longitudes = Math.abs(normalizeLongitude(a.longitude) - normalizeLongitude(b.longitude));
  return (
    Math.abs(a.latitude - b.latitude) <= tolerance &&
    Math.min(longitudes, 360 - longitudes) <= tolerance
  );
}

/**
 * A request is not made when the camera is within this of it, in degrees: the viewer keeps the
 * orbit to tenths of a degree, so the orbit it saves after a drag, asked for again, moves nothing.
 */
export const ORBIT_TOLERANCE = 0.06;

/** The model's echo of a request is recognized within this: floating noise alone. */
const ECHO_TOLERANCE = 1e-6;

/**
 * The 3D cube of one clip: the state after each move of the clip's segment, from the segment's
 * starting state, and the orientation the gyro file gives (core's `orientation.ts`). `show` moves the
 * cube to the state after a move, animating the next move as the video passes it and rebuilding
 * the state otherwise ({@link cubeStep}); `orient` rotates it, rendering only when the orientation
 * changed. The puzzle's object and the vantages come from the player's promises once, and whatever
 * is asked before they resolve is applied then.
 */
export class ClipCube {
  /** The moves of the segment, as written. */
  #moves: readonly string[] = [];
  /** The move the cube shows the state after; −1 before the first. */
  #shown = -1;
  #object: PuzzleObject | null = null;
  #vantages: readonly Renderable[] = [];
  /** The orientation shown, or to show once the object is there; null while nothing was asked. */
  #orientation: Quat | null = null;
  #disposed = false;
  /** The orbit as the model last reported it; null before its first report. */
  #orbit: Orbit | null = null;
  /** The orbit last requested ({@link view}); null before the first request. */
  #requested: Orbit | null = null;
  /** The model has reported the orbit requested: what it reports since is the user's. */
  #echoed = false;
  #dragListener: ((orbit: Orbit) => void) | null = null;
  readonly #onOrbit = (coordinates: OrbitCoordinates): void => {
    this.#report(coordinates);
  };

  constructor(private readonly player: CubePlayer) {
    void this.#attach();
    player.experimentalModel.twistySceneModel.orbitCoordinates.addFreshListener(this.#onOrbit);
  }

  /** The move the cube shows the state after; −1 at the segment's start. */
  get shown(): number {
    return this.#shown;
  }

  /** Where the player's camera looks from, as the model last reported it; null before it did. */
  get orbit(): Orbit | null {
    return this.#orbit;
  }

  /**
   * Where the player's camera looks from, or is on its way to: the orbit requested and not reported
   * back yet, else the one reported (a drag's included); null before either. What a step of the view
   * builds on, so that two steps before the model's report add up.
   */
  get target(): Orbit | null {
    return this.#requested !== null && !this.#echoed ? this.#requested : this.#orbit;
  }

  /**
   * Points the player's camera: a view from `latitude` degrees above the cube's equator and
   * `longitude` degrees around it, requested of the model in one go (so that the model reports the
   * new orbit once), unless the camera is there already ({@link ORBIT_TOLERANCE}) or the same request
   * is on its way. The model's report of the orbit requested is not a drag ({@link onDrag}); until
   * it comes, nothing the model reports is.
   */
  view(orbit: Orbit): void {
    if (this.#orbit !== null && sameOrbit(this.#orbit, orbit, ORBIT_TOLERANCE)) {
      this.#requested = orbit;
      this.#echoed = true;
      return;
    }
    if (
      this.#requested !== null &&
      !this.#echoed &&
      sameOrbit(this.#requested, orbit, ECHO_TOLERANCE)
    ) {
      return;
    }
    this.#requested = orbit;
    this.#echoed = false;
    this.player.experimentalModel.twistySceneModel.orbitCoordinatesRequest.set({
      latitude: orbit.latitude,
      longitude: orbit.longitude,
    });
  }

  /**
   * Calls `listener` with the orbit each time the user moved the camera (a drag of the cube with the
   * mouse or a finger, its inertia included), as the model reports it: not with the echoes of
   * {@link view}'s requests, nor with the model's own orbit before the first request. One listener.
   */
  onDrag(listener: (orbit: Orbit) => void): void {
    this.#dragListener = listener;
  }

  /**
   * The segment: `setup`, the alg of its starting state (the scramble for the solve, nothing for the
   * scramble), and `moves`, its moves as written. The cube shows the starting state.
   */
  load(setup: string, moves: readonly string[]): void {
    this.#moves = moves;
    this.#shown = -1;
    this.player.experimentalSetupAlg = setup;
    this.player.alg = '';
    this.player.timestamp = 'end';
  }

  /**
   * Shows the state after move `at` (−1 for the starting state): the next move alone animated when
   * the time passed exactly it on its own, else the moves up to it set at once, without animation
   * (`seek`: the video was seeked). Says what it did.
   */
  show(at: number, seek: boolean): CubeStep {
    const target = Math.min(Math.max(-1, at), this.#moves.length - 1);
    const step = cubeStep(this.#shown, target, seek);
    switch (step) {
      case 'animate':
        this.player.experimentalAddMove(this.#moves[target]);
        break;
      case 'rebuild':
        this.player.alg = this.#moves.slice(0, target + 1).join(' ');
        this.player.timestamp = 'end';
        break;
      case 'keep':
        break;
    }
    this.#shown = target;
    return step;
  }

  /**
   * Rotates the cube to `orientation` (in cubing.js's frame; null, nothing known: upright) and asks
   * the vantages to render, when it differs from the orientation shown. Says whether it rendered.
   */
  orient(orientation: Quat | null): boolean {
    const q = orientation ?? IDENTITY;
    if (this.#orientation !== null && sameOrientation(q, this.#orientation)) {
      return false;
    }
    this.#orientation = q;
    return this.#apply();
  }

  /** Forgets the player: nothing is touched after this, not even by a promise still pending. */
  dispose(): void {
    this.#disposed = true;
    this.#object = null;
    this.#vantages = [];
    this.#dragListener = null;
    this.player.experimentalModel.twistySceneModel.orbitCoordinates.removeFreshListener(
      this.#onOrbit,
    );
  }

  /** The model reported its orbit: the echo of a request, the user's drag, or its own at first. */
  #report(coordinates: OrbitCoordinates): void {
    if (this.#disposed) {
      return;
    }
    const orbit: Orbit = { latitude: coordinates.latitude, longitude: coordinates.longitude };
    this.#orbit = orbit;
    if (this.#requested === null) {
      return;
    }
    if (!this.#echoed) {
      if (sameOrbit(orbit, this.#requested, ECHO_TOLERANCE)) {
        this.#echoed = true;
      }
      return;
    }
    this.#dragListener?.(orbit);
  }

  /** Sets the orientation on the puzzle's object, once it is there, and schedules the render. */
  #apply(): boolean {
    const q = this.#orientation;
    if (this.#object === null || q === null || this.#disposed) {
      return false;
    }
    this.#object.quaternion.set(q[0], q[1], q[2], q[3]);
    for (const vantage of this.#vantages) {
      vantage.scheduleRender();
    }
    return true;
  }

  async #attach(): Promise<void> {
    try {
      const object = await this.player.experimentalCurrentThreeJSPuzzleObject();
      const vantages = Array.from(await this.player.experimentalCurrentVantages());
      if (this.#disposed) {
        return;
      }
      this.#object = object;
      this.#vantages = vantages;
      this.#apply();
    } catch {
      // The player gave no 3D object (its 3D code could not load): the turns still go to the
      // player, and there is nothing to rotate. The picture is a help; the moves list is the record.
    }
  }
}
