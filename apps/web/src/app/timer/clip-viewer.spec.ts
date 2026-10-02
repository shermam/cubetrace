import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { AttemptRecord, GyroJson, GyroSummary, VideoClip } from '@cubetrace/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeAnimationFrames, polyfillDialog, settle } from '../device/fake-browser';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { SESSION_A, testAttempt } from '../session/session-testing';
import type { PuzzleObject, Renderable } from './clip-cube';
import {
  CUBE_TEMPO_SCALE,
  ClipViewer,
  attemptFileName,
  clipHostMs,
  clipMoves,
  clipSeconds,
  moveAt,
} from './clip-viewer';
import { ClipViewing } from './clip-viewing';
import { type Quat, fromAxisAngle, sameOrientation, toPlayerFrame } from './cube-orientation';
import { TWISTY_LOADER } from './scramble-view';

/**
 * cubing.js's `<twisty-player>`, as far as the viewer drives it (`CubePlayer`), defined in jsdom
 * in place of the real one (whose chunk the fake `TWISTY_LOADER` never loads): it records the algs
 * set, the moves added, the quaternions set on its puzzle object and the renders asked.
 */
class FakeTwistyPlayer extends HTMLElement {
  static readonly instances: FakeTwistyPlayer[] = [];
  alg = '';
  experimentalSetupAlg = '';
  timestamp: number | 'start' | 'end' = 0;
  readonly added: string[] = [];
  readonly quaternions: Quat[] = [];
  renders = 0;

  constructor() {
    super();
    FakeTwistyPlayer.instances.push(this);
  }

  experimentalAddMove(move: string): void {
    this.added.push(move);
  }

  experimentalCurrentThreeJSPuzzleObject(): Promise<PuzzleObject> {
    return Promise.resolve({
      quaternion: {
        set: (x: number, y: number, z: number, w: number) => {
          this.quaternions.push([x, y, z, w]);
        },
      },
    });
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
}

if (customElements.get('twisty-player') === undefined) {
  customElements.define('twisty-player', FakeTwistyPlayer);
}

/** testAttempt's moves: the scramble R U F at 100, 200, 300 ms, the solve at 1400, 2400, 3400. */
function clip(
  segment: 'scramble' | 'solve',
  firstFrameHostMs: number,
  syncResidualMs: number | null = null,
): VideoClip {
  return {
    camera: 'laptop',
    segment,
    file: `laptop.${segment}.mp4`,
    bytes: 1_234_567,
    codec: 'vp09.00.40.08',
    audio: 'opus',
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 150,
    firstFrameHostMs,
    framesFile: `laptop.${segment}.frames.json`,
    syncResidualMs,
    truncatedStart: false,
  };
}

const ATTEMPT: AttemptRecord = {
  ...testAttempt(3, 2000),
  video: [clip('scramble', -2000), clip('solve', -1000)],
};

/** The cube's white axis (+Z of its frame) and cubing.js's up (+Y), which it maps to. */
const WHITE = [0, 0, 1] as const;
const UP = [0, 1, 0] as const;

/**
 * A gyro file over the attempt: a sample every 100 ms from −1000 to 4400 ms (the solve clip's
 * span), the cube turned about its white axis by `yawAt` degrees at each.
 */
function gyroFile(yawAt: (hostMs: number) => number, truncatedStart = false): GyroJson {
  const times = Array.from({ length: 55 }, (_, k) => -1000 + k * 100);
  return {
    schema: 1,
    session: SESSION_A,
    index: 3,
    app: { version: '0.4.0', commit: 'abc1234' },
    t0HostMs: times[0],
    dtMs: times.map((_t, k) => (k === 0 ? 0 : 100)),
    q: times.flatMap((t) => [...fromAxisAngle(WHITE, yawAt(t))]),
    v: null,
    truncatedStart,
  };
}

/** 50° of arbitrary yaw at the clip's first frame, then 10° per 100 ms. */
const TURNING = gyroFile((hostMs) => 50 + (hostMs + 1000) / 10);

const GYRO_SUMMARY: GyroSummary = {
  file: 'gyro.json',
  samples: 55,
  fromHostMs: -1000,
  toHostMs: 4400,
  rateHz: 10,
  truncatedStart: false,
};

const WITH_GYRO: AttemptRecord = { ...ATTEMPT, gyro: GYRO_SUMMARY };

describe('clipMoves and moveAt', () => {
  it('time the moves of the clip’s segment from its first frame, and find the one shown', () => {
    const solve = ATTEMPT.video[1];
    const moves = clipMoves(ATTEMPT, solve);
    expect(moves.map((move) => [move.m, move.seconds])).toEqual([
      ["F'", 2.4],
      ["U'", 3.4],
      ["R'", 4.4],
    ]);
    expect([0, 2.39, 2.4, 3.5, 99].map((seconds) => moveAt(moves, solve, seconds))).toEqual([
      -1, -1, 0, 1, 2,
    ]);
    expect(clipMoves(ATTEMPT, ATTEMPT.video[0]).map((move) => move.m)).toEqual(['R', 'U', 'F']);
    expect(attemptFileName(ATTEMPT, 'laptop.solve.mp4')).toBe(
      `cubetrace-session-${SESSION_A}-attempt-0003-laptop.solve.mp4`,
    );
  });

  it('apply the camera’s lag: a move is in the picture syncResidualMs after its host time (T3.8)', () => {
    const lagging = clip('solve', -1000, 50);
    const moves = clipMoves(ATTEMPT, lagging);
    expect(moves.map((move) => move.seconds)).toEqual([2.45, 3.45, 4.45]);
    expect(moves.map((move) => move.hostMs)).toEqual([1400, 2400, 3400]);
    expect([2.4, 2.449, 2.45, 3.45, 4.5].map((seconds) => moveAt(moves, lagging, seconds))).toEqual(
      [-1, -1, 0, 1, 2],
    );
    // The picture at t shows the world lag earlier; a host time is in the picture lag later.
    expect(clipHostMs(lagging, 2.45)).toBeCloseTo(1400, 9);
    expect(clipSeconds(lagging, 1400)).toBeCloseTo(2.45, 9);
    expect(clipHostMs(clip('solve', -1000), 2.4)).toBe(1400);
    expect(clipSeconds(clip('solve', -1000), 1400)).toBe(2.4);
  });
});

describe('ClipViewer', () => {
  let urls: string[];
  let revoked: string[];
  let reads: string[];
  let frames: FakeAnimationFrames;
  let fixture: ComponentFixture<ClipViewer>;

  async function render(
    missing: readonly string[] = [],
    attempt: AttemptRecord = ATTEMPT,
    options: { gyro?: GyroJson; picture?: boolean } = {},
  ): Promise<HTMLElement> {
    urls = [];
    revoked = [];
    reads = [];
    frames = new FakeAnimationFrames();
    FakeTwistyPlayer.instances.length = 0;
    polyfillDialog();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            URL: {
              createObjectURL: (blob: Blob) => {
                const url = `blob:${String(urls.length)}:${blob.type}`;
                urls.push(url);
                return url;
              },
              revokeObjectURL: (url: string) => {
                revoked.push(url);
              },
            },
            requestAnimationFrame: frames.request,
            cancelAnimationFrame: frames.cancel,
          },
        },
        {
          provide: TWISTY_LOADER,
          useValue: () =>
            options.picture === false
              ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
              : Promise.resolve(),
        },
        {
          provide: ATTEMPT_FILES,
          useValue: {
            read: (sessionId: string, index: number, name: string) => {
              reads.push(`${sessionId}/${String(index)}/${name}`);
              if (missing.includes(name)) {
                return Promise.reject(
                  new DOMException('A requested file was not found.', 'NotFoundError'),
                );
              }
              if (name === 'gyro.json' && options.gyro !== undefined) {
                return Promise.resolve(
                  new Blob([JSON.stringify(options.gyro)], { type: 'application/json' }),
                );
              }
              return Promise.resolve(
                new Blob([name], {
                  type: name.endsWith('.mp4') ? 'video/mp4' : 'application/json',
                }),
              );
            },
          },
        },
      ],
    });
    TestBed.inject(ClipViewing).open(3);
    fixture = TestBed.createComponent(ClipViewer);
    fixture.componentRef.setInput('attempt', attempt);
    await update();
    return fixture.nativeElement as HTMLElement;
  }

  async function update(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  function video(element: HTMLElement): HTMLVideoElement {
    const found = element.querySelector('video');
    if (found === null) {
      throw new Error('No video.');
    }
    return found;
  }

  /** The video's `currentTime` and `paused` as the test sets them (jsdom plays nothing). */
  function controllable(player: HTMLVideoElement): { time: number; paused: boolean } {
    const state = { time: 0, paused: true };
    Object.defineProperty(player, 'currentTime', {
      configurable: true,
      get: () => state.time,
      set: (value: number) => {
        state.time = value;
      },
    });
    Object.defineProperty(player, 'paused', { configurable: true, get: () => state.paused });
    return state;
  }

  /** The 3D cube's element, the one made for the clip on screen. */
  function cube(): FakeTwistyPlayer {
    const player = FakeTwistyPlayer.instances.at(-1);
    if (player === undefined) {
      throw new Error('No 3D cube.');
    }
    return player;
  }

  /** A move as listed: its time and the move. */
  function moveText(item: Element): string {
    return `${item.querySelector('.t')?.textContent ?? ''} ${item.querySelector('.m')?.textContent ?? ''}`;
  }

  function current(element: HTMLElement): string[] {
    return Array.from(element.querySelectorAll('[data-testid="clip-move"].current'), moveText);
  }

  function orientationLine(element: HTMLElement): string {
    return element.querySelector('[data-testid="clip-orientation"]')?.textContent.trim() ?? '';
  }

  function expectOrientation(actual: Quat | undefined, expected: Quat, what: string): void {
    expect(actual, what).toBeDefined();
    expect(sameOrientation(actual ?? [0, 0, 0, 1], expected), `${what}: ${String(actual)}`).toBe(
      true,
    );
  }

  it("opens modal on the solve's clip, read from the attempt's folder behind an object URL", async () => {
    const element = await render();

    expect(element.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(reads).toEqual([`${SESSION_A}/3/laptop.solve.mp4`]);
    expect(video(element).getAttribute('src')).toBe('blob:0:video/mp4');
    expect(
      Array.from(element.querySelectorAll('[data-testid="clip-segment"]'), (button) => [
        button.textContent.trim(),
        button.getAttribute('aria-pressed'),
      ]),
    ).toEqual([
      ['Scramble', 'false'],
      ['Solve', 'true'],
    ]);
    expect(element.querySelector('[data-testid="clip-facts"]')?.textContent.trim()).toBe(
      'laptop.solve.mp4: 1920×1080, 150 frames, 1.2 MB, vp09.00.40.08, opus.',
    );
    expect(Array.from(element.querySelectorAll('[data-testid="clip-move"]'), moveText)).toEqual([
      "2.40 s F'",
      "3.40 s U'",
      "4.40 s R'",
    ]);
    expect(
      element.querySelector('[data-testid="clip-move"] button')?.getAttribute('aria-label'),
    ).toBe("F' at 2.40 s");
  });

  it('shows the 3D cube beside the video, set up for the solve from the scramble, and says the orientation is not recorded (T3.8)', async () => {
    const element = await render();
    const player = element.querySelector('[data-testid="clip-cube-player"]');
    expect(player?.tagName.toLowerCase()).toBe('twisty-player');
    expect(
      [
        'puzzle',
        'visualization',
        'background',
        'control-panel',
        'hint-facelets',
        'experimental-drag-input',
        'tempo-scale',
      ].map((name) => player?.getAttribute(name)),
    ).toEqual(['3x3x3', '3D', 'none', 'none', 'none', 'none', String(CUBE_TEMPO_SCALE)]);
    expect(cube().experimentalSetupAlg).toBe('R U F');
    expect(cube().alg).toBe('');
    expect(cube().timestamp).toBe('end');
    expect(orientationLine(element)).toBe(
      'Orientation not recorded: the attempt has no gyroscope file. The cube turns with the moves, upright.',
    );
    expect(element.querySelector('[data-testid="clip-rezero"]')).toBeNull();
    expect(element.querySelector('[data-testid="clip-raw"]')).toBeNull();
    // No gyro file: nothing is read but the clip, and the cube stays upright.
    expect(reads).toEqual([`${SESSION_A}/3/laptop.solve.mp4`]);
    expect(cube().quaternions).toEqual([[0, 0, 0, 1]]);
    expect(
      (element.querySelector('.body') as HTMLElement).style.getPropertyValue('--cube-share'),
    ).toBe('0.36');
  });

  it('highlights the move the video shows, and goes to a move clicked', async () => {
    const element = await render();
    const player = video(element);
    const state = controllable(player);
    expect(current(element)).toEqual([]);

    state.time = 3.5;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expect(current(element)).toEqual(["3.40 s U'"]);

    element.querySelectorAll<HTMLButtonElement>('[data-testid="clip-move"] button')[2].click();
    expect(state.time).toBe(4.4);
    player.dispatchEvent(new Event('seeked'));
    await update();
    expect(current(element)).toEqual(["4.40 s R'"]);
  });

  it('turns the 3D cube with the picture: the next move animated, the state rebuilt after a seek or over several moves (T3.8)', async () => {
    const element = await render();
    const player = video(element);
    const state = controllable(player);
    player.dispatchEvent(new Event('loadedmetadata'));
    await update();
    expect(cube().alg).toBe('');

    // Two moves passed since the last frame: the state at once.
    state.time = 3.5;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expect(cube().alg).toBe("F' U'");
    expect(cube().timestamp).toBe('end');
    expect(cube().added).toEqual([]);

    // The next move, as the time passes it: animated.
    state.time = 4.45;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expect(cube().added).toEqual(["R'"]);
    expect(cube().alg).toBe("F' U'");

    // Paused there: nothing more; a seek back: rebuilt.
    player.dispatchEvent(new Event('pause'));
    await update();
    expect(cube().added).toEqual(["R'"]);
    state.time = 2.5;
    player.dispatchEvent(new Event('seeked'));
    await update();
    expect(cube().alg).toBe("F'");
    expect(current(element)).toEqual(["2.40 s F'"]);

    // The scramble's clip: the same cube, from solved, with the scramble's own moves.
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();
    expect(FakeTwistyPlayer.instances).toHaveLength(1);
    expect(cube().experimentalSetupAlg).toBe('');
    expect(cube().alg).toBe('');
    const scramble = video(element);
    const scrambleState = controllable(scramble);
    scrambleState.time = 2.25;
    scramble.dispatchEvent(new Event('seeked'));
    await update();
    expect(cube().alg).toBe('R U');
  });

  it('follows the video every animation frame while it plays, where the browser gives no video frame callback', async () => {
    const element = await render();
    const player = video(element);
    const state = controllable(player);
    state.paused = false;
    player.dispatchEvent(new Event('play'));
    expect(frames.waiting).toBe(1);

    state.time = 2.45;
    frames.frame();
    await update();
    expect(current(element)).toEqual(["2.40 s F'"]);
    expect(cube().added).toEqual(["F'"]);
    expect(frames.waiting).toBe(1);

    // Paused: the loop ends with the frame that sees it.
    state.paused = true;
    state.time = 2.6;
    frames.frame();
    await update();
    expect(frames.waiting).toBe(0);

    // Playing again, then another clip chosen: the loop goes with the video it followed.
    state.paused = false;
    player.dispatchEvent(new Event('play'));
    expect(frames.waiting).toBe(1);
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();
    expect(frames.waiting).toBe(0);
    expect(current(element)).toEqual([]);

    fixture.destroy();
    expect(frames.waiting).toBe(0);
  });

  it('tilts the 3D cube as the gyro file says, relative to the clip’s first sample, the camera’s lag applied (T3.8)', async () => {
    const lagging: AttemptRecord = {
      ...WITH_GYRO,
      video: [clip('scramble', -2000), clip('solve', -1000, 50)],
    };
    const element = await render([], lagging, { gyro: TURNING });
    expect(reads).toEqual([`${SESSION_A}/3/laptop.solve.mp4`, `${SESSION_A}/3/gyro.json`]);
    expect(orientationLine(element)).toBe('Orientation from the gyroscope, zeroed at 0.00 s.');
    expect(element.querySelector('[data-testid="clip-rezero"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="clip-raw"]')).not.toBeNull();
    // The first frame shows the world 50 ms before −1000: before the file, so its first sample,
    // which is the reference: upright.
    expectOrientation(cube().quaternions.at(-1), [0, 0, 0, 1], 'at the first frame');
    const renders = cube().renders;

    // At 2.45 s the picture shows host time 1400: 240° since the reference, about the white axis,
    // which is cubing.js's Y.
    const player = video(element);
    const state = controllable(player);
    state.time = 2.45;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expectOrientation(cube().quaternions.at(-1), fromAxisAngle(UP, 240), 'at 2.45 s');
    expect(cube().renders).toBe(renders + 1);

    // Half-way between two samples: the slerp; the same time again: no render.
    state.time = 2.5;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expectOrientation(cube().quaternions.at(-1), fromAxisAngle(UP, 245), 'at 2.5 s');
    expect(cube().renders).toBe(renders + 2);
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expect(cube().renders).toBe(renders + 2);

    // Re-zero: the orientation now is upright, and the line says where.
    element.querySelector<HTMLButtonElement>('[data-testid="clip-rezero"]')?.click();
    await update();
    expectOrientation(cube().quaternions.at(-1), [0, 0, 0, 1], 'after Re-zero');
    expect(orientationLine(element)).toBe('Orientation from the gyroscope, zeroed at 2.50 s.');
    state.time = 3.5;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expectOrientation(cube().quaternions.at(-1), fromAxisAngle(UP, 100), 'at 3.5 s, re-zeroed');

    // Raw: the sample as recorded, in cubing.js's frame, its yaw included.
    const raw = element.querySelector<HTMLInputElement>('[data-testid="clip-raw"]');
    expect(raw?.checked).toBe(false);
    raw?.click();
    await update();
    expect(raw?.checked).toBe(true);
    expectOrientation(
      cube().quaternions.at(-1),
      toPlayerFrame(fromAxisAngle(WHITE, 50 + 345)),
      'raw at 3.5 s',
    );
    expect(orientationLine(element)).toBe(
      'Orientation from the gyroscope, as recorded (its yaw is arbitrary).',
    );
    expect(element.querySelector<HTMLButtonElement>('[data-testid="clip-rezero"]')?.disabled).toBe(
      true,
    );
    raw?.click();
    await update();
    expectOrientation(cube().quaternions.at(-1), fromAxisAngle(UP, 100), 'relative again');

    // The scramble clip: its own reference, the sample at its first frame (−2000, before the file:
    // the first sample).
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();
    expect(orientationLine(element)).toBe('Orientation from the gyroscope, zeroed at 0.00 s.');
    expectOrientation(cube().quaternions.at(-1), [0, 0, 0, 1], 'the scramble clip');
    expect(reads.filter((name) => name.endsWith('gyro.json'))).toHaveLength(1);
  });

  it('knows nothing before a truncated file’s first sample, and says so', async () => {
    const truncated: AttemptRecord = {
      ...ATTEMPT,
      gyro: { ...GYRO_SUMMARY, truncatedStart: true },
    };
    const element = await render([], truncated, {
      gyro: gyroFile((hostMs) => (hostMs + 1000) / 10, true),
    });
    expect(orientationLine(element)).toBe(
      'Orientation from the gyroscope, zeroed at 0.00 s. Not recorded before 0.00 s.',
    );
    const player = video(element);
    const state = controllable(player);
    state.time = 1;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expectOrientation(cube().quaternions.at(-1), fromAxisAngle(UP, 100), 'at 1 s');

    // Before the first sample (the clip begins 1 s before it, in the lagged file): upright.
    const earlier: AttemptRecord = {
      ...truncated,
      video: [clip('scramble', -2000), clip('solve', -2000)],
    };
    fixture.componentRef.setInput('attempt', earlier);
    await update();
    expect(orientationLine(element)).toBe(
      'Orientation from the gyroscope, zeroed at 0.00 s. Not recorded before 1.00 s.',
    );
    const again = video(element);
    const againState = controllable(again);
    againState.time = 0.5;
    again.dispatchEvent(new Event('seeked'));
    await update();
    expectOrientation(cube().quaternions.at(-1), [0, 0, 0, 1], 'before the first sample');
    againState.time = 2;
    again.dispatchEvent(new Event('seeked'));
    await update();
    expectOrientation(cube().quaternions.at(-1), fromAxisAngle(UP, 100), 'at 2 s');
  });

  it('says in one line when the gyro file cannot be read, and the cube still turns', async () => {
    const element = await render(['gyro.json'], WITH_GYRO);
    expect(orientationLine(element)).toBe(
      'The orientation could not be read: A requested file was not found.',
    );
    expect(
      element.querySelector('[data-testid="clip-orientation"]')?.classList.contains('error'),
    ).toBe(true);
    expect(element.querySelector('[data-testid="clip-rezero"]')).toBeNull();
    const player = video(element);
    const state = controllable(player);
    state.time = 2.5;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expect(cube().added).toEqual(["F'"]);
  });

  it('says in one line when the gyro file is not one', async () => {
    const element = await render([], WITH_GYRO, {
      gyro: { ...TURNING, q: TURNING.q.slice(0, 7) },
    });
    expect(orientationLine(element)).toMatch(/^The orientation could not be read: .*q.* 7/);
    expect(element.querySelector('[data-testid="clip-rezero"]')).toBeNull();
  });

  it('shows the moves list without the 3D cube when cubing.js cannot load', async () => {
    const element = await render([], ATTEMPT, { picture: false });
    expect(element.querySelector('[data-testid="clip-cube-player"]')).toBeNull();
    expect(element.querySelector('[data-testid="clip-cube-error"]')?.textContent.trim()).toBe(
      'No 3D cube: Failed to fetch dynamically imported module',
    );
    expect(element.querySelectorAll('[data-testid="clip-move"]')).toHaveLength(3);
  });

  it('shows the other clip when chosen, letting go of the first one’s URL', async () => {
    const element = await render();
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();

    expect(reads.at(-1)).toBe(`${SESSION_A}/3/laptop.scramble.mp4`);
    expect(revoked).toEqual(['blob:0:video/mp4']);
    expect(video(element).getAttribute('src')).toBe('blob:1:video/mp4');
    expect(current(element)).toEqual([]);
    expect(element.querySelectorAll('[data-testid="clip-move"]')).toHaveLength(3);

    fixture.destroy();
    expect(revoked).toEqual(['blob:0:video/mp4', 'blob:1:video/mp4']);
  });

  it('marks a clip that begins later than asked, its start older than the buffer', async () => {
    const element = await render();
    fixture.componentRef.setInput('attempt', {
      ...ATTEMPT,
      video: [{ ...clip('scramble', -2000), truncatedStart: true }, clip('solve', -1000)],
    });
    await update();
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();

    expect(
      Array.from(element.querySelectorAll('[data-testid="clip-segment"]'), (button) =>
        button.textContent.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Scramble · late', 'Solve']);
    expect(element.querySelector('[data-testid="clip-facts"]')?.textContent.trim()).toBe(
      'laptop.scramble.mp4: 1920×1080, 150 frames, 1.2 MB, vp09.00.40.08, opus. It begins later ' +
        'than asked: its start was older than the 90 s kept in memory.',
    );
  });

  it('downloads both clips, their frame times and attempt.json, named after the attempt', async () => {
    const element = await render();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });

    element.querySelector<HTMLButtonElement>('[data-testid="clip-download"]')?.click();
    await update();

    const prefix = `cubetrace-session-${SESSION_A}-attempt-0003-`;
    expect(names).toEqual([
      `${prefix}laptop.scramble.mp4`,
      `${prefix}laptop.scramble.frames.json`,
      `${prefix}laptop.solve.mp4`,
      `${prefix}laptop.solve.frames.json`,
      `${prefix}attempt.json`,
    ]);
    expect(element.querySelector('[data-testid="clip-download-error"]')).toBeNull();
  });

  it('downloads the gyro file with the rest when the attempt has one, and says so (T3.7)', async () => {
    const withGyro: AttemptRecord = {
      ...ATTEMPT,
      gyro: {
        file: 'gyro.json',
        samples: 240,
        fromHostMs: -2000,
        toHostMs: 2780,
        rateHz: 50,
        truncatedStart: false,
      },
    };
    const element = await render([], withGyro, { gyro: TURNING });
    expect(element.textContent).toContain(
      'both clips, their frame times, the gyroscope and attempt.json',
    );
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    element.querySelector<HTMLButtonElement>('[data-testid="clip-download"]')?.click();
    await update();
    const prefix = `cubetrace-session-${SESSION_A}-attempt-0003-`;
    expect(names).toEqual([
      `${prefix}laptop.scramble.mp4`,
      `${prefix}laptop.scramble.frames.json`,
      `${prefix}laptop.solve.mp4`,
      `${prefix}laptop.solve.frames.json`,
      `${prefix}gyro.json`,
      `${prefix}attempt.json`,
    ]);
    expect(reads.at(-1)).toBe(`${SESSION_A}/3/gyro.json`);
  });

  it('says a clip deleted once uploaded is in the cloud, in place of its video, and downloads what is here', async () => {
    const solveGone: AttemptRecord = {
      ...ATTEMPT,
      video: [clip('scramble', -2000), { ...clip('solve', -1000), local: false }],
    };
    const element = await render([], solveGone);
    expect(reads).toEqual([]);
    expect(element.querySelector('video')).toBeNull();
    expect(element.querySelector('[data-testid="clip-cloud"]')?.textContent).toContain(
      'In the cloud: this clip was deleted from this device once its upload was confirmed',
    );
    // No 3D cube for a clip that is not here (T3.8).
    expect(element.querySelector('[data-testid="clip-cube"]')).toBeNull();
    expect(element.querySelector('.body')?.classList.contains('with-cube')).toBe(false);
    expect(
      Array.from(element.querySelectorAll('[data-testid="clip-segment"]'), (button) =>
        button.textContent.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Scramble', 'Solve · in the cloud']);
    // Its moves are still listed, by their time into the clip.
    expect(element.querySelectorAll('[data-testid="clip-move"]')).toHaveLength(3);
    expect(element.querySelector('.actions .muted')?.textContent.trim()).toBe(
      'the clip on this device, the frame times and attempt.json',
    );

    // The scramble's clip is here: it plays, with its cube.
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();
    expect(reads).toEqual([`${SESSION_A}/3/laptop.scramble.mp4`]);
    expect(video(element).getAttribute('src')).toBe('blob:0:video/mp4');
    expect(element.querySelector('[data-testid="clip-cube"]')).not.toBeNull();
    expect(element.querySelector('.body')?.classList.contains('with-cube')).toBe(true);

    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    element.querySelector<HTMLButtonElement>('[data-testid="clip-download"]')?.click();
    await update();
    const prefix = `cubetrace-session-${SESSION_A}-attempt-0003-`;
    expect(names).toEqual([
      `${prefix}laptop.scramble.mp4`,
      `${prefix}laptop.scramble.frames.json`,
      `${prefix}laptop.solve.frames.json`,
      `${prefix}attempt.json`,
    ]);

    fixture.componentRef.setInput('attempt', {
      ...solveGone,
      video: solveGone.video.map((c) => ({ ...c, local: false })),
    });
    await update();
    expect(element.querySelector('.actions .muted')?.textContent.trim()).toBe(
      'the frame times and attempt.json (the clips are in the cloud)',
    );
  });

  it('says so when a file cannot be read, and closes', async () => {
    const element = await render(['laptop.solve.mp4', 'laptop.scramble.frames.json']);
    expect(element.querySelector('[data-testid="clip-error"]')?.textContent.trim()).toBe(
      'The clip could not be read: A requested file was not found.',
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    element.querySelector<HTMLButtonElement>('[data-testid="clip-download"]')?.click();
    await update();
    expect(element.querySelector('[data-testid="clip-download-error"]')?.textContent.trim()).toBe(
      'The files could not be downloaded: A requested file was not found.',
    );

    element.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await update();
    expect(TestBed.inject(ClipViewing).index()).toBeNull();
  });
});
