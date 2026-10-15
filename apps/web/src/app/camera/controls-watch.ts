import { signal } from '@angular/core';
import {
  CONTROL_NAMES,
  controlGroupOf,
  controlValuesOf,
  isAutomaticMode,
  modeControlOf,
  modesOf,
  type CameraControls,
  type ControlDrift,
  type ControlName,
  type ControlRange,
  type ControlValue,
  type ControlValues,
  type ModeControl,
} from '@cubetrace/capture';

/** How often the watchdog reads the track's settings, ms. */
export const WATCH_INTERVAL_MS = 2000;

/** A difference is a drift once this many readings in a row show it (one may catch a change on its way). */
export const DRIFT_READINGS = 2;

/** The window in which re-applications of a control are counted, ms. */
export const REAPPLY_WINDOW_MS = 60_000;

/** A drift that comes back after this many re-applications within the window is left alone. */
export const MAX_REAPPLICATIONS = 3;

/**
 * A number the camera reports within this share of the value expected (or within one step of its
 * range, when that is more) is that value: cameras round what they are given.
 */
export const VALUE_TOLERANCE = 0.05;

/**
 * How a control's expected value was taken (T5.2a): `reading`, the camera's own reading of it once
 * the app applied its group, confirmed by the next reading; `applied`, the value in the app's record
 * (`applied`) for a group the app applied nothing to since the camera opened: the mode it opened in.
 */
export type DriftBaseline = 'reading' | 'applied';

/** What became of a drift, once the watchdog saw it. */
export interface DriftSaid {
  readonly drift: readonly ControlDrift[];
  /** The values applied were applied again ("Keep the camera's modes"). */
  readonly reapplied: boolean;
  /** It came back after {@link MAX_REAPPLICATIONS} re-applications within a minute: left alone. */
  readonly gaveUp: boolean;
  /** "Keep the camera's modes" was on. */
  readonly keep: boolean;
}

/**
 * A drift seen, for the diagnostics (`controls.drift`): what became of it, and how the expected
 * values of its controls were taken (T5.2a), one baseline per event.
 */
export interface DriftEvent extends DriftSaid {
  readonly baseline: DriftBaseline;
}

/** The last drift seen and what became of it, with when, on the watch's clock. */
export interface DriftOutcome extends DriftSaid {
  readonly atMs: number;
}

/** The clock and the timers the watch reads every {@link WATCH_INTERVAL_MS}. */
export interface WatchTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The part of a camera's track the watch reads. */
export interface WatchedTrack {
  getSettings(): object;
}

export interface ControlsWatchOptions {
  /** The camera's controls: which modes it has, and its ranges. */
  readonly controls: () => CameraControls | null;
  /** "Keep the camera's modes" (Settings → Camera): a drift is undone, not only said. */
  readonly keep: () => boolean;
  /** A slider being moved, or a change in flight: the readings wait. */
  readonly paused: () => boolean;
  /** Applies `values` again (the values applied of the drifted controls' groups). */
  readonly reapply: (values: ControlValues) => Promise<void>;
  /** A drift seen, and what became of it: for the diagnostics and the device's words. */
  readonly onDrift: (event: DriftEvent) => void;
  readonly timers: WatchTimers;
  readonly intervalMs?: number;
}

/** What became of a drift: set back, given up, or said and left (the setting off). */
type Outcome = 'reapplied' | 'gave-up' | 'left';

/**
 * What a control is held to (T5.2a), for the values applied to its group (`key`): the value applied
 * (`applied`), or the camera's reading of it (`reading`), taken after the apply and held to once the
 * next reading agrees with it (`confirmed`); `value` is null until a reading says it.
 */
interface Expected {
  readonly key: string;
  readonly baseline: DriftBaseline;
  value: ControlValue | null;
  confirmed: boolean;
}

/**
 * One control's watch: what it is held to (null before its first reading), the readings in a row
 * that disagree with it, what was said of its drift (null while it has none: a drift is listed from
 * what is said of it until a reading agrees), its re-applications.
 */
interface ControlState {
  expected: Expected | null;
  disagree: number;
  said: Outcome | null;
  reapplied: number[];
}

interface Run {
  readonly track: WatchedTrack;
  readonly applied: () => ControlValues;
  readonly options: ControlsWatchOptions;
  readonly states: Map<ControlName, ControlState>;
  /** Each control's group's values applied as the camera opened (`groupKey`). */
  readonly opening: ReadonlyMap<ControlName, string>;
  timer: unknown;
}

/** A drift seen at a reading, with how its expected value was taken. */
interface Seen {
  readonly drift: ControlDrift;
  readonly baseline: DriftBaseline;
}

/** The baselines in the order their events go out when one reading has both. */
const BASELINES: readonly DriftBaseline[] = ['reading', 'applied'];

/**
 * The camera's modes held to what the app applied (docs/PLAN.md T5.2): on 2026-10-09 the Moto g60's
 * focus went from `continuous` to `manual` by itself at solve 31, and twenty solves were blurred
 * before it was seen. Every {@link WATCH_INTERVAL_MS} while the camera is on and no slider is being
 * moved (`paused`), the track's `getSettings()`: each mode the camera has, the values a manual group
 * holds, and the zoom (`expectedValues`: which controls are held, never the torch). Since T5.2a each
 * is held to the camera's own reading of it, not to the value applied: the Moto g60 reports a manual
 * exposure as `none` and a focus distance of 0.12 m as 8.33 (its reciprocal), and the watchdog of
 * T5.2 called both a drift after every change from the MacBook (37 false drifts, 4 given up, from
 * 2026-10-10 to 10-12). After the app applies a group (`applied`: the device's panel, a
 * `set-controls`, the controls kept for the camera as it opened; or a change of `applied` found at a
 * reading), the camera's reading of its controls is taken and held to once the next reading agrees;
 * until then they are not judged. A group the app applied nothing to since the camera opened is held
 * to the mode it opened in. A mode drifts when it changes in kind (automatic, `continuous` or
 * `single-shot`, against `manual` or `none`); a number when it moves from the reading by more than
 * {@link VALUE_TOLERANCE} or a step. A difference that holds for {@link DRIFT_READINGS} readings is
 * a drift (`drift`, `onDrift`, an event per outcome and baseline). With "Keep the camera's modes"
 * (`keep`) the group's values applied are applied again, once per drift, and counted (a
 * re-application takes no new reading: it applies the values the reading was taken for, and a
 * reading after it could be the drift come straight back, or a re-application the camera refused);
 * a drift that comes back after {@link MAX_REAPPLICATIONS} re-applications within
 * {@link REAPPLY_WINDOW_MS} is left alone (`gaveUp`) until the camera agrees again or the app applies
 * something else. Without it, the drift is said and left. The torch is never held: it is a light for
 * the moment. Plain TypeScript but for its signals: the tests drive it with a fake clock and a fake
 * track.
 */
export class ControlsWatch {
  private readonly driftSignal = signal<readonly ControlDrift[]>([]);
  private readonly lastSignal = signal<DriftOutcome | null>(null);
  private run: Run | null = null;

  /** The controls the camera changed by itself and that still differ; empty when none. */
  readonly drift = this.driftSignal.asReadonly();
  /**
   * The last drift seen and what became of it, for the device's words: kept a minute when it was set
   * back, as long as it stands otherwise; null when there is none to say.
   */
  readonly last = this.lastSignal.asReadonly();

  /**
   * Watches `track` from now on, against `applied` (read at each reading: what it holds as the camera
   * opens is what the camera opened with); stops a watch before.
   */
  start(track: WatchedTrack, applied: () => ControlValues, options: ControlsWatchOptions): void {
    this.stop();
    const opening = applied();
    const run: Run = {
      track,
      applied,
      options,
      states: new Map(),
      opening: new Map(CONTROL_NAMES.map((name) => [name, groupKey(opening, name)])),
      timer: null,
    };
    this.run = run;
    this.schedule(run);
  }

  /** Stops watching, and forgets what was seen. */
  stop(): void {
    const run = this.run;
    this.run = null;
    if (run !== null && run.timer !== null) {
      run.options.timers.clearTimeout(run.timer);
    }
    this.driftSignal.set([]);
    this.lastSignal.set(null);
  }

  /**
   * The app applied the controls `names` (and their groups) to the camera, and the apply has resolved
   * (T5.2a: the device's panel, a `set-controls`, the controls kept for the camera as it opened): what
   * the camera reads of the group's controls now is what they are held to, once the next reading
   * agrees with it (a value the camera renders otherwise, rounded, in another unit, a mode under
   * another name, is thereby what is expected); until then they are not judged, and what was counted
   * of them before is forgotten. The watchdog's own re-applications are not said here (see the class).
   */
  applied(names: Iterable<ControlName>): void {
    const run = this.run;
    const controls = run?.options.controls() ?? null;
    if (run === null || controls === null) {
      return;
    }
    let settings: ControlValues;
    try {
      settings = controlValuesOf(run.track.getSettings());
    } catch {
      settings = {}; // A track that cannot say now: the next reading will.
    }
    const groups = new Set([...names].flatMap((name) => controlGroupOf(name)));
    const applied = run.applied();
    for (const [name] of expectedEntries(applied, controls)) {
      if (groups.has(name)) {
        restart(stateOf(run, name), {
          key: groupKey(applied, name),
          baseline: 'reading',
          value: settings[name] ?? null,
          confirmed: false,
        });
      }
    }
  }

  /** One reading now: the timer's, every {@link WATCH_INTERVAL_MS}. */
  read(): void {
    const run = this.run;
    if (run === null) {
      return;
    }
    const { options } = run;
    if (options.paused()) {
      // A reading skipped breaks the readings in a row: a value on its way is no drift.
      for (const state of run.states.values()) {
        state.disagree = 0;
      }
      return;
    }
    const controls = options.controls();
    if (controls === null) {
      return;
    }
    let settings: ControlValues;
    try {
      settings = controlValuesOf(run.track.getSettings());
    } catch {
      return; // A track that cannot say (ending): the next reading will.
    }
    const applied = run.applied();
    const now = options.timers.now();
    const keep = options.keep();
    const outcomes = new Map<Outcome, Seen[]>();
    const current: ControlDrift[] = [];
    for (const [name, value] of expectedEntries(applied, controls)) {
      const state = stateOf(run, name);
      const key = groupKey(applied, name);
      let expected = state.expected;
      if (expected?.key !== key) {
        // Applied otherwise since, and not said (or the first reading): what was counted was against
        // the values before. A group as the camera opened is held to them; another, to its reading.
        expected =
          run.opening.get(name) === key
            ? { key, baseline: 'applied', value, confirmed: true }
            : { key, baseline: 'reading', value: null, confirmed: false };
        restart(state, expected);
      }
      const actual = settings[name];
      if (actual === undefined) {
        // The camera does not say: nothing to hold it to.
        state.disagree = 0;
        state.said = null;
        continue;
      }
      if (expected.value === null || !expected.confirmed) {
        // The camera's reading of what was applied: held to once two readings in a row agree.
        if (expected.value !== null && agrees(name, expected.value, actual, controls)) {
          expected.confirmed = true;
        } else {
          expected.value = actual;
        }
        continue;
      }
      if (agrees(name, expected.value, actual, controls)) {
        state.disagree = 0;
        state.said = null;
        continue;
      }
      const drift: ControlDrift = { name, expected: expected.value, actual };
      state.disagree++;
      if (state.disagree >= DRIFT_READINGS) {
        state.disagree = 0;
        const outcome = decide(state, now, keep);
        if (outcome !== null) {
          outcomes.set(outcome, [
            ...(outcomes.get(outcome) ?? []),
            { drift, baseline: expected.baseline },
          ]);
        }
      }
      if (state.said !== null) {
        current.push(drift);
      }
    }
    if (JSON.stringify(current) !== JSON.stringify(this.driftSignal())) {
      this.driftSignal.set(current);
    }
    const last = this.lastSignal();
    if (
      current.length === 0 &&
      last !== null &&
      (!last.reapplied || now - last.atMs >= REAPPLY_WINDOW_MS)
    ) {
      // Gone: a drift left or given up is no longer there, one set back was said for a minute.
      this.lastSignal.set(null);
    }
    for (const [outcome, seen] of outcomes) {
      const said: DriftSaid = {
        drift: seen.map((entry) => entry.drift),
        reapplied: outcome === 'reapplied',
        gaveUp: outcome === 'gave-up',
        keep,
      };
      this.lastSignal.set({ ...said, atMs: now });
      if (said.reapplied) {
        void options.reapply(groupValues(applied, said.drift)).catch(() => undefined);
      }
      for (const baseline of BASELINES) {
        const drift = seen.filter((entry) => entry.baseline === baseline).map((e) => e.drift);
        if (drift.length > 0) {
          options.onDrift({ ...said, drift, baseline });
        }
      }
    }
  }

  private schedule(run: Run): void {
    run.timer = run.options.timers.setTimeout(() => {
      if (this.run !== run) {
        return;
      }
      this.read();
      if (this.run === run) {
        this.schedule(run);
      }
    }, run.options.intervalMs ?? WATCH_INTERVAL_MS);
  }
}

/** The watch of `name` in `run`, a new one the first time. */
function stateOf(run: Run, name: ControlName): ControlState {
  let state = run.states.get(name);
  if (state === undefined) {
    state = { expected: null, disagree: 0, said: null, reapplied: [] };
    run.states.set(name, state);
  }
  return state;
}

/** `state` held to `expected` from now on, with nothing counted or said of it before. */
function restart(state: ControlState, expected: Expected): void {
  state.expected = expected;
  state.disagree = 0;
  state.said = null;
  state.reapplied = [];
}

/** The values applied to `name`'s group, as a key: what the control is held to is taken for them. */
function groupKey(applied: ControlValues, name: ControlName): string {
  return JSON.stringify(controlGroupOf(name).map((member) => applied[member] ?? null));
}

/**
 * What a control's drift, seen again, becomes: set back (once more), given up, said and left, or
 * nothing new (null: it was said so already). Without the setting it is left, said once (also after a
 * re-application the camera undid before a reading agreed); with it, set back until a fourth time
 * within the minute, which gives it up, said once.
 */
function decide(state: ControlState, now: number, keep: boolean): Outcome | null {
  if (!keep) {
    if (state.said === 'left') {
      return null;
    }
    state.said = 'left';
    return 'left';
  }
  if (state.said === 'gave-up') {
    return null;
  }
  state.reapplied = state.reapplied.filter((at) => now - at < REAPPLY_WINDOW_MS);
  if (state.reapplied.length >= MAX_REAPPLICATIONS) {
    state.said = 'gave-up';
    return 'gave-up';
  }
  state.reapplied.push(now);
  state.said = 'reapplied';
  return 'reapplied';
}

const MODE_NAMES: readonly ModeControl[] = ['exposureMode', 'focusMode', 'whiteBalanceMode'];

/**
 * Which controls the watchdog holds the camera to, with the values applied (`applied`): the mode of
 * each group the camera has, the values a group that is not automatic holds (an exposure time, a
 * focus distance, a colour temperature: in `manual`, or `none`), and the zoom; never the torch. What
 * each is held to is the camera's reading of it once the app applied its group (T5.2a), or the value
 * here for a group the app applied nothing to since the camera opened (the mode it opened in).
 */
export function expectedValues(applied: ControlValues, controls: CameraControls): ControlValues {
  const expected: Partial<Record<ControlName, ControlValue>> = {};
  for (const mode of MODE_NAMES) {
    const value = applied[mode];
    if (value !== undefined && modesOf(controls, mode).length > 0) {
      expected[mode] = value;
    }
  }
  for (const name of ['exposureTime', 'iso', 'focusDistance', 'colorTemperature'] as const) {
    const mode = modeControlOf(name);
    const value = applied[name];
    const groupMode = mode === null ? undefined : applied[mode];
    if (
      value !== undefined &&
      groupMode !== undefined &&
      !isAutomaticMode(groupMode) &&
      rangeOf(controls, name) !== null
    ) {
      expected[name] = value;
    }
  }
  if (applied.zoom !== undefined && controls.zoom !== null) {
    expected.zoom = applied.zoom;
  }
  return expected as ControlValues;
}

function expectedEntries(
  applied: ControlValues,
  controls: CameraControls,
): [ControlName, ControlValue][] {
  return Object.entries(expectedValues(applied, controls)) as [ControlName, ControlValue][];
}

/**
 * Whether the camera's `actual` value of `name` is the `expected` one (T5.2a): a mode of the same
 * kind (automatic, `continuous` or `single-shot`, or not, `manual` or `none`: Chrome for Android
 * reports a manual exposure as `none`), and an expected single-shot whatever mode follows it (one that
 * has done its adjustment may say manual); a number within {@link VALUE_TOLERANCE} of it or a step of
 * its range.
 */
export function agrees(
  name: ControlName,
  expected: ControlValue,
  actual: ControlValue,
  controls: CameraControls,
): boolean {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') {
      return false;
    }
    const step = rangeOf(controls, name)?.step ?? 0;
    const tolerance = Math.max(step, Math.abs(expected) * VALUE_TOLERANCE, 1e-9);
    return Math.abs(actual - expected) <= tolerance;
  }
  if (typeof expected === 'boolean' || typeof actual !== 'string') {
    return actual === expected;
  }
  if (expected === 'single-shot') {
    return true;
  }
  return isAutomaticMode(expected) === isAutomaticMode(actual);
}

/** The values applied of the groups of the drifted controls, to apply again. */
function groupValues(applied: ControlValues, drift: readonly ControlDrift[]): ControlValues {
  const values: Partial<Record<ControlName, ControlValue>> = {};
  for (const { name } of drift) {
    for (const member of controlGroupOf(name)) {
      const value = applied[member];
      if (value !== undefined && member !== 'torch') {
        values[member] = value;
      }
    }
  }
  return values as ControlValues;
}

function rangeOf(controls: CameraControls, name: ControlName): ControlRange | null {
  switch (name) {
    case 'exposureTime':
      return controls.exposureTime;
    case 'iso':
      return controls.iso;
    case 'focusDistance':
      return controls.focusDistance;
    case 'colorTemperature':
      return controls.colorTemperature;
    case 'zoom':
      return controls.zoom;
    default:
      return null;
  }
}
