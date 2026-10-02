# Changelog

All notable changes to cubetrace. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

Nothing yet.

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
  Google, in a popup (in the app installed on Android, the page goes to Google's and comes back), and
  the header then shows the account's photo and name, with Sign out in its menu. The account records
  the name, the email and each device's label (`users/{uid}` in Firestore), and is there for the
  cloud index of the sessions and their uploads (below). Signed out, the app works as before and
  never downloads Firebase, which loads once the account is used; signed in, it opens offline too.
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
