// Records for the tests of the schemas and of the readers: made by the package as the app makes
// them, with the fields of phase 2 filled as the capture tasks will fill them, and the same records
// as schema version 1 wrote them. Not exported by the package.
import type {
  AttemptRecord,
  CameraClock,
  CameraInfo,
  FramesJson,
  SessionRecord,
  VideoClip,
  VideoSegment,
} from './index';
import { AttemptMachine, createSession, parseMoves } from './index';

export const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';

/** An attempt on `R U F` whose moves are `moves`, 100 ms apart on the cube clock. */
function attemptOf(moves: string, dnf: boolean): AttemptRecord {
  const machine = new AttemptMachine({
    session: SESSION,
    index: 7,
    scramble: 'R U F',
    scrambleShownMs: 1_790_000_000_000,
  });
  for (const [k, m] of parseMoves(moves).entries()) {
    machine.onMove({ m, cubeMs: 5000 + 100 * k, hostMs: 1_790_000_001_000.25 + 100.7 * k });
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
  };
}

/** The solved attempt with its two clips from the laptop's camera. */
export function attemptWithVideo(): AttemptRecord {
  return {
    ...solvedAttempt(),
    video: [clip('laptop', 'scramble'), { ...clip('laptop', 'solve'), audio: null, crop: null }],
  };
}

export function sessionRecord(): SessionRecord {
  return createSession({
    host: { label: 'laptop', userAgent: 'Mozilla/5.0', platform: 'Windows', isPhone: false },
    cube: { model: 'GAN 12 ui FreePlay', hardware: '1.2', firmware: '2.3.1', gyro: true },
    settings: { inspection15s: false, autoAdvance: true },
    appVersion: '0.2.0',
    commit: 'abc1234',
    nowMs: 1_730_640_000_000,
    id: SESSION,
  });
}

/** The laptop's camera as the camera panel (T2.1) will describe it. */
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

/** The session with the laptop's camera and its clock. */
export function sessionWithCamera(): SessionRecord {
  const s = sessionRecord();
  return {
    ...s,
    cameras: [CAMERA, { ...CAMERA, label: 'phone-rear', facing: 'environment', crop: null }],
    clock: { ...s.clock, cameras: { laptop: CAMERA_CLOCK, 'phone-rear': { ...CAMERA_CLOCK } } },
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

/** `record` without the field `key`. */
function without(record: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  Reflect.deleteProperty(copy, key);
  return copy;
}

/** An attempt as schema version 1 wrote it: no `clock`, no clips. */
export function asVersion1Attempt(a: AttemptRecord): Record<string, unknown> {
  return { ...without(a, 'clock'), schema: 1, video: [] };
}

/** A session as schema version 1 wrote it: no cameras. */
export function asVersion1Session(s: SessionRecord): Record<string, unknown> {
  return { ...s, schema: 1, cameras: [], clock: { cube: s.clock.cube, cameras: {} } };
}
