import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { SessionStore } from '@cubetrace/core';
// Types only: the queue's code is the lazy chunk's (upload-runtime.ts).
import type {
  AttemptRef,
  AttemptView,
  QueueView,
  UploadPolicy,
  UploadQueue,
} from '@cubetrace/upload';

import type { AccountBackend } from '../auth/account-backend';
import { AuthService, type CloudAccount } from '../auth/auth-service';
import { SessionIndexService } from '../cloud/session-index';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { StorageService } from '../device/storage-service';
import { ClipsInFlight } from '../session/clips-in-flight';
import { SessionChanges, type SessionChange } from '../session/session-changes';
import { SessionService } from '../session/session-service';
import { SESSION_STORAGE } from '../session/session-storage';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';

/** What of the upload queue the app uses. */
export type QueueHandle = Pick<
  UploadQueue,
  | 'start'
  | 'stop'
  | 'setPolicy'
  | 'sessionSaved'
  | 'attemptSaved'
  | 'attemptDeleted'
  | 'sessionDeleted'
  | 'refresh'
  | 'retry'
  | 'onChange'
  | 'view'
  | 'attemptView'
>;

/** What a queue is made of: the account, and the app's pieces its ports are made of. */
export interface UploadDeps {
  readonly uid: string;
  readonly backend: AccountBackend;
  readonly policy: UploadPolicy;
  readonly globals: BrowserGlobals;
  /** The app's session store over the origin private file system. */
  readonly store: SessionStore;
  /** `SessionService.markClipsGone`: an attempt's clips marked as gone in its record. */
  readonly markClipsGone: (ref: AttemptRef, files: readonly string[]) => Promise<boolean>;
  /** Whether attempt `index` of session `sessionId` has no clip still to come. */
  readonly settled: (sessionId: string, index: number) => boolean;
  /** Resolves once the session index has handed its writes so far to Firestore. */
  readonly indexIdle: () => Promise<void>;
}

/**
 * The queue's code, from its lazy chunk: a queue over `deps`; null where the browser has no origin
 * private file system to read the files from.
 */
export interface UploadRuntime {
  createQueue(deps: UploadDeps): QueueHandle | null;
}

/** Loads the queue's code: `upload-runtime.ts`, a lazy chunk; the unit tests give a fake. */
export const UPLOAD_RUNTIME = new InjectionToken<() => Promise<UploadRuntime>>('UPLOAD_RUNTIME', {
  providedIn: 'root',
  factory: () => () => import('./upload-runtime').then((runtime) => runtime.uploadRuntime),
});

/**
 * Where the uploads are: `signed-out` (nothing uploads without an account); `off` (Settings →
 * Uploads); `unavailable` (the sessions are not kept in this browser's file system); `loading` (the
 * queue's code is loading, or the queue reads this device's sessions); `waiting` (another tab of the
 * app uploads: one at a time); `running`; `error` (the queue's code could not be loaded: `error`).
 */
export type UploadsStatus =
  'signed-out' | 'off' | 'unavailable' | 'loading' | 'waiting' | 'running' | 'error';

/** The queue running, for the account it uploads for. */
interface Running {
  readonly account: CloudAccount;
  readonly queue: QueueHandle;
  readonly unsubscribe: () => void;
}

/**
 * The uploads (docs/PLAN.md T3.3, docs/ARCHITECTURE.md "Uploads"): while an account is signed in and
 * Settings → Uploads says so, the upload queue (@cubetrace/upload, loaded then from its lazy chunk)
 * sends this device's sessions to the account's bucket, follows the records the app saves
 * (`SessionChanges`) and the clips still to come (`ClipsInFlight`), and the settings: "Wi-Fi only"
 * and "Keep local copies". Signed out, or with uploads off, the queue stops (what was being sent
 * goes again later) and nothing of it loads. The pages read `status`, `view` and `attempt()`. The
 * header's indicator, which only an account signed in loads, makes it; so do the Sessions page and a
 * session's page.
 */
@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private readonly clips = inject(ClipsInFlight);
  private readonly storage = inject(StorageService);
  private readonly sessions = inject(SessionService);
  private readonly index = inject(SessionIndexService);
  private readonly sessionStorage = inject(SESSION_STORAGE);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly loadRuntime = inject(UPLOAD_RUNTIME);

  private readonly viewSignal = signal<QueueView | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  private readonly unavailableSignal = signal(false);

  /** The queue's state for the pages; null while no queue runs. */
  readonly view = this.viewSignal.asReadonly();
  /** Why the queue's code could not be loaded (offline after an update, say); null otherwise. */
  readonly error = this.errorSignal.asReadonly();
  /** See {@link UploadsStatus}. */
  readonly status = computed<UploadsStatus>(() => {
    if (this.auth.cloud() === null) {
      return 'signed-out';
    }
    if (!this.settings.uploadSessions()) {
      return 'off';
    }
    if (this.sessionStorage.kind !== 'opfs' || this.unavailableSignal()) {
      return 'unavailable';
    }
    if (this.errorSignal() !== null) {
      return 'error';
    }
    const view = this.viewSignal();
    return view?.status === 'running' || view?.status === 'waiting' ? view.status : 'loading';
  });
  /**
   * The header's indicator: the attempts still to upload (pending, waiting for their clips, being
   * sent) and those failed; null when there is nothing to say.
   */
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

  /** The queue running, and the account it was started for. */
  private running: Running | null = null;
  /** The account the queue is to run for; null when none is to run. */
  private wanted: CloudAccount | null = null;
  /** The starts and stops, one after the other. */
  private chain: Promise<void> = Promise.resolve();
  /** The clips deleted from the device so far, as the view last said. */
  private freed = 0;

  constructor() {
    const subscription = inject(SessionChanges).changes$.subscribe((change) => {
      this.forward(change);
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.follow(null);
    });
    effect(() => {
      const account = this.auth.cloud();
      const enabled = this.settings.uploadSessions();
      untracked(() => {
        this.follow(
          account !== null && enabled && this.sessionStorage.kind === 'opfs' ? account : null,
        );
      });
    });
    effect(() => {
      const policy = this.policy();
      untracked(() => {
        this.running?.queue.setPolicy(policy);
      });
    });
    // A clip saved, failed or dropped: the attempt it held back may go now.
    effect(() => {
      this.clips.version();
      untracked(() => {
        this.running?.queue.refresh();
      });
    });
  }

  /** Attempt `index` of session `sessionId` in the queue; null when the queue does not have it. */
  attempt(sessionId: string, index: number): AttemptView | null {
    // Read again whenever the queue changes.
    this.viewSignal();
    return this.running?.queue.attemptView(sessionId, index) ?? null;
  }

  /**
   * Tries the failed files again, and those waiting after a failure: of one attempt, of a session,
   * or all of them.
   */
  retry(sessionId?: string, index?: number): void {
    this.running?.queue.retry(sessionId, index);
  }

  /** Settings → Uploads, as the queue follows it. */
  private policy(): UploadPolicy {
    return { wifiOnly: this.settings.wifiOnly(), keepLocalCopies: this.settings.keepLocalCopies() };
  }

  /** Starts the queue for `account`, after stopping the one of another account; null stops it. */
  private follow(account: CloudAccount | null): void {
    const before = this.wanted;
    if (account?.uid === before?.uid && account?.backend === before?.backend) {
      return;
    }
    this.wanted = account;
    this.chain = this.chain
      .then(async () => {
        const running = this.running;
        if (running !== null) {
          this.running = null;
          running.unsubscribe();
          this.viewSignal.set(null);
          await running.queue.stop();
        }
        const wanted = this.wanted;
        if (wanted !== null) {
          await this.start(wanted);
        }
      })
      .catch((error: unknown) => {
        this.errorSignal.set(`The uploads could not start: ${errorMessage(error)}`);
      });
  }

  private async start(account: CloudAccount): Promise<void> {
    this.errorSignal.set(null);
    this.unavailableSignal.set(false);
    this.freed = 0;
    let runtime: UploadRuntime;
    try {
      runtime = await this.loadRuntime();
    } catch (error: unknown) {
      this.errorSignal.set(
        `The uploads could not be loaded (${errorMessage(error)}): they start again with the next page load online.`,
      );
      return;
    }
    if (this.wanted !== account) {
      return;
    }
    const queue = runtime.createQueue({
      uid: account.uid,
      backend: account.backend,
      policy: this.policy(),
      globals: this.globals,
      store: this.sessionStorage.store,
      markClipsGone: (ref, files) => this.sessions.markClipsGone(ref, files),
      settled: (sessionId, index) => !this.clips.has(sessionId, index),
      indexIdle: () => this.index.whenIdle(),
    });
    if (queue === null) {
      this.unavailableSignal.set(true);
      return;
    }
    const unsubscribe = queue.onChange(() => {
      this.onView(queue);
    });
    this.running = { account, queue, unsubscribe };
    this.onView(queue);
    void queue.start().then(() => {
      this.onView(queue);
    });
  }

  private onView(queue: QueueHandle): void {
    if (this.running?.queue !== queue) {
      return;
    }
    const view = queue.view();
    this.viewSignal.set(view);
    if (view.freed.clips !== this.freed) {
      // Uploaded clips were deleted: the storage meter goes down with them.
      this.freed = view.freed.clips;
      void this.storage.refresh();
    }
  }

  /** A record the app saved, or deleted, goes to the queue running. */
  private forward(change: SessionChange): void {
    const queue = this.running?.queue;
    if (queue === undefined) {
      return;
    }
    switch (change.type) {
      case 'session':
        queue.sessionSaved(change.session);
        break;
      case 'attempt':
        queue.attemptSaved(change.attempt);
        break;
      case 'attempt-deleted':
        queue.attemptDeleted(change.sessionId, change.index);
        break;
      case 'session-deleted':
        queue.sessionDeleted(change.sessionId);
        break;
    }
  }
}
