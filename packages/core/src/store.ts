// Where sessions and their attempts are kept (docs/DATA-MODEL.md §5): the interface the app uses,
// with an in-memory implementation for tests and for the app's unit tests. The browser's store
// (OPFS, T1.6b) implements the same interface with the same rules.
import type { AttemptRecord } from './attempt';
import type { SessionRecord } from './session';

/**
 * Sessions and their attempts. Records go in and come out as copies: changing a record after
 * saving it, or one that was loaded, changes nothing in the store.
 */
export interface SessionStore {
  /** Adds a new session; rejects if a session with its id exists. */
  createSession(s: SessionRecord): Promise<void>;
  /** Replaces a session's record (its summary, its clock fit); rejects if the session is unknown. */
  saveSession(s: SessionRecord): Promise<void>;
  /** Adds or replaces the attempt with the same index in its session; rejects if the session is unknown. */
  saveAttempt(a: AttemptRecord): Promise<void>;
  /** Every session, the newest first (by `createdMs`). */
  listSessions(): Promise<SessionRecord[]>;
  /** A session's attempts, sorted by index; rejects if the session is unknown. */
  loadAttempts(sessionId: string): Promise<AttemptRecord[]>;
  /** Removes a session and all its attempts; does nothing if the session is unknown. */
  deleteSession(sessionId: string): Promise<void>;
  /**
   * Removes one attempt of a session (the timer's "Delete last"); does nothing if the session has
   * no attempt with that index; rejects if the session is unknown.
   */
  deleteAttempt(sessionId: string, index: number): Promise<void>;
  /** A session with its attempts sorted by index, as one export file holds them; rejects if unknown. */
  exportSession(sessionId: string): Promise<{ session: SessionRecord; attempts: AttemptRecord[] }>;
}

interface Stored {
  session: SessionRecord;
  /** By index. */
  attempts: Map<number, AttemptRecord>;
}

/** A {@link SessionStore} in memory, for tests; nothing survives the page. */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Stored>();

  createSession(s: SessionRecord): Promise<void> {
    return settle(() => {
      if (this.#sessions.has(s.id)) {
        throw new Error(`Session ${s.id} exists already.`);
      }
      this.#sessions.set(s.id, { session: structuredClone(s), attempts: new Map() });
    });
  }

  saveSession(s: SessionRecord): Promise<void> {
    return settle(() => {
      this.#get(s.id).session = structuredClone(s);
    });
  }

  saveAttempt(a: AttemptRecord): Promise<void> {
    return settle(() => {
      this.#get(a.session).attempts.set(a.index, structuredClone(a));
    });
  }

  listSessions(): Promise<SessionRecord[]> {
    return settle(() =>
      [...this.#sessions.values()]
        .map(({ session }) => structuredClone(session))
        .sort((p, q) => q.createdMs - p.createdMs || p.id.localeCompare(q.id)),
    );
  }

  loadAttempts(sessionId: string): Promise<AttemptRecord[]> {
    return settle(() => this.#attempts(this.#get(sessionId)));
  }

  deleteSession(sessionId: string): Promise<void> {
    return settle(() => {
      this.#sessions.delete(sessionId);
    });
  }

  deleteAttempt(sessionId: string, index: number): Promise<void> {
    return settle(() => {
      this.#get(sessionId).attempts.delete(index);
    });
  }

  exportSession(sessionId: string): Promise<{ session: SessionRecord; attempts: AttemptRecord[] }> {
    return settle(() => {
      const stored = this.#get(sessionId);
      return { session: structuredClone(stored.session), attempts: this.#attempts(stored) };
    });
  }

  #get(sessionId: string): Stored {
    const stored = this.#sessions.get(sessionId);
    if (stored === undefined) {
      throw new Error(`No session ${sessionId}.`);
    }
    return stored;
  }

  #attempts(stored: Stored): AttemptRecord[] {
    return [...stored.attempts.values()]
      .sort((p, q) => p.index - q.index)
      .map((a) => structuredClone(a));
  }
}

/** A promise of `f()`'s result that rejects with what `f` throws, like an async function's. */
function settle<T>(f: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(f());
  });
}
