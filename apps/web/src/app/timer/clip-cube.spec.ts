import type { TwistyPlayer } from 'cubing/twisty';

import {
  ClipCube,
  type CubePlayer,
  ORBIT_TOLERANCE,
  type Orbit,
  type PuzzleObject,
  type Renderable,
  cubePlayerOf,
  sameOrbit,
} from './clip-cube';
import { FakeOrbitModel } from './clip-cube-testing';
import { IDENTITY, type Quat, fromAxisAngle } from '@cubetrace/core';

/** A player that records what it was told, with a puzzle object that arrives when the test says. */
class FakePlayer implements CubePlayer {
  alg = '';
  experimentalSetupAlg = '';
  timestamp: number | 'start' | 'end' = 0;
  readonly experimentalModel = new FakeOrbitModel();
  readonly log: string[] = [];
  readonly quaternions: Quat[] = [];
  renders = 0;
  private resolveObject: ((object: PuzzleObject) => void) | null = null;
  private readonly object = new Promise<PuzzleObject>((resolve) => {
    this.resolveObject = resolve;
  });

  experimentalAddMove(move: string): void {
    this.log.push(`add ${move}`);
  }

  experimentalCurrentThreeJSPuzzleObject(): Promise<PuzzleObject> {
    return this.object;
  }

  experimentalCurrentVantages(): Promise<Iterable<Renderable>> {
    return Promise.resolve([
      {
        scheduleRender: () => {
          this.renders++;
        },
      },
    ]);
  }

  /** The puzzle's object is there: its quaternion records what is set. */
  arrive(): void {
    this.resolveObject?.({
      quaternion: {
        set: (x: number, y: number, z: number, w: number) => {
          this.quaternions.push([x, y, z, w]);
        },
      },
    });
  }
}

/** Lets the player's promises settle. */
async function settled(): Promise<void> {
  for (let k = 0; k < 4; k++) {
    await Promise.resolve();
  }
}

describe('cubePlayerOf', () => {
  it('takes an element with the player’s API, and nothing else', () => {
    expect(cubePlayerOf(new FakePlayer())).not.toBeNull();
    // An element without the API (the viewer's spec defines a fake `twisty-player` in this jsdom,
    // so that name is not the example).
    expect(cubePlayerOf(document.createElement('div'))).toBeNull();
    expect(cubePlayerOf({ experimentalAddMove: () => undefined })).toBeNull();
    // The model's orbit too (T3.10).
    const player = new FakePlayer();
    expect(
      cubePlayerOf({
        experimentalAddMove: () => undefined,
        experimentalCurrentThreeJSPuzzleObject: () =>
          player.experimentalCurrentThreeJSPuzzleObject(),
        experimentalCurrentVantages: () => player.experimentalCurrentVantages(),
      }),
    ).toBeNull();
  });

  it('asks of cubing.js’s player members it has (a check for the compiler)', () => {
    const asCubePlayer = (player: TwistyPlayer): CubePlayer => player;
    expect(asCubePlayer).toBeTypeOf('function');
  });
});

describe('ClipCube', () => {
  it('loads a segment at its starting state: the setup alg, no moves, the end of the alg', () => {
    const player = new FakePlayer();
    const cube = new ClipCube(player);
    cube.load("F2 U2 R B2 D' L", ['R', "U'", 'F2']);
    expect(player.experimentalSetupAlg).toBe("F2 U2 R B2 D' L");
    expect(player.alg).toBe('');
    expect(player.timestamp).toBe('end');
    expect(cube.shown).toBe(-1);
    expect(player.log).toEqual([]);
  });

  it('animates the next move as the time passes it, keeps the state meanwhile, rebuilds on a seek or over several moves', () => {
    const player = new FakePlayer();
    const cube = new ClipCube(player);
    cube.load('', ['R', "U'", 'F2', 'L', 'D']);

    expect(cube.show(-1, true)).toBe('keep');
    expect(cube.show(0, false)).toBe('animate');
    expect(player.log).toEqual(['add R']);
    expect(cube.show(0, false)).toBe('keep');
    expect(cube.show(1, false)).toBe('animate');
    expect(player.log).toEqual(['add R', "add U'"]);
    expect(cube.shown).toBe(1);

    // Two moves passed in one frame: the state at once.
    player.timestamp = 0;
    expect(cube.show(3, false)).toBe('rebuild');
    expect(player.alg).toBe("R U' F2 L");
    expect(player.timestamp).toBe('end');
    expect(player.log).toEqual(['add R', "add U'"]);

    // A seek, even to the next move; and back.
    expect(cube.show(4, true)).toBe('rebuild');
    expect(player.alg).toBe("R U' F2 L D");
    expect(cube.show(1, false)).toBe('rebuild');
    expect(player.alg).toBe("R U'");
    expect(cube.show(-1, true)).toBe('rebuild');
    expect(player.alg).toBe('');
    expect(cube.shown).toBe(-1);

    // Beyond the segment's moves: its last state; before its start: its starting state.
    expect(cube.show(99, true)).toBe('rebuild');
    expect(player.alg).toBe("R U' F2 L D");
    expect(cube.shown).toBe(4);
    expect(cube.show(-5, false)).toBe('rebuild');
    expect(cube.shown).toBe(-1);
  });

  it('sets the orientation on the puzzle’s object once it is there, and renders only when it changed', async () => {
    const player = new FakePlayer();
    const cube = new ClipCube(player);
    const tilt = fromAxisAngle([1, 0, 0], 30);
    // Asked before the object arrived: applied then.
    expect(cube.orient(tilt)).toBe(false);
    player.arrive();
    await settled();
    expect(player.quaternions).toEqual([tilt]);
    expect(player.renders).toBe(1);

    // The same orientation again, also as −q: no render.
    expect(cube.orient(tilt)).toBe(false);
    expect(cube.orient([-tilt[0], -tilt[1], -tilt[2], -tilt[3]])).toBe(false);
    expect(player.renders).toBe(1);

    // A change: set and rendered; nothing known: upright.
    const turn = fromAxisAngle([0, 1, 0], 90);
    expect(cube.orient(turn)).toBe(true);
    expect(cube.orient(null)).toBe(true);
    expect(player.quaternions).toEqual([tilt, turn, IDENTITY]);
    expect(player.renders).toBe(3);
    expect(cube.orient(null)).toBe(false);
  });

  it('touches nothing once disposed, even when the object arrives later', async () => {
    const player = new FakePlayer();
    const cube = new ClipCube(player);
    cube.orient(fromAxisAngle([0, 0, 1], 10));
    cube.dispose();
    player.arrive();
    await settled();
    expect(player.quaternions).toEqual([]);
    expect(player.renders).toBe(0);
    expect(cube.orient(fromAxisAngle([0, 0, 1], 20))).toBe(false);
  });

  it('goes on without a 3D object when the player gives none', async () => {
    const player = new FakePlayer();
    vi.spyOn(player, 'experimentalCurrentThreeJSPuzzleObject').mockRejectedValue(
      new Error('no 3D'),
    );
    const cube = new ClipCube(player);
    await settled();
    cube.load('', ['R']);
    expect(cube.show(0, false)).toBe('animate');
    expect(cube.orient(fromAxisAngle([0, 0, 1], 10))).toBe(false);
    expect(player.log).toEqual(['add R']);
  });
});

describe('ClipCube and the orbit (T3.10)', () => {
  /** The orbits the listener heard, as the user's drags. */
  function dragged(cube: ClipCube): Orbit[] {
    const heard: Orbit[] = [];
    cube.onDrag((orbit) => heard.push(orbit));
    return heard;
  }

  it('compares orbits within a tolerance, −180 and 180 being one longitude', () => {
    expect(sameOrbit({ latitude: 0, longitude: 180 }, { latitude: 0, longitude: -180 }, 0)).toBe(
      true,
    );
    expect(
      sameOrbit({ latitude: 0, longitude: 179.95 }, { latitude: 0, longitude: -180 }, 0.06),
    ).toBe(true);
    expect(
      sameOrbit({ latitude: 12.34, longitude: 0 }, { latitude: 12.3, longitude: 0 }, 0.06),
    ).toBe(true);
    expect(
      sameOrbit({ latitude: 12.34, longitude: 0 }, { latitude: 12.2, longitude: 0 }, 0.06),
    ).toBe(false);
    expect(sameOrbit({ latitude: 0, longitude: 0.1 }, { latitude: 0, longitude: 0 }, 0.06)).toBe(
      false,
    );
    expect(ORBIT_TOLERANCE).toBeLessThan(0.1);
  });

  it('requests the view of the model in one go, and not again while the camera is there or the request is on its way', async () => {
    const player = new FakePlayer();
    const model = player.experimentalModel;
    const cube = new ClipCube(player);
    expect(cube.orbit).toBeNull();
    expect(cube.target).toBeNull();
    cube.view({ latitude: 90, longitude: 180 });
    expect(model.requests).toEqual([{ latitude: 90, longitude: 180 }]);
    // The same request again, before the model reported: nothing more; the target is the request.
    cube.view({ latitude: 90, longitude: 180 });
    expect(model.requests).toHaveLength(1);
    expect(cube.orbit).toBeNull();
    expect(cube.target).toEqual({ latitude: 90, longitude: 180 });
    await settled();
    // The model reports its orbit, the longitude as it keeps it.
    expect(cube.orbit).toEqual({ latitude: 90, longitude: -180 });
    expect(cube.target).toEqual({ latitude: 90, longitude: -180 });
    cube.view({ latitude: 90, longitude: 180 });
    cube.view({ latitude: 90, longitude: -180 });
    cube.view({ latitude: 89.95, longitude: 180 });
    expect(model.requests).toHaveLength(1);
    // Another view: requested.
    cube.view({ latitude: 0, longitude: 0 });
    expect(model.requests).toEqual([
      { latitude: 90, longitude: 180 },
      { latitude: 0, longitude: 0 },
    ]);
    await settled();
    expect(cube.orbit).toEqual({ latitude: 0, longitude: 0 });
  });

  it("tells the user's drags from its own requests' echoes, and from the model's orbit before the first request", async () => {
    const player = new FakePlayer();
    const model = player.experimentalModel;
    model.orbit = { latitude: 31.7, longitude: 0, distance: 5 };
    const cube = new ClipCube(player);
    const heard = dragged(cube);
    // The model's own orbit, reported as the listener is added: not a drag, nor is the echo.
    cube.view({ latitude: 0, longitude: 0 });
    await settled();
    expect(cube.orbit).toEqual({ latitude: 0, longitude: 0 });
    expect(heard).toEqual([]);

    // The user drags: heard, each report; then the view is asked for the orbit saved from the drag,
    // rounded, which moves nothing.
    model.drag({ latitude: 12.34, longitude: -20.06 });
    model.drag({ latitude: 13.3, longitude: -21 });
    await settled();
    expect(heard).toEqual([
      { latitude: 12.34, longitude: -20.06 },
      { latitude: 13.3, longitude: -21 },
    ]);
    expect(cube.target).toEqual({ latitude: 13.3, longitude: -21 });
    cube.view({ latitude: 13.3, longitude: -21 });
    expect(model.requests).toHaveLength(1);
    model.drag({ latitude: 14, longitude: -21 });
    await settled();
    expect(heard).toHaveLength(3);

    // A new request closes the gate until its echo: a report still on its way from before it (the
    // end of a drag's inertia) is not a drag; after the echo, a drag is heard again.
    model.drag({ latitude: 14.5, longitude: -21 });
    cube.view({ latitude: 0, longitude: 90 });
    await settled();
    expect(heard).toHaveLength(3);
    expect(cube.orbit).toEqual({ latitude: 0, longitude: 90 });
    model.drag({ latitude: 1, longitude: 91 });
    await settled();
    expect(heard).toHaveLength(4);
    expect(heard[3]).toEqual({ latitude: 1, longitude: 91 });
  });

  it('takes the echo of a view from behind, which the model reports as −180', async () => {
    const player = new FakePlayer();
    const cube = new ClipCube(player);
    const heard = dragged(cube);
    cube.view({ latitude: 0, longitude: 180 });
    await settled();
    expect(cube.orbit).toEqual({ latitude: 0, longitude: -180 });
    player.experimentalModel.drag({ latitude: 0, longitude: -170 });
    await settled();
    expect(heard).toEqual([{ latitude: 0, longitude: -170 }]);
  });

  it('hears nothing once disposed, and leaves the model its listener no more', async () => {
    const player = new FakePlayer();
    const model = player.experimentalModel;
    const cube = new ClipCube(player);
    const heard = dragged(cube);
    cube.view({ latitude: 0, longitude: 0 });
    await settled();
    expect(model.listeners.size).toBe(1);
    cube.dispose();
    expect(model.listeners.size).toBe(0);
    model.drag({ latitude: 5, longitude: 5 });
    await settled();
    expect(heard).toEqual([]);
  });
});
