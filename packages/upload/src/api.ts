// The two callable functions the queue goes through (functions/README.md, docs/PLAN.md T3.2):
// signUpload signs a PUT URL per file of an attempt, within the account's daily quota, and records
// the intent on the attempt's document; confirmUpload checks that the files are in the bucket with
// the sizes signed and marks them done. The types say what the functions take and answer; the app
// calls them through Firebase (AccountBackend, apps/web/src/app/auth), the tests through fakes.

/** A file of an attempt to sign: its name in the attempt's folder, its exact size and its type. */
export interface FileToSign {
  /** `attempt.json`, `<camera>.<segment>.mp4`, `<camera>.<segment>.frames.json` or `session.json`. */
  readonly path: string;
  readonly bytes: number;
  /** `video/mp4` for a clip, `application/json` for the rest. */
  readonly contentType: string;
}

/** `signUpload`'s argument. */
export interface SignRequest {
  readonly sessionId: string;
  /** The attempt's `index`, 1-based. */
  readonly attemptIndex: number;
  readonly files: readonly FileToSign[];
}

/** One file of `signUpload`'s answer: PUT it to `url` with exactly `headers`, before `expiresAt`. */
export interface SignedFile {
  readonly path: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** When the URL stops accepting the upload, in ms since 1970 on the server's clock. */
  readonly expiresAt: number;
}

/** `confirmUpload`'s argument. */
export interface ConfirmRequest {
  readonly sessionId: string;
  readonly attemptIndex: number;
  readonly files: readonly { readonly path: string }[];
}

/** `confirmUpload`'s answer. */
export interface ConfirmResult {
  /** The attempt's `upload.state`: `done` once every file of its upload is confirmed. */
  readonly state: 'uploading' | 'done';
  /** The files of the call, each with its size and when it was confirmed (the server's clock). */
  readonly confirmed: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly doneMs: number;
  }[];
  /** The files of the attempt's upload not confirmed yet. */
  readonly pending: readonly string[];
}

/** The content type a file of the dataset is uploaded with, which its signed URL binds. */
export const JSON_TYPE = 'application/json';
export const MP4_TYPE = 'video/mp4';

/**
 * A refusal of `signUpload` or `confirmUpload`: the `HttpsError`'s code without Firebase's
 * `functions/` prefix (`resource-exhausted`, `not-found`, `unavailable`, …), its message and its
 * details (`resetsAtMs` for the quota).
 */
export class CloudError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

/**
 * The codes of a refusal that a later call may not meet: the server or the network failed, or the
 * call was cut short. Every other code is a refusal of the request itself, which the queue does not
 * repeat as it is (docs/ARCHITECTURE.md, "Uploads").
 */
export const TRANSIENT_CODES: readonly string[] = [
  'internal',
  'unavailable',
  'deadline-exceeded',
  'unknown',
  'aborted',
  'cancelled',
];

/** `error` as a refusal of the functions: a {@link CloudError} as it is, anything else as `unknown`. */
export function cloudErrorOf(error: unknown): CloudError {
  if (error instanceof CloudError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CloudError('unknown', message);
}

/** When the daily quota resets, from a `resource-exhausted` refusal's details; null without one. */
export function resetsAtOf(error: CloudError): number | null {
  const details = error.details;
  const resetsAtMs =
    typeof details === 'object' && details !== null
      ? (Reflect.get(details, 'resetsAtMs') as unknown)
      : undefined;
  return typeof resetsAtMs === 'number' && Number.isFinite(resetsAtMs) ? resetsAtMs : null;
}
