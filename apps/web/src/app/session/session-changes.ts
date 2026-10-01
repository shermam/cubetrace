import { Injectable } from '@angular/core';
import type { AttemptRecord, SessionRecord, SessionStore } from '@cubetrace/core';
import type { ProblemReporter } from '@cubetrace/storage';
import { Subject, type Observable } from 'rxjs';

/** A write of the session store, once it is in the origin private file system. */
export type SessionChange =
  | { readonly type: 'session'; readonly session: SessionRecord }
  | { readonly type: 'attempt'; readonly attempt: AttemptRecord }
  | { readonly type: 'attempt-deleted'; readonly sessionId: string; readonly index: number }
  | { readonly type: 'session-deleted'; readonly sessionId: string };

/** The session store as `SessionService` uses it: the OPFS one also lists what it could not read. */
type TrackedStore = SessionStore & Partial<ProblemReporter>;

/**
 * The writes of `SessionService`'s store, as events (T3.3): the upload queue follows the records the
 * timer, the recording and the sync check save without reading the store again. `track` wraps the
 * store; each event comes once its write is done, never for one that failed.
 */
@Injectable({ providedIn: 'root' })
export class SessionChanges {
  private readonly subject = new Subject<SessionChange>();

  /** Every write of the tracked store, in order. */
  readonly changes$: Observable<SessionChange> = this.subject.asObservable();

  /** `store`, telling `changes$` of each of its writes once it is done. */
  track(store: TrackedStore): TrackedStore {
    const tracked: TrackedStore = {
      createSession: async (session) => {
        await store.createSession(session);
        this.subject.next({ type: 'session', session });
      },
      saveSession: async (session) => {
        await store.saveSession(session);
        this.subject.next({ type: 'session', session });
      },
      saveAttempt: async (attempt) => {
        await store.saveAttempt(attempt);
        this.subject.next({ type: 'attempt', attempt });
      },
      deleteAttempt: async (sessionId, index) => {
        await store.deleteAttempt(sessionId, index);
        this.subject.next({ type: 'attempt-deleted', sessionId, index });
      },
      deleteSession: async (sessionId) => {
        await store.deleteSession(sessionId);
        this.subject.next({ type: 'session-deleted', sessionId });
      },
      listSessions: () => store.listSessions(),
      loadAttempts: (sessionId) => store.loadAttempts(sessionId),
      exportSession: (sessionId) => store.exportSession(sessionId),
    };
    const listProblems = store.listProblems?.bind(store);
    if (listProblems !== undefined) {
      tracked.listProblems = listProblems;
    }
    return tracked;
  }
}
