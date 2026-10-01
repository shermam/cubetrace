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
  cloudAttempt,
  cloudAttemptFields,
  cloudCube,
  cloudSession,
  createSession,
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

  it('refuses a new record without one of its fields', async () => {
    const db = alice().firestore();
    for (const field of ['schema', 'createdMs', 'displayName', 'email', 'devices']) {
      const record = user();
      Reflect.deleteProperty(record, field);
      await assertFails(db.doc('users/alice').set(record));
    }
  });

  it('keeps the collections under a record closed but its cubes (T3.4, below)', async () => {
    await seed('users/alice', user());
    const db = alice().firestore();
    for (const path of ['users/alice/sessions/one', 'users/alice/devices/office-mbp']) {
      await assertFails(db.doc(path).set({ mac: 'AB:12:CD:34:EF:56' }));
      await assertFails(db.doc(path).get());
    }
    await assertFails(db.collection('users/alice/macs').get());
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

  it.each([
    ['no schema', { schema: undefined }],
    ['a schema that is text', { schema: '2' }],
    ['an owner that is a number', { owner: 42 }],
    ['the id of another session', { id: BOBS_ID }],
    ['no id', { id: undefined }],
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
