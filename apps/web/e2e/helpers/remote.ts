import type { Page } from '@playwright/test';

// What the remote cameras' specs share (docs/RTC.md, docs/PLAN.md T4.2 and T4.3): the settings the
// suite bends in a phone's page (`window.cubetraceE2eRemote`, src/app/rtc/e2e-remote.ts, development
// builds only), the files of a session read from the host's origin private file system, the phone's
// pill as a failure should read it; and, for the remote sync check (T4.3), a phone camera whose
// motion the suite schedules, and the demo cube's turns at given times; and, for the remote controls
// (T5.2), that camera's focus controls, which the suite reads and changes behind the app's back.

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

/**
 * "recording" as a part of the phone's picture line (`… · 1920×1080 · recording`) or of the host's
 * report of it (`recording · 30 fps · …`), not "not recording", which a plain `toContainText`
 * matches too: the line says "not recording" from the page's start until the capture has its first
 * frames, 2 to 5 s after the camera opens (T4.3's runs).
 */
export const RECORDING = /(?:^|· )recording(?: ·|$)/u;

/** A phone's health as {@link phoneHealth} sets it: its battery, and its Compute Pressure state. */
export interface PhoneHealth {
  readonly battery: { readonly level: number; readonly charging: boolean };
  readonly pressure: { readonly source: 'cpu' | 'thermals'; readonly state: string };
}

/**
 * On every load of `page` from now on, the phone's health is the suite's (T5.1): the Battery Status
 * API's battery (`navigator.getBattery`) and the Compute Pressure API's observer (`PressureObserver`,
 * whose `knownSources` is the source given and which reports the state given a moment after
 * `observe`), both replaced before the app's scripts run, so that the host's status line has known
 * values to read (the browser's own would say the machine's, if it has them at all).
 */
export async function phoneHealth(page: Page, health: PhoneHealth): Promise<void> {
  await page.addInitScript((health) => {
    const battery = Object.assign(new EventTarget(), health.battery);
    Object.defineProperty(navigator, 'getBattery', {
      configurable: true,
      value: () => Promise.resolve(battery),
    });
    type Callback = (records: { source: string; state: string; time: number }[]) => void;
    class SuitePressureObserver {
      static readonly knownSources = Object.freeze([health.pressure.source]);
      private readonly callback: Callback;
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(callback: Callback) {
        this.callback = callback;
      }

      observe(source: string): Promise<void> {
        if (source !== health.pressure.source) {
          return Promise.reject(new DOMException(`No ${source} source.`, 'NotSupportedError'));
        }
        this.timer = setTimeout(() => {
          this.callback([{ source, state: health.pressure.state, time: performance.now() }]);
        }, 100);
        return Promise.resolve();
      }

      disconnect(): void {
        if (this.timer !== null) {
          clearTimeout(this.timer);
        }
      }
    }
    Object.defineProperty(window, 'PressureObserver', {
      configurable: true,
      writable: true,
      value: SuitePressureObserver,
    });
  }, health);
}

/** The synthetic camera's picture: its size, and the square that flips inside it. */
export const SYNTHETIC_CAMERA = {
  width: 640,
  height: 360,
  /** The square, in the frame's pixels: a sixth of the frame's area. */
  square: { x: 220, y: 80, w: 200, h: 200 },
  /**
   * Its focus (T5.2): the modes and the distance its tracks list in `getCapabilities()`, and what
   * each new track's settings say as it opens (a phone's camera opens in continuous focus).
   */
  focus: {
    modes: ['continuous', 'manual'],
    distance: { min: 0.1, max: 8.1, step: 0.01 },
    opening: { focusMode: 'continuous', focusDistance: 0.5 },
  },
} as const;

/** The focus of the synthetic camera's current track, and the constraints the app applied to it. */
export interface SyntheticControls {
  readonly settings: { readonly focusMode: string; readonly focusDistance: number };
  readonly applied: readonly unknown[];
}

/**
 * On every load of `page` from now on, the camera the page opens is a synthetic one (T4.3): a canvas
 * of {@link SYNTHETIC_CAMERA}'s size captured at 30 fps (`HTMLCanvasElement.captureStream`), a grey
 * picture with a square that is light and turns dark, or back, at the times the suite gives
 * ({@link flipAt}); nothing else in it ever changes, so that a sync check sees motion at those times
 * only. Any request with video gets a new track of it (the microphone, when asked for too, is the
 * browser's own). Chrome's fake camera cannot serve there: its test pattern jumps at its own pace.
 * Since T5.2 each track has a focus, as a phone's camera has (`getCapabilities()` lists its modes and
 * its distance's range, `getSettings()` says them, `applyConstraints` sets the advanced sets it can
 * take and keeps what it was given): {@link syntheticControls} reads it, and {@link driftCamera}
 * changes it as a camera that changes its focus by itself would.
 */
export async function syntheticCamera(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, size }) => {
      const media = navigator.mediaDevices;
      const getUserMedia = media.getUserMedia.bind(media);
      let source: MediaStreamTrack | null = null;
      /** The tracks handed out, with their focus and the constraints applied to them. */
      const opened: {
        track: MediaStreamTrack;
        settings: Record<string, unknown>;
        applied: unknown[];
      }[] = [];
      const focus = size.focus;
      const takes = (name: string, value: unknown): boolean =>
        name === 'focusMode'
          ? (focus.modes as readonly unknown[]).includes(value)
          : name === 'focusDistance' &&
            typeof value === 'number' &&
            value >= focus.distance.min &&
            value <= focus.distance.max;
      /** `track` with the synthetic camera's focus (T5.2), as a phone's camera track has one. */
      const withFocus = (track: MediaStreamTrack): MediaStreamTrack => {
        const entry = {
          track,
          settings: { ...focus.opening } as Record<string, unknown>,
          applied: [] as unknown[],
        };
        opened.push(entry);
        const getSettings = track.getSettings.bind(track);
        const getCapabilities = track.getCapabilities.bind(track);
        // Image Capture's keys, which TypeScript's DOM types do not have: plain objects.
        Object.defineProperty(track, 'getSettings', {
          value: (): Record<string, unknown> => ({ ...getSettings(), ...entry.settings }),
        });
        Object.defineProperty(track, 'getCapabilities', {
          value: (): Record<string, unknown> => ({
            ...getCapabilities(),
            focusMode: [...focus.modes],
            focusDistance: { ...focus.distance },
          }),
        });
        Object.defineProperty(track, 'applyConstraints', {
          value: (constraints?: MediaTrackConstraints): Promise<void> => {
            entry.applied.push(JSON.parse(JSON.stringify(constraints ?? {})) as unknown);
            for (const set of constraints?.advanced ?? []) {
              const values = Object.entries(set) as [string, unknown][];
              if (values.every(([name, value]) => takes(name, value))) {
                Object.assign(entry.settings, Object.fromEntries(values));
              }
            }
            return Promise.resolve();
          },
        });
        return track;
      };
      const live = () => opened.filter((entry) => entry.track.readyState === 'live');
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
          controls: () => {
            const entry = live().at(-1);
            return entry === undefined
              ? null
              : { settings: { ...entry.settings }, applied: [...entry.applied] };
          },
          drift: (values: Record<string, unknown>): void => {
            for (const entry of live()) {
              Object.assign(entry.settings, values);
            }
          },
        });
        const [track] = canvas.captureStream(30).getVideoTracks();
        source = track;
        return track;
      };
      media.getUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
        if (constraints?.video === undefined || constraints.video === false) {
          return getUserMedia(constraints);
        }
        const stream = new MediaStream([withFocus(open().clone())]);
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

/** The focus of the synthetic camera's current track in `page` (T5.2); null before it opens. */
export async function syntheticControls(page: Page): Promise<SyntheticControls | null> {
  return page.evaluate((key) => {
    const camera: unknown = Reflect.get(window, key);
    const read: unknown =
      typeof camera === 'object' && camera !== null ? Reflect.get(camera, 'controls') : undefined;
    return typeof read === 'function' ? (read as () => SyntheticControls | null)() : null;
  }, CAMERA);
}

/**
 * The synthetic camera of `page` changes `values` of its focus by itself (T5.2: the Moto g60's focus
 * that went manual at solve 31 on 2026-10-09), behind the app's back: its tracks' settings say them
 * from now on.
 */
export async function driftCamera(page: Page, values: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ({ key, values }) => {
      const camera: unknown = Reflect.get(window, key);
      const drift: unknown =
        typeof camera === 'object' && camera !== null ? Reflect.get(camera, 'drift') : undefined;
      if (typeof drift !== 'function') {
        throw new Error('the synthetic camera is not open on this page');
      }
      (drift as (values: Record<string, unknown>) => void)(values);
    },
    { key: CAMERA, values },
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
