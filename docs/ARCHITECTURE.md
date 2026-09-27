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
"clapperboard", one face turned and turned back five times at session start, measures each camera's
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
during a solve. The camera's and the microphone's `MediaStreamTrackProcessor` streams (Chrome has
them on the main thread only) are transferred to the **capture worker**, which encodes without
pause: H.264 High, else Main, hardware first, else VP9 (Chromium without proprietary codecs, as in
CI), at the bitrate of the video quality chosen in Settings (4 Mbps at 1080p30 by default); AAC, else
Opus, else no sound; a keyframe every second; frames dropped and counted when more than 8 wait in the
encoder. The chunks, each with its frame's own timestamp and its arrival on the
host clock, fill a ring buffer bounded by 90 s and 160 MB and evicted by whole GOPs, so that it
always starts at a keyframe. When the timer's milestones say a segment of an attempt is over, the
recording asks for its cut 1.25 s after its end: the scramble from 2 s before its first turn to 1 s
after the state matched, the solve from 3 s before its first turn to 1 s after solved or the DNF,
each from the keyframe at or before its start. The capture worker copies the cut's chunks and passes
them over a `MessageChannel` to the **clip worker**, which muxes them into MP4 with mediabunny,
without re-encoding, and writes the clip and its `frames.json` (the first frame's host time from the
median arrival offset over the clip, then each frame's interval from the timestamps) into the
attempt's OPFS folder under temporary names moved into place; the clip is then added to the
attempt's `video` in `attempt.json`, whose timing it never changes, and a clip that fails is noted
in `session.json`. The **sync check** runs once per session and camera: the capture worker measures
the motion inside the framing rectangle of each frame (a 160-pixel luma plane read with
`VideoFrame.copyTo`), the clapperboard matches the motion's onsets after 500 ms of stillness to
single cube turns within 500 ms, and the median lag becomes the camera's `offsetMs` in
`clock.cameras` and the `syncResidualMs` of its later clips. Idle time is never stored. Remote
cameras (phase 4) will cut the same way and ship their clips over the WebRTC data channel; phase 3
uploads them.

## Storage (phase 3)

Cloud-first: every device stages sessions locally and uploads them; Firestore is the index
that merges sessions from every host into one dataset; files live in an object-storage
bucket reached through signed URLs minted by a Cloud Function. The bucket provider (Google
Cloud Storage or Cloudflare R2) is a deployment configuration, not a code decision.
