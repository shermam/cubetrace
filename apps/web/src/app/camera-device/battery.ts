// The phone's battery (the Battery Status API, `navigator.getBattery()`, which TypeScript's DOM
// library does not declare), for the camera device's `state` messages (docs/RTC.md §1): its level and
// whether it charges, as they change; null where the browser does not say.

/** The battery as the state message carries it. */
export interface BatteryState {
  /** 0 to 1. */
  readonly level: number;
  readonly charging: boolean;
}

/** `BatteryManager`, as far as this reads it. */
interface BatteryLike {
  readonly level: number;
  readonly charging: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Calls `next` with the battery once known and at each change of its level or charging, until the
 * returned function is called; `next(null)` once when the browser has no battery API, or refuses.
 */
export function watchBattery(
  navigator: Partial<Navigator> | undefined,
  next: (battery: BatteryState | null) => void,
): () => void {
  const getBattery: unknown =
    typeof navigator === 'object' ? Reflect.get(navigator, 'getBattery') : undefined;
  if (typeof getBattery !== 'function') {
    next(null);
    return () => undefined;
  }
  let stopped = false;
  let off: (() => void) | null = null;
  const asked: unknown = (getBattery as () => unknown).call(navigator);
  Promise.resolve(asked).then(
    (manager: unknown) => {
      if (stopped || !isBattery(manager)) {
        if (!stopped) {
          next(null);
        }
        return;
      }
      const report = (): void => {
        next({ level: manager.level, charging: manager.charging });
      };
      manager.addEventListener('levelchange', report);
      manager.addEventListener('chargingchange', report);
      off = () => {
        manager.removeEventListener('levelchange', report);
        manager.removeEventListener('chargingchange', report);
      };
      report();
    },
    () => {
      if (!stopped) {
        next(null);
      }
    },
  );
  return () => {
    stopped = true;
    off?.();
  };
}

function isBattery(value: unknown): value is BatteryLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'level') === 'number' &&
    typeof Reflect.get(value, 'charging') === 'boolean' &&
    typeof Reflect.get(value, 'addEventListener') === 'function'
  );
}
