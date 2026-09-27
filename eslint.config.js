// @ts-check
// One flat config for the whole repository. `npm run lint` runs `eslint .` for everything outside
// apps/web and `ng lint` (@angular-eslint/builder) for apps/web; both use this file.
import eslint from '@eslint/js';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/dist/',
    '**/.angular/',
    '**/coverage/',
    '**/playwright-report/',
    '**/test-results/',
    'fixtures/',
  ]),
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [eslint.configs.recommended],
  },
  {
    // TypeScript everywhere: typescript-eslint's strict preset with type information
    // (no `any`, no unsafe flows of `any`, no non-null assertions, ...).
    files: ['**/*.{ts,mts,cts}'],
    extends: [eslint.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Libraries are plain TypeScript and never import Angular (CLAUDE.md).
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@angular/*'], message: 'packages/* are plain TypeScript: no Angular.' },
          ],
        },
      ],
    },
  },
  {
    // The Angular app: component and template conventions from angular-eslint.
    files: ['apps/web/src/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      // Components, directives and pipes are decorated classes that may have an empty body.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
  },
  // Last: turn off every stylistic rule that Prettier owns.
  prettier,
]);
