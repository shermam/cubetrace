// Records and documents for the unit tests of the session index (T3.1): sessions of a real cube,
// which the index writes (the test sessions of session-testing.ts have the demo's simulated cube,
// which it never writes), and attempts with clips. Nothing in the app imports this file, so it is
// not in the bundle.
import {
  cloudAttempt,
  cloudSession,
  pendingUpload,
  type AttemptRecord,
  type CameraInfo,
  type CloudAttempt,
  type CloudSession,
  type SessionRecord,
  type VideoClip,
  type VideoSegment,
} from '@cubetrace/core';

import { SESSION_A, testAttempt, testSession } from '../session/session-testing';

/** The owner's GAN 12 ui, as session.json records it. */
export const GAN_12_UI = {
  model: 'GAN 12 ui FreePlay',
  hardware: 'GAN Gen2',
  firmware: '2.3.1',
  gyro: true,
};

/** The laptop's camera, as the camera panel records it. */
export const LAPTOP_CAMERA: CameraInfo = {
  label: 'laptop',
  local: true,
  facing: 'user',
  deviceLabel: 'FaceTime HD Camera',
  settings: { width: 1920, height: 1080, frameRate: 30 },
  capabilities: {},
  constraints: {},
  crop: null,
  mode: 'full',
  microphone: null,
};

/** A session of a real cube on `host`, with the laptop's camera. */
export function realSession(
  id = SESSION_A,
  createdMs = 1_790_000_000_000,
  host = 'Linux laptop',
): SessionRecord {
  const session = testSession(id, createdMs);
  return {
    ...session,
    host: { ...session.host, label: host },
    cube: { ...GAN_12_UI },
    cameras: [LAPTOP_CAMERA],
  };
}

/** A clip of the laptop's camera of `bytes`. */
export function clipOf(segment: VideoSegment, bytes: number): VideoClip {
  return {
    camera: 'laptop',
    segment,
    file: `laptop.${segment}.mp4`,
    bytes,
    codec: 'avc1.640028',
    audio: 'mp4a.40.2',
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 300,
    firstFrameHostMs: 1_790_000_001_000,
    framesFile: `laptop.${segment}.frames.json`,
    syncResidualMs: null,
    truncatedStart: false,
  };
}

/** Attempt `index` of `session`, solved in `timeMs`, with its two clips (1.2 and 4.1 MB). */
export function attemptWithClips(
  index: number,
  timeMs: number | null = 10_000,
  session = SESSION_A,
): AttemptRecord {
  return {
    ...testAttempt(index, timeMs, { session }),
    video: [clipOf('scramble', 1_200_000), clipOf('solve', 4_100_000)],
  };
}

/** `session` as the index of the account `owner` has it. */
export function sessionDocument(session: SessionRecord, owner: string): CloudSession {
  return cloudSession(session, owner);
}

/**
 * `attempt` of `session` as the index of the account `owner` has it: its files pending, or uploaded
 * at `doneMs` when it is given.
 */
export function attemptDocument(
  attempt: AttemptRecord,
  session: SessionRecord,
  owner: string,
  doneMs: number | null = null,
): CloudAttempt {
  const sizes: Record<string, number> = { 'attempt.json': 5_000 };
  for (const clip of attempt.video) {
    sizes[clip.file] = clip.bytes;
    sizes[clip.framesFile] = 2_000;
  }
  const upload = pendingUpload(sizes);
  if (doneMs !== null) {
    upload.state = 'done';
    for (const file of Object.values(upload.files)) {
      file.doneMs = doneMs;
    }
  }
  return cloudAttempt({ attempt, session, owner, upload });
}
