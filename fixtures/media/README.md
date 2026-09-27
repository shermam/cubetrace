# Encoded media samples

Samples of what the capture pipeline encodes (`packages/capture`, `docs/PLAN.md` T2.2 and T2.3), for
the Node tests of the muxer, the clip writer and the capture worker. Read-only, like the other
fixtures; they show Chrome's synthetic test picture and tone, nothing personal.

| File | What | Made |
|---|---|---|
| `fake-camera-vp9-1s.json` | One GOP (30 frames, about 1 s) of Chrome's fake camera at 1920×1080 and 30 fps, VP9 (`vp09.00.40.08`), with the 51 Opus chunks of the fake microphone that overlap it, 236 kB: a `Cut` (`packages/capture/src/cut.ts`) as JSON, every `ArrayBuffer` (the chunks' `data`, the decoder configs' `description`) in base64 | 2026-09-27 by `node apps/web/scripts/record-media-fixture.mts` with the dev server up (`npm start`): Playwright's Chromium 141 with `--use-fake-device-for-media-stream=fps=30` opens `/capture-lab`, records 4 s and cuts from the second keyframe of the last 2.5 s to just before the next; `recorded` in the file has the browser's user agent |

Chromium without proprietary codecs (Playwright's, CI's) encodes VP9 and Opus only; an H.264 and AAC
sample would come from Chrome on a real device.
