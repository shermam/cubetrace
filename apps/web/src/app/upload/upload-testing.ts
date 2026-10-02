// Fakes of the upload queue for the app's unit tests (T3.3): its views, a queue that records what the
// app asks of it (for UploadService), a runtime that makes it, and a stand-in for UploadService (for
// the pages and the header). Nothing in the app imports this file, so it is not in the bundle.
import { computed, signal } from '@angular/core';
import type { AttemptRecord, SessionRecord } from '@cubetrace/core';
import type { AttemptView, QueueView, UploadPolicy } from '@cubetrace/upload';

import { SESSION_A } from '../session/session-testing';
import type { QueueHandle, UploadDeps, UploadRuntime, UploadsStatus } from './upload-service';

/** A queue's view: nothing to upload, unless `change` says otherwise. */
export function queueView(change: Partial<QueueView> = {}): QueueView {
  return {
    status: 'running',
    pause: null,
    counts: { waiting: 0, pending: 0, uploading: 0, done: 0, failed: 0 },
    bytesLeft: 0,
    active: [],
    recent: [],
    freed: { clips: 0, bytes: 0 },
    error: null,
    ...change,
  };
}

/** Attempt `index` of session A in the queue, pending with its attempt.json alone. */
export function attemptView(index: number, change: Partial<AttemptView> = {}): AttemptView {
  return {
    sessionId: SESSION_A,
    index,
    sessionCreatedMs: 1_790_000_000_000,
    state: 'pending',
    files: [],
    bytes: 1_000_000,
    sent: 0,
    error: null,
    ...change,
  };
}

/** A queue that records what it is asked, and whose view the test sets. */
export class FakeQueue implements QueueHandle {
  readonly calls: string[] = [];
  readonly policies: UploadPolicy[] = [];
  readonly attempts = new Map<string, AttemptView>();
  #view = queueView({ status: 'stopped' });
  readonly #listeners = new Set<() => void>();

  constructor(readonly deps: UploadDeps) {
    this.policies.push(deps.policy);
  }

  /** Sets the view and tells the listeners, as the queue does after each change. */
  set(view: QueueView): void {
    this.#view = view;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  start(): Promise<void> {
    this.calls.push('start');
    this.set({ ...this.#view, status: 'running' });
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push('stop');
    return Promise.resolve();
  }

  flush(): Promise<void> {
    this.calls.push('flush');
    return Promise.resolve();
  }

  setPolicy(policy: UploadPolicy): void {
    this.policies.push(policy);
  }

  sessionSaved(session: SessionRecord): void {
    this.calls.push(`session ${session.id}`);
  }

  attemptSaved(attempt: AttemptRecord): void {
    this.calls.push(`attempt ${attempt.session}/${String(attempt.index)}`);
  }

  attemptDeleted(sessionId: string, index: number): void {
    this.calls.push(`attempt-deleted ${sessionId}/${String(index)}`);
  }

  sessionDeleted(sessionId: string): void {
    this.calls.push(`session-deleted ${sessionId}`);
  }

  refresh(): void {
    this.calls.push('refresh');
  }

  retry(sessionId?: string, index?: number): void {
    this.calls.push(`retry ${sessionId ?? '*'}/${index === undefined ? '*' : String(index)}`);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  view(): QueueView {
    return this.#view;
  }

  attemptView(sessionId: string, index: number): AttemptView | null {
    return this.attempts.get(`${sessionId}/${String(index)}`) ?? null;
  }
}

/** A runtime that makes {@link FakeQueue}s, or fails to load with `loadError`. */
export class FakeUploadRuntime implements UploadRuntime {
  readonly queues: FakeQueue[] = [];
  loads = 0;
  loadError: Error | null = null;
  /** Null: the queue cannot be made (no origin private file system). */
  available = true;

  readonly loader = (): Promise<UploadRuntime> => {
    this.loads++;
    return this.loadError === null ? Promise.resolve(this) : Promise.reject(this.loadError);
  };

  createQueue(deps: UploadDeps): FakeQueue | null {
    if (!this.available) {
      return null;
    }
    const queue = new FakeQueue(deps);
    this.queues.push(queue);
    return queue;
  }

  /** The queue made last. */
  get last(): FakeQueue {
    const queue = this.queues.at(-1);
    if (queue === undefined) {
      throw new Error('No queue was made.');
    }
    return queue;
  }
}

/** A stand-in for UploadService, for the pages and the header: its signals, set by the test. */
export class FakeUploads {
  readonly statusSignal = signal<UploadsStatus>('running');
  readonly viewSignal = signal<QueueView | null>(queueView());
  readonly errorSignal = signal<string | null>(null);
  readonly attempts = new Map<string, AttemptView>();
  readonly retries: string[] = [];

  readonly status = this.statusSignal.asReadonly();
  readonly view = this.viewSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  readonly outstanding = computed(() => {
    const view = this.viewSignal();
    if (view === null) {
      return null;
    }
    const { waiting, pending, uploading, failed } = view.counts;
    const left = waiting + pending + uploading;
    return left === 0 && failed === 0
      ? null
      : { left, failed, uploading: uploading > 0, pause: view.pause, bytesLeft: view.bytesLeft };
  });

  attempt(sessionId: string, index: number): AttemptView | null {
    this.viewSignal();
    return this.attempts.get(`${sessionId}/${String(index)}`) ?? null;
  }

  retry(sessionId?: string, index?: number): void {
    this.retries.push(`${sessionId ?? '*'}/${index === undefined ? '*' : String(index)}`);
  }
}
