# Session exports from real hardware

Exports (`Sessions → Export`) of the owner's manual rounds, kept as test data for anything that
must hold on a real GAN cube: Bluetooth packet timing, the cube clock, gyroscope pickups, the
phase detector on live solves. Read-only, like `fixtures/solves.json`; they hold no personal data
beyond the device label and the browser's user-agent string.

| File | Device | Cube | Attempts | Notes |
|---|---|---|---|---|
| `2026-09-27-macbook-pro-2021-gan12ui.json` | MacBook Pro 2021, macOS 26.6.2, Chrome 153 | GAN 12 ui FreePlay (`uiFp 138`, fw 8.62) | 12 solved | the session spans a cube reconnection after a 3-hour pause: `cubeMs` restarts between attempts 1 and 2; the cube's clock also loses time during pauses of minutes (see `docs/DEVICES.md`) |
| `2026-09-27-thinkphone-gan12ui.json` | ThinkPhone, Android 16, Chrome 155 | same cube | 3 solved | MAC address typed once (the Chrome flag was off); three attempts in 100 s, one clock fit holds to ±15 ms |

Round 1 found no functional issue (the owner's report in issues #19 and #20).
