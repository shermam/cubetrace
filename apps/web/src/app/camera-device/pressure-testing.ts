// A fake of the browser's `PressureObserver` (the Compute Pressure API, T5.1) for the unit tests of
// pressure.ts and of the camera device: its sources, the ones it refuses, and the records a test
// delivers. Nothing in the app imports this file, so it is not in the bundle.

/** What a test reads of, and does to, the fake. */
export interface FakePressure {
  /** The constructor, as the page's global `PressureObserver` holds it (BROWSER_GLOBALS). */
  readonly Observer: unknown;
  /** Each `observe` call: the source and the sample interval asked for, refused or not. */
  readonly observed: { source: string; sampleInterval: number | undefined; refused: boolean }[];
  /** How many observers were disconnected. */
  readonly disconnected: () => number;
  /** Delivers a record of `state` from `source` (`thermals` by default) to the observers of it. */
  emit(state: string, source?: string): void;
}

/**
 * A `PressureObserver` whose static `knownSources` is `sources` (none: an implementation without the
 * list), whose `observe` rejects with a `NotSupportedError` for the sources in `refuse`, and whose
 * observers get the records {@link FakePressure.emit} delivers, as the browser's callback does.
 */
export function fakePressure(
  options: { sources?: readonly string[] | null; refuse?: readonly string[] } = {},
): FakePressure {
  const sources = options.sources === undefined ? ['cpu'] : options.sources;
  const refuse = new Set(options.refuse ?? []);
  const observed: FakePressure['observed'] = [];
  const observers = new Set<Observer>();
  let disconnected = 0;

  class Observer {
    readonly watching = new Set<string>();

    constructor(private readonly callback: (records: readonly unknown[]) => void) {
      observers.add(this);
    }

    observe(source: string, options?: { sampleInterval?: number }): Promise<void> {
      const refused = refuse.has(source) || (sources !== null && !sources.includes(source));
      observed.push({ source, sampleInterval: options?.sampleInterval, refused });
      if (refused) {
        return Promise.reject(new DOMException(`No ${source} source.`, 'NotSupportedError'));
      }
      this.watching.add(source);
      return Promise.resolve();
    }

    disconnect(): void {
      this.watching.clear();
      observers.delete(this);
      disconnected++;
    }

    deliver(record: { source: string; state: string; time: number }): void {
      if (this.watching.has(record.source)) {
        this.callback([record]);
      }
    }
  }

  if (sources !== null) {
    Object.defineProperty(Observer, 'knownSources', { value: Object.freeze([...sources]) });
  }
  return {
    Observer,
    observed,
    disconnected: () => disconnected,
    emit: (state, source = 'thermals') => {
      for (const observer of [...observers]) {
        observer.deliver({ source, state, time: Date.now() });
      }
    },
  };
}
