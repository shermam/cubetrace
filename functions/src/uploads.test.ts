import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/https';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ObjectStore, ObjectToPut, SignedPut } from './object-store.js';
import {
  confirmUpload,
  signUpload,
  URL_LIFETIME_MS,
  type Call,
  type UploadDeps,
} from './uploads.js';

// signUpload and confirmUpload with the Admin SDK against the Firestore emulator that
// `npm run test:functions` starts (FIRESTORE_EMULATOR_HOST), under the offline project id
// demo-cubetrace, and a fake bucket in memory.

const projectId = 'demo-cubetrace';
const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
if (emulator === undefined) {
  throw new Error(
    'These tests need the Firestore emulator: run them with `npm run test:functions`.',
  );
}

const sessionId = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const bobsSession = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';
const session = `sessions/${sessionId}`;
const attempt = `${session}/attempts/0001`;
const prefix = `users/alice/sessions/${sessionId}`;
/** 2026-10-01 21:30:05.250 UTC, the evening of a practice session in Brazil. */
const evening = Date.UTC(2026, 9, 1, 21, 30, 5, 250);
const limits = { bytesPerDay: 100_000, filesPerDay: 10, maxFileBytes: 60_000 };

/** A bucket in memory: what was signed, and the objects the browser has PUT. */
class FakeBucket implements ObjectStore {
  readonly provider = 'fake';
  readonly bucket = 'cubetrace-test';
  readonly signed: (ObjectToPut & { signedAtMs: number; expiresAtMs: number })[] = [];
  readonly objects = new Map<string, number>();
  failing = false;

  signPut(object: ObjectToPut, signedAtMs: number, expiresAtMs: number): Promise<SignedPut> {
    if (this.failing) {
      return Promise.reject(new Error('Permission iam.serviceAccounts.signBlob denied.'));
    }
    this.signed.push({ ...object, signedAtMs, expiresAtMs });
    return Promise.resolve({
      url: `https://bucket.test/${object.key}?expires=${String(expiresAtMs)}`,
      headers: { 'Content-Type': object.contentType },
    });
  }

  sizeOf(key: string): Promise<number | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  /** What the browser's PUT to a signed URL does. */
  put(key: string, bytes: number): void {
    this.objects.set(key, bytes);
  }
}

interface Entry {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
}

let app: App;
let db: Firestore;
let bucket: FakeBucket;
let entries: Entry[];
let clock: number;
let deps: UploadDeps;

beforeAll(() => {
  app = initializeApp({ projectId }, 'uploads-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  const response = await fetch(
    `http://${emulator}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  expect(response.ok).toBe(true);
  bucket = new FakeBucket();
  entries = [];
  clock = evening;
  deps = {
    db,
    store: bucket,
    limits,
    now: () => clock,
    log: {
      info: (message, fields) => entries.push({ level: 'info', message, fields }),
      warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
      error: (message, fields) => entries.push({ level: 'error', message, fields }),
    },
  };
  // Alice's session and its first attempt, as T3.1 indexes them, and Bob's session.
  await db.doc(session).set({ owner: 'alice', schema: 2, id: sessionId });
  await db.doc(attempt).set({
    owner: 'alice',
    schema: 2,
    index: 1,
    device: 'office-mbp',
    upload: { state: 'pending', files: {} },
  });
  await db.doc(`sessions/${bobsSession}`).set({ owner: 'bob', schema: 2, id: bobsSession });
});

/** A call by `uid` (none: signed out). */
function call(data: unknown, uid: string | null = 'alice'): Call {
  return { auth: uid === null ? null : { uid }, data };
}

function file(path: string, bytes: number): { path: string; bytes: number; contentType: string } {
  return { path, bytes, contentType: path.endsWith('.mp4') ? 'video/mp4' : 'application/json' };
}

/** An attempt's files: its record, one camera's solve clip and its frame times. */
const files = [
  file('attempt.json', 1_000),
  file('laptop.solve.mp4', 40_000),
  file('laptop.solve.frames.json', 2_000),
];

function signRequest(signed = files, attemptIndex = 1): unknown {
  return { sessionId, attemptIndex, files: signed };
}

function confirmRequest(paths: string[], attemptIndex = 1): unknown {
  return { sessionId, attemptIndex, files: paths.map((path) => ({ path })) };
}

async function data(path: string): Promise<Record<string, unknown> | undefined> {
  return (await db.doc(path).get()).data();
}

async function refusal(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error('Nothing was refused.');
}

describe('signUpload', () => {
  it('signs each file under the account’s prefix, for 15 minutes, in the order asked', async () => {
    const signed = await signUpload(deps, call(signRequest()));
    const signedAtMs = Date.UTC(2026, 9, 1, 21, 30, 5);
    expect(signed).toEqual(
      ['attempt.json', 'laptop.solve.mp4', 'laptop.solve.frames.json'].map((path) => ({
        path,
        url: `https://bucket.test/${prefix}/attempts/0001/${path}?expires=${String(signedAtMs + URL_LIFETIME_MS)}`,
        headers: { 'Content-Type': path.endsWith('.mp4') ? 'video/mp4' : 'application/json' },
        expiresAt: signedAtMs + 15 * 60 * 1000,
      })),
    );
    expect(
      bucket.signed.map(({ key, bytes, contentType }) => ({ key, bytes, contentType })),
    ).toEqual(
      files.map(({ path, bytes, contentType }) => ({
        key: `${prefix}/attempts/0001/${path}`,
        bytes,
        contentType,
      })),
    );
  });

  it('records the intent on the attempt, leaving the rest of the attempt as it was', async () => {
    await db.doc(attempt).update({ 'upload.queue': 'laptop' });
    await signUpload(deps, call(signRequest()));
    expect(await data(attempt)).toEqual({
      owner: 'alice',
      schema: 2,
      index: 1,
      device: 'office-mbp',
      upload: {
        state: 'uploading',
        queue: 'laptop',
        files: {
          'attempt.json': { bytes: 1_000, doneMs: null },
          'laptop.solve.mp4': { bytes: 40_000, doneMs: null },
          'laptop.solve.frames.json': { bytes: 2_000, doneMs: null },
        },
      },
    });
    expect(entries).toEqual([
      {
        level: 'info',
        message: 'signUpload: signed',
        fields: expect.objectContaining({
          uid: 'alice',
          sessionId,
          attemptIndex: 1,
          provider: 'fake',
          files: ['attempt.json', 'laptop.solve.mp4', 'laptop.solve.frames.json'],
          bytes: 43_000,
          quota: { day: '2026-10-01', bytes: 43_000, files: 3 },
        }) as unknown,
      },
    ]);
  });

  it("counts the day's quota in the account's record, which it creates when there is none", async () => {
    await signUpload(deps, call(signRequest()));
    expect(await data('users/alice')).toEqual({
      quota: { day: '2026-10-01', bytes: 43_000, files: 3 },
    });
    // A sign-in merges the record into it, and the quota goes on beside the record's fields.
    const record = {
      schema: 1,
      createdMs: 1_790_000_000_000,
      displayName: 'Alice',
      email: null,
      devices: { 'office-mbp': 1_790_000_123_456.7 },
    };
    await db.doc('users/alice').set(record, { merge: true });
    await signUpload(deps, call(signRequest([file('session.json', 500)])));
    expect(await data('users/alice')).toEqual({
      ...record,
      quota: { day: '2026-10-01', bytes: 43_500, files: 4 },
    });
  });

  it("signs session.json as the session's file, and records it on the attempt that carries it", async () => {
    const signed = await signUpload(deps, call(signRequest([file('session.json', 4_100)])));
    expect(signed[0]?.url).toContain(`${prefix}/session.json?`);
    expect(bucket.signed[0]?.key).toBe(`${prefix}/session.json`);
    expect((await data(attempt))?.['upload']).toEqual({
      state: 'uploading',
      files: { 'session.json': { bytes: 4_100, doneMs: null } },
    });
  });

  it('counts every signature, a file signed again included', async () => {
    await signUpload(deps, call(signRequest()));
    await signUpload(deps, call(signRequest([file('laptop.solve.mp4', 40_000)])));
    expect((await data('users/alice'))?.['quota']).toEqual({
      day: '2026-10-01',
      bytes: 83_000,
      files: 4,
    });
  });

  it('adds up calls made at the same time', async () => {
    await db.doc(`${session}/attempts/0002`).set({ owner: 'alice', index: 2 });
    await Promise.all([
      signUpload(deps, call(signRequest())),
      signUpload(deps, call(signRequest([file('attempt.json', 7_000)], 2))),
    ]);
    expect((await data('users/alice'))?.['quota']).toEqual({
      day: '2026-10-01',
      bytes: 50_000,
      files: 4,
    });
  });

  it("refuses past the day's quota, recording and counting nothing", async () => {
    await signUpload(deps, call(signRequest()));
    const before = await data(attempt);
    const error = await refusal(
      signUpload(deps, call(signRequest([file('laptop.scramble.mp4', 57_001)]))),
    );
    expect(error.code).toBe('resource-exhausted');
    expect(error.details).toEqual({
      used: { day: '2026-10-01', bytes: 43_000, files: 3 },
      requested: { bytes: 57_001, files: 1 },
      limits: { bytesPerDay: 100_000, filesPerDay: 10 },
      resetsAtMs: Date.UTC(2026, 9, 2),
    });
    expect(await data(attempt)).toEqual(before);
    expect((await data('users/alice'))?.['quota']).toEqual({
      day: '2026-10-01',
      bytes: 43_000,
      files: 3,
    });
    expect(entries.at(-1)).toEqual({
      level: 'warn',
      message: 'signUpload: refused',
      fields: expect.objectContaining({ uid: 'alice', code: 'resource-exhausted' }) as unknown,
    });
    // The day's files run out as its bytes do.
    for (let i = 0; i < 7; i += 1) {
      await signUpload(deps, call(signRequest([file('attempt.json', 1)])));
    }
    expect(
      (await refusal(signUpload(deps, call(signRequest([file('attempt.json', 1)]))))).code,
    ).toBe('resource-exhausted');
  });

  it('starts a new count at midnight UTC', async () => {
    clock = Date.UTC(2026, 9, 1, 23, 59, 30);
    await signUpload(
      deps,
      call(signRequest([file('laptop.solve.mp4', 60_000), file('laptop.scramble.mp4', 39_000)])),
    );
    expect(
      (await refusal(signUpload(deps, call(signRequest([file('attempt.json', 1_001)]))))).code,
    ).toBe('resource-exhausted');
    clock = Date.UTC(2026, 9, 2);
    await signUpload(deps, call(signRequest([file('attempt.json', 1_001)])));
    expect((await data('users/alice'))?.['quota']).toEqual({
      day: '2026-10-02',
      bytes: 1_001,
      files: 1,
    });
  });

  it('records and counts nothing when the bucket cannot sign, and logs why', async () => {
    bucket.failing = true;
    const before = await data(attempt);
    const error = await refusal(signUpload(deps, call(signRequest())));
    expect(error.code).toBe('internal');
    expect(await data(attempt)).toEqual(before);
    expect(await data('users/alice')).toBeUndefined();
    expect(entries).toEqual([
      {
        level: 'error',
        message: 'signUpload: failed',
        fields: expect.objectContaining({
          uid: 'alice',
          sessionId,
          attemptIndex: 1,
          error: expect.stringContaining('signBlob denied') as unknown,
        }) as unknown,
      },
    ]);
  });

  it('refuses anyone signed out', async () => {
    const error = await refusal(signUpload(deps, call(signRequest(), null)));
    expect(error.code).toBe('unauthenticated');
    expect(bucket.signed).toEqual([]);
    expect(entries[0]?.fields).toEqual(
      expect.objectContaining({ code: 'unauthenticated', sessionId }),
    );
  });

  it("refuses another account's session or attempt", async () => {
    const bobs = { sessionId: bobsSession, attemptIndex: 1, files };
    await db.doc(`sessions/${bobsSession}/attempts/0001`).set({ owner: 'bob', index: 1 });
    expect((await refusal(signUpload(deps, call(bobs)))).code).toBe('permission-denied');
    expect((await refusal(signUpload(deps, call(signRequest(), 'bob')))).code).toBe(
      'permission-denied',
    );
    // An attempt of another owner under Alice's session (the rules do not let it be written).
    await db.doc(`${session}/attempts/0003`).set({ owner: 'bob', index: 3 });
    expect((await refusal(signUpload(deps, call(signRequest(files, 3))))).code).toBe(
      'permission-denied',
    );
    expect(await data('users/bob')).toBeUndefined();
    expect(await data('users/alice')).toBeUndefined();
    expect(bucket.signed).toEqual([]);
  });

  it('refuses a session or an attempt that is not in the index yet', async () => {
    const missing = { sessionId: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', attemptIndex: 1, files };
    expect((await refusal(signUpload(deps, call(missing)))).code).toBe('not-found');
    expect((await refusal(signUpload(deps, call(signRequest(files, 2))))).code).toBe('not-found');
    expect(bucket.signed).toEqual([]);
  });

  it('says that an attempt is not in the index even when the bucket cannot sign', async () => {
    bucket.failing = true;
    expect((await refusal(signUpload(deps, call(signRequest(files, 2))))).code).toBe('not-found');
  });

  it('refuses files the dataset does not have, of the wrong type, or too large', async () => {
    for (const bad of [
      [file('notes.txt', 10)],
      [{ path: 'laptop.solve.mp4', bytes: 10, contentType: 'application/json' }],
      [file('laptop.solve.mp4', 60_001)],
    ]) {
      expect((await refusal(signUpload(deps, call(signRequest(bad))))).code).toBe(
        'invalid-argument',
      );
    }
    expect(bucket.signed).toEqual([]);
  });
});

describe('confirmUpload', () => {
  beforeEach(async () => {
    await signUpload(deps, call(signRequest()));
    clock = evening + 60_000;
  });

  it('marks each file found with its size, and the attempt done once every file is', async () => {
    bucket.put(`${prefix}/attempts/0001/attempt.json`, 1_000);
    bucket.put(`${prefix}/attempts/0001/laptop.solve.mp4`, 40_000);
    expect(
      await confirmUpload(deps, call(confirmRequest(['attempt.json', 'laptop.solve.mp4']))),
    ).toEqual({
      state: 'uploading',
      confirmed: [
        { path: 'attempt.json', bytes: 1_000, doneMs: evening + 60_000 },
        { path: 'laptop.solve.mp4', bytes: 40_000, doneMs: evening + 60_000 },
      ],
      pending: ['laptop.solve.frames.json'],
    });
    clock = evening + 90_000;
    bucket.put(`${prefix}/attempts/0001/laptop.solve.frames.json`, 2_000);
    expect(await confirmUpload(deps, call(confirmRequest(['laptop.solve.frames.json'])))).toEqual({
      state: 'done',
      confirmed: [{ path: 'laptop.solve.frames.json', bytes: 2_000, doneMs: evening + 90_000 }],
      pending: [],
    });
    expect((await data(attempt))?.['upload']).toEqual({
      state: 'done',
      files: {
        'attempt.json': { bytes: 1_000, doneMs: evening + 60_000 },
        'laptop.solve.mp4': { bytes: 40_000, doneMs: evening + 60_000 },
        'laptop.solve.frames.json': { bytes: 2_000, doneMs: evening + 90_000 },
      },
    });
    expect(entries.at(-1)).toEqual({
      level: 'info',
      message: 'confirmUpload: confirmed',
      fields: expect.objectContaining({ uid: 'alice', state: 'done', pending: 0 }) as unknown,
    });
  });

  it('confirms a file again without moving its time', async () => {
    bucket.put(`${prefix}/attempts/0001/attempt.json`, 1_000);
    await confirmUpload(deps, call(confirmRequest(['attempt.json'])));
    clock += 5_000;
    const again = await confirmUpload(deps, call(confirmRequest(['attempt.json'])));
    expect(again.confirmed).toEqual([
      { path: 'attempt.json', bytes: 1_000, doneMs: evening + 60_000 },
    ]);
  });

  it('refuses a file that is not in the bucket, or not of the size signed, marking nothing', async () => {
    bucket.put(`${prefix}/attempts/0001/attempt.json`, 1_000);
    const missing = await refusal(
      confirmUpload(deps, call(confirmRequest(['attempt.json', 'laptop.solve.mp4']))),
    );
    expect(missing.code).toBe('not-found');
    expect(missing.message).toContain('laptop.solve.mp4');
    bucket.put(`${prefix}/attempts/0001/laptop.solve.mp4`, 39_999);
    const short = await refusal(confirmUpload(deps, call(confirmRequest(['laptop.solve.mp4']))));
    expect(short.code).toBe('failed-precondition');
    expect(short.message).toContain('39999');
    expect((await data(attempt))?.['upload']).toEqual({
      state: 'uploading',
      files: {
        'attempt.json': { bytes: 1_000, doneMs: null },
        'laptop.solve.mp4': { bytes: 40_000, doneMs: null },
        'laptop.solve.frames.json': { bytes: 2_000, doneMs: null },
      },
    });
  });

  it('refuses a file that was not signed for the attempt', async () => {
    bucket.put(`${prefix}/attempts/0001/laptop.scramble.mp4`, 30_000);
    const error = await refusal(confirmUpload(deps, call(confirmRequest(['laptop.scramble.mp4']))));
    expect(error.code).toBe('failed-precondition');
    expect(error.message).toContain('signUpload first');
  });

  it('starts the attempt again when a file is signed again after it was done', async () => {
    for (const { path, bytes } of files) {
      bucket.put(`${prefix}/attempts/0001/${path}`, bytes);
    }
    await confirmUpload(deps, call(confirmRequest(files.map(({ path }) => path))));
    await signUpload(deps, call(signRequest([file('attempt.json', 1_200)])));
    expect((await data(attempt))?.['upload']).toEqual(
      expect.objectContaining({
        state: 'uploading',
        files: expect.objectContaining({
          'attempt.json': { bytes: 1_200, doneMs: null },
          'laptop.solve.mp4': { bytes: 40_000, doneMs: evening + 60_000 },
        }) as unknown,
      }),
    );
    // The old object is still there, with the old size: not the upload signed.
    expect((await refusal(confirmUpload(deps, call(confirmRequest(['attempt.json']))))).code).toBe(
      'failed-precondition',
    );
    bucket.put(`${prefix}/attempts/0001/attempt.json`, 1_200);
    expect((await confirmUpload(deps, call(confirmRequest(['attempt.json'])))).state).toBe('done');
  });

  it("refuses anyone signed out, and another account's attempt", async () => {
    bucket.put(`${prefix}/attempts/0001/attempt.json`, 1_000);
    expect(
      (await refusal(confirmUpload(deps, call(confirmRequest(['attempt.json']), null)))).code,
    ).toBe('unauthenticated');
    expect(
      (await refusal(confirmUpload(deps, call(confirmRequest(['attempt.json']), 'bob')))).code,
    ).toBe('permission-denied');
    expect(
      (await refusal(confirmUpload(deps, call(confirmRequest(['attempt.json'], 9))))).code,
    ).toBe('not-found');
  });
});
