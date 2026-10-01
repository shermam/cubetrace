import { defineConfig } from 'vitest/config';

// The functions' tests (functions/src/*.test.ts), which need the Firestore emulator and the built
// functions (lib/, for the deploy's view of them): run by `npm run test:functions`, which builds them
// and starts the emulator (`firebase emulators:exec`), and not by `npm test`.
export default defineConfig({
  test: {
    include: ['functions/src/**/*.test.ts'],
    environment: 'node',
    // Google's auth library looks for a Compute Engine metadata server to learn its universe domain,
    // even against the emulator; the tests never run on Google Cloud, so it is told there is none.
    env: { METADATA_SERVER_DETECTION: 'none' },
    // The emulator answers the first request of a cold JVM in a few seconds.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
