import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Storage } from '@google-cloud/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gcsObjectStore } from './gcs.js';
import { toSize, unconfiguredObjectStore } from './object-store.js';
import { r2Client, r2ObjectStore } from './r2.js';

// The two buckets' adapters with made-up credentials: the URLs they sign, checked against the
// signature schemes themselves (the canonical request rebuilt from the URL and the headers returned),
// and the sizes they read, from a local server that answers as the provider's API does.

const key =
  'users/alice/sessions/3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f/attempts/0001/laptop.solve.mp4';

/** RFC 3986 percent-encoding, as both signature schemes encode the query. */
function encode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The canonical query: every parameter but the signature, encoded and sorted. */
function canonicalQuery(url: URL, signature: string): string {
  return [...url.searchParams]
    .filter(([name]) => name !== signature)
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .sort()
    .join('&');
}

/** The canonical headers: the headers the browser sends, and the host, lowercase and sorted. */
function canonicalHeaders(url: URL, headers: Record<string, string>): string {
  return Object.entries({ ...headers, host: url.host })
    .map(([name, value]) => `${name.toLowerCase()}:${value.trim()}\n`)
    .sort()
    .join('');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function param(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) {
    throw new Error(`The URL has no ${name}.`);
  }
  return value;
}

describe('Google Cloud Storage', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const signer = 'cubetrace-functions@demo-cubetrace.iam.gserviceaccount.com';
  const storage = new Storage({
    projectId: 'demo-cubetrace',
    credentials: { client_email: signer, private_key: privateKey },
  });
  const store = gcsObjectStore(storage.bucket('cubetrace-data'));

  it('signs a V4 URL for one PUT that binds the content type and the exact size', async () => {
    // The library refuses an expiry in the past, so the URL is signed now.
    const signedAtMs = Math.floor(Date.now() / 1000) * 1000;
    const { url, headers } = await store.signPut(
      { key, contentType: 'video/mp4', bytes: 23_734_012 },
      signedAtMs,
      signedAtMs + 15 * 60 * 1000,
    );
    expect(headers).toEqual({
      'Content-Type': 'video/mp4',
      'x-goog-content-length-range': '23734012,23734012',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://storage.googleapis.com');
    expect(parsed.pathname).toBe(`/cubetrace-data/${key}`);
    const date = new Date(signedAtMs).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const scope = `${date.slice(0, 8)}/auto/storage/goog4_request`;
    expect(param(parsed, 'X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(param(parsed, 'X-Goog-Credential')).toBe(`${signer}/${scope}`);
    expect(param(parsed, 'X-Goog-Date')).toBe(date);
    expect(param(parsed, 'X-Goog-Expires')).toBe('900');
    expect(param(parsed, 'X-Goog-SignedHeaders')).toBe(
      'content-type;host;x-goog-content-length-range',
    );
    // The signature is the signer's key over the request the browser will make with these headers.
    const canonicalRequest = [
      'PUT',
      parsed.pathname,
      canonicalQuery(parsed, 'X-Goog-Signature'),
      canonicalHeaders(parsed, headers),
      'content-type;host;x-goog-content-length-range',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['GOOG4-RSA-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
    const signature = Buffer.from(param(parsed, 'X-Goog-Signature'), 'hex');
    expect(createVerify('RSA-SHA256').update(stringToSign).verify(publicKey, signature)).toBe(true);
    // ...and not over a request of another size.
    const longer = canonicalRequest.replace('23734012,23734012', '23734013,23734013');
    const forged = ['GOOG4-RSA-SHA256', date, scope, sha256(longer)].join('\n');
    expect(createVerify('RSA-SHA256').update(forged).verify(publicKey, signature)).toBe(false);
  });
});

describe('Cloudflare R2', () => {
  const credentials = {
    accountId: '0123456789abcdef0123456789abcdef',
    accessKeyId: 'AKIDCUBETRACEEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYCUBETRACEKEY',
  };
  const store = r2ObjectStore(r2Client(credentials), 'cubetrace');

  it('signs an S3 SigV4 URL for one PUT that binds the content type and the exact size', async () => {
    const signedAtMs = Date.UTC(2026, 9, 1, 21, 30, 5);
    const { url, headers } = await store.signPut(
      { key, contentType: 'video/mp4', bytes: 23_734_012 },
      signedAtMs,
      signedAtMs + 15 * 60 * 1000,
    );
    // Content-Length is signed too, but the browser sets it from the body.
    expect(headers).toEqual({ 'Content-Type': 'video/mp4' });
    const parsed = new URL(url);
    expect(parsed.origin).toBe(`https://${credentials.accountId}.r2.cloudflarestorage.com`);
    expect(parsed.pathname).toBe(`/cubetrace/${key}`);
    expect(param(parsed, 'X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(param(parsed, 'X-Amz-Credential')).toBe(
      `${credentials.accessKeyId}/20261001/auto/s3/aws4_request`,
    );
    expect(param(parsed, 'X-Amz-Date')).toBe('20261001T213005Z');
    expect(param(parsed, 'X-Amz-Expires')).toBe('900');
    expect(param(parsed, 'X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(param(parsed, 'X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
    // No checksum of an empty body, which R2 would hold the real upload to.
    expect([...parsed.searchParams.keys()].filter((name) => /checksum/i.test(name))).toEqual([]);
    // The signature, recomputed from the secret key over the request the browser will make.
    const canonicalRequest = [
      'PUT',
      parsed.pathname,
      canonicalQuery(parsed, 'X-Amz-Signature'),
      canonicalHeaders(parsed, { ...headers, 'content-length': '23734012' }),
      'content-length;content-type;host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20261001T213005Z',
      '20261001/auto/s3/aws4_request',
      sha256(canonicalRequest),
    ].join('\n');
    const signingKey = ['20261001', 'auto', 's3', 'aws4_request'].reduce<Buffer | string>(
      (secret, part) => createHmac('sha256', secret).update(part).digest(),
      `AWS4${credentials.secretAccessKey}`,
    );
    expect(param(parsed, 'X-Amz-Signature')).toBe(
      createHmac('sha256', signingKey).update(stringToSign).digest('hex'),
    );
  });
});

describe('the size of an object', () => {
  /** A local stand-in for the providers' APIs: one object of 1234 bytes, and a key it refuses. */
  let server: Server;
  let origin: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const path = decodeURIComponent(request.url?.split('?')[0] ?? '');
      requests.push(`${request.method ?? ''} ${path}`);
      if (path.endsWith('/forbidden.json')) {
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 403, message: 'Forbidden' } }));
      } else if (!path.endsWith(key)) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(
          request.method === 'HEAD'
            ? undefined
            : '{"error":{"code":404,"message":"No such object"}}',
        );
      } else if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Length': '1234', 'Content-Type': 'video/mp4' });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ kind: 'storage#object', name: key, size: '1234' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads it from Google Cloud Storage, and null when there is none', async () => {
    const storage = new Storage({ projectId: 'demo-cubetrace', apiEndpoint: origin });
    const store = gcsObjectStore(storage.bucket('cubetrace-data'));
    await expect(store.sizeOf(key)).resolves.toBe(1234);
    await expect(store.sizeOf(key.replace('laptop', 'phone'))).resolves.toBeNull();
    await expect(store.sizeOf('users/alice/forbidden.json')).rejects.toThrow();
    expect(requests).toContain(`GET /storage/v1/b/cubetrace-data/o/${key}`);
  });

  it('reads it from R2, and null when there is none', async () => {
    const store = r2ObjectStore(
      r2Client({ accountId: 'unused', accessKeyId: 'AKID', secretAccessKey: 'secret' }, origin),
      'cubetrace',
    );
    await expect(store.sizeOf(key)).resolves.toBe(1234);
    await expect(store.sizeOf(key.replace('laptop', 'phone'))).resolves.toBeNull();
    await expect(store.sizeOf('users/alice/forbidden.json')).rejects.toThrow();
    expect(requests).toContain(`HEAD /cubetrace/${key}`);
  });
});

describe('a size as a provider reports it', () => {
  it('is a whole number of bytes, in a number or in decimal text', () => {
    expect(toSize(1234)).toBe(1234);
    expect(toSize('23734012')).toBe(23_734_012);
    for (const odd of [undefined, null, -1, 1.5, '12 MB', '']) {
      expect(() => toSize(odd)).toThrow('not one');
    }
  });
});

describe('a bucket that is not configured', () => {
  it('fails every call, saying what is missing', async () => {
    const store = unconfiguredObjectStore('r2', 'cubetrace', 'R2_ACCOUNT_ID is empty');
    await expect(
      store.signPut({ key, contentType: 'video/mp4', bytes: 1 }, 0, 900_000),
    ).rejects.toThrow('The bucket is not configured (r2, cubetrace): R2_ACCOUNT_ID is empty.');
    await expect(store.sizeOf(key)).rejects.toThrow('R2_ACCOUNT_ID is empty');
  });
});
