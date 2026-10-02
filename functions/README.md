# Cloud Functions

The Firebase project's functions (`cubetrace-cacd9`, region `us-central1`): `signUpload` and
`confirmUpload`, the server's half of the upload queue (`docs/PLAN.md` T3.2 and T3.3,
`docs/ARCHITECTURE.md` "Uploads"). TypeScript compiled to ES modules for Node 22, firebase-functions 7
(`onCall`), the Admin SDK for Firestore, and the bucket of the configuration: Google Cloud Storage or
Cloudflare R2 (`bucket/README.md`). Deployed on their own (Cloud Build installs this
`package.json` from npm), so they import no workspace package.

## The API

Two callable functions, for a signed-in account (App Check is not enforced yet). In the app:
`httpsCallable(getFunctions(app, 'us-central1'), 'signUpload')`.

### `signUpload`

```ts
signUpload({ sessionId, attemptIndex, files: [{ path, bytes, contentType }] })
  → [{ path, url, headers, expiresAt }]
```

- `sessionId`, a session's id (a lowercase UUID v4), and `attemptIndex`, an attempt's `index`
  (1-based): `sessions/{sessionId}` and `sessions/{sessionId}/attempts/{index}`, `{index}` padded to
  four digits like the attempt's folder (`0001`, `docs/DATA-MODEL.md` §5 and §10), must be in
  Firestore with the caller as `owner`; a document the app has not sent yet (Firestore's offline
  queue: `waitForPendingWrites` first) is `not-found`.
- `files`: 1 to 33, named as in the attempt's folder: `attempt.json`, `<camera>.<segment>.mp4`,
  `<camera>.<segment>.frames.json`, `gyro.json` (the attempt's gyroscope file, T3.7), or
  `session.json`, the session's file, which rides with one of its attempts (the first uploaded, and
  again with a later one when it has changed) and goes to the session's object. `bytes` is the file's
  exact size, 1 to `MAX_FILE_BYTES`; `contentType` is `video/mp4` for a clip and `application/json`
  for the rest.
- The answer, in the order of `files`: `PUT` the file as a `Blob` to `url` with exactly `headers`
  (`Content-Type`, and on GCS `x-goog-content-length-range: <bytes>,<bytes>`; the browser sets
  `Content-Length`) before `expiresAt` (ms since 1970 on the server's clock, 15 minutes on). The URL
  accepts that content type and that size only; once it has expired, sign again.
- Each call counts against the account's UTC day, `QUOTA_BYTES_PER_DAY` and `QUOTA_FILES_PER_DAY`, a
  file signed again included. A call that does not fit is refused whole, `resource-exhausted`, with
  `details: {used, requested, limits, resetsAtMs}`; the count is in `users/{uid}.quota`, which the
  account can read.
- It records the intent on the attempt's document: `upload.state = 'uploading'` and
  `upload.files[path] = {bytes, doneMs: null}`, for every file signed (one signed again starts again).

### `confirmUpload`

```ts
confirmUpload({ sessionId, attemptIndex, files: [{ path }] })
  → { state: 'uploading' | 'done', confirmed: [{ path, bytes, doneMs }], pending: [path] }
```

After the `PUT`s. Each file must be one of the attempt's upload, `upload.files` (signed, or listed by
the index when it created the attempt; `failed-precondition` otherwise), and be in the bucket with
that size (`not-found` when it is not there, `failed-precondition` when its size differs). It sets
each file's `doneMs` (the server's clock; one already set stays), and `upload.state = 'done'` once
every file of `upload.files` has one. Calling it again changes nothing.

### Errors and logs

`HttpsError` codes: `unauthenticated` (signed out), `invalid-argument` (the request; the message
names the field), `not-found` (the session, the attempt, an object), `permission-denied` (another
account's session or attempt), `resource-exhausted` (the quota), `failed-precondition` (a file not
signed, of another size, or signed again meanwhile), `internal` (anything else, such as a bucket that
cannot sign: the cause is in the function's log, nothing was recorded or counted). Every call is one
structured entry in Cloud Logging: `signUpload: signed` (the account, the attempt, the provider, the
files, the bytes, the quota after), `confirmUpload: confirmed`, `…: refused` with the `code` and the
`reason`, `…: failed` with the `error`.

## Configuration

Parameters (`src/params.ts`), whose values are in `functions/.env`, committed: none is a secret, and a
deploy without prompts needs a value for each. A `functions/.env.<project id>` beside it overrides
them for one project; `functions/.env.local` (gitignored) for the emulator only. One such file is
committed: `functions/.env.demo-cubetrace`, for the emulators' offline project, which gives the
end-to-end suite's bucket (below, "The local bucket") and which deploys neither read nor upload.

| Parameter | Value | |
|---|---|---|
| `BUCKET_PROVIDER` | `gcs` | `gcs` (Google Cloud Storage) or `r2` (Cloudflare R2); `local` in the Functions emulator only |
| `BUCKET_NAME` | `cubetrace-data` | the bucket at the provider |
| `R2_ACCOUNT_ID` | empty | Cloudflare's account id, for R2's endpoint |
| `QUOTA_BYTES_PER_DAY` | `6000000000` | 6 GB signed per account per UTC day |
| `QUOTA_FILES_PER_DAY` | `1200` | files signed per account per UTC day |
| `MAX_FILE_BYTES` | `512000000` | the largest file, 512 MB |

Secrets, with `BUCKET_PROVIDER=r2` only: `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, an R2 API
token's keys, in Secret Manager (`npm run firebase -- functions:secrets:set R2_ACCESS_KEY_ID --project
cubetrace-cacd9`). The CLI finds the functions by loading their code with the values of `.env`, so the
secrets are declared, and bound to both functions, only when it says `r2`: a declared secret must
exist in Secret Manager for a deploy to go through, and a function must not hold secrets it does not
use. The emulator reads them from `functions/.secret.local` (gitignored).

## Building, testing, running locally

- `npm run build -w @cubetrace/functions`: `tsc` into `functions/lib/` (gitignored). `firebase deploy`
  runs it first (`predeploy` in `firebase.json`).
- `npm run lint` type-checks and lints `functions/` with the rest of the repository.
- `npm run test:functions`: the build, then `functions/src/*.test.ts` against the Firestore emulator
  (`firebase emulators:exec --only firestore`, project `demo-cubetrace`, Java 21 or later): the
  requests, the quota, the two functions with the Admin SDK and a fake bucket, both signers checked
  against their signature schemes with made-up keys, the local bucket and its refusal outside the
  Functions emulator, and what a deploy finds in the built code (the functions, the parameters, the
  secrets for each provider).
- The Functions emulator: `npm run build -w @cubetrace/functions && npm run firebase --
  emulators:start --only functions,firestore --project demo-cubetrace` serves
  `http://127.0.0.1:5001/demo-cubetrace/us-central1/signUpload`. For that project the CLI reads
  `.env.demo-cubetrace` after `.env`, so the bucket is the local one (below); `gcs` there could not
  sign without Google credentials, and R2 with made-up keys in `.env.local` and `.secret.local`
  signs but cannot confirm.
- `npm run e2e:cloud`: the end-to-end suite's cloud project, the app's own Firebase SDK against the
  Auth, Firestore and Functions emulators (`docs/TOOLCHAIN.md`, "Cloud end-to-end").

### The local bucket

`BUCKET_PROVIDER=local` (`src/local.ts`) is the end-to-end suite's: its URLs are
`<LOCAL_BUCKET_URL>/<key>?contentType=…&bytes=…&expires=…` on a server on the same machine
(`http://127.0.0.1:4600`, `apps/web/e2e/helpers/bucket-sink.mts`), with GCS's headers
(`Content-Type`, `x-goog-content-length-range`), and the size of an object is read with `HEAD`
there. Nothing is signed: the server holds each `PUT` to what its URL says, as a signature would. It
works only where `FUNCTIONS_EMULATOR` is `true`, which the Functions emulator sets and Cloud
Functions never does: anywhere else every call fails with `internal`, the log saying why, so a
deploy configured with it signs nothing. `LOCAL_BUCKET_URL` is a variable of `.env.demo-cubetrace`,
not a parameter, so that deploys need no value for it.

## Deploying

By the coordinator, the first time (`docs/USER-ACTIONS.md`, phase 3, has the key and its roles):

1. The bucket, its CORS policy and the functions' account's roles (`bucket/README.md`).
2. `npm ci`, then `npm run firebase -- deploy --only functions --project cubetrace-cacd9
   --non-interactive --force`. `--force` sets up the cleanup policy of the functions' container
   images in Artifact Registry (one day), without which a deploy without prompts fails after
   deploying; once it is set, no later deploy needs `--force` (or, after a first deploy without it:
   `npm run firebase -- functions:artifacts:setpolicy --project cubetrace-cacd9 --location
   us-central1 --days 1 --force`).
3. The check of `docs/MANUAL-TESTS.md`, "T3.2": a test account signed in with a custom token, a URL
   signed, a `PUT` of the right size taken and one of another size refused, the upload confirmed.
   `npm run firebase -- functions:log --project cubetrace-cacd9` shows the calls.

From then on `.github/workflows/firebase.yml` deploys the rules and the functions
(`--only firestore:rules,functions`) after each merge that changes them, with the repository secret
`FIREBASE_SERVICE_ACCOUNT`.
