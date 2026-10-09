import { signal } from '@angular/core';
import {
  controlGroupOf,
  controlValuesOf,
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
 * A number the camera reports within this share of the value applied (or within one step of its
 * range, when that is more) is the value applied: cameras round what they are given.
 */
export const VALUE_TOLERANCE = 0.05;

/** What a drift became, once the watchdog saw it. */
export interface DriftEvent {
  readonly drift: readonly ControlDrift[];
  /** The values applied were applied again ("Keep the camera's modes"). */
  readonly reapplied: boolean;
  /** It came back after {@link MAX_REAPPLICATIONS} re-applications within a minute: left alone. */
  readonly gaveUp: boolean;
  /** "Keep the camera's modes" was on. */
  readonly keep: boolean;
}

/** The last drift seen and what became of it, with when, on the watch's clock. */
export interface DriftOutcome extends DriftEvent {
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

/** One control's watch: the readings in a row that disagree, the drift said, its re-applications. */
interface ControlState {
  disagree: number;
  drifting: boolean;
  gaveUp: boolean;
  reapplied: number[];
}

interface Run {
  readonly track: WatchedTrack;
  readonly applied: () => ControlValues;
  readonly options: ControlsWatchOptions;
  readonly states: Map<ControlName, ControlState>;
  appliedKey: string;
  timer: unknown;
}

/**
 * The camera's modes held to what the app applied (docs/PLAN.md T5.2): on 2026-10-09 the Moto g60's
 * focus went from `continuous` to `manual` by itself at solve 31, and twenty solves were blurred
 * before it was seen. Every {@link WATCH_INTERVAL_MS} while the camera is on and no slider is being
 * moved (`paused`), the track's `getSettings()` against `applied` (`expectedValues`: each mode the
 * camera has, and the values a manual group holds, and the zoom); a difference that holds for
 * {@link DRIFT_READINGS} readings is a drift (`drift`, `onDrift`). With "Keep the camera's modes"
 * (`keep`) the group's values are applied again, once per drift, and counted; a drift that comes
 * back after {@link MAX_REAPPLICATIONS} re-applications within {@link REAPPLY_WINDOW_MS} is left
 * alone (`gaveUp`) until the camera agrees again or the app applies something else. Without it, the
 * drift is said and left. The torch is never held: it is a light for the moment. Plain TypeScript
 * but for its signals: the tests drive it with a fake clock and a fake track.
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

  /** Watches `track` from now on, against `applied` (read at each reading); stops a watch before. */
  start(track: WatchedTrack, applied: () => ControlValues, options: ControlsWatchOptions): void {
    this.stop();
    const run: Run = {
      track,
      applied,
      options,
      states: new Map(),
      appliedKey: JSON.stringify(applied()),
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
    const applied = run.applied();
    const appliedKey = JSON.stringify(applied);
    if (appliedKey !== run.appliedKey) {
      // The app applied something else: what was counted was against the values before.
      run.appliedKey = appliedKey;
      run.states.clear();
    }
    let settings: ControlValues;
    try {
      settings = controlValuesOf(run.track.getSettings());
    } catch {
      return; // A track that cannot say (ending): the next reading will.
    }
    const now = options.timers.now();
    const keep = options.keep();
    const outcomes = new Map<'reapplied' | 'gave-up' | 'left', ControlDrift[]>();
    const current: ControlDrift[] = [];
    for (const [name, expected] of expectedEntries(applied, controls)) {
      const actual = settings[name];
      let state = run.states.get(name);
      if (actual === undefined || agrees(name, expected, actual, controls)) {
        if (state !== undefined) {
          state.disagree = 0;
          state.drifting = false;
          state.gaveUp = false;
        }
        continue;
      }
      if (state === undefined) {
        state = { disagree: 0, drifting: false, gaveUp: false, reapplied: [] };
        run.states.set(name, state);
      }
      const drift: ControlDrift = { name, expected, actual };
      state.disagree++;
      if (state.disagree >= DRIFT_READINGS) {
        state.disagree = 0;
        const outcome = decide(state, now, keep);
        if (outcome !== null) {
          outcomes.set(outcome, [...(outcomes.get(outcome) ?? []), drift]);
        }
      }
      if (state.drifting) {
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
    for (const [outcome, drift] of outcomes) {
      const event: DriftEvent = {
        drift,
        reapplied: outcome === 'reapplied',
        gaveUp: outcome === 'gave-up',
        keep,
      };
      this.lastSignal.set({ ...event, atMs: now });
      if (event.reapplied) {
        void options.reapply(groupValues(applied, drift)).catch(() => undefined);
      }
      options.onDrift(event);
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

/** What a control's drift becomes: set back, given up, said and left, or nothing new (null). */
function decide(
  state: ControlState,
  now: number,
  keep: boolean,
): 'reapplied' | 'gave-up' | 'left' | null {
  if (!keep) {
    if (state.drifting) {
      return null;
    }
    state.drifting = true;
    return 'left';
  }
  if (state.gaveUp) {
    return null;
  }
  state.drifting = true;
  state.reapplied = state.reapplied.filter((at) => now - at < REAPPLY_WINDOW_MS);
  if (state.reapplied.length >= MAX_REAPPLICATIONS) {
    state.gaveUp = true;
    return 'gave-up';
  }
  state.reapplied.push(now);
  return 'reapplied';
}

const MODE_NAMES: readonly ModeControl[] = ['exposureMode', 'focusMode', 'whiteBalanceMode'];

/**
 * What the watchdog holds the camera to, from `applied`: the mode of each group the camera has, the
 * values a group in manual holds (an exposure time, a focus distance, a colour temperature), and the
 * zoom; never the torch.
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
    if (
      value !== undefined &&
      mode !== null &&
      applied[mode] === 'manual' &&
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
 * Whether the camera's `actual` value of `name` is the `expected` one: a mode the same (a single-shot
 * that has done its adjustment may say manual, which holds it), a number within
 * {@link VALUE_TOLERANCE} of it or a step of its range.
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
  if (expected === 'single-shot' && actual === 'manual') {
    return true;
  }
  return actual === expected;
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
