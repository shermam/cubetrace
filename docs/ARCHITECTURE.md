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
  ──uses──▶ packages/core      cube simulator (Kociemba facelets) · notation · scramble target ·
                               attempt state machine · CFOP phase detector · clock fits · data model · fake cube
  ──uses──▶ packages/gan       GAN driver wrapper (Web Bluetooth) → typed CubeEvent stream; MAC provider
  ──uses──▶ packages/capture   (phase 2) MediaStreamTrackProcessor → VideoEncoder → ring buffer → cut → mediabunny MP4 → OPFS
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

All timestamps are host milliseconds. Cube time is mapped by a per-session linear fit of
(cubeMs, hostMs) pairs. Remote phones (phase 2) are mapped by a data-channel ping protocol;
video frames carry their arrival time in Chrome; a "clapperboard" of five deliberate turns at
session start measures each camera's constant latency. See the private design for the
measurements and the reasoning.

## Capture (phase 2)

Cameras record continuously into a ring buffer of encoded H.264 chunks (keyframe every
second). When the cube's events say an attempt happened, two segments are cut per camera
without re-encoding: scramble (2 s before the first scramble turn to 1 s after the state
matched) and solve (3 s before the first solve turn to 1 s after solved). Clips are muxed
to MP4 in a worker, staged in OPFS, shipped to the host over the WebRTC data channel
(remote cameras) and uploaded. Idle time is never stored. Audio is recorded with the video.

## Storage (phase 3)

Cloud-first: every device stages sessions locally and uploads them; Firestore is the index
that merges sessions from every host into one dataset; files live in an object-storage
bucket reached through signed URLs minted by a Cloud Function. The bucket provider (Google
Cloud Storage or Cloudflare R2) is a deployment configuration, not a code decision.
