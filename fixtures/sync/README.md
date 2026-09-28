# Sync checks from real hardware

The files that "Download check data" saves (`apps/web/src/app/camera/sync-report.ts`) for the owner's
sync checks, kept as test data for the clapperboard (`packages/capture/src/clapperboard.ts`): every
frame's motion in the framing rectangle (`series`: its host time, mean difference and changed area),
the cube's moves, and what the detection of the day saw around each turn (`turns`, `result`).
Read-only, like the other fixtures; they hold the camera's label, the framing rectangle, the app's
build and the browser's user-agent string, nothing personal. As downloaded (issue #38), formatted with
Prettier.

| File | Check | On the day: T2.8, the first rise | Since T2.11: the middle of the motion, a trimmed spread |
|---|---|---|---|
| `2026-09-27-macbook-pro-2021-facetime-check-1.json` | 10 single turns (U, U′ five times), 659 frames over 22 s; framing rectangle 585×558 | failed: 10 of 10 turns matched, lag −85.8 ms, spread 341.4 ms (the limit is 83 ms at 30 fps) | passes: lag 38.3 ms, spread 51.2 ms over the 8 turns kept of 10 |
| `2026-09-27-macbook-pro-2021-facetime-check-2.json` | 10 single turns, the first 0.14 s after the first frame (no baseline), 442 frames over 15 s; rectangle 816×703 | failed: 9 of 10 matched, lag −269 ms, spread 343.5 ms | passes: lag 18.7 ms, spread 70.9 ms over the 7 turns kept of 9 |

Both on the MacBook Pro 2021's FaceTime HD camera at 1920×1080 and 30 fps (NV12 frames, copied out,
0.8 and 0.9 ms a frame at the median) with the GAN 356 i3, app 0.2.0 (commit 5ab4270) in Chrome 153.
The owner held the cube in the air close to the camera, both hands on it, and turned the top face
with the fingers, the rectangle around the cube and the hands. The changed area's median was 4.6 and
4.8% of the region's pixels, and each turn's peak 16 to 31%. T2.8's onset, the first frame of a
turn's window to rise above its baseline, came from 381 ms before the move to 8 ms after it: it caught
the hand getting ready. The peak of each turn's motion came from 90 ms before its move to 130 ms after.
`packages/capture/src/clapperboard-hardware.test.ts` replays both files through a copy of T2.8's
estimator, which gives the day's lags turn by turn and fails both checks, and through the detection
since T2.11, which passes both, their lags 20 ms apart.
