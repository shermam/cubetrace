import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

// What `firebase deploy` sees of the functions. The CLI loads the built code (lib/, which
// `npm run test:functions` builds first) with firebase-functions' own loader, with the values of
// functions/.env in its environment and nothing else of the shell's, and reads the manifest it
// writes: the functions, their options, the parameters it must have values for and the secrets it
// must find in Secret Manager. This runs the same loader the same way.

interface Endpoint {
  region: string[];
  platform: string;
  maxInstances: number;
  callableTrigger?: object;
  secretEnvironmentVariables?: { key: string }[];
}

interface Manifest {
  endpoints: Record<string, Endpoint>;
  params: { name: string; type: string }[];
}

const functionsDir = fileURLToPath(new URL('..', import.meta.url));
const loader = join(
  dirname(createRequire(import.meta.url).resolve('firebase-functions')),
  '..',
  'bin',
  'firebase-functions.js',
);

/** functions/.env, read as the Firebase CLI reads it: KEY=value lines, # comments. */
async function dotenv(): Promise<Record<string, string>> {
  const text = await readFile(join(functionsDir, '.env'), 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

async function manifest(env: Record<string, string>): Promise<Manifest> {
  const dir = await mkdtemp(join(tmpdir(), 'cubetrace-functions-'));
  try {
    const output = join(dir, 'functions.json');
    await promisify(execFile)(process.execPath, [loader, '.'], {
      cwd: functionsDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        GCLOUD_PROJECT: 'cubetrace-cacd9',
        FUNCTIONS_CONTROL_API: 'true',
        FUNCTIONS_MANIFEST_OUTPUT_PATH: output,
        ...env,
      },
    });
    return JSON.parse(await readFile(output, 'utf8')) as Manifest;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const parameters = [
  'BUCKET_PROVIDER',
  'BUCKET_NAME',
  'R2_ACCOUNT_ID',
  'QUOTA_BYTES_PER_DAY',
  'QUOTA_FILES_PER_DAY',
  'MAX_FILE_BYTES',
];

describe('the deploy', () => {
  it('finds two callable functions in us-central1 that need no secret with the bucket on GCS', async () => {
    const env = await dotenv();
    expect(env['BUCKET_PROVIDER']).toBe('gcs');
    const { endpoints, params } = await manifest(env);
    expect(Object.keys(endpoints).sort()).toEqual(['confirmUpload', 'signUpload']);
    for (const endpoint of Object.values(endpoints)) {
      expect(endpoint).toMatchObject({
        platform: 'gcfv2',
        region: ['us-central1'],
        maxInstances: 10,
        callableTrigger: {},
      });
      expect(endpoint.secretEnvironmentVariables ?? []).toEqual([]);
    }
    expect(params.map(({ name }) => name)).toEqual(parameters);
  });

  it('has a value in functions/.env for every parameter, as a deploy without prompts needs', async () => {
    const env = await dotenv();
    const { params } = await manifest(env);
    for (const { name } of params) {
      expect(Object.keys(env)).toContain(name);
    }
  });

  it('binds the R2 keys to both functions, and only then, with the bucket on R2', async () => {
    const { endpoints, params } = await manifest({ ...(await dotenv()), BUCKET_PROVIDER: 'r2' });
    for (const endpoint of Object.values(endpoints)) {
      expect(endpoint.secretEnvironmentVariables).toEqual([
        { key: 'R2_ACCESS_KEY_ID' },
        { key: 'R2_SECRET_ACCESS_KEY' },
      ]);
    }
    expect(params.filter(({ type }) => type === 'secret').map(({ name }) => name)).toEqual([
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ]);
  });
});
