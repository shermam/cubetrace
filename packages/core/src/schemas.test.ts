import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { JsonSchema } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  FRAMES_SCHEMA,
  GYRO_SCHEMA,
  PHASE_NAMES,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
} from './index';
import {
  APP,
  REMOTE_CLOCK,
  REMOTE_DEVICE,
  asVersion1Attempt,
  asVersion1Session,
  attemptWithVideo,
  dnfAttempt,
  framesJson,
  gyroJson,
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
  ['gyro.json', GYRO_SCHEMA],
];

/** The objects that are not closed records: browser snapshots, and camera clocks by label. */
const SNAPSHOTS = /\/\$defs\/camera\/properties\/(settings|capabilities|constraints)$/;
const BY_LABEL = '#/properties/clock/properties/cameras';
/**
 * The only fields that may be absent, by schema and object: a phase's slot, a camera clock's
 * samples, a clip's truncatedStart (the clips written before T2.9 have none) and its local (only a
 * clip whose MP4 was deleted after its upload has it, T3.3), a camera's microphone (the cameras
 * written before T2.12 have none), the fields of T3.7, which the files written before have none
 * of: an attempt's app, gyro and resyncs and its moves' serial and packetLast, a session's battery
 * and its cube's productDate, and a frames file's app; and the fields of T4.0, which only a remote
 * camera has: a camera's remote (its device; required by an if/then when local is false) and a
 * camera clock's remote (its clock sync).
 */
const OPTIONAL: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'session.json version 2': {
    '#': ['battery'],
    '#/properties/cube': ['productDate'],
    '#/$defs/cameraClock': ['samples', 'remote'],
    '#/$defs/camera': ['microphone', 'remote'],
  },
  'attempt.json version 2': {
    '#': ['app', 'gyro', 'resyncs'],
    '#/$defs/move': ['serial', 'packetLast'],
    '#/$defs/phase': ['slot'],
    '#/$defs/clip': ['truncatedStart', 'local'],
  },
  'session.json version 1': { '#/$defs/cameraClock': ['samples'] },
  'attempt.json version 1': { '#/$defs/phase': ['slot'] },
  'frames.json': { '#': ['app'] },
  'gyro.json': {},
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
    ['session.json version 2', SESSION_SCHEMA, 20],
    ['attempt.json version 2', ATTEMPT_SCHEMA, 11],
    ['session.json version 1', SESSION_SCHEMA_V1, 9],
    ['attempt.json version 1', ATTEMPT_SCHEMA_V1, 5],
    ['frames.json', FRAMES_SCHEMA, 3],
    ['gyro.json', GYRO_SCHEMA, 2],
  ] as [string, JsonSchema, number][])(
    'the schema of %s closes every record and requires every field but the optional ones',
    (title, schema, count) => {
      const objects = objectSchemas(schema);
      expect(objects).toHaveLength(count);
      const optional = OPTIONAL[title];
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
            (k) => !(optional[at] ?? []).includes(k),
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
    // The version 2 definitions of version 1's parts are version 1's, but where version 2 added
    // optional fields (T3.7: a move's serial and packetLast, the cube's productDate).
    const v1 = ATTEMPT_SCHEMA_V1 as Readonly<Record<string, Record<string, unknown>>>;
    const v2 = ATTEMPT_SCHEMA as Readonly<Record<string, Record<string, unknown>>>;
    for (const def of ['facelets', 'phase']) {
      expect(v2['$defs'][def], def).toEqual(v1['$defs'][def]);
    }
    const move1 = v1['$defs']['move'] as Record<string, Record<string, unknown>>;
    const move2 = v2['$defs']['move'] as Record<string, Record<string, unknown>>;
    expect(move2['required']).toEqual(move1['required']);
    for (const field of Object.keys(move1['properties'])) {
      expect(move2['properties'][field], field).toEqual(move1['properties'][field]);
    }
    expect(Object.keys(move2['properties'])).toEqual([
      ...Object.keys(move1['properties']),
      'serial',
      'packetLast',
    ]);
    for (const field of ['session', 'index', 'scramble', 'crossFace', 'events', 'result']) {
      expect(v2['properties'][field], field).toEqual(v1['properties'][field]);
    }
    const s1 = SESSION_SCHEMA_V1['properties'] as Record<string, Record<string, unknown>>;
    const s2 = SESSION_SCHEMA['properties'] as Record<string, Record<string, unknown>>;
    for (const field of ['id', 'createdMs', 'app', 'host', 'audio', 'settings', 'notes']) {
      expect(s2[field], field).toEqual(s1[field]);
    }
    expect(s2['cube']['required']).toEqual(s1['cube']['required']);
    expect(Object.keys(s2['cube']['properties'] as object)).toEqual([
      ...Object.keys(s1['cube']['properties'] as object),
      'productDate',
    ]);
    expect(ATTEMPT_SCHEMA_V1['$id']).toMatch(/\/attempt\.v1\.schema\.json$/);
    expect(SESSION_SCHEMA_V1['$id']).toMatch(/\/session\.v1\.schema\.json$/);
  });

  it("gives the frames files and the gyro files the build's shape of session.json (T3.7)", () => {
    const app = (SESSION_SCHEMA['properties'] as Record<string, unknown>)['app'];
    expect((FRAMES_SCHEMA['$defs'] as Record<string, unknown>)['app']).toMatchObject(app as object);
    expect((GYRO_SCHEMA['$defs'] as Record<string, unknown>)['app']).toMatchObject(app as object);
    expect((ATTEMPT_SCHEMA['$defs'] as Record<string, unknown>)['app']).toMatchObject(
      app as object,
    );
  });
});

describe('version 2', () => {
  const validateAttempt = newAjv().compile(ATTEMPT_SCHEMA);
  const validateSession = newAjv().compile(SESSION_SCHEMA);
  const validateFrames = newAjv().compile(FRAMES_SCHEMA);
  const validateGyro = newAjv().compile(GYRO_SCHEMA);

  it('accepts the records the package makes, the phase 2 fields filled, and the files of T3.7', () => {
    for (const record of [solvedAttempt(), dnfAttempt(), untouchedAttempt(), attemptWithVideo()]) {
      expect(validateAttempt(record), JSON.stringify(validateAttempt.errors)).toBe(true);
    }
    for (const record of [sessionRecord(), sessionWithCamera()]) {
      expect(validateSession(record), JSON.stringify(validateSession.errors)).toBe(true);
    }
    expect(validateFrames(framesJson()), JSON.stringify(validateFrames.errors)).toBe(true);
    expect(validateFrames({ ...framesJson(), app: APP })).toBe(true);
    expect(validateGyro(gyroJson()), JSON.stringify(validateGyro.errors)).toBe(true);
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
    ['a move counter of 256', ['moves', 0, 'serial'], 256],
    ['a negative move counter', ['moves', 0, 'serial'], -1],
    ['a fractional move counter', ['moves', 0, 'serial'], 1.5],
    ['a packet flag that is text', ['moves', 0, 'packetLast'], 'true'],
    ['a packet flag of null', ['moves', 0, 'packetLast'], null],
    ['a build without its commit', ['app', 'commit'], undefined],
    ['a build that is text', ['app'], '0.3.0'],
    ['a gyro summary that is text', ['gyro'], 'gyro.json'],
    ['a gyro summary of another file', ['gyro', 'file'], 'laptop.gyro.json'],
    ['a gyro summary without samples', ['gyro', 'samples'], 0],
    ['a gyro summary with a negative rate', ['gyro', 'rateHz'], -1],
    ['a gyro summary without its span', ['gyro', 'toHostMs'], undefined],
    ['a gyro summary with an unknown field', ['gyro', 'bytes'], 1],
    ['resyncs that are an object', ['resyncs'], {}],
    ['a resync without its state', ['resyncs', 0, 'state'], undefined],
    ['a resync of a solved attempt', ['resyncs', 0, 'state'], 'solved'],
    ['a resync of 53 facelets', ['resyncs', 0, 'facelets'], 'U'.repeat(53)],
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
    ['a truncated start that is text', 'truncatedStart', 'true'],
    ['a truncated start of null', 'truncatedStart', null],
    ['a local that is text', 'local', 'false'],
    ['a local of null', 'local', null],
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

  it("accepts an attempt written before T3.7, without the build, the gyro file, the resyncs and the moves' counters", () => {
    const record = attemptWithVideo();
    const before = {
      ...record,
      moves: record.moves.map(({ m, hostMs, cubeMs, phase }) => ({ m, hostMs, cubeMs, phase })),
    };
    Reflect.deleteProperty(before, 'app');
    Reflect.deleteProperty(before, 'gyro');
    Reflect.deleteProperty(before, 'resyncs');
    expect(validateAttempt(before), JSON.stringify(validateAttempt.errors)).toBe(true);
    expect(validateAttempt({ ...record, gyro: null, resyncs: [] })).toBe(true);
    expect(validateAttempt(changed(record, ['moves', 0, 'serial'], null))).toBe(true);
    expect(validateAttempt(changed(record, ['moves', 0, 'serial'], 255))).toBe(true);
    expect(validateAttempt(changed(record, ['moves', 0, 'packetLast'], false))).toBe(true);
  });

  it('accepts a clip without audio, crop or sync check, one of a phone camera, one written before truncatedStart, and one whose MP4 is no longer on the device', () => {
    for (const [field, value] of [
      ['audio', null],
      ['crop', null],
      ['syncResidualMs', null],
      ['syncResidualMs', -3.5],
      ['camera', 'phone-2'],
      ['truncatedStart', false],
      ['truncatedStart', undefined],
      ['local', false],
      ['local', true],
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
    ['a remote camera without its device', ['cameras', 0, 'local'], false],
    ['a remote camera without its device, after the fact', ['cameras', 1, 'remote'], undefined],
    ['a local camera with a remote device', ['cameras', 0, 'remote'], REMOTE_DEVICE],
    ['a remote device without its platform', ['cameras', 1, 'remote', 'platform'], undefined],
    ['a remote device whose label is a number', ['cameras', 1, 'remote', 'label'], 7],
    ['an unknown field in a remote device', ['cameras', 1, 'remote', 'isPhone'], true],
    ['a local that is text', ['cameras', 0, 'local'], 'true'],
    ['a camera facing sideways', ['cameras', 0, 'facing'], 'left'],
    ['a camera without its device label', ['cameras', 0, 'deviceLabel'], undefined],
    ['settings that are a list', ['cameras', 0, 'settings'], [30]],
    ['no capabilities', ['cameras', 0, 'capabilities'], undefined],
    ['constraints that are null', ['cameras', 0, 'constraints'], null],
    ['a crop at source of another kind', ['cameras', 0, 'mode'], 'zoom'],
    ['a camera label with a capital', ['cameras', 0, 'label'], 'Laptop'],
    ['an unknown field in a camera', ['cameras', 0, 'torch'], true],
    ['a microphone that is text', ['cameras', 0, 'microphone'], 'raw'],
    ['an incomplete microphone', ['cameras', 0, 'microphone'], { label: 'Built-in' }],
    ['a microphone asked for another way', ['cameras', 0, 'microphone', 'processing'], 'loud'],
    ['a microphone without its label', ['cameras', 0, 'microphone', 'label'], undefined],
    [
      'a microphone without its noise suppression',
      ['cameras', 0, 'microphone', 'noiseSuppression'],
      undefined,
    ],
    ['echo cancellation as text', ['cameras', 0, 'microphone', 'echoCancellation'], 'all'],
    ['a sample rate of 0', ['cameras', 0, 'microphone', 'sampleRate'], 0],
    ['half a channel', ['cameras', 0, 'microphone', 'channelCount'], 1.5],
    ['no channel', ['cameras', 0, 'microphone', 'channelCount'], 0],
    ['an unknown field in a microphone', ['cameras', 0, 'microphone', 'deviceId'], 'default'],
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
    ['a remote clock sync that is a number', ['clock', 'cameras', 'phone-rear', 'remote'], 3],
    [
      'a remote clock sync without its drift',
      ['clock', 'cameras', 'phone-rear', 'remote', 'driftPpm'],
      undefined,
    ],
    [
      'a remote clock sync with a negative round trip',
      ['clock', 'cameras', 'phone-rear', 'remote', 'rttMs'],
      -1,
    ],
    [
      'a remote clock sync with fractional samples',
      ['clock', 'cameras', 'phone-rear', 'remote', 'samples'],
      1.5,
    ],
    [
      'a remote clock sync with a negative residual',
      ['clock', 'cameras', 'phone-rear', 'remote', 'residualP95Ms'],
      -0.1,
    ],
    [
      'an unknown field in a remote clock sync',
      ['clock', 'cameras', 'phone-rear', 'remote', 'converged'],
      true,
    ],
    ['a cube clock fit without its sample count', ['clock', 'cube', 'samples'], undefined],
    ['a negative cube residual', ['clock', 'cube', 'residualP95Ms'], -1],
    ['fractional attempts', ['summary', 'attempts'], 0.5],
    ['a missing setting', ['settings', 'autoAdvance'], undefined],
    ['audio that is not a boolean', ['audio'], 'on'],
    ['a production date that is a number', ['cube', 'productDate'], 20_250_314],
    ['battery reports that are an object', ['battery'], {}],
    ['a battery report without its time', ['battery', 0, 'hostMs'], undefined],
    ['a battery level over 100', ['battery', 0, 'level'], 101],
    ['a fractional battery level', ['battery', 0, 'level'], 82.5],
    ['a battery report with an unknown field', ['battery', 0, 'charging'], true],
  ];

  const session = sessionWithCamera();

  it.each(sessionCases)('rejects a session with %s', (_, path, value) => {
    expect(validateSession(session)).toBe(true);
    expect(validateSession(changed(session, path, value))).toBe(false);
  });

  it('accepts a session written before T3.7, without battery reports and a production date', () => {
    const before: Record<string, unknown> = { ...session, cube: { ...session.cube } };
    Reflect.deleteProperty(before, 'battery');
    Reflect.deleteProperty(before['cube'] as object, 'productDate');
    expect(validateSession(before), JSON.stringify(validateSession.errors)).toBe(true);
    expect(validateSession({ ...session, battery: [] })).toBe(true);
    expect(validateSession(changed(session, ['cube', 'productDate'], null))).toBe(true);
  });

  it('accepts any JSON in the browser snapshots, and a camera clock without its samples', () => {
    const odd = { 'weird key': [1, { nested: null }], resizeMode: 'none', torch: false };
    expect(validateSession(changed(session, ['cameras', 0, 'capabilities'], odd))).toBe(true);
    expect(validateSession(changed(session, ['cameras', 0, 'settings'], {}))).toBe(true);
    expect(
      validateSession(changed(session, ['clock', 'cameras', 'laptop', 'samples'], undefined)),
    ).toBe(true);
  });

  it('accepts a remote camera with its device and its clock sync, and a local camera with neither (T4.0)', () => {
    expect(session.cameras.map((camera) => camera.local)).toEqual([true, false]);
    expect(validateSession(session)).toBe(true);
    // A local camera's clock may say the remote sync too (the schema does not tie the two).
    expect(
      validateSession(changed(session, ['clock', 'cameras', 'laptop', 'remote'], REMOTE_CLOCK)),
    ).toBe(true);
    expect(
      validateSession(changed(session, ['clock', 'cameras', 'phone-rear', 'remote'], undefined)),
    ).toBe(true);
    // A session written before phase 4: the laptop's camera alone, as before.
    expect(validateSession({ ...session, cameras: [session.cameras[0]] })).toBe(true);
  });

  it('accepts a camera without a microphone, one written before it was kept, and what a browser does not report', () => {
    for (const [path, value] of [
      [['cameras', 0, 'microphone'], null],
      [['cameras', 0, 'microphone'], undefined],
      [['cameras', 0, 'microphone', 'processing'], 'voice'],
      [['cameras', 0, 'microphone', 'label'], ''],
      [['cameras', 0, 'microphone', 'echoCancellation'], null],
      [['cameras', 0, 'microphone', 'autoGainControl'], true],
      [['cameras', 0, 'microphone', 'voiceIsolation'], false],
      [['cameras', 0, 'microphone', 'sampleRate'], 44_100],
      [['cameras', 0, 'microphone', 'sampleRate'], null],
      [['cameras', 0, 'microphone', 'channelCount'], 2],
      [['cameras', 0, 'microphone', 'channelCount'], null],
    ] as [(string | number)[], unknown][]) {
      expect(validateSession(changed(session, path, value)), path.join('.')).toBe(true);
    }
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
    ['a build without its version', ['app'], { commit: 'abc1234' }],
    ['a build that is text', ['app'], '0.3.0'],
  ];

  it.each(framesCases)('rejects a frames file with %s', (_, path, value) => {
    expect(validateFrames(framesJson())).toBe(true);
    expect(validateFrames(changed(framesJson(), path, value))).toBe(false);
  });

  const gyroCases: [string, readonly (string | number)[], unknown][] = [
    ['schema version 2', ['schema'], 2],
    ['a session id that is not a UUID v4', ['session'], 'session-1'],
    ['index 0', ['index'], 0],
    ['no build', ['app'], undefined],
    ['a build without its commit', ['app', 'commit'], undefined],
    ['no first sample time', ['t0HostMs'], undefined],
    ['no samples', ['dtMs'], []],
    ['a sample before the previous one', ['dtMs', 2], -20],
    ['an interval that is text', ['dtMs', 1], '20'],
    ['no quaternion', ['q'], []],
    ['a quaternion component over 1', ['q', 3], 1.5],
    ['a quaternion component that is text', ['q', 0], '0'],
    ['a velocity of 8', ['v', 2], 8],
    ['a velocity of −9', ['v', 2], -9],
    ['a fractional velocity', ['v', 2], 1.5],
    ['velocities that are an object', ['v'], {}],
    ['no velocity field', ['v'], undefined],
    ['a truncated start that is text', ['truncatedStart'], 'false'],
    ['an unknown field', ['rateHz'], 50],
  ];

  it.each(gyroCases)('rejects a gyro file with %s', (_, path, value) => {
    expect(validateGyro(gyroJson())).toBe(true);
    expect(validateGyro(changed(gyroJson(), path, value))).toBe(false);
  });

  it('accepts a gyro file without velocities (a cube that gives none) and a truncated one', () => {
    expect(validateGyro({ ...gyroJson(), v: null })).toBe(true);
    expect(validateGyro({ ...gyroJson(), truncatedStart: true })).toBe(true);
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
