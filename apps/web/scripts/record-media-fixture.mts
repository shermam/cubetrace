// Records fixtures/media/fake-camera-vp9-1s.json (docs/PLAN.md, T2.3): about one second of Chrome's
// fake camera and microphone as the capture pipeline cuts it, for the Node tests of the muxer
// (packages/capture/src/mux.test.ts). It drives /capture-lab in Playwright's Chromium with the fake
// camera at 1080p30, which encodes VP9 and Opus (that build has no H.264 or AAC encoder,
// docs/TOOLCHAIN.md), and serializes the cut: a `Cut` (packages/capture/src/cut.ts) as JSON, with
// every ArrayBuffer (the chunks' `data`, the decoder configs' `description`) in base64.
//
// A one-off: run it once with the dev server up (`npm start`), from the repository root:
//   node apps/web/scripts/record-media-fixture.mts [http://localhost:4200]
// It reaches the lab's running capture through Angular's development-mode debugging API
// (`ng.getComponent`), so it needs the dev server, not a production build. Running it again
// replaces the fixture with another recording (the tests read whatever it holds).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:4200';
const target = resolve(import.meta.dirname, '../../../fixtures/media/fake-camera-vp9-1s.json');
/** docs/PLAN.md: the committed sample stays under 300 kB. */
const MAX_BYTES = 300_000;

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
});
try {
  const page = await browser.newPage();
  await page.goto(`${base}/capture-lab`);
  await page.getByRole('button', { name: 'Start' }).click();
  await page
    .getByTestId('lab-status')
    .filter({ hasText: /^Recording / })
    .waitFor();
  // Four seconds of encoded video, so that the cut below lies well inside the buffer.
  await page.waitForFunction(
    () => {
      const stats = JSON.parse(
        document.querySelector('[data-testid="lab-stats-json"]')?.textContent ?? '[]',
      ) as { bufferSeconds: number }[];
      return (stats.at(-1)?.bufferSeconds ?? 0) >= 4;
    },
    undefined,
    { timeout: 30_000 },
  );

  const json = await page.evaluate(async () => {
    interface Chunk {
      data: ArrayBuffer;
    }
    interface Config {
      description?: ArrayBuffer;
    }
    interface Track {
      decoderConfig: Config | null;
      chunks: Chunk[];
    }
    interface CutLike {
      video: Track;
      audio: Track | null;
      frames: { t0HostMs: number; dtMs: number[]; keyframes: number[] };
    }
    interface Lab {
      handle?: { cut(startHostMs: number, endHostMs: number): Promise<CutLike> };
    }
    const debug = (window as unknown as { ng?: { getComponent(element: Element): unknown } }).ng;
    const element = document.querySelector('app-capture-lab-page');
    const lab = element === null ? undefined : (debug?.getComponent(element) as Lab | undefined);
    const handle = lab?.handle;
    if (handle === undefined) {
      throw new Error('No running capture in the lab (is this the dev server?).');
    }
    const now = performance.timeOrigin + performance.now();
    // The last 2.5 s begin at a keyframe; the next keyframe, one second later, starts the sample:
    // from it to just before the keyframe after it, a whole GOP, all of it in the past.
    const probe = await handle.cut(now - 2500, now);
    const key = probe.frames.keyframes[1];
    const keyHostMs =
      probe.frames.t0HostMs + probe.frames.dtMs.slice(0, key + 1).reduce((sum, dt) => sum + dt, 0);
    const sample = await handle.cut(keyHostMs + 5, keyHostMs + 995);

    const base64 = (buffer: ArrayBuffer): string => {
      const bytes = new Uint8Array(buffer);
      let text = '';
      for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      }
      return btoa(text);
    };
    const track = (value: Track | null) =>
      value === null
        ? null
        : {
            ...value,
            decoderConfig:
              value.decoderConfig === null
                ? null
                : {
                    ...value.decoderConfig,
                    description:
                      value.decoderConfig.description === undefined
                        ? undefined
                        : base64(value.decoderConfig.description),
                  },
            chunks: value.chunks.map((chunk) => ({ ...chunk, data: base64(chunk.data) })),
          };
    return JSON.stringify({
      about:
        "About one second of Chrome's fake camera (1080p30) and microphone, as the capture " +
        "pipeline cuts it: a Cut (packages/capture/src/cut.ts) whose ArrayBuffers (the chunks' " +
        "data, the decoder configs' description) are base64. Made by " +
        'apps/web/scripts/record-media-fixture.mts through /capture-lab; see fixtures/media/README.md.',
      recorded: {
        date: new Date().toISOString().slice(0, 10),
        userAgent: navigator.userAgent,
        flags: '--use-fake-device-for-media-stream=fps=30',
      },
      cut: { ...sample, video: track(sample.video), audio: track(sample.audio) },
    });
  });

  const text = `${json}\n`;
  if (text.length > MAX_BYTES) {
    throw new Error(`The sample is ${String(text.length)} bytes, more than ${String(MAX_BYTES)}.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  console.log(`Wrote ${target}: ${String(text.length)} bytes.`);
} finally {
  await browser.close();
}
