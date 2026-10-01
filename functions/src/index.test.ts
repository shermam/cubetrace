import type { CallableRequest } from 'firebase-functions/https';
import { describe, expect, it } from 'vitest';

// The deployed functions as Firebase runs them (index.ts: the configuration, the Admin SDK against
// the Firestore emulator), with an R2 configuration that lacks its account id and keys. The
// configuration is read when the module loads, as on Cloud Functions, so it is set before the import.

Object.assign(process.env, {
  BUCKET_PROVIDER: 'r2',
  BUCKET_NAME: 'cubetrace',
  R2_ACCOUNT_ID: '',
  QUOTA_BYTES_PER_DAY: '2000000000',
  QUOTA_FILES_PER_DAY: '400',
  MAX_FILE_BYTES: '512000000',
});
const { confirmUpload, signUpload } = await import('./index.js');

const sessionId = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';

function request(data: unknown, uid?: string): CallableRequest {
  return {
    data,
    auth: uid === undefined ? undefined : { uid, token: {}, rawToken: '' },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest;
}

describe('the deployed functions', () => {
  it('refuse anyone signed out', async () => {
    const data = { sessionId, attemptIndex: 1, files: [{ path: 'attempt.json' }] };
    await expect(signUpload.run(request(data))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(confirmUpload.run(request(data))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('fail each call, without failing to load, when the bucket is not configured', async () => {
    const data = {
      sessionId,
      attemptIndex: 1,
      files: [{ path: 'attempt.json', bytes: 10, contentType: 'application/json' }],
    };
    await expect(signUpload.run(request(data, 'alice'))).rejects.toMatchObject({
      code: 'internal',
    });
  });
});
