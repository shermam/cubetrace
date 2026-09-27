import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { JsonSchema } from './index';
import {
  ATTEMPT_SCHEMA,
  AttemptMachine,
  PHASE_NAMES,
  SESSION_SCHEMA,
  createSession,
  parseMoves,
} from './index';

const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';

function newAjv(): Ajv2020 {
  return new Ajv2020({ allowUnionTypes: true, allErrors: true });
}

/** A solved attempt on `R U F`, whose f2l phases name their slots. */
function solvedAttempt(): unknown {
  const machine = new AttemptMachine({
    session: SESSION,
    index: 7,
    scramble: 'R U F',
    scrambleShownMs: 0,
  });
  for (const [k, m] of parseMoves("R U F F' U' R'").entries()) {
    machine.onMove({ m, cubeMs: 100 * k, hostMs: 100 * k + 1000.25 });
  }
  return machine.toRecord();
}

function sessionRecord(): unknown {
  return createSession({
    host: { label: 'laptop', userAgent: 'Mozilla/5.0', platform: 'Windows', isPhone: false },
    cube: { model: 'GAN 12 ui FreePlay', hardware: '1.2', firmware: '2.3.1', gyro: true },
    settings: { inspection15s: false, autoAdvance: true },
    appVersion: '0.1.0',
    commit: 'abc1234',
    nowMs: 1_730_640_000_000,
    id: SESSION,
  });
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

/** Every subschema of type object, with its path. */
function objectSchemas(schema: unknown, at = '#'): ObjectSchema[] {
  if (typeof schema !== 'object' || schema === null) {
    return [];
  }
  const node = schema as Record<string, unknown>;
  const own = node['type'] === 'object' ? [{ at, node }] : [];
  return [
    ...own,
    ...Object.entries(node).flatMap(([key, child]) => objectSchemas(child, `${at}/${key}`)),
  ];
}

describe('the JSON Schemas of session.json and attempt.json', () => {
  it.each([
    ['session', SESSION_SCHEMA],
    ['attempt', ATTEMPT_SCHEMA],
  ] as [string, JsonSchema][])(
    'the %s schema is draft 2020-12 and compiles in ajv without a warning',
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

  it.each([
    ['session', SESSION_SCHEMA, 9],
    ['attempt', ATTEMPT_SCHEMA, 5],
  ] as [string, JsonSchema, number][])(
    'the %s schema closes every object and requires every property but a slot',
    (_, schema, count) => {
      const objects = objectSchemas(schema);
      expect(objects).toHaveLength(count);
      for (const { at, node } of objects) {
        expect(node['additionalProperties'], at).toBe(false);
        const properties = Object.keys(node['properties'] ?? {}).filter((k) => k !== 'slot');
        const required = (node['required'] ?? []) as string[];
        expect([...required].sort(), at).toEqual(properties.sort());
      }
    },
  );

  it('the attempt schema names the eight phases in order', () => {
    const phase = (ATTEMPT_SCHEMA['$defs'] as Record<string, Record<string, unknown>>)['phase'];
    const properties = phase['properties'] as Record<string, { enum: unknown[] }>;
    expect(properties['name'].enum).toEqual(PHASE_NAMES);
  });

  it('accepts the records the package makes', () => {
    expect(newAjv().validate(SESSION_SCHEMA, sessionRecord())).toBe(true);
    expect(newAjv().validate(ATTEMPT_SCHEMA, solvedAttempt())).toBe(true);
  });

  const attemptCases: [string, readonly (string | number)[], unknown][] = [
    ['an unknown field', ['extra'], 1],
    ['an unknown field in result', ['result', 'extra'], 1],
    ['a missing field', ['phases'], undefined],
    ['a missing event', ['events', 'pickup'], undefined],
    ['another schema version', ['schema'], 2],
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
    ['another status', ['result', 'status'], 'timeout'],
    ['a negative time', ['result', 'timeMs'], -1],
    ['fractional quarter turns', ['result', 'movesQtm'], 2.5],
    ['a phase that is not CFOP', ['phases', 0, 'name'], 'oll'],
    ['a slot on the cross', ['phases', 0, 'slot'], 'FR'],
    ['an f2l phase without its slot', ['phases', 1, 'slot'], undefined],
    ['a slot that is not an edge position', ['phases', 1, 'slot'], 'URF'],
    ['a negative recognition time', ['phases', 2, 'recognitionMs'], -5],
    ['a video segment', ['video'], [{ camera: 'laptop' }]],
  ];

  const validateAttempt = newAjv().compile(ATTEMPT_SCHEMA);
  const attempt = solvedAttempt();

  it.each(attemptCases)('rejects an attempt with %s', (_, path, value) => {
    expect(validateAttempt(attempt)).toBe(true);
    expect(validateAttempt(changed(attempt, path, value))).toBe(false);
  });

  const sessionCases: [string, readonly (string | number)[], unknown][] = [
    ['an unknown field', ['extra'], 1],
    ['the type of a hardware event in cube', ['cube', 'type'], 'hardware'],
    ['an id that is not a UUID v4', ['id'], 'abc'],
    ['a camera', ['cameras'], [{ label: 'phone-1' }]],
    ['a camera clock', ['clock', 'cameras', 'phone-1'], { offsetMs: 3 }],
    ['a clock fit without its sample count', ['clock', 'cube', 'samples'], undefined],
    ['a negative residual', ['clock', 'cube', 'residualP95Ms'], -1],
    ['fractional attempts', ['summary', 'attempts'], 0.5],
    ['a missing setting', ['settings', 'autoAdvance'], undefined],
    ['audio that is not a boolean', ['audio'], 'on'],
  ];

  const validateSession = newAjv().compile(SESSION_SCHEMA);
  const session = sessionRecord();

  it.each(sessionCases)('rejects a session with %s', (_, path, value) => {
    expect(validateSession(session)).toBe(true);
    expect(validateSession(changed(session, path, value))).toBe(false);
  });
});
