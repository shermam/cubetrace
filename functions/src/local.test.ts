import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EMULATOR_ONLY, localObjectStore } from './local.js';

// The end-to-end suite's bucket (BUCKET_PROVIDER=local, local.ts): the URLs it makes for a server on
// this machine, the sizes it reads there, its refusal outside the Functions emulator, and the deployed
// functions signing and confirming an upload through it, as the Functions emulator runs them for
// `npm run e2e:cloud`, against a server of the test's that keeps the size of each PUT (the suite's
// sink, apps/web/e2e/helpers/bucket-sink.mts, keeps the bytes and checks them too).

const sessionId = '6c5d4e3f-2a1b-4c0d-9e8f-7a6b5c4d3e2f';
const key = `users/dave/sessions/${sessionId}/attempts/0001/laptop.solve.mp4`;

const sizes = new Map<string, number>();
const requests: string[] = [];
const server: Server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? '/', 'http://sink').pathname).slice(1);
  requests.push(`${request.method ?? ''} ${path}`);
  if (path.startsWith('broken/')) {
    response.writeHead(500).end();
  } else if (request.method === 'PUT') {
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    request.on('end', () => {
      sizes.set(path, bytes);
      response.writeHead(200).end();
    });
  } else if (request.method === 'HEAD' && sizes.has(path)) {
    response.writeHead(200, { 'Content-Length': String(sizes.get(path)) }).end();
  } else {
    response.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

// The deployed functions with the configuration of functions/.env.demo-cubetrace, in the Functions
// emulator: the configuration is read when the module loads, as on Cloud Functions, so it is set before
// the import.
Object.assign(process.env, {
  BUCKET_PROVIDER: 'local',
  BUCKET_NAME: 'cubetrace-data',
  R2_ACCOUNT_ID: '',
  QUOTA_BYTES_PER_DAY: '2000000000',
  QUOTA_FILES_PER_DAY: '400',
  MAX_FILE_BYTES: '512000000',
  LOCAL_BUCKET_URL: origin,
  FUNCTIONS_EMULATOR: 'true',
});
const { confirmUpload, signUpload } = await import('./index.js');

function call(uid: string, data: unknown): CallableRequest {
  return {
    data,
    auth: { uid, token: {}, rawToken: '' },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest;
}

beforeAll(async () => {
  const db = getFirestore(getApps()[0] ?? initializeApp());
  await db.doc(`sessions/${sessionId}`).set({ owner: 'dave' });
  await db
    .doc(`sessions/${sessionId}/attempts/0001`)
    .set({ owner: 'dave', upload: { state: 'pending', files: {} } });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('the local bucket', () => {
  const emulator = { FUNCTIONS_EMULATOR: 'true', LOCAL_BUCKET_URL: 'http://127.0.0.1:4600/' };

  it("makes a URL on the server for one PUT, with what it was made for in its query, and GCS's headers", async () => {
    const store = localObjectStore(emulator);
    expect(store).toMatchObject({ provider: 'local', bucket: 'http://127.0.0.1:4600' });
    const expiresAtMs = Date.UTC(2026, 9, 2, 21, 45, 5);
    const { url, headers } = await store.signPut(
      { key, contentType: 'video/mp4', bytes: 23_734_012 },
      expiresAtMs - 15 * 60 * 1000,
      expiresAtMs,
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe('http://127.0.0.1:4600');
    expect(parsed.pathname).toBe(`/${key}`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      contentType: 'video/mp4',
      bytes: '23734012',
      expires: String(expiresAtMs),
    });
    expect(headers).toEqual({
      'Content-Type': 'video/mp4',
      'x-goog-content-length-range': '23734012,23734012',
    });
  });

  it('reads the size of an object with HEAD, null when there is none, and fails on another answer', async () => {
    sizes.set('users/dave/known.json', 1234);
    const store = localObjectStore({ ...emulator, LOCAL_BUCKET_URL: origin });
    await expect(store.sizeOf('users/dave/known.json')).resolves.toBe(1234);
    await expect(store.sizeOf('users/dave/unknown.json')).resolves.toBeNull();
    await expect(store.sizeOf('broken/attempt.json')).rejects.toThrow(
      'The local bucket answered 500 for broken/attempt.json.',
    );
    expect(requests).toContain('HEAD users/dave/known.json');
  });

  it('fails every call outside the Functions emulator, and without a URL, saying why', async () => {
    const seen = requests.length;
    const outside = [
      { LOCAL_BUCKET_URL: origin },
      { FUNCTIONS_EMULATOR: '1', LOCAL_BUCKET_URL: origin },
    ];
    for (const env of outside) {
      const store = localObjectStore(env);
      await expect(
        store.signPut({ key, contentType: 'video/mp4', bytes: 1 }, 0, 1),
      ).rejects.toThrow(`The bucket is not configured (local, ${origin}): ${EMULATOR_ONLY}.`);
      await expect(store.sizeOf(key)).rejects.toThrow(EMULATOR_ONLY);
    }
    await expect(localObjectStore({ FUNCTIONS_EMULATOR: 'true' }).sizeOf(key)).rejects.toThrow(
      'LOCAL_BUCKET_URL is empty',
    );
    await expect(
      localObjectStore({ FUNCTIONS_EMULATOR: 'true', LOCAL_BUCKET_URL: 'sink' }).sizeOf(key),
    ).rejects.toThrow('LOCAL_BUCKET_URL is not a URL');
    expect(requests).toHaveLength(seen);
  });

  it('carries an upload through the deployed functions: signed for the server, PUT there, confirmed', async () => {
    const files = [{ path: 'laptop.solve.mp4', bytes: 1234, contentType: 'video/mp4' }];
    const [signed] = await signUpload.run(call('dave', { sessionId, attemptIndex: 1, files }));
    expect(signed.path).toBe('laptop.solve.mp4');
    expect(signed.url).toBe(
      `${origin}/${key}?contentType=video%2Fmp4&bytes=1234&expires=${String(signed.expiresAt)}`,
    );
    const put = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(1234),
    });
    expect(put.status).toBe(200);
    const done = await confirmUpload.run(
      call('dave', { sessionId, attemptIndex: 1, files: [{ path: 'laptop.solve.mp4' }] }),
    );
    expect(done).toMatchObject({ state: 'done', pending: [] });
    expect(requests.filter((request) => request.endsWith(key))).toEqual([
      `PUT ${key}`,
      `HEAD ${key}`,
    ]);
  });
});
