import type { Page } from '@playwright/test';

// What the remote cameras' specs share (docs/RTC.md, docs/PLAN.md T4.2 and T4.3): the settings the
// suite bends in a phone's page (`window.cubetraceE2eRemote`, src/app/rtc/e2e-remote.ts, development
// builds only), the files of a session read from the host's origin private file system, the phone's
// pill as a failure should read it; and, for the remote sync check (T4.3), a phone camera whose
// motion the suite schedules, and the demo cube's turns at given times.

/** The window property the app reads in development builds (src/app/rtc/e2e-remote.ts). */
const E2E_REMOTE = 'cubetraceE2eRemote';

/** The window property of the phone page's synthetic camera ({@link syntheticCamera}). */
const CAMERA = '__cubetraceTestCamera';

/** Sets what the suite bends on every load of `page` (src/app/rtc/e2e-remote.ts). */
export async function bend(page: Page, settings: Record<string, number | boolean>): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      Reflect.set(window, key, value);
    },
    { key: E2E_REMOTE, value: settings },
  );
}

/**
 * A file of the session's folder, as text: `session.json`, or `attempts/0001/<name>`. The app
 * replaces a file by moving a new one over it (`writeTextFile`), and a read at that instant finds
 * no file (a `NotFoundError`, which failed a poll of the record once in T4.2b's runs), or a file
 * that was replaced after the page took it (a `NotReadableError`, which failed T4.3's run of
 * uploads.spec.ts on `uploads.json`): it is read again then, a few times, 100 ms apart.
 */
export async function fileText(page: Page, sessionId: string, path: string[]): Promise<string> {
  return page.evaluate(
    async ({ sessionId, path }) => {
      for (let tries = 1; ; tries++) {
        try {
          let dir = await navigator.storage.getDirectory();
          for (const name of ['sessions', sessionId, ...path.slice(0, -1)]) {
            dir = await dir.getDirectoryHandle(name);
          }
          return await (await (await dir.getFileHandle(path[path.length - 1])).getFile()).text();
        } catch (error: unknown) {
          const replaced =
            error instanceof DOMException &&
            (error.name === 'NotFoundError' || error.name === 'NotReadableError');
          if (!replaced || tries === 5) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    { sessionId, path },
  );
}

/**
 * The phone's pill as a failure should read it: its state, and the problem line when it has one (why
 * a join was refused, why the host is gone).
 */
export async function pill(phone: Page): Promise<string> {
  const state = (await phone.getByTestId('device-state').getAttribute('data-state')) ?? '';
  const problem = (await phone.getByTestId('device-problem').allTextContents()).join(' ').trim();
  return problem === '' ? state : `${state}: ${problem}`;
}

/** The synthetic camera's picture: its size, and the square that flips inside it. */
export const SYNTHETIC_CAMERA = {
  width: 640,
  height: 360,
  /** The square, in the frame's pixels: a sixth of the frame's area. */
  square: { x: 220, y: 80, w: 200, h: 200 },
} as const;

/**
 * On every load of `page` from now on, the camera the page opens is a synthetic one (T4.3): a canvas
 * of {@link SYNTHETIC_CAMERA}'s size captured at 30 fps (`HTMLCanvasElement.captureStream`), a grey
 * picture with a square that is light and turns dark, or back, at the times the suite gives
 * ({@link flipAt}); nothing else in it ever changes, so that a sync check sees motion at those times
 * only. Any request with video gets a new track of it (the microphone, when asked for too, is the
 * browser's own). Chrome's fake camera cannot serve there: its test pattern jumps at its own pace.
 */
export async function syntheticCamera(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, size }) => {
      const media = navigator.mediaDevices;
      const getUserMedia = media.getUserMedia.bind(media);
      let source: MediaStreamTrack | null = null;
      const open = (): MediaStreamTrack => {
        if (source !== null) {
          return source;
        }
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.style.cssText =
          'position: fixed; left: 0; top: 0; width: 2px; height: 2px; opacity: 0.01; pointer-events: none';
        document.documentElement.append(canvas);
        const context = canvas.getContext('2d');
        if (context === null) {
          throw new Error('the synthetic camera: no 2D context');
        }
        let dark = false;
        const draw = (): void => {
          context.fillStyle = '#808080';
          context.fillRect(0, 0, size.width, size.height);
          context.fillStyle = dark ? '#202020' : '#e0e0e0';
          const { x, y, w, h } = size.square;
          context.fillRect(x, y, w, h);
        };
        draw();
        // Drawn over and over (the same picture), so that frames keep coming at the capture's rate.
        setInterval(draw, 16);
        const flips: number[] = [];
        const now = (): number => performance.timeOrigin + performance.now();
        Reflect.set(window, key, {
          flipAt: (times: number[]): void => {
            for (const at of times) {
              setTimeout(
                () => {
                  dark = !dark;
                  draw();
                  flips.push(now());
                },
                Math.max(0, at - now()),
              );
            }
          },
          flips: (): number[] => [...flips],
        });
        const [track] = canvas.captureStream(30).getVideoTracks();
        source = track;
        return track;
      };
      media.getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
        if (constraints?.video === undefined || constraints.video === false) {
          return getUserMedia(constraints);
        }
        const stream = new MediaStream([open().clone()]);
        if (constraints.audio !== undefined && constraints.audio !== false) {
          for (const track of (await getUserMedia({ audio: constraints.audio })).getAudioTracks()) {
            stream.addTrack(track);
          }
        }
        return stream;
      };
    },
    { key: CAMERA, size: SYNTHETIC_CAMERA },
  );
}

/**
 * The synthetic camera of `page` ({@link syntheticCamera}) flips its square at each of `times`, on
 * the shared clock of the browser's pages (`performance.timeOrigin + performance.now()`, the host
 * clock of docs/DATA-MODEL.md §1, without the clock offset the suite may bend the phone's
 * connection with). Resolves at once; the flips come at their times.
 */
export async function flipAt(page: Page, times: readonly number[]): Promise<void> {
  await page.evaluate(
    ({ key, times }) => {
      const camera: unknown = Reflect.get(window, key);
      const flip: unknown =
        typeof camera === 'object' && camera !== null ? Reflect.get(camera, 'flipAt') : undefined;
      if (typeof flip !== 'function') {
        throw new Error('the synthetic camera is not open on this page');
      }
      (flip as (times: number[]) => void)([...times]);
    },
    { key: CAMERA, times },
  );
}

/** When the synthetic camera of `page` flipped its square, on the shared clock. */
export async function flips(page: Page): Promise<number[]> {
  return page.evaluate((key) => {
    const camera: unknown = Reflect.get(window, key);
    const read: unknown =
      typeof camera === 'object' && camera !== null ? Reflect.get(camera, 'flips') : undefined;
    return typeof read === 'function' ? (read as () => number[])() : [];
  }, CAMERA);
}

/**
 * The demo cube of the Timer page in `page` turns face R at each of `times` (the host clock), a
 * quarter turn and back in turn, so that an even count leaves it as it was; resolves at once, and
 * {@link turned} says when the turns came. The dev server's debugging API (`ng`, development
 * builds only) reaches the page's CubeService, whose connection is the demo cube's FakeGanCube:
 * its `turn` emits a move at once, as a cube's report would.
 */
export async function turnAt(page: Page, times: readonly number[]): Promise<void> {
  await page.evaluate((times) => {
    const ng: unknown = Reflect.get(window, 'ng');
    const getComponent: unknown =
      typeof ng === 'object' && ng !== null ? Reflect.get(ng, 'getComponent') : undefined;
    if (typeof getComponent !== 'function') {
      throw new Error('no ng.getComponent: the page is not a development build');
    }
    const timer: unknown = (getComponent as (element: Element | null) => unknown)(
      document.querySelector('app-timer-page'),
    );
    const cube: unknown =
      typeof timer === 'object' && timer !== null ? Reflect.get(timer, 'cube') : undefined;
    const connection: unknown =
      typeof cube === 'object' && cube !== null ? Reflect.get(cube, 'connection') : undefined;
    const turn: unknown =
      typeof connection === 'object' && connection !== null
        ? Reflect.get(connection, 'turn')
        : undefined;
    if (typeof turn !== 'function') {
      throw new Error("the Timer page's cube is not the demo cube");
    }
    const move = turn as (this: unknown, move: { face: string; turns: number }) => void;
    const turned: number[] = [];
    Reflect.set(window, '__cubetraceTestTurns', turned);
    const now = (): number => performance.timeOrigin + performance.now();
    times.forEach((at, k) => {
      setTimeout(
        () => {
          move.call(connection, { face: 'R', turns: k % 2 === 0 ? 1 : 3 });
          turned.push(now());
        },
        Math.max(0, at - now()),
      );
    });
  }, times);
}

/** When the turns of {@link turnAt} came, on the host clock. */
export async function turned(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const turned: unknown = Reflect.get(window, '__cubetraceTestTurns');
    return Array.isArray(turned) ? turned.filter((at) => typeof at === 'number') : [];
  });
}
