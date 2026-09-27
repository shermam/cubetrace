import { uptime } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { ATTEMPT_SCHEMA, FRAMES_SCHEMA, type FramesJson, type VideoClip } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

// The capture pipeline (docs/PLAN.md, T2.2) on Chrome's fake camera, through the capture lab
// (/capture-lab), and its clips (T2.3): muxed into MP4 and written into the origin private file
// system by the worker. The fake camera runs at 20 fps unless told otherwise; `fps=30` gives the
// 1080p30 of the owner's cameras (docs/DEVICES.md). The fake microphone comes with it, and the
// camera prompt is answered "Allow". Launch options force a browser of their own for this file.
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

/** The lab's summary of the clip it saved (apps/web/src/app/capture-lab/capture-lab-page.ts). */
interface SavedClip {
  readonly clip: VideoClip;
  readonly folder: string;
  readonly files: { name: string; bytes: number }[];
  readonly frames: { count: number; t0HostMs: number; durationMs: number; keyframes: number[] };
  readonly latencyMs: number;
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

/** Records at least `seconds` of encoded video, from the lab's Start. */
async function record(page: Page, seconds: number): Promise<void> {
  await page.getByRole('button', { name: 'Start' }).click();
  await expect
    .poll(async () => (await history(page)).at(-1)?.bufferSeconds ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(seconds);
}

/** Mux and save of the last 3 s, and the lab's summary of the clip once it is saved. */
async function saveLast3s(page: Page): Promise<SavedClip> {
  await page.getByRole('button', { name: 'Mux and save the last 3 s' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText(/^Saved lab\.solve\.mp4: \d+ frames/, {
    timeout: 20_000,
  });
  return readJson<SavedClip>(page, 'lab-clip-json');
}

/** A file of the lab's clip folder in the origin private file system, read in the page. */
async function readLabFile(page: Page, name: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (file) => {
    const root = await navigator.storage.getDirectory();
    const folder = await (
      await (
        await (await root.getDirectoryHandle('sessions')).getDirectoryHandle('capture-lab')
      ).getDirectoryHandle('attempts')
    ).getDirectoryHandle('0001');
    const bytes = new Uint8Array(
      await (await (await folder.getFileHandle(file)).getFile()).arrayBuffer(),
    );
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
  }, name);
  return Buffer.from(base64, 'base64');
}

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

test('the last 3 s muxed and saved: an MP4 and its frames.json in OPFS, which play with the duration and the frames they say', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/capture-lab');
  await record(page, 4);

  const saved = await saveLast3s(page);

  // The two files in the attempt's folder of the lab's scratch session, and nothing else.
  expect(saved.folder).toBe('sessions/capture-lab/attempts/0001');
  expect(saved.files.map((file) => file.name)).toEqual(['lab.solve.frames.json', 'lab.solve.mp4']);
  expect(saved.files[1].bytes).toBe(saved.clip.bytes);
  // The video[] entry: valid against attempt.schema.json's clip, as the worker muxed it.
  const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
  ajv.addSchema(ATTEMPT_SCHEMA);
  const isClip = ajv.getSchema(`${String(ATTEMPT_SCHEMA['$id'])}#/$defs/clip`);
  expect(isClip?.(saved.clip), ajv.errorsText(isClip?.errors)).toBe(true);
  const stats = (await history(page)).at(-1);
  expect(saved.clip).toMatchObject({
    camera: 'lab',
    segment: 'solve',
    file: 'lab.solve.mp4',
    framesFile: 'lab.solve.frames.json',
    codec: stats?.codec,
    audio: stats?.audioCodec,
    width: 1920,
    height: 1080,
    fpsNominal: 30,
    crop: null,
    syncResidualMs: null,
  });

  // frames.json, read back from OPFS: valid, one entry per frame of the clip.
  const frames = JSON.parse(
    (await readLabFile(page, 'lab.solve.frames.json')).toString(),
  ) as FramesJson;
  const isFrames = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);
  expect(isFrames(frames), JSON.stringify(isFrames.errors)).toBe(true);
  expect(frames.dtMs).toHaveLength(saved.clip.frames);
  expect(frames.t0HostMs).toBe(saved.clip.firstFrameHostMs);
  expect(frames.keyframes[0]).toBe(0);
  // 3 s asked for, from the keyframe at or before its start: 3 to 4 s of frames.
  expect(saved.frames.durationMs).toBeGreaterThanOrEqual(2900);
  expect(saved.frames.durationMs).toBeLessThanOrEqual(4100);

  // The MP4 in a <video>: its metadata loads, with the duration of the frames (within 10%) and
  // their size; then it plays to the end.
  await expect(page.getByTestId('lab-clip-metadata')).toHaveText(/^The video element reads/);
  const video = page.getByTestId('lab-clip-video');
  const metadata = await video.evaluate((element: HTMLVideoElement) => ({
    durationS: element.duration,
    width: element.videoWidth,
    height: element.videoHeight,
  }));
  expect(Math.abs(metadata.durationS * 1000 - saved.frames.durationMs)).toBeLessThanOrEqual(
    0.1 * saved.frames.durationMs,
  );
  expect([metadata.width, metadata.height]).toEqual([1920, 1080]);
  const played = await video.evaluate(async (element: HTMLVideoElement) => {
    const ended = new Promise<void>((resolve) => {
      element.addEventListener('ended', () => {
        resolve();
      });
      // A clip that stops playing fails the test below rather than hanging it.
      setTimeout(resolve, 20_000);
    });
    element.playbackRate = 4;
    await element.play();
    await ended;
    const quality = element.getVideoPlaybackQuality();
    return { ended: element.ended, frames: quality.totalVideoFrames, error: element.error?.code };
  });
  expect(played).toMatchObject({ ended: true, error: undefined });

  // The MP4 read back from OPFS and demuxed: as many frames as frames.json, the codecs of the
  // entry.
  const mp4 = await readLabFile(page, 'lab.solve.mp4');
  expect(mp4.length).toBe(saved.clip.bytes);
  const input = new Input({ source: new BufferSource(new Uint8Array(mp4)), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  const packets = (await videoTrack?.computePacketStats())?.packetCount;
  expect(packets).toBe(frames.dtMs.length);
  expect((await videoTrack?.getCodecParameterString())?.startsWith(saved.clip.codec)).toBe(true);
  expect(audioTrack === null ? null : await audioTrack.getCodecParameterString()).toBe(
    saved.clip.audio,
  );
  const fileDurationMs = (await input.computeDuration()) * 1000;
  expect(Math.abs(fileDurationMs - saved.frames.durationMs)).toBeLessThanOrEqual(
    0.1 * saved.frames.durationMs,
  );

  const report = {
    saveLatencyMs: saved.latencyMs,
    mp4Bytes: saved.clip.bytes,
    framesJsonBytes: saved.files[0].bytes,
    frames: saved.clip.frames,
    keyframes: saved.frames.keyframes,
    framesDurationMs: saved.frames.durationMs,
    videoElementDurationMs: round(metadata.durationS * 1000),
    fileDurationMs: round(fileDurationMs),
    mp4Packets: packets,
    playedFrames: played.frames,
    codec: saved.clip.codec,
    audio: saved.clip.audio,
    audioPackets: audioTrack === null ? null : (await audioTrack.computePacketStats()).packetCount,
    audioFromMs: audioTrack === null ? null : round((await audioTrack.getFirstTimestamp()) * 1000),
    audioToMs: audioTrack === null ? null : round((await audioTrack.computeDuration()) * 1000),
  };
  console.log(`clip: ${JSON.stringify(report, null, 2)}`);
  test.info().annotations.push({ type: 'clip', description: JSON.stringify(report) });

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Stopped.');
});

test('the production build under /cubetrace/ starts the worker from its own chunk, which saves clips', async ({
  page,
}) => {
  test.setTimeout(60_000);
  // The production build that pwa.spec.ts serves like GitHub Pages (playwright.config.ts).
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto('http://localhost:4300/cubetrace/capture-lab');
  await record(page, 3.5);

  expect(workers).toContainEqual(
    expect.stringMatching(/^http:\/\/localhost:4300\/cubetrace\/worker-[A-Z0-9]{8}\.js$/),
  );
  // mediabunny, bundled into the worker's chunk, muxes there too.
  const saved = await saveLast3s(page);
  expect(saved.clip.frames).toBe(saved.frames.count);
  await expect(page.getByTestId('lab-clip-metadata')).toHaveText(/^The video element reads/);

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Stopped.');
});
