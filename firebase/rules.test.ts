import { readFileSync } from 'node:fs';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  AttemptMachine,
  MAX_VIEWER_CHOICES,
  cloudAttempt,
  cloudAttemptFields,
  cloudCube,
  cloudEvent,
  cloudSession,
  createSession,
  eventId,
  parseMoves,
  pendingUpload,
} from '@cubetrace/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// firebase/firestore.rules against the Firestore emulator that `npm run test:rules` starts (its
// address comes from FIRESTORE_EMULATOR_HOST). The project id starts with "demo-", which the emulator
// keeps offline: nothing here reaches the real project.

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-cubetrace',
    firestore: { rules: readFileSync(new URL('firestore.rules', import.meta.url), 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

function alice(): RulesTestContext {
  return env.authenticatedContext('alice', { email: 'alice@example.com' });
}

function bob(): RulesTestContext {
  return env.authenticatedContext('bob');
}

function nobody(): RulesTestContext {
  return env.unauthenticatedContext();
}

/** Writes `data` at `path` as an administrator would, past the rules. */
async function seed(path: string, data: Record<string, unknown>): Promise<void> {
  await env.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(path).set(data);
  });
}

/** users/{uid} as a sign-in on the laptop writes it (docs/DATA-MODEL.md §10). */
function user(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    createdMs: 1_790_000_000_000,
    displayName: 'Alice',
    email: 'alice@example.com',
    devices: { 'office-mbp': 1_790_000_123_456.7 },
    ...extra,
  };
}

/** A session, or an attempt, of `owner`, with a field the app would change later. */
function owned(owner: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { owner, schema: 2, notes: '', ...extra };
}

describe('users/{uid}', () => {
  it('lets an account create, read, merge into and delete its own record', async () => {
    const db = alice().firestore();
    await assertSucceeds(db.doc('users/alice').get());
    await assertSucceeds(db.doc('users/alice').set(user(), { merge: true }));
    await assertSucceeds(db.doc('users/alice').get());
    // A sign-in on another device: its entry is merged into devices, createdMs written again as it is.
    await assertSucceeds(
      db
        .doc('users/alice')
        .set(user({ devices: { 'Android phone': 1_790_000_200_000 } }), { merge: true }),
    );
    await assertSucceeds(db.doc('users/alice').delete());
  });

  it('refuses another account, and anyone signed out, any access to a record', async () => {
    await seed('users/alice', user());
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(db.doc('users/alice').get());
      await assertFails(db.doc('users/alice').set(user(), { merge: true }));
      await assertFails(db.doc('users/alice').update({ displayName: 'Mallory' }));
      await assertFails(db.doc('users/alice').delete());
    }
    await assertFails(nobody().firestore().doc('users/bob').set(user()));
  });

  it('refuses to list the records', async () => {
    await seed('users/alice', user());
    await seed('users/bob', user({ displayName: 'Bob', email: 'bob@example.com' }));
    await assertFails(alice().firestore().collection('users').get());
  });

  it('never changes createdMs once it is set', async () => {
    await seed('users/alice', user());
    const db = alice().firestore();
    await assertFails(
      db.doc('users/alice').set(user({ createdMs: 1_800_000_000_000 }), { merge: true }),
    );
    await assertFails(db.doc('users/alice').update({ createdMs: 0 }));
    await assertSucceeds(db.doc('users/alice').update({ displayName: 'Alice L.' }));
  });

  it('accepts only the fields of the record, so that the server keeps its own out of reach', async () => {
    const db = alice().firestore();
    await assertFails(db.doc('users/alice').set(user({ quota: { bytes: 1e12 } })));
    await assertSucceeds(db.doc('users/alice').set(user()));
    await assertFails(db.doc('users/alice').set({ quota: { bytes: 1e12 } }, { merge: true }));
    // A field the server wrote (T3.2's quota) stays, and the client's merge leaves it alone.
    await seed('users/alice', user({ quota: { bytes: 1 } }));
    await assertSucceeds(
      db.doc('users/alice').set(user({ devices: { laptop: 1_790_000_300_000 } }), { merge: true }),
    );
    await assertFails(db.doc('users/alice').update({ 'quota.bytes': 1e12 }));
  });

  it.each([
    ['schema version 2', { schema: 2 }],
    ['a creation time that is text', { createdMs: 'yesterday' }],
    ['a name that is a number', { displayName: 42 }],
    ['an email that is a list', { email: ['alice@example.com'] }],
    ['devices that are a list', { devices: ['office-mbp'] }],
  ])('refuses a record with %s', async (_, change) => {
    await assertFails(alice().firestore().doc('users/alice').set(user(change)));
  });

  it('refuses a new record without one of its fields (the viewer of T3.10 is optional)', async () => {
    const db = alice().firestore();
    for (const field of ['schema', 'createdMs', 'displayName', 'email', 'devices']) {
      const record = user();
      Reflect.deleteProperty(record, field);
      await assertFails(db.doc('users/alice').set(record));
    }
    await assertSucceeds(db.doc('users/alice').set(user()));
  });

  it('keeps the collections under a record closed but its cubes (T3.4) and its events (T3.9, below)', async () => {
    await seed('users/alice', user());
    const db = alice().firestore();
    for (const path of ['users/alice/sessions/one', 'users/alice/devices/office-mbp']) {
      await assertFails(db.doc(path).set({ mac: 'AB:12:CD:34:EF:56' }));
      await assertFails(db.doc(path).get());
    }
    await assertFails(db.collection('users/alice/macs').get());
  });
});

// The clip viewer's choice per camera in the account's record (T3.10, docs/DATA-MODEL.md §10):
// users/{uid}.viewer, which the app merges into the record apart from the sign-in's write, one
// camera's choice at a time.
const FRONT = { latitude: 0, longitude: 0, mirror: 'none' };
const BEHIND_ABOVE = { latitude: 90, longitude: 180, mirror: 'left-right' };

/** A viewer map of `count` cameras, each seen from the front. */
function cameras(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, k) => [`camera-${String(k)}`, FRONT]),
  );
}

describe('users/{uid}.viewer (T3.10)', () => {
  it("lets the account merge a camera's choice into its record, keep the others, replace one and read them back", async () => {
    await seed('users/alice', user());
    const db = alice().firestore();
    await assertSucceeds(
      db.doc('users/alice').set({ viewer: { laptop: BEHIND_ABOVE } }, { merge: true }),
    );
    await assertSucceeds(
      db.doc('users/alice').set({ viewer: { 'phone-rear': FRONT } }, { merge: true }),
    );
    const replaced = { latitude: -12.3, longitude: -179.9, mirror: 'all' };
    await assertSucceeds(
      db.doc('users/alice').set({ viewer: { laptop: replaced } }, { merge: true }),
    );
    let snapshot = await assertSucceeds(db.doc('users/alice').get());
    expect(snapshot.data()?.['viewer']).toEqual({ laptop: replaced, 'phone-rear': FRONT });
    // The sign-in's write of the record leaves the choices as they are.
    await assertSucceeds(
      db.doc('users/alice').set(user({ devices: { phone: 1_790_000_300_000 } }), { merge: true }),
    );
    snapshot = await assertSucceeds(db.doc('users/alice').get());
    expect(snapshot.data()?.['viewer']).toEqual({ laptop: replaced, 'phone-rear': FRONT });
    expect(snapshot.data()?.['devices']).toEqual({
      'office-mbp': 1_790_000_123_456.7,
      phone: 1_790_000_300_000,
    });
    // The map written whole: a camera's choice gone.
    await assertSucceeds(db.doc('users/alice').update({ viewer: { laptop: FRONT } }));
    snapshot = await assertSucceeds(db.doc('users/alice').get());
    expect(snapshot.data()?.['viewer']).toEqual({ laptop: FRONT });
    // A record created with choices in it, and the most cameras the rules take: merged beside the
    // one there (the cap is on the whole map: one more camera merged in is refused), and written whole.
    await assertSucceeds(
      bob()
        .firestore()
        .doc('users/bob')
        .set(user({ viewer: { laptop: FRONT } })),
    );
    await assertSucceeds(
      db.doc('users/alice').set({ viewer: cameras(MAX_VIEWER_CHOICES - 1) }, { merge: true }),
    );
    await assertFails(
      db.doc('users/alice').set({ viewer: { 'one-more': FRONT } }, { merge: true }),
    );
    await assertSucceeds(db.doc('users/alice').set(user({ viewer: cameras(MAX_VIEWER_CHOICES) })));
    await assertSucceeds(db.doc('users/alice').set(user({ viewer: {} })));
  });

  it("merges a choice into a record that holds the functions' quota, which stays", async () => {
    const quota = { day: '2026-10-02', bytes: 43_000, files: 3 };
    await seed('users/alice', user({ quota }));
    const db = alice().firestore();
    await assertSucceeds(db.doc('users/alice').set({ viewer: { laptop: FRONT } }, { merge: true }));
    const snapshot = await assertSucceeds(db.doc('users/alice').get());
    expect(snapshot.data()?.['quota']).toEqual(quota);
    expect(snapshot.data()?.['viewer']).toEqual({ laptop: FRONT });
  });

  it.each([
    ['a list of choices', [FRONT]],
    ['a choice that is a number', { laptop: 1 }],
    ['a latitude of 91', { laptop: { ...FRONT, latitude: 91 } }],
    ['a latitude of −91', { laptop: { ...FRONT, latitude: -91 } }],
    ['a longitude of 181', { laptop: { ...FRONT, longitude: 181 } }],
    ['a longitude of −181', { laptop: { ...FRONT, longitude: -181 } }],
    ['a latitude that is text', { laptop: { ...FRONT, latitude: '0' } }],
    ['a longitude that is null', { laptop: { ...FRONT, longitude: null } }],
    ['an unknown mirror', { laptop: { ...FRONT, mirror: 'sideways' } }],
    ['a mirror that is a number', { laptop: { ...FRONT, mirror: 1 } }],
    ['no mirror', { laptop: { latitude: 0, longitude: 0 } }],
    ['no latitude', { laptop: { longitude: 0, mirror: 'none' } }],
    ['a field more', { laptop: { ...FRONT, distance: 5 } }],
    ['a bad choice after good ones', { ...cameras(3), bad: { ...FRONT, mirror: 'sideways' } }],
    [
      'a bad choice as the last one the rules take',
      { ...cameras(MAX_VIEWER_CHOICES - 1), bad: { ...FRONT, latitude: 100 } },
    ],
    ['one camera too many', cameras(MAX_VIEWER_CHOICES + 1)],
  ] as [string, unknown][])(
    'refuses the viewer with %s, merged or written whole',
    async (_, viewer) => {
      await seed('users/alice', user());
      const db = alice().firestore();
      await assertFails(db.doc('users/alice').set({ viewer }, { merge: true }));
      await assertFails(db.doc('users/alice').set(user({ viewer })));
      await assertFails(db.doc('users/alice').update({ viewer }));
      await assertSucceeds(
        db.doc('users/alice').set({ viewer: { laptop: FRONT } }, { merge: true }),
      );
    },
  );

  it("refuses another account, and anyone signed out, the choices of someone's record", async () => {
    await seed('users/alice', user({ viewer: { laptop: FRONT } }));
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(
        db.doc('users/alice').set({ viewer: { laptop: BEHIND_ABOVE } }, { merge: true }),
      );
      await assertFails(db.doc('users/alice').update({ 'viewer.laptop': BEHIND_ABOVE }));
    }
  });
});

// The account's cubes (T3.4, docs/DATA-MODEL.md §10): users/{uid}/cubes/{name}, Settings' list of
// the cubes' MAC addresses, one document per cube by its Bluetooth name.
const CUBE = 'users/alice/cubes/GAN12ui_AB12';

/** users/alice/cubes/GAN12ui_AB12 as the laptop writes it (packages/core cloud-cube.ts). */
function cube(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...cloudCube({
      name: 'GAN12ui_AB12',
      mac: 'AB:12:CD:34:EF:56',
      updatedMs: 1_790_000_123_456.7,
      device: 'office-mbp',
    }),
    ...extra,
  };
}

describe('users/{uid}/cubes/{name}', () => {
  it('lets an account write, read, list, replace and delete its own cubes, with or without its record', async () => {
    const db = alice().firestore();
    await assertSucceeds(db.doc(CUBE).set(cube()));
    await assertSucceeds(db.doc(CUBE).get());
    await assertSucceeds(db.collection('users/alice/cubes').get());
    // Changed on the phone: the whole entry written again.
    await assertSucceeds(
      db
        .doc(CUBE)
        .set(
          cube({ mac: '11:22:33:44:55:66', updatedMs: 1_790_000_200_000, device: 'Android phone' }),
        ),
    );
    await assertSucceeds(db.doc(CUBE).update({ updatedMs: 1_790_000_300_000 }));
    await assertSucceeds(db.doc(CUBE).delete());
    // A name as Chrome's list may show it, with spaces; and the account's record beside it.
    await seed('users/alice', user());
    await assertSucceeds(
      db.doc('users/alice/cubes/GAN 356 i3').set(cube({ name: 'GAN 356 i3', updatedMs: 0 })),
    );
    const listed = await assertSucceeds(db.collection('users/alice/cubes').get());
    expect(listed.docs.map((document) => document.id)).toEqual(['GAN 356 i3']);
  });

  it("refuses another account, and anyone signed out, any access to an account's cubes", async () => {
    await seed(CUBE, cube());
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(db.doc(CUBE).get());
      await assertFails(db.collection('users/alice/cubes').get());
      await assertFails(db.doc(CUBE).set(cube()));
      await assertFails(db.doc(CUBE).update({ mac: '11:22:33:44:55:66' }));
      await assertFails(db.doc(CUBE).delete());
      await assertFails(
        db.doc('users/alice/cubes/GAN12ui_CD34').set(cube({ name: 'GAN12ui_CD34' })),
      );
    }
    // Bob's own list is his.
    await assertSucceeds(bob().firestore().doc('users/bob/cubes/GAN12ui_AB12').set(cube()));
  });

  it.each([
    ['schema version 2', { schema: 2 }],
    ['no schema', { schema: undefined }],
    ['the name of another cube', { name: 'GAN12ui_CD34' }],
    ['its name in another case', { name: 'gan12ui_ab12' }],
    ['no name', { name: undefined }],
    ['a MAC address in lower case', { mac: 'ab:12:cd:34:ef:56' }],
    ['a MAC address with dashes', { mac: 'AB-12-CD-34-EF-56' }],
    ['a MAC address without separators', { mac: 'AB12CD34EF56' }],
    ['a MAC address of five bytes', { mac: 'AB:12:CD:34:EF' }],
    ['a MAC address with a byte more', { mac: 'AB:12:CD:34:EF:56:78' }],
    ['a MAC address after other text', { mac: 'mac AB:12:CD:34:EF:56' }],
    ['a MAC address that is a number', { mac: 188_000_000_000_000 }],
    ['no MAC address', { mac: undefined }],
    ['a time that is text', { updatedMs: '1790000123456' }],
    ['a negative time', { updatedMs: -1 }],
    ['no time', { updatedMs: undefined }],
    ['an empty device', { device: '' }],
    ['a device that is a number', { device: 7 }],
    ['no device', { device: undefined }],
    ['an unknown field', { owner: 'alice' }],
  ] as [string, Record<string, unknown>][])('refuses a cube with %s', async (_, change) => {
    const document = cube();
    for (const [field, value] of Object.entries(change)) {
      if (value === undefined) {
        Reflect.deleteProperty(document, field);
      } else {
        document[field] = value;
      }
    }
    const db = alice().firestore();
    await assertFails(db.doc(CUBE).set(document));
    // Nor can an update leave a stored cube so.
    await seed(CUBE, cube());
    await assertFails(db.doc(CUBE).set(document));
    await assertSucceeds(db.doc(CUBE).set(cube()));
  });
});

// The account's diagnostics events (T3.9, docs/DATA-MODEL.md §10, docs/DIAGNOSTICS.md):
// users/{uid}/events/{eventId}, one fact each about the app's use, created by the account's devices
// and never changed.
const EVENT_ID = eventId(1_790_000_012_345, 'a1b2c3d4');
const EVENT = `users/alice/events/${EVENT_ID}`;

/** An event of the laptop (packages/core cloud-event.ts), an attempt's end. */
function event(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...cloudEvent({
      tsMs: 1_790_000_012_345,
      kind: 'attempt.done',
      app: { version: '0.4.0', commit: 'abc1234' },
      device: { label: 'office-mbp', platform: 'macOS', installed: false },
      session: '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f',
      attempt: 17,
      data: { status: 'solved', timeMs: 14_990, replayOk: true, gyroRateHz: null },
    }),
    ...extra,
  };
}

describe('users/{uid}/events/{eventId}', () => {
  it('lets an account create its own events, one by one and in a batch, and read and list them, newest first', async () => {
    const db = alice().firestore();
    await assertSucceeds(db.doc(EVENT).set(event()));
    const batch = db.batch();
    for (let k = 1; k <= 20; k++) {
      const tsMs = 1_790_000_012_345 + k;
      batch.set(
        db.doc(`users/alice/events/${eventId(tsMs, 'a1b2c3d4')}`),
        event({ tsMs, kind: k % 2 === 0 ? 'clip.saved' : 'page.viewed' }),
      );
    }
    await assertSucceeds(batch.commit());
    await assertSucceeds(db.doc(EVENT).get());
    const listed = await assertSucceeds(
      db.collection('users/alice/events').orderBy('tsMs', 'desc').limit(500).get(),
    );
    expect(listed.size).toBe(21);
    expect(listed.docs[0].get('tsMs')).toBe(1_790_000_012_365);
    // An event that belongs to no session or attempt, and one of the installed app on a phone.
    await assertSucceeds(
      db.doc(`users/alice/events/${eventId(1_790_000_000_000, '00000000')}`).set(
        cloudEvent({
          tsMs: 1_790_000_000_000,
          kind: 'app.start',
          app: { version: '0.4.0', commit: 'abc1234' },
          device: { label: 'Android phone', platform: 'Android', installed: true },
          data: { installed: true, online: true, persisted: 'persistent', previousCommit: null },
        }),
      ),
    );
  });

  it('never changes or deletes an event, not even for its owner', async () => {
    await seed(EVENT, event());
    const db = alice().firestore();
    await assertFails(db.doc(EVENT).set(event({ kind: 'attempt.deleted' })));
    await assertFails(db.doc(EVENT).set({ data: { status: 'dnf' } }, { merge: true }));
    await assertFails(db.doc(EVENT).update({ 'data.status': 'dnf' }));
    await assertFails(db.doc(EVENT).delete());
  });

  it("refuses another account, and anyone signed out, any access to an account's events", async () => {
    await seed(EVENT, event());
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(db.doc(EVENT).get());
      await assertFails(db.collection('users/alice/events').get());
      await assertFails(db.doc(`users/alice/events/${eventId(1, 'ffffffff')}`).set(event()));
      await assertFails(db.doc(EVENT).delete());
    }
    // Bob's own events are his.
    await assertSucceeds(bob().firestore().doc(`users/bob/events/${EVENT_ID}`).set(event()));
    await assertFails(bob().firestore().collection('users/alice/events').limit(1).get());
  });

  it.each([
    ['schema version 2', { schema: 2 }],
    ['no schema', { schema: undefined }],
    ['no time', { tsMs: undefined }],
    ['a time that is text', { tsMs: '1790000012345' }],
    ['no kind', { kind: undefined }],
    ['a kind of one word', { kind: 'start' }],
    ['a kind in upper case', { kind: 'App.Start' }],
    ['a kind with a space', { kind: 'app start.now' }],
    ['a kind over 64 characters', { kind: `app.${'x'.repeat(61)}` }],
    ['no build', { app: undefined }],
    ['a build that is text', { app: '0.4.0' }],
    ['a build without its commit', { app: { version: '0.4.0' } }],
    ['a build with a field more', { app: { version: '0.4.0', commit: 'abc1234', branch: 'main' } }],
    ['no device', { device: undefined }],
    ['a device without a label', { device: { label: '', platform: 'macOS', installed: false } }],
    ['a device without installed', { device: { label: 'office-mbp', platform: 'macOS' } }],
    [
      'a device with a user agent',
      { device: { label: 'office-mbp', platform: 'macOS', installed: false, userAgent: 'Chrome' } },
    ],
    ['an empty session', { session: '' }],
    ['a session that is a number', { session: 7 }],
    ['an attempt of index 0', { attempt: 0 }],
    ['an attempt that is text', { attempt: '17' }],
    ['no facts', { data: undefined }],
    ['facts that are a list', { data: ['solved'] }],
    ['facts that are text', { data: 'solved' }],
    [
      'more than 32 facts',
      { data: Object.fromEntries(Array.from({ length: 33 }, (_, k) => [`k${String(k)}`, k])) },
    ],
    ['an unknown field', { uid: 'alice' }],
    ['an email', { email: 'alice@example.com' }],
  ] as [string, Record<string, unknown>][])('refuses an event with %s', async (_, change) => {
    const document = event();
    for (const [field, value] of Object.entries(change)) {
      if (value === undefined) {
        Reflect.deleteProperty(document, field);
      } else {
        document[field] = value;
      }
    }
    await assertFails(alice().firestore().doc(EVENT).set(document));
  });

  it('refuses an id that is not the time as 13 digits and 8 hex digits', async () => {
    const db = alice().firestore();
    for (const id of [
      'latest',
      '1790000012345',
      'a1b2c3d4',
      '1790000012345-A1B2C3D4',
      '1-a1b2c3d4',
    ]) {
      await assertFails(db.doc(`users/alice/events/${id}`).set(event()));
    }
  });
});

// The session index (T3.1, docs/DATA-MODEL.md §10): sessions/{id} and sessions/{id}/attempts/{index}.
const SESSION_ID = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const BOBS_ID = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';

/** sessions/{id} of `owner`, with what the rules read (and a field the app changes later). */
function sessionDoc(
  owner: string,
  id = SESSION_ID,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { schema: 2, id, owner, notes: '', ...extra };
}

/** sessions/{id}/attempts/0001 of `owner`, with what the rules read. */
function attemptDoc(
  owner: string,
  session = SESSION_ID,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 2,
    session,
    index: 1,
    owner,
    device: { host: 'office-mbp', cameras: ['laptop'] },
    upload: { state: 'pending', files: { 'attempt.json': { bytes: 5_000, doneMs: null } } },
    ...extra,
  };
}

/**
 * A real session and its first attempt as the app's index writes them (packages/core cloud.ts): the
 * attempt's document as created, with its upload, and its fields as written again (a clip attached).
 */
function appDocuments(owner: string): {
  session: Record<string, unknown>;
  attempt: Record<string, unknown>;
  fields: Record<string, unknown>;
} {
  const record = createSession({
    host: { label: 'office-mbp', userAgent: 'Chrome', platform: 'macOS', isPhone: false },
    cube: { model: 'GAN 12 ui FreePlay', hardware: 'GAN Gen2', firmware: '2.3.1', gyro: true },
    settings: { inspection15s: false, autoAdvance: true },
    appVersion: '0.3.0',
    commit: 'abc1234',
    nowMs: 1_790_000_000_000,
    id: SESSION_ID,
  });
  const machine = new AttemptMachine({
    session: SESSION_ID,
    index: 1,
    scramble: 'R U F',
    scrambleShownMs: 1_790_000_001_000,
  });
  let t = 1_790_000_002_000;
  for (const m of parseMoves("R U F F' U' R'")) {
    machine.onMove({ m, cubeMs: t - 1_790_000_000_000, hostMs: t });
    t += 400;
  }
  const attempt = cloudAttempt({
    attempt: machine.toRecord(),
    session: record,
    owner,
    upload: pendingUpload({ 'attempt.json': 6_000 }),
  });
  const fields = cloudAttemptFields({
    attempt: { ...machine.toRecord(), video: [] },
    session: { ...record, cameras: [] },
    owner,
  });
  return {
    session: cloudSession(record, owner) as unknown as Record<string, unknown>,
    attempt: attempt as unknown as Record<string, unknown>,
    fields,
  };
}

describe('sessions/{id}', () => {
  const session = `sessions/${SESSION_ID}`;

  it('lets an account create a session that names it as the owner, then read, update and delete it', async () => {
    const db = alice().firestore();
    await assertSucceeds(db.doc(session).set(sessionDoc('alice')));
    await assertSucceeds(db.doc(session).get());
    await assertSucceeds(db.doc(session).update({ notes: 'clip failed: …' }));
    await assertSucceeds(
      db.doc(session).set(sessionDoc('alice', SESSION_ID, { notes: '' }), { merge: true }),
    );
    await assertSucceeds(db.doc(session).delete());
  });

  it('takes the documents the app writes, the session and its first attempt in one batch, and lists them back', async () => {
    const db = alice().firestore();
    const { session: document, attempt, fields } = appDocuments('alice');
    const batch = db.batch();
    batch.set(db.doc(session), document, { merge: true });
    batch.set(db.doc(`${session}/attempts/0001`), attempt, { merge: true });
    await assertSucceeds(batch.commit());
    // The functions sign its upload (T3.2), then the app writes its fields again (a clip attached):
    // the upload stays theirs.
    await env.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc(`${session}/attempts/0001`)
        .update({ 'upload.state': 'uploading' });
    });
    await assertSucceeds(db.doc(`${session}/attempts/0001`).set(fields, { merge: true }));
    const stored = await db.doc(`${session}/attempts/0001`).get();
    expect(stored.get('upload.state')).toBe('uploading');
    await assertSucceeds(
      db
        .collection('sessions')
        .where('owner', '==', 'alice')
        .orderBy('createdMs', 'desc')
        .limit(100)
        .get(),
    );
    await assertSucceeds(db.collection(`${session}/attempts`).where('owner', '==', 'alice').get());
  });

  it('refuses a new session without its writer as the owner', async () => {
    const db = alice().firestore();
    await assertFails(db.doc(session).set(sessionDoc('bob')));
    const anonymous = sessionDoc('alice');
    Reflect.deleteProperty(anonymous, 'owner');
    await assertFails(db.doc(session).set(anonymous));
    await assertFails(nobody().firestore().doc(session).set(sessionDoc('alice')));
  });

  it("takes the fields of T3.7 in their shape: the battery reports and the cube's production date", async () => {
    const db = alice().firestore();
    const cube = {
      model: 'GAN 12 ui FreePlay',
      hardware: 'GAN Gen2',
      firmware: '2.3.1',
      gyro: true,
    };
    await assertSucceeds(
      db.doc(session).set(
        sessionDoc('alice', SESSION_ID, {
          cube: { ...cube, productDate: null },
          battery: [{ hostMs: 1_790_000_000_100.5, level: 83 }],
        }),
      ),
    );
    await assertSucceeds(
      db
        .doc(session)
        .set(sessionDoc('alice', SESSION_ID, { cube: { ...cube, productDate: '2025-03-14' } })),
    );
    // A session recorded before T3.7, written by the catch-up: neither field.
    await assertSucceeds(db.doc(session).set(sessionDoc('alice', SESSION_ID, { cube })));
    await assertSucceeds(db.doc(session).update({ battery: [] }));
  });

  it.each([
    ['no schema', { schema: undefined }],
    ['a schema that is text', { schema: '2' }],
    ['an owner that is a number', { owner: 42 }],
    ['the id of another session', { id: BOBS_ID }],
    ['no id', { id: undefined }],
    ['a cube that is text', { cube: 'GAN 12 ui' }],
    ['a production date that is a number', { cube: { model: 'GAN 12 ui', productDate: 2025 } }],
    ['battery reports that are a map', { battery: { level: 83 } }],
    ['battery reports that are a number', { battery: 83 }],
  ])('refuses a session document with %s', async (_, change) => {
    const document = sessionDoc('alice');
    for (const [field, value] of Object.entries(change)) {
      if (value === undefined) {
        Reflect.deleteProperty(document, field);
      } else {
        document[field] = value;
      }
    }
    await assertFails(alice().firestore().doc(session).set(document));
    // Nor can an update leave a stored session so.
    await seed(session, sessionDoc('alice'));
    await assertFails(alice().firestore().doc(session).set(document));
  });

  it('never changes the owner', async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    await assertFails(db.doc(session).update({ owner: 'bob' }));
    await assertFails(db.doc(session).set(sessionDoc('bob')));
    const anonymous = sessionDoc('alice');
    Reflect.deleteProperty(anonymous, 'owner');
    await assertFails(db.doc(session).set(anonymous));
  });

  it("refuses another account, and anyone signed out, any access to someone's session", async () => {
    await seed(session, sessionDoc('alice'));
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(db.doc(session).get());
      await assertFails(db.doc(session).update({ notes: 'mine now' }));
      await assertFails(db.doc(session).set(sessionDoc('bob')));
      await assertFails(db.doc(session).delete());
    }
  });

  it("lists an account's own sessions only when the query asks for them", async () => {
    await seed(session, sessionDoc('alice'));
    await seed(`sessions/${BOBS_ID}`, sessionDoc('bob', BOBS_ID));
    const db = alice().firestore();
    await assertSucceeds(db.collection('sessions').where('owner', '==', 'alice').get());
    await assertFails(db.collection('sessions').get());
    await assertFails(db.collection('sessions').orderBy('createdMs', 'desc').limit(100).get());
    await assertFails(db.collection('sessions').where('owner', '==', 'bob').get());
    await assertFails(bob().firestore().collection('sessions').where('owner', '==', 'alice').get());
  });
});

describe('sessions/{id}/attempts/{index}', () => {
  const session = `sessions/${SESSION_ID}`;
  const attempt = `${session}/attempts/0001`;
  const bobs = `sessions/${BOBS_ID}`;

  it("lets the session's owner create, read, update and delete its attempts", async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    await assertSucceeds(db.doc(attempt).set(attemptDoc('alice')));
    await assertSucceeds(db.doc(attempt).get());
    await assertSucceeds(db.doc(attempt).update({ 'device.cameras': ['laptop', 'phone-front'] }));
    await assertSucceeds(db.collection(`${session}/attempts`).where('owner', '==', 'alice').get());
    await assertSucceeds(db.doc(attempt).delete());
  });

  it("leaves an attempt's upload to the functions: the app creates it with the document, and never changes it", async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    await assertSucceeds(db.doc(attempt).set(attemptDoc('alice')));
    // Its other fields written again, with the upload or without it, as it is: taken.
    const fields = attemptDoc('alice', SESSION_ID, { device: { host: 'office-mbp', cameras: [] } });
    await assertSucceeds(db.doc(attempt).set(fields, { merge: true }));
    Reflect.deleteProperty(fields, 'upload');
    await assertSucceeds(db.doc(attempt).set(fields, { merge: true }));
    // A change of the upload, a field of it, or the upload gone: refused.
    await assertFails(db.doc(attempt).update({ 'upload.state': 'done' }));
    await assertFails(
      db.doc(attempt).set(
        {
          upload: { state: 'pending', files: { 'laptop.solve.mp4': { bytes: 1, doneMs: null } } },
        },
        { merge: true },
      ),
    );
    await assertFails(db.doc(attempt).set(fields));
    // As the functions left it (signed), the app's next write of the fields keeps it.
    await seed(
      attempt,
      attemptDoc('alice', SESSION_ID, {
        upload: { state: 'uploading', files: { 'attempt.json': { bytes: 5_000, doneMs: null } } },
      }),
    );
    await assertSucceeds(db.doc(attempt).set(fields, { merge: true }));
    await assertFails(db.doc(attempt).set(attemptDoc('alice'), { merge: true }));
    expect((await db.doc(attempt).get()).get('upload.state')).toBe('uploading');
  });

  it('lets a session and its first attempt be written in one batch', async () => {
    const db = alice().firestore();
    const batch = db.batch();
    batch.set(db.doc(session), sessionDoc('alice'));
    batch.set(db.doc(attempt), attemptDoc('alice'));
    await assertSucceeds(batch.commit());
  });

  it("refuses an attempt that does not name its writer, or under a session that is not the writer's", async () => {
    await seed(session, sessionDoc('alice'));
    await seed(bobs, sessionDoc('bob', BOBS_ID));
    const db = alice().firestore();
    await assertFails(db.doc(attempt).set(attemptDoc('bob')));
    const anonymous = attemptDoc('alice');
    Reflect.deleteProperty(anonymous, 'owner');
    await assertFails(db.doc(attempt).set(anonymous));
    // Alice's own attempt under Bob's session, or under no session at all.
    await assertFails(db.doc(`${bobs}/attempts/0001`).set(attemptDoc('alice', BOBS_ID)));
    const nowhere = '4b0f3c2a-0000-4000-8000-000000000000';
    await assertFails(
      db.doc(`sessions/${nowhere}/attempts/0001`).set(attemptDoc('alice', nowhere)),
    );
  });

  it("takes the fields of T3.7 in their shape: the build, the gyro file's summary and the resyncs", async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    const gyro = {
      file: 'gyro.json',
      samples: 1234,
      fromHostMs: 1_789_999_999_012.5,
      toHostMs: 1_790_000_024_340.7,
      rateHz: 48.7,
      truncatedStart: false,
    };
    const resync = {
      hostMs: 1_790_000_001_450.5,
      facelets: 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB',
      state: 'scrambling',
    };
    await assertSucceeds(
      db.doc(attempt).set(
        attemptDoc('alice', SESSION_ID, {
          app: { version: '0.4.0', commit: 'abc1234' },
          gyro,
          resyncs: [resync],
        }),
      ),
    );
    // Written again as the record changes (the gyro file attached a second after the end).
    await assertSucceeds(db.doc(attempt).set({ gyro: null }, { merge: true }));
    await assertSucceeds(db.doc(attempt).set({ gyro, resyncs: [] }, { merge: true }));
    // An attempt recorded before T3.7, written by the catch-up: none of the fields.
    await assertSucceeds(
      db.doc(`${session}/attempts/0002`).set(attemptDoc('alice', SESSION_ID, { index: 2 })),
    );
  });

  it.each([
    ['its moves', { moves: [{ m: 'R', hostMs: 1, cubeMs: 1, phase: 'solve' }] }],
    ['no moves but an empty list of them', { moves: [] }],
    ['no schema', { schema: undefined }],
    ['a schema that is text', { schema: '2' }],
    ['an owner that is a number', { owner: 7 }],
    ['the id of another session', { session: BOBS_ID }],
    ['another index than its path', { index: 2 }],
    ['an index that is text', { index: '1' }],
    ['no device', { device: undefined }],
    ['a device that is text', { device: 'office-mbp' }],
    ['no upload', { upload: undefined }],
    ['a build that is text', { app: '0.4.0' }],
    ['a build without its commit', { app: { version: '0.4.0' } }],
    ['a build with a field more', { app: { version: '0.4.0', commit: 'abc1234', branch: 'main' } }],
    ['a gyro summary that is text', { gyro: 'gyro.json' }],
    [
      'a gyro summary of another file',
      {
        gyro: {
          file: 'laptop.gyro.json',
          samples: 1,
          fromHostMs: 0,
          toHostMs: 0,
          rateHz: 0,
          truncatedStart: false,
        },
      },
    ],
    [
      'a gyro summary without samples',
      {
        gyro: {
          file: 'gyro.json',
          samples: 0,
          fromHostMs: 0,
          toHostMs: 0,
          rateHz: 0,
          truncatedStart: false,
        },
      },
    ],
    [
      'a gyro summary without its span',
      { gyro: { file: 'gyro.json', samples: 1, fromHostMs: 0, rateHz: 0, truncatedStart: false } },
    ],
    [
      'a gyro summary with a negative rate',
      {
        gyro: {
          file: 'gyro.json',
          samples: 1,
          fromHostMs: 0,
          toHostMs: 0,
          rateHz: -1,
          truncatedStart: false,
        },
      },
    ],
    [
      'a gyro summary with a field more',
      {
        gyro: {
          file: 'gyro.json',
          samples: 1,
          fromHostMs: 0,
          toHostMs: 0,
          rateHz: 0,
          truncatedStart: false,
          bytes: 1,
        },
      },
    ],
    ['resyncs that are a map', { resyncs: { hostMs: 1 } }],
    ['resyncs that are a number', { resyncs: 1 }],
  ])('refuses an attempt document with %s', async (_, change) => {
    await seed(session, sessionDoc('alice'));
    const document = attemptDoc('alice');
    for (const [field, value] of Object.entries(change)) {
      if (value === undefined) {
        Reflect.deleteProperty(document, field);
      } else {
        document[field] = value;
      }
    }
    const db = alice().firestore();
    await assertFails(db.doc(attempt).set(document));
    // Nor can an update leave a stored attempt so.
    await seed(attempt, attemptDoc('alice'));
    await assertFails(db.doc(attempt).set(document));
  });

  it('takes the index from the path, zero-padded as the folder', async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    await assertSucceeds(
      db.doc(`${session}/attempts/0017`).set(attemptDoc('alice', SESSION_ID, { index: 17 })),
    );
    await assertFails(db.doc(`${session}/attempts/latest`).set(attemptDoc('alice')));
  });

  it("never changes an attempt's owner, and refuses others any access", async () => {
    await seed(session, sessionDoc('alice'));
    await seed(attempt, attemptDoc('alice'));
    await assertFails(alice().firestore().doc(attempt).update({ owner: 'bob' }));
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(db.doc(attempt).get());
      await assertFails(db.doc(attempt).update({ 'upload.state': 'done' }));
      await assertFails(db.doc(attempt).delete());
      await assertFails(db.collection(`${session}/attempts`).get());
    }
    await assertFails(
      bob().firestore().collection(`${session}/attempts`).where('owner', '==', 'alice').get(),
    );
    await assertFails(alice().firestore().collection(`${session}/attempts`).get());
  });
});

// T3.3: once the upload queue deleted a clip's MP4 from the device (by policy, after its upload was
// confirmed), the attempt's record says so (video[].local false, docs/DATA-MODEL.md §7), and the app
// writes its document's fields again with it.
describe('an attempt whose clip left the device (T3.3)', () => {
  const path = `sessions/${SESSION_ID}/attempts/0001`;

  it("takes its fields written again with the clip's local false, the upload left as the functions left it", async () => {
    const { session, attempt, fields } = appDocuments('alice');
    const db = alice().firestore();
    const batch = db.batch();
    batch.set(db.doc(`sessions/${SESSION_ID}`), session);
    batch.set(db.doc(path), attempt);
    await assertSucceeds(batch.commit());
    const done = {
      state: 'done',
      files: {
        'attempt.json': { bytes: 6_000, doneMs: 1_790_000_100_000 },
        'laptop.solve.mp4': { bytes: 4_100_000, doneMs: 1_790_000_100_000 },
        'laptop.solve.frames.json': { bytes: 2_000, doneMs: 1_790_000_100_000 },
      },
    };
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc(path).update({ upload: done });
    });
    const clip = {
      camera: 'laptop',
      segment: 'solve',
      file: 'laptop.solve.mp4',
      bytes: 4_100_000,
      codec: 'avc1.640028',
      audio: 'mp4a.40.2',
      width: 1920,
      height: 1080,
      crop: null,
      fpsNominal: 30,
      frames: 300,
      firstFrameHostMs: 1_790_000_001_500,
      framesFile: 'laptop.solve.frames.json',
      syncResidualMs: null,
      truncatedStart: false,
      local: false,
    };
    await assertSucceeds(db.doc(path).set({ ...fields, video: [clip] }, { merge: true }));
    const stored = await db.doc(path).get();
    expect((stored.get('video') as { local?: boolean }[]).map((entry) => entry.local)).toEqual([
      false,
    ]);
    expect(stored.get('upload')).toEqual(done);
  });
});

// The signaling of a remote camera (T4.0, docs/RTC.md, docs/DATA-MODEL.md §10): the session's pairing,
// sessions/{id}/peers/{peerId} and its two candidate collections, all the session's owner's alone.
const TOKEN_HASH = '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069';
const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

/** The pairing the host publishes: the token's hash, good until `expiresMs`. */
function pairing(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tokenHash: TOKEN_HASH, expiresMs: 1_790_000_600_000, ...extra };
}

/** sessions/{id}/peers/{peerId} as the phone creates it, with `extra` changed. */
function peerDoc(owner: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    owner,
    role: 'camera',
    createdMs: 1_790_000_000_123.5,
    tokenHash: TOKEN_HASH,
    offer: { type: 'offer', sdp: SDP },
    answer: null,
    state: 'offered',
    ...extra,
  };
}

/** A candidate as either side writes it. */
function candidateDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate: 'candidate:1 1 udp 2122260223 192.168.0.7 54321 typ host generation 0',
    sdpMid: '0',
    sdpMLineIndex: 0,
    createdMs: 1_790_000_000_200,
    ...extra,
  };
}

describe("a session's pairing (T4.0)", () => {
  const session = `sessions/${SESSION_ID}`;

  it("lets the host publish the token's hash in its session's document, read it, and close it", async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    await assertSucceeds(db.doc(session).set({ pairing: pairing() }, { merge: true }));
    const stored = await assertSucceeds(db.doc(session).get());
    expect(stored.get('pairing')).toEqual(pairing());
    await assertSucceeds(db.doc(session).set({ pairing: null }, { merge: true }));
    expect((await db.doc(session).get()).get('pairing')).toBeNull();
    // A session created with its pairing, or written whole without one, is fine too.
    await assertSucceeds(
      db.doc(session).set(sessionDoc('alice', SESSION_ID, { pairing: pairing() })),
    );
    await assertSucceeds(db.doc(session).set(sessionDoc('alice')));
    // The record's saves merge around it.
    await assertSucceeds(db.doc(session).set({ pairing: pairing() }, { merge: true }));
    await assertSucceeds(
      db.doc(session).set(sessionDoc('alice', SESSION_ID, { notes: 'x' }), { merge: true }),
    );
    expect((await db.doc(session).get()).get('pairing')).toEqual(pairing());
  });

  it.each([
    ['a pairing that is text', TOKEN_HASH],
    ['a pairing without its hash', { expiresMs: 1_790_000_600_000 }],
    ['a pairing without its expiry', { tokenHash: TOKEN_HASH }],
    ['a hash in upper case', pairing({ tokenHash: TOKEN_HASH.toUpperCase() })],
    ['a hash of 63 digits', pairing({ tokenHash: TOKEN_HASH.slice(1) })],
    ['the token itself', pairing({ token: 'A1B2C3D4' })],
    ['an expiry that is text', pairing({ expiresMs: 'soon' })],
  ])('refuses %s', async (_, value) => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    await assertFails(db.doc(session).set({ pairing: value }, { merge: true }));
    await assertFails(db.doc(session).set(sessionDoc('alice', SESSION_ID, { pairing: value })));
  });

  it("refuses another account, and anyone signed out, the pairing of someone's session", async () => {
    await seed(session, sessionDoc('alice', SESSION_ID, { pairing: pairing() }));
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(db.doc(session).get());
      await assertFails(db.doc(session).set({ pairing: pairing() }, { merge: true }));
      await assertFails(db.doc(session).set({ pairing: null }, { merge: true }));
    }
  });
});

describe('sessions/{id}/peers/{peerId} (T4.0)', () => {
  const session = `sessions/${SESSION_ID}`;
  const peer = `${session}/peers/peer-1`;
  const callerCandidates = `${peer}/callerCandidates`;
  const calleeCandidates = `${peer}/calleeCandidates`;

  it("runs the signaling of the session's owner: the offer, the answer, the candidates of both sides, the deletion", async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    // The phone creates the peer with its offer and adds its candidates.
    await assertSucceeds(db.doc(peer).set(peerDoc('alice')));
    await assertSucceeds(db.collection(callerCandidates).add(candidateDoc()));
    await assertSucceeds(
      db
        .collection(callerCandidates)
        .add(candidateDoc({ candidate: '', sdpMid: null, sdpMLineIndex: null })),
    );
    // The host watches the peers it owns, reads the offer, answers, and adds its candidates.
    await assertSucceeds(db.collection(`${session}/peers`).where('owner', '==', 'alice').get());
    await assertSucceeds(db.doc(peer).get());
    await assertSucceeds(
      db.doc(peer).update({ answer: { type: 'answer', sdp: SDP }, state: 'answered' }),
    );
    await assertSucceeds(
      db.collection(calleeCandidates).add(candidateDoc({ sdpMid: '0', sdpMLineIndex: 0 })),
    );
    await assertSucceeds(db.collection(callerCandidates).orderBy('createdMs').get());
    await assertSucceeds(db.collection(calleeCandidates).get());
    // An ICE restart: the phone's new offer replaces the old, the answer goes.
    await assertSucceeds(
      db.doc(peer).update({
        offer: { type: 'offer', sdp: `${SDP}a=ice-options:trickle\r\n` },
        answer: null,
        state: 'offered',
      }),
    );
    // The phone leaves, the host deletes everything.
    await assertSucceeds(db.doc(peer).update({ state: 'closed' }));
    const candidates = await db.collection(callerCandidates).get();
    const batch = db.batch();
    for (const document of candidates.docs) {
      batch.delete(document.ref);
    }
    batch.delete(db.doc(peer));
    await assertSucceeds(batch.commit());
    // The phone, watching its document, sees it gone rather than a refusal.
    expect((await assertSucceeds(db.doc(peer).get())).exists).toBe(false);
    await assertFails(bob().firestore().doc(peer).get());
    await assertFails(nobody().firestore().doc(peer).get());
  });

  it('refuses a peer under a session of another account, or without its writer as the owner', async () => {
    await seed(session, sessionDoc('alice'));
    await seed(`sessions/${BOBS_ID}`, sessionDoc('bob', BOBS_ID));
    const db = alice().firestore();
    await assertFails(db.doc(`sessions/${BOBS_ID}/peers/peer-1`).set(peerDoc('alice')));
    await assertFails(db.doc(`sessions/${BOBS_ID}/peers/peer-1`).set(peerDoc('bob')));
    await assertFails(db.doc(peer).set(peerDoc('bob')));
    const anonymous = peerDoc('alice');
    Reflect.deleteProperty(anonymous, 'owner');
    await assertFails(db.doc(peer).set(anonymous));
    // A peer of a session that does not exist.
    await assertFails(
      db.doc(`sessions/${BOBS_ID.replace('9e8d', '1111')}/peers/peer-1`).set(peerDoc('alice')),
    );
  });

  it('refuses another account, and anyone signed out, any access to a peer and its candidates', async () => {
    await seed(session, sessionDoc('alice'));
    await seed(peer, peerDoc('alice'));
    await seed(`${callerCandidates}/c1`, candidateDoc());
    for (const db of [bob().firestore(), nobody().firestore()]) {
      await assertFails(db.doc(peer).get());
      await assertFails(db.doc(peer).update({ state: 'closed' }));
      await assertFails(
        db.doc(peer).update({ answer: { type: 'answer', sdp: SDP }, state: 'answered' }),
      );
      await assertFails(db.doc(peer).delete());
      await assertFails(db.collection(`${session}/peers`).where('owner', '==', 'alice').get());
      await assertFails(db.collection(callerCandidates).get());
      await assertFails(db.doc(`${callerCandidates}/c1`).get());
      await assertFails(db.collection(calleeCandidates).add(candidateDoc()));
      await assertFails(db.doc(`${callerCandidates}/c1`).delete());
    }
    // Nor may a query leave the owner out.
    await assertFails(alice().firestore().collection(`${session}/peers`).get());
  });

  it('never changes the owner, and keeps the document whole and valid after every write', async () => {
    await seed(session, sessionDoc('alice'));
    await seed(peer, peerDoc('alice'));
    const db = alice().firestore();
    await assertFails(db.doc(peer).update({ owner: 'bob' }));
    await assertFails(db.doc(peer).update({ state: 'paired' }));
    await assertFails(db.doc(peer).update({ answer: { type: 'offer', sdp: SDP } }));
    await assertFails(db.doc(peer).update({ answer: { type: 'answer', sdp: 'x'.repeat(20_001) } }));
    await assertFails(db.doc(peer).update({ answer: { type: 'answer' } }));
    await assertFails(db.doc(peer).update({ answer: { type: 'answer', sdp: SDP, ice: 'lite' } }));
    await assertFails(db.doc(peer).update({ device: 'Android phone' }));
    await assertFails(db.doc(peer).update({ tokenHash: 'A1B2C3D4' }));
    await assertSucceeds(
      db
        .doc(peer)
        .update({ answer: { type: 'answer', sdp: 'x'.repeat(20_000) }, state: 'answered' }),
    );
  });

  it.each([
    ['schema version 2', { schema: 2 }],
    ['no schema', { schema: undefined }],
    ['a role of host', { role: 'host' }],
    ['no creation time', { createdMs: undefined }],
    ['a creation time that is text', { createdMs: 'now' }],
    ['no token hash', { tokenHash: undefined }],
    ['a token hash in upper case', { tokenHash: TOKEN_HASH.toUpperCase() }],
    ['a token hash of 63 digits', { tokenHash: TOKEN_HASH.slice(1) }],
    ['no offer field', { offer: undefined }],
    ['an offer that is text', { offer: SDP }],
    ['an offer of type answer', { offer: { type: 'answer', sdp: SDP } }],
    ['an offer without its SDP', { offer: { type: 'offer' } }],
    ['an SDP that is a number', { offer: { type: 'offer', sdp: 1 } }],
    ['an SDP of 20,001 characters', { offer: { type: 'offer', sdp: 'x'.repeat(20_001) } }],
    ['an unknown field in a description', { offer: { type: 'offer', sdp: SDP, ice: 'lite' } }],
    ['no answer field', { answer: undefined }],
    ['an answer that is text', { answer: SDP }],
    ['a state of paired', { state: 'paired' }],
    ['no state', { state: undefined }],
    ['an unknown field', { device: 'Android phone' }],
  ])('refuses a peer document with %s', async (_, change) => {
    await seed(session, sessionDoc('alice'));
    const document = peerDoc('alice');
    for (const [field, value] of Object.entries(change)) {
      if (value === undefined) {
        Reflect.deleteProperty(document, field);
      } else {
        document[field] = value;
      }
    }
    await assertFails(alice().firestore().doc(peer).set(document));
  });

  it('accepts a peer without an offer yet, answered, or closed, and an SDP of 20,000 characters', async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    await assertSucceeds(db.doc(peer).set(peerDoc('alice', { offer: null })));
    await assertSucceeds(
      db
        .doc(peer)
        .set(peerDoc('alice', { answer: { type: 'answer', sdp: SDP }, state: 'answered' })),
    );
    await assertSucceeds(db.doc(peer).set(peerDoc('alice', { state: 'closed' })));
    await assertSucceeds(
      db.doc(peer).set(peerDoc('alice', { offer: { type: 'offer', sdp: 'x'.repeat(20_000) } })),
    );
  });

  it.each([
    ['no candidate', { candidate: undefined }],
    ['a candidate that is a number', { candidate: 1 }],
    ['a candidate of 1,001 characters', { candidate: 'c'.repeat(1001) }],
    ['a mid that is a number', { sdpMid: 0 }],
    ['a mid of 101 characters', { sdpMid: 'm'.repeat(101) }],
    ['no line index field', { sdpMLineIndex: undefined }],
    ['a negative line index', { sdpMLineIndex: -1 }],
    ['a fractional line index', { sdpMLineIndex: 0.5 }],
    ['no creation time', { createdMs: undefined }],
    ['an unknown field', { usernameFragment: 'abc' }],
  ])('refuses a candidate with %s', async (_, change) => {
    await seed(session, sessionDoc('alice'));
    await seed(peer, peerDoc('alice'));
    const document = candidateDoc();
    for (const [field, value] of Object.entries(change)) {
      if (value === undefined) {
        Reflect.deleteProperty(document, field);
      } else {
        document[field] = value;
      }
    }
    const db = alice().firestore();
    await assertFails(db.collection(callerCandidates).add(document));
    await assertFails(db.collection(calleeCandidates).add(document));
    await assertSucceeds(db.collection(callerCandidates).add(candidateDoc()));
  });

  it('keeps the candidates to their two collections under a peer that exists, and never changes one', async () => {
    await seed(session, sessionDoc('alice'));
    const db = alice().firestore();
    // No peer yet: no candidate (its collection lists as empty).
    await assertFails(db.collection(callerCandidates).add(candidateDoc()));
    expect((await assertSucceeds(db.collection(callerCandidates).get())).empty).toBe(true);
    await seed(peer, peerDoc('alice'));
    await assertFails(db.collection(`${peer}/candidates`).add(candidateDoc()));
    await assertFails(db.collection(`${peer}/notes`).add({ text: 'x' }));
    await assertFails(db.collection(`${peer}/notes`).get());
    await assertSucceeds(db.doc(`${callerCandidates}/c1`).set(candidateDoc()));
    await assertFails(db.doc(`${callerCandidates}/c1`).update({ createdMs: 1 }));
    await assertFails(db.doc(`${callerCandidates}/c1`).set(candidateDoc({ sdpMid: '1' })));
    await assertSucceeds(db.doc(`${callerCandidates}/c1`).delete());
    // A peer of another account under Alice's session (which only an administrator could write):
    // its candidates are Alice's, the session's owner's, and nobody else's.
    await seed(`${session}/peers/bobs`, peerDoc('bob'));
    await assertFails(
      bob().firestore().collection(`${session}/peers/bobs/callerCandidates`).add(candidateDoc()),
    );
    await assertFails(bob().firestore().collection(`${session}/peers/bobs/callerCandidates`).get());
    await assertSucceeds(db.collection(`${session}/peers/bobs/callerCandidates`).get());
  });
});

describe('everything else', () => {
  it('is closed: no collection outside users and sessions, for anyone', async () => {
    await seed('public/notice', { text: 'hello' });
    for (const db of [alice().firestore(), nobody().firestore()]) {
      await assertFails(db.doc('public/notice').get());
      await assertFails(db.doc('public/notice').set({ text: 'mine' }));
      await assertFails(db.collection('public').get());
      await assertFails(db.doc('attempts/0001').set(owned('alice')));
    }
  });
});

describe('users/{uid}.quota (T3.2)', () => {
  // The day's upload quota, which only the functions write (signUpload, with the Admin SDK).
  const quota = { day: '2026-10-01', bytes: 123_456_789, files: 12 };

  it('lets the account read the quota the functions keep in its record', async () => {
    await seed('users/alice', user({ quota }));
    const snapshot = await assertSucceeds(alice().firestore().doc('users/alice').get());
    expect(snapshot.get('quota')).toEqual(quota);
    await assertFails(bob().firestore().doc('users/alice').get());
  });

  it('refuses the account any write of its quota: creating, changing or removing it', async () => {
    const db = alice().firestore();
    await assertFails(db.doc('users/alice').set(user({ quota })));
    await assertFails(db.doc('users/alice').set(user({ quota }), { merge: true }));
    await seed('users/alice', user({ quota }));
    await assertFails(db.doc('users/alice').update({ 'quota.bytes': 0 }));
    await assertFails(db.doc('users/alice').update({ quota: null }));
    await assertFails(
      db.doc('users/alice').set({ quota: { ...quota, files: 0 } }, { merge: true }),
    );
    // The whole record written over, without the quota: that would remove it.
    await assertFails(db.doc('users/alice').set(user()));
    // A sign-in's merge leaves the quota as it is.
    await assertSucceeds(
      db.doc('users/alice').set(user({ devices: { laptop: 1_790_000_300_000 } }), { merge: true }),
    );
    const snapshot = await assertSucceeds(db.doc('users/alice').get());
    expect(snapshot.get('quota')).toEqual(quota);
  });

  it('keeps a record that holds a quota from being deleted, which would start the day again', async () => {
    await seed('users/alice', user({ quota }));
    await assertFails(alice().firestore().doc('users/alice').delete());
    await seed('users/alice', user());
    await assertSucceeds(alice().firestore().doc('users/alice').delete());
  });

  it('lets the first sign-in merge into a record that the functions created with the quota alone', async () => {
    await seed('users/alice', { quota });
    const db = alice().firestore();
    await assertSucceeds(db.doc('users/alice').set(user(), { merge: true }));
    const snapshot = await assertSucceeds(db.doc('users/alice').get());
    expect(snapshot.data()).toEqual(user({ quota }));
  });
});
