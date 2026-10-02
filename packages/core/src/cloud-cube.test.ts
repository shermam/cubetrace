import { Ajv2020, type ErrorObject } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { CloudCube, JsonSchema } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_CUBE_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  FRAMES_SCHEMA,
  MAC_ADDRESS,
  RecordError,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  USER_SCHEMA,
  cloudCube,
  isCubeDocumentName,
  parseCloudCube,
} from './index';

// The account's cubes in Firestore (docs/DATA-MODEL.md §10, docs/PLAN.md T3.4): what the builder
// writes, the JSON Schema, and the reader the app reads the documents back with, held to the schema
// field by field as cloud.test.ts holds the session index's readers to theirs.

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isCloudCube = ajv.compile<CloudCube>(CLOUD_CUBE_SCHEMA);

/** The owner's GAN 12 ui as the laptop writes it. */
function laptopCube(): CloudCube {
  return cloudCube({
    name: 'GAN12ui_AB12',
    mac: 'AB:12:CD:34:EF:56',
    updatedMs: 1_790_000_123_456.7,
    device: 'office-mbp',
  });
}

/** A copy of `cube` with `field` replaced, or removed when `value` is undefined. */
function changed(cube: CloudCube, field: string, value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...cube };
  if (value === undefined) {
    Reflect.deleteProperty(copy, field);
  } else {
    copy[field] = value;
  }
  return copy;
}

describe('cloudCube', () => {
  it('writes users/{uid}/cubes/{name} as docs/DATA-MODEL.md §10 describes it: the entry and its writer', () => {
    expect(laptopCube()).toEqual({
      schema: 1,
      name: 'GAN12ui_AB12',
      mac: 'AB:12:CD:34:EF:56',
      updatedMs: 1_790_000_123_456.7,
      device: 'office-mbp',
    });
    expect(Object.keys(laptopCube())).toEqual(CLOUD_CUBE_SCHEMA['required']);
  });

  it('tells the names that can name a document from those that stay on their device', () => {
    for (const name of ['GAN12ui_AB12', 'GAN 356 i3', 'Ada’s cube', '.cube', '__cube', 'cube__']) {
      expect(isCubeDocumentName(name), name).toBe(true);
    }
    for (const name of ['', 'GAN/12', '/', '.', '..', '__cube__', '____', 'é'.repeat(751)]) {
      expect(isCubeDocumentName(name), name).toBe(false);
    }
    // 1,500 bytes is the limit: 750 two-byte characters fit.
    expect(isCubeDocumentName('é'.repeat(750))).toBe(true);
  });

  it('holds MAC addresses as Settings keeps them: upper case, colons', () => {
    expect(MAC_ADDRESS.test('AB:12:CD:34:EF:56')).toBe(true);
    for (const text of [
      'ab:12:cd:34:ef:56',
      'AB-12-CD-34-EF-56',
      'AB12CD34EF56',
      'AB:12:CD:34:EF',
    ]) {
      expect(MAC_ADDRESS.test(text), text).toBe(false);
    }
  });
});

describe('the JSON Schema of users/{uid}/cubes/{name}', () => {
  it('is draft 2020-12, compiles in ajv without a warning and has an $id of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      new Ajv2020({ allowUnionTypes: true }).compile(CLOUD_CUBE_SCHEMA);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(CLOUD_CUBE_SCHEMA['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(CLOUD_CUBE_SCHEMA['title']).toBe('users/{uid}/cubes/{name}');
    expect(CLOUD_CUBE_SCHEMA['$id']).toMatch(/\/cloud-cube\.schema\.json$/);
    const others: JsonSchema[] = [
      ATTEMPT_SCHEMA,
      ATTEMPT_SCHEMA_V1,
      CLOUD_ATTEMPT_SCHEMA,
      CLOUD_SESSION_SCHEMA,
      FRAMES_SCHEMA,
      SESSION_SCHEMA,
      SESSION_SCHEMA_V1,
      USER_SCHEMA,
    ];
    expect(others.map((schema) => schema['$id'])).not.toContain(CLOUD_CUBE_SCHEMA['$id']);
  });

  it('accepts what a device writes, whatever the name and the time', () => {
    for (const valid of [
      laptopCube(),
      changed(laptopCube(), 'name', 'GAN 356 i3'),
      changed(laptopCube(), 'name', '.cube'),
      changed(laptopCube(), 'updatedMs', 0),
      changed(laptopCube(), 'updatedMs', 1_790_000_000_000),
      changed(laptopCube(), 'device', 'Android phone'),
    ]) {
      expect(isCloudCube(valid), JSON.stringify(isCloudCube.errors)).toBe(true);
    }
  });

  it.each([
    ['schema version 2', 'schema', 2],
    ['no schema', 'schema', undefined],
    ['no name', 'name', undefined],
    ['an empty name', 'name', ''],
    ['a name with a slash', 'name', 'GAN/12'],
    ['a name that is ..', 'name', '..'],
    ['a reserved name', 'name', '__cube__'],
    ['no MAC address', 'mac', undefined],
    ['a MAC address in lower case', 'mac', 'ab:12:cd:34:ef:56'],
    ['a MAC address with dashes', 'mac', 'AB-12-CD-34-EF-56'],
    ['a MAC address without separators', 'mac', 'AB12CD34EF56'],
    ['a MAC address of five bytes', 'mac', 'AB:12:CD:34:EF'],
    ['no time', 'updatedMs', undefined],
    ['a time that is text', 'updatedMs', '1790000123456'],
    ['a negative time', 'updatedMs', -1],
    ['no device', 'device', undefined],
    ['an empty device', 'device', ''],
    ['an unknown field', 'owner', 'ada-uid'],
  ] as [string, string, unknown][])(
    'refuses a document with %s, as the reader does',
    (_, field, value) => {
      expect(isCloudCube(laptopCube())).toBe(true);
      const document = changed(laptopCube(), field, value);
      expect(isCloudCube(document)).toBe(false);
      expect(() => parseCloudCube(document)).toThrow(RecordError);
    },
  );
});

/** What ajv says of `value`, and the fields of its errors as the reader names a field. */
function schemaSays(value: unknown): { valid: boolean; fields: string[] } {
  const valid = isCloudCube(value);
  return { valid, fields: valid ? [] : (isCloudCube.errors ?? []).map(fieldOf) };
}

function fieldOf(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const key = params['missingProperty'] ?? params['additionalProperty'];
  const pointer = typeof key === 'string' ? `${error.instancePath}/${key}` : error.instancePath;
  return pointer.split('/').slice(1).join('.');
}

const REPLACEMENTS: unknown[] = [
  undefined,
  null,
  'x',
  '',
  -1,
  0,
  1,
  1.5,
  2,
  true,
  [],
  {},
  'AB:12:CD:34:EF:56',
  'ab:12:cd:34:ef:56',
  'a/b',
  '..',
  '__x__',
];

describe('parseCloudCube', () => {
  it('returns what a device writes as it is, as a new object', () => {
    const cube = laptopCube();
    const input = structuredClone(cube);
    const read = parseCloudCube(input);
    expect(read).toEqual(cube);
    expect(read).not.toBe(input);
    expect(Object.keys(read)).toEqual(CLOUD_CUBE_SCHEMA['required']);
  });

  it.each([
    ['text', 'GAN12ui_AB12', 'users/{uid}/cubes/{name} must be an object, got "GAN12ui_AB12".'],
    [
      'schema 2',
      changed(laptopCube(), 'schema', 2),
      'users/{uid}/cubes/{name}: schema must be 1, got 2.',
    ],
    [
      'a MAC address in lower case',
      changed(laptopCube(), 'mac', 'ab:12:cd:34:ef:56'),
      'users/{uid}/cubes/{name} (schema 1): mac must be a MAC address such as AB:12:CD:34:EF:56 (upper case, colons), got "ab:12:cd:34:ef:56".',
    ],
    [
      'no time',
      changed(laptopCube(), 'updatedMs', undefined),
      'users/{uid}/cubes/{name} (schema 1): updatedMs is missing.',
    ],
    [
      'an owner',
      changed(laptopCube(), 'owner', 'ada-uid'),
      'users/{uid}/cubes/{name} (schema 1): owner is not a known field.',
    ],
  ] as [string, unknown, string][])('throws on %s, naming the field', (_, value, message) => {
    expect(() => parseCloudCube(value)).toThrow(message);
  });

  it('accepts exactly what the schema accepts, every field changed in turn', () => {
    const cube = laptopCube();
    const mismatches: string[] = [];
    let rejected = 0;
    for (const field of [...Object.keys(cube), 'zz']) {
      for (const value of REPLACEMENTS) {
        const mutated = changed(cube, field, value);
        const schema = schemaSays(mutated);
        let reader: { valid: boolean; field?: string };
        try {
          parseCloudCube(mutated);
          reader = { valid: true };
        } catch (error: unknown) {
          if (!(error instanceof RecordError)) {
            throw error;
          }
          expect(error.file).toBe('users/{uid}/cubes/{name}');
          reader = { valid: false, field: error.field };
        }
        const what = `${field} = ${value === undefined ? 'removed' : JSON.stringify(value)}`;
        if (schema.valid !== reader.valid) {
          mismatches.push(`${what}: the schema says ${String(schema.valid)}`);
        } else if (!reader.valid) {
          rejected++;
          if (!schema.fields.includes(reader.field ?? '')) {
            mismatches.push(
              `${what}: the reader names ${reader.field ?? ''}, ajv ${schema.fields.join(' ')}`,
            );
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(rejected).toBeGreaterThan(60);
  });
});
