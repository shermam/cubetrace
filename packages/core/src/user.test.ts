import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { UserRecord, ViewerChoice, ViewerChoices } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  FRAMES_SCHEMA,
  MAX_VIEWER_CHOICES,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  USER_SCHEMA,
  VIEWER_DEFAULT,
  changedViewerChoices,
  clampLatitude,
  isViewerChoice,
  mergeViewerChoices,
  normalizeLongitude,
  parseViewerChoices,
  sameViewerChoice,
  userRecord,
  viewerChoice,
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

  it("accepts the clip viewer's choices per camera (T3.10), and refuses one that is not well formed", () => {
    const viewer: ViewerChoices = {
      laptop: { latitude: 0, longitude: 0, mirror: 'none' },
      'phone-rear': { latitude: 90, longitude: 180, mirror: 'left-right' },
      'phone-front': { latitude: -12.3, longitude: -179.9, mirror: 'all' },
    };
    expect(
      validate(changed(laptopSignIn(), 'viewer', viewer)),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(validate(changed(laptopSignIn(), 'viewer', {}))).toBe(true);
    const most = Object.fromEntries(
      Array.from({ length: MAX_VIEWER_CHOICES }, (_, k) => [`camera-${String(k)}`, VIEWER_DEFAULT]),
    );
    expect(validate(changed(laptopSignIn(), 'viewer', most))).toBe(true);
    for (const [what, bad] of [
      ['a list', [VIEWER_DEFAULT]],
      ['an empty label', { '': VIEWER_DEFAULT }],
      ['a latitude of 91', { laptop: { ...VIEWER_DEFAULT, latitude: 91 } }],
      ['a latitude of −91', { laptop: { ...VIEWER_DEFAULT, latitude: -91 } }],
      ['a longitude of 181', { laptop: { ...VIEWER_DEFAULT, longitude: 181 } }],
      ['a latitude that is text', { laptop: { ...VIEWER_DEFAULT, latitude: '0' } }],
      ['an unknown mirror', { laptop: { ...VIEWER_DEFAULT, mirror: 'sideways' } }],
      ['no mirror', { laptop: { latitude: 0, longitude: 0 } }],
      ['no longitude', { laptop: { latitude: 0, mirror: 'none' } }],
      ['a field more', { laptop: { ...VIEWER_DEFAULT, distance: 5 } }],
      ['a choice that is a number', { laptop: 1 }],
      ['one camera too many', { ...most, 'camera-more': VIEWER_DEFAULT }],
    ] as [string, unknown][]) {
      expect(validate(changed(laptopSignIn(), 'viewer', bad)), what).toBe(false);
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

describe("the clip viewer's choice per camera (T3.10)", () => {
  it('keeps the angles to a tenth of a degree, the latitude within ±90 and the longitude within (−180, 180]', () => {
    expect(viewerChoice(12.34, -20.06, 'none')).toEqual({
      latitude: 12.3,
      longitude: -20.1,
      mirror: 'none',
    });
    expect(viewerChoice(95, 270, 'all')).toEqual({ latitude: 90, longitude: -90, mirror: 'all' });
    expect(viewerChoice(-95, -180, 'up-down')).toEqual({
      latitude: -90,
      longitude: 180,
      mirror: 'up-down',
    });
    expect(viewerChoice(-0.04, 179.96, 'none')).toEqual({
      latitude: 0,
      longitude: 180,
      mirror: 'none',
    });
    expect(viewerChoice(-0.04, -179.96, 'none').longitude).toBe(180);
    expect(viewerChoice(0, 540, 'none').longitude).toBe(180);
    expect(viewerChoice(0, 0, 'front-back')).toEqual({ ...VIEWER_DEFAULT, mirror: 'front-back' });
    expect(Object.is(viewerChoice(-0.01, -0.01, 'none').latitude, -0)).toBe(false);
    expect(clampLatitude(100)).toBe(90);
    expect(clampLatitude(-100)).toBe(-90);
    expect(clampLatitude(12.5)).toBe(12.5);
    expect([0, 90, 180, -180, 181, -181, 360, 540, -90].map(normalizeLongitude)).toEqual([
      0, 90, 180, 180, -179, 179, 0, 180, -90,
    ]);
  });

  it('compares two choices by what they show: −180 and 180 are one longitude', () => {
    expect(sameViewerChoice(VIEWER_DEFAULT, { latitude: 0, longitude: 0, mirror: 'none' })).toBe(
      true,
    );
    expect(
      sameViewerChoice(
        { latitude: 90, longitude: 180, mirror: 'all' },
        { latitude: 90, longitude: -180, mirror: 'all' },
      ),
    ).toBe(true);
    expect(sameViewerChoice(VIEWER_DEFAULT, { ...VIEWER_DEFAULT, mirror: 'all' })).toBe(false);
    expect(sameViewerChoice(VIEWER_DEFAULT, { ...VIEWER_DEFAULT, latitude: 0.1 })).toBe(false);
    expect(sameViewerChoice(VIEWER_DEFAULT, { ...VIEWER_DEFAULT, longitude: -0.1 })).toBe(false);
  });

  it('parses the choices of a record, leaving out what is not well formed, at most the cap', () => {
    const laptop: ViewerChoice = { latitude: 90, longitude: -180, mirror: 'left-right' };
    expect(
      parseViewerChoices({ laptop, phone: { latitude: 1.23, longitude: 4.56, mirror: 'none' } }),
    ).toEqual({
      laptop: { latitude: 90, longitude: 180, mirror: 'left-right' },
      phone: { latitude: 1.2, longitude: 4.6, mirror: 'none' },
    });
    for (const nothing of [undefined, null, 'laptop', 42, [laptop], true]) {
      expect(parseViewerChoices(nothing)).toEqual({});
    }
    expect(
      parseViewerChoices({
        laptop,
        '': laptop,
        far: { ...laptop, latitude: 91 },
        wide: { ...laptop, longitude: 181 },
        text: { ...laptop, latitude: '90' },
        infinite: { ...laptop, longitude: Infinity },
        odd: { ...laptop, mirror: 'sideways' },
        bare: { latitude: 0, longitude: 0 },
        list: [0, 0, 'none'],
        none: null,
      }),
    ).toEqual({ laptop: { latitude: 90, longitude: 180, mirror: 'left-right' } });
    expect(isViewerChoice(laptop)).toBe(true);
    expect(isViewerChoice({ ...laptop, extra: 1 })).toBe(true);
    expect(isViewerChoice({ ...laptop, mirror: 'ALL' })).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: MAX_VIEWER_CHOICES + 2 }, (_, k) => [`camera-${String(k)}`, laptop]),
    );
    expect(Object.keys(parseViewerChoices(many))).toEqual(
      Object.keys(many).slice(0, MAX_VIEWER_CHOICES),
    );
  });

  it("merges the device's choices with the account's: the device's for the cameras it set, the account's for the others, the defaults for the rest", () => {
    const device: ViewerChoices = {
      laptop: { latitude: 0, longitude: 90, mirror: 'none' },
      'phone-rear': { latitude: 90, longitude: 0, mirror: 'up-down' },
    };
    const account: ViewerChoices = {
      laptop: { latitude: 0, longitude: 180, mirror: 'all' },
      'phone-front': { latitude: 0, longitude: 0, mirror: 'left-right' },
    };
    const merged = mergeViewerChoices(device, account);
    expect(merged).toEqual({
      laptop: device['laptop'],
      'phone-rear': device['phone-rear'],
      'phone-front': account['phone-front'],
    });
    // The device's first, in its order; the account's after.
    expect(Object.keys(merged)).toEqual(['laptop', 'phone-rear', 'phone-front']);
    expect(mergeViewerChoices({}, account)).toEqual(account);
    expect(mergeViewerChoices(device, {})).toEqual(device);
    expect(mergeViewerChoices({}, {})).toEqual({});
    // What the device then writes to the account: its own where they differ or are missing.
    expect(changedViewerChoices(account, merged)).toEqual({
      laptop: device['laptop'],
      'phone-rear': device['phone-rear'],
    });
    expect(changedViewerChoices(merged, merged)).toEqual({});
    expect(
      changedViewerChoices(
        { laptop: { latitude: 0, longitude: 180, mirror: 'all' } },
        { laptop: { latitude: 0, longitude: -180, mirror: 'all' } },
      ),
    ).toEqual({});
  });
});
