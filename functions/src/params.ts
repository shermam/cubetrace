// The functions' configuration (functions/README.md): parameters, whose values are in functions/.env
// (committed: none is a secret) and reach the functions as environment variables, and, only when the
// bucket is R2, two secrets in Secret Manager.
import { defineInt, defineSecret, defineString, type SecretParam } from 'firebase-functions/params';

/**
 * `gcs` (Google Cloud Storage, during the free trial) or `r2` (Cloudflare R2); `local`, the end-to-end
 * suite's bucket on the same machine, in the Functions emulator only (index.ts, local.ts).
 */
export const BUCKET_PROVIDER = defineString('BUCKET_PROVIDER', {
  default: 'gcs',
  description: 'Where uploads go: gcs (Google Cloud Storage) or r2 (Cloudflare R2).',
});

export const BUCKET_NAME = defineString('BUCKET_NAME', {
  default: 'cubetrace-data',
  description: "The bucket's name, at the provider.",
});

/** The Cloudflare account whose R2 holds the bucket; unused with `gcs`. */
export const R2_ACCOUNT_ID = defineString('R2_ACCOUNT_ID', {
  default: '',
  description:
    "Cloudflare's account id, for R2's endpoint (https://<id>.r2.cloudflarestorage.com).",
});

export const QUOTA_BYTES_PER_DAY = defineInt('QUOTA_BYTES_PER_DAY', {
  default: 2_000_000_000,
  description: 'The bytes an account may have signed for upload in one UTC day.',
});

export const QUOTA_FILES_PER_DAY = defineInt('QUOTA_FILES_PER_DAY', {
  default: 400,
  description: 'The files an account may have signed for upload in one UTC day.',
});

export const MAX_FILE_BYTES = defineInt('MAX_FILE_BYTES', {
  default: 512_000_000,
  description: 'The largest file signUpload signs, in bytes.',
});

/**
 * BUCKET_PROVIDER as the deploy sees it. The Firebase CLI finds the functions, and the secrets they
 * need, by loading this code with the values of functions/.env (and .env.<project>) in its environment,
 * the same values the functions then run with; a parameter's `value()` is only for the run.
 */
export const DEPLOYED_PROVIDER = process.env['BUCKET_PROVIDER'] ?? 'gcs';

/** R2's S3 keys: an API token's, with Object Read & Write on the bucket. */
export interface R2Keys {
  readonly accessKeyId: SecretParam;
  readonly secretAccessKey: SecretParam;
}

/**
 * The R2 keys, declared only when the bucket is R2: a declared secret must exist in Secret Manager for
 * any deploy to go through, and a function must not need secrets it does not use.
 */
export const R2_KEYS: R2Keys | null =
  DEPLOYED_PROVIDER === 'r2'
    ? {
        accessKeyId: defineSecret('R2_ACCESS_KEY_ID', {
          description: "An R2 API token's access key id (Object Read & Write on the bucket).",
        }),
        secretAccessKey: defineSecret('R2_SECRET_ACCESS_KEY', {
          description: "That token's secret access key.",
        }),
      }
    : null;
