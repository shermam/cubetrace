// Readers of session.json and attempt.json (docs/DATA-MODEL.md, "Reading older records"): a record
// of schema version 1 or 2 is checked field by field against the JSON Schema of its version
// (packages/core/schema/) and comes back as a version 2 record, a new object that shares nothing
// with its input. The checks are written out here instead of being run by a JSON Schema validator,
// so that the app reads its files without one in its bundle; records.test.ts holds them to the
// schemas with ajv, field by field. Since T3.1 they also read the documents of the session index in
// Firestore (docs/DATA-MODEL.md §10), which are of version 2 only (cloud.test.ts holds them to theirs),
// and since T3.4 the account's cubes there, of version 1 (cloud-cube.test.ts).
import type {
  AttemptEvents,
  AttemptMove,
  AttemptPhase,
  AttemptRecord,
  AttemptResult,
  AttemptResync,
  CropRect,
  VideoClip,
} from './attempt';
import type { CubeClockParams } from './clock';
import type {
  CloudAttempt,
  CloudDevice,
  CloudSession,
  CloudUpload,
  CloudUploadFile,
} from './cloud';
import { CLOUD_UPLOAD_STATES } from './cloud';
import type { CloudCube } from './cloud-cube';
import { CUBE_NAME, MAC_ADDRESS } from './cloud-cube';
import type { GyroJson, GyroSummary } from './gyro';
import { GYRO_FILE } from './gyro';
import type { Face } from './notation';
import type { PhaseName } from './phases';
import { PHASE_NAMES } from './phases';
import type { EdgePos } from './pieces';
import { EDGE_FACELETS } from './pieces';
import type {
  AppBuild,
  BatteryReading,
  CameraClock,
  CameraInfo,
  ClapperboardSample,
  CubeInfo,
  HostInfo,
  MicrophoneInfo,
  SessionRecord,
  SessionSettings,
  SessionSummary,
} from './session';
import { UUID_V4 } from './session';

/**
 * The files the readers read (the gyro file since T3.7), and the documents of the session index in
 * Firestore (T3.1) and of the account's cubes (T3.4), named by their paths.
 */
export type RecordFile =
  | 'session.json'
  | 'attempt.json'
  | 'gyro.json'
  | 'sessions/{id}'
  | 'sessions/{id}/attempts/{index}'
  | 'users/{uid}/cubes/{name}';

/**
 * What {@link parseSession} and {@link parseAttempt} throw for a record they do not accept. The
 * message names the file, the schema version the record says it has, the field and what is wrong
 * with it: `attempt.json (schema 2): moves[3].m must be a face turn such as R, U' or F2, got "M".`
 */
export class RecordError extends Error {
  override readonly name = 'RecordError';

  constructor(
    readonly file: RecordFile,
    /** The version whose schema the record failed; null when the version itself is the problem. */
    readonly version: 1 | 2 | null,
    /** The path of the field, such as `moves[3].m`; empty for the record as a whole. */
    readonly field: string,
    /** What is wrong with it, such as `is missing`. */
    readonly problem: string,
  ) {
    const where = version === null ? file : `${file} (schema ${String(version)})`;
    super(field === '' ? `${where} ${problem}.` : `${where}: ${field} ${problem}.`);
  }

  /** The field and what is wrong with it, without the file: `moves[3].m is missing`. */
  get detail(): string {
    return this.field === '' ? this.problem : `${this.field} ${this.problem}`;
  }
}

/**
 * attempt.json of schema version 1 or 2, as a version 2 record: a version 1 record gets `clock:
 * null` (no fit was kept; its moves have both clocks) and keeps its empty `video`. Throws a
 * {@link RecordError} naming the field on anything else, such as a record that breaks the schema of
 * its version, or a version other than 1 and 2.
 */
export function parseAttempt(json: unknown): AttemptRecord {
  return parse('attempt.json', json, {
    1: (value) => upgradeAttempt(ATTEMPT_V1.read(value, '')),
    2: (value) => ATTEMPT_V2.read(value, ''),
  });
}

/**
 * session.json of schema version 1 or 2, as a version 2 record: a version 1 record keeps its empty
 * `cameras` and `clock.cameras`. Throws a {@link RecordError} naming the field on anything else.
 */
export function parseSession(json: unknown): SessionRecord {
  return parse('session.json', json, {
    1: (value) => upgradeSession(SESSION_V1.read(value, '')),
    2: (value) => SESSION_V2.read(value, ''),
  });
}

/**
 * A session's document in the session index (`sessions/{id}`, docs/DATA-MODEL.md §10): session.json of
 * schema version 2 with its `owner`. Throws a {@link RecordError} naming the field on anything else,
 * such as a document of another version, written by another version of the app.
 */
export function parseCloudSession(json: unknown): CloudSession {
  return parseDocument('sessions/{id}', json, CLOUD_SESSION);
}

/**
 * An attempt's document in the session index (`sessions/{id}/attempts/{index}`, docs/DATA-MODEL.md
 * §10): attempt.json of schema version 2 without `moves`, with its `owner`, `device` and `upload`.
 * Throws a {@link RecordError} naming the field on anything else.
 */
export function parseCloudAttempt(json: unknown): CloudAttempt {
  return parseDocument('sessions/{id}/attempts/{index}', json, CLOUD_ATTEMPT);
}

/**
 * A cube of the account's list in Firestore (`users/{uid}/cubes/{name}`, docs/DATA-MODEL.md §10,
 * T3.4): schema version 1, its name, its MAC address normalized, when it last changed and the device
 * that wrote it. Throws a {@link RecordError} naming the field on anything else, such as a document of
 * another version, written by another version of the app.
 */
export function parseCloudCube(json: unknown): CloudCube {
  return parseDocument('users/{uid}/cubes/{name}', json, CLOUD_CUBE, 1);
}

/**
 * gyro.json of an attempt (docs/DATA-MODEL.md §11, T3.7), schema version 1, the only one: the
 * samples of the attempt's gyro window. Beyond the schema, the quaternions must be four numbers per
 * sample and the velocities, when there are any, three. Throws a {@link RecordError} naming the field
 * on anything else.
 */
export function parseGyro(json: unknown): GyroJson {
  return parseDocument('gyro.json', json, GYRO, 1);
}

function parse<T>(
  file: RecordFile,
  json: unknown,
  readers: Readonly<Record<1 | 2, (value: unknown) => T>>,
): T {
  if (!isObject(json)) {
    throw new RecordError(file, null, '', `must be an object, got ${show(json)}`);
  }
  const version = json['schema'];
  if (version !== 1 && version !== 2) {
    throw new RecordError(file, null, 'schema', `must be 1 or 2, got ${show(version)}`);
  }
  try {
    return readers[version](json);
  } catch (error: unknown) {
    if (error instanceof Invalid) {
      throw new RecordError(file, version, error.field, error.problem);
    }
    throw error;
  }
}

/**
 * A record of one schema version, the only one ever written: 2 for the documents of the session
 * index, 1 for the cubes' documents and for the gyro files.
 */
function parseDocument<T>(
  file: RecordFile,
  json: unknown,
  reader: Reader<T>,
  version: 1 | 2 = 2,
): T {
  if (!isObject(json)) {
    throw new RecordError(file, null, '', `must be an object, got ${show(json)}`);
  }
  if (json['schema'] !== version) {
    throw new RecordError(
      file,
      null,
      'schema',
      `must be ${String(version)}, got ${show(json['schema'])}`,
    );
  }
  try {
    return reader.read(json, '');
  } catch (error: unknown) {
    if (error instanceof Invalid) {
      throw new RecordError(file, version, error.field, error.problem);
    }
    throw error;
  }
}

// ---- The versions ----

/** A move of schema version 1: without the counter and the packet flag of T3.7. */
type AttemptMoveV1 = Omit<AttemptMove, 'serial' | 'packetLast'>;

/**
 * attempt.json of schema version 1: no `clock`, `video` always empty, and none of T3.7's fields (the
 * build, the gyro file, the resyncs, the moves' counters and packet flags).
 */
type AttemptRecordV1 = Omit<
  AttemptRecord,
  'schema' | 'app' | 'moves' | 'clock' | 'video' | 'gyro' | 'resyncs'
> & {
  schema: 1;
  moves: AttemptMoveV1[];
  video: never[];
};

/** The cube of schema version 1: without the production date of T3.7. */
type CubeInfoV1 = Omit<CubeInfo, 'productDate'>;

/**
 * session.json of schema version 1: `cameras` and `clock.cameras` always empty, no battery reports
 * and no production date (T3.7).
 */
type SessionRecordV1 = Omit<SessionRecord, 'schema' | 'cube' | 'cameras' | 'clock' | 'battery'> & {
  schema: 1;
  cube: CubeInfoV1;
  cameras: never[];
  clock: { cube: CubeClockParams; cameras: Record<string, never> };
};

/** The fields in the order of the schema, which the records keep when written again. */
function upgradeAttempt(a: AttemptRecordV1): AttemptRecord {
  return {
    schema: 2,
    session: a.session,
    index: a.index,
    scramble: a.scramble,
    scrambledFacelets: a.scrambledFacelets,
    crossFace: a.crossFace,
    events: a.events,
    moves: a.moves,
    clock: null,
    result: a.result,
    phases: a.phases,
    video: [],
    gyro: null,
    resyncs: [],
  };
}

function upgradeSession(s: SessionRecordV1): SessionRecord {
  return {
    schema: 2,
    id: s.id,
    createdMs: s.createdMs,
    app: s.app,
    host: s.host,
    cube: { ...s.cube, productDate: null },
    cameras: [],
    clock: { cube: s.clock.cube, cameras: {} },
    audio: s.audio,
    settings: s.settings,
    notes: s.notes,
    summary: s.summary,
    battery: [],
  };
}

// ---- A reader per part of the schemas (packages/core/schema/) ----

/**
 * Checks the value at `at` (a path such as `moves[3].m`) and returns a copy of it, or throws an
 * {@link Invalid} for the first field that breaks the rule.
 */
interface Reader<T> {
  /** What the value must be, for the messages: `a number ≥ 0`. */
  readonly what: string;
  read(value: unknown, at: string): T;
}

/** A field that may be absent (a phase's `slot`, a camera clock's `samples`). */
interface Optional<T> {
  readonly optional: Reader<T>;
}

/**
 * A field that may be absent, read as `absent` then (a clip's `truncatedStart`, a camera's
 * `microphone`).
 */
interface Defaulted<T> extends Optional<T> {
  readonly absent: T;
}

type Fields<T> = {
  readonly [K in keyof T]-?: Reader<T[K]> | Optional<Exclude<T[K], undefined>>;
};

/** The first rule a record breaks, before the reader knows the file. */
class Invalid extends Error {
  constructor(
    readonly field: string,
    readonly problem: string,
  ) {
    super(`${field} ${problem}`);
  }
}

function fail(at: string, problem: string): never {
  throw new Invalid(at, problem);
}

function join(at: string, key: string): string {
  return at === '' ? key : `${at}.${key}`;
}

/** A value, briefly, for a message: a string in quotes (cut after 40 characters), `an object`. */
function show(value: unknown): string {
  switch (typeof value) {
    case 'string': {
      const json = JSON.stringify(value);
      return json.length > 40 ? `${json.slice(0, 38)}…"` : json;
    }
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'undefined':
      return 'nothing';
    case 'object':
      return value === null ? 'null' : Array.isArray(value) ? 'an array' : 'an object';
    default:
      return `a ${typeof value}`;
  }
}

/** A JSON object: what JSON Schema's type `object` accepts. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value that the reader returns as it is (a number, a string, a boolean or null). */
function leaf<T>(what: string, accepts: (value: unknown) => value is T): Reader<T> {
  return {
    what,
    read: (value, at) => (accepts(value) ? value : fail(at, `must be ${what}, got ${show(value)}`)),
  };
}

/** A finite number (JSON has no other), at least `min` or more than `above`. */
function num(bound: { min?: number; above?: number } = {}): Reader<number> {
  const { min, above } = bound;
  const what =
    min !== undefined
      ? `a number ≥ ${String(min)}`
      : above !== undefined
        ? `a number > ${String(above)}`
        : 'a number';
  return leaf(
    what,
    (value): value is number =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (min === undefined || value >= min) &&
      (above === undefined || value > above),
  );
}

/** An integer from `min`, and at most `max` when given. */
function int(min: number, max?: number): Reader<number> {
  return leaf(
    max === undefined
      ? `an integer ≥ ${String(min)}`
      : `an integer from ${String(min)} to ${String(max)}`,
    (value): value is number =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= min &&
      (max === undefined || value <= max),
  );
}

/** A string, matching `pattern` if there is one (with the `u` flag, as JSON Schema's patterns). */
function text(what = 'a string', pattern?: RegExp): Reader<string> {
  return leaf(
    what,
    (value): value is string =>
      typeof value === 'string' && (pattern === undefined || pattern.test(value)),
  );
}

/** A string of at least one character (JSON Schema's `minLength: 1`). */
const nonEmpty = leaf(
  'a non-empty string',
  (value): value is string => typeof value === 'string' && value !== '',
);

const bool = leaf('true or false', (value): value is boolean => typeof value === 'boolean');

/** One of `values` (JSON Schema's `enum`, or its `const` for one value). */
function oneOf<const T extends readonly (string | number | boolean | null)[]>(
  ...values: T
): Reader<T[number]> {
  const shown = values.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v)));
  const what = shown.length === 1 ? shown[0] : `one of ${shown.join(', ')}`;
  return leaf(what, (value): value is T[number] => (values as readonly unknown[]).includes(value));
}

function nullable<T>(inner: Reader<T>): Reader<T | null> {
  const what = `${inner.what} or null`;
  return {
    what,
    read: (value, at) => {
      if (value === null) {
        return null;
      }
      try {
        return inner.read(value, at);
      } catch (error: unknown) {
        // A value of the wrong type is told what it can be; a problem inside an object stays.
        if (error instanceof Invalid && error.field === at) {
          fail(at, `must be ${what}, got ${show(value)}`);
        }
        throw error;
      }
    },
  };
}

function optional<T>(read: Reader<T>): Optional<T> {
  return { optional: read };
}

function defaulted<T>(read: Reader<T>, absent: T): Defaulted<T> {
  return { optional: read, absent };
}

/** An array of `item`s, with at most `max` of them, and at least `min`. */
function list<T>(item: Reader<T>, opts: { max?: number; min?: number } = {}): Reader<T[]> {
  const { max, min } = opts;
  const what = max === 0 ? 'an empty array' : 'an array';
  return {
    what,
    read: (value, at) => {
      if (!Array.isArray(value)) {
        return fail(at, `must be ${what}, got ${show(value)}`);
      }
      const items = value as readonly unknown[];
      if (max !== undefined && items.length > max) {
        fail(
          at,
          max === 0
            ? `must be empty, got ${String(items.length)} item${items.length === 1 ? '' : 's'}`
            : `must have at most ${String(max)} items, got ${String(items.length)}`,
        );
      }
      if (min !== undefined && items.length < min) {
        fail(at, `must have at least ${String(min)} items, got ${String(items.length)}`);
      }
      const out: T[] = [];
      for (let i = 0; i < items.length; i++) {
        out.push(item.read(items[i], `${at}[${String(i)}]`));
      }
      return out;
    },
  };
}

/**
 * An object with exactly the fields of `fields`, in that order: every one present (a field whose
 * value is undefined is absent, as for JSON Schema's `required`) but the optional ones, and no
 * other. A defaulted field that is absent gets its default.
 */
function object<T>(fields: Fields<T>): Reader<T> {
  const known = fields as Readonly<
    Record<string, Reader<unknown> | Optional<unknown> | Defaulted<unknown>>
  >;
  const keys = Object.keys(known);
  return {
    what: 'an object',
    read: (value, at) => {
      if (!isObject(value)) {
        return fail(at, `must be an object, got ${show(value)}`);
      }
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const field = known[key];
        const item = value[key];
        if (item !== undefined) {
          out[key] = ('optional' in field ? field.optional : field).read(item, join(at, key));
        } else if ('absent' in field) {
          out[key] = field.absent;
        } else if (!('optional' in field)) {
          fail(join(at, key), 'is missing');
        }
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(known, key)) {
          fail(join(at, key), 'is not a known field');
        }
      }
      return out as T;
    },
  };
}

/** An object whose keys are camera labels, each holding an `item`. */
function byLabel<T>(item: Reader<T>): Reader<Record<string, T>> {
  return byKey(label, item);
}

/** An object whose keys are what `key` accepts (a string with a pattern), each holding an `item`. */
function byKey<T>(key: Reader<string>, item: Reader<T>): Reader<Record<string, T>> {
  return {
    what: 'an object',
    read: (value, at) => {
      if (!isObject(value)) {
        return fail(at, `must be an object, got ${show(value)}`);
      }
      return Object.fromEntries(
        Object.keys(value).map((name) => {
          try {
            key.read(name, join(at, name));
          } catch (error: unknown) {
            if (error instanceof Invalid) {
              fail(join(at, name), `is not ${key.what}`);
            }
            throw error;
          }
          return [name, item.read(value[name], join(at, name))];
        }),
      );
    },
  };
}

/** Any JSON object, copied whole: a snapshot of the browser's settings. */
const snapshot: Reader<Record<string, unknown>> = {
  what: 'an object',
  read: (value, at) =>
    isObject(value) ? structuredClone(value) : fail(at, `must be an object, got ${show(value)}`),
};

/** Never valid: the items of an array that must be empty. */
const nothing: Reader<never> = {
  what: 'nothing',
  read: (_value, at) => fail(at, 'must not be there'),
};

// ---- Both files ----

const LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const label = text(
  'a camera label: lowercase letters and digits in words joined by hyphens',
  LABEL,
);
const uuid = text('a lowercase UUID v4', UUID_V4);

const crop = nullable(object<CropRect>({ x: int(0), y: int(0), w: int(1), h: int(1) }));

/** The build of the app that wrote a record (T3.7), as session.json has had it since version 1. */
const app = object<AppBuild>({ version: text(), commit: text() });

function clockFit(minSamples: number): Reader<CubeClockParams> {
  return object<CubeClockParams>({
    a: num(),
    b: num(),
    residualP95Ms: num({ min: 0 }),
    samples: int(minSamples),
  });
}

// ---- attempt.json (docs/DATA-MODEL.md §7) ----

const F2L: readonly PhaseName[] = ['f2l1', 'f2l2', 'f2l3', 'f2l4'];

const phaseFields = object<AttemptPhase>({
  name: oneOf(...PHASE_NAMES),
  slot: optional(oneOf(...(Object.keys(EDGE_FACELETS) as EdgePos[]))),
  startMs: num(),
  endMs: num(),
  moves: int(0),
  recognitionMs: num({ min: 0 }),
  executionMs: num({ min: 0 }),
});

/** A phase, of which the f2l ones name their slot and the others do not. */
const phase: Reader<AttemptPhase> = {
  what: 'an object',
  read: (value, at) => {
    const p = phaseFields.read(value, at);
    if (F2L.includes(p.name) !== (p.slot !== undefined)) {
      fail(
        join(at, 'slot'),
        p.slot === undefined
          ? `is missing: ${p.name} names its slot`
          : 'must not be there: only the f2l phases have a slot',
      );
    }
    return p;
  },
};

const events = object<AttemptEvents>({
  scrambleShown: num(),
  scrambleStart: nullable(num()),
  scrambleDone: nullable(num()),
  pickup: nullable(num()),
  solveStart: nullable(num()),
  solveEnd: nullable(num()),
});

const moveFields = {
  m: text("a face turn such as R, U' or F2", /^[UDRLFB][2']?$/u),
  hostMs: num(),
  cubeMs: num(),
  phase: oneOf('scramble', 'solve'),
};

const moveV1 = object<AttemptMoveV1>(moveFields);

/** Since T3.7 a move has the cube's counter and its packet flag; the moves written before have none. */
const move = object<AttemptMove>({
  ...moveFields,
  serial: optional(nullable(int(0, 255))),
  packetLast: optional(bool),
});

const resync = object<AttemptResync>({
  hostMs: num(),
  facelets: text('54 facelets, each one of U R F D L B', /^[URFDLB]{54}$/u),
  state: oneOf('scrambling', 'armed', 'solving'),
});

const gyroSummary = object<GyroSummary>({
  file: oneOf(GYRO_FILE),
  samples: int(1),
  fromHostMs: num(),
  toHostMs: num(),
  rateHz: num({ min: 0 }),
  truncatedStart: bool,
});

const result = object<AttemptResult>({
  timeMs: nullable(num({ min: 0 })),
  inspectionMs: nullable(num({ min: 0 })),
  movesQtm: int(0),
  tps: nullable(num({ min: 0 })),
  status: oneOf('solved', 'dnf'),
  replayOk: bool,
  scrambleCorrected: bool,
  scrambleExtraMoves: int(0),
});

const clip = object<VideoClip>({
  camera: label,
  segment: oneOf('scramble', 'solve'),
  file: text('<camera>.<segment>.mp4', /^[a-z0-9]+(-[a-z0-9]+)*\.(scramble|solve)\.mp4$/u),
  bytes: int(1),
  codec: nonEmpty,
  audio: nullable(nonEmpty),
  width: int(1),
  height: int(1),
  crop,
  fpsNominal: num({ above: 0 }),
  frames: int(1),
  firstFrameHostMs: num(),
  framesFile: text(
    '<camera>.<segment>.frames.json',
    /^[a-z0-9]+(-[a-z0-9]+)*\.(scramble|solve)\.frames\.json$/u,
  ),
  syncResidualMs: nullable(num()),
  // Since T2.9; the clips written before it have none, and began where asked.
  truncatedStart: defaulted(bool, false),
  // Since T3.3, and only once the clip's MP4 was deleted from the device after its upload: absent,
  // the file is there.
  local: optional(bool),
});

/** The fields both versions share before the moves, in the order of the schemas. */
const attemptHead = {
  scramble: text('face turns separated by single spaces', /^[UDRLFB][2']?( [UDRLFB][2']?)*$/u),
  scrambledFacelets: text('54 facelets, each one of U R F D L B', /^[URFDLB]{54}$/u),
  crossFace: oneOf<(Face | null)[]>('U', 'R', 'F', 'D', 'L', 'B', null),
  events,
};

const attemptEnd = { result, phases: list(phase, { max: 8 }) };

/**
 * The fields of version 2 since T3.7 (the records written before have none): the gyro file, read as
 * null, and the resyncs, read as none.
 */
const attemptTail = {
  gyro: defaulted(nullable(gyroSummary), null),
  resyncs: defaulted(list(resync), []),
};

const ATTEMPT_V1 = object<AttemptRecordV1>({
  schema: oneOf(1),
  session: uuid,
  index: int(1),
  ...attemptHead,
  moves: list(moveV1),
  ...attemptEnd,
  video: list(nothing, { max: 0 }),
});

const ATTEMPT_V2 = object<AttemptRecord>({
  schema: oneOf(2),
  session: uuid,
  index: int(1),
  // Since T3.7; the records written before name no build.
  app: optional(app),
  ...attemptHead,
  moves: list(move),
  clock: nullable(clockFit(2)),
  ...attemptEnd,
  video: list(clip),
  ...attemptTail,
});

// ---- session.json (docs/DATA-MODEL.md §6) ----

const microphone = nullable(
  object<MicrophoneInfo>({
    label: text(),
    processing: oneOf('raw', 'voice'),
    echoCancellation: nullable(bool),
    noiseSuppression: nullable(bool),
    autoGainControl: nullable(bool),
    voiceIsolation: nullable(bool),
    sampleRate: nullable(num({ above: 0 })),
    channelCount: nullable(int(1)),
  }),
);

const camera = object<CameraInfo>({
  label,
  local: oneOf(true),
  facing: oneOf('user', 'environment', 'unknown'),
  deviceLabel: text(),
  settings: snapshot,
  capabilities: snapshot,
  constraints: snapshot,
  crop,
  mode: oneOf('full', 'crop'),
  // Since T2.12; the cameras written before it have none: their microphone, if any, had the
  // browser's defaults, and what it applied was not kept.
  microphone: defaulted(microphone, null),
});

const cameraClock = object<CameraClock>({
  offsetMs: num(),
  rttMs: num({ min: 0 }),
  driftPpm: num(),
  clapperboardResidualMs: num({ min: 0 }),
  clapperboardSamples: int(0),
  samples: optional(list(object<ClapperboardSample>({ moveHostMs: num(), onsetHostMs: num() }))),
});

const cubeFields = { model: text(), hardware: text(), firmware: text(), gyro: bool };

const sessionStart = {
  id: uuid,
  createdMs: num(),
  app,
  host: object<HostInfo>({ label: text(), userAgent: text(), platform: text(), isPhone: bool }),
};

/** The cube since T3.7: with its production date, null when it does not say; absent before. */
const cube = object<CubeInfo>({ ...cubeFields, productDate: defaulted(nullable(text()), null) });

const sessionEnd = {
  audio: bool,
  settings: object<SessionSettings>({ inspection15s: bool, autoAdvance: bool }),
  notes: text(),
  summary: object<SessionSummary>({ attempts: int(0), solved: int(0), dnf: int(0) }),
};

/** The battery reports since T3.7 (the records written before have none, read as none). */
const battery = defaulted(list(object<BatteryReading>({ hostMs: num(), level: int(0, 100) })), []);

const SESSION_V1 = object<SessionRecordV1>({
  schema: oneOf(1),
  ...sessionStart,
  cube: object<CubeInfoV1>(cubeFields),
  cameras: list(nothing, { max: 0 }),
  clock: object<SessionRecordV1['clock']>({
    cube: clockFit(0),
    cameras: object<Record<string, never>>({}),
  }),
  ...sessionEnd,
});

const SESSION_V2 = object<SessionRecord>({
  schema: oneOf(2),
  ...sessionStart,
  cube,
  cameras: list(camera),
  clock: object<SessionRecord['clock']>({ cube: clockFit(0), cameras: byLabel(cameraClock) }),
  ...sessionEnd,
  battery,
});

// ---- The session index in Firestore (docs/DATA-MODEL.md §10) ----

/** A Firebase Authentication uid. */
const owner = nonEmpty;

const CLOUD_SESSION = object<CloudSession>({
  schema: oneOf(2),
  ...sessionStart,
  cube,
  cameras: list(camera),
  clock: object<SessionRecord['clock']>({ cube: clockFit(0), cameras: byLabel(cameraClock) }),
  ...sessionEnd,
  battery,
  owner,
});

/**
 * The name of a file of an attempt's folder (docs/DATA-MODEL.md §5), or `session.json`, the session's
 * file, which its upload records on the attempt it went with (T3.2).
 */
const attemptFile = text(
  'attempt.json, session.json, gyro.json, <camera>.<segment>.mp4 or <camera>.<segment>.frames.json',
  /^(attempt\.json|session\.json|gyro\.json|[a-z0-9]+(-[a-z0-9]+)*\.(scramble|solve)\.(mp4|frames\.json))$/u,
);

const CLOUD_ATTEMPT = object<CloudAttempt>({
  schema: oneOf(2),
  session: uuid,
  index: int(1),
  app: optional(app),
  ...attemptHead,
  clock: nullable(clockFit(2)),
  ...attemptEnd,
  video: list(clip),
  ...attemptTail,
  owner,
  device: object<CloudDevice>({ host: text(), cameras: list(label) }),
  upload: object<CloudUpload>({
    state: oneOf(...CLOUD_UPLOAD_STATES),
    files: byKey(attemptFile, object<CloudUploadFile>({ bytes: int(1), doneMs: nullable(num()) })),
  }),
});

// ---- gyro.json (docs/DATA-MODEL.md §11, T3.7) ----

/** A number from −1 to 1: a unit quaternion's component. */
const component = leaf(
  'a number from -1 to 1',
  (value): value is number => typeof value === 'number' && value >= -1 && value <= 1,
);

const gyroFields = object<GyroJson>({
  schema: oneOf(1),
  session: uuid,
  index: int(1),
  app,
  t0HostMs: num(),
  dtMs: list(num({ min: 0 }), { min: 1 }),
  q: list(component, { min: 4 }),
  v: nullable(list(int(-8, 7))),
  truncatedStart: bool,
});

/** The gyro file, whose arrays are four quaternion components and three velocities per sample. */
const GYRO: Reader<GyroJson> = {
  what: 'an object',
  read: (value, at) => {
    const file = gyroFields.read(value, at);
    const samples = file.dtMs.length;
    if (file.q.length !== samples * 4) {
      fail(
        join(at, 'q'),
        `must have four numbers per sample (${String(samples * 4)}), got ${String(file.q.length)}`,
      );
    }
    if (file.v !== null && file.v.length !== samples * 3) {
      fail(
        join(at, 'v'),
        `must have three integers per sample (${String(samples * 3)}), got ${String(file.v.length)}`,
      );
    }
    return file;
  },
};

// ---- The account's cubes in Firestore (docs/DATA-MODEL.md §10, T3.4) ----

const CLOUD_CUBE = object<CloudCube>({
  schema: oneOf(1),
  name: text('a name that can name a document (no "/", neither . nor .., not __…__)', CUBE_NAME),
  mac: text('a MAC address such as AB:12:CD:34:EF:56 (upper case, colons)', MAC_ADDRESS),
  updatedMs: num({ min: 0 }),
  device: nonEmpty,
});
