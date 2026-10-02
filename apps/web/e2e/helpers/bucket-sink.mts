// The bucket of the end-to-end suite's cloud project (npm run e2e:cloud): a server on this machine that
// keeps in memory what the app PUTs to the URLs that the functions make in the Functions emulator with
// BUCKET_PROVIDER=local (functions/src/local.ts; functions/.env.demo-cubetrace names this server's
// address). A PUT must be what its URL was made for, as a GCS signature binds it: the content type, the
// exact size, also in GCS's x-goog-content-length-range header, and the time; and the browser's
// preflights are answered from bucket/cors.json, the real bucket's CORS policy, so that an upload that
// passes here sends what the bucket accepts. The functions read an object's size with HEAD; the tests
// read an object with GET and list them with `GET /?prefix=<prefix>`. The Playwright config starts it:
//   node e2e/helpers/bucket-sink.mts <port>
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

/** A rule of a GCS bucket's CORS policy (`gcloud storage buckets update --cors-file`). */
interface CorsRule {
  readonly origin: readonly string[];
  readonly method: readonly string[];
  readonly responseHeader: readonly string[];
  readonly maxAgeSeconds: number;
}

/** An object, with what its PUT sent. */
interface StoredObject {
  readonly contentType: string;
  readonly body: Buffer;
}

const [port = '4600'] = process.argv.slice(2);
const cors = JSON.parse(
  readFileSync(new URL('../../../../bucket/cors.json', import.meta.url), 'utf8'),
) as readonly CorsRule[];
const objects = new Map<string, StoredObject>();

/** The policy's rule for a request from `origin` with `method`, as GCS picks it. */
function ruleFor(origin: string | undefined, method: string): CorsRule | undefined {
  return origin === undefined
    ? undefined
    : cors.find((rule) => rule.origin.includes(origin) && rule.method.includes(method));
}

/** The headers that let the page read the answer to its request, when the policy allows it. */
function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  return origin !== undefined && ruleFor(origin, request.method ?? '') !== undefined
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
}

/** A preflight, answered as GCS answers it from the policy: allowed, or without CORS headers. */
function preflight(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  const method = request.headers['access-control-request-method'] ?? '';
  const rule = ruleFor(origin, method);
  const allowed = new Set(rule?.responseHeader.map((name) => name.toLowerCase()) ?? []);
  const asked = (request.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  if (origin === undefined || rule === undefined || !asked.every((name) => allowed.has(name))) {
    response.writeHead(200).end();
    return;
  }
  response
    .writeHead(200, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': rule.method.join(', '),
      'Access-Control-Allow-Headers': rule.responseHeader.join(', '),
      'Access-Control-Max-Age': String(rule.maxAgeSeconds),
      Vary: 'Origin',
    })
    .end();
}

/** Why a PUT is not what its URL was made for (status and message), or null when it is. */
function refusal(
  url: URL,
  request: IncomingMessage,
  body: Buffer,
): { status: number; message: string } | null {
  const contentType = url.searchParams.get('contentType');
  const bytes = url.searchParams.get('bytes');
  const expires = Number(url.searchParams.get('expires'));
  if (contentType === null || bytes === null || !Number.isFinite(expires)) {
    return {
      status: 403,
      message: 'Not a URL of the functions: no contentType, bytes or expires.',
    };
  }
  if (Date.now() > expires) {
    return { status: 400, message: 'ExpiredToken: the URL has expired.' };
  }
  if (request.headers['content-type'] !== contentType) {
    return { status: 403, message: `SignatureDoesNotMatch: Content-Type is not ${contentType}.` };
  }
  if (request.headers['x-goog-content-length-range'] !== `${bytes},${bytes}`) {
    return { status: 403, message: `SignatureDoesNotMatch: the range is not ${bytes},${bytes}.` };
  }
  if (String(body.length) !== bytes) {
    return { status: 400, message: `EntityTooLarge: ${String(body.length)} bytes, not ${bytes}.` };
  }
  return null;
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://sink');
  const key = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
  if (request.method === 'OPTIONS') {
    preflight(request, response);
    return;
  }
  const headers = corsHeaders(request);
  if (request.method === 'PUT') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const refused = refusal(url, request, body);
      if (refused !== null) {
        response.writeHead(refused.status, { ...headers, 'Content-Type': 'text/plain' });
        response.end(refused.message);
        return;
      }
      objects.set(key, { contentType: request.headers['content-type'] ?? '', body });
      response.writeHead(200, headers).end();
    });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, headers).end();
    return;
  }
  if (key === '') {
    // The tests' listing: every object under the prefix, by key.
    const prefix = url.searchParams.get('prefix') ?? '';
    const listing = [...objects]
      .filter(([name]) => name.startsWith(prefix))
      .sort(([p], [q]) => p.localeCompare(q))
      .map(([name, object]) => ({
        key: name,
        bytes: object.body.length,
        contentType: object.contentType,
      }));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(listing));
    return;
  }
  const object = objects.get(key);
  if (object === undefined) {
    response.writeHead(404, headers).end();
    return;
  }
  response.writeHead(200, {
    ...headers,
    'Content-Type': object.contentType,
    'Content-Length': String(object.body.length),
  });
  response.end(request.method === 'HEAD' ? undefined : object.body);
}).listen(Number(port), '127.0.0.1', () => {
  console.log(`The bucket sink listens at http://127.0.0.1:${port}/`);
});
