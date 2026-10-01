// The bucket behind a port: a URL that lets the browser PUT one object, and the size of an object that
// is there. Two providers, chosen by configuration (BUCKET_PROVIDER, functions/src/params.ts): Google
// Cloud Storage, with V4 signed URLs, and Cloudflare R2, with S3 SigV4 presigned URLs. Both bind the
// object's content type and its exact size into the signature, so that an upload can be neither of
// another type nor longer or shorter than what the quota counted.
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ApiError, type Bucket } from '@google-cloud/storage';

/** An object to upload: its key in the bucket, its content type and its size in bytes. */
export interface ObjectToPut {
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
}

/** A signed upload: PUT the object's bytes to `url` with exactly these `headers`. */
export interface SignedPut {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ObjectStore {
  /** `gcs` or `r2`, for the logs. */
  readonly provider: string;
  /** The bucket's name, for the logs. */
  readonly bucket: string;
  /**
   * A URL that accepts one `PUT` of `object`, valid from `signedAtMs` until `expiresAtMs` (ms since
   * 1970, whole seconds), with the headers the request must carry.
   */
  signPut(object: ObjectToPut, signedAtMs: number, expiresAtMs: number): Promise<SignedPut>;
  /** The size in bytes of the object at `key`, or null when there is none. */
  sizeOf(key: string): Promise<number | null>;
}

/**
 * Google Cloud Storage. `bucket` comes from a `Storage` client: on Cloud Functions its credentials are
 * the function's service account, which signs through the IAM Credentials API (`signBlob`), so it needs
 * Service Account Token Creator on itself, and Storage Object Admin on the bucket for the uploads it
 * signs (docs/USER-ACTIONS.md). The size is bound by `x-goog-content-length-range`, which the browser
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

/** What an R2 client needs: the Cloudflare account's id and an API token's S3 keys. */
export interface R2Credentials {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * An S3 client for Cloudflare R2: the account's endpoint, `https://<account>.r2.cloudflarestorage.com`,
 * path-style URLs (`/<bucket>/<key>`), the region `auto`. The SDK's own checksums are off unless an
 * operation requires them: since 3.729 it would sign the CRC32 of an empty body into every presigned
 * PUT, which then refuses any real upload.
 */
export function r2Client(credentials: R2Credentials, endpoint?: string): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: endpoint ?? `https://${credentials.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Cloudflare R2 through its S3 API. The presigned URL signs `content-type`, which the browser sends,
 * and `content-length`, which it sets itself from the body (a script cannot), so only those headers
 * are returned; the bucket's CORS policy allows `Content-Type` (bucket/cors.r2.json).
 */
export function r2ObjectStore(client: S3Client, bucket: string): ObjectStore {
  return {
    provider: 'r2',
    bucket,
    async signPut({ key, contentType, bytes }, signedAtMs, expiresAtMs) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: bytes,
      });
      const url = await getSignedUrl(client, command, {
        signingDate: new Date(signedAtMs),
        expiresIn: Math.round((expiresAtMs - signedAtMs) / 1000),
        signableHeaders: new Set(['content-type', 'content-length']),
      });
      return { url, headers: { 'Content-Type': contentType } };
    },
    async sizeOf(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return toSize(head.ContentLength);
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
          return null;
        }
        throw error;
      }
    },
  };
}

function toSize(value: unknown): number {
  const size = typeof value === 'string' ? Number(value) : value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`The bucket reported a size that is not one: ${String(value)}.`);
  }
  return size;
}

/**
 * A bucket that cannot be used, because the configuration is not whole: every call fails, saying
 * why in the function's log, so that the misconfiguration is one call's error rather than the module's.
 */
export function unconfiguredObjectStore(
  provider: string,
  bucket: string,
  reason: string,
): ObjectStore {
  const fail = (): Promise<never> =>
    Promise.reject(new Error(`The bucket is not configured (${provider}, ${bucket}): ${reason}.`));
  return { provider, bucket, signPut: fail, sizeOf: fail };
}
