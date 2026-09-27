// session.json (docs/DATA-MODEL.md §6), schema version 2: the record of one session, created when it
// starts and saved again as it goes (the summary after every attempt, the cube clock fit, later the
// cameras and their clock sync).
import type { AttemptRecord, CropRect } from './attempt';
import type { CubeClockParams } from './clock';

/** The device that runs the session and holds the cube (`host` in session.json). */
export interface HostInfo {
  /** A name the owner gives the device, such as `office-mbp`. */
  label: string;
  userAgent: string;
  /** The platform, such as `macOS` or `Android`. */
  platform: string;
  isPhone: boolean;
}

/** What the cube says it is, from its `hardware` event (`cube` in session.json). */
export interface CubeInfo {
  model: string;
  hardware: string;
  firmware: string;
  gyro: boolean;
}

/** The timer settings the session runs with (`settings` in session.json). */
export interface SessionSettings {
  inspection15s: boolean;
  autoAdvance: boolean;
}

/** Counts of the session's attempts (`summary` in session.json); see {@link summarize}. */
export interface SessionSummary {
  attempts: number;
  solved: number;
  dnf: number;
}

/** A camera of the session: an entry of `cameras` in session.json (docs/DATA-MODEL.md §6). */
export interface CameraInfo {
  /**
   * Unique within the session, and the first part of its clips' file names: lowercase letters and
   * digits in words joined by hyphens, such as `laptop` or `phone-front` (docs/DATA-MODEL.md §5).
   */
  label: string;
  /** The host's own camera; phase 2 has no other. */
  local: true;
  /** Which way the camera faces, when the browser says (`facingMode`). */
  facing: 'user' | 'environment' | 'unknown';
  /** The camera's name as the browser gives it (`MediaDeviceInfo.label`). */
  deviceLabel: string;
  /** `MediaStreamTrack.getSettings()` when the camera was opened, as JSON. */
  settings: Record<string, unknown>;
  /** `MediaStreamTrack.getCapabilities()`, as JSON. */
  capabilities: Record<string, unknown>;
  /** The constraints the app opened the camera with, as JSON. */
  constraints: Record<string, unknown>;
  /** The framing rectangle the model trains on; null for the whole frame. */
  crop: CropRect | null;
  /** `full`: whole frames are recorded (phase 2); `crop`: only the `crop` rectangle. */
  mode: 'full' | 'crop';
}

/** One turn of the clapperboard matched to the motion it made in a camera's frames. */
export interface ClapperboardSample {
  /** The turn, on the host clock. */
  moveHostMs: number;
  /** The motion onset in the camera's frames, on the host clock. */
  onsetHostMs: number;
}

/** The clock sync of one camera: an entry of `clock.cameras` in session.json (§6). */
export interface CameraClock {
  /**
   * How far the camera's frames lag the cube: the median of `onsetHostMs − moveHostMs` over the
   * clapperboard's turns. A clip's `syncResidualMs` is this value when it was recorded.
   */
  offsetMs: number;
  /** The round-trip time of a remote camera's clock sync (phase 4); 0 for a local camera. */
  rttMs: number;
  /** The drift of a remote camera's clock against the host's, in ppm (phase 4); 0 for a local one. */
  driftPpm: number;
  /** The spread of the clapperboard's offsets (95th minus 5th percentile). */
  clapperboardResidualMs: number;
  /** The clapperboard's turns matched to a motion onset. */
  clapperboardSamples: number;
  /** The matched pairs, when kept. */
  samples?: ClapperboardSample[];
}

/** session.json, schema version 2 (docs/DATA-MODEL.md §6). */
export interface SessionRecord {
  schema: 2;
  /** A UUID v4, which names the session's folder (docs/DATA-MODEL.md §5). */
  id: string;
  /** Host clock when the session was created. */
  createdMs: number;
  app: { version: string; commit: string };
  host: HostInfo;
  cube: CubeInfo;
  /** The cameras; empty without one. */
  cameras: CameraInfo[];
  clock: {
    /**
     * A coarse summary: the cube clock fit (`CubeClockFit.params`) of the connection during which
     * the last attempt ended. Each attempt's own fit (`AttemptRecord.clock`) is the one to use.
     */
    cube: CubeClockParams;
    /** The clock sync of each camera, by label. */
    cameras: Record<string, CameraClock>;
  };
  /** The cameras record audio with their video (phase 2); on by default. */
  audio: boolean;
  settings: SessionSettings;
  notes: string;
  summary: SessionSummary;
}

/** A UUID v4 as `crypto.randomUUID()` writes it: lowercase hexadecimal. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The clock fit of a session without moves yet, as `CubeClockFit` reports it with no sample. */
const NO_CLOCK_FIT: CubeClockParams = { a: 1, b: 0, residualP95Ms: 0, samples: 0 };

/**
 * A new session record: no attempts, no clock fit yet, no cameras, audio on (the default of the
 * design, as in the example of docs/DATA-MODEL.md §6). Only the fields of
 * {@link HostInfo}, {@link CubeInfo} and {@link SessionSettings} are copied from the input, so that
 * passing, say, the cube's `hardware` event as `cube` does not add its `type` to session.json.
 *
 * @param input.id the session's id, for tests; by default `crypto.randomUUID()`. Throws if it is
 *   not a lowercase UUID v4.
 * @param input.audio whether the cameras record audio (phase 2); default true.
 */
export function createSession(input: {
  host: HostInfo;
  cube: CubeInfo;
  settings: SessionSettings;
  appVersion: string;
  commit: string;
  nowMs: number;
  id?: string;
  audio?: boolean;
}): SessionRecord {
  const id = input.id ?? crypto.randomUUID();
  if (!UUID_V4.test(id)) {
    throw new Error(`A session id is a lowercase UUID v4 (docs/DATA-MODEL.md §5), got "${id}".`);
  }
  const { host, cube, settings } = input;
  return {
    schema: 2,
    id,
    createdMs: input.nowMs,
    app: { version: input.appVersion, commit: input.commit },
    host: {
      label: host.label,
      userAgent: host.userAgent,
      platform: host.platform,
      isPhone: host.isPhone,
    },
    cube: { model: cube.model, hardware: cube.hardware, firmware: cube.firmware, gyro: cube.gyro },
    cameras: [],
    clock: { cube: { ...NO_CLOCK_FIT }, cameras: {} },
    audio: input.audio ?? true,
    settings: { inspection15s: settings.inspection15s, autoAdvance: settings.autoAdvance },
    notes: '',
    summary: { attempts: 0, solved: 0, dnf: 0 },
  };
}

/**
 * The session's `summary`, counted from its attempts: every attempt is either solved or a DNF.
 * Attempts of other sessions are ignored.
 */
export function summarize(
  session: SessionRecord,
  attempts: readonly AttemptRecord[],
): SessionSummary {
  const own = attempts.filter((a) => a.session === session.id);
  const solved = own.filter((a) => a.result.status === 'solved').length;
  return { attempts: own.length, solved, dnf: own.length - solved };
}
