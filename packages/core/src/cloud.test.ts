import { Ajv2020, type ErrorObject } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { CloudAttempt, CloudSession, JsonSchema } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  FRAMES_SCHEMA,
  RecordError,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  USER_SCHEMA,
  attemptDocumentId,
  attemptFiles,
  cloudAttempt,
  cloudSession,
  isSimulated,
  parseCloudAttempt,
  parseCloudSession,
  pendingUpload,
  sessionOfDocument,
} from './index';
import {
  attemptWithVideo,
  dnfAttempt,
  sessionRecord,
  sessionWithCamera,
  solvedAttempt,
  untouchedAttempt,
} from './test-records';

// The documents of the session index in Firestore (docs/DATA-MODEL.md §10, docs/PLAN.md T3.1): what
// the builders write, their JSON Schemas (which must keep the record schemas' fields as they are),
// and the readers the app reads them back with, held to the schemas field by field as records.test.ts
// holds the records' readers.

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isCloudSession = ajv.compile<CloudSession>(CLOUD_SESSION_SCHEMA);
const isCloudAttempt = ajv.compile<CloudAttempt>(CLOUD_ATTEMPT_SCHEMA);

const OWNER = 'ada-uid';

/** The laptop's session with its two cameras, as the index writes it. */
function sessionDocument(): CloudSession {
  return cloudSession(sessionWithCamera(), OWNER);
}

/** The solved attempt with its two clips, as the index writes it, its files' sizes known. */
function attemptDocument(): CloudAttempt {
  const attempt = attemptWithVideo();
  return cloudAttempt({
    attempt,
    session: sessionWithCamera(),
    owner: OWNER,
    upload: pendingUpload({
      'attempt.json': 6_100,
      'laptop.scramble.mp4': 4_412_345,
      'laptop.scramble.frames.json': 2_048,
      'laptop.solve.mp4': 4_412_345,
      'laptop.solve.frames.json': 2_210,
    }),
  });
}

describe('the documents of the session index', () => {
  it('copy session.json with its owner, sharing nothing with the record', () => {
    const session = sessionWithCamera();
    const document = cloudSession(session, OWNER);
    expect(document).toEqual({ ...session, owner: OWNER });
    expect(document.cameras[0]).not.toBe(session.cameras[0]);
    expect(document.clock.cameras['laptop']).not.toBe(session.clock.cameras['laptop']);
    expect(sessionOfDocument(document)).toEqual(session);
    expect('owner' in sessionOfDocument(document)).toBe(false);
  });

  it('copy attempt.json without its moves, with its owner, its device and its upload', () => {
    const attempt = attemptWithVideo();
    const document = attemptDocument();
    expect('moves' in document).toBe(false);
    const { owner, device, upload, ...rest } = document;
    expect({ ...rest, moves: attempt.moves }).toEqual(attempt);
    expect(owner).toBe(OWNER);
    // The session's host label and its cameras' labels, in their order.
    expect(device).toEqual({ host: 'laptop', cameras: ['laptop', 'phone-rear'] });
    expect(upload.state).toBe('pending');
    expect(upload.files['laptop.solve.mp4']).toEqual({ bytes: 4_412_345, doneMs: null });
    expect(document.video[0]).not.toBe(attempt.video[0]);
  });

  it('name an attempt by its index zero-padded as its folder, so that they sort by index', () => {
    expect([1, 17, 9999, 12_345].map(attemptDocumentId)).toEqual(['0001', '0017', '9999', '12345']);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => attemptDocumentId(bad)).toThrow(RangeError);
    }
  });

  it("list an attempt's files: attempt.json, then each clip's MP4 and frames file", () => {
    expect(attemptFiles(attemptWithVideo())).toEqual([
      'attempt.json',
      'laptop.scramble.mp4',
      'laptop.scramble.frames.json',
      'laptop.solve.mp4',
      'laptop.solve.frames.json',
    ]);
    expect(attemptFiles(dnfAttempt())).toEqual(['attempt.json']);
    expect(pendingUpload({ 'attempt.json': 10 })).toEqual({
      state: 'pending',
      files: { 'attempt.json': { bytes: 10, doneMs: null } },
    });
  });

  it('tell a demo session by its simulated cube', () => {
    const session = sessionRecord();
    expect(isSimulated(session)).toBe(false);
    expect(isSimulated({ ...session, cube: { ...session.cube, hardware: 'simulated' } })).toBe(
      true,
    );
  });
});

describe('the JSON Schemas of the documents', () => {
  const RECORDS: [string, JsonSchema][] = [
    ['session.json', SESSION_SCHEMA],
    ['attempt.json', ATTEMPT_SCHEMA],
    ['session.json version 1', SESSION_SCHEMA_V1],
    ['attempt.json version 1', ATTEMPT_SCHEMA_V1],
    ['frames.json', FRAMES_SCHEMA],
    ['users/{uid}', USER_SCHEMA],
  ];

  it.each([
    ['sessions/{id}', CLOUD_SESSION_SCHEMA, /\/cloud-session\.schema\.json$/],
    ['sessions/{id}/attempts/{index}', CLOUD_ATTEMPT_SCHEMA, /\/cloud-attempt\.schema\.json$/],
  ] as [string, JsonSchema, RegExp][])(
    'the schema of %s is draft 2020-12, compiles without a warning and has an $id of its own',
    (title, schema, id) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        new Ajv2020({ allowUnionTypes: true }).compile(schema);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema['title']).toBe(title);
      expect(schema['$id']).toMatch(id);
      expect(RECORDS.map(([, other]) => other['$id'])).not.toContain(schema['$id']);
    },
  );

  it("keep the records' fields and definitions as the record schemas have them", () => {
    const session = SESSION_SCHEMA as Readonly<Record<string, Record<string, unknown>>>;
    const cloud = CLOUD_SESSION_SCHEMA as Readonly<Record<string, Record<string, unknown>>>;
    expect(cloud['properties']).toEqual({
      ...session['properties'],
      owner: cloud['properties']['owner'],
    });
    expect(cloud['$defs']).toEqual(session['$defs']);
    expect(CLOUD_SESSION_SCHEMA['required']).toEqual([
      ...(SESSION_SCHEMA['required'] as string[]),
      'owner',
    ]);

    const attempt = ATTEMPT_SCHEMA as Readonly<Record<string, Record<string, unknown>>>;
    const document = CLOUD_ATTEMPT_SCHEMA as Readonly<Record<string, Record<string, unknown>>>;
    const kept = Object.entries(attempt['properties']).filter(([field]) => field !== 'moves');
    for (const [field, rule] of kept) {
      expect(document['properties'][field], field).toEqual(rule);
    }
    expect(Object.keys(document['properties'])).toEqual([
      ...kept.map(([field]) => field),
      'owner',
      'device',
      'upload',
    ]);
    for (const [name, rule] of Object.entries(attempt['$defs']).filter(([n]) => n !== 'move')) {
      expect(document['$defs'][name], name).toEqual(rule);
    }
    expect(Object.keys(document['$defs'])).not.toContain('move');
    expect(CLOUD_ATTEMPT_SCHEMA['required']).toEqual([
      ...(ATTEMPT_SCHEMA['required'] as string[]).filter((field) => field !== 'moves'),
      'owner',
      'device',
      'upload',
    ]);
  });

  it('accept what the index writes: sessions with and without cameras, attempts solved, DNF and untouched', () => {
    for (const session of [sessionRecord(), sessionWithCamera()]) {
      const document = cloudSession(session, OWNER);
      expect(isCloudSession(document), JSON.stringify(isCloudSession.errors)).toBe(true);
    }
    for (const attempt of [attemptWithVideo(), solvedAttempt(), dnfAttempt(), untouchedAttempt()]) {
      const document = cloudAttempt({
        attempt,
        session: sessionRecord(),
        owner: OWNER,
        upload: pendingUpload({ 'attempt.json': 4_000 }),
      });
      expect(isCloudAttempt(document), JSON.stringify(isCloudAttempt.errors)).toBe(true);
      expect(document.device).toEqual({ host: 'laptop', cameras: [] });
    }
  });

  it('accept an upload under way, done or failed, with the times of the files confirmed', () => {
    const document = attemptDocument();
    for (const state of ['uploading', 'done', 'failed']) {
      const upload = {
        state,
        files: { ...document.upload.files, 'attempt.json': { bytes: 6_100, doneMs: 1.79e12 } },
      };
      expect(isCloudAttempt({ ...document, upload }), state).toBe(true);
    }
  });

  it.each([
    ['no owner', 'session', { owner: undefined }],
    ['an empty owner', 'session', { owner: '' }],
    ['an owner that is a number', 'session', { owner: 42 }],
    ['schema version 1', 'session', { schema: 1 }],
    ['an unknown field', 'session', { syncedMs: 1 }],
    ['moves', 'attempt', { moves: [] }],
    ['no owner', 'attempt', { owner: undefined }],
    ['no device', 'attempt', { device: undefined }],
    ['a device without its cameras', 'attempt', { device: { host: 'laptop' } }],
    ['a camera label with a capital', 'attempt', { device: { host: 'x', cameras: ['Laptop'] } }],
    ['no upload', 'attempt', { upload: undefined }],
    ['an upload of another state', 'attempt', { upload: { state: 'queued', files: {} } }],
    ['an upload without its files', 'attempt', { upload: { state: 'pending' } }],
    [
      'a file outside the folder',
      'attempt',
      { upload: { state: 'pending', files: { '../a.mp4': { bytes: 1, doneMs: null } } } },
    ],
    [
      'a file that is not one of an attempt',
      'attempt',
      { upload: { state: 'pending', files: { 'laptop.solve.webm': { bytes: 1, doneMs: null } } } },
    ],
    [
      'an empty file',
      'attempt',
      { upload: { state: 'pending', files: { 'attempt.json': { bytes: 0, doneMs: null } } } },
    ],
    [
      'a file without its time',
      'attempt',
      { upload: { state: 'pending', files: { 'attempt.json': { bytes: 1 } } } },
    ],
    ['schema version 3', 'attempt', { schema: 3 }],
  ] as [string, 'session' | 'attempt', Record<string, unknown>][])(
    'refuse a document with %s (%s)',
    (_, kind, change) => {
      const document: Record<string, unknown> =
        kind === 'session' ? { ...sessionDocument() } : { ...attemptDocument() };
      for (const [field, value] of Object.entries(change)) {
        if (value === undefined) {
          Reflect.deleteProperty(document, field);
        } else {
          document[field] = value;
        }
      }
      const validate = kind === 'session' ? isCloudSession : isCloudAttempt;
      expect(validate(document)).toBe(false);
      const parse = kind === 'session' ? parseCloudSession : parseCloudAttempt;
      expect(() => parse(document)).toThrow(RecordError);
    },
  );
});

type Kind = 'session' | 'attempt';
type Path = (string | number)[];

const PARSE: Readonly<Record<Kind, (json: unknown) => unknown>> = {
  session: parseCloudSession,
  attempt: parseCloudAttempt,
};
const VALIDATE = { session: isCloudSession, attempt: isCloudAttempt };
const FILE: Readonly<Record<Kind, string>> = {
  session: 'sessions/{id}',
  attempt: 'sessions/{id}/attempts/{index}',
};

/**
 * What ajv says of `value`, and the paths of its errors as the readers write a field (`video[1].file`,
 * `upload.files.attempt.json.bytes`): the file names of an upload have dots in them, so the readers'
 * fields are compared in their own notation rather than as JSON pointers.
 */
function schemaSays(kind: Kind, value: unknown): { valid: boolean; paths: string[] } {
  const validate = VALIDATE[kind];
  const valid = validate(value);
  return { valid, paths: valid ? [] : (validate.errors ?? []).map(pathOf) };
}

function pathOf(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const key = params['missingProperty'] ?? params['additionalProperty'] ?? params['propertyName'];
  const pointer = typeof key === 'string' ? `${error.instancePath}/${key}` : error.instancePath;
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce(
      (at, part) => (/^\d+$/.test(part) ? `${at}[${part}]` : at === '' ? part : `${at}.${part}`),
      '',
    );
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
    expect(error.file).toBe(FILE[kind]);
    return { valid: false, field: error.field };
  }
}

/** Every path in `value`, but only the first two and the last item of an array. */
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

/** A copy of `record` with `value` at `path`; undefined removes it. */
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

const REPLACEMENTS: unknown[] = [undefined, null, 'x', '', -1, 0, 1, 1.5, 2, true, [], {}];

describe('parseCloudSession and parseCloudAttempt', () => {
  it('return what the index writes as it is, as new objects', () => {
    const session = sessionDocument();
    const read = parseCloudSession(structuredClone(session));
    expect(read).toEqual(session);
    expect(Object.keys(read)).toEqual(CLOUD_SESSION_SCHEMA['required']);
    const attempt = attemptDocument();
    const input = structuredClone(attempt);
    const parsed = parseCloudAttempt(input);
    expect(parsed).toEqual(attempt);
    expect(Object.keys(parsed)).toEqual(CLOUD_ATTEMPT_SCHEMA['required']);
    expect(parsed.upload.files).not.toBe(input.upload.files);
    expect(parsed.device.cameras).not.toBe(input.device.cameras);
  });

  it.each([
    ['text', 'session', 'x', 'sessions/{id} must be an object, got "x".'],
    [
      'schema 1',
      'session',
      { ...sessionDocument(), schema: 1 },
      'sessions/{id}: schema must be 2, got 1.',
    ],
    [
      'no owner',
      'session',
      changed(sessionDocument(), ['owner'], undefined),
      'sessions/{id} (schema 2): owner is missing.',
    ],
    [
      'moves',
      'attempt',
      { ...attemptDocument(), moves: [] },
      'sessions/{id}/attempts/{index} (schema 2): moves is not a known field.',
    ],
    [
      'an upload of another state',
      'attempt',
      changed(attemptDocument(), ['upload', 'state'], 'queued'),
      'sessions/{id}/attempts/{index} (schema 2): upload.state must be one of "pending", "uploading", "done", "failed", got "queued".',
    ],
    [
      'a file outside the folder',
      'attempt',
      changed(attemptDocument(), ['upload', 'files', '../x.mp4'], { bytes: 1, doneMs: null }),
      'sessions/{id}/attempts/{index} (schema 2): upload.files.../x.mp4 is not attempt.json, <camera>.<segment>.mp4 or <camera>.<segment>.frames.json.',
    ],
  ] as [string, Kind, unknown, string][])(
    'throw on %s, naming the field',
    (_, kind, value, message) => {
      expect(() => PARSE[kind](value)).toThrow(message);
    },
  );

  it.each([
    ['session', 'a session with cameras', sessionDocument()],
    ['session', 'a new session', cloudSession(sessionRecord(), OWNER)],
    ['attempt', 'a solved attempt with its clips', attemptDocument()],
    [
      'attempt',
      'a DNF without a move',
      cloudAttempt({
        attempt: untouchedAttempt(),
        session: sessionRecord(),
        owner: OWNER,
        upload: pendingUpload({ 'attempt.json': 3_000 }),
      }),
    ],
  ] as [Kind, string, unknown][])(
    'accept exactly what the schemas accept: %s, %s, every field changed in turn',
    (kind, _, record) => {
      expect(schemaSays(kind, record).valid).toBe(true);
      expect(readerSays(kind, record).valid).toBe(true);
      let rejected = 0;
      const mismatches: string[] = [];
      for (const path of pathsIn(record)) {
        const here = path.reduce<unknown>(
          (node, key) => (node as Record<string | number, unknown>)[key],
          record,
        );
        const isObject = typeof here === 'object' && here !== null && !Array.isArray(here);
        const variants: [Path, unknown][] = [
          ...REPLACEMENTS.map((value): [Path, unknown] => [path, value]),
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
            const field = reader.field ?? '';
            const inside = (p: string): boolean =>
              p === '' || field === p || field.startsWith(`${p}.`) || field.startsWith(`${p}[`);
            if (!schema.paths.some(inside)) {
              mismatches.push(`${what}: the reader names ${field}, ajv ${schema.paths.join(' ')}`);
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(rejected).toBeGreaterThan(30);
    },
  );
});
