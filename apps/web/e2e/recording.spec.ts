import { readFile, stat } from 'node:fs/promises';

import { type Download, type Page, expect, test } from '@playwright/test';
import {
  FRAMES_SCHEMA,
  type AttemptRecord,
  type FramesJson,
  type VideoClip,
} from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';

import { exportSession } from './helpers/export';
import { fixtureSolve } from './helpers/fixtures';
import { currentSessionId, demoPath, expectSolves, replayDemo, solveRows } from './helpers/timer';

// The recording in the timer (docs/PLAN.md, T2.4) with Chrome's fake camera at 30 fps and its fake
// microphone (the prompts answered "Allow"), and the demo cube: every attempt gets a clip of its
// scramble and one of its solve in its folder of the origin private file system, listed in its
// record's `video`; the solve list's badge opens them in the viewer, which plays them and downloads
// them. The same demo solve, replayed with the camera off and then on, is timed alike. And saving a
// clip while recording costs the camera no frame (the clip worker muxes and writes it). Launch
// options force a browser of their own for this file.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'],
  },
});
// One after the other: each encodes 1080p30 in software, and two at once on CI's four CPUs cost
// the fake camera frames that have nothing to do with the clips.
test.describe.configure({ mode: 'default' });

const SPEED = 20;

/** Replays of the demo solve timed with the camera off, and as many with it on. */
const REPLAYS = 4;

/** The margins of the clips (docs/PLAN.md, T2.4). */
const SCRAMBLE_LEAD_MS = 2000;
const SOLVE_LEAD_MS = 3000;
const TAIL_MS = 1000;

/** The files of attempt `index`'s folder, with their sizes, read in the page. */
async function attemptFiles(
  page: Page,
  sessionId: string,
  index: number,
): Promise<Record<string, number>> {
  return page.evaluate(
    async ({ sessionId, folder }) => {
      let dir = await navigator.storage.getDirectory();
      for (const name of ['sessions', sessionId, 'attempts', folder]) {
        dir = await dir.getDirectoryHandle(name);
      }
      const files: Record<string, number> = {};
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
          files[name] = (await handle.getFile()).size;
        }
      }
      return files;
    },
    { sessionId, folder: String(index).padStart(4, '0') },
  );
}

/** A text file of attempt `index`'s folder, read in the page. */
async function attemptText(
  page: Page,
  sessionId: string,
  index: number,
  name: string,
): Promise<string> {
  return page.evaluate(
    async ({ sessionId, folder, name }) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ['sessions', sessionId, 'attempts', folder]) {
        dir = await dir.getDirectoryHandle(part);
      }
      return (await (await dir.getFileHandle(name)).getFile()).text();
    },
    { sessionId, folder: String(index).padStart(4, '0'), name },
  );
}

/** The frames' host times of a frames file: `t0HostMs` plus the running sum of `dtMs`. */
function frameTimes(frames: FramesJson): number[] {
  let at = frames.t0HostMs;
  return frames.dtMs.map((dt) => (at += dt));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The median, the mean of the middle two for an even count. */
function middle(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

/** The frame intervals longer than one and a half frames: a frame lost there. */
function doubleIntervals(dtMs: readonly number[]): number[] {
  const typical = median(dtMs.slice(1));
  return dtMs.slice(1).filter((dt) => dt > 1.5 * typical);
}

/** The interval between keyframes, ms: one GOP. */
function gopMs(frames: FramesJson): number {
  const times = frameTimes(frames);
  const [first, second] = frames.keyframes;
  return frames.keyframes.length < 2 ? 1000 : times[second] - times[first];
}

const round = (value: number, digits = 1): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

test('demo solves with the camera on get their two clips, which play and download; their time is the same as with the camera off', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const solve = fixtureSolve(0);

  // Attempt 1 with the page (not timed: the page is still loading), then REPLAYS attempts on the
  // settled page with the camera off.
  await page.goto(demoPath(0, SPEED));
  await expectSolves(page, 1);
  await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
    timeout: 30_000,
  });
  let attempts = 1;
  for (let k = 0; k < REPLAYS; k++) {
    await replayDemo(page);
    await expectSolves(page, ++attempts);
  }
  const sessionId = (await currentSessionId(page)) ?? '';

  // The camera on: it records once the stream is there (a session is under way).
  await page.getByTestId('camera-section').locator('summary').click();
  await page.getByTestId('camera-toggle').click();
  await expect(page.getByTestId('recording-state')).toHaveAttribute('data-status', 'recording', {
    timeout: 15_000,
  });
  const stats = page.getByTestId('recording-stats');
  await expect
    .poll(async () => Number(await stats.getAttribute('data-buffer-seconds')), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(4);
  // The fake microphone recorded raw (T2.12), as it is by default.
  await expect(page.getByTestId('recording-codecs')).toHaveText(
    /^vp09\.00\.40\.08 at 4 Mbps, opus, mic raw$/,
  );

  // The same replays with the camera on: each attempt gets both clips, the solve's a second after
  // the solve. The next replay waits for them, as a solver's next solve comes after the next
  // scramble: the clips are saved while the next attempt is scrambled.
  const firstOn = attempts + 1;
  const badges = solveRows(page).getByTestId('clip-badge');
  for (let k = 0; k < REPLAYS; k++) {
    await replayDemo(page);
    await expectSolves(page, ++attempts);
    await expect(badges.first()).toHaveText(/^\s*2 clips, [\d.]+ [kM]B\s*$/, {
      timeout: 20_000,
    });
  }
  await expect(badges).toHaveCount(REPLAYS);
  for (let k = 0; k < REPLAYS; k++) {
    await expect(badges.nth(k)).toHaveText(/^\s*2 clips, [\d.]+ [kM]B\s*$/);
  }
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await expect(stats).toHaveAttribute('data-dropped', '0');

  // Each attempt's folder: the record and both clips, each with its frames file; each clip starts
  // at the keyframe at or before its start (so at most one GOP earlier) and ends a second after its
  // segment. Frames lost (double intervals) are counted for the report: a busy machine can lose one
  // anywhere, and the test below checks the moments after a clip is saved.
  const isFrames = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);
  const margins: Record<string, number[]> = {};
  let lost = 0;
  let record: AttemptRecord | undefined;
  let camera = '';
  let solveFrames: FramesJson | undefined;
  for (let index = firstOn; index <= attempts; index++) {
    record = JSON.parse(await attemptText(page, sessionId, index, 'attempt.json')) as AttemptRecord;
    expect(record.video.map((clip) => clip.segment)).toEqual(['scramble', 'solve']);
    camera = record.video[0].camera;
    expect(await attemptFiles(page, sessionId, index)).toEqual({
      'attempt.json': expect.any(Number) as unknown,
      [`${camera}.scramble.mp4`]: record.video[0].bytes,
      [`${camera}.scramble.frames.json`]: expect.any(Number) as unknown,
      [`${camera}.solve.mp4`]: record.video[1].bytes,
      [`${camera}.solve.frames.json`]: expect.any(Number) as unknown,
    });
    const { scrambleStart, scrambleDone, solveStart, solveEnd } = record.events;
    for (const clip of record.video) {
      const frames = JSON.parse(
        await attemptText(page, sessionId, index, clip.framesFile),
      ) as FramesJson;
      expect(isFrames(frames), JSON.stringify(isFrames.errors)).toBe(true);
      expect(clip).toMatchObject({
        codec: 'vp09.00.40.08',
        audio: 'opus',
        width: 1920,
        height: 1080,
        fpsNominal: 30,
        frames: frames.dtMs.length,
        firstFrameHostMs: frames.t0HostMs,
        crop: null,
        syncResidualMs: null,
      });
      const times = frameTimes(frames);
      const [begin, end] =
        clip.segment === 'scramble'
          ? [scrambleStart ?? 0, scrambleDone ?? 0]
          : [solveStart ?? 0, solveEnd ?? 0];
      const lead = clip.segment === 'scramble' ? SCRAMBLE_LEAD_MS : SOLVE_LEAD_MS;
      const gop = gopMs(frames);
      const frameMs = median(frames.dtMs.slice(1));
      const beforeMs = begin - clip.firstFrameHostMs;
      const afterMs = times[times.length - 1] - end;
      const what = `attempt ${String(index)}, ${clip.segment}`;
      expect(beforeMs, `${what}: from ${String(beforeMs)} ms before`).toBeGreaterThanOrEqual(
        lead - 1,
      );
      expect(beforeMs, `${what}: from ${String(beforeMs)} ms before`).toBeLessThanOrEqual(
        lead + gop + frameMs,
      );
      expect(afterMs, `${what}: to ${String(afterMs)} ms after`).toBeGreaterThanOrEqual(
        TAIL_MS - 2 * frameMs,
      );
      lost += doubleIntervals(frames.dtMs).length;
      (margins[`${clip.segment}FirstFrameBeforeMs`] ??= []).push(round(beforeMs));
      (margins[`${clip.segment}LastFrameAfterMs`] ??= []).push(round(afterMs));
      if (clip.segment === 'solve') {
        solveFrames = frames;
      }
    }
  }
  if (record === undefined || solveFrames === undefined) {
    throw new Error('No attempt was recorded.');
  }

  // The viewer, from the last attempt's badge: its solve clip plays (its metadata loads), with the
  // solve's moves by time.
  await badges.first().click();
  const viewer = page.getByTestId('clip-viewer');
  await expect(viewer).toBeVisible();
  const video = viewer.getByTestId('clip-video');
  await expect(video).toHaveAttribute('data-state', 'loaded', { timeout: 10_000 });
  const played = await video.evaluate((element: HTMLVideoElement) => ({
    duration: element.duration,
    width: element.videoWidth,
    height: element.videoHeight,
    src: element.src,
  }));
  expect(played.src).toMatch(/^blob:/);
  expect([played.width, played.height]).toEqual([1920, 1080]);
  const solveClip = record.video[1];
  const spanMs = (frameTimes(solveFrames).at(-1) ?? 0) - solveClip.firstFrameHostMs;
  expect(played.duration * 1000).toBeGreaterThan(0.9 * spanMs);
  await expect(viewer.getByTestId('clip-move')).toHaveCount(solve.moves.length);

  // Download: both clips, their frame times, and attempt.json.
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await viewer.getByTestId('clip-download').click();
  await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(5);
  const prefix = `cubetrace-session-${sessionId}-attempt-${String(attempts).padStart(4, '0')}-`;
  expect(downloads.map((download) => download.suggestedFilename()).sort()).toEqual(
    [
      `${prefix}${camera}.scramble.mp4`,
      `${prefix}${camera}.scramble.frames.json`,
      `${prefix}${camera}.solve.mp4`,
      `${prefix}${camera}.solve.frames.json`,
      `${prefix}attempt.json`,
    ].sort(),
  );
  for (const download of downloads) {
    const name = download.suggestedFilename();
    const path = await download.path();
    const clip = record.video.find((entry) => name.endsWith(entry.file));
    if (clip !== undefined) {
      expect((await stat(path)).size, name).toBe(clip.bytes);
    } else if (name.endsWith('attempt.json')) {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(record);
    }
  }
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();

  // The export: valid against schema 2, the clips in the attempts recorded with the camera on, the
  // camera in the session.
  const exported = await exportSession(page);
  expect(exported.attempts.map((attempt) => attempt.video.length)).toEqual([
    ...Array<number>(firstOn - 1).fill(0),
    ...Array<number>(REPLAYS).fill(2),
  ]);
  expect(exported.attempts.at(-1)).toEqual(record);
  expect(exported.session.cameras.map((entry) => entry.label)).toEqual([camera]);
  expect(exported.session.audio).toBe(true);
  expect(exported.session.notes).toBe('');
  await expect(page.getByTestId('session-clips')).toHaveText(
    new RegExp(`^\\s*${String(2 * REPLAYS)} clips, [\\d.]+ [kM]B\\s*$`),
  );
  await expect(page.getByTestId('storage-meter-text')).toHaveText(/ of .*\(\d+%\)$/);

  // The same demo solve, off and on: recording does not delay the timer. One replay's time varies
  // by a few milliseconds either way (the demo cube's timers), so the medians are compared; a busy
  // runner still moves a median of four by up to about 10 ms (CI saw differences of -7.4, +11.2,
  // -5.2 and +5.0 ms with nothing wrong), so the limit is 15 ms: a main thread held by the
  // recording costs hundreds, as the frame drops before T2.4 did.
  const times = exported.attempts.map((attempt) => attempt.result.timeMs ?? 0);
  const off = times.slice(1, firstOn - 1);
  const on = times.slice(firstOn - 1);
  const report = {
    expectedMs: round(solve.time_ms / SPEED),
    timeMsCameraOff: off.map((ms) => round(ms)),
    timeMsCameraOn: on.map((ms) => round(ms)),
    medianOffMs: round(middle(off)),
    medianOnMs: round(middle(on)),
    differenceMs: round(middle(on) - middle(off)),
    camera,
    clips: margins,
    doubleIntervalsInTheClips: lost,
  };
  console.log(`recording: ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'recording', description: JSON.stringify(report) });
  expect(Math.abs(middle(on) - middle(off))).toBeLessThan(15);
});

test('saving a 10 s clip while recording loses no frame: none dropped, no double interval after it', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/capture-lab');
  await page.getByLabel('Cut length (s)').fill('10');
  await page.getByRole('button', { name: 'Start' }).click();
  const history = async (): Promise<{ bufferSeconds: number; dropped: number }[]> =>
    JSON.parse((await page.getByTestId('lab-stats-json').textContent()) ?? '[]') as {
      bufferSeconds: number;
      dropped: number;
    }[];
  await expect
    .poll(async () => (await history()).at(-1)?.bufferSeconds ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(11);

  // A 10 s clip, saved mid-way: the capture worker cuts it, the clip worker muxes and writes it.
  await page.getByRole('button', { name: 'Mux and save the last 10 s' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText(/^Saved lab\.solve\.mp4: \d+ frames/, {
    timeout: 20_000,
  });
  const saved = JSON.parse((await page.getByTestId('lab-clip-json').textContent()) ?? '{}') as {
    clip: VideoClip;
    frames: { durationMs: number };
    latencyMs: number;
  };
  const savedEndMs = saved.clip.firstFrameHostMs + saved.frames.durationMs;

  // Four seconds more, then the last 6 s: the frames around and after the save.
  await expect
    .poll(async () => (await history()).at(-1)?.bufferSeconds ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(15);
  await page.getByLabel('Cut length (s)').fill('6');
  await page.getByRole('button', { name: 'Cut the last 6 s' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText(/^Cut \d+ frames/);
  const cut = JSON.parse((await page.getByTestId('lab-cut-json').textContent()) ?? '{}') as {
    frames: FramesJson;
  };
  const times = frameTimes({ ...cut.frames, schema: 2, camera: 'lab', segment: 'solve' });
  const typical = median(cut.frames.dtMs.slice(1));
  const after = cut.frames.dtMs.filter(
    (_dt, k) => k > 0 && times[k] > savedEndMs && times[k] <= savedEndMs + 1000,
  );
  expect(after.length).toBeGreaterThanOrEqual(25);
  expect(
    after.filter((dt) => dt > 1.5 * typical),
    'double intervals in the second after the save',
  ).toEqual([]);
  const last = (await history()).at(-1);
  expect(last?.dropped).toBe(0);

  const report = {
    savedFrames: saved.clip.frames,
    savedBytes: saved.clip.bytes,
    saveLatencyMs: saved.latencyMs,
    framesInTheSecondAfter: after.length,
    maxIntervalAfterMs: Math.max(...after),
    medianIntervalMs: typical,
    doubleIntervalsInTheLast6s: doubleIntervals(cut.frames.dtMs).length,
    dropped: last?.dropped,
  };
  console.log(`no drops: ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'no-drops', description: JSON.stringify(report) });

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('lab-status')).toHaveText('Stopped.');
});
