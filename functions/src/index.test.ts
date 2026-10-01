import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/https';
import { beforeAll, describe, expect, it } from 'vitest';

// The deployed functions as Firebase runs them (index.ts: the configuration, the Admin SDK's default
// app against the Firestore emulator), with an R2 configuration that lacks its account id and keys.
// The configuration is read when the module loads, as on Cloud Functions, so it is set before the
// import.

Object.assign(process.env, {
  BUCKET_PROVIDER: 'r2',
  BUCKET_NAME: 'cubetrace',
  R2_ACCOUNT_ID: '',
  QUOTA_BYTES_PER_DAY: '2000000000',
  QUOTA_FILES_PER_DAY: '400',
  MAX_FILE_BYTES: '512000000',
});
const { confirmUpload, signUpload } = await import('./index.js');

const sessionId = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const data = {
  sessionId,
  attemptIndex: 1,
  files: [{ path: 'attempt.json', bytes: 10, contentType: 'application/json' }],
};

function request(uid?: string): CallableRequest {
  return {
    data,
    auth: uid === undefined ? undefined : { uid, token: {}, rawToken: '' },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest;
}

beforeAll(async () => {
  const db = getFirestore(getApps()[0] ?? initializeApp());
  await db.doc(`sessions/${sessionId}`).set({ owner: 'carol' });
  await db.doc(`sessions/${sessionId}/attempts/0001`).set({ owner: 'carol' });
});

describe('the deployed functions', () => {
  it('refuse anyone signed out', async () => {
    await expect(signUpload.run(request())).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(confirmUpload.run(request())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('fail each call, without failing to load, when the bucket is not configured', async () => {
    await expect(signUpload.run(request('carol'))).rejects.toMatchObject({ code: 'internal' });
    await expect(signUpload.run(request('carol'))).rejects.toMatchObject({ code: 'internal' });
  });
});
