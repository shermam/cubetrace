// Cloudflare R2 behind the bucket's port (object-store.ts), through its S3 API.
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { toSize, type ObjectStore } from './object-store.js';

/** What an R2 client needs: the Cloudflare account's id and an API token's S3 keys. */
export interface R2Credentials {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * An S3 client for Cloudflare R2: the account's endpoint, `https://<account>.r2.cloudflarestorage.com`
 * (another for the tests), path-style URLs (`/<bucket>/<key>`), the region `auto`. The SDK's own
 * checksums are off unless an operation requires them: since 3.729 it would sign the CRC32 of an
 * empty body into every presigned PUT, which then refuses any real upload.
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
 * Cloudflare R2. The presigned URL signs `content-type`, which the browser sends, and
 * `content-length`, which it sets itself from the body (a script cannot), so only `Content-Type` is
 * returned; the bucket's CORS policy allows it (bucket/cors.r2.json).
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
