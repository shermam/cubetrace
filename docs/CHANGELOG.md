# Changelog

All notable changes to cubetrace. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

Toward 0.5.0, phase 5 of `docs/PLAN.md`: the rig's eyes and hands.

### Added

- The phone's picture at the size of the host's own, with its status line (T5.1; `docs/RTC.md` §10,
  `README.md` "The desk rig"): on the Timer page each paired phone's live picture is a cell as large
  as the laptop's preview (a box of 16:9, the phone's upright frames between bars, its framing
  rectangle drawn), beside it in a window of 1,552 px or more (the page then up to 120rem wide),
  under it in a narrower one; under each, the phone's status line, the twin of the laptop's own:
  its frame rate, its sharpness by the laptop's threshold (green good, amber soft), recording or
  not, its battery (amber under 20% and unplugged, red under 10%), its health (the frame rate
  dropped in amber; its Compute Pressure state, `fair` in amber, `serious` and `critical` in red),
  `reconnecting…`, `clock syncing…`, and `no report for N s` in red when its reports stop while it
  is connected. Camera settings → Cameras → "Pictures from phones": "Same size as mine" (a laptop's
  default) or "Small tiles" (a phone's default, and the only layout of a phone's Timer page with the
  scramble over its picture), the tiles of 0.4.0 with a caption saying in short what is wrong. The
  Cameras list's report reads the same words.
- The phone's Compute Pressure state (T5.1): where the phone's Chrome has the API
  (`PressureObserver`, Chrome 125+), its Camera page observes the thermals source (or the CPU)
  every 2 s while it is open, says the state beside its battery (`fair`: it is warming up;
  `serious`: it may be hot; `critical`: let it cool down) and sends it in each `state` message
  (`pressure`, `pressureSource`, additive within protocol version 1: a phone of 0.4.0 sends none).
  The web platform has no temperature reading; this is the nearest.
- Diagnostics: the host's `rtc.clock` of each minute carries the phone's last report (`report`: frame
  rate, sharpness and whether it is soft, recording, battery, thermal hint, pressure), a phone's
  health over a session; `settings.changed` names `remotePictures`; the round report's "After T5.1"
  items read them.

## 0.4.0 — 2026-10-04

Phase 4 of `docs/PLAN.md`: remote cameras. A phone signed in to the same account joins a laptop's
session as a camera through a QR code: it films the cube from another angle with its own camera,
cuts each attempt's two clips from its own memory when the laptop cuts its own, and sends them over
a direct WebRTC connection on the Wi-Fi into the attempt's folder, their frame times placed on the
laptop's clock, to be uploaded with the attempt; each phone has a sync check of its own and a live
picture over the laptop's preview. With them come the follow-ups of phase 3: the cube's whole record
(the gyroscope over each attempt, the moves' counters, the resyncs, the battery, the build in every
file), a 3D cube in the clip viewer that follows the video, and the app's own diagnostics in the
account, from which the manual rounds are now read. Deployed at
https://shermam.github.io/cubetrace/; `README.md`, "The desk rig", sets the laptop and the phones
up, and its "Known limitations" lists what is still open.

### Added

- Remote cameras, the pairing and the connection (T4.1, phase 4; `docs/RTC.md` §8, `README.md`
  "Remote cameras"): a phone films a session from another angle. On the host, Camera settings →
  Cameras → Add camera publishes a one-time code (10 minutes, one phone) and shows it as a QR code
  (drawn by the app, no dependency), a link and 8 characters to type; the Cameras section and the
  connection's code load only then. On the phone, the new Camera page (`/camera`, from the QR's URL
  or with the code typed or the link pasted; signed in to the same account, with Sign in there when
  it is not) turns the rear camera on (a camera choice of its own, apart from the Timer page's),
  runs the capture pipeline from the start, shows the preview with the framing rectangle, the
  sharpness meter and the camera's controls, the host, the connection's state, the clock sync as the
  host measures it, the battery and a thermal hint, keeps the screen on, reconnects by itself for
  five minutes after a drop and then says the host is gone, and leaves with Leave (or when the page
  goes). The host lists each phone with its name, its label in the session, its state (connected,
  reconnecting for up to five minutes), the sync (syncing, or synced with the round trip, the offset
  and the drift), what it reports (recording, frame rate, sharpness, framing, battery, a thermal
  hint), a picture every 2 s, and Remove; the camera goes into `session.json`'s `cameras[]` with
  `remote`, and its clock fit into `clock.cameras[<label>].remote` when it converges and every
  minute after. A demo session pairs too: its document goes to the index for the pairing (its
  attempts never). Diagnostics: `rtc.paired`, `rtc.connected`, `rtc.disconnected`, `rtc.clock`,
  `rtc.failed` on both devices; the round report's "After T4.1" items.
- Remote cameras' clips (T4.2, phase 4; `docs/RTC.md` §9): a phone paired as a camera records each
  attempt. The host asks it for the scramble's and the solve's clips at the moments it cuts its own,
  the window in the phone's clock through the clock sync's estimate, converged or not, widened by
  half a second or more on each side; the phone cuts and keeps each clip until the host has it,
  sends it over the data channel (resumed after a reconnection, offered again after a reload or a
  new pairing to the same session), and the host writes it into the attempt's folder with its times
  on the host clock: an attempt filmed by the laptop and the phone has four clips, uploaded
  together. The attempt waits for the phone's clips up to two minutes after its end, then is
  uploaded without them and the session's notes name the camera; a clip that comes later is added
  and uploaded then. Camera settings → Cameras has "Record remote cameras" (on by default) and says
  how many clips a phone still has to send; the phone's Camera page says how many wait. The clip
  viewer names each clip's camera when an attempt has several, and the QA view counts the clips by
  camera. The frames file of a phone's clip keeps the phone's own first frame time (`t0RemoteMs`)
  and the clock estimate that converted it (`remote`), and `clock.cameras[<label>].remote` may say
  `converged` false (schema 2, optional fields; `docs/DATA-MODEL.md` §6, §9). Diagnostics:
  `remote.cut`, `remote.clip`, `remote.clip.late`, `remote.clip.missing`; the round report's "After
  T4.2" items.
- A paired phone's sync check, and its live picture over the host's preview (T4.3, phase 4;
  `docs/RTC.md` §10; issue #60). Under the Timer page's preview each phone has a line of its own
  ("Sync: phone-rear has no check in this session"), whose Sync check runs the laptop's check on the
  phone's camera: the phone measures the motion inside its own framing rectangle and sends it, the
  laptop matches it against the cube's turns through the clock sync, and the panel says
  `phone-rear lags the cube by N ms (±S)`. The lag is kept in `clock.cameras[<label>]` beside the
  clock sync, and the phone's later clips take it as their `syncResidualMs`, as the laptop's do
  (`docs/DATA-MODEL.md` §6 says what a remote camera's lag is). Each phone also sends a small live
  picture of its camera (a fifth of its resolution, at most 300 kbps and 15 frames a second; its
  recording untouched): a tile in the top right corner of the host's preview on the Timer page, its
  live video while it comes and its latest thumbnail otherwise, with the phone's framing rectangle;
  a tap swaps it with the main picture, and with the host's camera off the first phone's picture is
  the main one. Camera settings → Cameras → "Live preview from phones" (on by default). Diagnostics:
  `sync.check` says `remote` and the clock sync that placed the phone's frames, `remote.clip` the
  lag its clip took, `preview.started` and `preview.stopped` what the preview cost the phone's
  recording; the round report's "After T4.3" items.
- Development (T4.0; `docs/RTC.md`): the groundwork of the remote cameras, the package
  `@cubetrace/rtc` with the data channel's protocol (versioned `hello`, pings, the camera's state
  and thumbnails, cuts, the file messages, `leave`; JSON control frames and binary chunk frames),
  the chunked file transfer (64 KB chunks paced by the channel's buffered amount under a 256 KB
  threshold, acknowledged every megabyte, resumed from the receiver's offset after a reconnection,
  the whole file checked by CRC-32 at the end), the clock sync's pings over core's new
  `RemoteClockFit` (the offset from the samples of least round trip, a drift fit once they span a
  minute, `toHostMs`/`toRemoteMs`, a convergence rule), the pairing token (8 characters of
  Crockford's base32 in the QR's URL, stored as its SHA-256), the signaling over Firestore
  (`FirestoreSignaling` on the account backend's new calls) and `WebRtcTransport` on
  `RTCPeerConnection` with Google's STUN server and ICE restart; `MemoryTransport`,
  `MemorySignaling` and `FakeTimers` for the tests. `session.json` keeps schema 2 with optional
  fields: a camera's `local` may be false, with `remote` naming its device, and a camera clock may
  carry `remote`, the fit's record (`docs/DATA-MODEL.md` §6). In Firestore, the session's document
  gains `pairing`, the peer documents and their candidates get their schemas, readers and rules
  (owner-only, shapes checked; §10), and `AccountBackend` gains `writePairing`, `createPeer`,
  `updatePeer`, `deletePeer`, `watchPeers`, `watchPeer`, `addCandidate` and `watchCandidates` in the
  SDK and both fakes.
- Development (T4.1): the `clock` message (host to phone) in the protocol; `CameraChoice.facing`;
  `FramingEditor` and `SharpnessMeter` as components of their own; `openMicrophone` shared by both
  recordings; the camera device's seams in `apps/web/src/app/rtc/`; the end-to-end suite's signaling
  over a `BroadcastChannel` (`apps/web/e2e/helpers/signaling.ts`) and its two pairing flows, the
  fast one on the loopback interface and the cloud one through the Firestore emulator; the QR
  encoder's test reads its codes back with `jsqr` (a devDependency).
- Development (T4.2): `cut` names the camera's label and the attempt's `scrambleShown`, `cut-done`
  carries what the phone's capture said of the clip, and `clip-ack` is new (additive within protocol
  version 1); core's `parseFrames`, `remoteFrames` and the fit's `least` and `rttP95Ms`; the
  capture's clip worker can stage a clip under a folder of its own (`SaveClipParams.staging`);
  `writeAttemptFile` takes bytes in parts; the end-to-end suite's `window.cubetraceE2eRemote`
  (development builds only) moves a camera device's clock, cuts its connection once in the middle of
  a file, ignores its cuts or shortens the host's wait.
- Development (T4.3): the protocol's `sync-start`, `sync-stop`, `sync-motion`, `sync-meter`,
  `sync-error` and `preview` (additive within version 1); rtc's `PREVIEW_ENCODING`,
  `PreviewChannel`, `previewStats` and `WebRtcTransport`'s `preview` option (a send-only video
  transceiver in the first offer, no renegotiation), `Transport.preview`; core's `RemoteClockLine`
  and `RemoteClockFit.line()`; the app's `RemoteCameraRegistry`, `CameraDeviceSync`,
  `CameraDevicePreview` and `RemotePreviews`; the end-to-end suite's synthetic camera and the demo
  cube's turns at given times (`apps/web/e2e/helpers/remote.ts`); the remote specs wait for six
  seconds of the phone's recording before an attempt (their "recording" matched "not recording"),
  and their reads of the origin private file system, `uploads.spec.ts`'s too, try again while the
  app replaces a file.
- The cube's whole record (T3.7; `docs/DATA-MODEL.md` §5, §6, §7, §11): everything the cube sends is
  kept now, to be trimmed later if useless. Each attempt of a cube with a gyroscope gets a
  `gyro.json` in its folder, written a second after the attempt ends, with or without a camera: the
  gyroscope's orientation (unit quaternions, as the cube reports them) and, on the Gen2 cubes, its
  angular velocity (raw 4-bit integers), from 2 s before the first scramble turn to 1 s after the
  end, from a ring buffer of the last 10 minutes of reports; `attempt.json` says what the file holds
  (`gyro`: its samples, span and rate). `attempt.json` also keeps each move's counter (`serial`) and
  whether its host time is its own packet's arrival (`packetLast`), and logs the states the app
  adopted from the cube when moves went unseen (`resyncs`); `session.json` keeps the cube's
  production date (`cube.productDate`, null on the Gen2 cubes, which say none) and its battery
  reports (`battery`, consecutive equal levels coalesced). Every JSON file the app writes names the
  build that wrote it (`app`: `attempt.json`, the frames files and `gyro.json`, as `session.json`
  always has), so that the files of a buggy or an older build can be told apart later. All of it is
  optional in the schemas: every file written so far still validates, and reads with the fields
  absent, null or empty.
- `gyro.json` is uploaded as the attempt's sixth file (T3.7), after the clips, counted by the day's
  quota like any file (an attempt with its clips is six files now, ten with a phone's), and stays on
  the device with the frames files when the clips are deleted by policy; the functions accept it (33
  files a call); the session index's documents carry the new fields, and the rules check their
  shape. The clip viewer's Download includes it, and the QA view's new Gyro column counts the
  attempts with one and says the median of their rates.
- Development (T3.7): the fake cube reports a gyroscope when asked (`?gyro=1` in demo mode: a slow
  steady turn at 50 Hz while a replay turns, with a velocity), which the end-to-end suite uses;
  `GyroBuffer`, `gyroFile`, `gyroSummary`, `parseGyro` and `gyro.schema.json` in `packages/core`,
  `writeAttemptFile` in `packages/storage`.
- Diagnostics (T3.9; `docs/DIAGNOSTICS.md`, `docs/DATA-MODEL.md` §10): signed in, the app keeps a
  log of its own use in the account (`users/{uid}/events`): when it starts and which build (and the
  build it ran before: the update), the sign-ins, the pages viewed, the settings changed, each cube
  connected (and how its address came, never which), disconnected (with the facts the console had)
  or reset, each session and attempt (its outcome, timing, clock fit, gyro file and clips), the
  camera and the recording, each clip saved or failed, the sync checks, the uploads' states and
  pauses, the clips deleted by policy, the cubes synced (a count), the downloads and the errors the
  app logs — never a MAC address, an email, a video or a user agent. The events go in batches, 5 s
  after the first or at 20, offline through Firestore's cache; signed out, nothing is kept beyond
  the page; a device writes at most 5,000 a day (2,000 until T4.2a: with a phone paired, about six
  events more per attempt on the host, a day of the owner's 130 to 170 attempts reached it at about
  155 and the evidence stopped mid-session; at 5,000, Firestore's writes stay within a quarter of
  its free tier). Settings → Account → Diagnostics, on by default, turns it off after one last
  event. Sessions → QA view gains a Diagnostics section: per device its last start and build, the
  events by kind over the last 7 days, and the failures. The manual rounds are now read from these
  events by the coordinator's round report (`npm run round-report`, with a service-account key:
  `functions/scripts/round-report.mts`), which ticks the checklists of `docs/MANUAL-TESTS.md` with
  the facts; the owner looks only at what no event can show.
- Development (T3.9): `cloudEvent`, `sanitizeEventData`, `eventId`, `parseCloudEvent` and
  `cloud-event.schema.json` in `packages/core`; the rules for `users/{uid}/events` (create-only by
  the account, never updated or deleted) with their tests; `AccountBackend.saveEvents` and
  `listEvents` in the SDK and both fakes; `diagnostics.spec.ts` in the end-to-end suite and the
  events checked in the cloud project.
- A 3D cube in the clip viewer that follows the video (T3.8, T3.10; issue #55): under the video, as
  wide as it and about half as tall (the video at most 45% of the screen's height and the cube 30%;
  on a phone the video, the cube, then the moves), cubing.js's cube in 3D turns with the attempt's
  moves as the picture shows them (the next move animated in about 100 ms; the state rebuilt at once
  after a seek) and, when the attempt has a `gyro.json` (T3.7), tilts and turns as the real cube
  did, from the gyroscope's samples around the moment the picture shows, upright at the clip's first
  frame (the gyroscope's yaw is arbitrary); "Re-zero" takes the current moment as upright, and "Raw"
  shows the samples as recorded. The moves list and the cube both apply the camera's lag from the
  sync check (`syncResidualMs`), so the highlighted move changes when the picture shows the turn,
  which it used to lead by that lag. The player's camera looks at the cube level and from the front
  (cubing.js looks from above and to the right by default, so an upright cube already looked
  tilted), so that its tilt can be compared with the hands'. Under the cube, in one wrapping row,
  Turn ◀ ▶ (90° around it), Tilt ▲ ▼ (90° over it, within ±90°), Behind and Reset view move the
  viewpoint, a drag with the mouse or a finger turns it freely (cubing.js's own drag input; a click
  adds no move), and Mirror (none, left–right, up–down, front–back, all) reflects the orientation
  shown, for a camera behind or beside the cube or a cube whose gyroscope's axes differ; Re-zero and
  Raw are under the orientation line. The view and the mirror are kept per camera label: on the
  device (Settings, at most 8 cameras) and, signed in, in the account (`users/{uid}.viewer`,
  `docs/DATA-MODEL.md` §10), read once at each sign-in and merged with the device's (the account's
  for the cameras the device has not set), then written a second after the last change; a clip of a
  camera without a choice opens with the defaults; Re-zero and Raw stay per clip. Without a gyro
  file (an older attempt, a cube without a gyroscope) the cube still turns, upright, and a line says
  the orientation is not recorded; a file that cannot be read is said in that line. No 3D cube on
  the Timer page: the solver watches the real cube, and WebGL would compete with the capture. The
  gyroscope's frame is mapped from the driver's documentation, not yet from a real recording: one
  line under the controls says how to calibrate, and `docs/MANUAL-TESTS.md`, "After T3.10", has the
  steps.
- Development (T3.8, T3.10): `orientation.ts` (quaternion arithmetic, the frame mapping
  `CUBE_TO_PLAYER`, the interpolation over a gyro file, `cubeStep`) and `clip.ts` (a clip's time on
  the host clock, the camera's lag applied) in `packages/core`, with `Mirror`, `mirrored` and
  `shownOrientation`'s mirror, and `ViewerChoice` with its reader, merge and diff (`user.ts`);
  `viewer` in `user.schema.json` and in the rules, with their tests; `AccountBackend.getUser` and
  `saveViewer` in the SDK and both fakes; `clip-cube.ts` (the player driven through
  `experimentalAddMove`, `experimentalCurrentThreeJSPuzzleObject` and the vantages; `ClipCube.view`,
  `target`, `orbit` and `onDrag`) in `apps/web/src/app/timer`, with their tests, and
  `ViewerSyncService`; the recording flow of the end-to-end suite seeks and plays a clip and checks
  the puzzle object's quaternion, the player's alg and the highlighted move against what core
  computes from the gyro file the app wrote, and the layout, the straight-on view, the presets, a
  drag with the mouse, the mirror and the choice kept on a second open.

### Changed

- The clock sync of a paired phone converges on a Wi-Fi whose round trips jitter (T4.2b,
  `docs/RTC.md` §4; issue #61): the estimate stands on the samples within a band of the least round
  trip and on at least the 10 of least round trip of the last two minutes (the band alone kept 2 to
  14 of 60 on the owner's home Wi-Fi, and 10 of 36 cuts had a converged sync), it is synced once ten
  of them over ten seconds agree within 5 ms (3 ms before), and it is withdrawn at once by a sample
  farther from the estimate than its own round trip allows (the phone's clock stopped while it
  slept). The host pings every 500 ms until the sync converges, for a minute at most, then every
  2 s. On a simulation of the owner's Wi-Fi the sync converges in about 12 s and stays so for
  20 minutes (after about 100 s, and withdrawn 13 to 15 times, before). The diagnostics' `rtc.clock`
  goes once a minute of the connection, converged or not (`syncing` before convergence), with the
  window's round trips (median, 95th percentile, how many, the share kept), so that a pairing says
  how its Wi-Fi behaves.
- A phone's clip is placed on the host clock with the clock estimate of its cut, at the clip's own
  time (T4.3, `docs/RTC.md` §4): T4.2 converted it with the estimate of the moment its files came,
  which a phone that slept meanwhile (its clock stopped) moved, five minutes off after a five-minute
  sleep in the simulation; the frames file's `remote.offsetMs` is now the offset applied at the
  clip's first frame (`docs/DATA-MODEL.md` §9). A clip 10 minutes into a session with 50 ppm of
  drift is placed within 1 ms.
- Development (T4.2b): core's `REMOTE_CLOCK_WINDOW_MS` (two minutes) and `REMOTE_CLOCK_MIN_KEPT`
  (10), `REMOTE_CLOCK_WINDOW` 240 (60 before), `RemoteClockFit`'s `windowMs` option and `window`
  (the window's round trips), `REMOTE_CLOCK_CONVERGED.spreadMs` 5; rtc's `FAST_PING_INTERVAL_MS`
  (500 ms) and `FAST_PINGS_MS` (a minute) with `ClockPinger`'s `fastIntervalMs`, `fastMs` and
  `intervalMs`; the host's and the phone's `HELLO_TIMEOUT_MS` 15 s (10 s before), their hello waits
  ended by the connection closing first (`apps/web/src/app/rtc/hello.ts`); `CutCamera.session`,
  `RemoteCutsService.pendingOf` and `watchPending`, the host's `FINISH_WAIT_MS` and the camera state
  `finishing`; the end-to-end suite's `cubetraceE2eRemote.finishWaitMs`, and its reads of an
  attempt's files trying again when the app is replacing one; the unit tests'
  `MemoryConnector.failRole`.
- The upload quota per account and UTC day is 15 GB and 3,000 files (6 GB and 1,200 in 0.3.0): on
  2026-10-03 the owner reached 1,199 files with 171 attempts in the day plus the re-signatures of
  `attempt.json` after clips deleted by policy, and phase 4 adds a phone's clips to each attempt.
- Development (T4.2a): `SessionService.releaseClips`, which saves nothing, and the upload source's
  `releaseClips` option, in place of `markClipsGone`; `AttemptFiles.list`; `clipsOnDevice`,
  `withClipsOnDevice` and `withoutLocal` (`apps/web/src/app/session/clips-on-device.ts`); `local` in
  `attempt.json` is no longer written (the readers take it as before).

### Fixed

- New session right after a solve no longer loses the paired phone's last clips (T4.2b, follow-up
  (l) of `docs/PLAN.md`): the session's end let the phone go at once, its clips still to come were
  noted missing and never reached the attempt although the phone kept them. A phone with clips of
  the ended session still to come now stays connected until they are in, 15 s at most, the Cameras
  list saying "waiting for the phone's last clips (n)"; the clips go into the ended session's
  attempt, and the phone is let go with "the session ended". Remove still lets it go at once.
- A phone's first call to the host that fails (the connection not made, a hello that a busy page
  sent late) no longer ends the pairing (T4.2b): the phone calls again with the same code every 3 s,
  saying "Joining…" and why, until the code's ten minutes are up, and the host answers it, listing
  the camera as connecting meanwhile; a wrong, expired or used code is still refused at once.
- The host's hello no longer goes missing at a pairing (T4.2b): the host said it the moment its
  channel opened, and now and then it never reached the phone's page (7 of about 115 hello exchanges
  in the end-to-end runs; the pairing was refused before T4.2b, and took 18 s longer with its
  retries). The host now answers the phone's hello, which the phone says once its channel is open.
- Deleting uploaded clips by policy ("Keep local copies" off, or the storage past 70%) no longer
  uploads `attempt.json` again (T4.2a). The deletion saved the record again to say that the clips
  had left the device, and a record read back otherwise than it was uploaded (one written before a
  later field) went up again, a file of the day's quota each; in a later page load than the upload,
  it also rewrote the attempt's index document, which the rules refused, with a note in the session.
  The record is now left as it was uploaded: `uploads.json` keeps which clips left, the pages read
  it from the attempts' folders, and still say "in the cloud".
- The clip viewer's line beside Download counts the clips it gives: "all 4 clips, …" for an attempt
  with a phone's clips, where it said "both clips", and "the 2 clips on this device, …" where it
  said "the clip" (T4.4).

## 0.3.0 — 2026-10-02

Phase 3 of `docs/PLAN.md`: the cloud. A Google account, optional, gathers the sessions of every
device into one dataset: signed in, each session of a real cube goes to the account's index in
Firestore as it is recorded, each attempt's records and clips are uploaded into the dataset's bucket
through URLs that the account's Cloud Functions sign, within a daily quota, and the cubes' MAC
addresses are known on every device; offline, all of it waits on the device. Signed out, the app
works as before and never downloads Firebase. Deployed at https://shermam.github.io/cubetrace/, with
the owner's Firebase project `cubetrace-cacd9` and the Google Cloud Storage bucket `cubetrace-data`.

### Added

- A Google account, optional (T3.0): Sign in, in the header and in Settings → Account, signs in with
  Google, in a popup (over the app installed on Android, a Chrome tab of its own that closes
  itself), and the header then shows the account's photo and name, with Sign out in its menu. The
  account records the name, the email and each device's label (`users/{uid}` in Firestore), and is
  there for the cloud index of the sessions and their uploads (below). Signed out, the app works as
  before and never downloads Firebase, which loads once the account is used; signed in, it opens
  offline too.
- Development: the Firestore rules (`firebase/firestore.rules`: an account reads and writes only its
  own record and its own sessions), tested against the Firestore emulator (`npm run test:rules`, in
  CI with Java 21), and a workflow that deploys them when a merge changes them
  (`.github/workflows/firebase.yml`).
- Development: the Cloud Functions the uploads go through (T3.2, `functions/`). `signUpload`
  gives a signed-in account, for one of its own attempts, a URL per file into the dataset's bucket
  (Google Cloud Storage for now, Cloudflare R2 by configuration), valid 15 minutes for that file's
  type and exact size, within a daily quota per account (6 GB and 1,200 files by default since 2026-10-02, 2 GB and 400 at first, kept in the
  account's record, which the app can read and not change); `confirmUpload` checks that the files
  arrived with their sizes and marks the attempt uploaded; the upload queue (T3.3, below) calls them.
  Their tests run against the Firestore emulator (`npm run test:functions`, in CI), the Firebase
  workflow deploys them with the rules, and `bucket/` has the bucket's CORS policies.
- The session index (T3.1): signed in, every session of a real cube goes to the account's index in
  the cloud as it is recorded, its record and each attempt's without the moves, with the device that
  recorded it and its files, each pending until it is uploaded: the saves never wait for it, and
  offline it waits on the device and goes when the network is back. Demo sessions stay on the device.
  The sessions recorded signed out are added when the account signs in (at most 300 documents at a
  time, the rest at the next start). A write the cloud refuses is said once, on the Sessions page and
  in the session's notes (`cloud: …`).
- The Sessions page, signed in, lists the account's sessions of every device, merged with this
  device's: a badge on each ("this device", "cloud", "both", dashed while a change waits to be sent),
  a filter by device, and why a session of this device is not in the cloud. A session recorded on
  another device opens a read-only page: its attempts and statistics, without its clips or its moves,
  which stay on that device. Delete there removes this device's copy only, and says so.
- The QA view, `/qa` (Sessions → QA view, signed in): the attempts of the account's 50 newest sessions
  by day and device, with their clips, the bytes they take, the bytes uploaded and pending, a total,
  when this device last synced and what still waits to be sent.
- Development: the session index's documents in `packages/core` (`cloudSession`, `cloudAttempt`, their
  readers and `cloud-session.schema.json`, `cloud-attempt.schema.json`), the rules' checks of their
  shape (an attempt without moves, its place, its owner) with their tests, the composite index of the
  sessions query (`firebase/firestore.indexes.json`), and the end-to-end suite's fake index.
- Uploads (T3.3): signed in, every attempt of a real cube's session goes to your account's storage in
  the cloud once it is over (its clips saved): its attempt.json with the moves, its clips and their
  frame times, and its session's session.json (again when it changed, once the session has been quiet
  for two minutes). Two files at a time; a failure of the network or the server is tried again after
  1 s, 2 s, 4 s, … up to 5 minutes; a file the storage refuses waits for Retry; when the day's upload
  quota is used up the uploads wait for the next day; a reload, or the next start, goes on where they
  were, without sending a file twice. Demo sessions, anything signed out and the cubes' MAC addresses
  are never uploaded.
- Settings → Uploads: Upload sessions (on), Wi-Fi only (on a phone whose browser tells Wi-Fi from
  mobile data; on by default there) and Keep local copies (on for a laptop, off for a phone: off, an
  attempt's clips are deleted from the device once all its files are uploaded, attempt.json and the
  frame times staying). In any case, once the browser's storage is 70% full, the oldest uploaded clips
  are deleted until it is under 60%.
- The Sessions page, signed in, has the uploads' panel: where they are (uploading, up to date, paused
  by the quota until a time, waiting for Wi-Fi or the network, off), each attempt still to upload with
  its progress and its last error, Retry for those that failed, the attempts uploaded last and the
  clips deleted from the device. The header shows an arrow with the attempts still to upload (dashed
  while paused, red when some failed), which opens it. A session's page says each attempt's upload.
- A clip deleted from the device once uploaded says "in the cloud" on its badges and in the clip
  viewer, in place of the video; Download gives what is still on the device.
- Development: `packages/upload`, the queue, tested in Node with fakes of the device, the functions,
  the bucket and the PUTs; `uploads.json`, its state, at the root of the origin private file system
  (`docs/DATA-MODEL.md` §10); `video[].local` in `attempt.json` (§7), an optional field of version 2;
  the end-to-end suite's fake of the functions with a bucket that the test runs (`uploads.spec.ts`).
- The cubes' MAC addresses synced with the account (T3.4, issue #21): signed in, the list of
  Settings → Cube MAC addresses, where the connect dialog's "Remember it for this cube" keeps an
  address too, is the account's as well, so that an address typed once on a device (a phone whose
  Chrome cannot read it) is known on the others. Each device merges its list with the account's at
  each sign-in and each start signed in (the latest change of each cube wins, and a cube removed on
  one device goes on the others), and sends each change as it is made, offline once the network is
  back. Settings → Cube MAC addresses says "Synced with your account" with the time of the last
  merge, and the changes still to be sent. The addresses stay out of the dataset: no export, upload
  or session index holds one.
- Development: the account's cubes in `packages/core` (`cloudCube`, `parseCloudCube`,
  `cloud-cube.schema.json`), the rules of `users/{uid}/cubes/{name}` (the account's alone, each
  document checked) with their tests, and a cloud of the end-to-end suite's fake that two browser
  contexts share, two devices of one account (`cube-macs.spec.ts`).
- Development: the end-to-end suite's cloud project (T3.5), `npm run e2e:cloud`, in CI after the
  other end-to-end tests: the app's own Firebase SDK against the Auth, Firestore and Functions
  emulators, with the project's rules, its uploads into a bucket on the same machine
  (`BUCKET_PROVIDER=local`, which the functions refuse outside the Functions emulator): signing in,
  a session recorded with the camera indexed, uploaded and confirmed, and a second device of the
  account that lists it and knows the cube's MAC address typed on the first.

### Changed

- The current session's row on the Sessions page follows the timer's attempts while the page is open
  (T3.1). Settings → Account says what the account keeps now, and that the files are uploaded as
  Settings → Uploads says (T3.3).
- The clip counts on the Sessions page and a session's page count the bytes still on the device, and
  say how many clips are in the cloud (T3.3).
- The settings that the browser keeps are version 2 (T3.4): each cube's MAC address has the time it
  last changed, and an address kept before gets the time this version first reads it. Settings →
  Account says that the account keeps the cubes' MAC addresses too.

### Fixed

- Two cameras of one laptop used in one session (its built-in camera and a USB webcam, issue #40)
  were both `laptop` in it: the second replaced the first one's entry in `session.json` and its sync
  check, and the first one's clips then named the wrong camera. Each device of a session now has a
  label of its own, which names its entry, its sync check and its clips (`laptop.solve.mp4`,
  `laptop-2.solve.mp4`): the first camera used is `laptop`, another `laptop-2`, then `laptop-3`, …
  (on a phone, a second rear lens is `phone-rear-2`), and a camera used again in the session gets
  its label back, with its sync check, while a camera switched to that has no check in the session
  is due one (T2.14). A new session starts again from `laptop`.
- Signing in from the app installed on Android never finished (issue #50, the first sign-in of manual
  round 3 on the ThinkPhone): the installed app sent the page to Google's and back, and the outcome
  comes back through Firebase's helper frame on another site than the app's, which Chrome's
  partitioning of third-party storage keeps from the app, so it said "Signing in did not finish:
  Google sent the page back without an account". The installed app now signs in with the same popup
  as a browser tab, which Chrome opens over it as a tab of its own that closes itself when Google is
  done (T3.6). Should that window not finish, the app says to sign in once in Chrome itself, at the
  app's address, which signs the installed app in too, and to open it again.

## 0.2.0 — 2026-09-27

Phase 2 of `docs/PLAN.md`: the device's own camera records every attempt, in sync with the cube.
Deployed at https://shermam.github.io/cubetrace/.

### Added

- Camera settings, a section of the Timer page (T2.1, T2.7): the camera to use ("Front camera" and
  "Rear camera" on a phone), Turn on and Turn off (kept across reloads), the frame rate and frame size
  measured next to what the camera claims, the manual controls it has (exposure and ISO, focus, white
  balance, zoom, torch) with Reset to auto, the framing rectangle (Framing → Edit, kept per camera) and
  a sharpness meter (good or soft); in Settings, the resolution, the frame rate, the sharpness
  threshold and Record audio.
- The camera's picture beside the time (on a phone, at the top of the page with the scramble over it,
  T2.13), mirrored for a front camera, with the framing rectangle drawn on it and one line with it:
  the frame rate, the sharpness, what the recording does and how full storage is (T2.7).
- Recording (T2.2, T2.3, T2.4, T2.9): with the camera on and a session under way, the camera and the
  microphone are encoded into the last 90 s kept in memory (H.264 and AAC where Chrome has encoders
  for them, VP9 and Opus otherwise), and every attempt gets two MP4 clips cut from it without
  re-encoding: its scramble, from 2 s before its first turn (at most 60 s before the cube matches it:
  a pause inside a scramble is not worth minutes of video) to 1 s after the cube matches it, and its
  solve, from 3 s before its first turn to 1 s after the cube is solved or the DNF. They are saved
  with the time of every frame into the attempt's folder and listed in its record; the attempt's
  timing never waits for them.
- Video quality, in Camera settings and in Settings → Camera (T2.10, issue #33): Standard, the
  default, records 4 Mbps at 1920×1080 and 30 fps, about 20 MB per attempt; High 8 Mbps (about 40 MB)
  and Maximum 12 (about 60 MB); 1280×720 takes 0.44 times as much, and 60 fps 1.5 times. Each choice
  says its bitrate and size at the resolution and frame rate chosen, the recording's counters the
  bitrate in use, and a line under the storage meter what an attempt takes. The first recordings on a
  MacBook took 35–42 MB per attempt at the 8 Mbps then asked for: two days of the owner's solves would
  have filled the browser's storage.
- Microphone, next to Record audio in Camera settings and in Settings → Camera (T2.12): Raw, the
  default, records the microphone with the browser's voice processing (echo cancellation, noise
  suppression, automatic gain control) asked off, which on the owner's ThinkPhone had kept a TV's
  voices and taken the cube's clicks for noise; Voice keeps the browser's defaults, for speech. The
  Recording part says "mic raw" or "mic voice" after the codecs, and "mic: the browser kept
  processing on", with a notice noted once in the session, when the browser keeps some on anyway; the
  session keeps what the browser applied, from the microphone's `getSettings()` (`microphone` in a
  camera's entry of `session.json`, optional: older files read as null).
- Clip badges on the solve lists, which open the clip viewer (T2.4): the clip plays next to the
  attempt's moves by time, the one on screen highlighted; Download saves both clips, their frame
  times and `attempt.json`.
- The storage meter, in Camera settings and on the Sessions page, whose rows also give each session's
  clips and their size: a warning from 80% of the browser's quota, and from 95% the camera stops
  recording while the timer goes on (T2.4).
- A clip that could not be saved is said once, written in the session's notes and logged in the
  console as `cubetrace: clip failed: …` (T2.4).
- The sync check (T2.5): when a session starts recording, one face turned and turned back five times
  gives "Camera lags the cube by X ms (±Y)", kept in the session (`clock.cameras`) and in every later
  clip of that camera (`syncResidualMs`); the timer tracks no attempt meanwhile; Retry, Later, and
  "Sync check" under the camera's picture to run it again between attempts.
- The session's page, `/sessions/<id>` (T2.7): its date, device, cube and cameras, its statistics with
  ao100, the storage its clips take, every attempt with the clip viewer and its downloads, Export and
  Delete; opened by "See all" under the Timer's solves and by each date on the Sessions page.
- `/capture-lab`, a page outside the navigation for trying a device: the capture pipeline with its
  counters and cuts, "Mux and save" and a sync check with any cube (T2.2, T2.3, T2.5).
- Development: `packages/capture` (the camera, the encoder pipeline and its ring buffer in a worker,
  the cuts, MP4 muxing with mediabunny and clip writing in a second worker, the motion measurement
  and the clapperboard), and end-to-end tests of the recording with Chrome's fake camera (T2.1–T2.7).
- Where the sound is (T2.9, issue #33): the Recording part of Camera settings says it when it is not
  being recorded ("no audio yet (waiting for the microphone)", "audio stopped"), and so do the
  capture lab's counters; 3 s after the camera starts without a sound from the microphone, a notice
  says that it sends none (muted, or held by another app); the notices of a recording stay together
  rather than the last alone, and each is written in the session's notes (`notice: …`). A clip
  without sound while the sound is recorded says why, in a notice and once in the notes
  (`clip without audio: …`): no audio from the microphone, no decoder config, no audio in the clip's
  span, or the encoder's error.

### Changed

- The Timer page (T2.7): the last 12 solves, with "N solves in this session · See all"; the scramble's
  picture beside its moves, and the result on the line of the attempt's number; wider on a laptop and
  tighter on a phone, so that the scramble, the time and the camera's picture are in view together.
- On a phone, the Timer page keeps the camera's picture and the scramble in view together while it
  scrolls (T2.13): with the camera on, the picture is pinned at the top of the window, as wide as the
  screen, with the scramble over its lower part on a dark strip through which the picture shows (its
  moves as large and in the same colours as before; its progress and undo moves there too), the time
  right under it and the sync check under the time; with the camera off, the scramble's card is pinned
  at the top. On the ThinkPhone the scramble was out of view whenever the picture was in view, and
  the hands drifted out of the frame unnoticed. Settings → Timer → "Scramble over the picture (phone)",
  on by default, turned off brings back the column of T2.7, with the picture under the time.
- The records are schema version 2 (T2.0, `docs/DATA-MODEL.md`): `attempt.json` gains `clock` and
  lists its clips in `video`, `session.json` lists its `cameras` and their `clock.cameras`, and every
  clip has a `frames.json`; sessions recorded by 0.1.0 are still read, resumed and exported, as
  version 2, and their files are not rewritten.
- The sync check asks to hold the cube still inside the framing rectangle and flick one face with one
  finger, the other hand still, then flick it back a second later, five times (T2.11); it says "Hold
  still…" for its first second and counts no turn made then, which it could not match. Its result
  in the capture lab, its console line and its data file (version 2) say the turns kept and those
  left out of the spread.
- While the framing rectangle is the whole frame or most of it, the sync check asks first for one
  around the cube ("Edit the framing" opens Camera settings to it), and starts with Start, or with
  "Start anyway".
- A sync check that cannot start says why beside its button; one that ended writes a line to the
  console (`cubetrace: sync check …`) and offers "Download check data", a JSON file of what the
  camera saw around each turn, to attach to an issue.
- The capture lab's sync check shows the latest frame's motion in two bars as it comes, with the
  frames' pixel format and how they are read.

### Fixed

- The cube clock fit of a session drifted by 0.7% of every pause between its attempts (the cube's
  clock runs slow only while it is turned), so it placed the moves of a long session hundreds of
  milliseconds off: every `attempt.json` now keeps the fit of its own moves (`clock`), and
  `session.json`'s `clock.cube` is only a coarse summary (issue #22, T2.0).
- A clip whose start was older than the 90 s kept in memory was refused, so an attempt with a long
  pause in its scramble lost its scramble clip: it is saved from the oldest keyframe in memory,
  marked `truncatedStart` in its `video` entry (optional in the schema: older files read as false)
  and "late" on the solve lists and in the clip viewer, with a notice and a line in the session's
  notes, `clip truncated: … starts X s late (the buffer held Y s)` (issue #34, T2.9).
- An attempt's clock fit went through a reconnection of the cube, whose clock starts again at 0, and
  recorded a line through both clocks (a slope of −0.81 on the owner's GAN 356 i3): the fit now
  starts again with the cube's clock, as it does when the i3's count of a pause over 65.5 s runs out
  (T2.9).
- Clips without an audio track (issue #33, T2.9): when the audio encoder's first chunk has no decoder
  config, the clip gets one made from the encoder's settings (for AAC with its AudioSpecificConfig);
  when the sound's timestamps count on another clock than the frames', the arrival times place it,
  and the clip's notes say by how much. On the owner's MacBook it was the latter (issue #40): its
  microphone's timestamps count on a clock of their own, 15.7 hours off the frames'.
- The sync check failed checks in which the camera saw every turn (issue #38, T2.11): it took each
  turn's time in the picture at the first frame that changed around it, which caught the hand getting
  ready a varying time before the turn, so that the owner's two checks on the MacBook's FaceTime
  camera spread their lags over 341 and 343 ms. It now takes the middle of each turn's motion, where
  the cube reports the turn, and the spread leaves out the fifth of the turns farthest from the
  median: the same two checks pass, with lags of 38 and 19 ms (spreads of 51 and 71 ms).
- The sync check works on a real camera (T2.8): the owner's first checks on the MacBook's FaceTime
  camera matched none of their turns ("fewer than 4 matches (0 of 8 single turns matched a
  motion)"). The motion is now measured as the share of the picture that changed (pixels whose
  brightness moved by more than 12 levels, so that the camera's noise and a flicker of the light
  count for nothing), at twice the resolution when the whole frame is watched, and each turn's
  motion is looked for in the frames around it, against the picture just before it, rather than
  anywhere in the check. The spread of the lags a check allows follows the camera's frame rate:
  50 ms plus one frame interval (83 ms at 30 fps, where the fixed 40 ms failed correct checks),
  since each turn's motion is only seen to the nearest frame.
- The turns made for a sync check no longer end up in the next attempt's scramble (issue #34): a
  check waits 20 s for the first turn, then runs until the ten turns are made, showing "Turn 3 of
  10", and after it the timer waits until the cube has been still for 2 s (or the result is closed),
  then for a second of stillness more, before the attempt begins.

## 0.1.0 — 2026-09-27

The first release: phase 1 of `docs/PLAN.md`, a timer for a GAN Bluetooth cube in Chrome that keeps
every solve as data. Deployed at https://shermam.github.io/cubetrace/.

### Added

- The timer (T1.6b): a WCA random-state scramble made in the browser by cubing.js, as text and as a
  picture, with its progress and, when the cube leaves it, the moves that undo the detour; the
  attempt arms when the cube matches the scramble, the time starts with the first turn and stops
  when the cube is solved; "Solve the cube first" when a scramble is due on an unsolved cube; the
  next scramble at once after a solve; Skip scramble (N), DNF (Esc), Delete last (Delete) and New
  session.
- An optional 15-second inspection countdown (visual only: no +2 or DNF), from the moment the
  attempt arms or, on a cube with a gyroscope, from the pickup (T1.6b).
- The CFOP breakdown of the last solve and of the session average (cross, four F2L pairs, EOLL,
  OCLL, PLL), with each phase's time and moves; phases are detected on any cross colour and agree
  with Cubeast on all 2,400 phase boundaries of 300 of the owner's solves (T1.3, T1.6b).
- The solve list: time, the phases as a mini bar and flags (DNF, Corrected, No replay), with the
  session's count, mean, best, ao5 and ao12 (T1.4, T1.6b).
- Sessions kept in the browser's origin private file system as `session.json` and one
  `attempt.json` per attempt (`docs/DATA-MODEL.md`: every move on the host and cube clocks, the
  cube clock fit, the phases and the result), resumed after a reload; a cube that disconnects
  pauses the attempt until it is back; JSON Schemas of both files in `packages/core/schema/`
  (T1.4, T1.6b).
- The Sessions page: every stored session with its date, device, cube, attempts and mean; export
  one as a JSON file, or delete it (T1.6b).
- GAN cube connection over Web Bluetooth, from the cube pill in the header: Chrome's device picker,
  the MAC address read by Chrome with the flag `#enable-web-bluetooth-new-permissions-backend` or
  typed once and remembered for that cube, the cube's model, firmware, battery and gyroscope, and
  Disconnect and Reconnect (T1.5, T1.6a).
- The Cube section of the Timer page: the cube's state as a net, solved or not, and its last 20
  moves with their cube time, the gaps between them and the Bluetooth packet they came in (T1.6a).
- Demo mode: a fake cube that replays one of 30 recorded solves, from "Demo cube" in the connect
  dialog or `?demo=<0-29>&speed=<x>` on the Timer page, so the app can be tried without a cube
  (T1.6a).
- End-to-end tests of the timer's flows with the demo cube, which `&misscramble=<k>` makes turn a
  wrong face after scramble move k and undo it: full attempts checked against the recorded solves, a
  mis-scramble, a DNF, a reload mid-session, the inspection setting, and exports validated against
  the JSON Schemas (T1.9).
- Settings: this device's label, the cubes' MAC addresses, inspection, the next scramble right
  after a solve, and the demo speed; keep the screen on; keep my data (T1.6a, T1.7).
- An installable app that opens offline, keeps the screen on during a session (the header shows
  the wake lock), asks the browser to keep its data, fits a phone in portrait and a laptop in one
  dark theme, shows its version and commit in the footer, and names the missing APIs on browsers
  other than Chrome (T1.7).
- The device probe page, `/probe`: what the browser can do with its cameras, H.264 encoders,
  storage and Bluetooth, as a JSON report to copy or download for `docs/DEVICES.md` (T1.8).
- Development: npm workspaces (`apps/web` and `packages/core`, `gan`, `storage`), strict
  TypeScript, ESLint and Prettier, Vitest and Playwright tests driven by the fake cube, CI on every
  pull request and a GitHub Pages deploy from `main` (T1.0).
- The scramble's moves are outlined as the cube makes them, as on Cubeast: green once made, yellow
  while a half turn is half made (one quarter turn of its two), red on the move where the cube left
  the scramble, next to the undo list as before; the whole scramble green once it is complete, until
  the solve starts. The demo cube now makes a scramble's half turns as two quarter turns, as a real
  cube does, so the yellow shows in demo mode too (T1.13).
- "Mark as solved", in the Timer page's Cube section and in the connected cube's details (the pill):
  it tells the cube that it is solved, for when the cube's own state and the cube in your hands went
  apart (turns made while it was asleep or disconnected). The attempt under way begins again with
  its scramble, and nothing is recorded; with the demo cube, the replay stops there (T1.14).
- A cube left 5 minutes without a turn is disconnected, to save its battery (Settings → Idle cube,
  0 to 60 minutes, 0 for never); the pill's tooltip and the Timer page say why, and Reconnect takes
  one click (T1.14).
- When the cube disconnects by itself, the reason says how long it had gone without a turn and
  whether the tab was in the background (and that GAN cubes go to sleep, after two minutes), and the
  browser's console gets one line with the details, to paste into an issue. Back in the tab, a
  connected cube is asked for its state, so that turns made meanwhile are caught up. The GAN driver
  now loads right after the page, so that the click on Connect does not wait for it (T1.14).

### Changed

- Connecting a cube takes one click (T1.12). "Connect a cube" on the Timer page (and in its Cube
  section) and the cube pill in the header, which now reads "Connect cube" or "Reconnect", open
  Chrome's list of Bluetooth devices at once; once the cube is connected, no dialog is left open.
  While it connects, the button says so, with Cancel next to it. The connect dialog opens only when
  it is needed: when the cube's MAC address has to be typed (the Chrome flag that makes it
  unnecessary is folded under the prompt), in a browser without Web Bluetooth, for the Details of a
  failed connection, and for a connected cube's details from the pill. A failure is written under
  the button and in the pill's tooltip, whose dot turns red. "Try the demo", next to "Connect a
  cube", starts the demo cube.

### Fixed

- A page reloaded or closed during a save no longer leaves an empty `session.json` or `attempt.json`
  behind: files are written under a temporary name and moved into place in one step. A file that
  cannot be read (empty, not JSON, or not its session's) is set aside instead of breaking the Timer
  page's resume and the whole Sessions page: the Sessions page still lists, exports and deletes the
  other sessions, shows a broken session as its own row, with the file and what is wrong, and can
  delete it, and names an attempt it left out; the Timer page starts a new session and says which
  file it could not read (issue #12, T1.11).
