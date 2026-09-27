import { uptime } from 'node:os';
import { expect, test, type Page } from '@playwright/test';

// The capture pipeline (docs/PLAN.md, T2.2) on Chrome's fake camera, through the capture lab
// (/capture-lab). The fake camera runs at 20 fps unless told otherwise; `fps=30` gives the 1080p30
// of the owner's cameras (docs/DEVICES.md). The fake microphone comes with it, and the camera
// prompt is answered "Allow". Launch options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});

/** The page's copy of `CaptureStats`. */
interface Stats {
  readonly fps: number;
  readonly encodedFps: number;
  readonly dropped: number;
  readonly queue: number;
  readonly bufferSeconds: number;
  readonly bufferBytes: number;
  readonly codec: string | null;
  readonly audioCodec: string | null;
}

/** The parts of the lab's cut summary (apps/web/src/app/capture-lab/cut-summary.ts) used here. */
interface CutSummary {
  readonly requested: { startHostMs: number; endHostMs: number; seconds: number };
  readonly latencyMs: number;
  readonly timeOrigin: number;
  readonly truncatedStart: boolean;
  readonly truncatedEnd: boolean;
  readonly clock: {
    firstTimestampUs: number;
    timestampMinusPageNowMs: number;
    arrivalDriftMsPerMinute: number | null;
    audioMinusVideoOffsetMs: number | null;
  };
  readonly video: {
    codec: string;
    width: number;
    height: number;
    chunks: number;
    bytes: number;
    firstType: 'key' | 'delta' | null;
    durationMs: number;
    bitrateKbps: number;
    timestampsUs: number[];
    arrivalsHostMs: number[];
  };
  readonly audio: {
    codec: string;
    chunks: number;
    firstTimestampUs: number | null;
    arrival: { offsetMs: number; residualP95Ms: number } | null;
  } | null;
  readonly frames: {
    t0HostMs: number;
    dtMs: number[];
    keyframes: number[];
    arrival: { offsetMs: number; residualP95Ms: number };
  };
}

async function readJson<T>(page: Page, testId: string): Promise<T> {
  return JSON.parse((await page.getByTestId(testId).textContent()) ?? 'null') as T;
}

async function history(page: Page): Promise<Stats[]> {
  return readJson<Stats[]>(page, 'lab-stats-json');
}

/** Cuts the last `seconds` and returns the page's summary of the cut. */
async function cutLast(page: Page, seconds: number): Promise<CutSummary> {
  await page.getByLabel('Cut length (s)').fill(String(seconds));
  await page.getByRole('button', { name: `Cut the last ${String(seconds)} s` }).click();
  await expect(page.getByTestId('lab-status')).toHaveText(/^Cut \d+ frames/);
  await expect
    .poll(async () => (await readJson<CutSummary>(page, 'lab-cut-json')).requested.seconds)
    .toBe(seconds);
  return readJson<CutSummary>(page, 'lab-cut-json');
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (value: number, digits = 1): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

test('10 s of the fake camera at 1080p30 encode without drops, and the last 3 s cut from a keyframe within 50 ms', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/capture-lab');
  await expect(page.getByRole('heading', { level: 1, name: 'Capture lab' })).toBeVisible();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText(/^Recording .*: 1920×1080 at 30 fps/);

  // 10 s of encoded video in the buffer.
  await expect
    .poll(async () => (await history(page)).at(-1)?.bufferSeconds ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(10);
  const seconds = await history(page);
  const last = seconds[seconds.length - 1];
  expect(last.dropped).toBe(0);
  expect(last.codec).toMatch(/^(avc1\.640028|avc1\.4d0028|vp09\.00\.40\.08)$/);
  // Every second once the encoder runs (after the first, which holds the half-second warm-up):
  // about 30 frames encoded.
  const encoding = seconds.filter((stats) => stats.bufferSeconds >= 1.5);
  expect(encoding.length).toBeGreaterThanOrEqual(8);
  expect(median(encoding.map((stats) => stats.encodedFps))).toBeGreaterThanOrEqual(27);
  expect(median(encoding.map((stats) => stats.encodedFps))).toBeLessThanOrEqual(33);
  expect(Math.max(...seconds.map((stats) => stats.queue))).toBeLessThanOrEqual(8);

  // The last 3 s: from the keyframe at or before the start (at most one GOP, 1 s, earlier), in
  // under 50 ms, covering the 3 s asked for to within 10%.
  const three = await cutLast(page, 3);
  expect(three.latencyMs).toBeLessThan(50);
  expect(three.truncatedStart).toBe(false);
  expect(three.video.firstType).toBe('key');
  expect(three.frames.keyframes[0]).toBe(0);
  const leadMs = three.requested.startHostMs - three.frames.t0HostMs;
  expect(leadMs).toBeGreaterThanOrEqual(-5);
  expect(leadMs).toBeLessThanOrEqual(1100);
  const coveredMs = three.frames.t0HostMs + three.video.durationMs - three.requested.startHostMs;
  expect(Math.abs(coveredMs - 3000)).toBeLessThanOrEqual(300);
  expect(three.video).toMatchObject({ codec: last.codec, width: 1920, height: 1080 });
  expect(three.frames.dtMs).toHaveLength(three.video.chunks);
  if (last.audioCodec !== null) {
    expect(three.audio?.codec).toBe(last.audioCodec);
    expect(three.audio?.chunks).toBeGreaterThan(0);
  }

  // The last 10 s: the encoded frame rate and bitrate over 10 s, and what the frames' timestamps
  // are (docs/DEVICES.md, "VideoFrame.timestamp").
  const ten = await cutLast(page, 10);
  const uptimeS = uptime();
  expect(ten.truncatedStart).toBe(false);
  const timestamps = ten.video.timestampsUs;
  const arrivals = ten.video.arrivalsHostMs;
  const spanS = (timestamps[timestamps.length - 1] - timestamps[0]) / 1e6;
  const encodedFps = (timestamps.length - 1) / spanS;
  expect(encodedFps).toBeGreaterThanOrEqual(27);
  expect(encodedFps).toBeLessThanOrEqual(33);
  const offsets = timestamps.map((timestampUs, index) => arrivals[index] - timestampUs / 1000);
  const offsetMedian = median(offsets);
  if (ten.clock.audioMinusVideoOffsetMs !== null) {
    // Audio and video timestamps share one clock: their arrival offsets differ by the pipelines'
    // latencies only, milliseconds (the cut takes the audio by timestamps).
    expect(Math.abs(ten.clock.audioMinusVideoOffsetMs)).toBeLessThan(100);
  }

  const report = {
    codec: last.codec,
    audioCodec: last.audioCodec,
    encodedFpsOver10s: round(encodedFps, 2),
    encodedFpsPerSecond: encoding.map((stats) => stats.encodedFps),
    dropped: last.dropped,
    maxQueue: Math.max(...seconds.map((stats) => stats.queue)),
    bitrateKbps: ten.video.bitrateKbps,
    bufferBytesAt10s: last.bufferBytes,
    cut3: {
      latencyMs: three.latencyMs,
      frames: three.video.chunks,
      durationMs: three.video.durationMs,
      leadBeforeStartMs: round(leadMs),
      coveredMs: round(coveredMs),
      truncatedEnd: three.truncatedEnd,
      keyframes: three.frames.keyframes,
      audioChunks: three.audio?.chunks ?? null,
    },
    cut10LatencyMs: ten.latencyMs,
    timestamp: {
      ...ten.clock,
      systemUptimeS: uptimeS,
      pageTimeOrigin: ten.timeOrigin,
      // Relative to their median, which is printed as a date: the epoch time of the clock's zero.
      arrivalMinusTimestampMs: {
        min: round(Math.min(...offsets) - offsetMedian, 2),
        p5: round(percentile(offsets, 5) - offsetMedian, 2),
        p95: round(percentile(offsets, 95) - offsetMedian, 2),
        max: round(Math.max(...offsets) - offsetMedian, 2),
        medianAsDate: new Date(offsetMedian).toISOString(),
      },
      fit: ten.frames.arrival,
      audioFit: ten.audio?.arrival ?? null,
      audioFirstMinusVideoFirstUs:
        ten.audio?.firstTimestampUs == null ? null : ten.audio.firstTimestampUs - timestamps[0],
    },
  };
  console.log(`capture: ${JSON.stringify(report, null, 2)}`);
  test.info().annotations.push({ type: 'capture', description: JSON.stringify(report) });

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Stopped.');
});

test('the production build under /cubetrace/ starts the worker from its own chunk', async ({
  page,
}) => {
  // The production build that pwa.spec.ts serves like GitHub Pages (playwright.config.ts).
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto('http://localhost:4300/cubetrace/capture-lab');
  await page.getByRole('button', { name: 'Start' }).click();

  await expect
    .poll(async () => (await history(page)).at(-1)?.codec ?? null, { timeout: 20_000 })
    .not.toBeNull();
  expect(workers).toContainEqual(
    expect.stringMatching(/^http:\/\/localhost:4300\/cubetrace\/worker-[A-Z0-9]{8}\.js$/),
  );

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Stopped.');
});
