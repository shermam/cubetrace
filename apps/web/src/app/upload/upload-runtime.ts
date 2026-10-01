// The upload queue in the app (docs/PLAN.md T3.3, docs/ARCHITECTURE.md "Uploads"): @cubetrace/upload's
// UploadQueue with its ports made of the app's pieces. A lazy chunk of its own, upload-runtime-<hash>.js,
// which UploadService loads only once an account is signed in with uploads on (UPLOAD_RUNTIME), and
// which the service worker leaves out of the app's prefetched files (ngsw-config.json): a device that
// never signs in never downloads it.
import { parseCloudAttempt, type CloudUpload } from '@cubetrace/core';
import {
  CloudError,
  OpfsUploadSource,
  UploadQueue,
  xhrHttp,
  type UploadCloud,
  type UploadEnvironment,
} from '@cubetrace/upload';

import type { AccountBackend } from '../auth/account-backend';
import { hostNow, type BrowserGlobals } from '../device/browser-globals';
import { networkConnection } from '../device/network-connection';
import type { UploadDeps, UploadRuntime } from './upload-service';

/** The Web Lock that one tab of the app holds while its queue runs. */
export const UPLOAD_LOCK = 'cubetrace.uploads';

/** The runtime UploadService loads. */
export const uploadRuntime: UploadRuntime = { createQueue: createUploadQueue };

/**
 * The upload queue of the account `deps.uid`, over this device's sessions (the app's session store
 * and the origin private file system), the account's backend (the index and the two functions) and
 * `XMLHttpRequest`; null where the browser has no origin private file system. Not started.
 */
export function createUploadQueue(deps: UploadDeps): UploadQueue | null {
  const { uid, backend, globals } = deps;
  const manager = globals.navigator?.storage;
  if (typeof manager?.getDirectory !== 'function') {
    return null;
  }
  const source = new OpfsUploadSource({
    root: manager.getDirectory(),
    store: deps.store,
    markClipsGone: deps.markClipsGone,
    settled: deps.settled,
  });
  return new UploadQueue({
    uid,
    source,
    cloud: cloudOf(uid, backend, deps.indexIdle),
    http: xhrHttp(() => new XMLHttpRequest()),
    env: environmentOf(globals),
    policy: deps.policy,
  });
}

/**
 * The index and the two functions, through the account's backend: the functions' errors as
 * `CloudError`s (their code without Firebase's `functions/`), the attempts' `upload` from the index.
 */
function cloudOf(
  uid: string,
  backend: AccountBackend,
  indexIdle: () => Promise<void>,
): UploadCloud {
  return {
    whenIndexed: async () => {
      // The index hands its writes to Firestore one after the other: once they are all handed over,
      // Firestore says when the server has them.
      await indexIdle();
      await backend.waitForIndexWrites();
    },
    signUpload: (request) => backend.signUpload(request).catch(rethrow),
    confirmUpload: (request) => backend.confirmUpload(request).catch(rethrow),
    uploadsOf: async (sessionId) => {
      const uploads = new Map<number, CloudUpload>();
      for (const { data } of (await backend.listAttempts(uid, sessionId)).documents) {
        try {
          const attempt = parseCloudAttempt(data);
          uploads.set(attempt.index, attempt.upload);
        } catch {
          // Another version's document: what it says is not known, so its files are sent.
        }
      }
      return uploads;
    },
  };
}

/** A Firebase error as the queue reads it: its code without `functions/`, its message, its details. */
function rethrow(error: unknown): never {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : '';
  const details: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'details') : undefined;
  const message = error instanceof Error ? error.message : String(error);
  throw new CloudError(
    typeof code === 'string' && code !== '' ? code.replace(/^functions\//, '') : 'unknown',
    message,
    details,
  );
}

/** The device for the queue: the host clock and timers, storage, the network and the Web Lock. */
function environmentOf(globals: BrowserGlobals): UploadEnvironment {
  const navigator = globals.navigator;
  const connection = networkConnection(navigator);
  const locks = navigator?.locks;
  const env: UploadEnvironment = {
    now: () => hostNow(globals),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    random: () => Math.random(),
    storage: async () => {
      const estimate = await navigator?.storage?.estimate();
      const { usage, quota } = estimate ?? {};
      return usage === undefined || quota === undefined ? null : { usage, quota };
    },
    network: () => {
      // Read again each time: the connection's fields change with the network.
      const now = networkConnection(navigator);
      return {
        online: navigator?.onLine !== false,
        type: now?.type,
        effectiveType: now?.effectiveType,
      };
    },
    watchNetwork: (listener) => {
      globals.addEventListener?.('online', listener);
      globals.addEventListener?.('offline', listener);
      connection?.addEventListener('change', listener);
      return () => {
        globals.removeEventListener?.('online', listener);
        globals.removeEventListener?.('offline', listener);
        connection?.removeEventListener('change', listener);
      };
    },
  };
  if (locks !== undefined) {
    env.lock = (signal) =>
      new Promise<() => void>((granted, refused) => {
        locks
          .request(
            UPLOAD_LOCK,
            { signal },
            () =>
              new Promise<void>((release) => {
                granted(release);
              }),
          )
          .catch(refused);
      });
  }
  return env;
}
