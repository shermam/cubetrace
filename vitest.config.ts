import { defineConfig } from 'vitest/config';

// Unit tests of packages/* (plain TypeScript, run in Node). The app's tests run through `ng test`,
// which loads this file too, minus `include` and `environment` (apps/web/vitest-base.config.mts).
export default defineConfig({
  resolve: {
    // Resolve "@cubetrace/*" with the "paths" of tsconfig.base.json, as the Angular build does.
    tsconfigPaths: true,
  },
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
  },
});
