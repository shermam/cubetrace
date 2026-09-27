import { TestBed } from '@angular/core/testing';
import type { AttemptRecord } from '@cubetrace/core';

import { bluetoothNavigator } from '../cube/cube-testing';
import {
  FAKE_FACETIME,
  FAKE_WEBCAM,
  FakeMediaDevices,
  mediaError,
  settle,
} from '../device/fake-browser';
import { StorageService } from '../device/storage-service';
import { inverse, ready, setup, turn, type Setup } from '../session/session-harness';
import { CameraService } from './camera-service';
import {
  CAPTURE_STARTER,
  CLIP_TAIL_MS,
  ENCODER_SETTLE_MS,
  RecordingService,
  SCRAMBLE_LEAD_MS,
  SOLVE_LEAD_MS,
  STORAGE_FULL,
} from './recording-service';
import { FakeCaptureStarter, statsOf } from './recording-testing';

/** How long after a segment's end its clip is saved. */
const SAVE_AFTER_MS = CLIP_TAIL_MS + ENCODER_SETTLE_MS;

interface Rig {
  readonly s: Setup;
  readonly media: FakeMediaDevices;
  readonly starter: FakeCaptureStarter;
  readonly recording: RecordingService;
  readonly camera: CameraService;
  readonly storage: StorageService;
}

/**
 * A timer on the fake clock, a camera and a microphone, and the recording with a fake pipeline (in a
 * browser without the capture APIs when `supported` is false).
 */
function rig(options: { supported?: boolean } = {}): Rig {
  const media = new FakeMediaDevices([FAKE_WEBCAM, FAKE_FACETIME]);
  const starter = new FakeCaptureStarter();
  starter.supported = options.supported ?? true;
  const s = setup({
    navigator: { ...bluetoothNavigator(true), mediaDevices: media },
    providers: [{ provide: CAPTURE_STARTER, useValue: starter }],
  });
  return {
    s,
    media,
    starter,
    recording: TestBed.inject(RecordingService),
    camera: TestBed.inject(CameraService),
    storage: TestBed.inject(StorageService),
  };
}

/** Runs the effects and lets the starts and stops they ask for finish. */
async function sync(r: Rig): Promise<void> {
  TestBed.tick();
  await r.recording.settled();
  await settle();
  TestBed.tick();
}

/** Moves the fake clock `ms` forward, running the timers due, and lets the saves they start go on. */
async function wait(r: Rig, ms: number): Promise<void> {
  r.s.timers.advance(ms);
  await settle();
}

/** The camera on, a cube connected (attempt 1 of a new session begins), the pipeline recording. */
async function recording(r: Rig) {
  await r.camera.start();
  const fake = await ready(r.s);
  await sync(r);
  const capture = r.starter.last;
  capture.emitStats(statsOf(5));
  return { fake, capture };
}

function sessionId(r: Rig): string {
  return r.s.service.session()?.id ?? '';
}

/** Everything but the clips: the attempt's timing, moves, phases and result. */
function withoutVideo(record: AttemptRecord | undefined): Partial<AttemptRecord> | undefined {
  if (record === undefined) {
    return undefined;
  }
  const copy: Partial<AttemptRecord> = { ...record };
  delete copy.video;
  return copy;
}

describe('RecordingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records while the camera is on and a session is under way, with the microphone', async () => {
    const r = rig();
    await r.camera.start();
    await sync(r);
    // The camera alone: nothing to record for yet.
    expect(r.starter.started).toEqual([]);
    expect(r.recording.status()).toBe('off');

    await ready(r.s);
    await sync(r);
    expect(r.starter.started).toHaveLength(1);
    const capture = r.starter.last;
    expect(capture.video).toBe(r.camera.stream()?.getVideoTracks()[0]);
    expect(capture.audio).toBe(r.media.audioTracks[0]);
    expect(capture.config).toEqual({ audio: true, quality: 'standard' });
    expect(r.media.requests.at(-1)).toEqual({ audio: true });
    expect(r.recording.status()).toBe('starting');

    capture.emitStats(statsOf(0.5));
    expect(r.recording.status()).toBe('recording');
    expect(r.recording.stats()).toEqual(statsOf(0.5));
    // The session holds the camera's entry, and says that it records audio.
    const session = r.s.service.session();
    expect(session?.cameras).toEqual([r.camera.cameraInfo()]);
    expect(session?.cameras[0]).toMatchObject({ label: 'laptop', deviceLabel: 'fake_device_0' });
    expect(session?.audio).toBe(true);
    await r.s.service.whenSaved();
    expect((await r.s.store.exportSession(sessionId(r))).session.cameras).toHaveLength(1);
    expect(r.recording.storage()).toEqual({ usage: 0, quota: 1e9, percent: 0 });

    // The camera off: the pipeline stops and lets the microphone go.
    r.camera.stop();
    await sync(r);
    expect(capture.stopped).toBe(true);
    expect(r.media.audioTracks[0].readyState).toBe('ended');
    expect(r.recording.status()).toBe('off');
    expect(r.recording.stats()).toBeNull();
  });

  it('starts again on another camera, and replaces its entry when its settings change', async () => {
    const r = rig();
    const { capture } = await recording(r);
    TestBed.tick();

    await r.camera.setControl('exposureTime', 30);
    TestBed.tick();
    expect(r.s.service.session()?.cameras).toHaveLength(1);
    expect(r.s.service.session()?.cameras[0].settings['exposureTime']).toBe(30);

    await r.camera.select('facetime');
    await sync(r);
    expect(capture.stopped).toBe(true);
    expect(r.starter.started).toHaveLength(2);
    expect(r.starter.last.video.label).toBe('FaceTime HD Camera (3A71:F4B5)');
    expect(r.media.audioTracks.map((track) => track.readyState)).toEqual(['ended', 'live']);
    r.starter.last.emitStats(statsOf(1));
    TestBed.tick();
    // One label, `laptop`: the entry is the camera recording now.
    expect(r.s.service.session()?.cameras).toEqual([r.camera.cameraInfo()]);
    expect(r.s.service.session()?.cameras[0].deviceLabel).toBe('FaceTime HD Camera (3A71:F4B5)');
  });

  it('records without audio when Settings says so, or when the microphone is refused', async () => {
    const r = rig();
    r.s.settings.setRecordAudio(false);
    await recording(r);
    expect(r.starter.last.audio).toBeNull();
    expect(r.starter.last.config).toEqual({ audio: false, quality: 'standard' });
    expect(r.media.requests.some((request) => request.audio === true)).toBe(false);
    expect(r.s.service.session()?.audio).toBe(false);

    r.media.microphoneFailures.push(mediaError('NotAllowedError'));
    r.s.settings.setRecordAudio(true);
    await sync(r);
    expect(r.starter.started).toHaveLength(2);
    expect(r.starter.last.audio).toBeNull();
    expect(r.recording.notice()).toBe(
      'Recording without audio: the microphone was not allowed (Chrome asks once; the site settings can change it).',
    );
    r.starter.last.emitError({ message: 'The audio encoder failed.', fatal: false });
    expect(r.recording.notice()).toBe('The audio encoder failed.');
  });

  it('starts again at the video quality Settings says, once the clips waiting for their time are saved', async () => {
    const r = rig();
    r.s.settings.setVideoQuality('high');
    const { fake, capture } = await recording(r);
    expect(capture.config).toEqual({ audio: true, quality: 'high' });
    r.s.settings.setVideoQuality('high');
    await sync(r);
    expect(r.starter.started).toHaveLength(1);

    // The scramble is done and its clip waits for its time: Standard saves it at once, from the
    // pipeline at High, which stops once it is written; the next one records at Standard.
    turn(r.s, fake, 'R U F');
    r.s.settings.setVideoQuality('standard');
    TestBed.tick();
    await settle();
    expect(capture.saves.map((save) => save.params.segment)).toEqual(['scramble']);
    expect(capture.stopped).toBe(false);
    capture.saveNext();
    await sync(r);
    expect(capture.stopped).toBe(true);
    expect(r.starter.started).toHaveLength(2);
    expect(r.starter.last.video).toBe(capture.video);
    expect(r.starter.last.config).toEqual({ audio: true, quality: 'standard' });
    expect(r.media.audioTracks.map((track) => track.readyState)).toEqual(['ended', 'live']);
    expect(r.recording.status()).toBe('starting');
    r.starter.last.emitStats(statsOf(1));
    expect(r.recording.status()).toBe('recording');
    await r.s.service.whenSaved();
    expect(r.recording.lastClip()?.clip.segment).toBe('scramble');
  });

  it('saves the scramble clip and the solve clip of an attempt, with their margins and the framing', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    r.camera.setFraming({ x: 480, y: 270, w: 960, h: 540 });
    TestBed.tick();

    turn(r.s, fake, 'R U F');
    const armed = r.s.service.attempt()?.events;
    expect(armed?.scrambleDone).not.toBeNull();
    await wait(r, SAVE_AFTER_MS - 1);
    expect(capture.saves).toEqual([]);
    await wait(r, 1);
    expect(capture.saves.map((save) => save.params)).toEqual([
      {
        startHostMs: (armed?.scrambleStart ?? 0) - SCRAMBLE_LEAD_MS,
        endHostMs: (armed?.scrambleDone ?? 0) + CLIP_TAIL_MS,
        sessionId: sessionId(r),
        index: 1,
        camera: 'laptop',
        segment: 'scramble',
        fpsNominal: 20,
      },
    ]);
    // Saved while the attempt is under way: kept for its record.
    const scrambleClip = capture.saveNext();
    await settle();
    expect(r.recording.lastClip()).toEqual({
      index: 1,
      clip: { ...scrambleClip, crop: { x: 480, y: 270, w: 960, h: 540 } },
    });

    turn(r.s, fake, "F'", 1000);
    turn(r.s, fake, "U' R'", 400);
    const record = r.s.service.attempts()[0];
    expect(record.result.status).toBe('solved');
    expect(record.video.map((clip) => clip.segment)).toEqual(['scramble']);
    const { solveStart, solveEnd } = record.events;

    await wait(r, SAVE_AFTER_MS);
    expect(capture.saves.map((save) => save.params)).toEqual([
      {
        startHostMs: (solveStart ?? 0) - SOLVE_LEAD_MS,
        endHostMs: (solveEnd ?? 0) + CLIP_TAIL_MS,
        sessionId: sessionId(r),
        index: 1,
        camera: 'laptop',
        segment: 'solve',
        fpsNominal: 20,
      },
    ]);
    const solveClip = capture.saveNext();
    await settle();
    await r.s.service.whenSaved();

    // The record, saved again with both clips; nothing else changed.
    const [stored] = (await r.s.store.exportSession(sessionId(r))).attempts;
    const crop = { x: 480, y: 270, w: 960, h: 540 };
    expect(stored.video).toEqual([
      { ...scrambleClip, crop },
      { ...solveClip, crop },
    ]);
    expect(withoutVideo(stored)).toEqual(withoutVideo(record));
    expect(r.s.service.attempts()[0]).toEqual(stored);
    expect(r.s.service.lastResult()).toEqual(stored);
  });

  it('says once that a clip failed and notes it in the session; the attempt is recorded as ever', async () => {
    const r = rig();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, capture } = await recording(r);

    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    capture.failNext('RangeError: Nothing is buffered yet.');
    await settle();
    await r.s.service.whenSaved();

    const line = 'clip failed: scramble of attempt 1: RangeError: Nothing is buffered yet.';
    expect(r.recording.failure()).toBe(line);
    expect(warn).toHaveBeenCalledWith(`cubetrace: ${line}`);
    expect(r.s.service.session()?.notes).toBe(line);
    expect((await r.s.store.exportSession(sessionId(r))).session.notes).toBe(line);

    turn(r.s, fake, "F'", 1000);
    turn(r.s, fake, "U' R'", 400);
    await wait(r, SAVE_AFTER_MS);
    capture.failNext('Error: QuotaExceededError');
    await settle();
    await r.s.service.whenSaved();
    const exported = await r.s.store.exportSession(sessionId(r));
    expect(exported.session.notes).toBe(
      `${line}\nclip failed: solve of attempt 1: Error: QuotaExceededError`,
    );
    expect(exported.attempts[0]).toMatchObject({ result: { status: 'solved' }, video: [] });
    r.recording.dismissFailure();
    expect(r.recording.failure()).toBeNull();
  });

  it('saves no solve clip when the solve never started, and ends a DNF at its time', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);

    // A DNF while armed: the scramble clip only.
    turn(r.s, fake, 'R U F');
    r.s.perf.advance(300);
    r.s.service.dnf();
    await wait(r, SAVE_AFTER_MS);
    expect(capture.saves.map((save) => save.params.segment)).toEqual(['scramble']);
    capture.saveNext();
    await settle();
    await r.s.service.whenSaved();
    expect(r.s.service.attempts()[0].video.map((clip) => clip.segment)).toEqual(['scramble']);

    // Attempt 2, a DNF during the solve: its solve clip ends a second after the DNF.
    turn(r.s, fake, inverse('R U F'));
    await settle();
    turn(r.s, fake, "L2 D B'");
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    turn(r.s, fake, 'R', 500);
    r.s.perf.advance(700);
    const dnfMs = r.s.perf.hostMs;
    r.s.service.dnf();
    await wait(r, SAVE_AFTER_MS);
    expect(capture.saves.map((save) => save.params)).toMatchObject([
      { index: 2, segment: 'solve', endHostMs: dnfMs + CLIP_TAIL_MS },
    ]);
  });

  it('drops the clips of an attempt that goes without a record, and removes those saved', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);

    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    const kept = capture.saveNext();
    await settle();
    turn(r.s, fake, "F'", 1000);
    // "Mark as solved" during the solve: no record; the scramble clip's files go.
    await r.s.cube.resetToSolved();
    await settle();
    expect(capture.deletions).toEqual([
      {
        sessionId: sessionId(r),
        index: 1,
        camera: 'laptop',
        segment: 'scramble',
        firstFrameHostMs: kept.firstFrameHostMs,
      },
    ]);

    // Again, reset before its scramble clip's time: that clip is never asked for.
    turn(r.s, fake, 'R U F');
    await r.s.cube.resetToSolved();
    await wait(r, SAVE_AFTER_MS);
    expect(capture.saves).toEqual([]);
    expect(r.s.service.attempts()).toEqual([]);
  });

  it('removes a clip whose attempt was deleted while it was saved', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    turn(r.s, fake, inverse('R U F'), 500);
    await wait(r, SAVE_AFTER_MS);
    expect(capture.saves).toHaveLength(1);

    r.s.service.deleteLast();
    const clip = capture.saveNext();
    await settle();
    await r.s.service.whenSaved();

    expect(capture.deletions).toEqual([
      {
        sessionId: sessionId(r),
        index: 1,
        camera: 'laptop',
        segment: 'solve',
        firstFrameHostMs: clip.firstFrameHostMs,
      },
    ]);
    expect(await r.s.store.loadAttempts(sessionId(r))).toEqual([]);
    expect(r.recording.failure()).toBeNull();
  });

  it('saves the clips waiting for their time at once when the camera goes off', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    turn(r.s, fake, inverse('R U F'), 500);
    const solveEnd = r.s.service.attempts()[0].events.solveEnd ?? 0;

    r.camera.stop();
    TestBed.tick();
    await settle();
    // Asked for before the pipeline stops, with the end it will have.
    expect(capture.saves.map((save) => save.params)).toMatchObject([
      { segment: 'solve', endHostMs: solveEnd + CLIP_TAIL_MS },
    ]);
    expect(capture.stopped).toBe(false);
    capture.saveNext();
    await r.recording.settled();
    expect(capture.stopped).toBe(true);
    await r.s.service.whenSaved();
    expect(r.s.service.attempts()[0].video.map((clip) => clip.segment)).toEqual([
      'scramble',
      'solve',
    ]);
  });

  it('warns from 80% of the storage quota and stops recording at 95%, not the timer', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);

    r.s.storage.usage = 850_000_000;
    await r.storage.refresh();
    await sync(r);
    expect(r.recording.storageLevel()).toBe('warn');
    expect(r.recording.storage()?.percent).toBeCloseTo(85, 6);
    expect(capture.stopped).toBe(false);
    expect(r.recording.status()).toBe('recording');

    r.s.storage.usage = 960_000_000;
    await r.storage.refresh();
    await sync(r);
    expect(r.recording.storageLevel()).toBe('full');
    expect(capture.stopped).toBe(true);
    expect(r.recording.status()).toBe('error');
    expect(r.recording.error()).toBe(STORAGE_FULL);
    // The timer goes on: the attempt is recorded, without clips.
    turn(r.s, fake, 'R U F');
    turn(r.s, fake, inverse('R U F'), 500);
    await wait(r, SAVE_AFTER_MS);
    await r.s.service.whenSaved();
    expect(r.s.service.attempts()[0]).toMatchObject({ result: { status: 'solved' }, video: [] });

    // Room again (sessions deleted): recording starts again.
    r.s.storage.usage = 500_000_000;
    await r.storage.refresh();
    await sync(r);
    expect(r.starter.started).toHaveLength(2);
    expect(r.recording.error()).toBeNull();
  });

  it('reads the storage again every minute while the camera is on', async () => {
    const r = rig();
    await recording(r);
    await settle();
    const before = r.recording.storage()?.usage;
    r.s.storage.usage = 123_456;
    await wait(r, 59_000);
    expect(r.recording.storage()?.usage).toBe(before);
    await wait(r, 1000);
    expect(r.recording.storage()?.usage).toBe(123_456);
  });

  it("lends the pipeline's motion watch to the sync check while it records, and clips carry the check's lag", async () => {
    const r = rig();
    const onSample = vi.fn();
    const onError = vi.fn();
    expect(r.recording.watchMotion(null, onSample, onError)).toBeNull();
    await r.camera.start();
    const fake = await ready(r.s);
    await sync(r);
    // Starting: not yet.
    expect(r.recording.watchMotion(null, onSample, onError)).toBeNull();
    const capture = r.starter.last;
    capture.emitStats(statsOf(5));

    const rect = { x: 480, y: 120, w: 960, h: 840 };
    const stop = r.recording.watchMotion(rect, onSample, onError);
    expect(capture.watches.at(-1)).toMatchObject({ rect, onSample, onError, stopped: false });
    stop?.();
    expect(capture.watches.at(-1)?.stopped).toBe(true);

    // A check of this camera in the session: its clips from then on carry its lag.
    r.s.service.putCameraClock('laptop', {
      offsetMs: 52.5,
      rttMs: 0,
      driftPpm: 0,
      clapperboardResidualMs: 9,
      clapperboardSamples: 5,
    });
    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    await settle();
    turn(r.s, fake, inverse('R U F'), 500);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    await settle();
    await r.s.service.whenSaved();
    const [stored] = (await r.s.store.exportSession(sessionId(r))).attempts;
    expect(stored.video.map((clip) => [clip.segment, clip.syncResidualMs])).toEqual([
      ['scramble', 52.5],
      ['solve', 52.5],
    ]);
  });

  it('says why a browser without the capture APIs cannot record', async () => {
    const r = rig({ supported: false });
    await r.camera.start();
    await ready(r.s);
    await sync(r);

    expect(r.starter.started).toEqual([]);
    expect(r.recording.status()).toBe('error');
    expect(r.recording.error()).toBe(
      'This browser cannot record video (no MediaStreamTrackProcessor): recording needs Chrome.',
    );
  });

  it('says so when the pipeline stops by itself, whose buffer still gives the clips', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    turn(r.s, fake, 'R U F');

    capture.emitError({
      message: 'The camera stopped sending frames (its track ended or the stream was closed).',
      fatal: true,
    });
    expect(r.recording.status()).toBe('error');
    expect(r.recording.error()).toBe(
      'Recording stopped: The camera stopped sending frames (its track ended or the stream was closed).',
    );
    await wait(r, SAVE_AFTER_MS);
    expect(capture.saves.map((save) => save.params.segment)).toEqual(['scramble']);
  });
});
