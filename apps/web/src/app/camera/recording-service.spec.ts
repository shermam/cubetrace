import { TestBed } from '@angular/core/testing';

import { APP_BUILD } from '../../environments/version';
import { NO_AUDIO_DATA, type CaptureStats, type ClipMotion } from '@cubetrace/capture';
import type { FakeCube } from '@cubetrace/gan';
import {
  ATTEMPT_SCHEMA,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  SESSION_SCHEMA,
  cloudAttempt,
  cloudSession,
  pendingUpload,
  type AttemptRecord,
  type CameraClock,
  type JsonSchema,
  type MicrophoneInfo,
} from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';

import { bluetoothNavigator } from '../cube/cube-testing';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import {
  FAKE_FACETIME,
  FAKE_WEBCAM,
  FakeMediaDevices,
  mediaError,
  settle,
} from '../device/fake-browser';
import { StorageService } from '../device/storage-service';
import { ClipsInFlight } from '../session/clips-in-flight';
import { inverse, ready, setup, turn, type Setup } from '../session/session-harness';
import { SettingsService } from '../settings/settings-service';
import { CameraService } from './camera-service';
import { HostCamerasService } from './host-cameras-service';
import {
  CAPTURE_STARTER,
  CLIP_TAIL_MS,
  ENCODER_SETTLE_MS,
  LOAD_ADVICE,
  RecordingService,
  SCRAMBLE_CLIP_MAX_MS,
  SCRAMBLE_LEAD_MS,
  SOLVE_LEAD_MS,
  STORAGE_FULL,
  pipelineSummary,
} from './recording-service';
import { FakeCaptureStarter, statsOf, type FakeCapture } from './recording-testing';

/** How long after a segment's end its clip is saved. */
const SAVE_AFTER_MS = CLIP_TAIL_MS + ENCODER_SETTLE_MS;

/** The request for the microphone, raw (T2.12): every voice processing off, ideals for the rest. */
const RAW_REQUEST = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
  },
};

/** The fake microphone opened raw, as the session keeps it: what the fake browser applied. */
const RAW_MICROPHONE: MicrophoneInfo = {
  label: 'Fake microphone',
  processing: 'raw',
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
  sampleRate: 48_000,
  channelCount: 1,
};

/** The fake microphone with the browser's defaults: its voice processing on. */
const DEFAULT_SETTINGS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: false,
};

/** The microphone requests made, the camera's left out. */
function microphoneRequests(media: FakeMediaDevices): MediaStreamConstraints[] {
  return media.requests.filter((request) => request.video === undefined);
}

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

/** The FaceTime camera's name, the second camera of the rig's laptop. */
const FACETIME = 'FaceTime HD Camera (3A71:F4B5)';

/**
 * Turns the camera called `label` on (or off) with its switch (T5.5), the cameras listed once the
 * first one opened, and lets the recording follow.
 */
async function switchCamera(r: Rig, label: string, on: boolean): Promise<void> {
  const hosts = TestBed.inject(HostCamerasService);
  const device = hosts.devices().find((candidate) => candidate.label === label);
  if (device === undefined) {
    throw new Error(`No camera ${label}.`);
  }
  await hosts.setOn(device, on);
  await sync(r);
}

/**
 * The pipeline running on the `k`-th camera of the host, the last one started on it (the cameras'
 * pipelines start in no set order: the first one waits for the microphone).
 */
function pipelineOf(r: Rig, k: number): FakeCapture {
  const track = TestBed.inject(HostCamerasService).cameras()[k]?.stream()?.getVideoTracks()[0];
  const capture = r.starter.started.filter((started) => started.video === track).at(-1);
  if (track === undefined || capture === undefined) {
    throw new Error(`No pipeline on camera ${String(k)}.`);
  }
  return capture;
}

/** Both cameras of the rig on (the default one, then the FaceTime camera), a session under way. */
async function bothRecording(r: Rig) {
  await r.camera.start();
  await switchCamera(r, FACETIME, true);
  const fake = await ready(r.s);
  await sync(r);
  const first = pipelineOf(r, 0);
  const second = pipelineOf(r, 1);
  first.emitStats(statsOf(5));
  second.emitStats(statsOf(5));
  TestBed.tick();
  return { fake, first, second };
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
    // The microphone raw (T2.12), once: what the browser applied is kept.
    expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST]);
    expect(r.recording.microphone()).toEqual(RAW_MICROPHONE);
    expect(r.recording.notices()).toEqual([]);
    expect(r.recording.status()).toBe('starting');

    capture.emitStats(statsOf(0.5));
    expect(r.recording.status()).toBe('recording');
    expect(r.recording.stats()).toEqual(statsOf(0.5));
    // The session holds the camera's entry with its microphone, and says that it records audio.
    const session = r.s.service.session();
    expect(session?.cameras).toEqual([{ ...r.camera.cameraInfo(), microphone: RAW_MICROPHONE }]);
    expect(session?.cameras[0]).toMatchObject({ label: 'laptop', deviceLabel: 'fake_device_0' });
    expect(session?.audio).toBe(true);
    await r.s.service.whenSaved();
    const stored = (await r.s.store.exportSession(sessionId(r))).session;
    expect(stored.cameras).toHaveLength(1);
    expect(stored.cameras[0].microphone).toEqual(RAW_MICROPHONE);
    expect(r.recording.storage()).toEqual({ usage: 0, quota: 1e9, percent: 0 });

    // The camera off: the pipeline stops and lets the microphone go.
    r.camera.stop();
    await sync(r);
    expect(capture.stopped).toBe(true);
    expect(r.media.audioTracks[0].readyState).toBe('ended');
    expect(r.recording.status()).toBe('off');
    expect(r.recording.stats()).toBeNull();
  });

  it('starts again on another camera, which gets a label of its own (T2.14), and replaces its entry when its settings change', async () => {
    const r = rig();
    const { capture } = await recording(r);
    TestBed.tick();

    await r.camera.setControl('exposureTime', 30);
    TestBed.tick();
    expect(r.s.service.session()?.cameras).toHaveLength(1);
    expect(r.s.service.session()?.cameras[0].settings['exposureTime']).toBe(30);
    const first = r.s.service.session()?.cameras[0];

    await r.camera.select('facetime');
    await sync(r);
    expect(capture.stopped).toBe(true);
    expect(r.starter.started).toHaveLength(2);
    expect(r.starter.last.video.label).toBe('FaceTime HD Camera (3A71:F4B5)');
    expect(r.media.audioTracks.map((track) => track.readyState)).toEqual(['ended', 'live']);
    r.starter.last.emitStats(statsOf(1));
    TestBed.tick();
    // Both are `laptop` by the host: the FaceTime camera is `laptop-2` in the session, with its
    // microphone, and the first camera keeps its entry.
    expect(r.s.service.session()?.cameras).toEqual([
      first,
      { ...r.camera.cameraInfo(), label: 'laptop-2', microphone: RAW_MICROPHONE },
    ]);

    // The first camera again: its label back, its entry the camera as it opened again.
    await r.camera.select('fake-webcam');
    await sync(r);
    r.starter.last.emitStats(statsOf(1));
    TestBed.tick();
    const cameras = r.s.service.session()?.cameras ?? [];
    expect(cameras.map((entry) => [entry.label, entry.deviceLabel])).toEqual([
      ['laptop', 'fake_device_0'],
      ['laptop-2', 'FaceTime HD Camera (3A71:F4B5)'],
    ]);
    expect(cameras[0]).toEqual({ ...r.camera.cameraInfo(), microphone: RAW_MICROPHONE });
    await r.s.service.whenSaved();
    expect((await r.s.store.exportSession(sessionId(r))).session.cameras).toEqual(cameras);
  });

  it("gives each camera of a session its own label: its clips and their files, its lag, the cloud's documents (T2.14)", async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const lag = (offsetMs: number): CameraClock => ({
      offsetMs,
      rttMs: 0,
      driftPpm: 0,
      clapperboardResidualMs: 9,
      clapperboardSamples: 8,
    });
    /** A solve recorded by `pipeline`: the attempt's scramble, its inverse, each clip saved. */
    const solve = async (pipeline: FakeCapture): Promise<void> => {
      const scramble = r.s.service.attempt()?.scramble ?? '';
      turn(r.s, fake, scramble);
      await wait(r, SAVE_AFTER_MS);
      pipeline.saveNext();
      await settle();
      turn(r.s, fake, inverse(scramble), 500);
      await wait(r, SAVE_AFTER_MS);
      pipeline.saveNext();
      await settle();
    };
    /** Switches to the camera `deviceId`, whose pipeline is then recording. */
    const switchTo = async (deviceId: string): Promise<FakeCapture> => {
      await r.camera.select(deviceId);
      await sync(r);
      r.starter.last.emitStats(statsOf(5));
      TestBed.tick();
      return r.starter.last;
    };

    // The first camera, `laptop`, and its sync check; then the FaceTime camera, also `laptop` by
    // the host (issue #40): `laptop-2`, which has no check until its own; then the first one again.
    r.s.service.putCameraClock('laptop', lag(20));
    await solve(capture);
    const facetime = await switchTo('facetime');
    expect(r.s.service.session()?.cameras.map((entry) => entry.label)).toEqual([
      'laptop',
      'laptop-2',
    ]);
    await solve(facetime);
    r.s.service.putCameraClock('laptop-2', lag(177));
    await solve(facetime);
    await solve(await switchTo('fake-webcam'));
    await r.s.service.whenSaved();

    const { session, attempts } = await r.s.store.exportSession(sessionId(r));
    expect(session.cameras.map((entry) => [entry.label, entry.deviceLabel])).toEqual([
      ['laptop', 'fake_device_0'],
      ['laptop-2', 'FaceTime HD Camera (3A71:F4B5)'],
    ]);
    expect(session.clock.cameras).toEqual({ laptop: lag(20), 'laptop-2': lag(177) });
    // Each clip names its camera's entry, in its files too, and carries that camera's lag.
    const clips = (camera: string, syncResidualMs: number | null) =>
      (['scramble', 'solve'] as const).map((segment) => [
        camera,
        `${camera}.${segment}.mp4`,
        `${camera}.${segment}.frames.json`,
        syncResidualMs,
      ]);
    expect(
      attempts.map((attempt) =>
        attempt.video.map((clip) => [clip.camera, clip.file, clip.framesFile, clip.syncResidualMs]),
      ),
    ).toEqual([
      clips('laptop', 20),
      clips('laptop-2', null),
      clips('laptop-2', 177),
      clips('laptop', 20),
    ]);

    // The records validate, and so do the documents of the session index (T3.1), whose attempts
    // name the session's two cameras as their device's.
    const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
    const validators = new Map(
      [SESSION_SCHEMA, ATTEMPT_SCHEMA, CLOUD_SESSION_SCHEMA, CLOUD_ATTEMPT_SCHEMA].map((schema) => [
        schema,
        ajv.compile(schema),
      ]),
    );
    const valid = (schema: JsonSchema, value: unknown): boolean => {
      const validate = validators.get(schema);
      const ok = validate?.(value) ?? false;
      expect(validate?.errors ?? []).toEqual([]);
      return ok;
    };
    expect(valid(SESSION_SCHEMA, session)).toBe(true);
    const document = cloudSession(session, 'ada-uid');
    expect(document.cameras.map((entry) => entry.label)).toEqual(['laptop', 'laptop-2']);
    expect(valid(CLOUD_SESSION_SCHEMA, document)).toBe(true);
    for (const attempt of attempts) {
      expect(valid(ATTEMPT_SCHEMA, attempt)).toBe(true);
      const files = Object.fromEntries(attempt.video.map((clip) => [clip.file, clip.bytes]));
      const indexed = cloudAttempt({
        attempt,
        session,
        owner: 'ada-uid',
        upload: pendingUpload(files),
      });
      expect(indexed.device).toEqual({ host: session.host.label, cameras: ['laptop', 'laptop-2'] });
      expect(Object.keys(indexed.upload.files)).toEqual(
        attempt.video.map((clip) => `${clip.camera}.${clip.segment}.mp4`),
      );
      expect(valid(CLOUD_ATTEMPT_SCHEMA, indexed)).toBe(true);
    }
  });

  it('saves the clip asked for when the camera switches under its own label and framing; the next one is the new camera’s (T2.14)', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const framing = { x: 480, y: 270, w: 960, h: 540 };
    r.camera.setFraming(framing);
    TestBed.tick();

    // The scramble done; its clip is to be saved in a second, but the camera switches first.
    turn(r.s, fake, 'R U F');
    await r.camera.select('facetime');
    TestBed.tick();
    await settle();
    // Asked for at once, from the first camera's buffer, under its label.
    expect(capture.saves.map((save) => save.params)).toMatchObject([
      { index: 1, segment: 'scramble', camera: 'laptop' },
    ]);
    const scrambleClip = capture.saveNext();
    await sync(r);
    expect(capture.stopped).toBe(true);
    const second = r.starter.last;
    expect(second).not.toBe(capture);
    second.emitStats(statsOf(5));
    TestBed.tick();

    turn(r.s, fake, inverse('R U F'), 500);
    await wait(r, SAVE_AFTER_MS);
    expect(second.saves.map((save) => save.params)).toMatchObject([
      { index: 1, segment: 'solve', camera: 'laptop-2' },
    ]);
    const solveClip = second.saveNext();
    await settle();
    await r.s.service.whenSaved();

    // The first camera's framing on its clip, none (the whole frame) on the FaceTime camera's.
    const [stored] = (await r.s.store.exportSession(sessionId(r))).attempts;
    expect(stored.video).toEqual([
      { ...scrambleClip, crop: framing },
      { ...solveClip, crop: null },
    ]);
    expect(stored.video.map((clip) => clip.file)).toEqual([
      'laptop.scramble.mp4',
      'laptop-2.solve.mp4',
    ]);
  });

  it('records without audio when Settings says so, or when the microphone is refused', async () => {
    const r = rig();
    r.s.settings.setRecordAudio(false);
    await recording(r);
    expect(r.starter.last.audio).toBeNull();
    expect(r.starter.last.config).toEqual({ audio: false, quality: 'standard' });
    expect(microphoneRequests(r.media)).toEqual([]);
    expect(r.s.service.session()?.audio).toBe(false);
    expect(r.s.service.session()?.cameras[0].microphone).toBeNull();
    expect(r.recording.microphone()).toBeNull();

    r.media.microphoneFailures.push(mediaError('NotAllowedError'));
    r.s.settings.setRecordAudio(true);
    await sync(r);
    expect(r.starter.started).toHaveLength(2);
    expect(r.starter.last.audio).toBeNull();
    const refused =
      'Recording without audio: the microphone was not allowed (Chrome asks once; the site settings can change it).';
    expect(r.recording.notices()).toEqual([refused]);
    // A notice after it does not hide it (issue #33): both stay, and the session notes both, once.
    r.starter.last.emitError({ message: 'The audio encoder failed.', fatal: false });
    r.starter.last.emitError({ message: 'The audio encoder failed.', fatal: false });
    expect(r.recording.notices()).toEqual([refused, 'The audio encoder failed.']);
    await r.s.service.whenSaved();
    expect(r.s.service.session()?.notes).toBe(
      `notice: ${refused}\nnotice: The audio encoder failed.`,
    );
    // Refused: no microphone, in the session too; a refusal is not asked again otherwise.
    expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST]);
    expect(r.recording.microphone()).toBeNull();
    expect(r.s.service.session()?.cameras[0].microphone).toBeNull();
  });

  it('says when the browser kept its voice processing on although raw was asked for, and notes it once', async () => {
    const r = rig();
    r.media.microphoneSettings = { noiseSuppression: true, autoGainControl: true };
    const { capture } = await recording(r);

    const kept: MicrophoneInfo = {
      ...RAW_MICROPHONE,
      noiseSuppression: true,
      autoGainControl: true,
    };
    expect(capture.audio).toBe(r.media.audioTracks[0]);
    expect(r.recording.microphone()).toEqual(kept);
    const notice =
      'The microphone is not raw: the browser kept its noise suppression and automatic gain control ' +
      "on although Raw was asked for, so the sound may lack the cube's clicks.";
    expect(r.recording.notices()).toEqual([notice]);
    await r.s.service.whenSaved();
    const stored = (await r.s.store.exportSession(sessionId(r))).session;
    expect(stored.notes).toBe(`notice: ${notice}`);
    expect(stored.cameras[0].microphone).toEqual(kept);
  });

  it("asks again with the browser's defaults when the raw request is overconstrained, and says so", async () => {
    const r = rig();
    r.media.microphoneFailures.push(mediaError('OverconstrainedError', '', 'sampleRate'));
    const { capture } = await recording(r);

    expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST, { audio: true }]);
    expect(capture.audio).toBe(r.media.audioTracks[0]);
    expect(capture.config).toEqual({ audio: true, quality: 'standard' });
    // Raw was asked for; the browser applied its defaults.
    const fallback: MicrophoneInfo = { ...RAW_MICROPHONE, ...DEFAULT_SETTINGS };
    expect(r.recording.microphone()).toEqual(fallback);
    const notice =
      'The microphone could not be opened raw: the browser refused the request (sampleRate), so it ' +
      "is recorded with the browser's voice processing.";
    expect(r.recording.notices()).toEqual([notice]);
    await r.s.service.whenSaved();
    expect(r.s.service.session()?.notes).toBe(`notice: ${notice}`);
    expect(r.s.service.session()?.cameras[0].microphone).toEqual(fallback);
  });

  it('does not ask again after another refusal, nor when Voice is overconstrained', async () => {
    const r = rig();
    r.media.microphoneFailures.push(mediaError('NotReadableError'));
    await recording(r);
    expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST]);
    expect(r.recording.notices()).toEqual([
      'Recording without audio: the microphone is in use by another app.',
    ]);

    r.media.microphoneFailures.push(mediaError('OverconstrainedError', '', 'deviceId'));
    r.s.settings.setMicrophoneProcessing('voice');
    await sync(r);
    expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST, { audio: true }]);
    expect(r.starter.last.audio).toBeNull();
    expect(r.recording.notices()).toEqual([
      'Recording without audio: the microphone could not be opened (OverconstrainedError).',
    ]);
  });

  it('starts again when the microphone setting changes while it records audio, and only then', async () => {
    const r = rig();
    const { capture } = await recording(r);
    expect(r.recording.microphone()?.processing).toBe('raw');

    // Voice: the recording starts again with the browser's defaults.
    r.s.settings.setMicrophoneProcessing('voice');
    await sync(r);
    expect(capture.stopped).toBe(true);
    expect(r.starter.started).toHaveLength(2);
    expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST, { audio: true }]);
    expect(r.media.audioTracks.map((track) => track.readyState)).toEqual(['ended', 'live']);
    const voice: MicrophoneInfo = { ...RAW_MICROPHONE, processing: 'voice', ...DEFAULT_SETTINGS };
    expect(r.recording.microphone()).toEqual(voice);
    expect(r.recording.notices()).toEqual([]);
    r.starter.last.emitStats(statsOf(1));
    TestBed.tick();
    expect(r.s.service.session()?.cameras[0].microphone).toEqual(voice);

    // Without audio the microphone's setting changes nothing, until the audio is on again.
    r.s.settings.setRecordAudio(false);
    await sync(r);
    expect(r.starter.started).toHaveLength(3);
    r.s.settings.setMicrophoneProcessing('raw');
    await sync(r);
    expect(r.starter.started).toHaveLength(3);
    expect(r.s.service.session()?.cameras[0].microphone).toBeNull();
    r.s.settings.setRecordAudio(true);
    await sync(r);
    expect(r.starter.started).toHaveLength(4);
    expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST, { audio: true }, RAW_REQUEST]);
    expect(r.recording.microphone()).toEqual(RAW_MICROPHONE);
    expect(r.s.service.session()?.cameras[0].microphone).toEqual(RAW_MICROPHONE);
  });

  it('says that the microphone sends nothing until its sound comes, and notes it', async () => {
    const r = rig();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { capture } = await recording(r);

    capture.emitError({ message: NO_AUDIO_DATA, fatal: false });
    capture.emitStats(statsOf(6, { audioState: 'waiting', audioChunks: 0, audioCodec: null }));
    expect(r.recording.notices()).toEqual([NO_AUDIO_DATA]);
    // The microphone was only late: its sound is recorded now, and the notice goes (the note stays).
    capture.emitStats(statsOf(7));
    expect(r.recording.notices()).toEqual([]);
    await r.s.service.whenSaved();
    expect(r.s.service.session()?.notes).toBe(`notice: ${NO_AUDIO_DATA}`);
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

    const inFlight = TestBed.inject(ClipsInFlight);
    turn(r.s, fake, 'R U F');
    const armed = r.s.service.attempt()?.events;
    expect(armed?.scrambleDone).not.toBeNull();
    // Its clip is to come (T3.3: its upload waits for it).
    expect(inFlight.has(sessionId(r), 1)).toBe(true);
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
        app: APP_BUILD,
      },
    ]);
    // Saved while the attempt is under way: kept for its record.
    expect(inFlight.has(sessionId(r), 1)).toBe(true);
    const scrambleClip = capture.saveNext();
    await settle();
    expect(r.recording.lastClip()).toEqual({
      index: 1,
      clip: { ...scrambleClip, crop: { x: 480, y: 270, w: 960, h: 540 } },
    });
    expect(inFlight.has(sessionId(r), 1)).toBe(false);

    turn(r.s, fake, "F'", 1000);
    turn(r.s, fake, "U' R'", 400);
    const record = r.s.service.attempts()[0];
    expect(record.result.status).toBe('solved');
    expect(record.video.map((clip) => clip.segment)).toEqual(['scramble']);
    const { solveStart, solveEnd } = record.events;
    // Its record is saved, its solve clip still to come: not final yet.
    expect(inFlight.has(sessionId(r), 1)).toBe(true);

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
        app: APP_BUILD,
      },
    ]);
    const solveClip = capture.saveNext();
    await settle();
    await r.s.service.whenSaved();
    expect(inFlight.has(sessionId(r), 1)).toBe(false);

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

  it('asks for at most the last 60 s of a scramble with a long pause in it', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);

    // A turn, 70 s without one, then the rest of the scramble.
    turn(r.s, fake, 'R');
    turn(r.s, fake, 'U F', 70_000);
    const { scrambleStart, scrambleDone } = r.s.service.attempt()?.events ?? {};
    if (scrambleStart == null || scrambleDone == null) {
      throw new Error('The scramble is done.');
    }
    expect(scrambleDone - scrambleStart).toBeGreaterThan(SCRAMBLE_CLIP_MAX_MS);
    await wait(r, SAVE_AFTER_MS);

    expect(SCRAMBLE_CLIP_MAX_MS).toBe(60_000);
    expect(capture.saves.map((save) => [save.params.startHostMs, save.params.endHostMs])).toEqual([
      [scrambleDone - SCRAMBLE_CLIP_MAX_MS, scrambleDone + CLIP_TAIL_MS],
    ]);
  });

  it('keeps a clip whose start was older than the buffer, says how late it begins and notes it', async () => {
    const r = rig();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, capture } = await recording(r);

    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext({ truncatedStart: true }, { lateMs: 434_100, bufferSeconds: 90 });
    await settle();
    const line =
      'clip truncated: scramble of attempt 1 starts 434.1 s late (the buffer held 90.0 s)';
    expect(r.recording.clipNotice()).toBe(
      'Scramble clip of attempt 1 starts 434.1 s late: the buffer holds 90 s.',
    );
    expect(r.recording.failure()).toBeNull();
    expect(warn).toHaveBeenCalledWith(`cubetrace: ${line}`);

    turn(r.s, fake, "F' U' R'", 500);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    await settle();
    await r.s.service.whenSaved();
    const exported = await r.s.store.exportSession(sessionId(r));
    expect(exported.session.notes).toBe(line);
    // Saved as the attempt's clip, marked.
    expect(exported.attempts[0].video.map((clip) => [clip.segment, clip.truncatedStart])).toEqual([
      ['scramble', true],
      ['solve', false],
    ]);
    r.recording.dismissClipNotice();
    expect(r.recording.clipNotice()).toBeNull();
  });

  it("says why a clip has no sound, and notes each reason once while it records, as the audio's rebase", async () => {
    const r = rig();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, capture } = await recording(r);
    const reason = 'no audio data: the microphone sent nothing (muted, or held by another app)';

    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext({ audio: null }, { audioMissing: reason });
    await settle();
    expect(r.recording.clipNotice()).toBe(`Scramble clip of attempt 1 has no sound: ${reason}.`);
    turn(r.s, fake, "F' U' R'", 500);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext({ audio: null }, { audioMissing: reason, audioRebasedMs: 30_000_010.4 });
    await settle();
    await r.s.service.whenSaved();

    expect(r.recording.clipNotice()).toBe(
      `Solve clip of attempt 1 has no sound: ${reason}. ` +
        'Solve clip of attempt 1: audio timestamps rebased by 30000010 ms.',
    );
    expect(r.s.service.session()?.notes).toBe(
      `clip without audio: scramble of attempt 1: ${reason}\n` +
        'clip audio rebased: solve of attempt 1: audio timestamps rebased by 30000010 ms',
    );
  });

  it('notes once, without a notice, that the capture made the audio decoder config of its clips', async () => {
    const r = rig();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, capture } = await recording(r);

    turn(r.s, fake, 'R U F');
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext({ audio: 'mp4a.40.2' }, { audioConfigMade: true });
    await settle();
    turn(r.s, fake, "F' U' R'", 500);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext({ audio: 'mp4a.40.2' }, { audioConfigMade: true });
    await settle();
    await r.s.service.whenSaved();

    expect(r.recording.clipNotice()).toBeNull();
    expect(r.s.service.session()?.notes).toBe(
      "clip audio described: scramble of attempt 1: the audio encoder gave no complete decoder config; the capture made it from the encoder's settings",
    );
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

    // Again, reset before its scramble clip's time: that clip is never asked for, nor waited for.
    turn(r.s, fake, 'R U F');
    const inFlight = TestBed.inject(ClipsInFlight);
    expect(inFlight.has(sessionId(r), 1)).toBe(true);
    await r.s.cube.resetToSolved();
    expect(inFlight.has(sessionId(r), 1)).toBe(false);
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

  describe('with two cameras of the laptop (T5.5)', () => {
    it('records each, the first with the microphone; an attempt gets two clips from each, under their labels', async () => {
      const r = rig();
      const { fake, first, second } = await bothRecording(r);
      const hosts = TestBed.inject(HostCamerasService);
      expect(r.starter.started).toHaveLength(2);
      expect(hosts.cameras().map((camera) => camera.label())).toEqual(['fake_device_0', FACETIME]);
      // The microphone once, with the first camera's clips; the second's without sound.
      expect(first.audio).toBe(r.media.audioTracks[0]);
      expect(first.config).toEqual({ audio: true, quality: 'standard' });
      expect(second.audio).toBeNull();
      expect(second.config).toEqual({ audio: false, quality: 'standard' });
      expect(microphoneRequests(r.media)).toEqual([RAW_REQUEST]);
      const recordings = r.recording.recordings();
      expect(recordings.map((recording) => recording.status())).toEqual(['recording', 'recording']);
      expect(recordings.map((recording) => recording.audio())).toEqual([true, false]);
      expect(recordings.map((recording) => recording.microphone())).toEqual([RAW_MICROPHONE, null]);
      expect(r.recording.recordingOf(hosts.cameras()[1])).toBe(recordings[1]);
      expect(r.recording.primary()).toBe(recordings[0]);
      expect(r.recording.status()).toBe('recording');
      // An entry each in the session, in the cameras' order; the session records sound.
      const session = r.s.service.session();
      expect(
        session?.cameras.map((entry) => [entry.label, entry.deviceLabel, entry.microphone]),
      ).toEqual([
        ['laptop', 'fake_device_0', RAW_MICROPHONE],
        ['laptop-2', FACETIME, null],
      ]);
      expect(session?.audio).toBe(true);

      const scramble = r.s.service.attempt()?.scramble ?? '';
      turn(r.s, fake, scramble);
      await wait(r, SAVE_AFTER_MS);
      const asked = (capture: FakeCapture) =>
        capture.saves.map((save) => [
          save.params.camera,
          save.params.segment,
          save.params.fpsNominal,
        ]);
      expect(asked(first)).toEqual([['laptop', 'scramble', 20]]);
      expect(asked(second)).toEqual([['laptop-2', 'scramble', 30]]);
      first.saveNext();
      second.saveNext({ audio: null });
      await settle();
      turn(r.s, fake, inverse(scramble), 500);
      await wait(r, SAVE_AFTER_MS);
      expect(asked(first)).toEqual([['laptop', 'solve', 20]]);
      expect(asked(second)).toEqual([['laptop-2', 'solve', 30]]);
      first.saveNext();
      second.saveNext({ audio: null });
      await settle();
      await r.s.service.whenSaved();
      const [stored] = (await r.s.store.exportSession(sessionId(r))).attempts;
      expect(
        stored.video
          .map((clip) => [clip.camera, clip.segment, clip.file, clip.framesFile, clip.audio])
          .sort(),
      ).toEqual([
        ['laptop', 'scramble', 'laptop.scramble.mp4', 'laptop.scramble.frames.json', 'opus'],
        ['laptop', 'solve', 'laptop.solve.mp4', 'laptop.solve.frames.json', 'opus'],
        ['laptop-2', 'scramble', 'laptop-2.scramble.mp4', 'laptop-2.scramble.frames.json', null],
        ['laptop-2', 'solve', 'laptop-2.solve.mp4', 'laptop-2.solve.frames.json', null],
      ]);
      // The recording's words name the clip's camera while several record.
      expect(r.recording.lastClip()?.clip.camera).toMatch(/^laptop(-2)?$/u);
    });

    it('labels the cameras in their order, whichever pipeline starts first', async () => {
      const r = rig();
      await r.camera.start();
      await switchCamera(r, FACETIME, true);
      // The microphone's prompt holds the first camera's pipeline: the second one starts first.
      r.media.hold();
      await ready(r.s);
      TestBed.tick();
      await settle();
      expect(r.starter.started.map((capture) => capture.audio)).toEqual([null]);
      expect(
        r.s.service.session()?.cameras.map((entry) => [entry.label, entry.deviceLabel]),
      ).toEqual([
        ['laptop', 'fake_device_0'],
        ['laptop-2', FACETIME],
      ]);
      r.media.release();
      await sync(r);
      expect(r.starter.started).toHaveLength(2);
      expect(r.starter.started[1].audio).toBe(r.media.audioTracks[0]);
      expect(r.s.service.session()?.cameras.map((entry) => entry.label)).toEqual([
        'laptop',
        'laptop-2',
      ]);
    });

    it('a camera turned off mid-session: its clips stop, the records stay right; the microphone goes with the first camera', async () => {
      const r = rig();
      const { fake, first, second } = await bothRecording(r);

      // The second camera off between two attempts: its pipeline stops; the next attempt has the
      // first camera's clips only, and the session keeps both entries.
      await switchCamera(r, FACETIME, false);
      expect(second.stopped).toBe(true);
      expect(first.stopped).toBe(false);
      expect(r.recording.recordings()).toHaveLength(1);
      const scramble = r.s.service.attempt()?.scramble ?? '';
      turn(r.s, fake, scramble);
      await wait(r, SAVE_AFTER_MS);
      first.saveNext();
      await settle();
      turn(r.s, fake, inverse(scramble), 500);
      await wait(r, SAVE_AFTER_MS);
      first.saveNext();
      await settle();
      await r.s.service.whenSaved();
      const exported = await r.s.store.exportSession(sessionId(r));
      expect(exported.attempts[0].video.map((clip) => [clip.camera, clip.segment])).toEqual([
        ['laptop', 'scramble'],
        ['laptop', 'solve'],
      ]);
      expect(exported.session.cameras.map((entry) => entry.label)).toEqual(['laptop', 'laptop-2']);

      // Back on, then the first one off: the FaceTime camera is the first now, and its pipeline
      // starts again with the microphone, under its own label still.
      await switchCamera(r, FACETIME, true);
      const third = pipelineOf(r, 1);
      expect(third.config.audio).toBe(false);
      await switchCamera(r, 'fake_device_0', false);
      expect(first.stopped).toBe(true);
      expect(third.stopped).toBe(true);
      const fourth = pipelineOf(r, 0);
      expect(fourth.config.audio).toBe(true);
      expect(fourth.audio).not.toBeNull();
      fourth.emitStats(statsOf(5));
      TestBed.tick();
      expect(
        r.s.service.session()?.cameras.map((entry) => [entry.label, entry.microphone]),
      ).toEqual([
        ['laptop', RAW_MICROPHONE],
        ['laptop-2', RAW_MICROPHONE],
      ]);
    });

    it('says once per recording when a camera encodes under 80% of its frame rate for 10 s, and never with one camera', async () => {
      const r = rig();
      const events: [string, Record<string, unknown>][] = [];
      vi.spyOn(TestBed.inject(DiagnosticsService), 'record').mockImplementation(
        (kind, data = {}) => {
          events.push([kind, { ...data }]);
        },
      );
      const { first, second } = await bothRecording(r);
      const [, facetime] = r.recording.recordings();
      // The FaceTime camera's track says 30 fps; it encodes 20 of them, second after second.
      const seconds = async (count: number, encodedFps: number): Promise<void> => {
        for (let k = 0; k < count; k++) {
          await wait(r, 1000);
          first.emitStats(statsOf(5));
          second.emitStats(statsOf(5, { encodedFps }));
        }
        TestBed.tick();
      };
      await seconds(10, 20);
      expect(facetime.notices()).toEqual([]);
      expect(facetime.load()).toBeNull();
      await seconds(1, 20);
      const words = `laptop-2 records 20 of its 30 frames a second. ${LOAD_ADVICE}`;
      expect(facetime.notices()).toEqual([words]);
      expect(facetime.load()).toEqual({ encodedFps: 20, nominalFps: 30 });
      expect(r.recording.recordings()[0].notices()).toEqual([]);
      await seconds(15, 21);
      expect(facetime.notices()).toEqual([words]);
      expect(events.filter(([kind]) => kind === 'recording.notice')).toEqual([
        ['recording.notice', { message: words, camera: 'laptop-2' }],
      ]);
      // Back to its rate: the line's word goes; the notice stays with the recording.
      await seconds(1, 30);
      expect(facetime.load()).toBeNull();
      expect(facetime.notices()).toEqual([words]);

      // One camera alone, however slow, is not the laptop's load.
      await switchCamera(r, FACETIME, false);
      await seconds(12, 10);
      expect(r.recording.recordings()[0].notices()).toEqual([]);
      expect(r.recording.recordings()[0].load()).toBeNull();
    });
  });
});

describe('RecordingService: the capture latency and the motion lag (T5.3)', () => {
  const FRAMING = { x: 480, y: 270, w: 960, h: 540 };
  /** The laptop's sync check, with the anchors T5.3 keeps. */
  const CHECK: CameraClock = {
    offsetMs: 58.4,
    rttMs: 0,
    driftPpm: 0,
    clapperboardResidualMs: 30.5,
    clapperboardSamples: 8,
    motionPeakAtCheckMs: 72.3,
    captureLatencyAtCheckMs: 3.2,
  };
  /** A solve's first moves, which undo each other, before the scramble's inverse. */
  const PAD = "R R' R R' R R' R R' R R'";
  /** The solve's moves come irregularly apart, ms, as a solve's do. */
  const GAPS = [180, 260, 150, 290, 210, 170, 240, 300, 160, 220, 190, 250, 280];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The diagnostics' events from now on, as kind and facts. */
  function spyEvents(): [string, Record<string, unknown>][] {
    const events: [string, Record<string, unknown>][] = [];
    vi.spyOn(TestBed.inject(DiagnosticsService), 'record').mockImplementation((kind, data = {}) => {
      events.push([kind, { ...data }]);
    });
    return events;
  }

  /** The counters of a second whose frames came `p50` ms beyond the track's floor. */
  function latencyStats(seconds: number, p50: number): CaptureStats {
    return statsOf(seconds, {
      latency: {
        capture: { p50, p95: p50 + 7, basis: 'timestamp' },
        encode: { p50: 14, p95: 22 },
        floorMs: 1_790_000_000_000,
        queueMax: 2,
        pending: 1,
        waiting: p50 > 30 ? 28 : 0,
        frameIntervalMs: p50 > 30 ? 34.6 : 32.9,
      },
    });
  }

  /** `seconds` of counters, one a second on the fake clock, at `p50`. */
  function feed(capture: FakeCapture, r: Rig, seconds: number, p50: number): void {
    for (let k = 0; k < seconds; k++) {
      r.s.perf.advance(1000);
      capture.emitStats(latencyStats(5 + k, p50));
    }
  }

  /** The attempt's scramble turned: the attempt is armed. Returns the scramble. */
  function scramble(r: Rig, fake: FakeCube): string {
    const moves = r.s.service.attempt()?.scramble ?? '';
    turn(r.s, fake, moves);
    return moves;
  }

  /** The solve of `scrambled`: ten moves that undo each other, then its inverse, irregularly apart. */
  function solve(r: Rig, fake: FakeCube, scrambled: string): void {
    [...PAD.split(' '), ...inverse(scrambled).split(' ')].forEach((move, k) => {
      turn(r.s, fake, move, GAPS[k % GAPS.length]);
    });
  }

  /**
   * The motion a solve clip of `record` shows at 30 fps: its square changes in the frame that comes
   * `afterMs` (to a frame later) after each of the solve's moves; a little noise elsewhere.
   */
  function motionOf(record: AttemptRecord, afterMs: number): ClipMotion {
    const moves = record.moves.filter((move) => move.phase === 'solve').map((m) => m.hostMs);
    const t0 = (record.events.solveStart ?? 0) - SOLVE_LEAD_MS;
    const end = (record.events.solveEnd ?? 0) + CLIP_TAIL_MS;
    const atMs: number[] = [];
    const changed: number[] = [];
    for (let k = 0; t0 + (k * 1000) / 30 <= end; k++) {
      const at = t0 + (k * 1000) / 30;
      atMs.push(Math.round(((k * 1000) / 30) * 10) / 10);
      const shows = moves.some((move) => at - move >= afterMs && at - move < afterMs + 1000 / 30);
      changed.push(shows ? 0.2 : 0.0004 * (k % 3));
    }
    return { t0HostMs: t0, atMs, changed, costMs: 0.7 };
  }

  it("measures each solve's motion from its armed scramble to its clip, which says where it peaked and the camera's lag from it; clip.saved says the latencies, the cadence and the pipeline", async () => {
    const r = rig();
    const events = spyEvents();
    const { fake, capture } = await recording(r);
    r.camera.setFraming(FRAMING);
    r.s.service.putCameraClock('laptop', CHECK);
    TestBed.tick();
    feed(capture, r, 3, 4.1);

    // The scramble done: the attempt is armed, and the meter goes on in the framing rectangle.
    const scrambled = scramble(r, fake);
    expect(capture.meters).toEqual([{ on: true, rect: FRAMING }]);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    await settle();
    solve(r, fake, scrambled);
    const record = r.s.service.attempts()[0];
    expect(record.result.status).toBe('solved');
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext(
      {
        captureLatencyMs: { p50: 4.1, p95: 11.1, basis: 'timestamp' },
        encodeLatencyMs: { p50: 14, p95: 22 },
      },
      { frameIntervalMs: 33.3 },
      motionOf(record, 80),
    );
    await settle();
    await r.s.service.whenSaved();
    // Off once the solve clip is saved.
    expect(capture.meters.at(-1)).toEqual({ on: false, rect: null });

    const [stored] = (await r.s.store.exportSession(sessionId(r))).attempts;
    const clip = stored.video.find((c) => c.segment === 'solve');
    // The change shows 80 to 113 ms after each move: its middle, about 97 ms.
    expect(clip?.motionPeakMs).toBeGreaterThan(85);
    expect(clip?.motionPeakMs).toBeLessThan(110);
    expect(clip?.motionSpreadMs).toBeGreaterThan(0);
    // Anchored to the check: its lag plus how far the peak moved from the check's own.
    expect(clip?.syncResidualMs).toBe(58.4);
    expect(clip?.motionLagMs).toBe(Math.round((58.4 + (clip?.motionPeakMs ?? 0) - 72.3) * 10) / 10);
    // The scramble clip has none.
    expect(stored.video.find((c) => c.segment === 'scramble')).toMatchObject({
      motionPeakMs: null,
      motionLagMs: null,
    });
    const saved = events.filter(([kind]) => kind === 'clip.saved').map(([, data]) => data);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({
      segment: 'solve',
      // The sync check's lag, which the event lacked before T5.3.
      syncResidualMs: 58.4,
      captureLatencyMs: { p50: 4.1, p95: 11.1, basis: 'timestamp' },
      encodeLatencyMs: { p50: 14, p95: 22 },
      frameIntervalMs: 33.3,
      motionPeakMs: clip?.motionPeakMs,
      motionLagMs: clip?.motionLagMs,
      pipeline: { waitingShare: 0, queueMax: 2, pendingMax: 1 },
    });
  });

  it('measures nothing with "Measure the motion during solves" off: the clip has no peak', async () => {
    const r = rig();
    TestBed.inject(SettingsService).setMotionMeter(false);
    const { fake, capture } = await recording(r);
    const scrambled = scramble(r, fake);
    expect(capture.meters).toEqual([]);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    solve(r, fake, scrambled);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    await settle();
    await r.s.service.whenSaved();
    const [stored] = (await r.s.store.exportSession(sessionId(r))).attempts;
    expect(stored.video.map((c) => c.motionPeakMs)).toEqual([null, null]);
    expect(capture.meters).toEqual([]);
  });

  it("says when the capture latency drifts from the check's, records it, restarts the recording after an attempt it held through, and says it recovered", async () => {
    const r = rig();
    const events = spyEvents();
    const { fake, capture } = await recording(r);
    r.s.service.putCameraClock('laptop', CHECK);
    TestBed.tick();
    feed(capture, r, 12, 4.1);
    expect(r.recording.latencyDrift()).toBeNull();
    expect(r.recording.captureLatencyMs()).toBe(4.1);
    // The step of 2026-10-09: 75 ms more from now on.
    feed(capture, r, 12, 79.2);
    expect(r.recording.latencyDrift()).toBe(76);
    const latency = events.filter(([kind]) => kind === 'recording.latency').map(([, d]) => d);
    expect(latency).toEqual([
      expect.objectContaining({
        camera: 'laptop',
        why: 'drift',
        baselineMs: 3.2,
        p50Ms: 79.2,
        p95Ms: 86.2,
        deltaMs: 76,
        basis: 'timestamp',
        waiting: 28,
        frameIntervalMs: 34.6,
        restartOn: true,
      }),
    ]);

    // An attempt through the drift: once its solve clip is saved, the recording starts again.
    const scrambled = scramble(r, fake);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    solve(r, fake, scrambled);
    await wait(r, SAVE_AFTER_MS);
    expect(r.starter.started).toHaveLength(1);
    capture.saveNext();
    await settle();
    await sync(r);
    expect(capture.stopped).toBe(true);
    expect(r.starter.started).toHaveLength(2);
    expect(r.recording.restarted()).toMatchObject({ deltaMs: 76 });
    expect(events.filter(([kind]) => kind === 'recording.restarted').map(([, d]) => d)).toEqual([
      { why: 'latency', camera: 'laptop', deltaMs: 76, baselineMs: 3.2, p50Ms: 79.2, p95Ms: 86.2 },
    ]);
    expect(r.s.service.session()?.notes).toContain(
      'recording restarted: the capture latency of laptop was +76 ms from its sync check',
    );

    // The new run's frames come as before the step: recovered, said once a minute after the drift.
    const next = r.starter.last;
    feed(next, r, 70, 4.3);
    expect(r.recording.latencyDrift()).toBeNull();
    expect(r.recording.restarted()).toBeNull();
    expect(
      events.filter(([kind]) => kind === 'recording.latency').map(([, d]) => d['why']),
    ).toEqual(['drift', 'recovered']);
  });

  it('does not restart for a drift that began during the attempt, once per drift, nor with the setting off', async () => {
    const r = rig();
    const events = spyEvents();
    const { fake, capture } = await recording(r);
    r.s.service.putCameraClock('laptop', CHECK);
    TestBed.tick();
    feed(capture, r, 12, 4.1);
    // The scramble turned before the drift: it did not hold for the whole attempt.
    const first = scramble(r, fake);
    feed(capture, r, 12, 79.2);
    expect(r.recording.latencyDrift()).toBe(76);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    solve(r, fake, first);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    await settle();
    await sync(r);
    expect(r.starter.started).toHaveLength(1);

    // The setting off: the next attempt, through the drift, does not restart either.
    TestBed.inject(SettingsService).setRestartOnLatencyDrift(false);
    await wait(r, 5000);
    const second = scramble(r, fake);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    solve(r, fake, second);
    await wait(r, SAVE_AFTER_MS);
    capture.saveNext();
    await settle();
    await sync(r);
    expect(r.starter.started).toHaveLength(1);
    expect(events.filter(([kind]) => kind === 'recording.restarted')).toEqual([]);
  });

  it("summarises the pipeline's counters over a clip's span", () => {
    const at = (atMs: number, waiting: number, delay: number, queueMax = 1): StatsEntryLike => ({
      atMs,
      stats: {
        ...latencyStats(1, 4),
        fps: 30,
        postedHostMs: atMs - delay,
        latency: {
          capture: null,
          encode: null,
          floorMs: null,
          queueMax,
          pending: queueMax,
          waiting,
          frameIntervalMs: 33.3,
        },
      },
    });
    const entries = [
      at(900, 30, 9),
      at(1000, 0, 1),
      at(2000, 29, 2, 5),
      at(3000, 30, 3),
      at(5000, 0, 50),
    ];
    expect(pipelineSummary(entries, 1000, 3000)).toEqual({
      waitingShare: 0.97,
      queueMax: 5,
      pendingMax: 5,
      mainDelayMs: 2,
      seconds: 3,
    });
    expect(pipelineSummary(entries, 6000, 7000)).toEqual({
      waitingShare: null,
      queueMax: null,
      pendingMax: null,
      mainDelayMs: null,
      seconds: 0,
    });
  });
});

interface StatsEntryLike {
  readonly atMs: number;
  readonly stats: CaptureStats;
}
