# Devices

What the owner's devices can do, from the `/probe` page (T1.8) and the manual rounds. The raw
probe reports are in `docs/devices/`; the session exports of the rounds are in
`fixtures/hardware/`. Phase 2 (video capture) chooses its camera settings from this page.

## Probes of 2026-09-27

| | MacBook Pro 2021 | ThinkPhone (motorola) |
|---|---|---|
| OS, Chrome | macOS 26.6.2 (arm64), Chrome 153.0.8010.53 | Android 16, Chrome 155.0.8059.16 |
| Camera probed | FaceTime HD (built-in), 1920×1080 | front camera, 1920×1080 (portrait, 1080×1920 frames); the rear camera is not probed yet |
| Frame rate | capability max 30; measured 30.05 fps over 10 s | capability max 60, the track *says* 60, but the sensor delivered 30 (mediaTime steps of 33.3 ms; measured 30.0 fps) |
| Frame interval at the callback (p5 / p50 / p95) | 17.7 / 33.3 / 43.2 ms | 17.0 / 33.3 / 50.0 ms |
| Sensor timestamps (`mediaTime` steps) | 33.35 ms, steady | 33.3 ms (p5–p95), steady |
| `captureTime − now` at the callback | −10 ms (p5 −17, p95 −3) | −10 ms (p5 −18, p95 −4) |
| Dropped frames in 10 s | 0 | 0 |
| Manual controls | none (no exposure, focus or white-balance capabilities) | exposure (manual, 0.05–250 ms, ISO), focus (manual, 0–3.19), white balance, colour temperature, zoom: a FULL-class camera |
| H.264 `VideoEncoder` | High and Main, 1080p30 and 1080p60, hardware: all supported | same, all supported |
| `MediaStreamTrackProcessor` | main thread only (not in workers) | main thread only |
| `VideoEncoder` in a worker | yes | yes |
| Storage quota | 10.74 GB, not persisted (Keep my data not granted) | 10.74 GB, persisted |
| Web Bluetooth | present; `getDevices` and `watchAdvertisements` present (the MAC flag is on) | present; `getDevices` absent (the MAC flag is off, so the MAC address had to be typed once) |
| CPU, memory | 8 cores, 16 GB (as reported) | 8 cores, 8 GB (as reported) |
| Screen | 3360×1890 CSS px at 2×, landscape | 509×1130 CSS px at 2.125×, portrait |

What this means for phase 2:

- **30 fps is what both default cameras deliver**, whatever the track settings say; plan the
  pipeline and the storage for 30 fps and treat 60 fps as a bonus to be measured per camera
  (the ThinkPhone's rear camera, next probe).
- **The sensor clock is steady** (`mediaTime` steps of 33.3 ms with no jitter) while the
  callback time jitters by ±10–17 ms: frame times must come from `mediaTime`/`captureTime`,
  never from when the frame reached JavaScript, as the design says.
- **Frames must be taken on the main thread** (`MediaStreamTrackProcessor` is not in workers on
  either device) and handed to a worker for encoding, or encoded on the main thread; the
  encoder itself runs in a worker with hardware H.264 on both.
- **About 10 GB of local staging** per device: at the design's ~4.4 MB per attempt and camera,
  a few thousand attempts, so uploads (phase 3) must keep up rather than accumulate.
- **Manual exposure exists on the phone** (front camera at least): the fixed-shutter "master"
  recording of the design is possible there; the MacBook's camera has no controls.

## Manual round 1 (2026-09-27, v0.1.0)

Both devices with the GAN 12 ui FreePlay, which reports model `uiFp 138`, hardware `0.5`,
firmware `8.62`, gyroscope present. 12 solves on the laptop (mean 17.2 s) and 3 on the phone
(mean 18.9 s): every attempt solved, eight phases, `replayOk`, cross on `U`, a pickup detected
from the gyroscope on every attempt (inspection 2.2–6.8 s). Both exports validate against the
schemas. The GAN 356 i3 was flat and is still to be tested.

Two things the exports show about the cube's clock (`fixtures/hardware/README.md`):

- the cube's `cubeMs` restarts when the cube reconnects (the laptop session spans a
  reconnection three hours after its first attempt: `cubeMs` went from 51,434 back to 51,142);
- **the cube's clock loses time during pauses**: between the laptop's attempts 3 and 4 the host
  clock advanced 330 s and the cube's clock 291 s. `cubeMs` is a running sum of the intervals
  the cube reports between moves, and long intervals are not reported in full. So one linear
  fit per session is wrong whenever the session has pauses (the laptop's fit has residuals of
  ±600 ms at its ends); within one attempt the fit holds to about ±15 ms (the phone's three
  attempts, one fit: p5 −15 ms, p95 +17 ms). Phase 2 fits the clock per attempt
  (`docs/PLAN.md`, T2.0) and every move keeps its `hostMs` anyway.
