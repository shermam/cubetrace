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

/** `localStorage`: an in-memory store; while `failWith` is set, every write throws it. */
export class FakeLocalStorage implements Storage {
  [name: string]: unknown;
  private readonly items = new Map<string, string>();
  failWith: Error | null = null;

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWith) {
      throw this.failWith;
    }
    this.items.set(key, value);
  }
}

/** `navigator.clipboard`, for text: keeps what was written, or refuses with `refuseWith`. */
export class FakeClipboard extends EventTarget implements Clipboard {
  readonly texts: string[] = [];
  refuseWith: Error | null = null;

  read(): Promise<ClipboardItems> {
    return Promise.reject(new Error('FakeClipboard holds text only.'));
  }

  readText(): Promise<string> {
    return Promise.resolve(this.texts.at(-1) ?? '');
  }

  write(): Promise<void> {
    return Promise.reject(new Error('FakeClipboard holds text only.'));
  }

  writeText(text: string): Promise<void> {
    if (this.refuseWith) {
      return Promise.reject(this.refuseWith);
    }
    this.texts.push(text);
    return Promise.resolve();
  }
}

/**
 * `fetch` over a table of URL → JSON body; any other URL answers 404, and `failWith`, when set,
 * makes every request reject (the network is down). `requests` lists the URLs asked for.
 */
export class FakeFetch {
  readonly requests: string[] = [];
  failWith: Error | null = null;

  constructor(private readonly files: Readonly<Record<string, unknown>>) {}

  readonly fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    this.requests.push(url);
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    if (!(url in this.files)) {
      return Promise.resolve(new Response('Not found', { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(this.files[url]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

/**
 * jsdom's `<dialog>` has no `showModal()` or `close()`. These stand-ins do what the tests need:
 * `showModal()` sets `open`; `close()` removes it and fires `close`, as a browser does after a
 * dialog closes (a browser fires it a task later).
 */
export function polyfillDialog(): void {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement): void {
      if (this.hasAttribute('open')) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      }
    },
  });
}

/** Lets pending promises and timers run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
