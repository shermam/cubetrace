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
  on both devices, fits `hostMs ≈ 1.0070 × cubeMs + b` (slopes 1.0069–1.0071) with residuals of
  ±13 ms at the 5th/95th percentiles: that ±13 ms is the Bluetooth notification jitter, in the
  range the design expected. On the ThinkPhone one fit for its three attempts (100 s) holds to
  ±15 ms.
- **Across a pause the two clocks advance equally** (the laptop's 291 s pause between attempts 3
  and 4: host 291.1 s, cube 291.1 s), so the offset `b` shifts by 0.7% of each pause. One fit per
  session is therefore wrong as soon as the session has pauses of minutes: the laptop's session
  fit (11 attempts over 14 minutes) has a slope of 1.0031 and residuals of ±600 ms at its ends.
- `cubeMs` restarts when the cube reconnects (the laptop session spans a reconnection after a
  3-hour pause: `cubeMs` went from 51,434 back to 51,142).

So the clock fit belongs to the attempt, not the session (`docs/PLAN.md`, T2.0); every move keeps
its `hostMs` anyway, and the session-level `clock.cube` of schema 1 stays as a coarse summary.
