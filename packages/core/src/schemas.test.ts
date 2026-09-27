import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { JsonSchema } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  FRAMES_SCHEMA,
  PHASE_NAMES,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
} from './index';
import {
  asVersion1Attempt,
  asVersion1Session,
  attemptWithVideo,
  dnfAttempt,
  framesJson,
  sessionRecord,
  sessionWithCamera,
  solvedAttempt,
  untouchedAttempt,
} from './test-records';

function newAjv(): Ajv2020 {
  return new Ajv2020({ allowUnionTypes: true, allErrors: true });
}

/** A copy of `record` with the value at `path` replaced, or removed when `value` is undefined. */
function changed(record: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const copy: unknown = structuredClone(record);
  let node = copy;
  for (const key of path.slice(0, -1)) {
    node = (node as Record<string | number, unknown>)[key];
  }
  const parent = node as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (value === undefined) {
    Reflect.deleteProperty(parent, last);
  } else {
    parent[last] = value;
  }
  return copy;
}

interface ObjectSchema {
  at: string;
  node: Record<string, unknown>;
}

/** Every subschema whose type is object (or object or null), with its path. */
function objectSchemas(schema: unknown, at = '#'): ObjectSchema[] {
  if (typeof schema !== 'object' || schema === null) {
    return [];
  }
  const node = schema as Record<string, unknown>;
  const type = node['type'];
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'));
  const own = isObject ? [{ at, node }] : [];
  return [
    ...own,
    ...Object.entries(node).flatMap(([key, child]) => objectSchemas(child, `${at}/${key}`)),
  ];
}

const SCHEMAS: [string, JsonSchema][] = [
  ['session.json version 2', SESSION_SCHEMA],
  ['attempt.json version 2', ATTEMPT_SCHEMA],
  ['session.json version 1', SESSION_SCHEMA_V1],
  ['attempt.json version 1', ATTEMPT_SCHEMA_V1],
  ['frames.json', FRAMES_SCHEMA],
];

/** The objects that are not closed records: browser snapshots, and camera clocks by label. */
const SNAPSHOTS = /\/\$defs\/camera\/properties\/(settings|capabilities|constraints)$/;
const BY_LABEL = '#/properties/clock/properties/cameras';
/** The only fields that may be absent: a phase's slot, a camera clock's samples. */
const OPTIONAL: Readonly<Record<string, string>> = {
  '#/$defs/phase': 'slot',
  '#/$defs/cameraClock': 'samples',
};

describe('the JSON Schemas of the records', () => {
  it.each(SCHEMAS)(
    'the schema of %s is draft 2020-12 and compiles in ajv without a warning',
    (_, schema) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        newAjv().compile(schema);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    },
  );

  it('gives every schema its own $id, so that one ajv instance compiles them all', () => {
    const ids = SCHEMAS.map(([, schema]) => schema['$id']);
    expect(new Set(ids).size).toBe(SCHEMAS.length);
    const ajv = newAjv();
    for (const [, schema] of SCHEMAS) {
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it.each([
    ['session.json version 2', SESSION_SCHEMA, 16],
    ['attempt.json version 2', ATTEMPT_SCHEMA, 8],
    ['session.json version 1', SESSION_SCHEMA_V1, 9],
    ['attempt.json version 1', ATTEMPT_SCHEMA_V1, 5],
    ['frames.json', FRAMES_SCHEMA, 2],
  ] as [string, JsonSchema, number][])(
    'the schema of %s closes every record and requires every field but a slot and samples',
    (_, schema, count) => {
      const objects = objectSchemas(schema);
      expect(objects).toHaveLength(count);
      for (const { at, node } of objects) {
        if (SNAPSHOTS.test(at)) {
          // What the browser reports, as it is: any keys.
          expect(Object.keys(node).sort(), at).toEqual(['description', 'type']);
        } else if (at === BY_LABEL && schema === SESSION_SCHEMA) {
          expect(node['propertyNames'], at).toEqual({ $ref: '#/$defs/cameraLabel' });
          expect(node['additionalProperties'], at).toEqual({ $ref: '#/$defs/cameraClock' });
        } else {
          expect(node['additionalProperties'], at).toBe(false);
          const properties = Object.keys(node['properties'] ?? {}).filter(
            (k) => OPTIONAL[at] !== k,
          );
          const required = (node['required'] ?? []) as string[];
          expect([...required].sort(), at).toEqual(properties.sort());
        }
      }
    },
  );

  it.each([
    ['2', ATTEMPT_SCHEMA],
    ['1', ATTEMPT_SCHEMA_V1],
  ] as [string, JsonSchema][])(
    'the attempt schema of version %s names the eight phases in order',
    (_, schema) => {
      const phase = (schema['$defs'] as Record<string, Record<string, unknown>>)['phase'];
      const properties = phase['properties'] as Record<string, { enum: unknown[] }>;
      expect(properties['name'].enum).toEqual(PHASE_NAMES);
    },
  );

  it('keeps version 1 as it was, but for its $id: version 2 adds to it', () => {
    // The version 2 definitions of version 1's parts are version 1's.
    const v1 = ATTEMPT_SCHEMA_V1 as Readonly<Record<string, Record<string, unknown>>>;
    const v2 = ATTEMPT_SCHEMA as Readonly<Record<string, Record<string, unknown>>>;
    for (const def of ['facelets', 'move', 'phase']) {
      expect(v2['$defs'][def], def).toEqual(v1['$defs'][def]);
    }
    for (const field of ['session', 'index', 'scramble', 'crossFace', 'events', 'result']) {
      expect(v2['properties'][field], field).toEqual(v1['properties'][field]);
    }
    const s1 = SESSION_SCHEMA_V1['properties'] as Record<string, unknown>;
    const s2 = SESSION_SCHEMA['properties'] as Record<string, unknown>;
    for (const field of ['id', 'createdMs', 'app', 'host', 'cube', 'audio', 'settings', 'notes']) {
      expect(s2[field], field).toEqual(s1[field]);
    }
    expect(ATTEMPT_SCHEMA_V1['$id']).toMatch(/\/attempt\.v1\.schema\.json$/);
    expect(SESSION_SCHEMA_V1['$id']).toMatch(/\/session\.v1\.schema\.json$/);
  });
});

describe('version 2', () => {
  const validateAttempt = newAjv().compile(ATTEMPT_SCHEMA);
  const validateSession = newAjv().compile(SESSION_SCHEMA);
  const validateFrames = newAjv().compile(FRAMES_SCHEMA);

  it('accepts the records the package makes, and the phase 2 fields filled', () => {
    for (const record of [solvedAttempt(), dnfAttempt(), untouchedAttempt(), attemptWithVideo()]) {
      expect(validateAttempt(record), JSON.stringify(validateAttempt.errors)).toBe(true);
    }
    for (const record of [sessionRecord(), sessionWithCamera()]) {
      expect(validateSession(record), JSON.stringify(validateSession.errors)).toBe(true);
    }
    expect(validateFrames(framesJson()), JSON.stringify(validateFrames.errors)).toBe(true);
  });

  const attemptCases: [string, readonly (string | number)[], unknown][] = [
    ['an unknown field', ['extra'], 1],
    ['an unknown field in result', ['result', 'extra'], 1],
    ['a missing field', ['phases'], undefined],
    ['no clock', ['clock'], undefined],
    ['a missing event', ['events', 'pickup'], undefined],
    ['schema version 1', ['schema'], 1],
    ['schema version 3', ['schema'], 3],
    ['a session id that is not a UUID v4', ['session'], 'session-1'],
    ['index 0', ['index'], 0],
    ['a fractional index', ['index'], 1.5],
    ['a scramble with two spaces', ['scramble'], 'R  U F'],
    ['a scramble with a wide move', ['scramble'], 'R Uw F'],
    ['53 facelets', ['scrambledFacelets'], 'U'.repeat(53)],
    ['a facelet that is not a face', ['scrambledFacelets'], 'X'.repeat(54)],
    ['a cross face that is not a face', ['crossFace'], 'X'],
    ["the move R2'", ['moves', 0, 'm'], "R2'"],
    ['the slice move M', ['moves', 0, 'm'], 'M'],
    ['a move of another phase', ['moves', 0, 'phase'], 'inspection'],
    ['a move without its cube time', ['moves', 0, 'cubeMs'], undefined],
    ['a move that says whether it ended its packet', ['moves', 0, 'packetLast'], true],
    ['a clock without its slope', ['clock', 'a'], undefined],
    ['a clock fit of one sample', ['clock', 'samples'], 1],
    ['a clock with a negative residual', ['clock', 'residualP95Ms'], -1],
    ['a clock with an unknown field', ['clock', 'window'], 2000],
    ['a clock that is a number', ['clock'], 1.007],
    ['another status', ['result', 'status'], 'timeout'],
    ['a negative time', ['result', 'timeMs'], -1],
    ['fractional quarter turns', ['result', 'movesQtm'], 2.5],
    ['a phase that is not CFOP', ['phases', 0, 'name'], 'oll'],
    ['a slot on the cross', ['phases', 0, 'slot'], 'FR'],
    ['an f2l phase without its slot', ['phases', 1, 'slot'], undefined],
    ['a slot that is not an edge position', ['phases', 1, 'slot'], 'URF'],
    ['a negative recognition time', ['phases', 2, 'recognitionMs'], -5],
    ['an incomplete clip', ['video'], [{ camera: 'laptop' }]],
  ];

  const clipCases: [string, string, unknown][] = [
    ['a camera label with a capital', 'camera', 'Laptop'],
    ['a camera label with a space', 'camera', 'office laptop'],
    ['a camera label with a dot', 'camera', 'laptop.1'],
    ['a camera label ending in a hyphen', 'camera', 'phone-'],
    ['another segment', 'segment', 'inspection'],
    ['a file in another folder', 'file', '../laptop.solve.mp4'],
    ['a file that is not an MP4', 'file', 'laptop.solve.webm'],
    ['no size', 'bytes', undefined],
    ['an empty file', 'bytes', 0],
    ['an empty codec', 'codec', ''],
    ['no audio field', 'audio', undefined],
    ['an empty audio codec', 'audio', ''],
    ['a fractional width', 'width', 1919.5],
    ['a height of 0', 'height', 0],
    ['a crop with a negative x', 'crop', { x: -1, y: 0, w: 10, h: 10 }],
    ['a crop of width 0', 'crop', { x: 0, y: 0, w: 0, h: 10 }],
    ['a crop without its height', 'crop', { x: 0, y: 0, w: 10 }],
    ['a crop in fractions of the frame', 'crop', { x: 0.25, y: 0, w: 0.5, h: 1 }],
    ['a frame rate of 0', 'fpsNominal', 0],
    ['no frames', 'frames', 0],
    ['a first frame time that is text', 'firstFrameHostMs', '1790000000812.4'],
    ['a frames file that is not JSON', 'framesFile', 'laptop.solve.frames.txt'],
    ['a sync residual that is text', 'syncResidualMs', '41.5'],
    ['an unknown field', 'rotation', 90],
  ];

  const attempt = attemptWithVideo();

  it.each(attemptCases)('rejects an attempt with %s', (_, path, value) => {
    expect(validateAttempt(attempt)).toBe(true);
    expect(validateAttempt(changed(attempt, path, value))).toBe(false);
  });

  it.each(clipCases)('rejects a clip with %s', (_, field, value) => {
    expect(validateAttempt(changed(attempt, ['video', 1, field], value))).toBe(false);
  });

  it('accepts a clip without audio, crop or sync check, and one of a phone camera', () => {
    for (const [field, value] of [
      ['audio', null],
      ['crop', null],
      ['syncResidualMs', null],
      ['syncResidualMs', -3.5],
      ['camera', 'phone-2'],
    ] as [string, unknown][]) {
      expect(validateAttempt(changed(attempt, ['video', 0, field], value)), field).toBe(true);
    }
  });

  const sessionCases: [string, readonly (string | number)[], unknown][] = [
    ['an unknown field', ['extra'], 1],
    ['the type of a hardware event in cube', ['cube', 'type'], 'hardware'],
    ['an id that is not a UUID v4', ['id'], 'abc'],
    ['schema version 1', ['schema'], 1],
    ['an incomplete camera', ['cameras'], [{ label: 'phone-1' }]],
    ['a remote camera', ['cameras', 0, 'local'], false],
    ['a camera facing sideways', ['cameras', 0, 'facing'], 'left'],
    ['a camera without its device label', ['cameras', 0, 'deviceLabel'], undefined],
    ['settings that are a list', ['cameras', 0, 'settings'], [30]],
    ['no capabilities', ['cameras', 0, 'capabilities'], undefined],
    ['constraints that are null', ['cameras', 0, 'constraints'], null],
    ['a crop at source of another kind', ['cameras', 0, 'mode'], 'zoom'],
    ['a camera label with a capital', ['cameras', 0, 'label'], 'Laptop'],
    ['an unknown field in a camera', ['cameras', 0, 'torch'], true],
    ['an incomplete camera clock', ['clock', 'cameras', 'phone-1'], { offsetMs: 3 }],
    [
      'a camera clock under another label',
      ['clock', 'cameras', 'Phone 1'],
      {
        offsetMs: 3,
        rttMs: 0,
        driftPpm: 0,
        clapperboardResidualMs: 0,
        clapperboardSamples: 0,
      },
    ],
    ['a negative round trip', ['clock', 'cameras', 'laptop', 'rttMs'], -1],
    ['a negative residual', ['clock', 'cameras', 'laptop', 'clapperboardResidualMs'], -1],
    ['fractional matches', ['clock', 'cameras', 'laptop', 'clapperboardSamples'], 1.5],
    [
      'a sample without its onset',
      ['clock', 'cameras', 'laptop', 'samples', 0, 'onsetHostMs'],
      undefined,
    ],
    ['an unknown field in a camera clock', ['clock', 'cameras', 'laptop', 'lagMs'], 40],
    ['a cube clock fit without its sample count', ['clock', 'cube', 'samples'], undefined],
    ['a negative cube residual', ['clock', 'cube', 'residualP95Ms'], -1],
    ['fractional attempts', ['summary', 'attempts'], 0.5],
    ['a missing setting', ['settings', 'autoAdvance'], undefined],
    ['audio that is not a boolean', ['audio'], 'on'],
  ];

  const session = sessionWithCamera();

  it.each(sessionCases)('rejects a session with %s', (_, path, value) => {
    expect(validateSession(session)).toBe(true);
    expect(validateSession(changed(session, path, value))).toBe(false);
  });

  it('accepts any JSON in the browser snapshots, and a camera clock without its samples', () => {
    const odd = { 'weird key': [1, { nested: null }], resizeMode: 'none', torch: false };
    expect(validateSession(changed(session, ['cameras', 0, 'capabilities'], odd))).toBe(true);
    expect(validateSession(changed(session, ['cameras', 0, 'settings'], {}))).toBe(true);
    expect(
      validateSession(changed(session, ['clock', 'cameras', 'laptop', 'samples'], undefined)),
    ).toBe(true);
  });

  const framesCases: [string, readonly (string | number)[], unknown][] = [
    ['schema version 1', ['schema'], 1],
    ['a camera label with a capital', ['camera'], 'Laptop'],
    ['another segment', ['segment'], 'clapperboard'],
    ['no first frame time', ['t0HostMs'], undefined],
    ['no frames', ['dtMs'], []],
    ['a frame before the previous one', ['dtMs', 2], -33.3],
    ['a frame time that is text', ['dtMs', 1], '33.4'],
    ['no keyframe', ['keyframes'], []],
    ['a keyframe twice', ['keyframes'], [0, 0]],
    ['a fractional keyframe', ['keyframes', 1], 2.5],
    ['an arrival fit without its residual', ['arrival', 'residualP95Ms'], undefined],
    ['a negative arrival residual', ['arrival', 'residualP95Ms'], -1],
    ['an unknown field', ['fps'], 30],
  ];

  it.each(framesCases)('rejects a frames file with %s', (_, path, value) => {
    expect(validateFrames(framesJson())).toBe(true);
    expect(validateFrames(changed(framesJson(), path, value))).toBe(false);
  });
});

describe('version 1', () => {
  const validateAttempt = newAjv().compile(ATTEMPT_SCHEMA_V1);
  const validateSession = newAjv().compile(SESSION_SCHEMA_V1);

  it('accepts the records of version 1, and rejects those of version 2', () => {
    for (const record of [solvedAttempt(), dnfAttempt(), untouchedAttempt()]) {
      expect(validateAttempt(asVersion1Attempt(record))).toBe(true);
      expect(validateAttempt(record)).toBe(false);
    }
    expect(validateSession(asVersion1Session(sessionRecord()))).toBe(true);
    expect(validateSession(sessionRecord())).toBe(false);
  });

  it.each([
    ['a clock', ['clock'], { a: 1, b: 0, residualP95Ms: 0, samples: 2 }],
    ['a clip', ['video'], [{ camera: 'laptop' }]],
  ] as [string, readonly string[], unknown][])('rejects an attempt with %s', (_, path, value) => {
    expect(validateAttempt(changed(asVersion1Attempt(solvedAttempt()), path, value))).toBe(false);
  });

  it.each([
    ['a camera', ['cameras'], [{ label: 'phone-1' }]],
    ['a camera clock', ['clock', 'cameras', 'phone-1'], { offsetMs: 3 }],
  ] as [string, readonly string[], unknown][])('rejects a session with %s', (_, path, value) => {
    expect(validateSession(changed(asVersion1Session(sessionRecord()), path, value))).toBe(false);
  });
});
