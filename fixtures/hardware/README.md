# Session exports from real hardware

Exports (`Sessions → Export`) of the owner's manual rounds, kept as test data for anything that
must hold on a real GAN cube: Bluetooth packet timing, the cube clock, gyroscope pickups, the
phase detector on live solves. Read-only, like `fixtures/solves.json`; they hold no personal data
beyond the device label and the browser's user-agent string.

| File | Device | Cube | Attempts | Notes |
|---|---|---|---|---|
| `2026-09-27-macbook-pro-2021-gan12ui.json` | MacBook Pro 2021, macOS 26.6.2, Chrome 153 | GAN 12 ui FreePlay (`uiFp 138`, fw 8.62) | 12 solved | the session spans a cube reconnection after a 3-hour pause: `cubeMs` restarts between attempts 1 and 2; within each attempt the cube's clock runs 0.7% slow with ±13 ms jitter, and across pauses the clocks advance equally, so a per-session fit drifts (see `docs/DEVICES.md`) |
| `2026-09-27-thinkphone-gan12ui.json` | ThinkPhone, Android 16, Chrome 155 | same cube | 3 solved | MAC address typed once (the Chrome flag was off); three attempts in 100 s; one clock fit holds to ±15 ms, slope 1.0069 |
| `2026-09-27-macbook-pro-2021-gan356i3.json` | MacBook Pro 2021, macOS 26.6.2, Chrome 153 | GAN 356 i3 (`GANi3I1w`, hw 0.1, fw 7.76, gyro) | 6 solved | **schema 2**, the first export with clips: two H.264 High clips per attempt (`avc1.640028`, 1080p30, 13–26 MB each, no audio track, issue #33), per-attempt clock fits with slope 1.0010–1.0017 (this cube's clock runs 0.1% slow, against the 12 ui's 0.7%), residual p95 18–22 ms; every move ended its packet, so those fits have every move as a sample; no sync check result. Attempt 6 (the export taken again after it): the turn and turn back of a failed sync check became its first two scramble moves, then 434 s without a turn, during which the cube idle-disconnected and reconnected (its `cubeMs` restarted: 561,080 at the second move, 10,977 at the third), then more sync-check turns (B' B, F' F) and the scramble from its seventh move; its scramble clip was refused, its start (2 s before the first move) older than the 90 s in memory (`session.notes`, issue #34), so it has the solve clip only; its recorded clock fit is one line through both cube clocks (slope −0.81, residual p95 48 s: the bug that T2.9 fixed), while the 112 moves after the reconnection fit a slope of 1.00086 (residual p95 32.6 ms), which is the session's `clock.cube`, the fit of the connection |

Round 1 found no functional issue (the owner's report in issues #19 and #20).
