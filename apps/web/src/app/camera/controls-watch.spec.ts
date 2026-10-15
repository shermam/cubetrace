import { signal, type WritableSignal } from '@angular/core';
import {
  applyControls,
  controlsOf,
  type CameraControls,
  type ControlName,
  type ControlValues,
} from '@cubetrace/capture';

import {
  FAKE_PHONE_REAR,
  FakePerformance,
  FakeTimers,
  FakeVideoTrack,
} from '../device/fake-browser';
import { outcomeSentences } from './controls-source';
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

  /**
   * The app applies `values` as `CameraService.setControl` does: its record (`applied`, never the
   * torch), the camera, then the watch told, which takes the camera's reading of their groups.
   */
  async function apply(values: ControlValues): Promise<void> {
    const kept: Record<string, unknown> = { ...applied(), ...values };
    delete kept['torch'];
    applied.set(kept);
    await applyControls(track, values);
    watch.applied(Object.keys(values) as ControlName[]);
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
    // Held to the mode it opened in: nothing was applied to the focus since.
    expect(events).toEqual([
      { drift: [focus], reapplied: true, gaveUp: false, keep: true, baseline: 'applied' },
    ]);
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
        baseline: 'applied',
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

  it('holds a manual group’s values and the zoom to the camera’s reading of them, also of a change of what was applied it was not told of', async () => {
    // Applied without a word to the watch (T5.2a: the reading is taken at the next one instead).
    applied.set({ ...OPENING, focusMode: 'manual', focusDistance: 0.35, zoom: 2.5 });
    track.drift({ focusMode: 'manual', focusDistance: 0.354, zoom: 2.5 });
    await readings(4);
    expect(events).toEqual([]);
    drift({ focusDistance: 1.2, zoom: 1 });
    await readings(DRIFT_READINGS);
    // Held to what the camera read of them (0.354, its rounding), set back with what was applied.
    expect(events[0]).toMatchObject({ reapplied: true, baseline: 'reading' });
    expect(events[0].drift).toEqual([
      { name: 'focusDistance', expected: 0.354, actual: 1.2 },
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

  describe('against the camera’s own readings (T5.2a)', () => {
    it('holds a manual exposure the camera reports as none to its kind: no drift, then one when it turns automatic', async () => {
      // The Moto g60's and the ThinkPhone's: Chrome for Android says none (the automatic exposure off).
      track.quirks = { manualReadsNone: true };
      await apply({ exposureMode: 'manual', exposureTime: 100 });
      expect(setting('exposureMode')).toBe('none');
      await readings(10);
      expect(events).toEqual([]);
      expect(watch.drift()).toEqual([]);
      // The camera's automatic exposure back on by itself: a drift, set back with what was applied.
      drift({ exposureMode: 'continuous' });
      await readings(DRIFT_READINGS);
      expect(events).toEqual([
        {
          drift: [{ name: 'exposureMode', expected: 'none', actual: 'continuous' }],
          reapplied: true,
          gaveUp: false,
          keep: true,
          baseline: 'reading',
        },
      ]);
      expect(reapplied).toEqual([{ exposureMode: 'manual', exposureTime: 100 }]);
      expect(setting('exposureMode')).toBe('none');
      await readings(5);
      expect(watch.drift()).toEqual([]);
      expect(events).toHaveLength(1);
    });

    it('holds a focus distance the camera reports as its reciprocal to that reading: no drift, then one when it moves', async () => {
      // The Moto g60's rear camera: 0.12 m applied, 8.33 read (metres against dioptres).
      track.quirks = { reciprocalFocus: true };
      await apply({ focusMode: 'manual', focusDistance: 0.12 });
      expect(setting('focusDistance')).toBeCloseTo(8.33, 2);
      await readings(10);
      expect(events).toEqual([]);
      drift({ focusDistance: 2 });
      await readings(DRIFT_READINGS);
      expect(events).toEqual([
        {
          drift: [{ name: 'focusDistance', expected: 1 / 0.12, actual: 2 }],
          reapplied: true,
          gaveUp: false,
          keep: true,
          baseline: 'reading',
        },
      ]);
      // Set back with the distance applied, which the camera reads as before.
      expect(reapplied).toEqual([{ focusMode: 'manual', focusDistance: 0.12 }]);
      expect(outcomeSentences(events[0])).toEqual([
        'The camera set the focus distance to 2.00 by itself: set back to 8.33.',
      ]);
      await readings(5);
      expect(watch.drift()).toEqual([]);
      expect(events).toHaveLength(1);
    });

    it('sets back the groups the torch reset, and never holds the torch', async () => {
      // The Moto g60 on 2026-10-11: the torch put the focus and the white balance back to automatic.
      track.quirks = { torchResets: true };
      await apply({ focusMode: 'manual', focusDistance: 0.35 });
      await apply({ whiteBalanceMode: 'manual', colorTemperature: 4500 });
      await readings(3);
      expect(events).toEqual([]);
      await apply({ torch: true });
      expect(setting('focusMode')).toBe('continuous');
      await readings(DRIFT_READINGS);
      expect(events).toEqual([
        {
          drift: [
            { name: 'focusMode', expected: 'manual', actual: 'continuous' },
            { name: 'whiteBalanceMode', expected: 'manual', actual: 'continuous' },
            { name: 'focusDistance', expected: 0.35, actual: 0.1 },
            { name: 'colorTemperature', expected: 4500, actual: 0 },
          ],
          reapplied: true,
          gaveUp: false,
          keep: true,
          baseline: 'reading',
        },
      ]);
      expect(reapplied).toEqual([
        {
          focusMode: 'manual',
          focusDistance: 0.35,
          whiteBalanceMode: 'manual',
          colorTemperature: 4500,
        },
      ]);
      expect(setting('torch')).toBe(true);
      await readings(10);
      expect(watch.drift()).toEqual([]);
      expect(events).toHaveLength(1);
    });

    it('still calls a focus gone manual by itself a drift after two readings, from the mode it opened in or from the reading of the one applied', async () => {
      // A camera with all of the Moto g60's quirks: the focus of 2026-10-09 is still caught.
      track.quirks = { manualReadsNone: true, reciprocalFocus: true, torchResets: true };
      drift({ focusMode: 'manual' });
      await readings(1);
      expect(events).toEqual([]);
      await readings(1);
      const focus = { name: 'focusMode', expected: 'continuous', actual: 'manual' };
      expect(events).toEqual([
        { drift: [focus], reapplied: true, gaveUp: false, keep: true, baseline: 'applied' },
      ]);
      await readings(1);
      // Continuous applied from the panel: held to the camera's reading of it from then on.
      await apply({ focusMode: 'continuous' });
      await readings(2);
      drift({ focusMode: 'manual' });
      await readings(1);
      expect(events).toHaveLength(1);
      await readings(1);
      expect(events.at(-1)).toEqual({
        drift: [focus],
        reapplied: true,
        gaveUp: false,
        keep: true,
        baseline: 'reading',
      });
    });

    it('judges nothing of a group the app applied until two readings agree: a camera still on its way is no drift', async () => {
      // The reading as the apply resolves still says the focus before it; the next, the one applied.
      applied.set({ ...OPENING, focusMode: 'manual', focusDistance: 2 });
      watch.applied(['focusDistance']);
      await applyControls(track, { focusMode: 'manual', focusDistance: 2 });
      await readings(1);
      expect(watch.drift()).toEqual([]);
      await readings(4);
      expect(events).toEqual([]);
      // Taken from then on: the camera's distance moving is a drift from it.
      drift({ focusDistance: 3 });
      await readings(DRIFT_READINGS);
      expect(events.map((event) => event.drift)).toEqual([
        [{ name: 'focusDistance', expected: 2, actual: 3 }],
      ]);
    });

    it('gives up a drift the camera brings back after each re-application, its readings not taken again by them', async () => {
      track.quirks = { reciprocalFocus: true };
      await apply({ focusMode: 'manual', focusDistance: 0.25 });
      await readings(2);
      for (let k = 0; k <= MAX_REAPPLICATIONS; k++) {
        drift({ focusDistance: 1 });
        await readings(DRIFT_READINGS);
      }
      expect(reapplied).toHaveLength(MAX_REAPPLICATIONS);
      expect(events.map((event) => [event.reapplied, event.gaveUp, event.baseline])).toEqual([
        [true, false, 'reading'],
        [true, false, 'reading'],
        [true, false, 'reading'],
        [false, true, 'reading'],
      ]);
      const last = watch.last();
      expect(last === null ? [] : outcomeSentences(last)).toEqual([
        'The camera keeps setting the focus distance to 1.00: left as it is.',
      ]);
      await readings(10);
      expect(events).toHaveLength(4);
    });

    it('says how the expected values were taken: an event per outcome and baseline, one re-application for them all', async () => {
      await apply({ zoom: 2.5 });
      await readings(2);
      drift({ exposureMode: 'manual', zoom: 1 });
      await readings(DRIFT_READINGS);
      expect(events).toEqual([
        {
          drift: [{ name: 'zoom', expected: 2.5, actual: 1 }],
          reapplied: true,
          gaveUp: false,
          keep: true,
          baseline: 'reading',
        },
        {
          drift: [{ name: 'exposureMode', expected: 'continuous', actual: 'manual' }],
          reapplied: true,
          gaveUp: false,
          keep: true,
          baseline: 'applied',
        },
      ]);
      expect(reapplied).toEqual([{ exposureMode: 'continuous', zoom: 2.5 }]);
      // The device's words say them both.
      expect(watch.last()?.drift).toHaveLength(2);
    });
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
  it('each mode the camera has, the values of a group not automatic, the zoom; never the torch', () => {
    expect(expectedValues({ ...OPENING, torch: true, exposureTime: 20 }, REAR)).toEqual(OPENING);
    // A group in none is not automatic either (T5.2a): it holds its values.
    expect(expectedValues({ exposureMode: 'none', exposureTime: 20 }, REAR)).toEqual({
      exposureMode: 'none',
      exposureTime: 20,
    });
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

  it('takes a mode by its kind (T5.2a): manual and none alike, continuous and single-shot alike', () => {
    expect(agrees('exposureMode', 'manual', 'none', REAR)).toBe(true);
    expect(agrees('exposureMode', 'none', 'manual', REAR)).toBe(true);
    expect(agrees('focusMode', 'continuous', 'single-shot', REAR)).toBe(true);
    expect(agrees('focusMode', 'continuous', 'manual', REAR)).toBe(false);
    expect(agrees('focusMode', 'continuous', 'none', REAR)).toBe(false);
    expect(agrees('exposureMode', 'none', 'continuous', REAR)).toBe(false);
    expect(agrees('focusMode', 'single-shot', 'none', REAR)).toBe(true);
    // The reciprocal of a distance is no rounding of it.
    expect(agrees('focusDistance', 0.12, 8.33, REAR)).toBe(false);
  });
});
