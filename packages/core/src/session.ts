// session.json (docs/DATA-MODEL.md §6): the record of one session, created when it starts and
// saved again as it goes (the summary after every attempt, the cube clock fit).
import type { AttemptRecord } from './attempt';
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

/** session.json, schema version 1 (docs/DATA-MODEL.md §6). */
export interface SessionRecord {
  schema: 1;
  /** A UUID v4, which names the session's folder (docs/DATA-MODEL.md §5). */
  id: string;
  /** Host clock when the session was created. */
  createdMs: number;
  app: { version: string; commit: string };
  host: HostInfo;
  cube: CubeInfo;
  /** Phase 2: the cameras. Always empty in phase 1. */
  cameras: [];
  clock: {
    /** The cube clock fit (`CubeClockFit.params`). */
    cube: CubeClockParams;
    /** Phase 2: the clock sync of each camera. Always empty in phase 1. */
    cameras: Record<string, never>;
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
    schema: 1,
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
