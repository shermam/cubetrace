// Fakes of what the queue works through, for the package's tests and the app's: the functions and
// the bucket (FakeUploadCloud, FakeBucket), the PUTs (FakeUploadHttp), and the device's clock,
// storage and network (FakeUploadEnvironment). They play the functions' rules (functions/README.md):
// a URL per file, bound to its size, for 15 minutes; the attempt must be in the index; a daily quota
// of bytes and files, every signature counted; a confirmation finds the object with the size signed.
// Nothing in the app imports this file, so it is not in the bundle.
import type { CloudUpload } from '@cubetrace/core';

import {
  CloudError,
  type ConfirmRequest,
  type ConfirmResult,
  type SignRequest,
  type SignedFile,
} from './api';
import type { ConnectionInfo } from './network';
import type {
  PutRequest,
  PutResponse,
  StorageEstimate,
  UploadCloud,
  UploadEnvironment,
  UploadHttp,
} from './ports';

/** The bucket: objects by key, as the PUTs left them. */
export class FakeBucket {
  readonly objects = new Map<string, { bytes: number; contentType: string; text: string }>();
}

/** One call of the functions, for the tests to check: `sign <session>/<index> <paths>`, `confirm …`. */
export type FakeCall = string;

/**
 * `signUpload` and `confirmUpload` in memory, with the index's `upload` of each attempt and the
 * account's quota. `indexed` holds the attempts the index has (`<session>/<index>`); by default every
 * attempt is (`indexAll`).
 */
export class FakeUploadCloud implements UploadCloud {
  /** The index's `upload` of each attempt, by `<session>/<index>`. */
  readonly uploads = new Map<string, CloudUpload>();
  /** The calls, in order. */
  readonly calls: FakeCall[] = [];
  /** The attempts in the index; with `indexAll`, every one. */
  readonly indexed = new Set<string>();
  indexAll = true;
  /** The daily quota: bytes and files signed, and the limits; `resetsAtMs` for a refusal. */
  quota = { bytes: 0, files: 0, maxBytes: 2_000_000_000, maxFiles: 400, resetsAtMs: 0 };
  /** Set: each signUpload is refused with it (and taken off once used when `once`). */
  signError: { error: CloudError; once: boolean } | null = null;
  confirmError: { error: CloudError; once: boolean } | null = null;
  /** How many times whenIndexed was asked. */
  waits = 0;
  #signatures = 0;

  constructor(
    readonly bucket: FakeBucket,
    /** The server's clock. */
    readonly now: () => number,
    readonly uid = 'ada-uid',
  ) {}

  whenIndexed(): Promise<void> {
    this.waits++;
    return Promise.resolve();
  }

  /** The object key of `path` of the attempt, as the functions name it. */
  key(sessionId: string, index: number, path: string): string {
    const session = `users/${this.uid}/sessions/${sessionId}`;
    return path === 'session.json'
      ? `${session}/session.json`
      : `${session}/attempts/${String(index).padStart(4, '0')}/${path}`;
  }

  signUpload(request: SignRequest): Promise<SignedFile[]> {
    const id = `${request.sessionId}/${String(request.attemptIndex)}`;
    this.calls.push(`sign ${id} ${request.files.map((file) => file.path).join(',')}`);
    const refusal = this.#take('signError');
    if (refusal !== null) {
      return Promise.reject(refusal);
    }
    if (!this.indexAll && !this.indexed.has(id)) {
      return Promise.reject(new CloudError('not-found', `The attempt ${id} is not in the cloud index.`));
    }
    const bytes = request.files.reduce((sum, file) => sum + file.bytes, 0);
    const { quota } = this;
    if (quota.bytes + bytes > quota.maxBytes || quota.files + request.files.length > quota.maxFiles) {
      return Promise.reject(
        new CloudError('resource-exhausted', "The day's upload quota is used up.", {
          resetsAtMs: quota.resetsAtMs,
        }),
      );
    }
    quota.bytes += bytes;
    quota.files += request.files.length;
    const upload = this.uploads.get(id) ?? { state: 'pending', files: {} };
    upload.state = 'uploading';
    const expiresAt = this.now() + 15 * 60 * 1000;
    const signed = request.files.map((file): SignedFile => {
      upload.files[file.path] = { bytes: file.bytes, doneMs: null };
      const key = this.key(request.sessionId, request.attemptIndex, file.path);
      return {
        path: file.path,
        url: `https://bucket.test/${key}?signature=${String(++this.#signatures)}&bytes=${String(file.bytes)}&expires=${String(expiresAt)}`,
        headers: {
          'Content-Type': file.contentType,
          'x-goog-content-length-range': `${String(file.bytes)},${String(file.bytes)}`,
        },
        expiresAt,
      };
    });
    this.uploads.set(id, upload);
    return Promise.resolve(signed);
  }

  confirmUpload(request: ConfirmRequest): Promise<ConfirmResult> {
    const id = `${request.sessionId}/${String(request.attemptIndex)}`;
    this.calls.push(`confirm ${id} ${request.files.map((file) => file.path).join(',')}`);
    const refusal = this.#take('confirmError');
    if (refusal !== null) {
      return Promise.reject(refusal);
    }
    const upload = this.uploads.get(id);
    const confirmed: { path: string; bytes: number; doneMs: number }[] = [];
    for (const { path } of request.files) {
      const file = upload?.files[path];
      if (upload === undefined || file === undefined) {
        return Promise.reject(new CloudError('failed-precondition', `${path} was not signed.`));
      }
      const object = this.bucket.objects.get(this.key(request.sessionId, request.attemptIndex, path));
      if (object === undefined) {
        return Promise.reject(new CloudError('not-found', `${path} is not in the bucket.`));
      }
      if (object.bytes !== file.bytes) {
        return Promise.reject(
          new CloudError('failed-precondition', `${path} has ${String(object.bytes)} bytes.`),
        );
      }
      file.doneMs ??= this.now();
      confirmed.push({ path, bytes: file.bytes, doneMs: file.doneMs });
    }
    const pending = Object.entries(upload?.files ?? {})
      .filter(([, file]) => file.doneMs === null)
      .map(([path]) => path)
      .sort();
    const state = pending.length === 0 ? 'done' : 'uploading';
    if (upload !== undefined) {
      upload.state = state;
    }
    return Promise.resolve({ state, confirmed, pending });
  }

  uploadsOf(sessionId: string): Promise<ReadonlyMap<number, CloudUpload>> {
    this.calls.push(`uploads ${sessionId}`);
    const found = new Map<number, CloudUpload>();
    for (const [id, upload] of this.uploads) {
      const [session, index] = id.split('/');
      if (session === sessionId) {
        found.set(Number(index), structuredClone(upload));
      }
    }
    return Promise.resolve(found);
  }

  #take(which: 'signError' | 'confirmError'): CloudError | null {
    const set = this[which];
    if (set === null) {
      return null;
    }
    if (set.once) {
      this[which] = null;
    }
    return set.error;
  }
}

/** A PUT as the fake saw it. */
export interface FakePut {
  readonly url: string;
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: number;
  /** Its answer, once given; null while it is held. */
  status: number | null;
}

/**
 * The PUTs into a {@link FakeBucket}: a URL of {@link FakeUploadCloud} with its headers and the size
 * it was signed for, before it expires, is stored (200), anything else refused as the bucket would
 * (400, 403). `respond` answers otherwise (a status, or 0 for a network error) for the next PUTs;
 * `hold` keeps them waiting until `release()`, to see how many go at once.
 */
export class FakeUploadHttp implements UploadHttp {
  readonly puts: FakePut[] = [];
  /** The answers to give the next PUTs, in order, before the bucket's own. */
  readonly responses: { status: number; body?: string }[] = [];
  hold = false;
  /** The PUTs under way now, and the most there were at once. */
  inFlight = 0;
  maxInFlight = 0;
  readonly #held: (() => void)[] = [];

  constructor(
    readonly bucket: FakeBucket,
    readonly now: () => number,
  ) {}

  async put(request: PutRequest): Promise<PutResponse> {
    const url = new URL(request.url);
    const put: FakePut = {
      url: request.url,
      key: url.pathname.slice(1),
      headers: { ...request.headers },
      bytes: request.body.size,
      status: null,
    };
    this.puts.push(put);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      request.progress(Math.floor(request.body.size / 2));
      if (this.hold) {
        await new Promise<void>((resolve, reject) => {
          this.#held.push(resolve);
          request.signal.addEventListener('abort', () => {
            reject(new DOMException('Cut off.', 'AbortError'));
          });
        });
      } else {
        await Promise.resolve();
      }
      if (request.signal.aborted) {
        throw new DOMException('Cut off.', 'AbortError');
      }
      const scripted = this.responses.shift();
      const response =
        scripted === undefined
          ? await this.#store(url, request)
          : { status: scripted.status, body: scripted.body ?? '' };
      put.status = response.status;
      if (response.status >= 200 && response.status < 300) {
        request.progress(request.body.size);
      }
      return response;
    } finally {
      this.inFlight--;
    }
  }

  /** Lets the held PUTs go. */
  release(): void {
    this.hold = false;
    for (const go of this.#held.splice(0)) {
      go();
    }
  }

  /** How many PUTs wait in `hold`. */
  get held(): number {
    return this.#held.length;
  }

  async #store(url: URL, request: PutRequest): Promise<PutResponse> {
    const bytes = Number(url.searchParams.get('bytes'));
    const expires = Number(url.searchParams.get('expires'));
    if (this.now() >= expires) {
      return { status: 400, body: '<Error><Code>ExpiredToken</Code>Request has expired</Error>' };
    }
    const range = request.headers['x-goog-content-length-range'];
    if (request.body.size !== bytes || range !== `${String(bytes)},${String(bytes)}`) {
      return { status: 400, body: 'The upload is not of the size signed.' };
    }
    const contentType = request.headers['Content-Type'];
    this.bucket.objects.set(url.pathname.slice(1), {
      bytes,
      contentType,
      text: await request.body.text(),
    });
    return { status: 200, body: '' };
  }
}

/**
 * The device for the queue: a clock with timers (`advance()` runs those that come due, in order),
 * a fixed jitter, the storage (`usage`, `quota`), the network (`setNetwork()` tells the queue) and,
 * with `withLock`, the upload lock of the page's tabs.
 */
export class FakeUploadEnvironment implements UploadEnvironment {
  #now: number;
  #nextTimer = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  readonly #networkListeners = new Set<() => void>();
  /** The jitter: Math.random's value, fixed. */
  jitter = 0;
  usage = 0;
  quota = 10_000_000_000;
  connection: ConnectionInfo = { online: true };
  /** The holders of the lock: the first holds it, the others wait. */
  readonly #lockQueue: { take: (release: () => void) => void; signal: AbortSignal }[] = [];
  #lockHeld = false;

  constructor(
    startMs = 1_790_000_000_000,
    readonly withLock = false,
  ) {
    this.#now = startMs;
    if (withLock) {
      this.lock = (signal: AbortSignal) =>
        new Promise<() => void>((resolve, reject) => {
          const entry = { take: resolve, signal };
          signal.addEventListener('abort', () => {
            const at = this.#lockQueue.indexOf(entry);
            if (at >= 0) {
              this.#lockQueue.splice(at, 1);
              reject(new DOMException('Cut off.', 'AbortError'));
            }
          });
          this.#lockQueue.push(entry);
          this.#grantLock();
        });
    }
  }

  lock?: (signal: AbortSignal) => Promise<() => void>;

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#nextTimer++;
    this.#timers.set(handle, { at: this.#now + Math.max(0, ms), callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.#timers.delete(handle);
    }
  }

  random(): number {
    return this.jitter;
  }

  storage(): Promise<StorageEstimate | null> {
    return Promise.resolve({ usage: this.usage, quota: this.quota });
  }

  network(): ConnectionInfo {
    return this.connection;
  }

  watchNetwork(listener: () => void): () => void {
    this.#networkListeners.add(listener);
    return () => {
      this.#networkListeners.delete(listener);
    };
  }

  /** The network changes, as `change` on `navigator.connection` and `online` say. */
  setNetwork(connection: ConnectionInfo): void {
    this.connection = connection;
    for (const listener of [...this.#networkListeners]) {
      listener();
    }
  }

  /** How many timers wait, and when the first comes due. */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  /** Moves the clock `ms` forward, running each timer that comes due, at its time. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.#timers) {
        if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (next === null) {
        break;
      }
      this.#timers.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].callback();
    }
    this.#now = end;
  }

  #grantLock(): void {
    if (this.#lockHeld) {
      return;
    }
    const entry = this.#lockQueue.shift();
    if (entry === undefined) {
      return;
    }
    this.#lockHeld = true;
    entry.take(() => {
      this.#lockHeld = false;
      this.#grantLock();
    });
  }
}
