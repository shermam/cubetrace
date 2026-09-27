// Fakes of the browser APIs behind the device services, for unit tests (provide them through
// BROWSER_GLOBALS). Nothing in the app imports this file, so it is not in the bundle.

/** A screen wake lock that the fake browser, or the test, can release. */
export class FakeWakeLockSentinel extends EventTarget implements WakeLockSentinel {
  readonly type = 'screen';
  released = false;
  onrelease: WakeLockSentinel['onrelease'] = null;

  release(): Promise<void> {
    if (!this.released) {
      this.released = true;
      this.dispatchEvent(new Event('release'));
    }
    return Promise.resolve();
  }
}

/** `navigator.wakeLock`: grants every request, or refuses with `refuseWith` when it is set. */
export class FakeWakeLock implements WakeLock {
  readonly sentinels: FakeWakeLockSentinel[] = [];
  refuseWith: Error | null = null;

  request(): Promise<WakeLockSentinel> {
    if (this.refuseWith) {
      return Promise.reject(this.refuseWith);
    }
    const sentinel = new FakeWakeLockSentinel();
    this.sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  }

  /** How many locks are held now. */
  held(): number {
    return this.sentinels.filter((sentinel) => !sentinel.released).length;
  }
}

/** `navigator.storage`: `persist()` answers `grant`; `estimate()` reports `usage` and `quota`. */
export class FakeStorageManager implements StorageManager {
  persistent: boolean;
  grant: boolean;
  usage: number;
  quota: number;
  persistCalls = 0;

  constructor(options: { persistent?: boolean; grant?: boolean; usage?: number; quota?: number }) {
    this.persistent = options.persistent ?? false;
    this.grant = options.grant ?? false;
    this.usage = options.usage ?? 0;
    this.quota = options.quota ?? 1e9;
  }

  persisted(): Promise<boolean> {
    return Promise.resolve(this.persistent);
  }

  persist(): Promise<boolean> {
    this.persistCalls++;
    this.persistent ||= this.grant;
    return Promise.resolve(this.persistent);
  }

  estimate(): Promise<StorageEstimate> {
    return Promise.resolve({ usage: this.usage, quota: this.quota });
  }

  getDirectory(): Promise<FileSystemDirectoryHandle> {
    return Promise.reject(new Error('FakeStorageManager has no file system.'));
  }
}

/** Stands in for the `VideoEncoder` constructor, whose presence means WebCodecs is there. */
export class FakeVideoEncoder {
  readonly state = 'unconfigured';
}

/** Lets pending promises and timers run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
