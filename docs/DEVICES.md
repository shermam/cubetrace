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
schemas. The GAN 356 i3 was flat that morning; its round is below.

The gyroscope's rate, measured on 2026-10-03 from the first `gyro.json` files (T3.7) of both devices:
the GAN 12 ui reports its orientation about **11 times a second** (the median interval between
reports is 89 ms), with stretches at about 17 a second (58 ms intervals: 15% of the intervals) and
gaps of up to 165 ms; over an attempt's window (the scramble, the inspection and the solve) that is
12.6–13 reports a second on the laptop and on the phone alike (`gyro.rateHz`, the QA view's Gyro
column), far under the 50–100 Hz the buffer was sized for, which therefore holds its 10 minutes with
room. The angular velocity is non-zero in two thirds of the samples of a solve, with components up to
5 of the 7 the packets allow. The GAN 356 i3 has not recorded a gyro file yet. Both are Gen2 cubes,
which say no production date.

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
clock slopes 1.0010–1.0017 (this cube's clock runs about 0.1% slow, against the 12 ui's 0.7%: the
rate is a property of the cube), residual p95 18–22 ms (a little more jitter than the 12 ui's 13–15
ms), a pickup on every attempt. Every move of the five attempts ended its Bluetooth packet (one move
per notification, 556 of 556), so the recorded fits have every move as a sample and
`clock-hardware.test.ts` reproduces them exactly by replaying the export. The export was taken again
after a sixth attempt (the fixture now holds six), which spans a reconnection of the cube: the
attempt began right after a failed sync check, whose next turn and turn back became its first two
scramble moves; the cube idle-disconnected during the 434 s that followed and its count restarted
when it reconnected (`cubeMs` 561,080 at the second move, 10,977 at the third). The fit recorded on
the day took all 114 moves as one line: a slope of −0.81, residuals of 48 s. Since T2.9 the fit
starts again with the cube's clock (`docs/DATA-MODEL.md` §7): the 112 moves after the reconnection
fit a slope of 1.00086, residual p95 32.6 ms (six late packets of 33 to 50 ms), the fit the app kept
for that connection in `clock.cube`. The i3's clock also falls behind the host's across a long pause
between two moves: the driver adds up the cube's 16-bit move-to-move intervals
(`docs/TOOLCHAIN.md`), and the i3 reported 65,535 ms for the 80.1 s between attempts 3 and 4, where
the 12 ui's clock kept pace with the host's across its pauses of 131 and 291 s; the fit starts again
there too.

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
  design's storage tables (4.4 MB per attempt and camera) were low by 8×. The ceiling is now a
  setting, Video quality (T2.10, issue #33): Standard, the default, asks 4 Mbps at 1080p30, which
  makes these attempts 17–21 MB, 2.2–2.7 GB a day, four days of the quota; High is the 8 Mbps
  measured here, and Maximum 12. Crop-at-source must still arrive earlier than planned, and phase
  3's upload becomes urgent.
- **No audio track** in any clip (`audio: null`), although Chrome asked for the microphone and got
  it, "Record audio" was on and no notice said "Recording without audio" (issue #33). The causes the
  code allowed were all silent: no `AudioData` from the microphone's track (muted, or held by
  another app), an encoder whose first chunk carried no decoder config (the muxer then left the
  audio out), or audio timestamps on another clock than the frames' (the buffer then dropped it at
  once, or kept it for ever, and no chunk overlapped a clip). CI's clips, from Chromium's fake
  microphone, do have their Opus track (checked in T2.9, and asserted since). Since T2.9 each cause
  is said: the Recording part's Codecs line gives the audio's state, a notice comes 3 s after the
  first frame when the microphone sends nothing, and a clip without sound says why in the session's
  notes; the second and the third are fixed (a decoder config made from the encoder's settings; the
  audio placed by the arrival times). Round 2 told which it was on the MacBook: the third (below,
  "Audio").

## Audio

What the clips' sound showed in round 2, and what each device's microphone says it applies
(`docs/PLAN.md` T2.9 and T2.12).

- **Chrome's voice processing took the cube's clicks for noise on the ThinkPhone** (Android 16,
  Chrome 155, app 0.2.0): its clips have sound, and a TV's voices came through clearly, but the
  cube's own sounds were missing. The recording opened the microphone with
  `getUserMedia({audio: true})`, so Chrome applied its voice processing (echo cancellation, noise
  suppression, automatic gain control; on Android the platform's voice pipeline too), which keeps
  speech and suppresses short clicks as noise. For the dataset the clicks are signal: each turn
  clicks, so the sound can time the moves. Since T2.12 the microphone is asked for raw, every
  processing off (Settings → Camera → Microphone, Raw by default; Voice is the browser's defaults),
  and each session's camera keeps what the browser applied (`cameras[].microphone`,
  `docs/DATA-MODEL.md` §6).
- **The MacBook's microphone counts its own time** (the export of 2026-10-01, issue #40: MacBook Pro
  2021, FaceTime HD camera, GAN 12 ui FreePlay, app 0.2.0, Chrome 153): with T2.9 every clip has its
  AAC track (`mp4a.40.2`, six clips), and the session's notes name the cause of the clips without
  sound before it (issue #33's audio half): `clip audio rebased: scramble of attempt 1: audio
  timestamps rebased by 56536287 ms`. On macOS Chrome 153 the microphone's `AudioData.timestamp`
  counts on a clock of its own, 56,536 s (15.7 hours) off the frames' `VideoFrame.timestamp`, so no
  audio chunk overlapped a clip's frames and the muxer wrote clips without sound; since T2.9 the
  buffer, the cut and the muxer place such audio by its arrival times. Chrome's fake microphone on
  Linux counts on the frames' clock ("VideoFrame.timestamp", below), which is why CI never saw it.

What each device's microphone reports at the default, Raw: the export's `cameras[].microphone`
(Camera settings' Recording part says "mic raw" after the codecs, or "mic: the browser kept
processing on" with a notice naming what it kept), to fill in rounds 2 and 3. Chromium's fake
microphone is printed by `apps/web/e2e/microphone.spec.ts` at every run.

| Device, Chrome | Microphone (`label`) | Echo cancellation / noise suppression / gain control / voice isolation | Sample rate, channels | The cube's clicks in a clip |
|---|---|---|---|---|
| Chromium 141's fake microphone (Linux, CI), 2026-10-01 | Fake Default Audio Input | off / off / off / off (with Voice: on / on / on / off) | 44,100 Hz, 2 (with Voice: 48,000 Hz, 1) | — (a tone) |
| MacBook Pro 2021, Chrome: | | | | |
| ThinkPhone, Chrome: | | | | |

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
  video's, so a cut takes the audio chunks that overlap its frames by their timestamps. Not so on the
  MacBook, whose microphone counts on a clock of its own ("Audio", above).
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

How far each camera's frames lag the cube, from the sync check (T2.5, T2.8 and T2.11,
`docs/DATA-MODEL.md` §6): the median, over the turns kept, of the middle of each turn's motion in the
frames minus the turn's host time (`offsetMs` of `clock.cameras`), and the range of those lags
(`clapperboardResidualMs`), the fifth of the matched turns farthest from the median being left out;
with the capture worker's time per frame to measure the motion. For the owner's round 2
(`docs/MANUAL-TESTS.md`, T2.5): two checks per camera, whose offsets should agree within 25 ms, each
spread under the limit of 50 ms plus a frame interval (83 ms at 30 fps, 67 at 60).

| Camera | Date, Chrome | Check 1: offset / spread / turns | Check 2: offset / spread / turns | Per frame: median / p95 |
|---|---|---|---|---|
| MacBook Pro 2021, FaceTime HD, 1080p30 | 2026-09-27, Chrome 153 | 38.3 ms / 51.2 ms / 8 kept of 10 (T2.8: −85.8 ms / 341.4 ms, failed) | 18.7 ms / 70.9 ms / 7 kept of 9 (T2.8: −269 ms / 343.5 ms, failed) | 0.8 and 0.9 ms / 1.9 ms |
| MacBook Pro 2021 (office), Logitech Webcam C930e, 1080p30 | 2026-10-01, Chrome 154 | 177.4 ms / 11.6 ms / 6 kept of 8 (T2.11, GAN 12 ui) | — | 0.3 ms / 0.4 ms |
| ThinkPhone, front camera | | | | |
| ThinkPhone, rear camera | | | | |

The FaceTime row is the owner's first two checks of round 2 (issue #38, `fixtures/sync/`), made with
app 0.2.0, whose detection (T2.8, the first rise of each turn's motion) failed both; T2.11 recomputed
them from their data files. The cube was held in the air close to the camera, both hands on it, the
top face turned with the fingers, the framing rectangle around the cube and the hands (585×558 and
816×703 of the 1920×1080 frame, measured on a plane 160 pixels wide). The two offsets agree within
20 ms: the camera lags the cube by about 20 to 40 ms. Checks made as T2.11 asks (the cube held still,
one face flicked with one finger) are still to come. The Logitech row is the owner's check on the
office MacBook with the GAN 12 ui (issue #40): a USB webcam, with its own compression on the way to
the browser, lags about 140 ms more than the FaceTime camera; the lag is the camera's, not the cube's.
Both cameras are `laptop` by the host; since T2.14, a laptop's built-in camera and a USB webcam such
as this one used in one session are `laptop` and `laptop-2` there (the first one used is `laptop`),
each with its own sync check and clips (`docs/PLAN.md` T2.14, `docs/DATA-MODEL.md` §6).

Chrome's fake camera cannot give a lag, since nothing in its test pattern turns with the cube, but
it gives the cost: in Playwright's Chromium 141 on the containers' four CPUs, while the same worker
encoded 1080p30 VP9 in software, measuring a frame of the whole 1920×1080 picture took 1.1 to 1.2 ms
at the median and 1.5 to 4.9 ms at the 95th percentile in four runs of the lab's e2e test (the
highest with the rest of the suite running beside it): its luma copied out of the frame with
`VideoFrame.copyTo` and averaged down to 160 pixels wide (drawing the frame into a canvas instead
took 10 to 20 ms there, `docs/TOOLCHAIN.md`). Since T2.8 the whole frame is averaged down to 320
pixels wide, with the changed area beside the mean difference: 1.0 ms at the median and 1.6 ms at
the 95th percentile (4 at most) in the same test. The fake camera's frames are I420, copied; the
page gets each frame's motion 1.6 to 3.4 ms after the frame's host time. Over the whole frame its
test pattern changes by about 1.7 luma levels from one frame to the next, and by about 15 times that
every 14 to 16 frames, so some of those jumps come after half a second of stillness: onsets that a
check there cannot match, since the demo cube's turns come close together, not as single turns
(`docs/TOOLCHAIN.md`). Its changed area (T2.8) is 0.7% of the pixels at the median and 11% at most.

## Manual round 2 (v0.2.0)

What the owner's second round measures on each camera (`docs/MANUAL-TESTS.md`, "Round 2"), to fill
in after it: the frame rate measured in Camera settings; the sharpness of the framing rectangle with
the cube in it, in focus, moving and covered, and the threshold between them (20 by default, set on
Chrome's test camera); the codecs Chrome chose; the sizes of one attempt's clips (at Standard quality,
T2.10); and, on the phone
on its stand, 20 minutes of solves with the camera on. The sync check's numbers go into "Camera lag"
above, and the capture lab's frame timestamps under "VideoFrame.timestamp".

| Camera | Date, Chrome | Measured fps | Sharpness: in focus / moving / covered; threshold | Codecs | One attempt's clips: scramble / solve | 20 minutes: warmth, battery, dropped frames, storage used |
|---|---|---|---|---|---|---|
| MacBook Pro 2021, FaceTime HD | | | | | | |
| ThinkPhone, front camera | | | | | | |
| ThinkPhone, rear camera | | | | | | |

## Manual round 3 (v0.3.0)

What the owner's third round measures of the uploads, per device and network
(`docs/MANUAL-TESTS.md`, "Round 3"), to fill in after it: the upload speed seen (a solve clip's PUT
in DevTools → Network, or in `chrome://inspect` for the phone: its size over its time), the bytes
per attempt (one attempt's six files in the bucket's listing, at Standard quality, T2.10; five before
T3.7's `gyro.json`) and the
time to confirm (the latest `upload.files[…].doneMs` of the attempt's document minus its
`events.solveEnd`, in the Firebase console). The networks' upstream, measured apart
(`docs/USER-ACTIONS.md`), is the speed to compare with.

| Device, network | Date, Chrome | Upload speed seen | Bytes per attempt | Time to confirm |
|---|---|---|---|---|
| MacBook Pro 2021, Wi-Fi | | | | |
| ThinkPhone, Wi-Fi | | | | |
| ThinkPhone, mobile data (Wi-Fi only off) | | | | |

## Remote cameras

A phone paired to the laptop as a camera (phase 4, `docs/RTC.md`): the Wi-Fi's round trips as the
clock sync measures them, the phone's clock against the laptop's, how the clock sync fared, and the
transfer of the phone's clips. T4.3 adds the phone camera's lag from its sync check and the phone's
warmth after twenty minutes of solves. From the diagnostics events (`rtc.clock`, `remote.cut`,
`remote.clip`, `sync.check`; `docs/DIAGNOSTICS.md`): since T4.2b, `rtc.clock` says every minute of a
connection the median and the 95th percentile of the window's round trips and the share the fit
keeps, so the next pairing fills the window's columns. The coordinator fills a row from the owner's
pairing (`npm run round-report`, "After T4.3", and the events themselves), each cell from these
facts of the pairing's events, the medians over its minutes with the range or the worst beside them:

- **Round trip**: `rtc.clock`'s `rttMs` (the least round trip kept) and the window's `rttP50Ms` and
  `rttP95Ms` (T4.2b).
- **The phone's clock**: `rtc.clock`'s `offsetMs` at the first and the last record (how far it
  moved) and `driftPpm` (the minute records').
- **The clock sync**: `rtc.clock`'s `windowSamples` and `keptShare` (the samples of the window and the
  share kept), `samples` and `residualP95Ms` (the clock sync's spread), how long after `rtc.paired`
  its `why: converged` came, how many `withdrawn`, and the longest stretch converged (the round
  report's 4.3.5; issue #61 asks for 20 minutes); with `remote.cut`'s `converged` and `marginMs`, how
  many cuts went before convergence and how wide.
- **A clip's transfer**: `remote.clip`'s `transferMs` (from the phone's offer to the record: an
  attempt's clips are two of them), `bytes` and `bytesPerSecond` (the data channel's throughput), and
  `resumedBytes` when a transfer was cut.
- **Camera lag**: `sync.check` with `remote: true`: `offsetMs` and `spreadMs` of each check, with
  `clockConverged` and `clockRttMs` (the clock sync then), beside the laptop's own camera's lag of the
  same session; and `remote.clip`'s `syncResidualMs`, the lag the later clips took.
- **After 20 minutes**: the owner's notes (the phone's temperature by hand, its battery, whether its
  Camera page said throttled); the `state` reports are not events.
- **The live preview** (the table below): `preview.stopped` with `why: off` (a span with the
  preview: `encodeMsPerFrame`, `fps`, `kbps`, `encoder`, `cpuLimitedShare`, and the recording's
  `recordingFps`, `recordingFpsMin`, `recordingDropped`) against the `preview.started` that ends a
  span without it (the same recording facts).

| Pair, network | Date, measured by | Round trip | The phone's clock | The clock sync | A clip's transfer | Camera lag | After 20 minutes |
|---|---|---|---|---|---|---|---|
| ThinkPhone paired to the MacBook Pro 2021, the owner's home Wi-Fi | 2026-10-04, the coordinator from the diagnostics events (20.7 minutes paired, 18 attempts, 36 cuts) | the least of the window 5.4 to 8.5 ms; the window's median and 95th percentile not recorded before T4.2b | 238 to 245 ms behind the laptop's, moving by about 7 ms over the 20 minutes (a few ppm) | with the band of T4.0 to T4.2: 2 to 14 samples kept of 60 at the cuts (7 at the median), their residuals' 95th percentile 0.7 to 1.7 ms; converged twice and withdrawn twice, 10 of the 36 cuts converged (on 2026-10-03, two pairings of 12 and 4 minutes never converged: issue #61) | 1.8 s at the median and 8.0 s at most, for clips of 12.9 MB at the median, at 7.0 MB/s at the median | none: no sync check of a phone's camera before T4.3 | not noted |
| ThinkPhone paired to the MacBook Pro 2021, the owner's home Wi-Fi, after T4.3 (build 0.4.0) | 2026-10-05, the coordinator from the diagnostics events (three pairings, the first of 21.2 minutes ended by New session; 62 attempts, 124 cuts and clips) | the least kept 5.1 ms (4.7 to 5.9); the window's median 8.3 ms (6.9 to 14.4), its 95th percentile 49 ms (29 to 92) | −420.6 ms at the first record, −417.1 ms thirteen minutes later (the phone's clock gains about 4.5 ppm on the laptop's); `driftPpm` 4.7 over the minutes (−1.8 to 9.1) | converged 11 s after pairing; never withdrawn; the longest stretch 21.0 minutes, the whole first pairing; the window 60 samples (22 to 80), 47% kept (17 to 60%), 28 kept (10 to 39), spread 0.89 ms (0.49 to 1.36); 0 of 124 cuts before convergence, every margin 500 ms | 1.39 s at the median, 2.16 s at the 90th percentile, 5.65 s at most, for clips of 11.3 MB at the median (1.5 GB in 129 clips); 8.4 MB/s at the median (1.7 to 10.3); no transfer resumed | no sync check of the phone yet (its clips carry no lag); the laptop's own that session: 53 ms ± 47 | not noted |

The live preview's cost on the phone (T4.3: a fifth of the camera's resolution, at most 300 kbps and
15 fps, beside the recording), from the spans with and without it:

| Phone, camera | Date, measured by | The recording without the preview | The recording with it | The preview's encoder |
|---|---|---|---|---|
| ThinkPhone, the rear camera at 1080p30 | 2026-10-05, the coordinator from `preview.stopped` (a span of 1,271 s ended by the session's end; the preview was never switched off, so the span without it is not measured) | not measured | 30 fps (29 the least), 30 encoded, none dropped | 216 × 384 at 14.9 fps, 298 kbps, 3.9 ms a frame (`libvpx`), never held back by the CPU |
| Two pages of one browser (the end-to-end pair: a still 640 × 360 canvas), for scale | 2026-10-04, T4.3's e2e | – | 30.2 fps (29 the least), none dropped | 128 × 72 at 15 fps, 4 kbps, 0.36 ms a frame (`libvpx`), never held back |

