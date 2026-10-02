import type { TwistyPlayer } from 'cubing/twisty';

import {
  ClipCube,
  type CubePlayer,
  type PuzzleObject,
  type Renderable,
  cubePlayerOf,
} from './clip-cube';
import { IDENTITY, type Quat, fromAxisAngle } from './cube-orientation';

/** A player that records what it was told, with a puzzle object that arrives when the test says. */
class FakePlayer implements CubePlayer {
  alg = '';
  experimentalSetupAlg = '';
  timestamp: number | 'start' | 'end' = 0;
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
    expect(cubePlayerOf(document.createElement('twisty-player'))).toBeNull();
    expect(cubePlayerOf({ experimentalAddMove: () => undefined })).toBeNull();
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
