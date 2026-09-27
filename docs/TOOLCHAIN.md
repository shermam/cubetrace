# Toolchain

Set up by T1.0 on 2026-09-27. Change it only with a pull request that says why (`CLAUDE.md`).
`package-lock.json` is the source of truth for every version; `package.json` files use caret or
tilde ranges, except Playwright, which is pinned exactly (see below).

## Versions installed

| Tool | Version | Declared in | Notes |
|---|---|---|---|
| Node.js | 22.23.3 locally, 22.23.2 in CI | `engines` in `package.json`; `node-version: 22` in the workflows | Angular CLI 22.2 refuses Node older than 22.22.3 (or 24.15.0) |
| npm | 10.9.9 locally, 10.9.8 in CI (bundled with Node) | `engines` | npm workspaces: `apps/*`, `packages/*` |
| Angular (`core`, `router`, `cli`, `build`, `compiler-cli`, ...) | 22.2.0 | `apps/web/package.json` | latest stable on npm |
| TypeScript | 6.0.3 | root `package.json` | Angular 22.2 requires `>=6.0 <6.1` |
| Vitest | 5.0.2 (Vite 8.3.1) | root `package.json` | packages and app share this one installation |
| jsdom | 30.1.1 | `apps/web/package.json` | DOM for the app's unit tests |
| Playwright (`@playwright/test`) | 1.56.1, exact | root `package.json` | drives Chromium 141.0.7390.37 (browser revision 1194) |
| ESLint | 10.11.0 (`@eslint/js` 10.0.1) | root `package.json` | flat config, `eslint.config.js` |
| typescript-eslint | 8.70.1 | root `package.json` | |
| angular-eslint | 22.5.0 | root `package.json` | provides the `ng lint` builder |
| Prettier | 3.9.9 (`eslint-config-prettier` 10.1.8) | root `package.json` | |
| `@types/node` | 22.20.4 | root `package.json` | Node-side TypeScript only (configs, Playwright) |
| rxjs, tslib | 7.8.2, 2.8.1 | `apps/web/package.json` | Angular runtime dependencies |
| `@angular/service-worker` | 22.2.0 | `apps/web/package.json` | added by `ng add @angular/pwa@22.2.0` (T1.7); `@angular/pwa` itself is only the schematic and is not installed |
| cubing | not installed yet | — | T1.2 adds it; the latest release on 2026-09-27 is 0.63.7 |

## Commands

| Root script | Runs |
|---|---|
| `npm start` | `ng serve` in `apps/web` (extra arguments after `--` go to `ng`), after `scripts/write-version.mts` |
| `npm run build` | `ng build` in `apps/web`, production configuration, output `apps/web/dist/web/browser`, after `scripts/write-version.mts` |
| `npm run typecheck` | `tsc --noEmit` for the root configs, each package, and the Node-side files of `apps/web` (`tsconfig.node.json`) |
| `npm run lint` | `typecheck`, then `eslint .` (everything outside `apps/web`), then `ng lint` (`apps/web`: `src`, `e2e`, configs) |
| `npm test` | `vitest run` (`packages/**/src/**/*.test.ts`, Node), then `ng test --watch=false` (the app's `*.spec.ts`, jsdom, headless) |
| `npm run test:watch` | `vitest` in watch mode for the packages; the app: `npm run test -w @cubetrace/web` |
| `npm run e2e` | `playwright test -c apps/web/e2e/playwright.config.ts` (Chromium; report in `apps/web/e2e/playwright-report`); starts `ng serve` on port 4200 and a production build under `/cubetrace/` on port 4300 |
| `npm run icons -w @cubetrace/web` | `scripts/generate-icons.mts`: redraws `apps/web/public/icons/` (the SVG and the PNGs the manifest lists) |
| `npm run format` / `format:check` | `prettier --write .` / `prettier --check .` |

The app was generated with
`npx @angular/cli@22.2.0 new web --directory apps/web --standalone --style=scss --routing --ssr=false --skip-git --skip-install --package-manager=npm --ai-config=none --defaults`
(the first commit of T1.0 is that output, unmodified). It is zoneless and its components are
`OnPush` by default, as Angular 22 generates them.

## Decisions

**Angular's test runner is Vitest, sharing the root config.** Angular 22.2's default runner for
new projects is Vitest, through the `@angular/build:unit-test` builder (jsdom, no browser). It
uses the root Vitest installation and loads the root `vitest.config.ts` through
`apps/web/vitest-base.config.mts` (`runnerConfig` in `angular.json`), which removes the two
settings that only describe `packages/*`: the builder rejects `test.include` (it finds the
app's `*.spec.ts` itself) and runs in jsdom only when `test.environment` is unset. Anything
else added to the root config applies to both. App specs use Vitest's globals (Angular's
default); package tests import `describe`/`it`/`expect` from `vitest`.

**`ng build` resolves the `paths` mapping directly; the packages have no build step.**
`tsconfig.base.json` maps `@cubetrace/*` to `packages/*/src/index.ts` and `apps/web/tsconfig.json`
extends it. Checked on 2026-09-27 by building the app with the packages' `exports` field removed
(build passes: the mapping alone resolves the import) and with both the mapping and `exports`
removed (build fails with TS2307 and esbuild's "Could not resolve"). The packages are also npm
workspaces whose `exports` point at `src/index.ts`, so tools that ignore tsconfig (Node,
Playwright) find them too; Vitest reads the same mapping through Vite's `resolve.tsconfigPaths`.

**Types are checked by `tsc`, not only by the bundlers.** Vitest and Playwright strip types
without checking them; `ng build` and `ng test` check the app and its specs. `npm run typecheck`
(part of `npm run lint`) covers the rest: packages, root configs, `apps/web/e2e`.

**Lint.** One root flat config for everything: typescript-eslint's `strictTypeChecked` preset
(the strict preset with type information, so `any` is caught where it flows, not only where it is
written), angular-eslint's `tsRecommended`, `templateRecommended` and `templateAccessibility`
for the app, and `eslint-config-prettier` last. One rule option differs from the presets:
`@typescript-eslint/no-extraneous-class` allows decorated classes, because an Angular component
may have an empty body. One rule is added: `no-restricted-imports` forbids `@angular/*` in
`packages/*` ("libraries never import Angular", `CLAUDE.md`). `eslint .` skips `apps/web`
because `ng lint` covers it; running both on the app would lint it twice.

**Formatting.** Prettier (settings from the Angular CLI: single quotes, width 100, Angular
parser for HTML) formats everything except Markdown (documents keep their hand-made tables and
line breaks), `fixtures/` (read-only) and `package-lock.json`. CI runs `npm run format:check`.

**End-to-end tests run against `ng serve`.** The Playwright config starts the dev server on port
4200 and reuses one that is already running outside CI, so `npm start` and `npm run e2e` can run
side by side. Chromium only; no retries (flaky tests get fixed, `docs/PLAN.md` T1.9).

**Playwright is pinned to 1.56.1.** The agents' containers ship Chromium revision 1194 in
`/opt/pw-browsers` and cannot download browsers; 1.56.x is the Playwright release that drives
that revision, so `npm run e2e` works there without `playwright install`. CI installs the
matching browser with `npx playwright install --with-deps chromium`, on `ubuntu-24.04` because
Playwright 1.56 only knows the system dependencies of Ubuntu up to 24.04. Upgrading Playwright
means updating the containers' browsers too.

**Node 22.22.3 or later.** Angular CLI 22.2 exits with an error on older Node 22 releases. The
agents' containers had 22.22.2 on 2026-09-27; T1.0 was verified locally with the official Node
22.23.3 binary from nodejs.org (the latest 22.x that day). In CI, `actions/setup-node` with
`node-version: 22` uses the runner's cached 22.x release: 22.23.2 on the first run.

**GitHub Pages.** `pages.yml` builds with `--base-href /cubetrace/`, copies `index.html` to
`404.html` so that deep links (`/cubetrace/settings`) reach the Angular router, and uploads the
artifact; a separate deploy job with `pages: write` and `id-token: write` runs
`actions/configure-pages` with `enablement: true` and then `actions/deploy-pages`. Enabling Pages
needs a token with admin rights, which `GITHUB_TOKEN` lacks, so the deploy job fails until the
owner enables Pages once (`docs/USER-ACTIONS.md`); the workflow can then be re-run by hand
(`workflow_dispatch`).

**PWA (T1.7).** Set up with `npx ng add @angular/pwa@22.2.0 --project web` (the first commit of
T1.7 is its output), then adapted. The service worker registers only in production builds
(`isDevMode()` in `app.config.ts`), so `ng serve` never has one. `ngsw-config.json` prefetches the
app shell (`index.html`, the manifest, the SVG icon and every `*.js` and `*.css` file the build
emits, lazy route chunks included, so the Timer's cubing.js chunks and worker files are covered when
T1.2 adds them; check that they appear in `dist/web/browser/ngsw.json`) and loads the PNG icons
lazily. The manifest's `start_url`, `scope`, `id` and icon paths are relative, so the same build
works at `/` and under `/cubetrace/` on Pages; its `theme_color` and `background_color` are the
theme's `--bg`. Angular reads `ngsw-config.json` with `JSON.parse`, so it cannot hold comments.

**Icons.** `apps/web/scripts/generate-icons.mts` draws one flat isometric cube (white up, green
front, red right) as SVG and has Playwright's Chromium rasterise it: `icon.svg` (favicon and
manifest), `icon-192.png` and `icon-512.png` (rounded tile, purpose `any`) and `maskable-192.png`
and `maskable-512.png` (full-bleed square, the cube inside the maskable safe zone). Change the
drawing in the script and run `npm run icons -w @cubetrace/web`; there is no other source.

**The version and the commit are written into a generated file before each build.**
`apps/web/scripts/write-version.mts` writes `apps/web/src/environments/version.ts`, which exports
`APP_BUILD = { version, commit }`: the version of the root `package.json` (the release version,
tagged `vX.Y.Z`) and `git rev-parse --short=7 HEAD` (`unknown` outside a git checkout). The
footer shows it and `session.json` records it as `app` (`docs/DATA-MODEL.md`). npm runs the
script as `postinstall` of `apps/web` (so `npm ci` leaves the file in place for `ng test`,
`ng lint` and editors), `prestart` and `prebuild` (a fresh SHA for every build and dev server);
it leaves the file untouched when nothing changed, so a running `ng serve` does not rebuild. The
file is in `.gitignore`: if it is missing, run `npm install` or `npm run build`. Angular's
`define` option was the alternative; its values are static in `angular.json`, so the SHA would
have to come from wrapper scripts that call `ng build` and `ng serve` with `--define`, in place of
the plain `ng` commands, and the unit tests would still need a fallback.

**Node scripts in `apps/web` are `.mts`.** `apps/web/package.json` has no `"type": "module"` (as
Angular generates it; adding it would turn the Playwright config and specs into ES modules), so
the scripts Node runs directly (`scripts/*.mts`, `e2e/serve-pages.mts`) use the `.mts` extension
to be ES modules. Every Node release that `engines` allows strips their types without a flag
(checked on 22.22.2 and 22.23.3). `tsconfig.node.json` type-checks them and `ng lint` lints them.

**The PWA is tested on a production build served like Pages.** The Playwright config has a
second web server: `npm run build -- --base-href /cubetrace/ --output-path dist/pages`, then
`node e2e/serve-pages.mts dist/pages/browser 4300`, which serves that build under `/cubetrace/`
and answers unknown paths there with `index.html` and status 404, as Pages does with the
workflow's `404.html`. `pwa.spec.ts` checks the manifest, `ngsw-worker.js`, the service worker's
scope, offline start and the footer's version against it. It needs no dependency: the static
servers on npm (`sirv-cli`, `http-server`) cannot serve a directory under a path prefix. The build
adds about 5 seconds to `npm run e2e`.

**Pages are lazy-loaded.** Each route loads its page component on demand, so the initial bundle
stays small when cubing.js (large) arrives with the Timer page.
