import type { Page } from '@playwright/test';

// A fake of the account's backend for the end-to-end suite: the dev server's app takes it in place of
// Firebase (ACCOUNT_LOADER, src/app/auth/account-backend.ts, reads `window.cubetraceE2eAccountLoader`
// in development builds only), so that no test opens Google's page or reaches Firebase. Its state is
// in localStorage, so that the account stays signed in across page loads, as Firebase keeps it in
// IndexedDB, and so is its session index (T3.1): the documents as written, merged as Firestore's
// `set` with `merge` merges them.

/** A signed-in account as the backend reports it (src/app/auth/account-backend.ts, BackendUser). */
export interface FakeAccountUser {
  readonly uid: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly photoURL: string | null;
  readonly createdMs: number | null;
}

/** The session index of the fake: the documents by path (docs/DATA-MODEL.md §10). */
export interface FakeIndex {
  /** sessions/{id}, by id. */
  readonly sessions: Readonly<Record<string, Record<string, unknown>>>;
  /** sessions/{id}/attempts/{index}, by session id, then by index zero-padded (`0001`). */
  readonly attempts: Readonly<Record<string, Readonly<Record<string, Record<string, unknown>>>>>;
}

/** What the fake has done: its loads, the calls made into it, users/{uid} as written. */
export interface FakeAccountState {
  /** The account signed in on this browser context; null without one. */
  readonly user: FakeAccountUser | null;
  /** How many times the app loaded the account's backend (where it would load Firebase). */
  readonly loads: number;
  /** `popup`, `redirect`, `redirect-result`, `sign-out`, in order. */
  readonly calls: readonly string[];
  readonly saved: readonly { readonly uid: string; readonly record: unknown }[];
  /** The session index, as written (and as the test seeded it). */
  readonly index: FakeIndex;
  /** The index's writes in order: `sessions/<id>`, `sessions/<id>/attempts/0001`, `delete …`. */
  readonly indexWrites: readonly string[];
}

/** The account Google's page would sign in. */
export const ADA: FakeAccountUser = {
  uid: 'e2e-ada',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  photoURL: null,
  createdMs: 1_790_000_000_000,
};

const STATE_KEY = 'e2e.fakeAccount';

/**
 * Installs the fake before the app's scripts run, on every page load of `page` (call it before
 * `page.goto`). With `popupError`, signing in fails as Firebase does, with that error code. `index`
 * is what the session index holds before the first page load (another device's sessions).
 */
export async function fakeAccount(
  page: Page,
  options: { account?: FakeAccountUser; popupError?: string; index?: FakeIndex } = {},
): Promise<void> {
  await page.addInitScript(
    ({ key, account, popupError, seed }) => {
      type Doc = Record<string, unknown>;
      interface State {
        user: FakeAccountUser | null;
        loads: number;
        calls: string[];
        saved: { uid: string; record: unknown }[];
        index: { sessions: Record<string, Doc>; attempts: Record<string, Record<string, Doc>> };
        indexWrites: string[];
      }
      const read = (): State =>
        (JSON.parse(localStorage.getItem(key) ?? 'null') as State | null) ?? {
          user: null,
          loads: 0,
          calls: [],
          saved: [],
          index: structuredClone(seed),
          indexWrites: [],
        };
      const change = (edit: (state: State) => void): State => {
        const state = read();
        edit(state);
        localStorage.setItem(key, JSON.stringify(state));
        return state;
      };
      // Firestore's `set` with `merge`: maps merged field by field, anything else replaced.
      const isMap = (value: unknown): value is Doc =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const merged = (stored: unknown, next: Doc): Doc => {
        if (!isMap(stored)) {
          return structuredClone(next);
        }
        const out: Doc = { ...stored };
        for (const [field, value] of Object.entries(next)) {
          out[field] = isMap(value) && isMap(stored[field]) ? merged(stored[field], value) : value;
        }
        return out;
      };
      const putAttempt = (state: State, attempt: Doc): void => {
        const sessionId = String(attempt['session']);
        const id = String(attempt['index']).padStart(4, '0');
        const attempts = (state.index.attempts[sessionId] ??= {});
        attempts[id] = merged(attempts[id], attempt);
        state.indexWrites.push(`sessions/${sessionId}/attempts/${id}`);
      };
      const watchers = new Set<(user: FakeAccountUser | null) => void>();
      const setUser = (user: FakeAccountUser | null): void => {
        change((state) => {
          state.user = user;
        });
        for (const watcher of watchers) {
          setTimeout(() => {
            watcher(user);
          }, 0);
        }
      };
      const backend = {
        watchUser(next: (user: FakeAccountUser | null) => void): () => void {
          watchers.add(next);
          const user = read().user;
          setTimeout(() => {
            next(user);
          }, 0);
          return () => {
            watchers.delete(next);
          };
        },
        signInWithPopup(): Promise<void> {
          change((state) => state.calls.push('popup'));
          if (popupError !== undefined) {
            const error = Object.assign(new Error(`Firebase: Error (${popupError}).`), {
              code: popupError,
            });
            return Promise.reject(error);
          }
          setUser(account);
          return Promise.resolve();
        },
        signInWithRedirect(): Promise<void> {
          change((state) => state.calls.push('redirect'));
          return Promise.reject(new Error('The end-to-end fake does not redirect.'));
        },
        redirectResult(): Promise<FakeAccountUser | null> {
          change((state) => state.calls.push('redirect-result'));
          return Promise.resolve(null);
        },
        signOut(): Promise<void> {
          change((state) => state.calls.push('sign-out'));
          setUser(null);
          return Promise.resolve();
        },
        saveUser(uid: string, record: unknown): Promise<void> {
          change((state) => state.saved.push({ uid, record }));
          return Promise.resolve();
        },
        saveSessionIndex(session: Doc, attempts: Doc[] = []): Promise<void> {
          change((state) => {
            const id = String(session['id']);
            state.index.sessions[id] = merged(state.index.sessions[id], session);
            state.indexWrites.push(`sessions/${id}`);
            for (const attempt of attempts) {
              putAttempt(state, attempt);
            }
          });
          return Promise.resolve();
        },
        saveAttemptIndex(attempt: Doc): Promise<void> {
          change((state) => {
            putAttempt(state, attempt);
          });
          return Promise.resolve();
        },
        deleteAttemptIndex(sessionId: string, index: number): Promise<void> {
          change((state) => {
            const id = String(index).padStart(4, '0');
            Reflect.deleteProperty(state.index.attempts[sessionId] ?? {}, id);
            state.indexWrites.push(`delete sessions/${sessionId}/attempts/${id}`);
          });
          return Promise.resolve();
        },
        listSessions(uid: string, limit: number) {
          const documents = Object.values(read().index.sessions)
            .filter((session) => session['owner'] === uid)
            .sort((p, q) => Number(q['createdMs']) - Number(p['createdMs']))
            .slice(0, limit)
            .map((session) => ({ id: String(session['id']), data: session, pending: false }));
          return Promise.resolve({ documents, fromCache: false });
        },
        getSession(sessionId: string) {
          const session = read().index.sessions[sessionId] as Doc | undefined;
          return Promise.resolve(
            session === undefined ? null : { id: sessionId, data: session, pending: false },
          );
        },
        listAttempts(uid: string, sessionId: string) {
          const documents = Object.entries(read().index.attempts[sessionId] ?? {})
            .filter(([, attempt]) => attempt['owner'] === uid)
            .sort(([p], [q]) => p.localeCompare(q))
            .map(([id, attempt]) => ({ id, data: attempt, pending: false }));
          return Promise.resolve({ documents, fromCache: false });
        },
      };
      Reflect.set(window, 'cubetraceE2eAccountLoader', () => {
        change((state) => {
          state.loads++;
        });
        return Promise.resolve(backend);
      });
    },
    {
      key: STATE_KEY,
      account: options.account ?? ADA,
      popupError: options.popupError,
      seed: options.index ?? { sessions: {}, attempts: {} },
    },
  );
}

/** What the fake has done so far in this browser context. */
export async function fakeAccountState(page: Page): Promise<FakeAccountState> {
  return page.evaluate(
    (key) =>
      (JSON.parse(localStorage.getItem(key) ?? 'null') as FakeAccountState | null) ?? {
        user: null,
        loads: 0,
        calls: [],
        saved: [],
        index: { sessions: {}, attempts: {} },
        indexWrites: [],
      },
    STATE_KEY,
  );
}
