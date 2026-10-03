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
  timer UI · scramble view (cubing.js twisty-player) · CFOP chart · session list · settings · probe page ·
  clip viewer (a clip's video, its moves by time, and a 3D cube that follows it: cubing.js in 3D, T3.8;
               its view and mirror per camera, T3.10)
  device services: wake lock · storage persistence · browser support (read the browser through the
                   BROWSER_GLOBALS token; fakes in apps/web/src/app/device/fake-browser.ts)
  account (phase 3): AuthService · Firebase (Authentication, Firestore, Functions) in a lazy chunk behind
                   ACCOUNT_LOADER (fake in apps/web/src/app/auth/fake-account.ts) · SessionIndexService:
                   the session index in Firestore, the Sessions page's cloud sessions, the QA view ·
                   UploadService: the upload queue, from a lazy chunk of its own, its panel and indicator ·
                   CubeSyncService: Settings' cube MAC addresses merged with the account's (T3.4) ·
                   ViewerSyncService: the clip viewer's view and mirror per camera merged with the account's (T3.10) ·
                   DiagnosticsService: the app's own log of its use, in the account (T3.9)
  ──uses──▶ packages/core      cube simulator (Kociemba facelets) · notation · scramble target ·
                               attempt state machine · CFOP phase detector · clock fits · data model · fake cube
  ──uses──▶ packages/gan       GAN driver wrapper (Web Bluetooth) → typed CubeEvent stream; MAC provider
  ──uses──▶ packages/capture   (phase 2) camera · capture worker: MediaStreamTrackProcessor → VideoEncoder → ring buffer → cut ·
                               clip worker: mediabunny MP4 + frames.json → OPFS · motion and clapperboard (the sync check)
  ──uses──▶ packages/storage   OPFS staging of sessions (the session store, atomic writes, tolerant reads)
  ──uses──▶ packages/upload    (phase 3) the upload queue: an attempt's files into the bucket through
                               signed URLs, retried, throttled, its state in uploads.json; clips deleted by policy
  ──uses──▶ packages/rtc       (phase 4) the connection to a remote camera: the data channel's protocol · the file
                               transfer (paced, resumable, checked) · the clock sync's pings · the pairing token ·
                               the signaling over Firestore · WebRtcTransport; fakes of the transport and the signaling
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

**What the cube's events become** (T3.7, the cube's whole record; `docs/DATA-MODEL.md` §6, §7,
§11). Everything the driver decodes is kept now, to be trimmed later if useless:

```
GAN driver ─▶ GanEventMapper ─▶ CubeService.events$ ─▶ SessionService
  move (serial, cube and host time, packetLast) ─▶ AttemptMachine ─▶ attempt.json moves[] (with serial, packetLast)
  facelets that differ from the machine's state ─▶ resync ─▶ attempt.json resyncs[] (the state adopted, when, in which state)
  gyro (quaternion, Gen2 velocity) ─▶ GyroBuffer (10 min, typed arrays, no allocation) ─▶ pickup detection, and
       1 s after the attempt ─▶ gyro.json (2 s before the first turn to 1 s after the end) + attempt.json gyro
  battery (level, host time) ─▶ session.json battery[] (equal levels coalesced)
  hardware (model, versions, gyro, production date) ─▶ session.json cube
every JSON file ─▶ app: the build that wrote it (session.json, attempt.json, frames.json, gyro.json)
```

The gyro file waits for its window's end margin as the clips do, with or without a camera, and
`ClipsInFlight` holds the attempt back from the upload queue meanwhile; it goes to the bucket as the
attempt's sixth file and stays on the device with the frames files when the clips are deleted by
policy. The fake cube reports a gyroscope when asked (`?gyro=1` in demo mode), for the end-to-end
suite.

## Time

All timestamps are host milliseconds. Cube time is mapped by a linear fit of (cubeMs, hostMs) pairs
per attempt (docs/DEVICES.md). Remote phones (phase 4) are mapped by a data-channel ping protocol
(`docs/RTC.md` §4: the host pings every 2 s, the offset from the samples of least round trip, a drift
fit once they span a minute, `RemoteClockFit` in core; the fit's record in `session.json` as
`clock.cameras[label].remote`); video frames carry their own timestamps and their arrival time in
the capture worker; a "clapperboard", one face flicked and flicked back five times at session start,
measures each camera's constant latency. See the private design for the measurements and the
reasoning.

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
The **sync check** runs once per session and camera (each device of a session has a label of its
own, `laptop`, `laptop-2`…, which names its clips and its check, T2.14): the capture worker measures
the motion inside the framing rectangle of each frame (the share of a 320- or 160-pixel luma plane,
read with `VideoFrame.copyTo`, that changed by more than 12 levels), the clapperboard finds the
middle of each single cube turn's motion in the frames around it, against the picture just before it,
and the median lag of the turns kept (the fifth farthest from the median left out of the spread)
becomes the camera's `offsetMs` in `clock.cameras` and the `syncResidualMs` of its later clips.
Idle time is never stored. Remote cameras (phase 4) will cut the same way and ship their clips over
the WebRTC data channel; phase 3 uploads them.

## Remote cameras (phase 4)

A phone joins a session as a camera (`docs/PLAN.md`, the phase 4 board; the contract in
`docs/RTC.md`): the same app on a page of its own, the capture pipeline above running on the phone,
and one `RTCPeerConnection` to the host with a reliable ordered data channel, made with Google's
public STUN server and no TURN (the two devices on one Wi-Fi). T4.0 built what needs no page,
`packages/rtc`; the pages, the services and the cuts come with T4.1–T4.3:

```
host (the session's device)                                                 phone (the camera device)
show the QR: the token's hash in sessions/{id}.pairing  ─ ─ ─ ─ ─ ─▶  checkPairing, then call(): the offer
FirestoreSignaling.watchOffers ◀── sessions/{id}/peers/{peerId} ──▶  (offer, answer, candidates: Firestore,
answer, candidates                                                    the AccountBackend's few calls)
WebRtcTransport (callee) ◀══════ the data channel ══════▶ WebRtcTransport (caller)
MessageLink: hello ─▶ ClockPinger ─▶ RemoteClockFit ◀─ pong ◀─ answerPings; state, thumbnail ◀─ the phone
cut (the window in the phone's clock) ─▶                             the ring buffer cut, muxed, staged
FileReceiver ◀── file-begin / chunks / file-done ◀── FileSender       64 KB chunks under a 256 KB threshold,
  ──▶ file-resume / file-ack ──▶                                        resumed by offset, CRC-32 checked
the attempt's folder: <label>.<segment>.mp4 + frames.json (times converted to the host clock) ─▶ upload
```

The host decides everything the dataset needs: the cuts' windows (converted into the phone's clock
with the fit, and back when the frames file comes), the labels (`labelFor`, as for any camera, with
`remote` naming the device), the records, the upload. The phone only films, cuts, stages and sends;
what it misses is a missing clip, never a lost attempt. Everything of `packages/rtc` but
`WebRtcTransport` is plain TypeScript tested in Node: the transport and the signaling are interfaces
with in-memory fakes (`MemoryTransport.pair` with a delay, a bandwidth and losses; `MemorySignaling`
over `MemorySignalingBackend`), so that T4.1's services are unit-tested without WebRTC and the fast
end-to-end suite pairs two pages of one browser through a `BroadcastChannel` signaling.

## The clip viewer

The solve lists' clip badges open the viewer (`apps/web/src/app/timer/clip-viewer.ts`, a modal
dialog on the Timer and the session pages): it reads the clip's MP4 from the attempt's folder
(`ATTEMPT_FILES`, behind an object URL let go when the dialog closes) and lists the segment's moves
by their time into the clip, the one on screen highlighted. Since T3.8 a 3D cube follows the video,
under it since T3.10 (as wide as the video and about half as tall; on a phone the video, the cube,
then the moves):

```
attempt.json moves[] ──▶ clipMoves: seconds = (hostMs + lag − firstFrameHostMs) / 1000      lag = the clip's syncResidualMs
gyro.json ──parseGyro──▶ GyroTrack (sample times, quaternions)                                 (0 before a sync check)
video frame at t ──▶ host time firstFrameHostMs + t·1000 − lag
   ├─▶ the last move at or before it ──▶ ClipCube.show: one move on, animated (experimentalAddMove, tempo 5: ~100 ms);
   │                                      a seek or several moves ──▶ alg = the moves so far, timestamp end
   └─▶ orientationAt (binary search, slerp) ──▶ conj(reference) · q ──▶ cubing.js's frame ──▶ mirrored ──▶ Object3D.quaternion, scheduleRender
the clip's camera label ──▶ SettingsService.viewerChoiceFor: {latitude, longitude, mirror} ──▶ ClipCube.view (the player's orbit), the mirror above
a drag of the cube ──▶ the model's orbitCoordinates ──▶ ClipCube.onDrag ──▶ setViewerChoice ──▶ (signed in) ViewerSyncService ──▶ users/{uid}.viewer
```

The cube is cubing.js's `<twisty-player>` in 3D (no control panel, no hint facelets, a transparent
background, cubing.js's own drag input on), from the scramble view's lazy chunk (`TWISTY_LOADER`),
its 3D code a further lazy chunk that cubing.js loads itself. The solve clip's cube starts from the scramble (the
setup alg; `scrambledFacelets` by definition), the scramble clip's from solved, its moves including a
mis-scramble's corrections. The viewer follows the video on every frame while it plays
(`requestVideoFrameCallback`, else an animation frame) and on `timeupdate`, `seeked` and `pause`; the
same mapping times the moves list, so the highlighted move and the 3D turn agree with the picture,
the camera's lag applied to both (`docs/DATA-MODEL.md` §7: the picture at `t` shows the world `lag`
earlier). The orientation (core's `orientation.ts`, pure) is the gyro sample at that host time, slerped
between its neighbours along the shorter arc, the first or last sample beyond the file's span and
nothing before a truncated file's first sample; shown relative to the sample at the clip's first
frame (`conj(q_ref) · q`: the cube starts upright and moves as the hands moved it, whatever the
gyro's yaw reference, which is arbitrary and drifts), or to the sample at the current time after
"Re-zero", or raw with the "Raw" box; then carried from the cube's frame (+X red, +Y blue, +Z white)
into cubing.js's (+X R, +Y U, +Z F) by one constant, a rotation of −90° about X (`CUBE_TO_PLAYER`);
then seen in the camera's mirror, if one is chosen (`mirrored`, T3.10: a reflection across the plane
normal to the viewer's X, Y or Z, or all three, turns a rotation about an axis by θ into one about
the reflected axis by −θ, `(x, −y, −z, w)` for left–right, `(−x, y, −z, w)` for up–down, `(−x, −y,
z, w)` for front–back, the conjugate for all). The puzzle's three.js object comes from
`experimentalCurrentThreeJSPuzzleObject()` and the render from the vantages' `scheduleRender()`,
only when the orientation changed. Without a gyro file (an older attempt, a cube without a
gyroscope) the cube still turns and a line says the orientation is not recorded; a file that cannot
be read is said in that line; a clip in the cloud has no cube. Per frame the loop costs one scan of
the segment's moves, one binary search over the samples, one slerp and one render; nothing runs once
the dialog closes. There is no live 3D cube on the Timer page, by decision: the solver watches the
real cube, and WebGL would compete with the capture pipeline.

**The view (T3.10, issue #55).** The player's camera looks at the cube straight on by default: level
with it and in front (`camera-latitude` and `camera-longitude` 0, where cubing.js looks from 35°
above and 30° to the right, which drew an upright cube tilted), at `camera-distance` 5 (6 by default:
a fifth larger, every corner still in the 20° of vertical field), with `camera-latitude-limit` 90, so
that an upright cube is drawn upright and a tilt to the right shows to the right. Under the cube,
in one wrapping row: Turn ◀ ▶ (90° of longitude), Tilt ▲ ▼ (90° of latitude, within ±90°), Behind
(longitude 180°), Reset view (0, 0), and the Mirror select; each preset is one request of the
player's model (`experimentalModel.twistySceneModel.orbitCoordinatesRequest.set`, both angles at
once, from where the camera is or is on its way to). The cube can be dragged with the mouse or a
finger (`experimental-drag-input="auto"`; a click adds no move, the player's move-press input being
off), and `ClipCube` reads the orbit back from the model (`orbitCoordinates`' fresh listener),
telling the user's drags from the echoes of its own requests, so that the viewer keeps the orbit
where a drag leaves the camera, to a tenth of a degree. The view and the mirror are kept per camera
label (the clip's `camera`): on the device in Settings (`viewer`, at most 8 cameras, the oldest
first; a camera without one has the defaults, which are never stored) and, signed in, in the account
(`users/{uid}.viewer`, `docs/DATA-MODEL.md` §10) by `ViewerSyncService`
(`apps/web/src/app/cloud/viewer-sync.ts`, made by the header's controls as the cube sync is): at
each sign-in and start signed in the record is read once and the choices merged (the device's for
the cameras it has set, the account's for the others), the account written what it lacks; from then
on each change is written a second after the last (a drag is one write), a merge of the cameras
changed, never awaited; a refusal is said once, and a write lost with the page is made up by the next
start's merge. Re-zero and Raw are per clip and never kept. The calibration (`docs/MANUAL-TESTS.md`,
"After T3.10"): pause where the cube is square to the camera and Re-zero; if tilts go the other way,
a mirror; turn the view for a camera behind or beside the cube. A slice move (M, S, E) is a check of
the orientation: the cube reports a slice as two opposite outer-layer turns relative to its core
(`docs/DATA-MODEL.md` §2) while the core itself rotates with the middle layer, which the gyro
records, so that shown together the two turns and the core's rotation reproduce the middle layer
turning in space, and outer layers that seem to turn mean the orientation shown is off (or lags the
turns' animation).

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
Sign in ─▶ ACCOUNT_LOADER (the lazy chunk) ─▶ Google's page in a popup (a laptop, a phone's browser
                                              tab; over the app installed on Android, a Custom Tab
                                              that closes itself) ─▶ the account
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
through the window (development builds only), so that no test reaches Google, and its cloud project
runs the app's own SDK against the Firebase emulators ("Testing the cloud", below).

The rules (`firebase/firestore.rules`, `docs/DATA-MODEL.md` §10): an account reads and writes only
its own `users/{uid}` (with the clip viewer's choices in it, T3.10) with its cubes (T3.4), and the sessions, and their attempts, whose `owner` is
its uid; nothing is public. They are tested against the Firestore emulator in CI and deployed on merge by
`.github/workflows/firebase.yml`. The service worker has no data group, so it caches nothing of
Google's or Firebase's: it passes their requests through (one that fails reaches the SDK as a 504,
which it reads as a network error), and Google's sign-in page and its helper frame are on
`cubetrace-cacd9.firebaseapp.com`, outside its scope.

The popup is the one sign-in flow, in the installed app too (T3.6). Until it, the app installed on
Android signed in with a redirect, whose outcome comes back through that helper frame, on another
site than the app's, and browsers that partition third-party storage (Chrome since 115, Safari
16.1, Firefox 109) keep it from the app: manual round 3 met exactly that on the ThinkPhone (issue
#50, "Signing in did not finish: Google sent the page back without an account"). Of the fixes
Firebase lists ("Best practices for using signInWithRedirect on browsers that block third-party
storage access"), the ones that put the helper on the app's own domain (the app's domain as the
`authDomain`, a reverse proxy of `/__/auth/`, the helper's files served with the app) need a host
other than GitHub Pages; the popup passes its outcome from Google's window to the app's by messages,
not through the helper frame's storage (the owner's laptop, the same Chrome with the same
partitioning, signs in with it already), and Chrome on Android opens it from an installed app as a
Custom Tab over the app, which closes itself when Google is done, so the installed app signs in as a
tab does. If the popup is blocked, or closed before Google is done, in the installed app (display
mode `standalone`), the message says to sign in once in Chrome itself, at the app's address, and to
open the installed app again: Chrome's installed apps share the site's storage with Chrome's tabs,
so the account that Firebase keeps in IndexedDB, and the `localStorage` that remembers it, are the
installed app's too. A `redirect` value of `cubetrace.account` left by 0.3.0 is removed at start,
without loading Firebase.

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

## The account's cubes (T3.4)

The cubes' MAC addresses that Settings keeps (Settings → Cube MAC addresses, and the connect
dialog's "Remember it for this cube", for Chrome without the flag that reads them) are the account's
too: `users/{uid}/cubes/{name}`, one document per cube by its Bluetooth name (`docs/DATA-MODEL.md`
§10), so that an address typed on the phone is known on the laptop. `CubeSyncService`
(`apps/web/src/app/cloud/cube-sync.ts`) does it, made by the header's controls on every page, in the
lazy chunk of the account's code (the initial bundle is unchanged); `cube-merge.ts` beside it is the
merge, as pure functions:

```
sign-in, or a start signed in ─▶ listCubes(uid): the server's documents, or the cache's offline
  ─▶ mergeCubes(Settings' list, the documents, what this device knows the server holds)
       the union by name, ignoring case; of two copies the later updatedMs (equal: the account's);
       missing on one side in a version the server held: deleted there, so deleted on the other
  ─▶ SettingsService.setCubeMacs(the merged list) ─▶ cubeChanges ─▶ saveCube, deleteCube
a change of the list (Settings, the connect dialog) ─▶ cubeChanges ─▶ saveCube, deleteCube
  (never awaited) ─▶ Firestore's cache ─▶ the server, when online ─▶ its confirmation ─▶ what this
  device knows the server holds (localStorage cubetrace.cubeSync, per account)
```

Each entry of Settings' list has `updatedMs`, when it last changed (the stored settings are version
2; an entry stored before gets the time it is first read), and an edit is dated later than the entry
it replaces, even one dated by a clock running ahead, so that an edit wins over the copy it changed.
The device remembers, per account, each document's `updatedMs` as the server last held it to its
knowledge: an entry missing on one side in a version the server held was deleted there, while one in
a version it never held is new. A listing from the cache (offline) adds what it holds and deletes
nothing. Writes go through Firestore's persistent cache, as the session index's do: nothing waits
for them, and offline they wait there, across reloads. Settings → Cube MAC addresses says "Synced
with your account" with the time of the last merge with the server, a merge under way, or the
changes still to be sent, and what went wrong (a refusal, a document of another version, a name that
cannot be an id), which the console has once. Signed out, nothing is read or written, and the list
is the device's. The addresses never reach the dataset: no record holds one, so no export, upload or
document of the session index does.

## Diagnostics (T3.9)

The app records what `docs/MANUAL-TESTS.md` asked the owner to write down, as events in the
account (`users/{uid}/events`, `docs/DATA-MODEL.md` §10; the catalogue and the checklists' mapping in
`docs/DIAGNOSTICS.md`), so that the coordinator's round report, not the owner's notes, is the
evidence of the manual rounds. `DiagnosticsService` (`apps/web/src/app/diagnostics/`), made on
every page load by the header's controls, is a sink the services write into where they know a fact;
it never throws and never waits:

```
the services ─▶ record(kind, data, scope?) ─▶ cloudEvent: the facts sanitized (texts cut and scrubbed of
  CubeService: cube.connected / failed /       MAC addresses and emails, ≤ 32 of them), the session and
    disconnected / reset                        attempt under way (SessionService keeps them)
  SessionService: session.started, attempt.done   ├─ signed out: a ring of the last 500, written at a sign-in
    (once the clips and gyro file are in),        │  during the page's life, gone with the page
    attempt.deleted, cube.resync, session.deleted ├─ the setting off: one last settings.changed, then nothing
  CameraService, RecordingService: camera.on /    └─ signed in: the queue ─▶ one batch 5 s after its first
    switched / off, recording.started / stopped /       event, at 20, when the page hides or goes away
    notice, clip.saved / failed, audio.missing           ─▶ AccountBackend.saveEvents (writeBatch) ─▶ Firestore's
  SyncService: sync.check                                cache ─▶ the server (a refusal: said once, dropped)
  UploadService: upload.state / paused / resumed, storage.deleted     at most 2,000 a local day per device
  CubeSyncService: cubes.synced (a count)                             (localStorage), then error.* alone
  AuthService: account.signin / signout; the pages: clips.viewed, download; every console `cubetrace:` warning: error.app
the service itself: app.start (the build last seen on the device: the update evidence), page.viewed (the
  router), settings.changed (the settings the checklists name), wake.lock, storage.persistence, network.changed
```

The rules let only the account's own devices create the events, and only the account read them;
nothing updates or deletes one. The QA view sums the last 500 (per device, by kind over the last
days, the failures); `npm run round-report`, with a service-account key the coordinator holds, prints
the checklists of `docs/MANUAL-TESTS.md` with ✅ ⬜ ❗ and the facts, and the owner looks only at what
no event can show. Signed out, nothing leaves the device, as everything else.

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
policy (`bucket/`) lets the app's origins send those headers. A third provider, `local`, is the
end-to-end suite's bucket on the same machine, in the Functions emulator only ("Testing the cloud").

**Quota.** Per account and UTC day, the bytes and the files signed (6 GB and 1,200 by default,
parameters): `users/{uid}.quota = {day, bytes, files}`, reserved in the same transaction that records
the intent, every signature counted, a call that does not fit refused whole with when the day resets.
It is a ceiling on what a runaway client can cost while there is one solver, not the community quotas
of phase 5. The URLs are signed before the transaction, so a bucket that cannot sign counts nothing.

**What the index says.** The attempt's `upload` (`docs/DATA-MODEL.md` §10) goes `pending` (T3.1) →
`uploading` (signUpload) → `done` (confirmUpload, every file there with its size); a file signed again
starts its attempt again. Errors are `HttpsError` codes the queue can act on (`resource-exhausted`
waits for the next UTC day, `not-found` for an attempt Firestore has not sent yet), and every call is
one structured entry in Cloud Logging.

**The queue (T3.3).** `packages/upload` is plain TypeScript over three ports, tested in Node with
fakes: the device (`UploadSource`: the session store, the attempts' files and `uploads.json` in the
origin private file system, and the deletion of a clip), the cloud (`UploadCloud`: the index's
`upload` of a session's attempts, `waitForPendingWrites`, and the two functions) and the PUT
(`UploadHttp`: `XMLHttpRequest`, for the upload's progress and to send a file of the origin private
file system without reading it into memory), with the device's clock, storage, network and Web Lock
beside them (`UploadEnvironment`). In the app, `UploadService` (`apps/web/src/app/upload/`) loads it,
from a lazy chunk of its own (`upload-runtime-<hash>.js`, a lazy group of the service worker), only
once an account is signed in with Settings → Uploads → Upload sessions on, and stops it on sign-out;
the header's indicator, a deferred block that only a signed-in account loads, makes the service.

```
the store's writes (SessionChanges) ──▶ UploadQueue ◀── the recording: an attempt's clips still to come (ClipsInFlight)
start: the Web Lock (one tab uploads) ─▶ uploads.json ─▶ the device's sessions, the oldest first
        (a session of a real cube; never a demo session's)
per attempt, once its record is final (solved or DNF, its clips saved or known absent):
  attempt.json (the record without local) · each clip's MP4 and frames file · session.json, riding along
  ─▶ wait for the index's writes (the session index's queue, then waitForPendingWrites)
  ─▶ signUpload: the attempt's files still to send, in one call, right before they go
  ─▶ PUT, two at a time, each as a Blob with exactly the headers signed ─▶ confirmUpload ─▶ done
  ─▶ uploads.json (100 ms after a change, at once on pagehide)
```

- **What goes.** Per attempt its `attempt.json` (the record as the store writes it, without the clips'
  `local`), each clip's MP4 and frames file, its `gyro.json` when it has one (T3.7, after the clips:
  the sixth file with one camera), and the session's `session.json`, which rides with the
  newest of its attempts still to send, again whenever it changed since it was last confirmed, once
  it has stayed the same for two minutes: every attempt changes its summary, so a session being
  recorded sends it in its pauses and at its end rather than with every attempt (each upload of it is a
  file of the day's quota). An attempt waits until its record is final: the recording says which
  attempts still have a clip, or a gyro file, to come (`ClipsInFlight`). Never a demo session (a
  simulated cube), never anything signed out, and nothing but the records, the clips and the gyro
  files: no cube MAC address, no setting.
- **Order and throttling.** The oldest session first, its attempts by index, an attempt's files in
  their order; two PUTs at a time. A file is signed right before it goes, with its attempt's other
  files still to send in the same call (the quota counts every signature); a signature is used until a
  minute before its 15 minutes are up, then signed again.
- **Failures.** A try that the network or the server failed (no response, a 5xx, a 408, a 429, a
  function's transient code) is tried again after 1 s, 2 s, 4 s, … up to 5 minutes, each less a random
  share of up to half of it; an attempt the index has not received yet (`not-found`) waits the same way.
  Any other 4xx fails the file until Retry (the Sessions page), but for a URL that expired, which is
  signed again once. A confirmation that failed is asked again before the file is sent again.
  `resource-exhausted` pauses the queue until the day resets (`resetsAtMs`, at least a minute), across
  reloads. Offline, or off Wi-Fi with "Wi-Fi only" (where the browser says the network's type,
  `navigator.connection`), nothing is sent: the PUTs under way are cut off and wait, without counting
  as failures.
- **Resumption.** `uploads.json` (`docs/DATA-MODEL.md` §10) keeps each file's state with its size, its
  tries and its last error, so that a reload resumes where the queue was: a file being sent when the
  page went is confirmed first (its PUT may have finished), and sent again only when the bucket does
  not have it. For an attempt the file does not know, or not as all done, the index's `upload` says
  what the bucket has (`doneMs` and the same size): a device that uploaded before, or whose
  `uploads.json` was lost or written late, sends nothing twice. Only one tab uploads (a Web Lock);
  another one's recordings are found by the queue's look at the device's sessions every 10 minutes, or
  at the next start.
- **The clips on the device.** Once uploaded, clips are deleted by policy: with "Keep local copies" off
  (a phone's default; a laptop keeps them), the clips of an attempt once all its files are confirmed;
  in any case, once the browser's storage is 70% full, the oldest uploaded clips first, until it would
  be under 60%. The record says so first (`video[].local` false, saved through `SessionService`, which
  also writes it to the index), then the MP4 is deleted; `attempt.json`, the frames files and
  `gyro.json` stay, and the pages say "in the cloud" for such a clip.
- **The pages.** The Sessions page has the queue's panel (where the uploads are, the attempts still to
  upload with their progress, their errors and Retry, those uploaded last, the clips freed); the
  header, an arrow with the attempts to upload (dashed while paused, red with failures), which opens
  it; a session's page, each attempt's upload (this device's queue's, or the index's for another
  device's session); the QA view counts what `confirmUpload` confirmed.

## Testing the cloud (T3.5)

The end-to-end suite meets the cloud twice: every run of `npm run e2e` with fakes of Firebase (the
account, the index, the functions and a bucket in the test, `apps/web/e2e/helpers/account.ts`), and
`npm run e2e:cloud`, after it in CI, with the app's own Firebase SDK against the emulators, in a
Playwright project of its own, `cloud`:

```
npm run e2e:cloud ─▶ the functions built ─▶ firebase emulators:exec, offline project demo-cubetrace:
                     Auth :9099 · Firestore :8080 (firebase/firestore.rules) · Functions :5001
                     (functions/.env, then .env.demo-cubetrace: BUCKET_PROVIDER=local)
  └─▶ Playwright, project cloud ─▶ ng serve :4200, each page given window.cubetraceE2eEmulators
                                 · the bucket sink :4600, preflights answered from bucket/cors.json
the page ─▶ Sign in: signInWithCredential, a Google ID token of unsigned claims (the emulator's)
         ─▶ the index's writes, through the rules ─▶ signUpload ─▶ URLs on the sink ─▶ PUT
         ─▶ confirmUpload: HEAD on the sink ─▶ the attempt's upload done
the test ─▶ the emulators' REST APIs (the Auth accounts; the documents, past the rules) and the sink
```

- **Development builds only.** `ACCOUNT_LOADER` reads `window.cubetraceE2eEmulators` only when
  `isDevMode()`, as it reads the fake's loader; `connectFirebase` then starts the app under the
  emulators' project and points Authentication, Firestore and the functions at them before anything
  is asked of them (the Auth emulator's banner left out). Sign in, there, signs in with
  `signInWithCredential(GoogleAuthProvider.credential(<claims>))`: the Auth emulator's Google
  provider takes unsigned claims (`sub`, `email`, `name`), so that no window opens and the same
  `sub` is the same account on any page. A production build ignores the property.
- **The local bucket.** `BUCKET_PROVIDER=local` (`functions/src/local.ts`) makes URLs on the server
  at `LOCAL_BUCKET_URL`, the object's key as their path and what each was made for (the content
  type, the exact size, the expiry) in their query, with GCS's headers, and reads an object's size
  with `HEAD` there. It fails every call where `FUNCTIONS_EMULATOR` is not `true`, which only the
  Functions emulator sets, so a deploy configured with it signs nothing;
  `functions/.env.demo-cubetrace` gives it to the emulators' project alone, and deploys read
  `functions/.env`.
- **The sink** (`apps/web/e2e/helpers/bucket-sink.mts`) keeps in memory each `PUT` that is what its
  URL was made for, as a GCS signature would hold it, and answers the browser's preflights from
  `bucket/cors.json`, the real bucket's policy, so that the app's uploads cross origins as they do
  in production.
