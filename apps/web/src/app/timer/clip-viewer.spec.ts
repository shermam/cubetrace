import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  type AttemptRecord,
  type GyroJson,
  type GyroSummary,
  type Quat,
  VIEWER_DEFAULT,
  type VideoClip,
  type ViewerChoice,
  clipHostMs,
  clipSeconds,
  fromAxisAngle,
  mirrored,
  sameOrientation,
  toPlayerFrame,
} from '@cubetrace/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FakeAnimationFrames,
  FakeLocalStorage,
  polyfillDialog,
  settle,
} from '../device/fake-browser';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { SESSION_A, testAttempt } from '../session/session-testing';
import { SETTINGS_STORAGE_KEY, SettingsService } from '../settings/settings-service';
import type { PuzzleObject, Renderable } from './clip-cube';
import { FakeOrbitModel } from './clip-cube-testing';
import {
  CUBE_CAMERA_DISTANCE,
  CUBE_TEMPO_SCALE,
  ClipViewer,
  VIEW_HELP,
  attemptFileName,
  clipMoves,
  moveAt,
} from './clip-viewer';
import { ClipViewing } from './clip-viewing';
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
  /** The model's orbit (T3.10): the requests made of it, and the user's drags. */
  readonly experimentalModel = new FakeOrbitModel();
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
  camera = 'laptop',
): VideoClip {
  return {
    camera,
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
  /** The settings' storage: the view and the mirror kept per camera (T3.10). */
  let storage: FakeLocalStorage;
  let fixture: ComponentFixture<ClipViewer>;

  async function render(
    missing: readonly string[] = [],
    attempt: AttemptRecord = ATTEMPT,
    options: { gyro?: GyroJson; picture?: boolean; viewer?: Record<string, ViewerChoice> } = {},
  ): Promise<HTMLElement> {
    urls = [];
    revoked = [];
    reads = [];
    frames = new FakeAnimationFrames();
    storage = new FakeLocalStorage();
    if (options.viewer !== undefined) {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ viewer: options.viewer }));
    }
    FakeTwistyPlayer.instances.length = 0;
    polyfillDialog();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            localStorage: storage,
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

  /** The choice kept for the camera labelled `camera`, as the viewer's host keeps it. */
  function kept(camera: string): ViewerChoice | null {
    return TestBed.inject(SettingsService).viewerChoiceFor(camera);
  }

  /** The orbit the model holds: where the player's camera looks from. */
  function orbit(): [number, number] {
    const { latitude, longitude } = cube().experimentalModel.orbit;
    return [latitude, longitude];
  }

  function click(element: HTMLElement, testId: string): void {
    element.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  }

  function mirrorSelect(element: HTMLElement): HTMLSelectElement {
    const select = element.querySelector<HTMLSelectElement>('[data-testid="clip-mirror"]');
    if (select === null) {
      throw new Error('No mirror select.');
    }
    return select;
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

  it('shows the 3D cube under the video, seen straight on, set up for the solve from the scramble, and says the orientation is not recorded (T3.8, T3.10)', async () => {
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
        'camera-latitude',
        'camera-longitude',
        'camera-latitude-limit',
        'camera-distance',
        'tempo-scale',
      ].map((name) => player?.getAttribute(name)),
    ).toEqual([
      '3x3x3',
      '3D',
      'none',
      'none',
      'none',
      'auto',
      '0',
      '0',
      '90',
      String(CUBE_CAMERA_DISTANCE),
      String(CUBE_TEMPO_SCALE),
    ]);
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
    // Under the video, in its column, as wide as it and half as tall (twice a 16:9 clip's ratio).
    const block = element.querySelector<HTMLElement>('.player [data-testid="clip-cube"]');
    expect(block).not.toBeNull();
    expect(block?.style.getPropertyValue('--cube-aspect')).toBe('3.556');
    expect(element.querySelector('video')?.compareDocumentPosition(block ?? element) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The view's controls, the mirror and the help line (T3.10); the model at the front view.
    expect(
      Array.from(element.querySelectorAll('.view-controls button'), (b) => b.textContent.trim()),
    ).toEqual(['Turn ◀', 'Turn ▶', 'Tilt ▲', 'Tilt ▼', 'Behind', 'Reset view']);
    expect(mirrorSelect(element).value).toBe('none');
    expect(
      Array.from(mirrorSelect(element).options, (option) => [option.value, option.text.trim()]),
    ).toEqual([
      ['none', 'none'],
      ['left-right', 'left–right'],
      ['up-down', 'up–down'],
      ['front-back', 'front–back'],
      ['all', 'all'],
    ]);
    expect(element.querySelector('[data-testid="clip-view-help"]')?.textContent.trim()).toBe(
      VIEW_HELP,
    );
    expect(orbit()).toEqual([0, 0]);
    expect(kept('laptop')).toBeNull();
  });

  it('turns and tilts the view by the presets, keeps the choice for the clip’s camera, and resets it (T3.10)', async () => {
    const element = await render();
    const model = cube().experimentalModel;
    click(element, 'clip-turn-right');
    await update();
    expect(orbit()).toEqual([0, 90]);
    expect(kept('laptop')).toEqual({ latitude: 0, longitude: 90, mirror: 'none' });
    click(element, 'clip-turn-left');
    click(element, 'clip-turn-left');
    await update();
    expect(orbit()).toEqual([0, -90]);
    expect(kept('laptop')).toEqual({ latitude: 0, longitude: -90, mirror: 'none' });
    // Tilts within what the camera allows: a second step up stays at 90.
    click(element, 'clip-tilt-up');
    await update();
    expect(orbit()).toEqual([90, -90]);
    const requests = model.requests.length;
    click(element, 'clip-tilt-up');
    await update();
    expect(orbit()).toEqual([90, -90]);
    expect(model.requests).toHaveLength(requests);
    expect(kept('laptop')).toEqual({ latitude: 90, longitude: -90, mirror: 'none' });
    click(element, 'clip-tilt-down');
    click(element, 'clip-tilt-down');
    await update();
    expect(orbit()).toEqual([-90, -90]);
    // Behind: longitude 180, kept as 180 and held by the model as 180.
    click(element, 'clip-behind');
    await update();
    expect(orbit()).toEqual([-90, 180]);
    expect(kept('laptop')).toEqual({ latitude: -90, longitude: 180, mirror: 'none' });
    click(element, 'clip-reset-view');
    await update();
    expect(orbit()).toEqual([0, 0]);
    expect(kept('laptop')).toEqual(VIEWER_DEFAULT);
    // The other clip, of the same camera: its view too; another camera's clip: the defaults.
    click(element, 'clip-turn-right');
    await update();
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();
    expect(orbit()).toEqual([0, 90]);
    fixture.componentRef.setInput('attempt', {
      ...ATTEMPT,
      video: [clip('scramble', -2000, null, 'phone-rear'), clip('solve', -1000)],
    });
    await update();
    expect(orbit()).toEqual([0, 0]);
    expect(kept('phone-rear')).toBeNull();
    expect(kept('laptop')).toEqual({ latitude: 0, longitude: 90, mirror: 'none' });
  });

  it('keeps a drag’s orbit for the camera, to a tenth of a degree, without asking the player again (T3.10)', async () => {
    const element = await render();
    const model = cube().experimentalModel;
    const requests = model.requests.length;
    model.drag({ latitude: 12.34, longitude: -20.06 });
    await update();
    expect(kept('laptop')).toEqual({ latitude: 12.3, longitude: -20.1, mirror: 'none' });
    expect(model.requests).toHaveLength(requests);
    expect(orbit()).toEqual([12.34, -20.06]);
    model.drag({ latitude: 40, longitude: 170 });
    model.drag({ latitude: 45.55, longitude: 179.96 });
    await update();
    expect(kept('laptop')).toEqual({ latitude: 45.6, longitude: 180, mirror: 'none' });
    expect(model.requests).toHaveLength(requests);
    // A preset from where the drag left the camera, kept to a tenth of a degree.
    click(element, 'clip-tilt-down');
    await update();
    expect(orbit()).toEqual([-44.4, 180]);
    expect(kept('laptop')).toEqual({ latitude: -44.4, longitude: 180, mirror: 'none' });
  });

  it('opens a clip with the view and the mirror kept for its camera, which the player’s first report does not undo (T3.10)', async () => {
    const choice: ViewerChoice = { latitude: 90, longitude: 180, mirror: 'up-down' };
    const element = await render([], WITH_GYRO, {
      gyro: TURNING,
      viewer: { laptop: choice, 'phone-rear': { latitude: 0, longitude: -90, mirror: 'all' } },
    });
    const model = cube().experimentalModel;
    expect(model.requests).toEqual([{ latitude: 90, longitude: 180 }]);
    expect(orbit()).toEqual([90, 180]);
    expect(mirrorSelect(element).value).toBe('up-down');
    expect(kept('laptop')).toEqual(choice);
    // The orientation in the mirror: at 2.45 s (host time 1450, no lag), 245° about the vertical
    // since the first frame's sample, seen up–down.
    const player = video(element);
    const state = controllable(player);
    state.time = 2.45;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expectOrientation(
      cube().quaternions.at(-1),
      mirrored(fromAxisAngle(UP, 245), 'up-down'),
      'at 2.45 s, up–down',
    );
    // A clip of another camera: its own choice; the scramble clip of this one: the same choice.
    fixture.componentRef.setInput('attempt', {
      ...WITH_GYRO,
      video: [clip('scramble', -2000, null, 'phone-rear'), clip('solve', -1000)],
    });
    await update();
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();
    expect(orbit()).toEqual([0, -90]);
    expect(mirrorSelect(element).value).toBe('all');
    element.querySelector<HTMLButtonElement>('[data-segment="solve"]')?.click();
    await update();
    expect(orbit()).toEqual([90, 180]);
    expect(mirrorSelect(element).value).toBe('up-down');
  });

  it('reflects the orientation in the mirror chosen, kept for the camera; Re-zero and Raw are not kept (T3.10)', async () => {
    const element = await render([], WITH_GYRO, { gyro: TURNING });
    const player = video(element);
    const state = controllable(player);
    state.time = 2.45;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    // At 2.45 s the picture shows host time 1450 (no lag): 245° since the first frame's sample.
    expectOrientation(cube().quaternions.at(-1), fromAxisAngle(UP, 245), 'no mirror');

    const select = mirrorSelect(element);
    select.value = 'left-right';
    select.dispatchEvent(new Event('change'));
    await update();
    expectOrientation(
      cube().quaternions.at(-1),
      mirrored(fromAxisAngle(UP, 245), 'left-right'),
      'left–right',
    );
    expect(kept('laptop')).toEqual({ latitude: 0, longitude: 0, mirror: 'left-right' });
    expect(select.value).toBe('left-right');
    // The mirror applies to the raw samples and after a re-zero too; neither is kept.
    click(element, 'clip-rezero');
    await update();
    expectOrientation(cube().quaternions.at(-1), [0, 0, 0, 1], 're-zeroed');
    state.time = 3.45;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expectOrientation(
      cube().quaternions.at(-1),
      mirrored(fromAxisAngle(UP, 100), 'left-right'),
      're-zeroed, left–right',
    );
    element.querySelector<HTMLInputElement>('[data-testid="clip-raw"]')?.click();
    await update();
    expectOrientation(
      cube().quaternions.at(-1),
      mirrored(toPlayerFrame(fromAxisAngle(WHITE, 50 + 345)), 'left-right'),
      'raw, left–right',
    );
    expect(kept('laptop')).toEqual({ latitude: 0, longitude: 0, mirror: 'left-right' });
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    await update();
    expectOrientation(
      cube().quaternions.at(-1),
      mirrored(toPlayerFrame(fromAxisAngle(WHITE, 50 + 345)), 'all'),
      'raw, all',
    );
    select.value = 'none';
    select.dispatchEvent(new Event('change'));
    await update();
    expect(kept('laptop')).toEqual(VIEWER_DEFAULT);
    // A value that is no mirror changes nothing.
    select.dispatchEvent(new Event('change'));
    Object.defineProperty(select, 'value', { configurable: true, value: 'sideways' });
    select.dispatchEvent(new Event('change'));
    await update();
    expect(kept('laptop')).toEqual(VIEWER_DEFAULT);
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
    expect(element.querySelector('[data-testid="clip-mirror"]')).toBeNull();
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
    expect(element.querySelector('.player [data-testid="clip-cube"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="clip-mirror"]')).not.toBeNull();

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
