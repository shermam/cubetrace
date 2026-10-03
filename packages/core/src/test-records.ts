// Records for the tests of the schemas and of the readers: made by the package as the app makes
// them, with the fields of phase 2 filled as the capture tasks will fill them, and the same records
// as schema version 1 wrote them. Not exported by the package.
import type {
  AppBuild,
  AttemptRecord,
  CameraClock,
  CameraInfo,
  FramesJson,
  GyroJson,
  GyroSummary,
  MicrophoneInfo,
  RemoteClockParams,
  RemoteDevice,
  SessionRecord,
  VideoClip,
  VideoSegment,
} from './index';
import { AttemptMachine, createSession, parseMoves } from './index';

export const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';

/** The build that writes the test records (T3.7). */
export const APP: AppBuild = { version: '0.2.0', commit: 'abc1234' };

/**
 * An attempt on `R U F` whose moves are `moves`, 100 ms apart on the cube clock, each with the
 * cube's counter from 1, that names the build.
 */
function attemptOf(moves: string, dnf: boolean): AttemptRecord {
  const machine = new AttemptMachine({
    session: SESSION,
    index: 7,
    scramble: 'R U F',
    scrambleShownMs: 1_790_000_000_000,
    app: APP,
  });
  for (const [k, m] of parseMoves(moves).entries()) {
    machine.onMove({
      m,
      cubeMs: 5000 + 100 * k,
      hostMs: 1_790_000_001_000.25 + 100.7 * k,
      serial: k + 1,
    });
  }
  if (dnf) {
    machine.markDnf(1_790_000_009_000);
  }
  return machine.toRecord();
}

/** A solved attempt on `R U F`, whose f2l phases name their slots, with its clock fit. */
export function solvedAttempt(): AttemptRecord {
  return attemptOf("R U F F' U' R'", false);
}

/** A DNF one move into the solve. */
export function dnfAttempt(): AttemptRecord {
  return attemptOf("R U F F'", true);
}

/** A DNF before any move: no clock fit. */
export function untouchedAttempt(): AttemptRecord {
  return attemptOf('', true);
}

/** A clip as the capture tasks (T2.3, T2.4) will describe it. */
export function clip(camera: string, segment: VideoSegment): VideoClip {
  return {
    camera,
    segment,
    file: `${camera}.${segment}.mp4`,
    bytes: 4_412_345,
    codec: 'avc1.640028',
    audio: 'mp4a.40.2',
    width: 1920,
    height: 1080,
    crop: { x: 480, y: 120, w: 960, h: 840 },
    fpsNominal: 30,
    frames: 541,
    firstFrameHostMs: 1_790_000_000_812.4,
    framesFile: `${camera}.${segment}.frames.json`,
    syncResidualMs: 41.5,
    truncatedStart: false,
  };
}

/** The gyro file of an attempt as the session service writes it (T3.7), summed up. */
export const GYRO: GyroSummary = {
  file: 'gyro.json',
  samples: 1234,
  fromHostMs: 1_789_999_999_012.5,
  toHostMs: 1_790_000_024_340.7,
  rateHz: 48.7,
  truncatedStart: false,
};

/**
 * The solved attempt with its two clips from the laptop's camera, the scramble's begun later than
 * asked (its start was older than the capture's buffer, T2.9), its gyro file, and a resync during
 * the solve (T3.7).
 */
export function attemptWithVideo(): AttemptRecord {
  const attempt = solvedAttempt();
  return {
    ...attempt,
    video: [
      { ...clip('laptop', 'scramble'), truncatedStart: true },
      { ...clip('laptop', 'solve'), audio: null, crop: null },
    ],
    gyro: { ...GYRO },
    resyncs: [
      { hostMs: 1_790_000_001_450.5, facelets: attempt.scrambledFacelets, state: 'scrambling' },
    ],
  };
}

export function sessionRecord(): SessionRecord {
  return createSession({
    host: { label: 'laptop', userAgent: 'Mozilla/5.0', platform: 'Windows', isPhone: false },
    cube: { model: 'GAN 12 ui FreePlay', hardware: '1.2', firmware: '2.3.1', gyro: true },
    settings: { inspection15s: false, autoAdvance: true },
    appVersion: APP.version,
    commit: APP.commit,
    nowMs: 1_730_640_000_000,
    id: SESSION,
  });
}

/** The laptop's microphone, asked for raw, as the recording (T2.12) describes it. */
export const MICROPHONE: MicrophoneInfo = {
  label: 'MacBook Pro Microphone (Built-in)',
  processing: 'raw',
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: null,
  sampleRate: 48_000,
  channelCount: 1,
};

/** The laptop's camera as the camera panel (T2.1) will describe it, with its microphone. */
export const CAMERA: CameraInfo = {
  label: 'laptop',
  local: true,
  facing: 'user',
  deviceLabel: 'FaceTime HD Camera (Built-in) (05ac:8514)',
  settings: { deviceId: 'hashed', width: 1920, height: 1080, frameRate: 30, facingMode: 'user' },
  capabilities: { width: { min: 1, max: 1920 }, frameRate: { min: 1, max: 30 }, facingMode: [] },
  constraints: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
  crop: { x: 480, y: 120, w: 960, h: 840 },
  mode: 'full',
  microphone: MICROPHONE,
};

/** Its clock, as the clapperboard (T2.5) will measure it. */
export const CAMERA_CLOCK: CameraClock = {
  offsetMs: 41.5,
  rttMs: 0,
  driftPpm: 0,
  clapperboardResidualMs: 12.25,
  clapperboardSamples: 2,
  samples: [
    { moveHostMs: 1_730_640_010_000.5, onsetHostMs: 1_730_640_010_040.5 },
    { moveHostMs: 1_730_640_012_000.5, onsetHostMs: 1_730_640_012_043.1 },
  ],
};

/** The phone a remote camera runs on (T4.0), as its own records name it. */
export const REMOTE_DEVICE: RemoteDevice = { label: 'Android phone', platform: 'Android' };

/** The clock sync of the phone's camera, as the host's `RemoteClockFit` reports it (T4.0). */
export const REMOTE_CLOCK: RemoteClockParams = {
  offsetMs: -3127.4,
  driftPpm: 37.8,
  rttMs: 9.6,
  samples: 58,
  residualP95Ms: 1.1,
  since: 1_730_640_000_123.5,
};

/**
 * The session with the laptop's camera and its clock, and a phone's rear camera, remote (T4.0), that
 * recorded without a microphone, with the clock sync of its device beside the clapperboard's result;
 * its cube says its production date and reported its battery twice (T3.7).
 */
export function sessionWithCamera(): SessionRecord {
  const s = sessionRecord();
  return {
    ...s,
    cube: { ...s.cube, productDate: '2025-03-14' },
    cameras: [
      CAMERA,
      {
        ...CAMERA,
        label: 'phone-rear',
        local: false,
        facing: 'environment',
        crop: null,
        microphone: null,
        remote: REMOTE_DEVICE,
      },
    ],
    clock: {
      ...s.clock,
      cameras: {
        laptop: CAMERA_CLOCK,
        'phone-rear': {
          ...CAMERA_CLOCK,
          rttMs: REMOTE_CLOCK.rttMs,
          driftPpm: REMOTE_CLOCK.driftPpm,
          remote: REMOTE_CLOCK,
        },
      },
    },
    battery: [
      { hostMs: 1_730_640_000_100.5, level: 83 },
      { hostMs: 1_730_640_600_100.5, level: 82 },
    ],
  };
}

/** The frames file of a clip of 4 frames at 30 fps, one of them late. */
export function framesJson(): FramesJson {
  return {
    schema: 2,
    camera: 'laptop',
    segment: 'solve',
    t0HostMs: 1_790_000_000_812.4,
    dtMs: [0, 33.4, 33.3, 66.7],
    keyframes: [0, 3],
    arrival: { offsetMs: 1_789_999_990_000.25, residualP95Ms: 9.8 },
  };
}

/**
 * The frames file of a remote camera's clip as the host keeps it (T4.2): the phone's first frame time
 * kept, converted with the phone's clock sync of {@link REMOTE_CLOCK}.
 */
export function remoteFramesJson(): FramesJson {
  return {
    schema: 2,
    camera: 'phone-rear',
    segment: 'solve',
    app: { ...APP },
    t0HostMs: 1_790_000_003_939.81,
    t0RemoteMs: 1_790_000_000_812.4,
    dtMs: [0, 33.4, 33.3, 66.7],
    keyframes: [0, 3],
    arrival: { offsetMs: 1_789_999_990_000.25, residualP95Ms: 9.8 },
    remote: { ...REMOTE_CLOCK, converged: true, takenMs: 1_790_000_009_250.5 },
  };
}

/** The gyro file of a short attempt: four samples at 50 Hz, with velocities (T3.7). */
export function gyroJson(): GyroJson {
  return {
    schema: 1,
    session: SESSION,
    index: 7,
    app: { ...APP },
    t0HostMs: 1_789_999_999_012.5,
    dtMs: [0, 20.1, 19.9, 20],
    q: [0, 0, 0, 1, 0, 0, 0.08716, 0.99619, 0, 0, 0.17365, 0.98481, 0, 0, 0.25882, 0.96593],
    v: [0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0, 2],
    truncatedStart: false,
  };
}

/** `record` without the fields `keys`. */
function without(record: object, ...keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  for (const key of keys) {
    Reflect.deleteProperty(copy, key);
  }
  return copy;
}

/** An attempt as schema version 1 wrote it: no `clock`, no clips, none of T3.7's fields. */
export function asVersion1Attempt(a: AttemptRecord): Record<string, unknown> {
  return {
    ...without(a, 'app', 'clock', 'gyro', 'resyncs'),
    schema: 1,
    moves: a.moves.map((move) => without(move, 'serial', 'packetLast')),
    video: [],
  };
}

/** A session as schema version 1 wrote it: no cameras, no battery, no production date. */
export function asVersion1Session(s: SessionRecord): Record<string, unknown> {
  return {
    ...without(s, 'battery'),
    schema: 1,
    cube: without(s.cube, 'productDate'),
    cameras: [],
    clock: { cube: s.clock.cube, cameras: {} },
  };
}
