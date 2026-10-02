import type { Page } from '@playwright/test';

// A fake of the account's backend for the end-to-end suite: the dev server's app takes it in place of
// Firebase (ACCOUNT_LOADER, src/app/auth/account-backend.ts, reads `window.cubetraceE2eAccountLoader`
// in development builds only), so that no test opens Google's page or reaches Firebase. Its state is
// in localStorage, so that the account stays signed in across page loads, as Firebase keeps it in
// IndexedDB, and so is its session index (T3.1): the documents as written, merged as Firestore's
// `set` with `merge` merges them. Its upload functions (T3.2, T3.3) answer only in a test that runs a
// bucket (`fakeBucket`): they sign URLs into it, on the app's own origin, and confirm what it holds;
// elsewhere they refuse as unavailable, and the upload queue waits.

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
  /**
   * The upload functions' calls that went through, in order: `sign <session>/<index> <paths>`,
   * `confirm …` (the functions write `upload` past the rules, so these are not in `indexWrites`).
   */
  readonly uploadCalls: readonly string[];
}

/** An object the fake bucket holds: what its PUT sent. */
export interface FakeObject {
  readonly bytes: number;
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * The bucket of the fake functions, in the test: the PUTs to the URLs they sign
 * (`/e2e-bucket/<key>` on the app's origin, which a route answers before the dev server sees it),
 * stored by key with their bytes. `hold()` keeps the next PUTs waiting until `release()`.
 */
export interface FakeBucket {
  readonly objects: Map<string, FakeObject>;
  /** The keys PUT, in order (a key twice when it was sent twice). */
  readonly puts: string[];
  hold(): void;
  release(): void;
  /** How many PUTs wait now. */
  readonly held: number;
}

/** Where the fake functions' URLs point, on the app's origin. */
const BUCKET_PATH = '/e2e-bucket/';

/**
 * Runs the fake functions' bucket for `page` (call it before `page.goto`): a route that takes the
 * PUTs and keeps their bytes, and `window.cubetraceE2eBucketSize(key)`, through which the page's fake
 * `confirmUpload` asks for an object's size, as the functions ask the bucket.
 */
export async function fakeBucket(page: Page): Promise<FakeBucket> {
  const objects = new Map<string, FakeObject>();
  const puts: string[] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  let waiting = 0;
  await page.route(`**${BUCKET_PATH}**`, async (route) => {
    const request = route.request();
    const key = decodeURIComponent(new URL(request.url()).pathname.slice(BUCKET_PATH.length));
    if (request.method() !== 'PUT') {
      await route.fulfill({ status: 405, body: 'PUT only' });
      return;
    }
    if (gate !== null) {
      waiting++;
      await gate;
      waiting--;
    }
    const body = request.postDataBuffer() ?? Buffer.alloc(0);
    const headers = request.headers();
    const range = headers['x-goog-content-length-range'] as string | undefined;
    if (range !== `${String(body.length)},${String(body.length)}`) {
      await route.fulfill({ status: 400, body: `Not of the size signed: ${range ?? 'none'}` });
      return;
    }
    puts.push(key);
    objects.set(key, { bytes: body.length, contentType: headers['content-type'] ?? '', body });
    await route.fulfill({ status: 200, body: '' });
  });
  await page.exposeFunction(
    'cubetraceE2eBucketSize',
    (key: string) => objects.get(key)?.bytes ?? null,
  );
  return {
    objects,
    puts,
    hold: () => {
      gate ??= new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      gate = null;
      open();
    },
    get held() {
      return waiting;
    },
  };
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
        uploadCalls: string[];
      }
      const read = (): State =>
        (JSON.parse(localStorage.getItem(key) ?? 'null') as State | null) ?? {
          user: null,
          loads: 0,
          calls: [],
          saved: [],
          index: structuredClone(seed),
          indexWrites: [],
          uploadCalls: [],
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
      // The upload functions (functions/README.md), on the index above, with the test's bucket.
      type Upload = {
        state: string;
        files: Record<string, { bytes: number; doneMs: number | null }>;
      };
      const functionsError = (code: string, message: string): Error =>
        Object.assign(new Error(message), { code: `functions/${code}` });
      const bucketSize = (): ((key: string) => Promise<number | null>) | null => {
        const size: unknown = Reflect.get(window, 'cubetraceE2eBucketSize');
        return typeof size === 'function'
          ? (size as (key: string) => Promise<number | null>)
          : null;
      };
      const objectKey = (uid: string, sessionId: string, index: number, path: string): string =>
        path === 'session.json'
          ? `users/${uid}/sessions/${sessionId}/session.json`
          : `users/${uid}/sessions/${sessionId}/attempts/${String(index).padStart(4, '0')}/${path}`;
      /** The attempt a call is about, checked as the functions check it; its upload to change. */
      const target = (state: State, sessionId: string, index: number): Doc => {
        const uid = state.user?.uid;
        const attempts = state.index.attempts[sessionId] as Record<string, Doc> | undefined;
        const attempt = attempts?.[String(index).padStart(4, '0')];
        const session = state.index.sessions[sessionId] as Doc | undefined;
        if (uid === undefined) {
          throw functionsError('unauthenticated', 'Sign in to upload.');
        }
        if (session?.['owner'] !== uid || attempt?.['owner'] !== uid) {
          throw functionsError(
            'not-found',
            `The attempt ${String(index)} is not in the cloud index.`,
          );
        }
        return attempt;
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
        waitForIndexWrites(): Promise<void> {
          return Promise.resolve();
        },
        signUpload(request: {
          sessionId: string;
          attemptIndex: number;
          files: { path: string; bytes: number; contentType: string }[];
        }) {
          try {
            if (bucketSize() === null) {
              throw functionsError('unavailable', 'The upload functions are not in this test.');
            }
            const uid = read().user?.uid ?? '';
            change((state) => {
              const attempt = target(state, request.sessionId, request.attemptIndex);
              const upload = attempt['upload'] as Upload;
              upload.state = 'uploading';
              for (const file of request.files) {
                upload.files[file.path] = { bytes: file.bytes, doneMs: null };
              }
              state.uploadCalls.push(
                `sign ${request.sessionId}/${String(request.attemptIndex)} ${request.files.map((file) => file.path).join(',')}`,
              );
            });
            return Promise.resolve(
              request.files.map((file) => ({
                path: file.path,
                url: `${location.origin}/e2e-bucket/${objectKey(uid, request.sessionId, request.attemptIndex, file.path)}`,
                headers: {
                  'Content-Type': file.contentType,
                  'x-goog-content-length-range': `${String(file.bytes)},${String(file.bytes)}`,
                },
                expiresAt: Date.now() + 15 * 60 * 1000,
              })),
            );
          } catch (error: unknown) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        async confirmUpload(request: {
          sessionId: string;
          attemptIndex: number;
          files: { path: string }[];
        }) {
          const size = bucketSize();
          if (size === null) {
            throw functionsError('unavailable', 'The upload functions are not in this test.');
          }
          const uid = read().user?.uid ?? '';
          const sizes = await Promise.all(
            request.files.map((file) =>
              size(objectKey(uid, request.sessionId, request.attemptIndex, file.path)),
            ),
          );
          let result: unknown = null;
          change((state) => {
            const attempt = target(state, request.sessionId, request.attemptIndex);
            const upload = attempt['upload'] as Upload;
            const confirmed = request.files.map(({ path }, k) => {
              const signed = upload.files[path] as Upload['files'][string] | undefined;
              if (signed === undefined) {
                throw functionsError('failed-precondition', `${path} was not signed.`);
              }
              if (sizes[k] !== signed.bytes) {
                throw functionsError('not-found', `${path} is not in the bucket.`);
              }
              signed.doneMs ??= Date.now();
              return { path, bytes: signed.bytes, doneMs: signed.doneMs };
            });
            const pending = Object.entries(upload.files)
              .filter(([, file]) => file.doneMs === null)
              .map(([path]) => path)
              .sort();
            upload.state = pending.length === 0 ? 'done' : 'uploading';
            state.uploadCalls.push(
              `confirm ${request.sessionId}/${String(request.attemptIndex)} ${request.files.map((file) => file.path).join(',')}`,
            );
            result = { state: upload.state, confirmed, pending };
          });
          return result;
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
        uploadCalls: [],
      },
    STATE_KEY,
  );
}
