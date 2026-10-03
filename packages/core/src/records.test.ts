/// <reference types="node" />
// The readers of records.ts: records of schema versions 1 and 2 come back as version 2, and the
// checks written out there accept exactly what the JSON Schemas accept, which ajv tells here, field
// by field. Node's types for this file only (node:fs, for the real-hardware exports).
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  FRAMES_SCHEMA,
  GYRO_SCHEMA,
  RecordError,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  parseAttempt,
  parseCameraInfo,
  parseFrames,
  parseGyro,
  parseSession,
  type AttemptRecord,
  type SessionRecord,
} from './index';
import {
  REMOTE_CLOCK,
  REMOTE_DEVICE,
  asVersion1Attempt,
  asVersion1Session,
  attemptWithVideo,
  dnfAttempt,
  framesJson,
  gyroJson,
  remoteFramesJson,
  sessionRecord,
  sessionWithCamera,
  solvedAttempt,
  untouchedAttempt,
} from './test-records';

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
// A gyro file has one version, 1, and a frames file one, 2: each one's schema stands for both
// entries, so that a file that says another version is refused by it as by the reader.
const isGyro = ajv.compile(GYRO_SCHEMA);
const isFrames = ajv.compile(FRAMES_SCHEMA);
const VALIDATE = {
  attempt: { 1: ajv.compile(ATTEMPT_SCHEMA_V1), 2: ajv.compile(ATTEMPT_SCHEMA) },
  session: { 1: ajv.compile(SESSION_SCHEMA_V1), 2: ajv.compile(SESSION_SCHEMA) },
  gyro: { 1: isGyro, 2: isGyro },
  frames: { 1: isFrames, 2: isFrames },
};
const PARSE = {
  attempt: parseAttempt,
  session: parseSession,
  gyro: parseGyro,
  frames: parseFrames,
};
type Kind = keyof typeof PARSE;

/**
 * The owner's exports (fixtures/hardware/), as they are: schema version 1 from round 1 (the GAN 12
 * ui on the laptop and on the phone) and schema version 2 from the i3 round (with clips).
 */
const HARDWARE = (() => {
  const folder = new URL('../../../fixtures/hardware/', import.meta.url);
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => {
      const json: unknown = JSON.parse(readFileSync(new URL(file, folder), 'utf8'));
      const session: unknown = Reflect.get(json as object, 'session');
      const attempts: unknown = Reflect.get(json as object, 'attempts');
      return {
        file,
        schema: Reflect.get(session as object, 'schema') as unknown,
        session,
        attempts: Array.isArray(attempts) ? (attempts as unknown[]) : [],
      };
    });
})();

/** The export whose file name has `name` in it. */
function hardware(name: string): (typeof HARDWARE)[number] {
  const found = HARDWARE.find(({ file }) => file.includes(name));
  if (found === undefined) {
    throw new Error(`No export of ${name} in fixtures/hardware/.`);
  }
  return found;
}

/** `record` without the fields `keys` (the ones T3.7 added, which the files written before lack). */
function without<T extends object>(record: T, ...keys: (keyof T)[]): Partial<T> {
  const copy: Partial<T> = { ...record };
  for (const key of keys) {
    Reflect.deleteProperty(copy, key);
  }
  return copy;
}

/** What ajv says of `value`: valid against the schema of the version it claims, or not, and where. */
function schemaSays(kind: Kind, value: unknown): { valid: boolean; paths: string[] } {
  const version: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'schema') : null;
  const validate = VALIDATE[kind][version === 1 ? 1 : 2];
  const valid = validate(value) && (version === 1 || version === 2);
  return { valid, paths: valid ? [] : (validate.errors ?? []).map(pathOf) };
}

/** The path of the value an ajv error is about, as a JSON pointer: the missing or extra field's too. */
function pathOf(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const key = params['missingProperty'] ?? params['additionalProperty'] ?? params['propertyName'];
  return typeof key === 'string' ? `${error.instancePath}/${key}` : error.instancePath;
}

/** A reader's field, `moves[3].m`, as a JSON pointer, `/moves/3/m`. */
function pointer(field: string): string {
  return field === ''
    ? ''
    : `/${field
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .join('/')}`;
}

/** What the reader says of `value`: accepted, or the field it names. */
function readerSays(kind: Kind, value: unknown): { valid: boolean; field?: string } {
  try {
    PARSE[kind](value);
    return { valid: true };
  } catch (error: unknown) {
    if (!(error instanceof RecordError)) {
      throw error;
    }
    expect(error.file).toBe(`${kind}.json`);
    return { valid: false, field: error.field };
  }
}

type Path = (string | number)[];

/**
 * The paths of every value in `record`, objects and arrays included, but only the first two and the
 * last item of an array.
 */
function pathsIn(value: unknown, at: Path = []): Path[] {
  if (typeof value !== 'object' || value === null) {
    return [at];
  }
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? (value as unknown[])
        .map((item, i): [number, unknown] => [i, item])
        .filter(([i], _, all) => i < 2 || i === all.length - 1)
    : Object.entries(value);
  return [at, ...entries.flatMap(([key, item]) => pathsIn(item, [...at, key]))];
}

function valueAt(record: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (node, key) => (node as Record<string | number, unknown>)[key],
    record,
  );
}

/** A copy of `record` with `value` at `path` (a root path replaces the record); undefined removes. */
function changed(record: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const copy: unknown = structuredClone(record);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (value === undefined) {
    Reflect.deleteProperty(node, last);
  } else {
    node[last] = value;
  }
  return copy;
}

/** What each value is replaced with, in turn. */
const REPLACEMENTS: unknown[] = [undefined, null, 'x', '', -1, 0, 1, 1.5, 2, true, [], {}];

const CORPUS: [Kind, string, unknown][] = [
  ['attempt', 'a solved attempt with its clips', attemptWithVideo()],
  [
    'attempt',
    'a solved attempt whose solve clip was deleted after its upload',
    changed(attemptWithVideo(), ['video', 1, 'local'], false),
  ],
  ['attempt', 'a DNF', dnfAttempt()],
  ['attempt', 'a DNF without a move', untouchedAttempt()],
  ['attempt', 'a solved attempt of version 1', asVersion1Attempt(solvedAttempt())],
  ['attempt', 'a DNF of version 1', asVersion1Attempt(dnfAttempt())],
  ['attempt', 'the first attempt on the laptop', hardware('gan12ui').attempts[0]],
  ['attempt', 'the first attempt of the i3, with its clips', hardware('gan356i3').attempts[0]],
  ['session', 'a session with cameras', sessionWithCamera()],
  ['session', 'a new session', sessionRecord()],
  [
    'session',
    "a session whose remote camera's clock was recorded for a cut before the fit converged (T4.2)",
    changed(sessionWithCamera(), ['clock', 'cameras', 'phone-rear', 'remote', 'converged'], false),
  ],
  ['session', 'a session of version 1', asVersion1Session(sessionRecord())],
  ['session', 'the session on the phone', hardware('thinkphone').session],
  ['session', 'the session of the i3, with its camera', hardware('gan356i3').session],
  ['gyro', 'a gyro file', gyroJson()],
  [
    'gyro',
    'a gyro file of a cube without velocities, truncated',
    { ...gyroJson(), v: null, truncatedStart: true },
  ],
  ['frames', 'the frames file of a clip of the host', framesJson()],
  ['frames', "the frames file of a remote camera's clip (T4.2)", remoteFramesJson()],
];

describe('parseAttempt and parseSession', () => {
  it('return a record of version 2 as it is, as a new object', () => {
    for (const record of [attemptWithVideo(), dnfAttempt(), untouchedAttempt()]) {
      const parsed = parseAttempt(structuredClone(record));
      expect(parsed).toEqual(record);
      expect(Object.keys(parsed)).toEqual(Object.keys(record));
    }
    const session = sessionWithCamera();
    const input = structuredClone(session);
    const parsed = parseSession(input);
    expect(parsed).toEqual(session);
    // Nothing is shared with the input.
    expect(parsed.cameras[0]).not.toBe(input.cameras[0]);
    expect(parsed.cameras[0].capabilities).not.toBe(input.cameras[0].capabilities);
    expect(parsed.cameras[0].capabilities['width']).not.toBe(
      input.cameras[0].capabilities['width'],
    );
    expect(parsed.clock.cameras['laptop']).not.toBe(input.clock.cameras['laptop']);
    const attempt = attemptWithVideo();
    const read = parseAttempt(attempt);
    expect(read.moves[0]).not.toBe(attempt.moves[0]);
    expect(read.video[0].crop).not.toBe(attempt.video[0].crop);
  });

  it('read a clip written before truncatedStart as one that began where asked', () => {
    const attempt = attemptWithVideo();
    expect(attempt.video.map((clip) => clip.truncatedStart)).toEqual([true, false]);
    const older = changed(
      changed(attempt, ['video', 0, 'truncatedStart'], undefined),
      ['video', 1, 'truncatedStart'],
      undefined,
    );
    expect(VALIDATE.attempt[2](older)).toBe(true);
    const read = parseAttempt(older);
    expect(read.video.map((clip) => clip.truncatedStart)).toEqual([false, false]);
    // In the order of the schema's fields, as the next save writes it.
    expect(Object.keys(read.video[0])).toEqual(Object.keys(attempt.video[0]));
  });

  it("keep a clip's local as it is written, and leave it out where it is not (T3.3)", () => {
    const attempt = attemptWithVideo();
    expect(attempt.video.every((clip) => !('local' in clip))).toBe(true);
    expect(parseAttempt(structuredClone(attempt)).video.every((clip) => !('local' in clip))).toBe(
      true,
    );
    const gone = changed(attempt, ['video', 1, 'local'], false);
    expect(VALIDATE.attempt[2](gone)).toBe(true);
    const read = parseAttempt(gone);
    expect(read.video.map((clip) => clip.local)).toEqual([undefined, false]);
    expect(read).toEqual(gone);
    // In the order of the schema's fields, last.
    expect(Object.keys(read.video[1]).at(-1)).toBe('local');
    expect(() => parseAttempt(changed(attempt, ['video', 0, 'local'], 'no'))).toThrow(
      'video[0].local must be true or false, got "no"',
    );
  });

  it('read the records written before T3.7 as ones without a build, a gyro file, resyncs, battery reports and a production date', () => {
    const attempt = attemptWithVideo();
    const before = {
      ...attempt,
      moves: attempt.moves.map(({ m, hostMs, cubeMs, phase }) => ({ m, hostMs, cubeMs, phase })),
    };
    Reflect.deleteProperty(before, 'app');
    Reflect.deleteProperty(before, 'gyro');
    Reflect.deleteProperty(before, 'resyncs');
    const read = parseAttempt(before);
    expect('app' in read).toBe(false);
    expect(read.gyro).toBeNull();
    expect(read.resyncs).toEqual([]);
    expect('serial' in read.moves[0]).toBe(false);
    expect('packetLast' in read.moves[0]).toBe(false);
    expect(Object.keys(read).slice(-3)).toEqual(['video', 'gyro', 'resyncs']);
    // Written since: every field kept as it is, in the order of the schema.
    const now = parseAttempt(attempt);
    expect(now).toEqual(attempt);
    expect(Object.keys(now)).toEqual(Object.keys(attempt));
    expect(now.moves[0]).toEqual(attempt.moves[0]);

    const session = sessionWithCamera();
    const earlier: Record<string, unknown> = { ...session, cube: { ...session.cube } };
    Reflect.deleteProperty(earlier, 'battery');
    Reflect.deleteProperty(earlier['cube'] as object, 'productDate');
    const readSession = parseSession(earlier);
    expect(readSession.battery).toEqual([]);
    expect(readSession.cube.productDate).toBeNull();
    expect(Object.keys(readSession).at(-1)).toBe('battery');
    expect(parseSession(session)).toEqual(session);
  });

  it("read a frames file as a new object, a remote camera's with its sync, and refuse a keyframe named twice or a remote field alone (T4.2)", () => {
    for (const file of [framesJson(), remoteFramesJson()]) {
      const read = parseFrames(structuredClone(file));
      expect(read).toEqual(file);
      expect(Object.keys(read)).toEqual(Object.keys(file));
      expect(read.dtMs).not.toBe(file.dtMs);
    }
    expect(() => parseFrames({ ...framesJson(), keyframes: [0, 3, 3] })).toThrow(
      'frames.json (schema 2): keyframes must name each frame once.',
    );
    const { remote, ...alone } = remoteFramesJson();
    expect(remote).toBeDefined();
    expect(() => parseFrames(alone)).toThrow(
      "frames.json (schema 2): remote is missing: a remote camera's clip has both t0RemoteMs and remote.",
    );
    expect(() => parseFrames({ ...framesJson(), schema: 1 })).toThrow(
      'frames.json: schema must be 2, got 1.',
    );
  });

  it('read a gyro file, and refuse one whose arrays do not fit its samples (beyond the schema)', () => {
    const file = gyroJson();
    expect(parseGyro(file)).toEqual(file);
    expect(parseGyro(file)).not.toBe(file);
    expect(() => parseGyro({ ...file, q: [...file.q, 0] })).toThrow(
      'gyro.json (schema 1): q must have four numbers per sample (16), got 17.',
    );
    expect(() => parseGyro({ ...file, v: file.v?.slice(1) })).toThrow(
      'gyro.json (schema 1): v must have three integers per sample (12), got 11.',
    );
    expect(() => parseGyro({ ...file, schema: 2 })).toThrow('gyro.json: schema must be 1, got 2.');
  });

  it('read a camera written before its microphone was kept as one without, in the order of the schema', () => {
    const session = sessionWithCamera();
    expect(session.cameras.map((entry) => entry.microphone?.processing ?? null)).toEqual([
      'raw',
      null,
    ]);
    const older = changed(
      changed(session, ['cameras', 0, 'microphone'], undefined),
      ['cameras', 1, 'microphone'],
      undefined,
    );
    expect(VALIDATE.session[2](older)).toBe(true);
    const read = parseSession(older);
    expect(read.cameras.map((entry) => entry.microphone)).toEqual([null, null]);
    // In the order of the schema's fields, as the next save writes it.
    expect(Object.keys(read.cameras[0])).toEqual(Object.keys(session.cameras[0]));
    // A microphone is copied, not shared with the input.
    const input = structuredClone(session);
    expect(parseSession(input).cameras[0].microphone).toEqual(input.cameras[0].microphone);
    expect(parseSession(input).cameras[0].microphone).not.toBe(input.cameras[0].microphone);
  });

  it('read a remote camera with its device and its clock sync, and refuse the device on the wrong camera (T4.0)', () => {
    const session = sessionWithCamera();
    const read = parseSession(structuredClone(session));
    expect(read.cameras[1].local).toBe(false);
    expect(read.cameras[1].remote).toEqual(REMOTE_DEVICE);
    expect(read.cameras[1].remote).not.toBe(session.cameras[1].remote);
    expect(read.clock.cameras['phone-rear'].remote).toEqual(REMOTE_CLOCK);
    expect(read.clock.cameras['phone-rear'].remote).not.toBe(
      session.clock.cameras['phone-rear'].remote,
    );
    // The host's own camera has neither, and the keys stay in the schema's order.
    expect('remote' in read.cameras[0]).toBe(false);
    expect('remote' in read.clock.cameras['laptop']).toBe(false);
    expect(Object.keys(read.cameras[1]).at(-1)).toBe('remote');
    expect(Object.keys(read.clock.cameras['phone-rear']).at(-1)).toBe('remote');
    // A remote camera names its device; a local one has none to name.
    const headless = changed(session, ['cameras', 1, 'remote'], undefined);
    expect(VALIDATE.session[2](headless)).toBe(false);
    expect(() => parseSession(headless)).toThrow(
      'session.json (schema 2): cameras[1].remote is missing: a remote camera names its device.',
    );
    const confused = changed(session, ['cameras', 0, 'remote'], REMOTE_DEVICE);
    expect(VALIDATE.session[2](confused)).toBe(false);
    expect(() => parseSession(confused)).toThrow(
      "session.json (schema 2): cameras[0].remote must not be there: the host's own camera has no remote device.",
    );
    expect(() => parseSession(changed(session, ['cameras', 1, 'remote', 'platform'], 1))).toThrow(
      'session.json (schema 2): cameras[1].remote.platform must be a string, got 1.',
    );
    expect(() =>
      parseSession(changed(session, ['clock', 'cameras', 'phone-rear', 'remote', 'samples'], -1)),
    ).toThrow('clock.cameras.phone-rear.remote.samples must be an integer ≥ 0, got -1.');
    // The same checks on a camera alone, as a remote camera's hello sends it (docs/RTC.md).
    expect(parseCameraInfo(structuredClone(session.cameras[1]))).toEqual(session.cameras[1]);
    expect(parseCameraInfo(session.cameras[0])).toEqual(session.cameras[0]);
    expect(() => parseCameraInfo({ ...session.cameras[1], remote: undefined })).toThrow(
      'session.json (schema 2): camera.remote is missing: a remote camera names its device.',
    );
    expect(() => parseCameraInfo('laptop')).toThrow(
      'session.json (schema 2): camera must be an object, got "laptop".',
    );
    expect(() => parseCameraInfo({ ...session.cameras[0], label: 'Laptop' })).toThrow(RecordError);
  });

  it('upgrade a record of version 1 in memory: no clock, no clip, no camera, none of T3.7', () => {
    for (const record of [solvedAttempt(), dnfAttempt(), untouchedAttempt()]) {
      const v1 = asVersion1Attempt(record);
      const before = JSON.stringify(v1);
      const parsed = parseAttempt(v1);
      // Version 1 kept no build and no move counters; the gyro file and the resyncs read as none.
      expect(parsed).toEqual({
        ...without(record, 'app'),
        moves: record.moves.map((move) => without(move, 'serial', 'packetLast')),
        clock: null,
        gyro: null,
        resyncs: [],
      });
      expect(JSON.stringify(v1)).toBe(before);
      // In the order of the schema, as the next save writes it.
      expect(Object.keys(parsed)).toEqual([
        ...(ATTEMPT_SCHEMA['required'] as string[]),
        'gyro',
        'resyncs',
      ]);
      expect(VALIDATE.attempt[2](parsed)).toBe(true);
    }
    const parsed = parseSession(asVersion1Session(sessionRecord()));
    expect(parsed).toEqual(sessionRecord());
    expect(Object.keys(parsed)).toEqual([...(SESSION_SCHEMA['required'] as string[]), 'battery']);
  });

  it('read the real-hardware exports of version 1, which upgrade to valid records of version 2', () => {
    const round1 = HARDWARE.filter(({ schema }) => schema === 1);
    expect(round1.map(({ attempts }) => attempts.length)).toEqual([12, 3]);
    for (const { file, session, attempts } of round1) {
      expect(VALIDATE.session[1](session), file).toBe(true);
      const s = parseSession(session);
      expect(VALIDATE.session[2](s), JSON.stringify(VALIDATE.session[2].errors)).toBe(true);
      expect(s).toMatchObject({ schema: 2, cameras: [], clock: { cameras: {} } });
      expect(s.clock.cube).toEqual(
        Reflect.get(Reflect.get(session as object, 'clock') as object, 'cube'),
      );
      for (const [k, attempt] of attempts.entries()) {
        const at = `${file} attempts[${String(k)}]`;
        expect(VALIDATE.attempt[1](attempt), at).toBe(true);
        const a = parseAttempt(attempt);
        expect(VALIDATE.attempt[2](a), JSON.stringify(VALIDATE.attempt[2].errors)).toBe(true);
        expect(a, at).toMatchObject({
          schema: 2,
          session: s.id,
          clock: null,
          video: [],
          gyro: null,
          resyncs: [],
        });
        expect(
          { ...a, schema: 1, clock: undefined, gyro: undefined, resyncs: undefined },
          at,
        ).toEqual(attempt);
      }
    }
  });

  it('read the real-hardware export of version 2 as it is: a camera, a fit and the clips of each attempt', () => {
    const i3 = HARDWARE.filter(({ schema }) => schema === 2);
    expect(i3.map(({ file, attempts }) => [file, attempts.length])).toEqual([
      ['2026-09-27-macbook-pro-2021-gan356i3.json', 6],
    ]);
    for (const { file, session, attempts } of i3) {
      expect(VALIDATE.session[2](session), JSON.stringify(VALIDATE.session[2].errors)).toBe(true);
      const s = parseSession(session);
      // Written before the microphone was kept (T2.12), its camera reads as having none; before
      // T3.7, its cube's production date reads as null and its battery reports as none.
      const written = session as SessionRecord;
      expect(s, file).toEqual({
        ...written,
        cube: { ...written.cube, productDate: null },
        cameras: written.cameras.map((entry) => ({ ...entry, microphone: null })),
        battery: [],
      });
      expect(s.cameras.map(({ label }) => label)).toEqual(['laptop']);
      // Attempt 6's scramble clip was refused on the day (its start was older than the buffer, issue
      // #34), and the session's notes say so.
      expect(s.notes).toMatch(/^clip failed: scramble of attempt 6: /);
      for (const [k, attempt] of attempts.entries()) {
        const at = `${file} attempts[${String(k)}]`;
        expect(VALIDATE.attempt[2](attempt), JSON.stringify(VALIDATE.attempt[2].errors)).toBe(true);
        const a = parseAttempt(attempt);
        // Written before truncatedStart existed (T2.9), its clips read as begun where asked;
        // before T3.7, its gyro file reads as none and its resyncs as none.
        const raw = attempt as AttemptRecord;
        expect(a, at).toEqual({
          ...raw,
          video: raw.video.map((clip) => ({ ...clip, truncatedStart: false })),
          gyro: null,
          resyncs: [],
        });
        expect(a.session, at).toBe(s.id);
        expect(a.clock, at).not.toBeNull();
        expect(
          a.video.map(({ camera, segment }) => `${camera} ${segment}`),
          at,
        ).toEqual(a.index === 6 ? ['laptop solve'] : ['laptop scramble', 'laptop solve']);
      }
    }
  });

  const attempt = attemptWithVideo();
  const session = sessionWithCamera();

  it.each([
    ['text', 'attempt', 'text', `attempt.json must be an object, got "text".`],
    ['a list', 'attempt', [attempt], 'attempt.json must be an object, got an array.'],
    [
      'no schema',
      'attempt',
      changed(attempt, ['schema'], undefined),
      'attempt.json: schema must be 1 or 2, got nothing.',
    ],
    [
      'schema 3',
      'attempt',
      changed(attempt, ['schema'], 3),
      'attempt.json: schema must be 1 or 2, got 3.',
    ],
    [
      'schema "2"',
      'session',
      changed(session, ['schema'], '2'),
      'session.json: schema must be 1 or 2, got "2".',
    ],
    [
      'a slice move',
      'attempt',
      changed(attempt, ['moves', 3, 'm'], 'M'),
      `attempt.json (schema 2): moves[3].m must be a face turn such as R, U' or F2, got "M".`,
    ],
    [
      'no clock',
      'attempt',
      changed(attempt, ['clock'], undefined),
      'attempt.json (schema 2): clock is missing.',
    ],
    [
      'a clock of version 2 in version 1',
      'attempt',
      { ...asVersion1Attempt(solvedAttempt()), clock: null },
      'attempt.json (schema 1): clock is not a known field.',
    ],
    [
      'a clock of one sample',
      'attempt',
      changed(attempt, ['clock', 'samples'], 1),
      'attempt.json (schema 2): clock.samples must be an integer ≥ 2, got 1.',
    ],
    [
      'a clock that is text',
      'attempt',
      changed(attempt, ['clock'], 'x'),
      'attempt.json (schema 2): clock must be an object or null, got "x".',
    ],
    [
      'a slot on the cross',
      'attempt',
      changed(attempt, ['phases', 0, 'slot'], 'FR'),
      'attempt.json (schema 2): phases[0].slot must not be there: only the f2l phases have a slot.',
    ],
    [
      'an f2l phase without its slot',
      'attempt',
      changed(attempt, ['phases', 2, 'slot'], undefined),
      'attempt.json (schema 2): phases[2].slot is missing: f2l2 names its slot.',
    ],
    [
      'a clip in another folder',
      'attempt',
      changed(attempt, ['video', 1, 'file'], '../laptop.solve.mp4'),
      'attempt.json (schema 2): video[1].file must be <camera>.<segment>.mp4, got "../laptop.solve.mp4".',
    ],
    [
      'a clip in version 1',
      'attempt',
      changed(asVersion1Attempt(solvedAttempt()), ['video'], [attempt.video[0]]),
      'attempt.json (schema 1): video must be empty, got 1 item.',
    ],
    [
      'a camera label with a capital',
      'session',
      changed(session, ['cameras', 0, 'label'], 'Laptop'),
      'session.json (schema 2): cameras[0].label must be a camera label: lowercase letters and digits in words joined by hyphens, got "Laptop".',
    ],
    [
      'a camera clock under another label',
      'session',
      changed(session, ['clock', 'cameras', 'Phone 1'], session.clock.cameras['laptop']),
      'session.json (schema 2): clock.cameras.Phone 1 is not a camera label: lowercase letters and digits in words joined by hyphens.',
    ],
    [
      'a negative round trip',
      'session',
      changed(session, ['clock', 'cameras', 'laptop', 'rttMs'], -1),
      'session.json (schema 2): clock.cameras.laptop.rttMs must be a number ≥ 0, got -1.',
    ],
    [
      'a microphone that was asked for loud',
      'session',
      changed(session, ['cameras', 0, 'microphone', 'processing'], 'loud'),
      'session.json (schema 2): cameras[0].microphone.processing must be one of "raw", "voice", got "loud".',
    ],
    [
      'a microphone that reports echo cancellation as text',
      'session',
      changed(session, ['cameras', 0, 'microphone', 'echoCancellation'], 'remote-only'),
      'session.json (schema 2): cameras[0].microphone.echoCancellation must be true or false or null, got "remote-only".',
    ],
    [
      'a microphone of half a channel',
      'session',
      changed(session, ['cameras', 0, 'microphone', 'channelCount'], 1.5),
      'session.json (schema 2): cameras[0].microphone.channelCount must be an integer ≥ 1 or null, got 1.5.',
    ],
    [
      'a microphone that is text',
      'session',
      changed(session, ['cameras', 1, 'microphone'], 'raw'),
      'session.json (schema 2): cameras[1].microphone must be an object or null, got "raw".',
    ],
    [
      'a camera in version 1',
      'session',
      changed(asVersion1Session(sessionRecord()), ['cameras'], session.cameras),
      'session.json (schema 1): cameras must be empty, got 2 items.',
    ],
    [
      'fractional attempts',
      'session',
      changed(session, ['summary', 'attempts'], 0.5),
      'session.json (schema 2): summary.attempts must be an integer ≥ 0, got 0.5.',
    ],
  ] as [string, Kind, unknown, string][])(
    'throw on %s, naming the field',
    (_, kind, value, message) => {
      expect(() => PARSE[kind](value)).toThrow(RecordError);
      expect(() => PARSE[kind](value)).toThrow(message);
    },
  );

  it('say what is wrong with the field apart from the file', () => {
    try {
      parseSession(changed(session, ['clock', 'cameras', 'laptop', 'rttMs'], -1));
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toMatchObject({
        name: 'RecordError',
        file: 'session.json',
        version: 2,
        field: 'clock.cameras.laptop.rttMs',
        problem: 'must be a number ≥ 0, got -1',
        detail: 'clock.cameras.laptop.rttMs must be a number ≥ 0, got -1',
      });
    }
  });

  it.each(CORPUS)(
    'accept exactly what the schemas accept: %s, every field changed in turn',
    (kind, _, record) => {
      expect(schemaSays(kind, record).valid).toBe(true);
      expect(readerSays(kind, record).valid).toBe(true);
      let rejected = 0;
      const mismatches: string[] = [];
      for (const path of pathsIn(record)) {
        const here = valueAt(record, path);
        const isObject = typeof here === 'object' && here !== null && !Array.isArray(here);
        const variants: [Path, unknown][] = [
          ...REPLACEMENTS.map((value): [Path, unknown] => [path, value]),
          // A field that no version has.
          ...(isObject ? [[[...path, 'zz'], 1] as [Path, unknown]] : []),
        ];
        for (const [where, value] of variants) {
          const mutated = changed(record, where, value);
          const schema = schemaSays(kind, mutated);
          const reader = readerSays(kind, mutated);
          const what = `${where.join('.')} = ${value === undefined ? 'removed' : JSON.stringify(value)}`;
          if (schema.valid !== reader.valid) {
            mismatches.push(`${what}: the schema says ${String(schema.valid)}`);
          } else if (!reader.valid) {
            rejected++;
            // The field the reader names is one ajv names, or inside one.
            const field = pointer(reader.field ?? '');
            if (!schema.paths.some((p) => field === p || field.startsWith(`${p}/`))) {
              mismatches.push(`${what}: the reader names ${field}, ajv ${schema.paths.join(' ')}`);
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(rejected).toBeGreaterThan(50);
    },
  );
});
