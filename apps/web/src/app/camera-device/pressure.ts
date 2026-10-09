// The phone's pressure (the Compute Pressure API: `PressureObserver`, Chrome 125+, which TypeScript's
// DOM library does not declare), for the camera device's `state` messages (docs/RTC.md §1, T5.1): the
// browser's rating of how hard the device is pressed (`nominal`, `fair`, `serious`, `critical`),
// from its thermals where the browser lists that source, else from its CPU. The web platform has no
// temperature reading; this is the nearest to one. Null where the browser has no observer, no source
// it can observe, or refuses.
import { PRESSURE_STATES, type PressureSource, type PressureState } from '@cubetrace/rtc';

/** The pressure as the state message carries it. */
export interface PressureReading {
  readonly state: PressureState;
  readonly source: PressureSource;
}

/** How often the observer asks the browser for a sample, in ms: the rate of the `state` messages. */
export const PRESSURE_SAMPLE_INTERVAL_MS = 2000;

/** `PressureObserver`, as far as this uses it. */
interface PressureObserverLike {
  observe(source: string, options?: { sampleInterval?: number }): Promise<void>;
  disconnect(): void;
}

/** The `PressureObserver` constructor, as far as this uses it. */
type PressureObserverConstructor = new (
  callback: (records: readonly unknown[]) => void,
) => PressureObserverLike;

/**
 * The sources to observe, the preferred first, from `PressureObserver.knownSources`: `thermals` when
 * the browser lists it (how hot the device runs), then `cpu`; `cpu` alone without a list.
 */
export function pressureSources(known: unknown): PressureSource[] {
  if (!Array.isArray(known)) {
    return ['cpu'];
  }
  const listed: unknown[] = known;
  return (['thermals', 'cpu'] as const).filter((source) => listed.includes(source));
}

/**
 * Calls `next` with the pressure once the browser reports it and at each change of its state,
 * until the returned function is called; `next(null)` once when the browser has no `PressureObserver`
 * (`Observer` is what the page's global holds), lists no source this reads, or refuses each one it
 * lists (`observe` rejects, as for a source the device does not have). `thermals` is observed when
 * the browser lists it, `cpu` otherwise or when `thermals` is refused; a sample every `sampleIntervalMs`.
 */
export function watchPressure(
  Observer: unknown,
  next: (pressure: PressureReading | null) => void,
  sampleIntervalMs = PRESSURE_SAMPLE_INTERVAL_MS,
): () => void {
  if (typeof Observer !== 'function') {
    next(null);
    return () => undefined;
  }
  const sources = pressureSources(Reflect.get(Observer, 'knownSources'));
  /** The watch's state, which the stop changes while an `observe` is awaited. */
  const watch: { stopped: boolean; current: PressureSource | null } = {
    stopped: false,
    // The source being observed (or asked for); null before and after.
    current: null,
  };
  /** The state last given to `next`. */
  let last: PressureState | null = null;
  const onRecords = (records: readonly unknown[]): void => {
    const source = watch.current;
    if (watch.stopped || source === null) {
      return;
    }
    // The newest record of the source observed.
    for (let k = records.length - 1; k >= 0; k--) {
      const record = records[k];
      const state = member(record, 'state');
      if (member(record, 'source') === source && isPressureState(state)) {
        if (state !== last) {
          last = state;
          next({ state, source });
        }
        return;
      }
    }
  };
  let observer: PressureObserverLike;
  try {
    observer = new (Observer as PressureObserverConstructor)(onRecords);
  } catch {
    next(null);
    return () => undefined;
  }
  void (async () => {
    for (const source of sources) {
      watch.current = source;
      try {
        await observer.observe(source, { sampleInterval: sampleIntervalMs });
        return;
      } catch {
        // NotSupportedError: a source the device does not have; NotAllowedError: refused.
        watch.current = null;
        if (watch.stopped) {
          return;
        }
      }
    }
    if (!watch.stopped) {
      next(null);
    }
  })();
  return () => {
    watch.stopped = true;
    watch.current = null;
    try {
      observer.disconnect();
    } catch {
      // Already gone.
    }
  };
}

function isPressureState(value: unknown): value is PressureState {
  return typeof value === 'string' && (PRESSURE_STATES as readonly string[]).includes(value);
}

function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (Reflect.get(value, key) as unknown) : null;
}
