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
  RecordError,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  parseAttempt,
  parseSession,
} from './index';
import {
  asVersion1Attempt,
  asVersion1Session,
  attemptWithVideo,
  dnfAttempt,
  sessionRecord,
  sessionWithCamera,
  solvedAttempt,
  untouchedAttempt,
} from './test-records';

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const VALIDATE = {
  attempt: { 1: ajv.compile(ATTEMPT_SCHEMA_V1), 2: ajv.compile(ATTEMPT_SCHEMA) },
  session: { 1: ajv.compile(SESSION_SCHEMA_V1), 2: ajv.compile(SESSION_SCHEMA) },
};
const PARSE = { attempt: parseAttempt, session: parseSession };
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
  ['attempt', 'a DNF', dnfAttempt()],
  ['attempt', 'a DNF without a move', untouchedAttempt()],
  ['attempt', 'a solved attempt of version 1', asVersion1Attempt(solvedAttempt())],
  ['attempt', 'a DNF of version 1', asVersion1Attempt(dnfAttempt())],
  ['attempt', 'the first attempt on the laptop', hardware('gan12ui').attempts[0]],
  ['attempt', 'the first attempt of the i3, with its clips', hardware('gan356i3').attempts[0]],
  ['session', 'a session with cameras', sessionWithCamera()],
  ['session', 'a new session', sessionRecord()],
  ['session', 'a session of version 1', asVersion1Session(sessionRecord())],
  ['session', 'the session on the phone', hardware('thinkphone').session],
  ['session', 'the session of the i3, with its camera', hardware('gan356i3').session],
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

  it('upgrade a record of version 1 in memory: no clock, no clip, no camera', () => {
    for (const record of [solvedAttempt(), dnfAttempt(), untouchedAttempt()]) {
      const v1 = asVersion1Attempt(record);
      const before = JSON.stringify(v1);
      const parsed = parseAttempt(v1);
      expect(parsed).toEqual({ ...record, clock: null });
      expect(JSON.stringify(v1)).toBe(before);
      // In the order of the schema, as the next save writes it.
      expect(Object.keys(parsed)).toEqual(ATTEMPT_SCHEMA['required']);
      expect(VALIDATE.attempt[2](parsed)).toBe(true);
    }
    const parsed = parseSession(asVersion1Session(sessionRecord()));
    expect(parsed).toEqual(sessionRecord());
    expect(Object.keys(parsed)).toEqual(SESSION_SCHEMA['required']);
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
        expect(a, at).toMatchObject({ schema: 2, session: s.id, clock: null, video: [] });
        expect({ ...a, schema: 1, clock: undefined }, at).toEqual(attempt);
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
      expect(s, file).toEqual(session);
      expect(s.cameras.map(({ label }) => label)).toEqual(['laptop']);
      // Attempt 6's scramble clip was refused on the day (its start was older than the buffer, issue
      // #34), and the session's notes say so.
      expect(s.notes).toMatch(/^clip failed: scramble of attempt 6: /);
      for (const [k, attempt] of attempts.entries()) {
        const at = `${file} attempts[${String(k)}]`;
        expect(VALIDATE.attempt[2](attempt), JSON.stringify(VALIDATE.attempt[2].errors)).toBe(true);
        const a = parseAttempt(attempt);
        expect(a, at).toEqual(attempt);
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
