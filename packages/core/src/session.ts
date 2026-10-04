// session.json (docs/DATA-MODEL.md §6), schema version 2: the record of one session, created when it
// starts and saved again as it goes (the summary after every attempt, the cube clock fit, the
// cameras and their clock sync; since T4.0 the remote cameras, with the device each runs on and the
// fit of its clock).
import type { AttemptRecord, CropRect } from './attempt';
import type { CubeClockParams } from './clock';
import type { RemoteClockRecord } from './remote-clock';

/** The device that runs the session and holds the cube (`host` in session.json). */
export interface HostInfo {
  /** A name the owner gives the device, such as `office-mbp`. */
  label: string;
  userAgent: string;
  /** The platform, such as `macOS` or `Android`. */
  platform: string;
  isPhone: boolean;
}

/** The build of the app that wrote a record: `app` in every JSON file the app writes (T3.7). */
export interface AppBuild {
  /** The version of the root package.json. */
  version: string;
  /** The short SHA of the build's commit. */
  commit: string;
}

/** What the cube says it is, from its `hardware` event (`cube` in session.json). */
export interface CubeInfo {
  model: string;
  hardware: string;
  firmware: string;
  gyro: boolean;
  /**
   * The production date, as the cube's hardware message has it (a Gen4 cube says it; a Gen2 cube
   * does not); null when the cube does not say. Optional in the files (those written before T3.7
   * have none); `parseSession` reads a missing one as null.
   */
  productDate: string | null;
}

/** A battery report of the cube: an entry of `battery` in session.json (T3.7). */
export interface BatteryReading {
  /** When the cube reported it, on the host clock. */
  hostMs: number;
  /** In percent, 0 to 100. */
  level: number;
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

/**
 * How the recording asks for the microphone (docs/PLAN.md T2.12, Settings' "Microphone"): `raw`,
 * with the browser's voice processing off (echo cancellation, noise suppression, automatic gain
 * control, voice isolation), which takes a cube's clicks for noise; `voice`, with the browser's
 * defaults, for speech.
 */
export type MicrophoneProcessing = 'raw' | 'voice';

/**
 * The microphone of a camera's clips: `microphone` of an entry of `cameras` in session.json
 * (docs/DATA-MODEL.md §6). What the app asked for, and what the browser says it applied, from the
 * microphone track's `getSettings()`: each field null when the browser does not report it. The
 * device's id is not kept.
 */
export interface MicrophoneInfo {
  /** The microphone's name as the browser gives it (`MediaStreamTrack.label`). */
  label: string;
  /** What the app asked for. */
  processing: MicrophoneProcessing;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  voiceIsolation: boolean | null;
  /** In hertz. */
  sampleRate: number | null;
  channelCount: number | null;
}

/**
 * The device a remote camera runs on (phase 4, docs/PLAN.md T4.0): `remote` of an entry of `cameras`
 * in session.json (docs/DATA-MODEL.md §6), which a camera the host's own device runs has none of.
 */
export interface RemoteDevice {
  /** The device's host label (Settings → This device on the phone; `host.label` of its own records). */
  label: string;
  /** Its platform, such as `Android` (`host.platform` of its own records). */
  platform: string;
}

/** A camera of the session: an entry of `cameras` in session.json (docs/DATA-MODEL.md §6). */
export interface CameraInfo {
  /**
   * Unique within the session, and the first part of its clips' file names: lowercase letters and
   * digits in words joined by hyphens, such as `laptop` or `phone-front` (docs/DATA-MODEL.md §5).
   * One per device: a second camera of the laptop in the session is `laptop-2` ({@link labelFor}).
   */
  label: string;
  /**
   * The host's own camera (true), or a remote camera (false, since T4.0: a phone paired over WebRTC,
   * whose device is `remote`); phase 2 had only the former.
   */
  local: boolean;
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
  /**
   * The microphone of the camera's sound when it last recorded (docs/PLAN.md T2.12); null when it
   * recorded without one (Record audio off, the microphone refused). Optional in the files (those
   * written before it existed have none); `parseSession` reads a missing one as null.
   */
  microphone: MicrophoneInfo | null;
  /**
   * The device a remote camera runs on (T4.0): there exactly when `local` is false. Absent for the
   * host's own cameras, and from every file written before phase 4.
   */
  remote?: RemoteDevice;
}

/**
 * A camera as a session tells it from its other cameras (docs/PLAN.md T2.14, {@link labelFor}):
 * its label, the browser's name for it, and the browser's id for it when known. The records keep
 * the name (`deviceLabel`) and never the id, a hashed identifier of the browser's installation that
 * says nothing about the pictures (@cubetrace/capture's `snapshot` leaves it out): the app knows it
 * only while the page is open.
 */
export interface CameraIdentity {
  /** An entry's label in the session; for a camera to label, its own (`laptop`, `phone-front`). */
  readonly label: string;
  /** The browser's name for the camera (`MediaStreamTrack.label`). */
  readonly deviceLabel: string;
  /** `MediaDeviceInfo.deviceId`; null or absent when it is not known. */
  readonly deviceId?: string | null;
}

/** One turn of the clapperboard matched to the motion it made in a camera's frames. */
export interface ClapperboardSample {
  /** The turn, on the host clock. */
  moveHostMs: number;
  /**
   * The middle of the turn's motion in the camera's frames, on the host clock (until T2.11, the first
   * frame of the motion's rise; the name stays, docs/DATA-MODEL.md §6).
   */
  onsetHostMs: number;
}

/** The clock sync of one camera: an entry of `clock.cameras` in session.json (§6). */
export interface CameraClock {
  /**
   * How far the camera's frames lag the cube: the median of `onsetHostMs − moveHostMs` over the
   * clapperboard's turns kept (since T2.11 the fifth of the turns matched farthest from the median
   * are left out). A clip's `syncResidualMs` is this value when it was recorded.
   */
  offsetMs: number;
  /** The least round trip of a remote camera's clock sync, in ms (`remote.rttMs`); 0 for a local camera. */
  rttMs: number;
  /** The drift of a remote camera's clock against the host's, in ppm (`remote.driftPpm`); 0 for a local one. */
  driftPpm: number;
  /**
   * The spread of the clapperboard's offsets: since T2.11 the range of those of the turns kept (until
   * then the 95th minus the 5th percentile of all of them).
   */
  clapperboardResidualMs: number;
  /** The clapperboard's turns kept (until T2.11, all the turns matched to a motion). */
  clapperboardSamples: number;
  /** The pairs of the turns kept, when the record keeps them. */
  samples?: ClapperboardSample[];
  /**
   * The clock sync of a remote camera (T4.0, `RemoteClockFit.params`): the offset and the drift of
   * the phone's clock against the host's, from the data channel's pings, as they were when the record
   * was written, and since T4.2 whether the fit had converged then; `rttMs` and `driftPpm` above
   * repeat its round trip and drift. Absent for the host's own cameras.
   */
  remote?: RemoteClockRecord;
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
  /**
   * The cube's battery reports over the session's connections, in order, consecutive equal levels
   * coalesced (T3.7); empty when the cube reported none. Optional in the files (those written before
   * T3.7 have none); `parseSession` reads a missing one as empty.
   */
  battery: BatteryReading[];
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
 * @param input.cube the cube; its `productDate` may be left out (a cube that does not say it, the
 *   driver's `hardware` event), which is null in the record.
 * @param input.battery the cube's battery reports so far on the connection (T3.7); default none.
 */
export function createSession(input: {
  host: HostInfo;
  cube: Omit<CubeInfo, 'productDate'> & { productDate?: string | null };
  settings: SessionSettings;
  appVersion: string;
  commit: string;
  nowMs: number;
  id?: string;
  audio?: boolean;
  battery?: readonly BatteryReading[];
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
    cube: {
      model: cube.model,
      hardware: cube.hardware,
      firmware: cube.firmware,
      gyro: cube.gyro,
      productDate: cube.productDate ?? null,
    },
    cameras: [],
    clock: { cube: { ...NO_CLOCK_FIT }, cameras: {} },
    audio: input.audio ?? true,
    settings: { inspection15s: settings.inspection15s, autoAdvance: settings.autoAdvance },
    notes: '',
    summary: { attempts: 0, solved: 0, dnf: 0 },
    battery: (input.battery ?? []).map(({ hostMs, level }) => ({ hostMs, level })),
  };
}

/**
 * `readings` with `reading` added, unless its level is the last one's: the session's `battery`
 * keeps every report of the cube with consecutive equal levels coalesced (docs/DATA-MODEL.md §6).
 */
export function withBattery(
  readings: readonly BatteryReading[],
  reading: BatteryReading,
): BatteryReading[] {
  const last = readings.at(-1);
  return last !== undefined && last.level === reading.level
    ? [...readings]
    : [...readings, { hostMs: reading.hostMs, level: reading.level }];
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

/**
 * Whether `a` and `b` are the same camera: the browser names them alike and, when the ids of both
 * are known, gives them the same id (two cameras of one model can have one name).
 */
export function sameCamera(a: CameraIdentity, b: CameraIdentity): boolean {
  const idA = a.deviceId ?? null;
  const idB = b.deviceId ?? null;
  return a.deviceLabel === b.deviceLabel && (idA === null || idB === null || idA === idB);
}

/**
 * The label of `camera` among a session's `cameras` (docs/DATA-MODEL.md §6, docs/PLAN.md T2.14):
 * one per device within the session, the same each time the device is used in it. That of the
 * entry of the same camera ({@link sameCamera}; one with the same id first), so that a camera used
 * again gets its label back; else the camera's own label, `camera.label` (from the host and the
 * facing: `laptop`, `phone-front`, @cubetrace/capture's `cameraLabel`), when no entry has it; else
 * the first of `<label>-2`, `<label>-3`, … that no entry has. A new session, whose `cameras` are
 * empty, starts again at the camera's own label.
 */
export function labelFor(cameras: readonly CameraIdentity[], camera: CameraIdentity): string {
  const id = camera.deviceId ?? null;
  const same =
    cameras.find(
      (entry) => id !== null && entry.deviceId === id && entry.deviceLabel === camera.deviceLabel,
    ) ?? cameras.find((entry) => sameCamera(entry, camera));
  if (same !== undefined) {
    return same.label;
  }
  const taken = new Set(cameras.map((entry) => entry.label));
  let label = camera.label;
  for (let n = 2; taken.has(label); n++) {
    label = `${camera.label}-${String(n)}`;
  }
  return label;
}
