import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { UserRecord } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  FRAMES_SCHEMA,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  USER_SCHEMA,
  userRecord,
} from './index';

function newAjv(): Ajv2020 {
  return new Ajv2020({ allowUnionTypes: true, allErrors: true });
}

const validate = newAjv().compile<UserRecord>(USER_SCHEMA);

/** What a sign-in on the owner's laptop writes. */
function laptopSignIn(): UserRecord {
  return userRecord({
    createdMs: 1_790_000_000_000,
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    hostLabel: 'office-mbp',
    nowMs: 1_790_000_123_456.7,
  });
}

/** A copy of `record` with `field` replaced, or removed when `value` is undefined. */
function changed(record: UserRecord, field: string, value: unknown): unknown {
  const copy: Record<string, unknown> = { ...record };
  if (value === undefined) {
    Reflect.deleteProperty(copy, field);
  } else {
    copy[field] = value;
  }
  return copy;
}

describe('userRecord', () => {
  it('writes users/{uid} as docs/DATA-MODEL.md §10 describes it: the account and this device', () => {
    expect(laptopSignIn()).toEqual({
      schema: 1,
      createdMs: 1_790_000_000_000,
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      devices: { 'office-mbp': 1_790_000_123_456.7 },
    });
  });

  it('keeps a label with spaces and dots as one key, as Settings lets one type it', () => {
    const record = userRecord({
      createdMs: 0,
      displayName: null,
      email: null,
      hostLabel: 'Ada’s phone v2.1',
      nowMs: 5,
    });
    expect(record.devices).toEqual({ 'Ada’s phone v2.1': 5 });
  });
});

describe('the JSON Schema of users/{uid}', () => {
  it('is draft 2020-12, compiles in ajv without a warning and has an $id of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      newAjv().compile(USER_SCHEMA);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(USER_SCHEMA['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const others = [
      ATTEMPT_SCHEMA,
      ATTEMPT_SCHEMA_V1,
      FRAMES_SCHEMA,
      SESSION_SCHEMA,
      SESSION_SCHEMA_V1,
    ];
    expect(others.map((schema) => schema['$id'])).not.toContain(USER_SCHEMA['$id']);
    expect(USER_SCHEMA['$id']).toMatch(/\/user\.schema\.json$/);
  });

  it('accepts what a sign-in writes, an account without a name or an email, and several devices', () => {
    const record = laptopSignIn();
    const merged = {
      ...record,
      devices: { ...record.devices, 'Android phone': 1_790_000_200_000 },
    };
    for (const valid of [
      record,
      changed(record, 'displayName', null),
      changed(record, 'email', null),
      merged,
    ]) {
      expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each([
    ['schema version 2', 'schema', 2],
    ['no schema', 'schema', undefined],
    ['no creation time', 'createdMs', undefined],
    ['a creation time that is text', 'createdMs', 'Wed, 01 Oct 2026 12:00:00 GMT'],
    ['a negative creation time', 'createdMs', -1],
    ['no name field', 'displayName', undefined],
    ['a name that is a number', 'displayName', 42],
    ['no email field', 'email', undefined],
    ['no devices', 'devices', undefined],
    ['devices as a list', 'devices', ['office-mbp']],
    ['a device seen at a time that is text', 'devices', { 'office-mbp': '1790000123456' }],
    ['a device without a label', 'devices', { '': 1_790_000_123_456 }],
    ['an unknown field', 'quota', { bytes: 1 }],
  ] as [string, string, unknown][])('rejects a record with %s', (_, field, value) => {
    expect(validate(laptopSignIn())).toBe(true);
    expect(validate(changed(laptopSignIn(), field, value))).toBe(false);
  });
});
