# Architecture

A condensed, public version of the design. The full design with the measurements behind
the choices lives in the owner's private repository.

## Roles and devices

Every device runs the same app. The device that starts a session is the **host**: it holds
the Bluetooth connection to the cube, the timer UI, the host clock, the attempt records
and the upload queue. Any device present, the host included, may run a **camera
pipeline**. So a phone on a pedestal is a host whose only camera is its own front camera;
a laptop with two phones is a host with one local and two remote cameras. Cameras are a
list, empty to many; the data model never assumes which device recorded what.

Chrome only, on Android, macOS and Windows: Web Bluetooth rules out Safari and Firefox.

## Modules

```
apps/web (Angular, PWA)
  timer UI · scramble view (cubing.js twisty-player) · CFOP chart · session list · settings · probe page
  device services: wake lock · storage persistence · browser support (read the browser through the
                   BROWSER_GLOBALS token; fakes in apps/web/src/app/device/fake-browser.ts)
  account (phase 3): AuthService · Firebase (Authentication, Firestore) in a lazy chunk behind
                   ACCOUNT_LOADER (fake in apps/web/src/app/auth/fake-account.ts) · SessionIndexService:
                   the session index in Firestore, the Sessions page's cloud sessions, the QA view
  ──uses──▶ packages/core      cube simulator (Kociemba facelets) · notation · scramble target ·
                               attempt state machine · CFOP phase detector · clock fits · data model · fake cube
  ──uses──▶ packages/gan       GAN driver wrapper (Web Bluetooth) → typed CubeEvent stream; MAC provider
  ──uses──▶ packages/capture   (phase 2) camera · capture worker: MediaStreamTrackProcessor → VideoEncoder → ring buffer → cut ·
                               clip worker: mediabunny MP4 + frames.json → OPFS · motion and clapperboard (the sync check)
  ──uses──▶ packages/storage   (phase 1: OPFS staging of sessions; phase 3: upload queue with signed URLs)
```

`packages/*` are plain TypeScript, tested in Node with Vitest, and never import Angular.
The app is the shell: components, routing, PWA, settings persistence.

## The attempt state machine (core)

```
idle ──scramble shown──▶ scrambling ──state == target──▶ armed ──first move──▶ solving ──state solved──▶ solved
                             │ mis-scramble: undo guidance, stays scrambling                      │
                             ◀─────────────────────────── auto-advance: next scramble ─────────────┘
```

Inputs are cube events (moves with cube and host time, facelets, battery, gyro) and app
actions (skip scramble, mark DNF, delete last). Outputs are the events of §3 of the data
model and, on `solved`, a complete `attempt.json` with phases. The machine is pure and
synchronous so it can be unit-tested by replaying fixtures through it.

## Time

All timestamps are host milliseconds. Cube time is mapped by a linear fit of (cubeMs, hostMs) pairs
per attempt (docs/DEVICES.md). Remote phones (phase 4) are mapped by a data-channel ping protocol;
video frames carry their own timestamps and their arrival time in the capture worker; a
"clapperboard", one face flicked and flicked back five times at session start, measures each camera's
constant latency. See the private design for the measurements and the reasoning.

## Capture (phase 2)

```
camera ─▶ MediaStreamTrackProcessor (window) ─▶ capture worker: encoders ─▶ ring buffer (90 s, 160 MB) ─▶ cut
                                                          └─ motion in the framing rectangle (sync check)
cut ─▶ MessageChannel ─▶ clip worker: mediabunny MP4 + frames.json ─▶ OPFS ─▶ attempt.json video[]
```

`packages/capture` is plain TypeScript around two module workers. On the window, the camera is
opened with its constraints and manual controls (snapshots go into `session.json`), and its preview
measures the frame rate and the sharpness of the framing rectangle, at most twice a second and never
during a solve; the microphone is opened raw, without the browser's voice processing, which takes a
cube's clicks for noise (what the browser applied goes into `session.json` too, T2.12). The camera's and the microphone's `MediaStreamTrackProcessor` streams (Chrome has
them on the main thread only) are transferred to the **capture worker**, which encodes without
pause: H.264 High, else Main, hardware first, else VP9 (Chromium without proprietary codecs, as in
CI), at the bitrate of the video quality chosen in Settings (4 Mbps at 1080p30 by default); AAC,
else Opus, else no sound; a keyframe every second; frames dropped and counted when more than 8
wait in the encoder. The chunks, each with its frame's own timestamp and its arrival on the
host clock, fill a ring buffer bounded by 90 s and 160 MB and evicted by whole GOPs, so that it
always starts at a keyframe. When the timer's milestones say a segment of an attempt is over, the
recording asks for its cut 1.25 s after its end: the scramble from 2 s before its first turn (at
most 60 s before the state matched) to 1 s after the state matched, the solve from 3 s before its
first turn to 1 s after solved or the DNF, each from the keyframe at or before its start, or from
the oldest one in memory when its start is older, the clip then marked `truncatedStart`. The capture
worker copies the cut's chunks and passes them over a `MessageChannel` to the **clip worker**, which
muxes them into MP4 with mediabunny, without re-encoding, and writes the clip and its `frames.json`
(the first frame's host time from the median arrival offset over the clip, then each frame's
interval from the timestamps) into the attempt's OPFS folder under temporary names moved into place;
the clip is then added to the attempt's `video` in `attempt.json`, whose timing it never changes,
and a clip that fails is noted in `session.json`, as is a clip that begins late or has no sound
while the sound is recorded (with why: the capture worker follows its audio, from the microphone's
first `AudioData` to the encoder's chunks and their decoder config, and places audio whose
timestamps count on another clock than the frames' by the arrival times).
The **sync check** runs once per session and camera: the capture worker measures
the motion inside the framing rectangle of each frame (the share of a 320- or 160-pixel luma plane,
read with `VideoFrame.copyTo`, that changed by more than 12 levels), the clapperboard finds the
middle of each single cube turn's motion in the frames around it, against the picture just before it,
and the median lag of the turns kept (the fifth farthest from the median left out of the spread)
becomes the camera's `offsetMs` in `clock.cameras` and the `syncResidualMs` of its later clips.
Idle time is never stored. Remote cameras (phase 4) will cut the same way and ship their clips over
the WebRTC data channel; phase 3 uploads them.

## Account (phase 3)

An account is optional: the app works signed out as before, and a device that never signs in never
downloads Firebase. `AuthService` (`apps/web/src/app/auth/`) reaches Firebase through
`ACCOUNT_LOADER`, a dynamic import of `firebase-sdk.ts`, the only file that imports the SDK (12.x,
modular: `firebase/app`, `firebase/auth`, `firebase/firestore`): one lazy chunk,
`firebase-sdk-<hash>.js`, which the service worker leaves out of the app's prefetched files and
caches once it is used (the `account` group of `ngsw-config.json`). It loads on Sign in, and as the
app starts when a sign-in is remembered (`localStorage` `cubetrace.account`, set on sign-in and
removed on sign-out).

```
Sign in ─▶ ACCOUNT_LOADER (the lazy chunk) ─▶ Google's page: a popup (a laptop, a phone's browser tab)
                                              or a redirect (the app installed on Android, read at
                                              the next start) ─▶ the account
start with a sign-in remembered ─▶ ACCOUNT_LOADER ─▶ the account kept in IndexedDB (offline too)
the account ─▶ users/{uid} merged: the account, this device's host label and host clock (not awaited)
```

Firebase Authentication keeps the account in IndexedDB; Firestore keeps a persistent cache in
IndexedDB, shared by the app's tabs, into which writes go first: offline they wait there, across
reloads, until the network is back, and the page never waits for the server. The header shows the
account (its photo or initial and its name, a menu with Sign out) or Sign in, and Settings → Account
the same with what went wrong; a failure (the popup closed or blocked, no network, the chunk not
available offline) is kept in `AuthService.status` and `error`, never thrown to the page. The unit
tests give `AuthService` a fake of the backend; the end-to-end suite gives the dev server's app one
through the window (development builds only), so that no test reaches Google.

The rules (`firebase/firestore.rules`, `docs/DATA-MODEL.md` §10): an account reads and writes only
its own `users/{uid}` and the sessions, and their attempts, whose `owner` is its uid; nothing is
public. They are tested against the Firestore emulator in CI and deployed on merge by
`.github/workflows/firebase.yml`. The service worker has no data group, so it caches nothing of
Google's or Firebase's: it passes their requests through (one that fails reaches the SDK as a 504,
which it reads as a network error), and Google's sign-in page and its helper frame are on
`cubetrace-cacd9.firebaseapp.com`, outside its scope.

A redirect comes back through that helper frame, on another site than the app's: browsers that
partition third-party storage, Chrome since version 115 among them, can keep the outcome from the
app, which then says that signing in did not finish. If the installed app on the phone meets it
(manual round 3), the fix is to serve the helper from the app's own site (Firebase's
"signInWithRedirect best practices") or to use the popup there too.

## Session index (T3.1)

With an account signed in, the sessions and attempts of every device are indexed in Firestore
(`docs/DATA-MODEL.md` §10): `sessions/{id}`, a session's record with its owner, and
`sessions/{id}/attempts/{index}`, an attempt's record without its moves, with its device and the state
of its upload. `SessionIndexService` (`apps/web/src/app/cloud/`) wraps the session store of
`SessionService`, so that each save of a record, once the record is in the origin private file system,
also writes its document, which no save waits for:

```
SessionService ─▶ the store (OPFS) ─▶ saved ─▶ SessionIndexService: one operation after the other
                                                ├─ demo session (simulated cube): nothing
                                                ├─ no account (signed out, or still loading): the session
                                                │  leaves the device's list of indexed sessions
                                                └─ account ─▶ AccountBackend ─▶ Firestore's cache (IndexedDB)
                                                              ─▶ the server, when online; a refusal ─▶ the
                                                              session's notes ("cloud: …"), once per session
sign-in, or a start signed in ─▶ catch-up: the device's sessions not in the account's index, the
                                 oldest first, each with its attempts in one batch, ≤ 300 documents
```

Offline, the writes wait in Firestore's persistent cache, across reloads, and go when the network is
back; the queries of the Sessions page, a session's page and the QA view read the cache then, with
the device's unsent writes in it (`pending`), and say they did (`fromCache`). The device keeps, by
account, which of its sessions are all in the index (`localStorage` `cubetrace.sessionIndex`), so
that the catch-up looks only at what a sign-out or a refusal left out: a session changed while no
account was signed in leaves that list, and the next catch-up writes it whole, after asking the index
which of its attempts are there already. An attempt's document is created with its `upload`, all
pending; the app's later writes of it (a clip attached, the catch-up) leave `upload` to the upload's
functions ("Uploads", below), and the rules refuse the app's changes to it. The rules hold every
document to its owner and its shape (an attempt without moves); the
sessions query (`where('owner', '==', uid)`, newest `createdMs` first) has a composite index of its
own (`firebase/firestore.indexes.json`). The Sessions page merges the device's sessions with the
account's 100 newest from the index, by id ("this device", "cloud", "both"), a session of the cloud
alone opening a read-only page (its clips and moves are on the device that recorded it); `/qa` counts
the attempts of the 50 newest sessions by day and device. Signed out, none of it reads or writes
anything, and the pages are as before.

## Storage (phase 3)

Cloud-first: every device stages sessions locally and uploads them; Firestore is the index
that merges sessions from every host into one dataset; files live in an object-storage
bucket reached through signed URLs minted by a Cloud Function. The bucket provider (Google
Cloud Storage or Cloudflare R2) is a deployment configuration, not a code decision.

## Uploads (phase 3)

The browser puts the files straight into the bucket; two callable Cloud Functions in `us-central1`
(`functions/`, `functions/README.md`) decide what it may put there and record what arrived, in
Firestore through the Admin SDK:

```
upload queue (T3.3) ─▶ signUpload({sessionId, attemptIndex, files: [{path, bytes, contentType}]})
                         a signed-in account; its session and attempt in the index; the dataset's file
                         names, each with its content type, at most 512 MB; a PUT URL signed per file
                         (15 min, the type and the exact size bound); then one transaction: the day's
                         quota reserved in users/{uid}.quota, the intent in the attempt's upload
                    ◀─ [{path, url, headers, expiresAt}]
                    ─▶ PUT each file to its URL, with its headers ─▶ the bucket
                    ─▶ confirmUpload({sessionId, attemptIndex, files: [{path}]})
                         each object found with the size signed ─▶ upload.files[path].doneMs,
                         upload.state done once every file is ◀─ {state, confirmed, pending}
```

Objects are keyed under the account, `users/{uid}/sessions/{id}/attempts/{index}/<file>` (and the
session's `session.json` beside its attempts), so a URL can only ever write into its signer's own
prefix; the bucket is private, and nothing but these URLs writes to it.

**Providers.** `BUCKET_PROVIDER`, a parameter in `functions/.env`, picks the bucket behind one port
(`ObjectStore`: sign a `PUT`, read an object's size): `gcs`, Google Cloud Storage, `cubetrace-data`
in `us-central1`, during the free trial, with V4 signed URLs that the functions' service account
signs through the IAM Credentials API; `r2`, Cloudflare R2, later, with S3 SigV4 presigned URLs
against `https://<account>.r2.cloudflarestorage.com`, whose two keys are secrets bound to the
functions only then. Either way the signature binds the content type and the exact size (GCS:
`x-goog-content-length-range`; R2: `content-length`, which the browser sets from the body), so an
upload can be neither of another type nor longer than what the quota counted, and the bucket's CORS
policy (`bucket/`) lets the app's origins send those headers.

**Quota.** Per account and UTC day, the bytes and the files signed (2 GB and 400 by default,
parameters): `users/{uid}.quota = {day, bytes, files}`, reserved in the same transaction that records
the intent, every signature counted, a call that does not fit refused whole with when the day resets.
It is a ceiling on what a runaway client can cost while there is one solver, not the community quotas
of phase 5. The URLs are signed before the transaction, so a bucket that cannot sign counts nothing.

**What the index says.** The attempt's `upload` (`docs/DATA-MODEL.md` §10) goes `pending` (T3.1) →
`uploading` (signUpload) → `done` (confirmUpload, every file there with its size); a file signed again
starts its attempt again. Errors are `HttpsError` codes the queue can act on (`resource-exhausted`
waits for the next UTC day, `not-found` for an attempt Firestore has not sent yet), and every call is
one structured entry in Cloud Logging.
