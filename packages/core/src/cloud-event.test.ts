import { Ajv2020, type ErrorObject } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { CloudEvent, JsonSchema } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_CUBE_SCHEMA,
  CLOUD_EVENT_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  EVENT_DATA_MAX_KEYS,
  EVENT_ID,
  EVENT_TEXT_MAX_LENGTH,
  FRAMES_SCHEMA,
  GYRO_SCHEMA,
  RecordError,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  USER_SCHEMA,
  cloudEvent,
  eventId,
  isEventKind,
  parseCloudEvent,
  sanitizeEventData,
  scrubEventText,
} from './index';

// The diagnostics events in Firestore (docs/DATA-MODEL.md §10, docs/PLAN.md T3.9): what the builder
// writes, the JSON Schema, and the reader the app and the QA view read the documents back with, held
// to the schema field by field as cloud-cube.test.ts holds the cubes' reader to theirs; and the
// sanitizer that keeps every event to its shapes and free of what it must never carry.

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isCloudEvent = ajv.compile<CloudEvent>(CLOUD_EVENT_SCHEMA);

const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const APP = { version: '0.4.0', commit: 'abc1234' };
const LAPTOP = { label: 'office-mbp', platform: 'macOS', installed: false };

/** An attempt's end on the laptop, as SessionService records it. */
function attemptDone(): CloudEvent {
  return cloudEvent({
    tsMs: 1_790_000_012_345.5,
    kind: 'attempt.done',
    app: APP,
    device: LAPTOP,
    session: SESSION,
    attempt: 17,
    data: { status: 'solved', timeMs: 14_990, replayOk: true, clips: 2, gyroRateHz: null },
  });
}

/** A copy of `event` with `field` replaced, or removed when `value` is undefined. */
function changed(event: CloudEvent, field: string, value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...event };
  if (value === undefined) {
    Reflect.deleteProperty(copy, field);
  } else {
    copy[field] = value;
  }
  return copy;
}

describe('cloudEvent', () => {
  it('writes users/{uid}/events/{eventId} as docs/DATA-MODEL.md §10 describes it, in its order', () => {
    expect(attemptDone()).toEqual({
      schema: 1,
      tsMs: 1_790_000_012_345.5,
      kind: 'attempt.done',
      app: APP,
      device: LAPTOP,
      session: SESSION,
      attempt: 17,
      data: { status: 'solved', timeMs: 14_990, replayOk: true, clips: 2, gyroRateHz: null },
    });
    expect(Object.keys(attemptDone())).toEqual([
      'schema',
      'tsMs',
      'kind',
      'app',
      'device',
      'session',
      'attempt',
      'data',
    ]);
  });

  it('leaves the session and the attempt out of an event that belongs to none', () => {
    const start = cloudEvent({
      tsMs: 1_790_000_000_000,
      kind: 'app.start',
      app: APP,
      device: LAPTOP,
      data: { installed: false, online: true },
    });
    expect(Object.keys(start)).toEqual(['schema', 'tsMs', 'kind', 'app', 'device', 'data']);
    const alone = cloudEvent({
      tsMs: 1,
      kind: 'page.viewed',
      app: APP,
      device: LAPTOP,
      session: null,
      attempt: null,
      data: {},
    });
    expect('session' in alone || 'attempt' in alone).toBe(false);
    expect(cloudEvent({ ...start, session: '' })).not.toHaveProperty('session');
  });

  it('copies the build and the device rather than sharing them', () => {
    const app = { ...APP };
    const device = { ...LAPTOP };
    const event = cloudEvent({ tsMs: 1, kind: 'app.start', app, device, data: {} });
    app.commit = 'changed';
    device.label = 'changed';
    expect(event.app.commit).toBe('abc1234');
    expect(event.device.label).toBe('office-mbp');
  });

  it.each([
    ['one word', 'start'],
    ['an upper-case letter', 'App.start'],
    ['a space', 'app start'],
    ['a trailing dot', 'app.'],
    ['a digit first', '1app.start'],
    ['an underscore', 'app_start.now'],
    ['more than 64 characters', `app.${'x'.repeat(61)}`],
    ['nothing', ''],
  ])('refuses a kind with %s', (_, kind) => {
    expect(isEventKind(kind)).toBe(false);
    expect(() => cloudEvent({ tsMs: 1, kind, app: APP, device: LAPTOP, data: {} })).toThrow(
      RangeError,
    );
  });

  it('takes the kinds of the catalogue', () => {
    for (const kind of [
      'app.start',
      'attempt.done',
      'error.app',
      'upload.state',
      'sync.check',
      'cube.disconnected',
      'a.b.c',
      `app.${'x'.repeat(60)}`,
    ]) {
      expect(isEventKind(kind), kind).toBe(true);
    }
  });

  it('refuses an attempt that is not a positive integer', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        cloudEvent({ tsMs: 1, kind: 'attempt.done', app: APP, device: LAPTOP, attempt, data: {} }),
      ).toThrow(RangeError);
    }
  });
});

describe('eventId', () => {
  it('is the time as 13 digits, a dash and the suffix, so that the ids of a device sort by time', () => {
    expect(eventId(1_790_000_012_345.7, 'a1b2c3d4')).toBe('1790000012345-a1b2c3d4');
    expect(eventId(12_345, '00000000')).toBe('0000000012345-00000000');
    expect(eventId(-5, 'ffffffff')).toBe('0000000000000-ffffffff');
    const ids = [
      eventId(1_790_000_012_345, 'ffffffff'),
      eventId(1_790_000_012_346, '00000000'),
      eventId(1_790_000_012_345, '0000000a'),
    ];
    expect([...ids].sort()).toEqual([ids[2], ids[0], ids[1]]);
    for (const id of ids) {
      expect(id).toMatch(EVENT_ID);
    }
  });

  it('refuses a suffix that is not 8 hex digits', () => {
    for (const suffix of ['', 'abc', 'A1B2C3D4', 'g1b2c3d4', 'a1b2c3d4e']) {
      expect(() => eventId(1, suffix), suffix).toThrow(RangeError);
    }
  });
});

describe('sanitizeEventData', () => {
  it('keeps text, numbers, booleans and null, and one level of maps', () => {
    expect(
      sanitizeEventData({
        text: 'ok',
        count: 3,
        yes: true,
        none: null,
        nested: { a: 1, b: 'two', c: null, d: false },
      }),
    ).toEqual({
      text: 'ok',
      count: 3,
      yes: true,
      none: null,
      nested: { a: 1, b: 'two', c: null, d: false },
    });
  });

  it('leaves out what cannot be a fact: undefined, functions, symbols, and anything nested deeper', () => {
    expect(
      sanitizeEventData({
        gone: undefined,
        fn: () => 1,
        sym: Symbol('x'),
        map: { deep: { deeper: 1 }, fn: () => 2, kept: 'yes', list: ['a', 'b'] },
      }),
    ).toEqual({ map: { kept: 'yes', list: 'a, b' } });
  });

  it('reads a list as one text, and a number that is not finite as null', () => {
    expect(
      sanitizeEventData({
        files: ['laptop.scramble.mp4', 'laptop.solve.mp4', 3, true, null, { no: 1 }],
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        big: 12n,
      }),
    ).toEqual({
      files: 'laptop.scramble.mp4, laptop.solve.mp4, 3, true',
      nan: null,
      inf: null,
      big: 12,
    });
  });

  it(`keeps the first ${String(EVENT_DATA_MAX_KEYS)} facts`, () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`k${String(k)}`, k]));
    const kept = sanitizeEventData(many);
    expect(Object.keys(kept)).toHaveLength(EVENT_DATA_MAX_KEYS);
    expect(Object.keys(kept).at(-1)).toBe('k31');
  });

  it(`cuts a text to ${String(EVENT_TEXT_MAX_LENGTH)} characters, with an ellipsis`, () => {
    const long = 'x'.repeat(EVENT_TEXT_MAX_LENGTH + 100);
    const { message, nested } = sanitizeEventData({ message: long, nested: { message: long } });
    expect(message).toHaveLength(EVENT_TEXT_MAX_LENGTH);
    expect(message).toMatch(/…$/u);
    expect((nested as Record<string, string>)['message']).toHaveLength(EVENT_TEXT_MAX_LENGTH);
    expect(sanitizeEventData({ exact: 'y'.repeat(EVENT_TEXT_MAX_LENGTH) })['exact']).toHaveLength(
      EVENT_TEXT_MAX_LENGTH,
    );
  });

  it('scrubs MAC addresses and emails out of every text, in a fact, a map and a list', () => {
    expect(
      sanitizeEventData({
        message: 'check its MAC address: AB:12:CD:34:EF:56 may not be this cube',
        lower: 'ab-12-cd-34-ef-56 typed',
        who: 'ada@example.com signed in',
        nested: { reason: 'The cube AB:12:CD:34:EF:56 did not answer' },
        list: ['ada.lovelace@example.co.uk', 'fine'],
        notMac: 'AB12CD34EF56 and 2026-10-02',
      }),
    ).toEqual({
      message: 'check its MAC address: [mac] may not be this cube',
      lower: '[mac] typed',
      who: '[email] signed in',
      nested: { reason: 'The cube [mac] did not answer' },
      list: '[email], fine',
      notMac: 'AB12CD34EF56 and 2026-10-02',
    });
    expect(scrubEventText('')).toBe('');
    expect(scrubEventText('a session 3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f kept')).toBe(
      'a session 3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f kept',
    );
  });
});

describe('the JSON Schema of users/{uid}/events/{eventId}', () => {
  it('is draft 2020-12, compiles in ajv without a warning and has an $id of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      new Ajv2020({ allowUnionTypes: true }).compile(CLOUD_EVENT_SCHEMA);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(CLOUD_EVENT_SCHEMA['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(CLOUD_EVENT_SCHEMA['title']).toBe('users/{uid}/events/{eventId}');
    expect(CLOUD_EVENT_SCHEMA['$id']).toMatch(/\/cloud-event\.schema\.json$/);
    const others: JsonSchema[] = [
      ATTEMPT_SCHEMA,
      ATTEMPT_SCHEMA_V1,
      CLOUD_ATTEMPT_SCHEMA,
      CLOUD_CUBE_SCHEMA,
      CLOUD_SESSION_SCHEMA,
      FRAMES_SCHEMA,
      GYRO_SCHEMA,
      SESSION_SCHEMA,
      SESSION_SCHEMA_V1,
      USER_SCHEMA,
    ];
    expect(others.map((schema) => schema['$id'])).not.toContain(CLOUD_EVENT_SCHEMA['$id']);
    // The build has the shape every file gives it (T3.7).
    expect((CLOUD_EVENT_SCHEMA['properties'] as Record<string, unknown>)['app']).toMatchObject(
      (SESSION_SCHEMA['properties'] as Record<string, unknown>)['app'] as object,
    );
  });

  it('accepts what a device writes: with and without a session and an attempt, facts of every shape', () => {
    for (const valid of [
      attemptDone(),
      changed(attemptDone(), 'session', undefined),
      changed(attemptDone(), 'attempt', undefined),
      cloudEvent({ tsMs: 0, kind: 'app.start', app: APP, device: LAPTOP, data: {} }),
      cloudEvent({
        tsMs: 1,
        kind: 'cube.disconnected',
        app: APP,
        device: { label: 'Android phone', platform: '', installed: true },
        data: {
          reason: 'The Bluetooth connection was closed.',
          idleMs: 372_104,
          hidden: true,
          battery: null,
          facts: { visibilityState: 'hidden', hiddenMs: 311_875 },
          long: 'x'.repeat(EVENT_TEXT_MAX_LENGTH),
        },
      }),
      cloudEvent({
        tsMs: 1,
        kind: 'settings.changed',
        app: APP,
        device: LAPTOP,
        data: Object.fromEntries(
          Array.from({ length: EVENT_DATA_MAX_KEYS }, (_, k) => [`k${String(k)}`, k]),
        ),
      }),
    ]) {
      expect(isCloudEvent(valid), JSON.stringify(isCloudEvent.errors)).toBe(true);
    }
  });

  it.each([
    ['schema version 2', 'schema', 2],
    ['no schema', 'schema', undefined],
    ['no time', 'tsMs', undefined],
    ['a time that is text', 'tsMs', '1790000012345'],
    ['no kind', 'kind', undefined],
    ['a kind of one word', 'kind', 'start'],
    ['a kind in upper case', 'kind', 'App.Start'],
    ['a kind over 64 characters', 'kind', `app.${'x'.repeat(61)}`],
    ['no build', 'app', undefined],
    ['a build without its commit', 'app', { version: '0.4.0' }],
    ['a build with a field more', 'app', { ...APP, branch: 'main' }],
    ['no device', 'device', undefined],
    ['a device without a label', 'device', { label: '', platform: 'macOS', installed: false }],
    ['a device without installed', 'device', { label: 'office-mbp', platform: 'macOS' }],
    ['a device with a user agent', 'device', { ...LAPTOP, userAgent: 'Mozilla/5.0' }],
    ['an empty session', 'session', ''],
    ['a session that is a number', 'session', 7],
    ['an attempt of index 0', 'attempt', 0],
    ['an attempt that is not whole', 'attempt', 1.5],
    ['no facts', 'data', undefined],
    ['facts that are a list', 'data', ['solved']],
    ['a fact that is a list', 'data', { files: ['a', 'b'] }],
    ['a fact nested two levels down', 'data', { clock: { fit: { a: 1 } } }],
    ['a text over 500 characters', 'data', { message: 'x'.repeat(EVENT_TEXT_MAX_LENGTH + 1) }],
    [
      'more than 32 facts',
      'data',
      Object.fromEntries(Array.from({ length: 33 }, (_, k) => [`k${String(k)}`, k])),
    ],
    ['an unknown field', 'uid', 'ada'],
  ] as [string, string, unknown][])('refuses an event with %s', (_, field, value) => {
    const invalid = changed(attemptDone(), field, value);
    expect(isCloudEvent(invalid)).toBe(false);
    expect(() => parseCloudEvent(invalid)).toThrow(RecordError);
  });
});

describe('parseCloudEvent', () => {
  it('reads a document back as the builder wrote it, a new object', () => {
    const written = attemptDone();
    const read = parseCloudEvent(written);
    expect(read).toEqual(written);
    expect(read).not.toBe(written);
    expect(read.data).not.toBe(written.data);
    const bare = cloudEvent({ tsMs: 2, kind: 'app.start', app: APP, device: LAPTOP, data: {} });
    expect(parseCloudEvent(bare)).toEqual(bare);
    expect(parseCloudEvent(bare)).not.toHaveProperty('session');
  });

  it('names the field and the problem, with the document and its version', () => {
    expect(() => parseCloudEvent(changed(attemptDone(), 'kind', 'start'))).toThrow(
      'users/{uid}/events/{eventId} (schema 1): kind must be a dotted lowercase name of at most 64 characters, such as attempt.done, got "start".',
    );
    expect(() => parseCloudEvent(changed(attemptDone(), 'data', { a: { b: { c: 1 } } }))).toThrow(
      /data\.a\.b must be a text of at most 500 characters, a number, true, false or null, got an object/u,
    );
    expect(() => parseCloudEvent(changed(attemptDone(), 'schema', 2))).toThrow(
      'users/{uid}/events/{eventId}: schema must be 1, got 2.',
    );
    expect(() => parseCloudEvent('attempt.done')).toThrow(RecordError);
  });

  it('agrees with the schema on every refusal above and on what it accepts', () => {
    // The same documents, the schema and the reader side by side (the list above runs both).
    const errors = (document: unknown): ErrorObject[] | null | undefined => {
      isCloudEvent(document);
      return isCloudEvent.errors;
    };
    expect(errors(attemptDone())).toBeNull();
    expect(errors(changed(attemptDone(), 'attempt', '17'))).not.toBeNull();
    expect(() => parseCloudEvent(changed(attemptDone(), 'attempt', '17'))).toThrow(RecordError);
  });
});
