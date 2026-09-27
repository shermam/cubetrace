import { describe, expect, it } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };
import { CORE_VERSION, coreVersion } from './index';

describe('coreVersion', () => {
  it('names the package and the version in its package.json', () => {
    expect(CORE_VERSION).toBe(packageJson.version);
    expect(coreVersion()).toBe(`@cubetrace/core ${packageJson.version}`);
  });
});
