// The bucket behind a port: a URL that lets the browser PUT one object, and the size of an object that
// is there. Two providers, chosen by configuration (BUCKET_PROVIDER, functions/src/params.ts), each in a
// module of its own that index.ts loads only when it is the one configured, so that a cold start never
// loads the other's SDK: Google Cloud Storage (gcs.ts), with V4 signed URLs, and Cloudflare R2 (r2.ts),
// with S3 SigV4 presigned URLs. Both bind the object's content type and its exact size into the
// signature, so that an upload can be neither of another type nor longer or shorter than what the
// quota counted.

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

/** A size as a provider reports it (a number, or GCS's decimal text), checked. */
export function toSize(value: unknown): number {
  const size = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`The bucket reported a size that is not one: ${String(value)}.`);
  }
  return size;
}
