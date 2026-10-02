// The end-to-end suite's bucket behind the bucket's port (object-store.ts): BUCKET_PROVIDER=local, for
// the Functions emulator only (npm run e2e:cloud, with functions/.env.demo-cubetrace). The bucket is a
// server on the same machine that keeps what is PUT to it (apps/web/e2e/helpers/bucket-sink.mts).
// Nothing is signed: a URL names the object's key and carries in its query what it was made for, the
// content type, the exact size and the expiry, to which the sink holds the PUT as GCS's signature holds
// it, and the headers returned are GCS's, so that the app sends the requests it sends to the real bucket.
import { toSize, unconfiguredObjectStore, type ObjectStore } from './object-store.js';

/** Why the local bucket is refused where the Functions emulator does not run. */
export const EMULATOR_ONLY =
  "the local bucket is the end-to-end suite's, for the Functions emulator only";

/**
 * The bucket on the server at `env.LOCAL_BUCKET_URL` (`http://127.0.0.1:4600`): `PUT <url>/<key>?
 * contentType=…&bytes=…&expires=…` with the headers returned, and an object's size from
 * `HEAD <url>/<key>`. Only when `env` is the Functions emulator's (FUNCTIONS_EMULATOR is `true`, as the
 * emulator sets it and Cloud Functions never does): elsewhere, and without a URL, a bucket that fails
 * every call, saying why, so that a deploy configured with it signs nothing.
 */
export function localObjectStore(env: Readonly<Record<string, string | undefined>>): ObjectStore {
  const configured = env['LOCAL_BUCKET_URL'] ?? '';
  if (env['FUNCTIONS_EMULATOR'] !== 'true') {
    return unconfiguredObjectStore('local', configured, EMULATOR_ONLY);
  }
  let origin: string;
  try {
    origin = new URL(configured).origin;
  } catch {
    const reason =
      configured === '' ? 'LOCAL_BUCKET_URL is empty' : 'LOCAL_BUCKET_URL is not a URL';
    return unconfiguredObjectStore('local', configured, reason);
  }
  return {
    provider: 'local',
    bucket: origin,
    signPut({ key, contentType, bytes }, _signedAtMs, expiresAtMs) {
      const url = objectUrl(origin, key);
      url.searchParams.set('contentType', contentType);
      url.searchParams.set('bytes', String(bytes));
      url.searchParams.set('expires', String(expiresAtMs));
      const range = `${String(bytes)},${String(bytes)}`;
      return Promise.resolve({
        url: url.href,
        headers: { 'Content-Type': contentType, 'x-goog-content-length-range': range },
      });
    },
    async sizeOf(key) {
      const response = await fetch(objectUrl(origin, key), { method: 'HEAD' });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`The local bucket answered ${String(response.status)} for ${key}.`);
      }
      return toSize(response.headers.get('content-length'));
    },
  };
}

/** The URL of the object at `key` on the server at `origin`, each segment of the key encoded. */
function objectUrl(origin: string, key: string): URL {
  return new URL(`/${key.split('/').map(encodeURIComponent).join('/')}`, origin);
}
