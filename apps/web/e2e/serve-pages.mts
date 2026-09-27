// Serves a production build the way GitHub Pages serves the deploy (.github/workflows/pages.yml):
// under /cubetrace/, with index.html as the 404 page so that deep links reach the router.
// The Playwright config starts it for pwa.spec.ts:
//   node e2e/serve-pages.mts <build directory> <port>
// No dependency: the static servers on npm (sirv-cli, http-server) cannot serve a directory
// under a path prefix, and the prefix is the point of the test.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { type ServerResponse, createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const [directory = 'dist/pages/browser', port = '4300'] = process.argv.slice(2);
const root = resolve(directory);
const base = '/cubetrace/';
const types: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** The file a URL path names, or null when it is outside the site or not a file. */
async function fileFor(pathname: string): Promise<string | null> {
  if (!pathname.startsWith(base)) {
    return null;
  }
  const relative = decodeURIComponent(pathname.slice(base.length));
  const path = join(
    root,
    relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative,
  );
  if (!path.startsWith(root + sep)) {
    return null;
  }
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function send(response: ServerResponse, status: number, path: string): void {
  response.writeHead(status, {
    'content-type': types[extname(path)] ?? 'application/octet-stream',
  });
  createReadStream(path).pipe(response);
}

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === base.slice(0, -1)) {
    response.writeHead(301, { location: base }).end();
    return;
  }
  fileFor(pathname).then(
    (file) => {
      if (file !== null) {
        send(response, 200, file);
      } else if (pathname.startsWith(base)) {
        send(response, 404, join(root, 'index.html'));
      } else {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
      }
    },
    (error: unknown) => {
      response
        .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        .end(`${String(error)}\n`);
    },
  );
}).listen(Number(port), () => {
  console.log(`Serving ${root} at http://localhost:${port}${base}`);
});
