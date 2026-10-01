import type { Page } from '@playwright/test';

// A fake of the account's backend for the end-to-end suite: the dev server's app takes it in place of
// Firebase (ACCOUNT_LOADER, src/app/auth/account-backend.ts, reads `window.cubetraceE2eAccountLoader`
// in development builds only), so that no test opens Google's page or reaches Firebase. Its state is
// in localStorage, so that the account stays signed in across page loads, as Firebase keeps it in
// IndexedDB.

/** A signed-in account as the backend reports it (src/app/auth/account-backend.ts, BackendUser). */
export interface FakeAccountUser {
  readonly uid: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly photoURL: string | null;
  readonly createdMs: number | null;
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
 * `page.goto`). With `popupError`, signing in fails as Firebase does, with that error code.
 */
export async function fakeAccount(
  page: Page,
  options: { account?: FakeAccountUser; popupError?: string } = {},
): Promise<void> {
  await page.addInitScript(
    ({ key, account, popupError }) => {
      interface State {
        user: FakeAccountUser | null;
        loads: number;
        calls: string[];
        saved: { uid: string; record: unknown }[];
      }
      const read = (): State =>
        (JSON.parse(localStorage.getItem(key) ?? 'null') as State | null) ?? {
          user: null,
          loads: 0,
          calls: [],
          saved: [],
        };
      const change = (edit: (state: State) => void): State => {
        const state = read();
        edit(state);
        localStorage.setItem(key, JSON.stringify(state));
        return state;
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
      };
      Reflect.set(window, 'cubetraceE2eAccountLoader', () => {
        change((state) => {
          state.loads++;
        });
        return Promise.resolve(backend);
      });
    },
    { key: STATE_KEY, account: options.account ?? ADA, popupError: options.popupError },
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
      },
    STATE_KEY,
  );
}
