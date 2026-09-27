# Devices

What the owner's devices can do, from the `/probe` page (T1.8) and the manual rounds. The raw
probe reports are in `docs/devices/`; the session exports of the rounds are in
`fixtures/hardware/`. Phase 2 (video capture) chooses its camera settings from this page.

## Probes of 2026-09-27

| | MacBook Pro 2021 | ThinkPhone, front camera | ThinkPhone, rear camera |
|---|---|---|---|
| OS, Chrome | macOS 26.6.2 (arm64), Chrome 153.0.8010.53 | Android 16, Chrome 155.0.8059.16 | same |
| Camera probed | FaceTime HD (built-in), 1920×1080 | front camera, 1920×1080 (portrait, 1080×1920 frames) | rear camera, 1920×1080 (portrait, 1080×1920 frames) |
| Frame rate | capability max 30; measured 30.05 fps over 10 s | capability max 60, the track *says* 60, but the sensor delivered 30 (mediaTime steps of 33.3 ms; measured 30.0 fps) | capability max 60, the track says 60, the sensor delivered 30 (mediaTime steps of 33.3 ms) |
| Frame interval at the callback (p5 / p50 / p95) | 17.7 / 33.3 / 43.2 ms | 17.0 / 33.3 / 50.0 ms | 16.6 / 33.3 / 50.1 ms |
| Sensor timestamps (`mediaTime` steps) | 33.35 ms, steady | 33.3 ms (p5–p95), steady | 33.32 ms, steady |
| `captureTime − now` at the callback | −10 ms (p5 −17, p95 −3) | −10 ms (p5 −18, p95 −4) | −10 ms (p5 −19, p95 −4) |
| Dropped frames in 10 s | 0 | 0 | 0 |
| Manual controls | none (no exposure, focus or white-balance capabilities) | exposure (manual, 0.05–250 ms, ISO), focus (manual, 0–3.19), white balance, colour temperature, zoom: a FULL-class camera | exposure (manual, 0.08–288 ms, ISO 100–1594), focus (manual, single-shot, continuous; 0.1–8.2), white balance (manual), colour temperature, zoom 1–8×, **torch** |
| H.264 `VideoEncoder` | High and Main, 1080p30 and 1080p60, hardware: all supported | same, all supported | same, all supported |
| `MediaStreamTrackProcessor` | main thread only (not in workers) | main thread only | main thread only |
| `VideoEncoder` in a worker | yes | yes | yes |
| Storage quota | 10.74 GB, not persisted (Keep my data not granted) | 10.74 GB, persisted | same phone |
| Web Bluetooth | present; `getDevices` and `watchAdvertisements` present (the MAC flag is on) | present; `getDevices` absent (the MAC flag is off, so the MAC address had to be typed once) | same phone |
| CPU, memory | 8 cores, 16 GB (as reported) | 8 cores, 8 GB (as reported) | same phone |
| Screen | 3360×1890 CSS px at 2×, landscape | 509×1130 CSS px at 2.125×, portrait | same phone |

What this means for phase 2:

- **30 fps is what all three cameras deliver at 1080p**, whatever the track settings say (both
  ThinkPhone cameras claim 60 and deliver 30); plan the pipeline and the storage for 30 fps. T2.1
  tries `frameRate: {exact: 60}` and 1280×720 to see whether 60 fps exists at all on the phone.
- **The sensor clock is steady** (`mediaTime` steps of 33.3 ms with no jitter) while the
  callback time jitters by ±10–17 ms: frame times must come from `mediaTime`/`captureTime`,
  never from when the frame reached JavaScript, as the design says.
- **Frames must be taken on the main thread** (`MediaStreamTrackProcessor` is not in workers on
  either device) and handed to a worker for encoding, or encoded on the main thread; the
  encoder itself runs in a worker with hardware H.264 on both.
- **About 10 GB of local staging** per device: at the design's ~4.4 MB per attempt and camera,
  a few thousand attempts, so uploads (phase 3) must keep up rather than accumulate.
- **Manual exposure exists on both ThinkPhone cameras** (the rear one down to 0.08 ms, with ISO to
  1594, manual focus, manual white balance, zoom and a torch): the fixed-shutter "master" recording of
  the design is possible there, and the torch can serve as the optional sharper clapperboard mark;
  the MacBook's camera has no controls.

## Manual round 1 (2026-09-27, v0.1.0)

Both devices with the GAN 12 ui FreePlay, which reports model `uiFp 138`, hardware `0.5`,
firmware `8.62`, gyroscope present. 12 solves on the laptop (mean 17.2 s) and 3 on the phone
(mean 18.9 s): every attempt solved, eight phases, `replayOk`, cross on `U`, a pickup detected
from the gyroscope on every attempt (inspection 2.2–6.8 s). Both exports validate against the
schemas. The GAN 356 i3 was flat and is still to be tested.

What the exports show about the cube's clock (a fit of host time on cube time, per attempt and per
session, over all 1,802 moves; `fixtures/hardware/README.md`):

- **Within an attempt, the cube's clock runs 0.7% slow, steadily.** Every one of the 15 attempts,
  on both devices, fits `hostMs ≈ 1.0070 × cubeMs + b` (slopes 1.0067–1.0071), with 95th
  percentiles of the absolute residuals of 13–23 ms (the median attempt: slope 1.006983,
  14.6 ms): that is the Bluetooth notification jitter, in the range the design expected, and
  `packages/core/src/clock-hardware.test.ts` holds the bounds. On the ThinkPhone one fit for its
  three attempts (100 s) holds to ±15 ms.
- **Across a pause the two clocks advance equally** (the laptop's 291 s pause between attempts 3
  and 4: host 291.1 s, cube 291.1 s), so the offset `b` shifts by 0.7% of each pause. One fit per
  session is therefore wrong as soon as the session has pauses of minutes: the laptop's session
  fit (11 attempts over 14 minutes) has a slope of 1.0031 and residuals of ±600 ms at its ends.
- `cubeMs` restarts when the cube reconnects (the laptop session spans a reconnection after a
  3-hour pause: `cubeMs` went from 51,434 back to 51,142).

So the clock fit belongs to the attempt, not the session (`docs/PLAN.md`, T2.0); every move keeps
its `hostMs` anyway, and the session-level `clock.cube` of schema 1 stays as a coarse summary.

**The GAN 356 i3 (issue #32, 2026-09-27, MacBook Pro 2021, a schema 2 export with clips):** model
string `GANi3I1w`, hardware `0.1`, firmware `7.76`, gyroscope present. Five solves; per-attempt
clock slopes 1.0010–1.0017 (this cube's clock runs about 0.1% slow, against the 12 ui's 0.7%:
the rate is a property of the cube), residual p95 18–22 ms (a little more jitter than the 12 ui's
13–15 ms), a pickup on every attempt.

## First recordings (2026-09-27, MacBook Pro 2021, FaceTime camera)

From the same export: every attempt has its two clips, encoded by the hardware H.264 High encoder
(`avc1.640028`) at 1080p30, so the H.264 path that CI cannot test works on the MacBook.

| Clip | Frames | Size | Rate |
|---|---|---|---|
| scramble (13.4–16.4 s) | 402–493 | 13.6–17.1 MB | ~8 Mbps |
| solve (20.2–25.3 s) | 606–760 | 20.2–25.4 MB | ~8 Mbps |

Two consequences:

- **35–42 MB per attempt** at the configured 8 Mbps ceiling, which real footage uses in full
  (the fake camera compressed to 1.2 Mbps and hid this): at the owner's cadence (about 130
  attempts a day) that is 4.5–5.5 GB a day, so the 10 GB local quota fills in two days and the
  design's storage tables (4.4 MB per attempt and camera) were low by 8×. The bitrate must come
  down (4 Mbps at 1080p30 is plenty for hands; a "Video quality" setting), crop-at-source must
  arrive earlier than planned, and phase 3's upload becomes urgent.
- **No audio track** in any clip (`audio: null`), although "Record audio" defaults to on: the
  microphone stream or the AAC/Opus encoder was not there. Under investigation (issue #33).

## VideoFrame.timestamp

What the capture worker sees of a frame's own time (T2.2), measured on 2026-09-27 with Chrome's fake
camera and microphone (Playwright's Chromium 141, headless, on Linux, with
`--use-fake-device-for-media-stream=fps=30`): by `apps/web/e2e/capture.spec.ts`, which prints these
numbers at every run, and by a 96 s recording through `/capture-lab`. CI's runner gave the same
picture on another machine: a first `timestamp` of 192,556,290 µs on a runner up for 203.4 s, a
95th percentile of +0.4 ms around the median offset, and the audio's offset 0.1 ms from the video's.

- **It does not start at 0 at the first frame.** It is the frame's time in microseconds on the
  system's monotonic clock (Chrome's `base::TimeTicks`: the time since boot, on Linux). The first
  frame of a 10 s cut had `timestamp` 5,305,665,091 µs on a machine up for 5,316.6 s, and
  `arrival − timestamp / 1000` (arrival in Unix ms) is, as a date, 13:39:03.598 UTC that day: when
  the machine booted, plus the few milliseconds a frame takes to reach the worker.
- **It counts on the clock of `performance.now()`, from another zero.** `timestamp / 1000` minus the
  page's `performance.now()` when the frame reached the worker was 5,304,521.9 ms and steady (the
  page's time origin on the monotonic clock, less that delivery time). A worker has a time origin
  of its own, but `performance.timeOrigin + performance.now()` is the same Unix-based host clock
  there as in the window.
- **`arrival − timestamp / 1000` is constant.** From the first third of the frames to the last it
  moved by −0.3 to −0.2 ms per minute over 10 s and by 0.2 ms per minute over 85 s: no drift.
  Around its median, the 5th percentile was −0.3 ms and the 95th +0.7 to +3.3 ms in three runs
  (+1.6 ms over 85 s), with a single late frame now and then (20 to 61 ms). So the cut's arrival
  fit (the median offset) puts `t0HostMs` on the host clock to a fraction of a millisecond here,
  and the frames' intervals (`dtMs`) come from the timestamps, where a dropped frame shows as a
  double interval.
- **`AudioData.timestamp` is on the same clock**: the audio's arrival offset was 0.6 ms from the
  video's, so a cut takes the audio chunks that overlap its frames by their timestamps.
- The fake camera's frames have no `duration` (null); the worker uses the frame interval it
  measures from the timestamps. The fake camera runs at 20 fps without `fps=30`.

`t0HostMs` is therefore when the first frame reached the capture worker, without the jitter of a
single arrival; how long the light takes to get there (the camera's latency plus Chrome's delivery)
stays in it, for the clapperboard (T2.5) to measure.

**To confirm in round 2 (T2.6), on the real cameras** (Chrome's capture code differs by platform,
and the fake camera has no sensor behind it): on the MacBook's FaceTime camera and on both
ThinkPhone cameras, open `/capture-lab`, Start, record for a minute, set the cut length to 60 and
cut, then read `clock` at the top of "Last cut": `firstTimestampUs` (large or near 0: either works,
only the offset changes), `timestampMinusPageNowMs` (steady from one cut to the next if the
timestamps count on the `performance.now()` clock), `arrivalDriftMsPerMinute` (about 0 expected),
`audioMinusVideoOffsetMs` (a few ms at most; far more would mean the audio has a clock of its own,
and the cut would have to place it by its own offset), and `frames.arrival.residualP95Ms`, the
arrival jitter in the worker (the probes saw ±10–17 ms at `requestVideoFrameCallback` on the main
thread). The counters also say which codecs Chrome chose (H.264 expected on both devices) and
whether frames were dropped.

## Camera lag

How far each camera's frames lag the cube, from the sync check (T2.5, `docs/DATA-MODEL.md` §6): the
median, over the turns matched, of the motion's onset in the frames minus the turn's host time
(`offsetMs` of `clock.cameras`), and the spread of those lags (95th minus 5th percentile,
`clapperboardResidualMs`); with the capture worker's time per frame to measure the motion (the
capture lab's Sync check). For the owner's round 2 (`docs/MANUAL-TESTS.md`, T2.5): two checks per
camera, whose offsets should agree within 10 ms, each spread under 40 ms.

| Camera | Date, Chrome | Check 1: offset / spread / turns | Check 2: offset / spread / turns | Per frame: median / p95 |
|---|---|---|---|---|
| MacBook Pro 2021, FaceTime HD | | | | |
| ThinkPhone, front camera | | | | |
| ThinkPhone, rear camera | | | | |

Chrome's fake camera cannot give a lag, since nothing in its test pattern turns with the cube, but
it gives the cost: in Playwright's Chromium 141 on the containers' four CPUs, while the same worker
encoded 1080p30 VP9 in software, measuring a frame of the whole 1920×1080 picture took 1.1 to 1.2 ms
at the median and 1.5 to 4.9 ms at the 95th percentile in four runs of the lab's e2e test (the
highest with the rest of the suite running beside it): its luma copied out of the frame with
`VideoFrame.copyTo` and averaged down to 160 pixels wide (drawing the frame into a canvas instead took
10 to 20 ms there, `docs/TOOLCHAIN.md`). Over the whole frame its test pattern changes by about 1.7
luma levels from one frame to the next, and by about 15 times that every 14 to 16 frames, so some of
those jumps come after half a second of stillness: onsets that a check there cannot match, since the
demo cube's turns come close together, not as single turns (`docs/TOOLCHAIN.md`).

## Manual round 2 (v0.2.0)

What the owner's second round measures on each camera (`docs/MANUAL-TESTS.md`, "Round 2"), to fill
in after it: the frame rate measured in Camera settings; the sharpness of the framing rectangle with
the cube in it, in focus, moving and covered, and the threshold between them (20 by default, set on
Chrome's test camera); the codecs Chrome chose; the sizes of one attempt's clips; and, on the phone
on its stand, 20 minutes of solves with the camera on. The sync check's numbers go into "Camera lag"
above, and the capture lab's frame timestamps under "VideoFrame.timestamp".

| Camera | Date, Chrome | Measured fps | Sharpness: in focus / moving / covered; threshold | Codecs | One attempt's clips: scramble / solve | 20 minutes: warmth, battery, dropped frames, storage used |
|---|---|---|---|---|---|---|
| MacBook Pro 2021, FaceTime HD | | | | | | |
| ThinkPhone, front camera | | | | | | |
| ThinkPhone, rear camera | | | | | | |
