import { signal, type WritableSignal } from '@angular/core';
import {
  applyControls,
  controlsOf,
  type CameraControls,
  type ControlValues,
} from '@cubetrace/capture';

import {
  FAKE_PHONE_REAR,
  FakePerformance,
  FakeTimers,
  FakeVideoTrack,
} from '../device/fake-browser';
import {
  ControlsWatch,
  DRIFT_READINGS,
  MAX_REAPPLICATIONS,
  REAPPLY_WINDOW_MS,
  WATCH_INTERVAL_MS,
  agrees,
  expectedValues,
  type DriftEvent,
} from './controls-watch';

/** The ThinkPhone's rear camera's controls (docs/devices/): every mode, the ranges and the torch. */
const REAR: CameraControls = controlsOf(FAKE_PHONE_REAR.capabilities, FAKE_PHONE_REAR.settings);

/** What the app applied to the rear camera as it opened: the mode each group opened in. */
const OPENING: ControlValues = {
  exposureMode: 'continuous',
  focusMode: 'continuous',
  whiteBalanceMode: 'continuous',
};

describe('ControlsWatch', () => {
  let perf: FakePerformance;
  let timers: FakeTimers;
  let track: FakeVideoTrack;
  let applied: WritableSignal<ControlValues>;
  let keep: boolean;
  let paused: boolean;
  let events: DriftEvent[];
  let reapplied: ControlValues[];
  let watch: ControlsWatch;

  /** The camera changes `values` by itself: the track's settings, without the app asking. */
  function drift(values: ControlValues): void {
    track.drift(values);
  }

  /** What the track's settings say of `name`. */
  function setting(name: string): unknown {
    return (track.getSettings() as Record<string, unknown>)[name];
  }

  /** Moves the clock by `readings` intervals of the watch: that many readings. */
  async function readings(count: number): Promise<void> {
    for (let k = 0; k < count; k++) {
      timers.advance(WATCH_INTERVAL_MS);
      // The re-application is a promise: its snapshot comes a turn later.
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    perf = new FakePerformance();
    timers = new FakeTimers(perf);
    track = new FakeVideoTrack(FAKE_PHONE_REAR);
    applied = signal<ControlValues>(OPENING);
    keep = true;
    paused = false;
    events = [];
    reapplied = [];
    watch = new ControlsWatch();
    watch.start(track, applied, {
      controls: () => REAR,
      keep: () => keep,
      paused: () => paused,
      reapply: async (values) => {
        reapplied.push(values);
        await applyControls(track, values);
      },
      onDrift: (event) => {
        events.push(event);
      },
      timers: {
        now: () => perf.hostMs,
        setTimeout: timers.setTimeout,
        clearTimeout: (handle) => {
          timers.clearTimeout(handle as number);
        },
      },
    });
  });

  afterEach(() => {
    watch.stop();
  });

  it('sees nothing while the camera does what the app applied', async () => {
    await readings(10);
    expect(watch.drift()).toEqual([]);
    expect(events).toEqual([]);
    expect(timers.pending).toBe(1);
  });

  it('calls a difference a drift after two readings, not one, and sets it back with Keep the camera’s modes', async () => {
    expect(DRIFT_READINGS).toBe(2);
    drift({ focusMode: 'manual' });
    await readings(1);
    expect(watch.drift()).toEqual([]);
    expect(events).toEqual([]);
    await readings(1);
    const focus = { name: 'focusMode', expected: 'continuous', actual: 'manual' };
    expect(events).toEqual([{ drift: [focus], reapplied: true, gaveUp: false, keep: true }]);
    expect(reapplied).toEqual([{ focusMode: 'continuous' }]);
    expect(track.applied.at(-1)).toEqual({ advanced: [{ focusMode: 'continuous' }] });
    expect(watch.drift()).toEqual([focus]);
    expect(watch.last()).toMatchObject({ reapplied: true, atMs: perf.hostMs });
    // The next reading agrees: the drift is over, and said for a minute.
    await readings(1);
    expect(setting('focusMode')).toBe('continuous');
    expect(watch.drift()).toEqual([]);
    expect(watch.last()?.reapplied).toBe(true);
    await readings(REAPPLY_WINDOW_MS / WATCH_INTERVAL_MS);
    expect(watch.last()).toBeNull();
    expect(events).toHaveLength(1);
  });

  it('reads nothing while a slider moves, and counts again from the next reading', async () => {
    paused = true;
    drift({ focusMode: 'manual' });
    await readings(5);
    expect(events).toEqual([]);
    expect(watch.drift()).toEqual([]);
    // One reading before the pause, one after: not two in a row.
    paused = false;
    await readings(1);
    paused = true;
    await readings(1);
    paused = false;
    await readings(1);
    expect(events).toEqual([]);
    await readings(1);
    expect(events).toHaveLength(1);
  });

  it('gives a drift up after three re-applications within a minute, and says so once', async () => {
    expect(MAX_REAPPLICATIONS).toBe(3);
    // The camera goes back to manual right after each re-application.
    for (let k = 0; k < MAX_REAPPLICATIONS; k++) {
      drift({ focusMode: 'manual' });
      await readings(DRIFT_READINGS);
    }
    expect(reapplied).toHaveLength(3);
    drift({ focusMode: 'manual' });
    await readings(DRIFT_READINGS);
    expect(reapplied).toHaveLength(3);
    expect(events.map((event) => [event.reapplied, event.gaveUp])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(watch.drift()).toEqual([
      { name: 'focusMode', expected: 'continuous', actual: 'manual' },
    ]);
    expect(watch.last()?.gaveUp).toBe(true);
    // Left alone: no more events, no more re-applications, the drift still said.
    await readings(20);
    expect(events).toHaveLength(4);
    expect(reapplied).toHaveLength(3);
    expect(watch.drift()).toHaveLength(1);
    // Set by hand: the app applies manual focus; the drift is gone, and so are its words.
    applied.set({ ...OPENING, focusMode: 'manual' });
    await readings(1);
    expect(watch.drift()).toEqual([]);
    expect(watch.last()).toBeNull();
  });

  it('counts the re-applications within a sliding minute', async () => {
    // A drift every 26 s: the fourth 78 s after the first, when the minute holds two: set back again.
    for (let k = 0; k < 4; k++) {
      drift({ focusMode: 'manual' });
      await readings(26_000 / WATCH_INTERVAL_MS);
    }
    expect(reapplied).toHaveLength(4);
    expect(events.every((event) => event.reapplied && !event.gaveUp)).toBe(true);
  });

  it('says a drift and leaves it with the setting off, once; on again, it is set back', async () => {
    keep = false;
    drift({ exposureMode: 'manual', focusMode: 'manual' });
    await readings(DRIFT_READINGS);
    expect(events).toEqual([
      {
        drift: [
          { name: 'exposureMode', expected: 'continuous', actual: 'manual' },
          { name: 'focusMode', expected: 'continuous', actual: 'manual' },
        ],
        reapplied: false,
        gaveUp: false,
        keep: false,
      },
    ]);
    expect(reapplied).toEqual([]);
    await readings(10);
    expect(events).toHaveLength(1);
    expect(watch.drift()).toHaveLength(2);
    expect(watch.last()?.keep).toBe(false);
    keep = true;
    await readings(DRIFT_READINGS);
    expect(reapplied).toEqual([{ exposureMode: 'continuous', focusMode: 'continuous' }]);
    expect(events.at(-1)).toMatchObject({ reapplied: true, keep: true });
    await readings(1);
    expect(watch.drift()).toEqual([]);
  });

  it('holds a manual group to its values and the zoom to its own, within the camera’s rounding', async () => {
    applied.set({ ...OPENING, focusMode: 'manual', focusDistance: 0.35, zoom: 2.5 });
    track.drift({ focusMode: 'manual', focusDistance: 0.354, zoom: 2.5 });
    await readings(4);
    expect(events).toEqual([]);
    drift({ focusDistance: 1.2, zoom: 1 });
    await readings(DRIFT_READINGS);
    expect(events[0].drift).toEqual([
      { name: 'focusDistance', expected: 0.35, actual: 1.2 },
      { name: 'zoom', expected: 2.5, actual: 1 },
    ]);
    expect(reapplied).toEqual([{ focusMode: 'manual', focusDistance: 0.35, zoom: 2.5 }]);
    await readings(1);
    expect(watch.drift()).toEqual([]);
  });

  it('says a drift the camera brings back right after it was set back, with the setting turned off meanwhile, as left', async () => {
    drift({ focusMode: 'manual' });
    await readings(DRIFT_READINGS);
    expect(events.map((event) => event.reapplied)).toEqual([true]);
    // The camera undoes it before the next reading, and the setting goes off.
    keep = false;
    drift({ focusMode: 'manual' });
    await readings(1);
    expect(watch.drift()).toHaveLength(1);
    await readings(1);
    expect(events.map((event) => [event.reapplied, event.keep])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(watch.last()).toMatchObject({ reapplied: false, keep: false });
    await readings(5);
    expect(events).toHaveLength(2);
    expect(reapplied).toHaveLength(1);
  });

  it('starts counting again when the app applies something else', async () => {
    drift({ focusMode: 'manual' });
    await readings(1);
    applied.set({ ...OPENING, focusMode: 'manual' });
    await readings(1);
    expect(events).toEqual([]);
    expect(watch.drift()).toEqual([]);
  });

  it('stops: no more readings, nothing said', async () => {
    drift({ focusMode: 'manual' });
    await readings(DRIFT_READINGS);
    expect(watch.drift()).toHaveLength(1);
    watch.stop();
    expect(watch.drift()).toEqual([]);
    expect(watch.last()).toBeNull();
    await readings(5);
    expect(events).toHaveLength(1);
    expect(timers.pending).toBe(0);
  });
});

describe('what the watchdog holds the camera to', () => {
  it('each mode the camera has, the values of a manual group, the zoom; never the torch', () => {
    expect(expectedValues({ ...OPENING, torch: true, exposureTime: 20 }, REAR)).toEqual(OPENING);
    expect(
      expectedValues(
        { exposureMode: 'manual', exposureTime: 20, iso: 400, focusMode: 'continuous', zoom: 2 },
        REAR,
      ),
    ).toEqual({
      exposureMode: 'manual',
      exposureTime: 20,
      iso: 400,
      focusMode: 'continuous',
      zoom: 2,
    });
    const none = controlsOf({}, {});
    expect(expectedValues({ ...OPENING, zoom: 2 }, none)).toEqual({});
  });

  it('takes a mode as it is, a single-shot that holds as manual, and a number within the camera’s rounding', () => {
    expect(agrees('focusMode', 'continuous', 'continuous', REAR)).toBe(true);
    expect(agrees('focusMode', 'continuous', 'manual', REAR)).toBe(false);
    expect(agrees('focusMode', 'single-shot', 'manual', REAR)).toBe(true);
    expect(agrees('focusMode', 'manual', 'single-shot', REAR)).toBe(false);
    // 5% of the value, or a step of the range (0.01 m of focus, 50 K of white balance).
    expect(agrees('focusDistance', 0.35, 0.36, REAR)).toBe(true);
    expect(agrees('focusDistance', 0.35, 0.37, REAR)).toBe(false);
    expect(agrees('colorTemperature', 4500, 4550, REAR)).toBe(true);
    expect(agrees('exposureTime', 20, 20.9, REAR)).toBe(true);
    expect(agrees('exposureTime', 20, 33, REAR)).toBe(false);
    expect(agrees('zoom', 2.5, 'manual', REAR)).toBe(false);
  });
});
