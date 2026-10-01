// Google Cloud Storage behind the bucket's port (object-store.ts).
import { ApiError, type Bucket } from '@google-cloud/storage';

import { toSize, type ObjectStore } from './object-store.js';

/**
 * Google Cloud Storage. `bucket` comes from a `Storage` client: on Cloud Functions its credentials are
 * the function's service account, which signs through the IAM Credentials API (`signBlob`), so it needs
 * Service Account Token Creator on itself, and Storage Object Admin on the bucket for the uploads it
 * signs (bucket/README.md). The size is bound by `x-goog-content-length-range`, which the browser
 * sends and the bucket's CORS policy allows (bucket/cors.json).
 */
export function gcsObjectStore(bucket: Bucket): ObjectStore {
  return {
    provider: 'gcs',
    bucket: bucket.name,
    async signPut({ key, contentType, bytes }, signedAtMs, expiresAtMs) {
      const range = `${String(bytes)},${String(bytes)}`;
      const [url] = await bucket.file(key).getSignedUrl({
        version: 'v4',
        action: 'write',
        accessibleAt: signedAtMs,
        expires: expiresAtMs,
        contentType,
        extensionHeaders: { 'x-goog-content-length-range': range },
      });
      return {
        url,
        headers: { 'Content-Type': contentType, 'x-goog-content-length-range': range },
      };
    },
    async sizeOf(key) {
      try {
        const [metadata] = await bucket.file(key).getMetadata();
        return toSize(metadata.size);
      } catch (error) {
        if (error instanceof ApiError && error.code === 404) {
          return null;
        }
        throw error;
      }
    },
  };
}
