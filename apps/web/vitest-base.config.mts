import { defineConfig } from 'vitest/config';

import rootConfig from '../../vitest.config.ts';

// Vitest configuration for `ng test` (angular.json: test.options.runnerConfig). It is the
// repository's root vitest.config.ts minus the two settings that only describe packages/*:
// the Angular builder finds the app's *.spec.ts itself (it rejects `test.include`) and runs
// them in jsdom, which it only picks when `test.environment` is unset.
const test = { ...rootConfig.test };
delete test.include;
delete test.environment;

export default defineConfig({ ...rootConfig, test });
