// The clip viewer's 3D cube (docs/PLAN.md T3.8), driven through cubing.js's `<twisty-player>`: its
// turns from the clip's moves, added one by one so that they animate or rebuilt at once after a seek,
// and its orientation set on the puzzle's three.js object. Plain TypeScript around the few members of
// the player's API the viewer uses, so that the tests drive it with a fake player and the viewer
// does without the element where the browser gave none (the unit tests' jsdom).
import { type CubeStep, IDENTITY, type Quat, cubeStep, sameOrientation } from '@cubetrace/core';

/** The puzzle's three.js `Object3D`, as far as the viewer touches it: its rotation. */
export interface PuzzleObject {
  readonly quaternion: { set(x: number, y: number, z: number, w: number): unknown };
}

/** A view of the puzzle that renders when asked: cubing.js's `Twisty3DVantage`. */
export interface Renderable {
  scheduleRender(): void;
}

/**
 * The members of cubing.js's `TwistyPlayer` the viewer uses (`node_modules/cubing/dist/lib/cubing/
 * index-*.d.ts`; the properties are setters there, whose getters throw): the alg and its setup, the
 * timestamp into the alg, a move appended with its catch-up animation, the puzzle's 3D object and
 * the vantages that draw it.
 */
export interface CubePlayer {
  alg: string;
  experimentalSetupAlg: string;
  timestamp: number | 'start' | 'end';
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
  return typeof candidate.experimentalAddMove === 'function' &&
    typeof candidate.experimentalCurrentThreeJSPuzzleObject === 'function' &&
    typeof candidate.experimentalCurrentVantages === 'function'
    ? (element as CubePlayer)
    : null;
}

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

  constructor(private readonly player: CubePlayer) {
    void this.#attach();
  }

  /** The move the cube shows the state after; −1 at the segment's start. */
  get shown(): number {
    return this.#shown;
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
