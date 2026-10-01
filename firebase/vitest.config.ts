import { defineConfig } from 'vitest/config';

// The Firestore rules' tests (firebase/*.test.ts), which need the Firestore emulator: run by
// `npm run test:rules`, which starts it (`firebase emulators:exec`), and not by `npm test`.
export default defineConfig({
  test: {
    include: ['firebase/**/*.test.ts'],
    environment: 'node',
    // The emulator compiles the rules on the first request, which takes a few seconds on a cold JVM.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
