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

  it('keeps the collections under a record closed until a task opens them (T3.4: cubes)', async () => {
    await seed('users/alice', user());
    const db = alice().firestore();
    await assertFails(db.doc('users/alice/cubes/GAN12ui_AB12').set({ mac: 'AB:12:CD:34:EF:56' }));
    await assertFails(db.doc('users/alice/cubes/GAN12ui_AB12').get());
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

/** A real session and its first attempt as the app's index writes them (packages/core cloud.ts). */
function appDocuments(owner: string): {
  session: Record<string, unknown>;
  attempt: Record<string, unknown>;
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
  return {
    session: cloudSession(record, owner) as unknown as Record<string, unknown>,
    attempt: attempt as unknown as Record<string, unknown>,
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
    const { session: document, attempt } = appDocuments('alice');
    const batch = db.batch();
    batch.set(db.doc(session), document, { merge: true });
    batch.set(db.doc(`${session}/attempts/0001`), attempt, { merge: true });
    await assertSucceeds(batch.commit());
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
    await assertSucceeds(db.doc(attempt).update({ 'upload.state': 'done' }));
    await assertSucceeds(db.collection(`${session}/attempts`).where('owner', '==', 'alice').get());
    await assertSucceeds(db.doc(attempt).delete());
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
