/** Version of `@cubetrace/core`; kept equal to `packages/core/package.json`. */
export const CORE_VERSION = '0.0.0';

/**
 * Names the package and its version, e.g. `"@cubetrace/core 0.0.0"`.
 *
 * The scaffold's placeholder: the Timer page shows it, which proves that the app
 * resolves `@cubetrace/core` from `packages/core/src` through the tsconfig paths.
 */
export function coreVersion(): string {
  return `@cubetrace/core ${CORE_VERSION}`;
}
