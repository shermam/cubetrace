# Toolchain

Set up by T1.0 on 2026-09-27. Change it only with a pull request that says why (`CLAUDE.md`).
`package-lock.json` is the source of truth for every version; `package.json` files use caret or
tilde ranges, except Playwright, which is pinned exactly (see below), and the functions' dependencies,
which Cloud Build installs without the lockfile ("Functions", below).

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
| rxjs, tslib | 7.8.2, 2.8.1 | `apps/web/package.json`; rxjs also `packages/gan/package.json` | Angular runtime dependencies; rxjs is also the type of `CubeConnection.events$` |
| gan-web-bluetooth (the owner's fork) | 3.0.2 plus 3 commits: git `52417a1` | `packages/gan/package.json` | GAN cube driver, a git dependency pinned to that commit; see "GAN driver" below |
| `@angular/service-worker` | 22.2.0 | `apps/web/package.json` | added by `ng add @angular/pwa@22.2.0` (T1.7); `@angular/pwa` itself is only the schematic and is not installed |
| cubing (cubing.js) | 0.63.7 | `packages/core/package.json`, `apps/web/package.json` | added by T1.2 for scrambles; the app uses it directly for the scramble picture (`cubing/twisty`, T1.6b); MPL-2.0 or GPL-3.0; needs Node 22.3 or later; see "cubing.js" below |
| mediabunny | 1.60.0 | `packages/capture/package.json` | added by T2.3 to mux the encoded chunks into MP4 without re-encoding, in a worker (the clip worker since T2.4); MPL-2.0; brings `@types/dom-webcodecs` 0.1.13 and `@types/dom-mediacapture-transform` 0.1.12 (type declarations only); see "Clips" below |
| firebase (the Firebase JavaScript SDK) | 12.19.0 | `apps/web/package.json` | added by T3.0: Authentication and Firestore, modular imports, in one lazy chunk; Apache-2.0; see "Account" below |
| `@firebase/rules-unit-testing` | 5.0.2 | root `package.json` | added by T3.0: the Firestore rules' tests against the emulator; its peer is the same `firebase` |
| firebase-tools (the Firebase CLI) | 15.32.1, exact | the `firebase` script of the root `package.json` (npx) | not installed by `npm ci`: the emulators (`npm run test:rules`, `test:functions` and `e2e:cloud`) and the deploys (`.github/workflows/firebase.yml`); see "Account" and "Cloud end-to-end" below |
| Java | 21: Temurin in CI, OpenJDK 21.0.10 locally | `.github/workflows/ci.yml` (`actions/setup-java`) | the Firestore emulator, 1.22.0 with firebase-tools 15.32.1, a jar that the CLI downloads into `~/.cache/firebase/emulators` (137 MB), which CI caches; `npm run test:rules`, `npm run test:functions` and `npm run e2e:cloud` (the Auth and Functions emulators are the CLI's own Node code, with nothing to download) |
| firebase-functions | 7.4.0, exact | `functions/package.json` | added by T3.2: `onCall`, parameters and secrets, the logger, the loader the CLI finds functions with; MIT; see "Functions" below |
| firebase-admin | 14.5.0, exact | `functions/package.json` | added by T3.2: Firestore for the functions (its Firestore is `@google-cloud/firestore` 9.3, over `@grpc/grpc-js` 1.14.5); needs Node 22; Apache-2.0 |
| `@google-cloud/storage` | 8.2.0, exact | `functions/package.json` | added by T3.2: V4 signed URLs and object metadata for Google Cloud Storage; firebase-admin's optional dependency, the same copy; Apache-2.0 |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | 3.1145.0, exact | `functions/package.json` | added by T3.2: S3 SigV4 presigned URLs and `HeadObject` for Cloudflare R2; Apache-2.0 |

## Commands

| Root script | Runs |
|---|---|
| `npm start` | `ng serve` in `apps/web` (extra arguments after `--` go to `ng`), after `scripts/write-version.mts` and `scripts/write-demo-solves.mts` |
| `npm run build` | `ng build` in `apps/web`, production configuration, output `apps/web/dist/web/browser`, after `scripts/write-version.mts` and `scripts/write-demo-solves.mts` |
| `npm run typecheck` | `tsc --noEmit` for the root configs, each package, and the Node-side files of `apps/web` (`tsconfig.node.json`) |
| `npm run lint` | `typecheck`, then `eslint .` (everything outside `apps/web`), then `ng lint` (`apps/web`: `src`, `e2e`, configs) |
| `npm test` | `vitest run` (`packages/**/src/**/*.test.ts`, Node), then `ng test --watch=false` (the app's `*.spec.ts`, jsdom, headless) |
| `npm run test:watch` | `vitest` in watch mode for the packages; the app: `npm run test -w @cubetrace/web` |
| `npm run test:rules` | `firebase emulators:exec --only firestore --project demo-cubetrace "vitest run --config firebase/vitest.config.ts"`: starts the Firestore emulator (port 8080, `firebase.json`), runs `firebase/*.test.ts` against it, stops it |
| `npm run test:functions` | `npm run build -w @cubetrace/functions`, then `firebase emulators:exec --only firestore --project demo-cubetrace "vitest run --config functions/vitest.config.ts"`: the functions' tests (`functions/src/*.test.ts`) against the Firestore emulator |
| `npm run build -w @cubetrace/functions` | `tsc -p functions/tsconfig.build.json`: the functions compiled into `functions/lib/` (gitignored), which deploys and the Functions emulator load |
| `npm run firebase -- <arguments>` | the Firebase CLI: `npx --yes firebase-tools@15.32.1 <arguments>`, downloaded into npm's cache on first use |
| `npm run e2e` | `playwright test -c apps/web/e2e/playwright.config.ts` (Chromium; report in `apps/web/e2e/playwright-report`); starts `ng serve` on port 4200 and a production build under `/cubetrace/` on port 4300 |
| `npm run e2e:cloud` | `npm run build -w @cubetrace/functions`, then `firebase emulators:exec --only auth,firestore,functions --project demo-cubetrace "playwright test -c apps/web/e2e/playwright.config.ts --project cloud"`: the Playwright project `cloud` against the Auth (9099), Firestore (8080) and Functions (5001) emulators, with `ng serve` on port 4200 and the bucket sink on port 4600 ("Cloud end-to-end", below) |
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

## GAN driver

Added by T1.5 on 2026-09-27. `@cubetrace/gan` wraps the owner's fork of the GAN driver,
[shermam/gan-web-bluetooth](https://github.com/shermam/gan-web-bluetooth) (MIT, by Andy Fedotov;
the fork is by the owner).

**A git dependency, pinned to commit `52417a1fcbe83a9cb1e76ab959a30a9cf9ffc3cb`** (the fork's
`main` on 2026-09-27): `"gan-web-bluetooth": "github:shermam/gan-web-bluetooth#52417a1…"` in
`packages/gan/package.json`. The fork has no build step (plain ES-module JavaScript in `src/`, no
`prepare` script), so npm installs it as it is: `npm ci` downloads the commit's tarball from
codeload.github.com, or clones it with git where that host is blocked (the agents' containers;
checked with an empty npm cache). Vendoring was not needed, and would also have needed the copied
files excluded from ESLint and Prettier. The fork's `package.json` has no `main` or `exports`, so
the entry point is imported by path, `gan-web-bluetooth/src/index.js`, and it ships no declaration
for it (TS7016): `packages/gan/src/driver.ts` types the part of the API the wrapper uses,
transcribed from the fork's `src/types.d.ts`, and imports the module under one
`@ts-expect-error`. The import is dynamic, so the driver is a lazy chunk of its own (59 kB raw, 19 kB
transferred, in the T1.5 check), which Chrome downloads once the cube code is there, in a browser
with Web Bluetooth (the preload, "Cube connection" below; before T1.14, on the first connection); the
service worker prefetches it with the other chunks. To update: `npm install
github:shermam/gan-web-bluetooth#<commit> -w @cubetrace/gan`, compare the fork's `src/types.d.ts`
with `driver.ts`, run the tests and the hardware checks of `docs/MANUAL-TESTS.md`.

**What the fork changes from upstream** [afedotov/gan-web-bluetooth](https://github.com/afedotov/gan-web-bluetooth)
3.0.2 (three commits on the 3.0.2 release, May 2026; `git diff 65173e2 52417a1`):

- No dependencies and no build: the TypeScript is rewritten as JavaScript with JSDoc
  (`src/types.d.ts` keeps the types), the rollup bundle is gone, `aes-js` is copied into
  `src/aes.js` (a comment in `src/gan-cube-encrypter.js` explains why WebCrypto's AES-CBC could not
  replace it), and RxJS is replaced by the browser's native Observable API (WICG:
  `EventTarget.prototype.when()`, `Observable.from`; present in Chromium 141).
- So `events$` is a cold native Observable: every subscription adds its own
  `characteristicvaluechanged` listener and runs the stateful protocol decoder again. The wrapper
  subscribes exactly once and multicasts through an RxJS Subject.
- The connection has no `disconnect()` and never emits `DISCONNECT`: its stream completes on
  `gattserverdisconnected`, and the cubes' own "disconnect" messages are ignored instead of
  closing the link. The wrapper turns the completion into a `disconnected` event, and disconnects
  by calling `gatt.disconnect()` on the device that the driver passes to the MAC provider.
- `now()` lost upstream's `process.hrtime` branch for Node; nothing changes in a browser.
- A regression in the Gen3 driver (GAN356 i Carry 2): `#evictMoveBuffer` pushes nothing
  (`evictedEvents.push()`), so that cube emits no moves; and the Gen3 and Gen4 `#checkIfMoveMissed`
  read the head of a move buffer that can be empty. Both of the owner's cubes (GAN 12 ui FreePlay,
  GAN 356 i3) speak the Gen2 protocol, which the fork leaves unchanged apart from the
  `DISCONNECT` handling above.

**Timestamps, verified in the fork's source.** Every driver event carries `timestamp`, the
driver's `now()` when its Bluetooth message arrived: `Math.floor(window.performance.now())` in a
window, `Date.now()` elsewhere (`src/utils.js`). So `hostMs = performance.timeOrigin + timestamp`
(up to 1 ms early because of the floor), and `hostMs = timestamp` outside a window
(`driverTimeToHost` in `connection.ts`). A Gen2 message carries up to seven moves; the driver emits
them oldest first, all with the message's `timestamp`, and sets `localTimestamp` on the newest only
(`null` on the others). That is the packet boundary, exposed as `packetLast` on move events
(`localTimestamp !== null`); the older moves of a packet share its `hostMs`. Moves that the Gen3
and Gen4 drivers recover after a loss also have `localTimestamp: null`. `cubeTimestamp` (Gen2: the
driver's running sum of the cube's 16-bit move-to-move deltas) is `cubeMs`; a recovered move
without one keeps the previous `cubeMs`.

**Connecting.** The Gen2 driver ignores moves until its first `FACELETS` event, so the wrapper
sends `REQUEST_FACELETS` as soon as the link is up (then `REQUEST_HARDWARE` and `REQUEST_BATTERY`,
one GATT write at a time, as Chrome requires), and `connectGanCube` resolves with the first valid
facelets report: asked again after 1.5 s, given up after 5 s (the way a mistyped MAC shows up).

**The Chrome flag.** The fork's README names no flag. The driver reads the MAC address with
`BluetoothDevice.watchAdvertisements()`, and the author's sample app (linked from the README) asks
for `chrome://flags/#enable-experimental-web-platform-features`. In Chromium
(`runtime_enabled_features.json5`, `content/child/runtime_features.cc`), `getDevices()` and
`watchAdvertisements()` are experimental features that
`chrome://flags/#enable-web-bluetooth-new-permissions-backend` (Android and desktop) turns on by
itself. Checked in Chromium 141 on 2026-09-27: with only Web Bluetooth enabled, both are missing;
adding the `WebBluetoothNewPermissionsBackend` feature exposes both. The support check names that narrower
flag (the one `docs/USER-ACTIONS.md` names) and uses `navigator.bluetooth.getDevices` to detect
`watchAdvertisements`, which lives on devices, not on `navigator`. On Linux, Web Bluetooth itself
needs `#enable-experimental-web-platform-features`.

## Cube connection

Added by T1.6a on 2026-09-27.

**The cube code loads right after the first render, not with the initial bundle.** The app
imports `@cubetrace/core` and `@cubetrace/gan` through their `index.ts`, and esbuild assigns whole
files to chunks: once a file of the initial bundle imports either package, every file behind those
indexes goes into the initial bundle too, `packages/core/src/scramble.ts` and its cubing.js chunks
included. Checked with `ng build --stats-json`: with the status pill and the connect dialog in the
initial bundle, it grew by 122 kB raw, 113 kB of it cubing.js. So `app.html` renders the pill and
the dialog in `@defer (on immediate)` blocks, with a static placeholder pill that already works: a
click on it is kept by `ConnectDialogService`, which stays in `main`, and the pill acts on it as
soon as it has loaded (T1.12; Chrome keeps a click's user activation, which Web Bluetooth's device
picker needs, for a few seconds). The pill, the dialog,
`CubeService`, `SettingsService` and both packages load in lazy chunks right after the first
render, shared with the Timer page. The initial bundle grew from 247.2 to 261.2 kB raw (69.6 to
73.5 kB transferred): 12.9 kB of Angular's `@defer` runtime, the placeholder, the dialog's open
state and the shared styles. The GAN driver is still a chunk of its own, which `CubeService` starts
loading as soon as it exists (T1.14, below). Checked again with T1.6b, once `scramble.ts` imported cubing.js lazily (see "cubing.js"):
an eager pill and dialog then bring no cubing.js along, but still cost 42 kB raw (13.8 kB
transferred) on the initial bundle, 305.4 kB against 263.3 kB, because the chunk optimizer then
merges core's attempt, phase and scramble modules into `main`; the `@defer` blocks stay. Checked
again with T1.12 (the one-click connection): 263.5 kB raw against 263.3 kB before, and 72.3 to
72.4 kB transferred either way (that estimate moves with the commit SHA the build embeds). The
connect dialog shows the flag's steps in two places through a component of its own, `FlagSteps`,
rather than an `<ng-template>` with `NgTemplateOutlet`, which the chunk optimizer put in `main`
(2.5 kB raw).

**The demo solves are a file in `public/`, fetched when a demo starts.**
`apps/web/scripts/write-demo-solves.mts` writes `apps/web/public/demo/solves.json`: the first 30
solves of `fixtures/solves.json` with only `scramble`, `scrambled_facelets`, `moves` (`[{m, ms}]`)
and `time_ms`, one solve per line, 57 kB (the script fails at 100 kB). npm runs it with
`write-version.mts` (postinstall, prestart, prebuild); the file is in `.gitignore` and is rewritten
only when it changes. A lazy chunk was the alternative, but the service worker's `app` asset group
prefetches every `.js` file, so the demo data would have been downloaded by every installation. The
`assets` group lists images and fonts only, so `demo/solves.json` is neither prefetched nor cached
(`dist/web/browser/ngsw.json` does not list it; `cube.spec.ts` checks this). Demo mode therefore
needs the network, apart from the browser's own HTTP cache.

**The demo makes the scramble's half turns as a real cube does** (T1.13). A GAN cube reports every
move as a quarter turn, so the demo cube turns each half turn of the scramble as two clockwise
quarter turns 60 ms apart (3 ms at speed 20); the scramble's moves still start 100 ms apart (5 ms at
speed 20). Before T1.13 a `U2` was one move event, which a real cube never sends, so the scramble
view's half-made state (yellow) could not be seen without a cube; the move log now counts a demo
half turn as two moves.

**Demo mode can mis-scramble on purpose** (T1.9). With `?demo=`, `&misscramble=<k>` makes the demo
cube turn one wrong face after scramble move k: a clockwise quarter turn of the first face, in the
order U R F D L B, that neither move k nor move k + 1 turns, nor their opposite faces, so that the
scramble tracker cannot take it for a step of the scramble (half of a half turn, or the next move of
an opposite pair made first). One second of replay time later (50 ms at speed 20) it turns the face
back and finishes the scramble; the attempt records `scrambleCorrected: true` and
`scrambleExtraMoves: 2`. k runs from 1 to one less than the number of scramble moves; other values
are ignored. "Demo cube" in the connect dialog passes it on like `?demo` and `?speed`, and Reconnect
keeps it.

**The demo replay is a list of parts, each started on a timer once the previous one has ended**
(`demoParts` in `apps/web/src/app/cube/demo.ts`, T1.9): the scramble (or its first k moves and the
wrong turn, then the inverse and the rest), cut before the second quarter turn of each half turn
(T1.13), then the solution. When a part's last move changes a signal, Angular schedules the page's
render on a zero-delay timer or the next animation frame, ahead of that timer, so the page shows the
state the part left before the next part starts: the half-made turn before its second quarter turn,
the undo guidance before the inverse, the armed attempt before the solve, however fast the replay
and however late its timers fire. The next part's schedule counts from after that render. Before
T1.9 the solution was queued while the scramble played, so its timers were set before the armed
render: its first move waited behind the render (and the frame after it) while the other moves kept
their times, and a solve measured 2 to 11 ms shorter than recorded, and up to 47 ms with the CPU
loaded (demo solve 1 lasts 750 ms at speed 20, where 5% is 37 ms).

**The GAN driver is preloaded** (T1.14). The first click on Connect could open the device picker
only once the driver's chunk had downloaded, and Chrome keeps a click's user activation, which
`requestDevice` needs, for a few seconds only. So `CubeService` calls `loadGanDriver()` when it is
created, in a browser with Web Bluetooth, right after the first render (the pill's `@defer` block),
without awaiting it and dropping a failure. `loadGanDriver()` keeps its promise, and
`connectGanCube` awaits that same promise, so a click after the download does not wait for it; a
failed load is not kept, and the click tries again. The unit tests give `CubeService` a loader that
imports nothing (`GAN_DRIVER_LOADER`).

**Mark as solved** (T1.14) is `CubeConnection.resetToSolved()`. A GAN connection writes the driver's
`REQUEST_RESET` (in the fork, a message that sets the cube's own state to solved, for the Gen2,
Gen3 and Gen4 protocols), then takes the solved state and emits it as a `facelets` event with
`reset: true`, then sends `REQUEST_FACELETS`: the cube's answer confirms the reset or, if the cube
disagrees, is adopted like any report. The flag lets `SessionService` tell a reset from a report: a
report of the solved state during a solve ends it (a resync, `docs/DATA-MODEL.md` §7), while a reset
drops the attempt without a record (§3). A notice sent before the event would have left the attempt
dropped even when the reset failed. The demo cube's replay stops at a reset (`FakeCube.stop()`), as
a solver's hands would; otherwise the rest of its scramble and solution would go on from the solved
state.

**The idle disconnection and the tab's visibility** (T1.14). `CubeService` restarts a timer on every
move of a GAN cube, and when a cube connects, on Mark as solved and when the setting changes; when
it runs out, it disconnects the cube with a reason that says why. The demo cube, which has no
battery, is never disconnected this way. The timers and the tab's visibility come through
`BROWSER_GLOBALS` (`setTimeout`, `clearTimeout` and `document`), which the unit tests fake with
`FakeTimers`, on the clock of `FakePerformance`, and `FakeDocument`. Chrome throttles the timers of
hidden tabs (to one wake-up a second, and some timers to one a minute once the tab has been hidden
for five minutes), so in a background tab the disconnection can come up to a minute late; that is
fine. When the tab is shown again with a cube connected, `CubeService` asks the cube for its state
once, so that turns the app missed while the tab was hidden are caught up (the facelets report is
adopted, and the timer resyncs); nothing connects by itself, since Web Bluetooth needs a click.

**Disconnect diagnostics** (T1.14). When a connection ends without the app asking (`disconnect()`),
`CubeService.disconnectReason` is the connection's own reason followed by how long the cube had gone
without a turn (or since connecting), whether the tab was hidden, and, past two minutes, that GAN
cubes go to sleep; the pill's tooltip, the Timer page and the connect dialog show it. The console
gets one `console.info` line with the raw facts, for the owner to paste into an issue:
`cubetrace: the cube disconnected {"reason":…,"idleMs":…,"visibilityState":…,"hiddenMs":…,
"connectedMs":…,"battery":…,"model":…}` (ms; `hiddenMs` is null while the tab is visible).

## cubing.js

Added by T1.2 on 2026-09-27. Version 0.63.7, a dependency of `@cubetrace/core` (its own dependencies,
such as `three` and `type-fest`, come through the lock file). `packages/core/src/scramble.ts`
imports two of its ES module entry points, `cubing/scramble` (`randomScrambleForEvent`) and
`cubing/search` (`setSearchDebug`); their types resolve with the base `tsconfig` as it is
(`moduleResolution: bundler`, `"types": []`). Since T1.6b it imports them dynamically, on the first
call of `generateScramble()`: with static imports, any chunk that the build gave `scramble.ts` (the
chunk optimizer groups it with the core code that the cube pill needs) also pulled cubing.js's
static chunks, so every page downloaded about 100 kB of cubing.js after its first render (checked on
`/settings`: 101 kB of cubing.js before, none after). cubing.js searches in a module worker: a Web Worker
in the browser, a `node:worker_threads` worker in Node (found through
`process.getBuiltinModule`, hence its Node 22.3 minimum), unreferenced so that it never keeps Node
alive.

- *Vitest and Node:* nothing to configure. The package tests generate 20 scrambles in a worker
  thread in about 0.6 s, worker start included, well within Vitest's default 5 s timeout; the app's
  tests (jsdom) run it the same way when they render the Timer page.
- *Angular build:* nothing to configure either. The application builder (and Vite's dependency
  optimizer under `ng serve`) emits cubing.js's worker entry as a chunk of its own, which cubing.js
  reaches with what it calls its esbuild workaround (`await import("./search-worker-entry.js")`,
  then that chunk's `import.meta.url`). Its default first attempt,
  `import.meta.resolve("./search-worker-entry.js")`, names a file that neither build emits, so every
  first scramble of a page began with a failed worker and a 404 (and, under `ng serve`, Vite's
  warning "The file does not exist at .../vite/deps/search-worker-entry.js") before the fallback
  worked. `generateScramble()` therefore calls, once, before its first scramble,
  `setSearchDebug({ prioritizeEsbuildWorkaroundForWorkerInstantiation: true, logPerf: false })`:
  the flag is cubing.js's own switch for this case (its source: "This can prevent a request to
  `search-worker-entry.js` when it doesn't exist, if the library semantics have been mangled by
  `esbuild`"); `logPerf: false` drops the console warning it otherwise prints with the duration of
  every scramble search. Not at import time: the package declares `"sideEffects": false`.
- *Output:* cubing.js is only in lazy chunks and adds nothing to the initial bundle (checked with
  `ng build --stats-json`: no cubing.js module in any initial chunk). The build emits about 1.2 MB
  of it in 24 chunks (335 kB gzipped); a 3x3x3 scramble loads about 110 kB of that (the worker
  entry, the worker's own chunk, the 3x3x3 search and shared chunks). The rest is cubing.js's code
  for other puzzles and searches, which the timer never loads; the largest is its WebAssembly
  search, `twips` (671 kB). Every JavaScript file of the build is in the `app` asset group of
  `dist/web/browser/ngsw.json` (all 31 on 2026-09-27), so the service worker prefetches all of
  cubing.js, the unused chunks too; a lazy asset group for those would save that download if
  install size ever matters.
- *Checked end to end:* `apps/web/e2e/scramble.spec.ts` expects a scramble on the Timer page, and
  a worker, on the dev server, on the production build under `/cubetrace/`, and on that build
  offline after the service worker has cached it.
- *The scramble picture (T1.6b):* the Timer page shows cubing.js's `<twisty-player>` (2D, the
  scramble as `experimental-setup-alg`), a custom element that `cubing/twisty` defines when it is
  imported. `apps/web` depends on `cubing` itself for it, at core's version, and the scramble view
  imports `cubing/twisty` dynamically (`TWISTY_LOADER`, which the unit tests replace), so it is a
  lazy chunk: 116.4 kB raw, 28.7 kB transferred, plus 4 kB of shared helpers. The 2D player never
  loads the 3D renderer, a 509 kB chunk of its own (checked with Playwright's network log on the
  production build).

## Timer and sessions

Added by T1.6b on 2026-09-27.

**`@cubetrace/storage` is a workspace package like `core` and `gan`** (plain TypeScript, `src/index.ts`
through the `@cubetrace/*` paths, Vitest in Node, `sideEffects: false`). `OpfsSessionStore` writes the
files of `docs/DATA-MODEL.md` §5 through the File System API; it takes the root directory handle (or
the promise `navigator.storage.getDirectory()` returns), so its tests run against
`FakeDirectoryHandle`, an in-memory OPFS with Chrome's errors, and the `SessionStore` semantics are
tested on it and on `MemorySessionStore` alike. The real OPFS is exercised in Chromium by
`apps/web/e2e/timer.spec.ts`, whose session survives page loads. The app picks the store through
`SESSION_STORAGE` (`MemorySessionStore`, with a warning on the Timer page, where the browser has no
OPFS); unit tests provide a `MemorySessionStore`.

**The timer's unit tests drive a real `SessionService`** (`src/app/session/session-harness.ts`): the
fake cube connected as a GAN cube on a fake host clock (`FakePerformance`), fixed scrambles
(`SCRAMBLE_SOURCE`), animation frames that run when the test says (`FakeAnimationFrames`) and an
in-memory store. `BROWSER_GLOBALS` now also carries `performance`, `requestAnimationFrame` and `URL`.

**Sizes** (production build, 2026-09-27): the initial bundle is 263.3 kB raw, 72.3 kB transferred
(261.2 and 73.5 before T1.6b); the Timer page's chunk 27.5 kB (7.7 kB), `SessionService` with the
store 18.3 kB (5.3 kB, shared with the Sessions page), the Sessions page 5.4 kB (2.0 kB), and the
scramble picture as above.

## End-to-end suite

Added by T1.9 on 2026-09-27: the flows of `docs/PLAN.md` T1.9 in `apps/web/e2e/`, driven by the demo
cube.

| Flow | Spec | What it checks |
|---|---|---|
| 1. Full attempt | `attempt.spec.ts` | Demo solves 0, 1 and 13 (the one whose cross is on F; the others' is on U) at speed 20, each replayed twice, the second time from the connect dialog: solved; the second replay's time on the timer within 5% of the fixture's `time_ms` / 20; eight phases in the chart; in both records, `crossFace` and each phase's moves and F2L slot as `detectPhases` finds them in the fixture, `status` solved, `replayOk`, `movesQtm` equal to the fixture's `quarter_turns`. |
| 2. Mis-scramble | `misscramble.spec.ts` | `&misscramble=5`: the undo guidance shows the inverse of the wrong turn, then clears; the attempt arms and is solved; the export has the wrong turn and its inverse among the scramble's moves, `scrambleCorrected: true` and `scrambleExtraMoves: 2`. |
| 3. DNF | `timer.spec.ts`, second test | Esc during the solve (speed 5): the row and the time say DNF; once the replay has solved the cube, attempt 2 begins with a scramble of its own; the DNF's record. |
| 4. Reload | `reload.spec.ts` | After a solve, a reload: the page shows the stored solve and attempt 2 at once, and the demo solve, replayed again, becomes attempt 2 of the same session. |
| 5. Export | `export.spec.ts`, and the export of every other flow | A session with a solved, corrected attempt and a DNF validates against both schemas; copies that break either schema fail with ajv's message. |
| 6. Settings | `inspection.spec.ts` | The inspection switch on: the armed attempt shows the countdown from 15; switched off: 0.00 and no countdown. |
| Mark as solved (T1.14) | `reset.spec.ts` | Demo solve 0 at speed 0.25: "Mark as solved" in the Cube section while the scramble is part-way: the net shows solved, the demo cube stays connected, attempt 1 begins again (0 / 21, the same scramble), no row; the recorded views show the scrambling attempt just before. A page load with `?demo=0&speed=20` then solves attempt 1 in the same session, and the export has that one attempt. |
| Idle setting (T1.14) | `cube.spec.ts`, last test | Settings shows the idle disconnection at 5 minutes; 1 survives a reload; 61 is refused with its message. The timer itself is tested in the unit tests, on a fake clock. |
| Scramble marks (T1.13) | `scramble-colours.spec.ts` | Demo solve 1 at speed 20: each of its 11 half turns marked partial after its first quarter turn, then done; every view while scrambling agrees with its progress; all moves but the last done before the attempt arms, all done while armed, none from the solve on. `&misscramble=5` (demo solve 0): move 6 marked wrong exactly while the undo guidance shows, then done; all done while armed. |
| Recording (T2.4) | `recording.spec.ts` | Chrome's fake camera at 30 fps and its microphone, demo solve 0 at speed 20: four replays with the camera off, then four with it on, each waiting for the last one's clips; every attempt recorded has its two clips in OPFS, their frames files valid, each clip from its margin (2 s before the scramble's first turn, 3 s before the solve's) to at most one GOP earlier and to about 1 s after its segment; the viewer plays the last solve clip (`loadedmetadata`) with its moves, and Download gives the five files with the sizes of the record; the export validates; the median `timeMs` with the camera on is within 5 ms of the median with it off. With the demo cube's gyroscope on (`?gyro=1`, T3.7): attempt 1 without a camera gets its `gyro.json` a second after the solve (truncated: the demo connected a moment before its scramble), attempt 2 with the camera on its six files, the frames files naming the build, the gyro window reaching back 2 s, the download of six files, the export with both summaries. In the capture lab, a 10 s clip saved mid-way: no frame dropped and no double interval in the second after it. The file's three tests run one after the other (`mode: 'default'`): each encodes 1080p30 in software. |
| Sync check (T2.5, T2.8, T2.11) | `sync-check.spec.ts` | Chrome's fake camera at 30 fps, demo solve 0 at speed 20: once the solve is recorded, the camera on; when it records, the check is due and, the whole frame being framed, asks for a rectangle around the cube first ("Edit the framing"; the timer goes on); "Start anyway" starts it: it asks to hold still for a second, then counts down for the first turn (the capture worker's frames counted), the timer's status says `sync-check`, the scramble and "Attempt 2" stay; after 20 s without a turn it fails with "the cube did not move" (the demo has finished: the same outcome every run), with Retry and "Download check data", whose file has the whole motion series, the camera, how its frames were read and the frames' clock within 1 s of the page's; attempt 2 is back with its scramble; Retry, Later and "Sync check" start and hide it; the export has no `clock.cameras` entry and the one attempt of the solve. A second test draws the rectangle with the keyboard in the editor that "Edit the framing" opens: the hint goes, Start starts the check, and Full frame brings the hint back. In the capture lab, a 6 s check with the demo cube's turns shows the latest frame's motion in its bars (the mean difference above 0), the frames' format and "copied out", reports its outcome and the capture worker's time per frame, which it prints, and saves its data. |
| Session with clips (T2.6) | `session-clips.spec.ts` | Chrome's fake camera at 30 fps and its microphone, demo solve 0 at speed 20: the solve that starts with the page, recorded before the camera is on, is deleted (Delete last); the camera on, the sync check that starts by itself is ended with Later; two replays, each with its two clips; then a new page load straight to the session's page: both attempts listed with a badge "2 clips, …", "4 clips, …" in its header, the first attempt's solve clip plays in the viewer, and the page's Export validates against schema 2; every clip of the records is a file in its attempt's folder in OPFS, the MP4 of the record's size and the frames file valid against its schema, with the record's frame count and first frame, and nothing else is there but `attempt.json`. |
| First render (T2.6) | `timer-render.spec.ts` | On the production build under `/cubetrace/`, after a demo solve (a session with a stored solve), the first animation frame that shows the clock comes within 2 s of `DOMContentLoaded`, with the camera setting off and on; with the camera (`getUserMedia`) and the storage (`navigator.storage.getDirectory`) each held back 3 s, the clock still comes within 2 s, and the solve list and the camera's preview after them. Recording is off in the file (no `MediaStreamTrackProcessor`), as in `timer-layout.spec.ts`. It prints the times: over three runs, the clock 44 to 83 ms after `DOMContentLoaded` with the camera off or on, the solve list 104 to 177 ms and the preview 137 to 194 ms; held back, the clock 39 to 104 ms, the list 3,056 to 3,121 ms and the preview 3,139 to 3,237 ms. |
| Microphone (T2.12) | `microphone.spec.ts` | Chrome's fake camera at 30 fps and its microphone: Settings → Camera → Microphone says Raw, with its line of help; after demo solve 0 at speed 20, the Timer page without the demo cube (the session resumed, so no attempt and no sync check begins), the camera on: the codecs line ends with "opus, mic raw" and no notice shows; the export's `cameras[0].microphone` says `processing: 'raw'` with the four processing settings false, as the fake microphone reports them raw, and a sample rate and channels; Voice in Camera settings starts the recording again, which says "mic voice", and the export then says echo cancellation, noise suppression and gain control on; after a reload, Voice in Camera settings and in Settings, and "mic voice". It prints both records. |
| Camera labels (T2.14) | `camera-labels.spec.ts` | Three of Chrome's fake cameras (`--use-fake-device-for-media-stream=device-count=3,fps=30`) and its microphone, demo solve 0 at speed 20: the solve that starts with the page deleted (Delete last); a solve recorded with `fake_device_0`, one with `fake_device_2`, chosen in Camera settings (the sync check is due for it, a camera without a check in the session: Later sets it aside), and one with `fake_device_0` again (no check is due: the session has its label, whose check was set aside); the export validates, with the entries `laptop` (`fake_device_0`) and `laptop-2` (`fake_device_2`) and no `clock.cameras` (the fake camera gives no check), each attempt's two clips named after its camera's label, in its folder in OPFS beside `attempt.json` alone, and the session's page says "laptop (fake_device_0), laptop-2 (fake_device_2)". `fake_device_1` is left out: it sends 16-bit depth frames (Y16, a `VideoFrame` whose `format` is null), which Chromium's VP9 encoder refuses ("OperationError: Encoding error"), as a probe of the three cameras found on 2026-10-02 (the other two send I420). About 32 s. |

`timer.spec.ts`'s first test is T1.6b's flow (demo solve 0, the Sessions page after a page load, the
export), without its time check, which flow 1 makes on a settled page (below). The helpers in
`apps/web/e2e/helpers/` are shared by the flows:

- **The fixtures are the oracle.** `fixtures.ts` reads `fixtures/solves.json`, whose first 30 solves
  are the demo's, and runs `@cubetrace/core`'s phase detector on them in the test. Specs import
  `@cubetrace/core` as a package: Playwright resolves it through the `@cubetrace/*` paths of
  `tsconfig.base.json` and transpiles its TypeScript.
- **Every export is validated.** `export.ts` opens the Sessions page from the navigation (no reload),
  exports the browser context's one session and validates `session` against `session.schema.json`
  and each attempt against `attempt.schema.json` with ajv (draft 2020-12, `allowUnionTypes`, all
  errors), so a flow fails with ajv's text, such as "attempts[0]/crossFace must be equal to one of
  the allowed values".
- **States that last one render are recorded, not polled.** At speed 20 the armed attempt lasts until
  the solution's first move, a few milliseconds, and a mis-scramble's guidance 50 ms, while
  Playwright's assertions poll every 100 ms to 1 s. `timer-views.ts` installs a MutationObserver
  before the page's own scripts run (`page.addInitScript`) that records every state the Timer page
  renders (the status line, the time, the attempt's number, the progress, the undo guidance, the
  scramble and its moves' marks, the solve list); flows 2, 4 and 6 and the scramble marks check that
  record, which also goes into the report as `timer-views`.
  That the page renders those states at all is the demo's doing (the replay's parts, above).
- **Times are checked on a settled page.** The replay that starts with the page runs while the page
  is still loading: cubing.js builds its search tables in a worker and the scramble picture's chunk
  is evaluated. With the CPU busy, that holds the demo cube's timers back by tens of milliseconds,
  and demo solve 1 lasts 750 ms at speed 20, where 5% is 37 ms. Measured on 2026-09-27 with four
  workers on four CPUs, 24 solves each: the replay that starts with the page was 4.0% short to 6.1%
  long, and a second replay once the next attempt's scramble is on screen, from the connect dialog
  (Disconnect, then Demo cube, which takes `?demo` and `?speed` from the address), 1.4% short to
  1.6% long. Flow 1 therefore times the second replay (`replayDemo` in `timer.ts`). With two
  workers, T1.6b's check of the first replay was 0.5% to 4.2% short over 20 runs, too close to 5%,
  so it was left to flow 1.
- **No fixed waits and no retries.** Every wait is on a `data-testid`'s content, an attribute or a
  download. The DNF flows run at speed 5 (solves of 4.3 and 6.9 s), which leaves seconds to press Esc
  after the solve starts although assertions poll up to 1 s apart.
- **The specs that record run one at a time** (T2.6). `capture.spec.ts`, `recording.spec.ts`,
  `session-clips.spec.ts` and `sync-check.spec.ts` (and since `video-quality.spec.ts`, T2.10,
  `microphone.spec.ts`, T2.12, and `camera-labels.spec.ts`, T2.14) record Chrome's fake camera,
  encoding 1080p30 VP9 in software; they
  are the Playwright project `encoding`, limited to one worker (the project's `workers` option) and
  listed first, so that the next of them starts as soon as one ends, while the other specs, the
  project `chromium`, run in the other worker. Two encoders at once on four CPUs lose frames and
  hold back the demo cube's timers: when `session-clips.spec.ts` joined the suite,
  two of three runs in a row failed, once on a frame lost in the second after a save in
  `recording.spec.ts`'s no-drop test (an interval of 67.1 ms, with `sync-check.spec.ts` encoding in
  the other worker) and once on its timing check (the medians with the camera on and off 5.05 ms
  apart, over its 5 ms, with `session-clips.spec.ts` encoding beside it). With the project, three
  runs in a row passed, the medians 0.4, −1.4 and −3.6 ms apart, and no frame lost after a save.

The whole suite (34 tests, two workers) took 44 s and 59 s in CI in the pull request's first two
runs (the `npm run e2e` step, servers included; T1.6b's suite took 40 s), and 58 to 60 s locally on
four CPUs in three runs in a row on 2026-09-27. With T2.4 it has 49 tests and took 2.3 min locally
(Playwright's count) in each of four runs in a row, 2 min 20 s with the servers; it was 1.6 min
before T2.4 (47 tests), the recording flow alone taking about 30 s. With T2.5 and T2.7 it had 55
tests and took 2.7 min in CI (2 min 43 s for the `npm run e2e` step, on `main` at 21c7bca) and
2.8 min locally (2 min 50 s with the servers). With T2.6's two flows and the `encoding` project it
has 57 tests and took 2.8, 2.9 and 2.9 min locally in three runs in a row on 2026-09-27 (2 min 52 s
to 2 min 58 s with the servers), and 2.8 min in CI (2 min 50 s for the `npm run e2e` step) in
its pull request's first run; the specs that record take 132 to 135 s of it, one after the other.

Since T3.5 the suite also has a project `cloud`, which only runs inside the Firebase emulators
(`npm run e2e:cloud`, after `npm run e2e` in CI; "Cloud end-to-end", below): `npm run e2e` is as it
was.

## packages/capture

Added by T2.1 on 2026-09-27: `@cubetrace/capture`, a workspace package like `core`, `gan` and
`storage` (plain TypeScript, `src/index.ts` through the `@cubetrace/*` paths, Vitest in Node,
`sideEffects: false`), which imports only types from `@cubetrace/core` (`CameraInfo`, `CropRect`).
T2.1 put the camera in it (`camera.ts`, `sharpness.ts`, `framing.ts`); T2.2 adds the encoder
pipeline. The Timer page's Camera section is `apps/web/src/app/camera/`.

**Tracks are parameters.** The functions take a track, or the part of it they use (`getSettings`,
`getCapabilities`, `applyConstraints`), and read no browser global, so their tests run in Node on
the three probe reports of `docs/devices/` (the MacBook's camera has no control; the ThinkPhone's
have exposure, focus, white balance and zoom, and the rear one a torch), and `cameraInfo()` is
checked against schema 2's `camera`. The app reads `navigator.mediaDevices` through
`BROWSER_GLOBALS`; its unit tests use `FakeMediaDevices` (`device/fake-browser.ts`), and
`e2e/camera.spec.ts` and `e2e/camera-denied.spec.ts` use Chrome's fake camera
(`--use-fake-device-for-media-stream`), a green test pattern at 20 fps with manual exposure and focus.

**Manual controls.** Chrome adds the Image Capture controls to a camera track: `exposureMode`,
`exposureTime` (in units of 100 µs), `iso`, `focusMode`, `focusDistance`, `whiteBalanceMode`,
`colorTemperature`, `zoom`, `torch`. TypeScript's DOM types describe none of them, so they are read as
unknown values and checked. They are set with `applyConstraints({advanced: [...]})`, one constraint
set per group (exposure, focus, white balance, zoom, torch): Chrome applies each set it can satisfy
and skips the others without an error (checked in Chromium 141 with the fake camera: an
out-of-range focus distance left the exposure set applied), so each value is first fitted to its
range and steps, and a group the camera refuses leaves the others alone. Only Image Capture
constraints are sent, which leave the track's size and frame rate as they are. The ThinkPhone's front
camera lists only `manual` focus while its setting is `continuous`: the mode a setting reports counts
as one the camera has, and a camera that does not go back to an automatic mode by a constraint is
reopened (a new capture starts in the automatic modes, and the other kept controls are applied
again). "Reset to auto" reopens the camera for the same reason. The torch is never kept: it would
light by itself at the next start.

**What was asked, and what came.** `buildConstraints` asks for the chosen camera (else
`facingMode: {ideal: 'user'}`, the front camera on a phone) at 1920×1080 ideally and 60 fps
ideally, or exactly 60 when Settings says so. When `getUserMedia` fails, `fallbackChoice` gives the
next thing to ask for and the notice says it: the default camera when the chosen one is gone (Chrome
reports an unknown id as an OverconstrainedError on `deviceId`), the camera's best rate when exactly
60 fps is refused (an OverconstrainedError on `frameRate`), 1280×720 at 30 fps when the camera could
not start (a NotReadableError, after one retry 0.5 s later, in case it was this app's own camera
closing). Both of the ThinkPhone's cameras claim 60 fps and deliver 30 (`docs/DEVICES.md`), so the
panel shows, next to the track's claim, the rate measured on the preview with
`requestVideoFrameCallback`: the frames presented (`presentedFrames`, which counts the ones no callback
saw) over the last second of the camera's own clock (`mediaTime`), and the size of the frames as
they arrive.

**Snapshots.** `snapshot()` copies `getSettings()` and `getCapabilities()` as JSON for
`session.json`: every key with a JSON value (a number only when it is finite), ranges as
`{min, max, step?}`, except `deviceId` and `groupId`, hashed identifiers of the browser's
installation that say nothing about the pictures (the probes in `docs/devices/` have them redacted
for the same reason); the `constraints` of `cameraInfo()` leave the device id out too.

**Sharpness.** The variance of the 4-neighbour Laplacian of the luma (BT.601 weights) of the framing
rectangle drawn into an `OffscreenCanvas` (`willReadFrequently`): until T2.7, 320 pixels wide on
every 10th frame of the preview; since, 160 pixels wide at most twice a second and never during a
solve (see "Timer layout (T2.7)" below, with the numbers at 160). Calibrated on Chromium 141's fake
camera on 2026-09-27, at 320 pixels wide, over 12 s of frames (24
measurements each): the whole frame measured 76–135, a centred 1080×1080 square 30–93 and a centred
half 55–145; the same frames blurred by 1 pixel at 320 wide (a canvas `blur(1px)` filter, about 6
pixels at 1080p) 1.4–8.7; black frames 0. The default threshold, 20, lies between the two with a
margin each side; since the number depends on the scene as much as on the camera, it is a setting,
which the owner's round 2 sets for real cameras. A measurement took 12 ms (18 at most) in headless
Chromium, whose canvas is software; three a second at 30 fps.

**Framing.** The rectangle is in the pixels of the frames as they arrive (a phone held upright
delivers 1080×1920 while its settings may say 1920×1080), at least a tenth of the shorter side, and
is kept in Settings per camera label and frame size: another size of the same orientation scales it,
a turned picture starts from the full frame. `cameraInfo()` records it as `crop`, null for the whole
frame; `mode` stays `full` in phase 2.

**Sizes** (production build, 2026-09-27, against `main` at a44a0ae): the panel and all of
`@cubetrace/capture` are one lazy chunk, `camera-panel`, 37.8 kB raw (11.2 kB transferred), which the
Timer page loads right after it renders (`@defer (on immediate)`), so that a camera left on opens
again with the page. The initial bundle has no camera code: 263.66 kB raw against 263.53 (72.4 kB
transferred against 72.3), of which 0.1 kB is the global style of `select` and range inputs. The
Timer page's chunk grew by 0.4 kB; the chunk shared by the cube pill and the pages, which holds
`SettingsService`, by 3.3 kB raw (0.9 kB transferred): the camera settings and their checks, which
import only types from the package.

## The capture pipeline (`packages/capture`)

Added by T2.2 on 2026-09-27: the encoder pipeline of `packages/capture` (`pipeline.ts`,
`protocol.ts`, `capture-worker.ts`, `ring-buffer.ts`, `cut.ts`). Like the camera code, it imports
only types from `@cubetrace/core` (`FramesJson`), so nothing of core reaches the worker; the muxer
(T2.3) comes next to it.

**The capture worker is a chunk of its own, built by Angular's builder.** `pipeline.ts` starts it
with `new Worker(new URL('./capture-worker.ts', import.meta.url), { type: 'module' })`. The
application builder recognises exactly that form (a `new Worker` or `new SharedWorker` of a
`new URL` of a string literal and `import.meta.url`) in the TypeScript it compiles, the packages
included, since the `paths` put them in its program: its web worker transformer bundles the file
with esbuild as an entry of its own, `worker-<hash>.js`, and rewrites the URL; there is nothing to
configure. That bundle is built without Angular's plugins, so the build does not type-check it;
`npm run typecheck` does, through `packages/capture/tsconfig.json`. The package's index never
imports `capture-worker.ts`, whose code is therefore only in the worker, and the file installs its
message handler only where `DedicatedWorkerGlobalScope` exists, so that Node's tests can import
its `CaptureWorker` class. Checked with `ng build` on 2026-09-27, on `main` with T2.1: the worker is
11.5 kB raw (4.4 kB gzipped: the worker loop, the ring buffer, the cut and the protocol), a file the
CLI's table of chunks does not list, which `index.html` does not load and `ngsw.json` lists, so the
service worker prefetches it with the other scripts. The initial bundle grew by 128 bytes, the
`/capture-lab` route's entry, and by nothing else (263.66 to 263.79 kB raw). The code that starts
the worker, the pipeline's window side (`pipeline.ts` and `protocol.ts`), is in the chunk of
`@cubetrace/capture`'s files: the build assigns whole files to chunks ("Cube connection" above), and
the capture lab and the camera panel both import the package, so all of its files make one chunk
that the two share, 11.7 kB raw (4.6 kB gzipped). The camera panel, which the Timer page loads right
after it renders, therefore loads the pipeline's window side too: 3.6 kB raw (2.1 kB gzipped) more
with everything it imports (86.5 kB raw against 82.9); T2.4 records from the Timer page, which needs
that code anyway. The lab's own chunk is 11.5 kB raw (4.4 kB gzipped); `shared/error-message.ts`,
which the lab uses too, moved into a 149-byte chunk of its own. The dev server serves the worker from
the same build; `apps/web/e2e/capture.spec.ts` starts it on `ng serve` and on the production build
under `/cubetrace/`.

**`MediaStreamTrackProcessor` is typed by the package.** TypeScript's DOM library (6.0.3) declares
`VideoEncoder`, `AudioEncoder`, `VideoFrame`, `AudioData` and the encoded chunks, but
`MediaStreamTrackProcessor` only for workers (`lib.webworker.d.ts`, without the `track` of its init),
while Chrome has it on the window only (`docs/DEVICES.md`). `packages/capture/src/webcodecs.d.ts`
declares the window's constructor as a type, and `startCapture` reads it from `globalThis` once it
has checked that it exists: no global declaration, so none can clash with another one.

**Codecs.** The worker asks `VideoEncoder.isConfigSupported` in this order: H.264 High
(`avc1.640028`) with `hardwareAcceleration: 'prefer-hardware'` (the platform's encoder or nothing),
then `'no-preference'`, then H.264 Main (`avc1.4d0028`) the same way, then VP9 (`vp09.00.40.08`,
`'no-preference'`). Every config asks the bitrate of the start's video quality (T2.10: 4, 8 or 12
Mbps at 1080p30, 1.5 times as much at 1080p60, in proportion to the pixels at other sizes; before
T2.10, 8 and 12), `latencyMode: 'quality'` and the frame rate measured from the frames'
timestamps during the first half second; H.264 adds `avc: {format: 'avc'}`, which puts the
parameter sets in the decoder config's `description`, as MP4 wants them. Audio: AAC-LC
(`mp4a.40.2`) at 128 kbps and the track's sample rate and channels, else Opus, else none. The
codecs chosen are in the counters (`codec`, `audioCodec`) and in every cut.

**What CI's Chromium encodes.** Playwright's Chromium 141, the browser of CI and of the agents'
containers, is a build without proprietary codecs: it has no H.264 encoder at all (neither
`prefer-hardware` nor `no-preference`) and no AAC encoder; it encodes VP9, VP8 and AV1 in software
(`prefer-hardware` is refused for every codec) and Opus. So CI records VP9 and Opus, and the H.264
and AAC paths run only in Chrome on real devices (the probes found hardware H.264 at 1080p on both of
the owner's; round 2 notes the audio codec). Software VP9 keeps up with the fake camera at 1080p30
in the containers (four CPUs): no frame dropped over 96 s, the encoder's queue never above 1, 12 ms
from `encode()` to the chunk at the median and 21 ms at the 95th percentile; the fake camera's
test pattern takes about 1.2 Mbps.

**Chrome's fake camera** (`--use-fake-device-for-media-stream`) gives 1920×1080 I420 frames at
20 fps unless the flag says `fps=30`, as `capture.spec.ts` does to have the 1080p30 of the real
cameras (`--use-fake-device-for-media-stream=fps=30`); its frames have no `duration`, and its
microphone gives 48 kHz mono in 10 ms buffers with the browser's voice processing, 44.1 kHz stereo
without it (raw, as the recording asks for it since T2.12: "Microphone (T2.12)", below).

**The capture lab** (`/capture-lab`, lazy, not in the navigation, with a plain message in a browser
without the APIs, as the probe has) runs the pipeline on a chosen camera, shows its counters once per
second and prints cuts as JSON, with the frame times and a summary of what the frames' clock is. The
end-to-end test drives it; the owner runs it on the real devices in round 2 (`docs/DEVICES.md`,
"VideoFrame.timestamp").

## Clips: MP4 muxing and OPFS writing (`packages/capture`)

Added by T2.3 on 2026-09-27: `mux.ts` turns a cut into an MP4 and its frames.json, `clip-writer.ts`
writes both into the attempt's folder, and the capture worker does both on `saveClip`, so that the
MP4 never crosses to the window. Neither file is exported by the package's index: they are the
worker's.

**Why mediabunny.** WebCodecs gives encoded chunks, and the browser has no API that writes them into
a file a player opens. mediabunny (by Vanilagy, MPL-2.0) is a TypeScript library whose only
dependencies are type declarations; it muxes encoded packets as they are, without decoding them,
into MP4 among other formats; its modules are side-effect free, so a build keeps only what is used;
it supersedes the same author's `mp4-muxer`, deprecated on npm in its favour; and it runs in Node,
so the muxer is tested there. The plan named it (`docs/PLAN.md`, T2.3). 1.60.0 was the latest
release on npm on 2026-09-27 (published on 2026-09-25); `packages/capture/package.json` asks
`^1.60.0`, like the other dependencies, and the lockfile holds 1.60.0. MPL-2.0 is copyleft per file:
the app bundles the files unmodified from npm, and a modified mediabunny file would have to be
published under the same license. Its type declarations reference `@types/dom-webcodecs` and
`@types/dom-mediacapture-transform`, which repeat declarations of TypeScript's own DOM library;
`skipLibCheck` (in `tsconfig.base.json` since T1.0) keeps their conflicts out of the type check, and
nothing in the repository relies on them.

**How the packets are built.** `muxClip(cut, {camera, segment})` makes an `Output` with
`Mp4OutputFormat({fastStart: 'in-memory'})` (the `moov` box before `mdat`, so that a player starts
at once) and a `BufferTarget`, an `EncodedVideoPacketSource` (`avc` or `vp9`, from the codec string)
and, when the cut has audio, an `EncodedAudioPacketSource` (`aac` or `opus`). Each chunk becomes
`new EncodedPacket(bytes, type, timestamp, duration)` from the ring buffer's record, the times in
seconds from the first frame's timestamp, so that the clip starts at 0 at its keyframe
(`EncodedPacket.fromEncodedChunk` would need `EncodedVideoChunk` objects, which the buffer does not
keep and Node does not have). The first packet of each track carries the encoder's decoder config:
for H.264 its `description`, the avcC of `avc: {format: 'avc'}`; for VP9 mediabunny writes the vpcC
from the codec string and the colour space (`vp09.00.40.08.01.06.06.06.00` on the fake camera); for
Opus the dOps from the OpusHead description, its pre-skip included; for AAC the esds from its
AudioSpecificConfig, which the capture worker makes itself from the encoder's settings when the
encoder's first chunk has no decoder config (T2.9). The packets of both tracks go in by time, so the
file interleaves them in half-second chunks. The audio keeps its place by its own timestamps (the
capture clock is shared, `docs/DEVICES.md`), or, when its arrival offset is more than 100 ms from
the frames' (a clock of its own), by the cut's `rebaseMs` (T2.9): chunks that end before the first
frame are left out, and the one that overlaps it starts before 0, which mediabunny writes as an edit
list. The video's time scale is mediabunny's default, 57,600 per second, with no frame rate set, so
the frames keep their measured intervals to 17 µs (the exact times are in frames.json). A frame
whose chunk has no duration lasts until the next frame, and the last one the median interval. Muxing
takes 2 ms for 1 s of the fake camera, 20 ms for 30 s (5 MB) and 50 ms for 90 s (15 MB) in Node on
the agents' containers (medians of the committed sample repeated); the bytes are the encoder's,
never decoded.

**Chrome's chunks of frames without a duration say 0, not null.** The fake camera's frames have no
`duration`, and the VP9 encoder's chunks then have `duration` 0: the recorded sample showed it, and
T2.2's worker, which replaced only a missing duration with the measured frame interval, had kept the
0. It now replaces 0 too (`capture-worker.ts`), so the buffer's `bufferSeconds`, a cut's audio span
and `truncatedEnd` count the last frame's duration, and the MP4's last frame lasts one interval.

**Where the files are written.** `writeClip` writes `<camera>.<segment>.mp4` and
`<camera>.<segment>.frames.json` (compact JSON) into `sessions/<sessionId>/attempts/<index>/` of the
origin private file system, which the worker opens itself (`navigator.storage.getDirectory()`). The
session's folder must exist (`createSession` makes it); the attempt's folder is made. Each file is
written whole under a temporary name, `<name>.<8 base-36 digits>.tmp`, through a
`FileSystemSyncAccessHandle` (dedicated workers only; its methods are synchronous since Chrome 108:
the bytes go straight into the file, without the swap file of a writable stream), then moved into
place with `move()` (Chrome 111), the frames file first, as the session store writes its records
(T1.11), so that no clip file is ever half written and an MP4 always has its frames file. The next
write or deletion of the same clip removes the temporary files that a write cut short left. Where a
file has no access handle (the window, Node's fake without `syncAccessHandle`), a writable stream
writes it; where handles have no `move()`, the files are written in place, as the store does then.
`deleteClip` removes a clip's files and their temporary files. The worker saves one clip at a time,
in the order asked, from a cut taken when asked (sharing the buffer's bytes, `cut(…, {copy:
false})`), and its `stop` waits for the clips queued; the window's `stop()` waits for the clips
being saved before it asks the worker to stop.

**The worker imports nothing of `@cubetrace/storage` but types.** The first build of T2.3 imported
the folder names and the temporary names from `@cubetrace/storage`, whose index also brings
`@cubetrace/core` and, through it, cubing.js; the worker's bundler then emitted 26 chunks more into
the build (among them a second copy of cubing.js's 670 kB search), none of which the worker loads,
all of which `ngsw.json` lists for the service worker to prefetch. `clip-files.ts` therefore repeats
the three names the clips need (`sessions`, `attempts`, the zero-padded index) and the temporary
names, and `clip-files.test.ts` checks them against the session store's. Only types come from core
and storage, which the compiler erases. `attemptPath` and `clipFiles` are exported for the window
(the lab reads its clip back with them).

**Sizes** (`ng build`, 2026-09-27, against `main` at 0ebb491 built the same way): the worker,
`worker-<hash>.js`, is 136.4 kB raw, 33.4 kB transferred (11.5 and 4.4 kB before): mediabunny's
`Output`, its ISOBMFF muxer with the boxes of every codec it knows, the packet sources and the clip
writer; none of its demuxers, encoders or other formats. The initial bundle's `main-*.js` grew by 9
bytes (260,686 to 260,695): one more name in its export list, Angular's URL sanitizer, which the
lab's `<video [src]>` now imports from it; no code moved into it. The lab's chunk grew from 11.5 to
15.9 kB, the package's window chunk, which the camera panel shares, from 11.7 to 12.7 kB
(`saveClip`, `attemptPath`, `clipFiles`); every other chunk is the same but for a byte or two of
chunk names.

**The recorded sample.** `fixtures/media/fake-camera-vp9-1s.json` is one GOP (30 frames, 1 s) of
Chrome's fake camera at 1080p30 with its Opus audio, a `Cut` with the bytes in base64 (236 kB),
recorded through `/capture-lab` by `apps/web/scripts/record-media-fixture.mts`
(`fixtures/media/README.md`); `test-media.ts` reads it for the tests of the muxer, the clip writer
and the worker. Since CI's Chromium encodes neither H.264 nor AAC, a test describes the sample's
chunks as H.264 High 4.0 (an avcC) and AAC-LC: the MP4 then has an `avc1` track carrying that avcC
and an `mp4a` track, which mediabunny reads back as `avc1.640028` and `mp4a.40.2`; the pictures
themselves come only from real devices. The end-to-end test (`capture.spec.ts`) saves the last 3 s
through the lab's "Mux and save" on the fake camera, reads both files back from the origin private
file system, plays the MP4 in a `<video>` to its end and demuxes it with mediabunny in Node; in two
runs: 98 and 99 frames (3.3 s from the keyframe before the start), 557 and 559 kB, cut, muxed and
written in 42 and 48 ms, the element's duration within 0.1 ms of the frames' and as many frames
played as frames.json has. The production build's worker saves a clip under `/cubetrace/` too.

**Saving takes the worker from its frames for a moment.** Muxing is synchronous work in the capture
worker, and so are the access handles' writes: while they run, the camera's frames wait in
`MediaStreamTrackProcessor`, which drops the oldest beyond its `maxBufferSize` (the pipeline leaves
Chrome's default). In a throwaway run on the fake camera (not committed), saving 30 s (926 frames,
5.2 MB) took 90 ms (37 ms muxing, 55 ms writing, timed in the worker) and 60 s (10 MB) 130 ms, and
the frames right after each save had one and two double intervals (a frame lost; frames.json shows
it, as a double `dtMs`), while the counters' frames per second dipped to 29 and 27.7 in that second.
T2.4 saves a solve's clip a second after it ends; if a lost frame in the next attempt's scramble
matters, a larger `maxBufferSize` for the processor (`pipeline.ts`) or muxing in a second worker
would avoid it (not done here).

## Recording in the timer (T2.4)

Added by T2.4 on 2026-09-27: `RecordingService` (`apps/web/src/app/camera/recording-service.ts`)
records the clips of every attempt, and `packages/capture` saves them in a second worker.

**Two workers.** The capture worker only cuts now. `saveClip` still asks it (`mux-and-write`); it
cuts the interval with copies of the chunks' bytes (`cut(…, {copy: true})`, a memory copy) and moves
the cut, with the request, through a `MessageChannel` to the clip worker (`clip-worker.ts`), which
muxes it with mediabunny, writes it with the clip writer and answers the window. `startCapture`
starts both workers and gives each an end of the channel (`start.clips`, `connect`), so the bytes
never pass through the window; `stop()` terminates both once the clips being saved are answered.
The clip worker is a chunk of its own, started by the same `new Worker(new URL('./clip-worker.ts',
import.meta.url))` form as the capture worker, and mediabunny, the muxer and the clip writer moved
into it. It also removes, when the window asks (`CaptureHandle.deleteClip`), a clip saved for an
attempt that went meanwhile, but only while the clip's frames file still names the first frame asked
for (`deleteClipIf`), so that a newer clip of the same name, the next attempt with that index, stays.
Measured with the capture lab on the fake camera (throwaway runs, not committed), a save no longer
costs a frame: 30 s (921 frames, 5.1 MB) saved in 125 ms from the request and 60 s (1,818 frames,
10.2 MB) in 198 ms, with no double interval in the frames of the second after either, the frame rate
at 30 throughout and none dropped; T2.3's single worker lost one and two frames on the same saves
(above). `recording.spec.ts` checks a 10 s save the same way at every run.

**The processors' buffers.** `MediaStreamTrackProcessor` keeps the frames a late reader has not
taken, up to its `maxBufferSize`, and then drops the oldest. The pipeline now asks for 10 video frames
(a third of a second at 30 fps) and 50 audio buffers (half a second of the microphone's 10 ms
buffers), for a garbage collection or a busy moment in the capture worker. Frames wait there only
while the worker is behind, so the steady state holds none. On the real cameras, whose frames come
from a pool of capture buffers, the owner's round checks that recording for twenty minutes drops no
frame (`docs/MANUAL-TESTS.md`, T2.4).

**When it records.** While the camera is on and a session is under way, or a cube is connected (the
first attempt of a new session begins with the connection, and its scramble clip needs the two
seconds before it in memory), and the storage is under 95% of the quota. A new stream (another
camera, another resolution) or a new "Record audio" or "Video quality" starts it again; the camera
off, no session and no cube, or storage from 95% stop it. The microphone comes from its own
`getUserMedia`, raw since T2.12 ("Microphone (T2.12)", below); a refusal records the video alone and
says so. `SessionService` emits
`milestones$` (an attempt `armed`, `ended` with its record and its end, or `dropped` without a
record); the service saves the scramble clip `[max(scrambleStart − 2 s, scrambleDone − 60 s),
scrambleDone + 1 s]` (T2.9) and the solve clip `[solveStart − 3 s, end + 1 s]` a second and a
quarter after their end, the quarter second for the last frames to come out of the encoder (tens of
milliseconds, more on a busy machine), so that the cut is whole. `SessionService.attachClip` keeps a
clip for the record of an attempt under way, or saves the record again with the clip (its timing
untouched); a clip of an attempt that went is removed. The unit tests (`recording-service.spec.ts`)
drive a real `SessionService` with the fake cube on a fake clock (`session-harness.ts`) and a fake
pipeline (`recording-testing.ts`).

**Timing with the camera on.** One replay of a demo solve at speed 20 varies by a few milliseconds
either way, from the fake cube's timers: its time is when the last move's timer fired minus when the
first one's did, and the page's own work can hold either back. With the camera on, the preview's
sharpness meter (T2.1) is the page's longest task: in headless Chromium, whose canvas is software,
its measurement took up to 30 ms (a long-animation-frame entry of the `requestVideoFrameCallback`),
which delayed the moves around it by up to 29 ms in a throwaway run; the recording itself (the
pipeline, the clips' messages) showed no long task. Single replays with the camera on were 1,066 to
1,131 ms against 1,067 to 1,071 with it off (the fixture's 1,074.9 ms at speed 20), so the e2e
compares the medians of four replays each: they differed by 0.1 to 1.9 ms over six runs. On real
devices the canvas is the GPU's and the measurement is shorter; measuring the sharpness less often,
or not while solving, would take it out of the solve's timing.

**Sizes** (`ng build`, 2026-09-27, against `main` at d483f06): the initial bundle is 264.26 kB raw,
72.41 kB transferred (263.80 and 72.35): `main` grew by 465 bytes, Angular's instructions for the
new lazy components (one more export) and no app file. The capture worker is 12.1 kB raw, 4.2 kB
transferred (136.4 and 33.4 before, with mediabunny); the clip worker, new, 126.5 kB (30.4 kB). The
Camera section's chunk, which the Timer page loads right after it renders and which holds
`RecordingService` (9.1 kB) and the recording panel (5.7 kB), is 42.2 kB (11.8 kB), against 29.7
(8.8); the Timer page's 34.1 kB (9.3 kB), against 32.6 (8.9); the clip viewer, a chunk of its own
that loads when a badge is clicked, 10.0 kB (3.4 kB); the Sessions page 8.1 kB (2.5 kB), against 7.6
(2.4); the storage meter, shared by the Camera section and the Sessions page, 2.3 kB (1.0 kB); the
chunk of `SessionService` and the store 23.1 kB (6.7 kB), against 20.3.

## Timer layout (T2.7)

Added by T2.7 on 2026-09-27.

**The preview and Camera settings.** The camera's picture beside the time is `CameraPreview`
(`camera/camera-preview.ts`), a chunk of its own that the Timer page loads right after it renders,
like Camera settings (`CameraPanel`); the two share `CameraService` and `RecordingService`. The
preview measures the frames (`watchPreview`); the larger picture of Camera settings, there only while
the framing is edited (Framing → Edit), is a second `<video>` of the same stream that measures
nothing, so that a second picture costs nothing the rest of the time. The preview is a box of 16:9,
15rem (240 px) high once its row is 46rem wide, else the width of the page (a phone); the frames keep
their proportions inside it through container query units (the box has `container-type: size`, the
frame is `min(100cqw, 100cqh × aspect)` wide), so the framing rectangle is still drawn in percent of
the frames. The Timer page's `main` is 80rem wide at most (72rem, `--page-max`, elsewhere), by
`main:has(> app-timer-page)` in the shell's styles, so that the time keeps about 400 px beside the
preview at 1280 px. Whether Camera settings are open is a setting (`cameraSettingsOpen`: null until
they are first opened or closed; the first time the camera is on they open by themselves).

**The sharpness meter's cost.** Measured on 2026-09-27 in headless Chromium (software canvas) on the
fake camera at 1080p30, over three runs of 15 s: drawing a frame's rectangle and reading it back took
11.3 to 12.2 ms at 160 pixels wide (the runs' medians of each frame's first draw; 25 ms at most)
against 12.3 to 16.3 ms at 320 (23 at most): reading the frame back dominates, not the size of the
picture.
What takes the meter out of the solve's timing is when it measures: at most twice a second
(`SharpnessSchedule`, on the camera's clock; it was three times a second at 30 fps and six at 60),
and never while an attempt is armed or solving, which the Camera preview tells `watchPreview`: the
first move of the solve starts its time and the last one ends it. With the camera on and recording,
over eight replays at speed 20 no long animation frame (over 50 ms) fell while an attempt was armed
or solving (one did, 52 ms, on `main` at 220cc02); in the recording e2e the medians of four replays
with and without the camera differed by −0.3 to 3.1 ms over four runs, single replays with the camera
on taking 1,059.8 to 1,124.7 ms against 1,070.0 to 1,070.3 off: what spread remains is not the
meter's.

At 160 pixels wide the fake camera measures (four runs of 12 to 15 s) 78–198 on the whole frame,
88–279 on a centred half and 48–183 on a centred 1080×1080 square, and 2.5–17 blurred by 1 pixel (a
canvas `blur(1px)`, about 12 pixels at 1080p), so the default threshold stays 20. A smaller blur tells
less at this width: blurred by 1 pixel at 320 wide (about 6 at 1080p), then averaged 2 by 2 down to
160 (a canvas ignores a blur under a pixel), the same frames measure 19–57 on the whole frame, 19–81 on
the half and 9–44 on the square, often above 20 yet under the sharp frames of the same rectangle (at
320 wide they measured 1.2–8.8). The owner's round sets the threshold per camera, with the cube in its
rectangle.

**The phone.** For the scramble, the time and the preview to fit a phone's screen together: the
scramble's picture floats beside the heading and the first lines of the moves (7rem wide, 12rem from
a 32rem-wide scramble), whose lines are closer (1.45) where the scramble is narrow; the result and the
attempt's number share a line under the time; the time's buttons are smaller where it is narrower
than 24rem; the sections are 12 px apart and inside under 60rem (16 from there); and the Timer page's
`h1` is visually hidden, the navigation saying where the page is. Measured with the demo cube and the
fake camera, without the banner about Web Bluetooth (which Chrome on the phone does not show): at
390×844 the preview's picture ends at 764 px and its line at 787; at 412×818 (the ThinkPhone in
Chrome with its address bar) at 784 and 808; at 360×780 the picture ends at 739 and its line, on two
lines there, at 782. At 1280×800 the preview ends at 507 (530 with its line) and the time's section
at 545. Headless Chromium's banner about Web Bluetooth adds 44 px at 1280 and 85 px at 390, where the
e2e dismisses it.

**E2E.** `apps/web/e2e/timer-layout.spec.ts` checks the layout with bounding boxes, at 1280×800 after
15 replays of the demo at speed 20 (about 37 s) and at 390×844 (the banner dismissed) and 320 px wide.
Recording is off in that file (an init script deletes `MediaStreamTrackProcessor`, so the app says it
cannot record): it then encodes no video beside `recording.spec.ts` and `capture.spec.ts`, which count
the frames lost and run in the other worker.

**Sizes** (`ng build`, 2026-09-27, against `main` at 220cc02): the initial bundle is 264.46 kB raw,
72.51 kB transferred (264.26 and 72.48): `main` grew by 203 bytes, the route of the session's page and
the shell's rule for the Timer page's width. The Timer page's chunk is 28.2 kB raw, 8.7 kB gzipped
(34.1 and 10.4): the solve list is now in a chunk it shares with the session's page, 9.1 kB (3.5 kB).
The camera's code that the Timer page loads right after it renders is Camera settings, 25.2 kB (7.9
kB), the preview, 6.1 kB (2.4 kB), and `CameraService` with `RecordingService`, which they share, 21.0
kB (6.9 kB), against one chunk of 42.2 kB (13.2 kB). The session's page, new, is 9.1 kB (3.3 kB); the
Sessions page 8.3 kB (2.8 kB), against 8.1 (2.8).

## Phone layout (T2.13)

Added by T2.13 on 2026-10-01.

**The choice.** `timerLayout()` (`apps/web/src/app/timer/timer-layout.ts`) gives the Timer page's
layout from three things: whether the window is 60rem wide or more (`matchMedia('(min-width:
60rem)')`, `$two-columns` of `styles/_layout.scss`, read through `BROWSER_GLOBALS` and followed on
`change`), the camera setting (`cameraOn`, which `CameraService` follows as soon as its code has
loaded, so that the layout waits for no camera code) and Scramble over the picture: `columns` (a
wide window), `stacked` (T2.7's column), `pinned` (the scramble's card pinned) or `overlay` (the
picture and the scramble over it, pinned). The page's elements follow it, since one
`<app-camera-preview>` cannot be both beside the time and in the pinned part: in `overlay` the
preview is rendered in the pinned part (`.stage`, after the scramble's section) with its `overlay`
input, and the Timer page renders the sync check under the time; otherwise both are where T2.7 has
them. A change of layout makes a new preview (a new `<video>` on the same stream: the camera, the
recording and the sync check live in root services), never a new scramble view, whose `overPicture`
input changes.

**Pinning.** `position: sticky; top: 0` on `.stage`, a grid item of the page's one-column grid:
Chromium keeps a sticky grid item within its grid container, not within its grid area (checked on
Chromium 141 with a sticky first row, which stays at the top while the grid scrolls by). The stage
has the page's background and bleeds over the gutters (`margin-inline: -1rem`), so that nothing
shows through beside it; with the camera off, bands of background above the card (16 px, against a
margin as negative, so that the card does not move until it is pinned) and under it (8 px).
`z-index: 2` puts it over the rest of the page; the two dialogs are modal, in the top layer. The
header scrolls away as before.

**The picture.** In the pinned part the preview's box takes the frames' proportions (`aspect-ratio:
var(--aspect)`, 16:9 until a frame is measured) up to `max-height: 42svh` (the small viewport:
Chrome's address bar shown), and the frames fit inside it as T2.7 has them, so upright frames come
between bars. Measured on the production build with Chrome's test camera, the banner about Web
Bluetooth dismissed: at 390×844 the picture is 390×219, the strip 119 px high (the heading and three
lines of moves) and the time's section runs from 368 to 608; scrolled to the solves, the picture is
at 0 and the time's section at −86; at 320×640 the picture is 180 px high; at 412×818 (the
ThinkPhone in Chrome with its address bar) with upright 1080×1920 frames (the test camera turned a
quarter turn in a canvas) the picture is 412×344 with the frames 193 px wide between bars, the strip
122 px, and the time's section runs from 493 to 737. The page's boxes at 1280×800 (camera on and
off) and at 390×844 with the setting off, or with the camera off before scrolling, are those of
`main` to the pixel.

**The strip.** Black at 60% (the task asked about 55%): over a mid-grey picture the moves (white)
have a contrast of 12.6:1, the heading (white at 80%) 8.7:1 and a move made (`--ok`, #3fb950) 5.0:1;
over a white picture the moves still have 5.7:1. At 55% a move made had 4.5:1 over the grey and the
moves 4.8:1 over white. A move where the cube left the scramble (`--danger`) has 3.8:1 over the
grey, with its red outline; the text has a dark shadow. The undo guidance is tinted (`--warn` at
30%) rather than the opaque box it has elsewhere, so that the picture shows through it; while it
shows, at 390 px with 16:9 frames, the strip is as tall as the picture and covers the status line.

**Sizes** (`ng build`, 2026-10-01, against `main` at b0c908a): the initial bundle is 264.47 kB raw
against 264.46 (the chunks' names in `main`). The Timer page's chunk is 31.2 kB raw against 28.3
(the layout, the second places of the preview and of the sync check, the styles); the sync check's
panel and `SyncService` left the preview's chunk for one that it shares with the Timer page, 14.5 kB
raw (the preview's is 6.9 kB, against 20.3 with them); the Settings page's chunk is 17.0 kB (16.4)
and `SettingsService`'s 46.8 kB (46.6).

**E2E.** `timer-layout.spec.ts` checks the phone's layout with bounding boxes at 390×844 after a
load with the camera on, then scrolled until the breakdown and the solves come under the pinned
part, and at 320×640; the strip's legibility from its computed colours composited over a mid-grey
picture (WCAG 2's contrast); the camera off (with the Cube section open, so that a session of one
solve is long enough to scroll the time away); and T2.7's phone test with the setting off. The suite
has 62 tests and took 3.3 min locally (3 min 20 s with the servers) on 2026-10-01.

## The sync check (T2.5, T2.8, T2.11)

Added by T2.5 on 2026-09-27: the motion of the frames in the capture worker
(`packages/capture/src/motion.ts`), the clapperboard (`clapperboard.ts`), and the check in the app
(`apps/web/src/app/camera/sync-run.ts`, `sync-service.ts`, `sync-check.ts`, and a section of the
capture lab). Remade by T2.8 the same day, after the owner's first checks on the MacBook's FaceTime
camera matched none of their turns ("fewer than 4 matches (0 of 8 single turns matched a motion)",
the framing rectangle most likely the whole 1080p frame): the changed area, the detection locked to
each turn, the framing hint, the check that runs until its ten turns are made and the timer's wait
after it, and the diagnostics (`sync-report.ts`). Remade again by T2.11 after the owner's first checks
of round 2 on the same camera (issue #38), which matched every turn but spread their lags over 341 and
343 ms: a turn's time in the frames is the middle of its motion rather than its first rise, the spread
leaves out the fifth of the lags farthest from their median, and the check asks to hold still for its
first second.

**The motion is read with `VideoFrame.copyTo`, not drawn into a canvas.** Measured on 2026-09-27 in
Playwright's Chromium 141 with the fake camera (1080p30 I420 frames), 150 frames each way in a
throwaway page and worker: drawing the framing rectangle of a frame into a 160-pixel-wide
`OffscreenCanvas` and reading it back took 10 to 20 ms a frame (12 ms at the median), with
`willReadFrequently` or without, and through `createImageBitmap` with a resize alike (the canvas is
software there); copying the rectangle's planes out with `copyTo({rect})` took 0.4 to 0.7 ms at the
median (Chrome copies a frame that is in memory within the call; the promise resolves at once), and
averaging 2 × 2 points for each pixel of the 160-pixel plane 0.3 to 0.5 ms more. So the worker
copies the rectangle, on even pixels as 4:2:0 planes need, and reads its first plane: the luma of
I420, NV12 and the other 8-bit YUV formats, or RGBA and BGRA pixels weighed into luma. Frames it
cannot copy (no pixel format, or a frame marked to be shown turned or mirrored, which newer browsers
do instead of turning its pixels) are drawn into an `OffscreenCanvas` by the sharpness meter's
`LumaSampler`, as wide as the plane. The worker measures a frame after handing it to the encoder,
and only while a check runs; the e2e runs measured 1.1 to 1.2 ms a frame at the median and 1.5 to
4.9 ms at the 95th percentile while the same worker encoded 1080p30 VP9 (`docs/DEVICES.md`, "Camera
lag"). The unit tests hold the median under 2 ms on synthetic 1080p frames (about 0.6 to 0.9 ms in
Node).

**Two measures since T2.8, on a finer plane for the whole frame.** Each frame gives the mean
absolute difference of its plane from the previous frame's (T2.5's measure, kept for the
diagnostics) and its **changed area**: the share of the plane's pixels whose luma moved by more than
12 levels. A face turning with a finger on it changes a compact part of the picture by far more than
12 levels, while a camera's noise (a few levels a pixel, halved by the 2 × 2 points) and a flicker
of the light (every pixel a few levels) change almost none; on the whole 1080p frame a turn changes
about 1% of the picture, which moves the mean by a fraction of a level against the noise's one or
two. The plane is 320 pixels wide when the region is wide (the whole frame, or more than 60% of it:
`isWideFraming` in `framing.ts`, which the app's framing hint shares), where the cube is small, and
160 for a tighter one. With the whole frame on 320 × 180, averaging the 2 × 2 points in the general
loop took 0.7 ms in Node; an unrolled loop for 2 × 2 luma points takes 0.19 ms (0.05 at 160), so
that the copy dominates: the lab's e2e check measured 1.0 ms a frame at the median and 1.6 ms at the
95th percentile (4 at most) while the same worker encoded 1080p30 VP9, against 2.1 and 4.5 ms before
the loop was unrolled. The worker sends, with the first frame measured and whenever it changes, how
it reads the frames (`sync-meter`: the pixel format, copied or drawn, the frame's size, the region,
the plane), for the diagnostics and the capture lab.

**The frames' times** are those of the clips (`docs/DATA-MODEL.md` §9): each sample carries the
frame's timestamp and its arrival in the worker, and the check places its frames at their timestamp
plus the median arrival offset, so the onsets have none of the arrival's jitter. A move's time is
its `hostMs`, the arrival of its Bluetooth packet, as `docs/DATA-MODEL.md` §6 defines the offset.
Since T2.8 the page also stamps each sample with its own clock when the sample reaches it, and the
check compares: the median of the frames' host times minus those stamps is a few ms below 0 (−1.6 to
−3.4 ms in the e2e runs), the delivery from the worker. Beyond 1 s either way the frames' clock is
not the page's (a worker's `performance.timeOrigin` can differ from the page's, for one, if the page
was opened before the machine slept and the worker after), no turn's motion can be where the check
looks for it, and the check fails with "frame times are off by X s: the frame clock is wrong". The
tolerance is 1 s rather than the 5 s first thought of: the detection's window reaches 0.7 s after a
turn, so any error over about a second already defeats it, and a 3 s error must say so.

**The clapperboard** of T2.5 looked for onsets anywhere in the check (the first frame above 4 times
the still picture's median energy after 500 ms under it) and matched each to the nearest turn within
500 ms. On a real camera watching the whole frame, with a person in it moving a little all the time,
there was neither a quiet half second nor a jump to 4 times the baseline, and it matched nothing.
**Since T2.8 the detection is locked to the turns.** For each single turn at `t` (no other move
within 500 ms either way, as the check asks for: the demo cube's scramble and solve, and a solver's,
come so close together that any motion is near one of them, and would give a lag and a narrow spread
out of nothing), the baseline is the median and the median absolute deviation (MAD) of the changed
area from `t − 900` to `t − 300` ms (at least 5 frames); the turn's motion must rise in its window,
from `t − 400` to `t + 700` ms, above `baseline + max(3 × MAD, 0.1%)` from a frame that did not (a
rise, not a window that begins in motion: the first such frame is the onset), and the window's peak
must exceed `baseline + max(6 × MAD, 0.2%)`. T2.8 took the onset for the turn's time.

**Since T2.11 a turn's time is the middle of its motion.** The owner's first checks of round 2
(`fixtures/sync/`: the MacBook's FaceTime camera at 1080p30, the GAN 356 i3 held in the air close to
the camera, both hands on it, the top face turned with the fingers, the rectangle around the cube and
the hands) matched every turn, but the onsets came from 381 ms before the move to 8 ms after it: they
caught the hand getting ready, the fingers placed and the cube shifted a varying time before the turn,
in a picture where 4.6 to 4.8% of the rectangle changed from frame to frame at rest and each turn
16 to 31%; the peak of each turn's motion came from 90 ms before its move to 130 ms after. The cube
reports a turn in the middle of the face's motion, so the event is the middle of the turn's motion:
the centroid of `max(0, changed − baseline)²` over the frames within 150 ms of its peak, at the
frames' own times (nothing is interpolated, and the centroid falls between frames), squared so that
the frames of the peak weigh most and the tails, near the baseline, little. The peak is the window's
highest frame, or an earlier peak (a frame that no frame within 150 ms rises above) whose rise above
the baseline is at least 0.8 of the highest's (`EARLIER_PEAK_SHARE`): what follows a turn in its
window (the hand letting go, a fidget) can move the picture as much as the turn, as the synthetic
scene's fidgets do and as a later motion did in two of the owner's turns (0.95 and 0.98 of the
turn's), while the hand getting ready before a turn moved it at most 0.68 as much. A motion goes to
one turn only: when two turns' peaks are within 150 ms of each other (the same frame, or the same
motion seen through the edges of two windows, which overlap for turns 0.5 to 1.1 s apart), the turn
whose move is nearer its peak keeps it, and the other takes the peak of its window more than 150 ms
from it, or none. The onset stays in each turn's analysis, for the diagnostics. The offset is the
median lag of the turns kept and the residual the range of their lags: of the matched turns, the
fifth whose lags are farthest from the median of all, rounded up, are left out (1 of 4 or 5, 2 of 6
to 10, 3 of 11 to 15; of two as far, the later turn's), since the range hangs on the two most extreme
turns and the median does not; fewer than 4 matches fail, as in T2.5.

**The spread a check allows follows the frame rate** (T2.8): 50 ms plus the median interval of the
check's frames (83 ms at 30 fps, 67 at 60, 58 at 120; never under T2.5's 40 ms, which is also the
limit without an interval), since the frames see each turn's motion a frame at a time, an error of up
to about one interval, on top of the Bluetooth jitter of the cube's reports (a 95th percentile of 13
to 23 ms on both cubes, `docs/DEVICES.md`): T2.5's fixed 40 ms would fail correct checks at 30 fps.
The analysis keeps the interval and the limit, and a failure says both and the turns kept ("spread
over 83 ms at 30 fps (91.2 ms over the 8 turns kept of 10)"); `clapperboardResidualMs` stays the
spread itself, the honest number (the offset, a median of n lags, is known to about the spread over
√n). Each turn's analysis says why it is unmatched (no frames, no baseline, no rise, the picture
already changing, or its motion nearer another turn), and the failure's message counts those.

**The numbers.** The owner's two checks, replayed from their data files by
`clapperboard-hardware.test.ts`: T2.8's estimator (a copy of it in the test, which gives the day's
lags turn by turn) fails both, with lags of −85.8 and −269 ms spread over 341.4 and 343.5 ms (10 and 9
turns matched; the second check's first turn came 0.14 s after its first frame, without a baseline);
T2.11's passes both: a lag of 38.3 ms with a spread of 51.2 ms over the 8 turns kept of 10 (lags 21,
38, 24, 1, 38, 72, 35, 44, 51 and 75 ms; 1 and 75 left out) and 18.7 ms with 70.9 ms over 7 of 9 (12,
19, −5, 78, 52, 66, 45, −75 and 18 ms; 78 and −75 left out), 20 ms apart. On a synthetic film of a
check (`clapperboard-scene.test.ts`: 640 × 360 frames of a room and a person swaying and breathing,
with the sensor's noise, a flickering light and three fidgets, ten turns each a compact change of
about 0.7% of the picture from the first frame 60 ms or more after the move) T2.5's detector matched
none of the ten turns, and T2.8's all ten, with a lag of 73.5 ms and a spread of 26.9 ms; T2.11's
matches all ten with a lag of 127.2 ms (the middle of each turn's motion, drawn over four frames, is
about 50 ms after its first) and a spread of 20.1 ms. Three of the fidgets change as much of the
picture as a turn within half a second after one: the window's highest frame alone would have taken
them for those turns, and failed the film with a spread of 368.2 ms. The 0.1% floor keeps a still
picture (a MAD of 0) from taking a few changed pixels for a turn; on the fake camera the changed
area's median is 0.7% and its peaks 11% (its test pattern moves), which the MAD absorbs.

**The check in the Timer** is due by itself when a session is under way with the camera recording, a
cube connected and no check of that camera in the session's `clock.cameras`, once per session and
camera, and only where an attempt starts: before the scramble's first turn, or between attempts (not
once a scramble has begun, nor while a solve is about to start, is under way or is paused); "Sync
check" makes it due again under the same conditions, and "Later" ends it and hides it; where it
cannot start, the reason is written beside its button, and a start refused says why. Since T2.8,
while the framing rectangle is wide (the whole frame, the default, or more than 60% of it) a check
that is due asks first for a rectangle around the cube ("Edit the framing" opens Camera settings to
the editor, through `CameraService.framingEditing`), then starts with Start, or at once with "Start
anyway", which the session remembers for the camera. It asks to hold the cube still inside the
rectangle and flick one face with one finger, the other hand and the cube still, and to flick it back
after a second, five times over: ten single turns that leave the cube as it was. Since T2.11 it says
"Hold still…" for its first second and counts no turn made then, which would have no baseline (the
owner's second check of issue #38 lost its first turn so). It waits 20 s from its start for the
first turn (and fails, "the cube did not move", without one); from the first turn on it never gives
up in the middle of what it asked for, counting "Turn 3 of 10", and ends once ten turns are made and
the cube has been still for a second (the capture lab's check keeps T2.5's end: its time, or sooner
once its ten turns are matched and it passes); the recording stopping or the cube disconnecting end
it as failed. While it runs the timer tracks no attempt (`SessionService.suspendForSyncCheck`, refused
while an attempt is armed or solving): the attempt waiting for its scramble is dropped without a
record, by the path "Mark as solved" takes, the cube's moves go to no attempt (they still feed the
session's coarse cube clock fit), the status line says "Sync check: …" (a timer phase of its own,
`sync-check`). When the check ends the suspension holds (`holdAfterSyncCheck`) until the cube has
been still for 2 s or the result is dismissed (`resumeAfterSyncCheck`), and then no attempt begins
until the cube has been still for a second more: the owner's second GAN 356 i3 export (issue #34)
had a check give up after 8 of its turns and the next two, a turn and its turning back, become the
attempt's scramble moves 0 and 1. The status line says "Sync check over: the attempt begins once the
cube is still" meanwhile; then the attempt begins again with the same scramble and number as soon as
the cube is solved, or "Solve the cube first" says what to do. So no record holds the check's turns,
and no scramble clip either (the restarted attempt's clip begins 2 s before its own first turn). On
success `SessionService` keeps the lag with the matched pairs in `clock.cameras[label]`
(`putCameraClock`), and `attachClip` gives each clip of that camera attached from then on its
`offsetMs` as `syncResidualMs`: clips saved before the check keep null, and one saved within a
second after it, whose frames were before it, gets the lag too. The capture lab's check involves no
session: the lab is a page reached by its address, whose load starts no timer.

**The diagnostics** (T2.8). Every check that ends writes one line to the console, `cubetrace: sync
check passed {…}` or `failed {…}` (the reason and message, the lag and spread, the turns matched out
of the single turns, the moves, the frames, the frames' clock against the page's, the arrival fit,
the camera, its frame size, whether the framing is wide, the pixel format, copied or drawn, the
plane, the time per frame), and "Download check data" (a button after a failure, a small link after
a success, and in the capture lab) saves `cubetrace-sync-check-<local time>.json`: the app's version
and commit and the browser, the camera's label and name and frame size, the framing rectangle, how
the frames were read, the detection's parameters, the result, the frames' clock, every single turn's
window, baseline, MAD, levels, peak and onset or why it has none, the cube's moves with whether each
was single, and the whole series (`{hostMs, mean, changed}` per frame). It is a file for an issue,
not a record of the data model. Since T2.11 it is version 2: each turn's analysis has its event
(`eventHostMs`) beside its onset, and its lag is to the event; the detection says its estimator
(`motion-centre`) and the new parameters (the half window of the event, the share of an earlier
peak, the share of the turns left out); the result says the turns kept and the pairs left out with
their lags; and the console line has the estimator, the count kept and the lags left out. The
capture lab also shows the latest frame's two measures in bars as they come, so that a hand waved in
front of the camera can be seen to register.

**Sizes** (`ng build`, 2026-09-27, against `main` at 01706c2, with T2.7): the initial bundle is
unchanged, 264.46 kB raw. The motion code is in the capture worker only, 18.2 kB raw, 6.2 kB
transferred (12.1 and 4.2 before). The clapperboard and the pipeline's `watchMotion` joined the
window side of `packages/capture`, the chunk the Timer's camera code and the capture lab share, 17.4
kB raw (14.0 before). The sync check's panel and `SyncService` are in the chunk of the camera's
preview, beside the time (T2.7), which the Timer page loads right after it renders: 14.6 kB raw, 4.4
kB transferred (6.1 and 2.1 before); `SyncRun`, which the preview and the capture lab share, is a
chunk of its own, 2.8 kB (1.1 kB gzipped); the capture lab's chunk is 19.2 kB (16.0), the chunk of
`SessionService` 24.1 kB (23.2: the suspension and `putCameraClock`), the Timer page's and Camera
settings' unchanged but for a status line (28.2 and 25.2 kB). With T2.8 (`ng build`, 2026-09-27,
against `main` at 1cbd063) the initial bundle is unchanged, 264.46 kB raw; the capture worker is
19.6 kB raw, 6.7 kB transferred (18.2 and 6.2 with T2.5: the changed area, the unrolled loop, the
meter's description); the camera preview's chunk, with the sync panel, `SyncService` and the report,
20.1 kB, 5.6 kB transferred; the capture lab's 22.8 kB; Camera settings' 25.6 kB. With T2.11 (`ng
build`, 2026-09-28, against `main` at 5ab4270) the initial bundle is unchanged, 264.46 kB raw; the
window side of `packages/capture`, with the clapperboard, is 21.5 kB raw, 7.4 kB transferred (20.2
and 7.0: the peaks, the event and the trimmed spread); `SyncRun`'s chunk 6.2 kB (5.8: the second of
stillness); the camera preview's 20.3 kB (20.1); the capture lab's 23.3 kB (23.1); the Timer page's
28.3 kB (a status line); the capture worker is unchanged, 22.5 kB.

## Video quality (T2.10)

Added by T2.10 on 2026-09-27. The bitrate rule is `packages/capture/src/bitrate.ts`: the capture
worker configures its encoder with it, and the app's texts (`apps/web/src/app/camera/video-quality.ts`)
show it, so that each choice says what the worker will ask for. `SettingsService`, in a chunk every
page loads right after the first render, keeps only the list of qualities and their names, and still
imports no camera code.

**Sizes** (`ng build`, 2026-09-27, against `main` at 1cbd063): the initial bundle is unchanged,
264.46 kB raw. The builder put `bitrate.ts` in the chunk of `@cubetrace/capture`'s window side, 17.6
kB raw against 17.4, so the Settings page, whose own chunk is 16.4 kB raw against 15.1, now loads that
chunk too (6.0 kB transferred), which the Timer page loads right after it renders anyway; the texts
are a chunk of their own, 0.5 kB. Camera settings' chunk is 26.4 kB raw (25.2 before), the capture
worker 18.3 kB (18.2), the capture lab's chunk 19.4 kB (19.2).

## Microphone (T2.12)

Added by T2.12 on 2026-10-01. The recording asks for the microphone with every voice processing off
(`apps/web/src/app/camera/microphone.ts`): `echoCancellation`, `noiseSuppression`, `autoGainControl`
and `voiceIsolation` false, `channelCount: {ideal: 1}` and `sampleRate: {ideal: 48000}`, all of which
a browser may ignore and none of which can fail a request. TypeScript 6.0's DOM lib has no
`voiceIsolation`, neither in `MediaTrackConstraintSet` nor in `MediaTrackSettings`, while Chrome
supports it (`getSupportedConstraints()` says so), hence the typed extensions `MicrophoneConstraints`
and `MicrophoneSettings` there.

**Chrome's fake microphone** (Playwright's Chromium 141 on Linux, `--use-fake-device-for-media-stream`,
measured on 2026-10-01 with a throwaway page and by `apps/web/e2e/microphone.spec.ts`, which prints
it): labelled "Fake Default Audio Input" (two more, "Fake Audio Input 1" and "2", are listed), its
track's `getSettings()` reports every processing as asked. With `{audio: true}`: `echoCancellation`,
`noiseSuppression` and `autoGainControl` true, `voiceIsolation` false, 48,000 Hz, one channel, 16-bit
samples, `latency` 0.01 s. Raw: all four false, and the device's own format, 44,100 Hz in two
channels (`f32-planar` `AudioData` of 441 frames, 10 ms), whatever the ideals ask: one channel asked
for as a bare `channelCount: 1` gives two as well, and only an `exact` sample rate it lacks fails, with
an `OverconstrainedError` on `sampleRate`. Its capabilities: `echoCancellation` `[true, false,
"remote-only"]`, `autoGainControl`, `noiseSuppression` and `voiceIsolation` `[true, false]`, one or
two channels, 44,100 to 48,000 Hz. Chromium's `AudioEncoder` takes Opus at 44.1 kHz stereo (AAC not at
all, as above), so CI's clips keep their Opus sound raw: the capture lab's 3.4 s clip has 165 Opus
packets, and the audio's arrival offset is 0.7 ms from the video's.

**Sizes** (`ng build`, 2026-10-01, against `main` at 8aecd2c): the initial bundle is unchanged,
264.47 kB raw. The chunk with `SettingsService` and the records' readers, which every page loads right
after the first render, is 47.6 kB raw against 46.8 (15.2 kB transferred against 14.9); the recording
service's 22.3 kB against 21.3, Camera settings' 28.4 against 27.4, the Settings page's 18.1 against
17.0, the capture lab's 23.4 against 23.3; `microphone.ts`, which the recording and the capture lab
share, is a chunk of its own, 1.3 kB.

## Account (T3.0)

Added by T3.0 on 2026-10-01: Google sign-in through Firebase Authentication, `users/{uid}` in
Firestore, the Firestore rules and their tests, and the deploy workflow (`docs/ARCHITECTURE.md`,
"Account"; `docs/DATA-MODEL.md` §10).

**Firebase 12.19.0, modular, behind one file.** The latest 12.x on 2026-10-01 and the version the plan
names (13.0 exists only as prereleases). `apps/web/src/app/auth/firebase-sdk.ts` is the only file
that imports it: `initializeApp`, `initializeAuth` (IndexedDB persistence, then `localStorage`; no
popup resolver at start, so that a remembered account starts without Google's iframe: the one call
that opens Google's page passes `browserPopupRedirectResolver`), `GoogleAuthProvider` (with
`prompt: select_account`) and `initializeFirestore` with `persistentLocalCache` and
`persistentMultipleTabManager`, so that writes wait in IndexedDB while offline, across reloads, and
the app's tabs share the cache. It implements `AccountBackend` (`account-backend.ts`), the few calls
the app makes, which the unit tests fake (`fake-account.ts`) and `AuthService` reaches through
`ACCOUNT_LOADER`. The config is `apps/web/src/environments/firebase.ts`, committed: a web app's config
names the project and is public; the rules and the authorized domains protect the data.

**One lazy chunk, named, out of the service worker's prefetch.** `ACCOUNT_LOADER` is a dynamic import
of `firebase-sdk.ts`, so the whole SDK is one chunk. The service worker's `app` group prefetches every
`.js` file, which would have downloaded Firebase into every installation; `namedChunks` (in
`angular.json`) names the lazy chunks after their files (`firebase-sdk-<hash>.js`,
`timer-page-<hash>.js`, …, shared chunks stay `chunk-<hash>.js`), so that `ngsw-config.json` takes
`firebase-sdk-*.js` out of the `app` group and into `account`, a lazy group: cached when the app first
loads it, and updated with each version once cached. Signed in after an update, the first start
offline cannot load the new chunk: the account says it could not be loaded, and comes back at the
next start online (the timer is unaffected). `account.spec.ts` checks it on the production build:
signed out, no request to Google's or Firebase's servers or for the chunk, while the timer solves
and Settings opens; the shell cached, the chunk not.

**The header's controls are one deferred component.** `HeaderControls` holds the cube's pill and the
account's control, so the shell's `@defer` block still imports one chunk. Two smaller choices kept
Angular's runtime in `main` as it was: the empty photo of "Sign in" is drawn in CSS, since an SVG
followed by HTML in a template costs `ɵɵnamespaceHTML` (83 bytes), which no other template needed; and
the photo is a component of its own rather than an `<ng-template>` (`NgTemplateOutlet`, see "Cube
connection").

**Sizes** (`ng build`, 2026-10-01, against `main` at b0c908a): the initial bundle's code is
unchanged, but it is 264.53 kB raw, 72.58 kB transferred (264.46 and 72.56 before): `main` names the
eight lazy chunks it imports (the pages, the header's controls, the connect dialog), and their names
are 63 bytes longer in all with `namedChunks`. Firebase is `firebase-sdk-<hash>.js`, 619.1 kB raw,
156.6 kB transferred. The account's code (`AuthService`, the control, the photo, the error texts) is a
chunk of 13.0 kB raw, 3.9 kB transferred, which the header's controls (`header-controls-<hash>.js`,
2.3 kB, the cube's pill with it; the pill alone was 1.9 kB) and the Settings page share, and which
every start loads right after the first render; the Settings page's own chunk is 17.0 kB (16.4).

**The sign-in flow.** A popup (`signInWithPopup`) everywhere, in the app installed on Android too
(T3.6). Until it, the installed app (display mode `standalone` and the platform Android) signed in
with `signInWithRedirect`, whose outcome the next start read (`getRedirectResult`), the
`localStorage` flag `cubetrace.account` saying `redirect` meanwhile, on the thought that a popup
would leave the app for a Chrome tab; the outcome comes back through Firebase's helper frame on
`cubetrace-cacd9.firebaseapp.com`, which browsers that partition third-party storage (Chrome 115+)
cut off from the app on another site (Firebase's "signInWithRedirect best practices"), and manual
round 3 met exactly that on the ThinkPhone (issue #50: "Signing in did not finish…"). The popup
passes its outcome by messages, not through storage, and Chrome opens it from the installed app as
a Custom Tab over the app that closes itself; of the two flows' functions, `firebase-sdk.ts` now
imports `signInWithPopup` and `browserPopupRedirectResolver` alone, a `redirect` flag left by 0.3.0
is removed at start, and `docs/ARCHITECTURE.md` ("Account") has the reasoning and the plan B. Errors
keep Firebase's codes' meaning in plain sentences (`auth-error.ts`); in the installed app, which
`AuthService` tells `authErrorMessage` through an `AuthErrorContext`, a popup blocked or closed
before Google was done says to sign in once from a Chrome tab at the app's address and to open the
installed app again, since Chrome's installed apps share the site's storage with its tabs.

**The end-to-end suite's fake.** The dev server's app takes a fake backend from
`window.cubetraceE2eAccountLoader` (`apps/web/e2e/helpers/account.ts`, installed with
`page.addInitScript`), read only when `isDevMode()`; production builds ignore it. The fake keeps its
account and what it was asked in `localStorage`, so the suite checks the remembered start, the loads
and `users/{uid}` (against `user.schema.json`) without Google.

**The rules' tests run against the Firestore emulator.** `@firebase/rules-unit-testing` 5.0.2 drives
it from Vitest in Node (`firebase/rules.test.ts`, its own `firebase/vitest.config.ts`, the root
`tsconfig.json` type-checks `firebase/`); `npm run test:rules` starts it with `firebase
emulators:exec` under the project id `demo-cubetrace`, which keeps the emulator offline. The emulator
needs Java 21 or later. 22 tests take about 8 s; the first run downloads firebase-tools (about 25 s)
and the emulator's jar. Each rule's clause was checked to fail its test when removed (the parent
session of an attempt, `createdMs` kept, the record's fields, the owner kept), and every refusal
when everything is allowed.

**The Firebase CLI through npx, pinned.** firebase-tools would add 672 packages and 271 MB to every
`npm ci` (which installs 484 with `firebase`), and 9 `npm audit` findings (4 moderate, 5 high) in its
own tree, for two commands that need Java or a key anyway; `npm run firebase` runs the pinned version
through npx instead, into npm's cache, which `actions/setup-node` keeps in CI.

**`npm audit`.** `firebase` brings `@grpc/grpc-js` 1.9.16 (Firestore's build for Node pins
`~1.9.0`), and its two advisories (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4: what a gRPC server
accepts or sends) make 5 high findings along `@firebase/firestore`, `firebase` and
`@firebase/rules-unit-testing`. The app's chunk has no gRPC (the browser build talks to Firestore over
HTTP), and the rules' tests are a client of the local emulator; an `overrides` past Firebase's range
was not worth it.

**CI and the deploy.** `ci.yml` installs Temurin 21 (`actions/setup-java`), restores
`~/.cache/firebase/emulators` (`actions/cache`, keyed on `package.json`, where the CLI's version is
pinned) and runs `npm run test:rules` after `npm test`. `firebase.yml` deploys the rules
(`firebase deploy --only firestore:rules --project cubetrace-cacd9 --non-interactive`) on pushes to
`main` that change `firebase/**`, `firebase.json`, `.firebaserc` or itself, and by hand: it fails in
its first step while the repository secret `FIREBASE_SERVICE_ACCOUNT` is missing, then writes the key
into the runner's temporary directory for the CLI (`GOOGLE_APPLICATION_CREDENTIALS`) and removes it at
the end (`docs/USER-ACTIONS.md` has the key and its roles).

## Functions (T3.2)

Added by T3.2 on 2026-10-01: `functions/`, the Cloud Functions `signUpload` and `confirmUpload`
(`functions/README.md`, `docs/ARCHITECTURE.md` "Uploads", `docs/DATA-MODEL.md` §10), the bucket's
CORS policies (`bucket/`), and their deploy.

**A workspace that is deployed alone.** `functions/` is an npm workspace (`@cubetrace/functions`), so
`npm ci` installs it, `npm run typecheck` and `npm run lint` cover it and its dependencies are in the
root lockfile. `firebase deploy` builds it (`predeploy` in `firebase.json`), uploads the directory
without `src/` and `node_modules`, and Cloud Build runs `npm install` on `functions/package.json`
alone, without the root lockfile and without the workspace's packages: the functions import none
(`no-restricted-imports` in `eslint.config.js`; `paths` emptied in `functions/tsconfig.json`), and
their direct dependencies are pinned exactly, so that Cloud Build installs the versions tested (their
own dependencies follow their ranges). `gcp-build` is empty: Cloud Run functions would otherwise run
`npm run build`, whose `tsc` is the root's and is not there; `lib/` is uploaded built.

**ES modules, compiled by `tsc`.** `"type": "module"`, `module` and `moduleResolution` `nodenext`
(relative imports end in `.js`), `lib` ES2023 without the DOM, Node's types; `tsconfig.json`
type-checks everything (the tests too) and `tsconfig.build.json` emits `src/` minus the tests into
`lib/` with source maps. firebase-functions 7 has ES module builds of every entry point, and its
loader (the CLI's way to find the functions) loads ES modules. The functions import its entry points
one by one (`/https`, `/params`, `/logger`, `/options`), not the root, which loads every provider, and
load the bucket's adapter of the configuration (`gcs.ts` or `r2.ts`, behind `ObjectStore` in
`object-store.ts`) with its SDK on an instance's first call: with GCS a cold start never loads the
AWS SDK (loading `lib/index.js` took 0.56 s and 110 MB, and 0.8 s and 134 MB with both SDKs imported
up front).

**Parameters in a committed `.env`.** A non-interactive deploy (the workflow's, and the coordinator's)
refuses to go on without a value in a dotenv file for every parameter, its default notwithstanding
(firebase-tools 15.32.1, `resolveParams`), so `functions/.env` holds them all; none is a secret, and
`.gitignore` lets that one file through. The CLI loads the code to find the functions with those values
in its environment and nothing else of the shell's; the R2 secrets are declared only when
`BUCKET_PROVIDER` is `r2` there, because any declared secret must exist in Secret Manager for a deploy
to go through, bound or not. `functions/src/deploy.test.ts` runs that loader on the build for each
provider. The emulator also reads `functions/.env.local` and `functions/.secret.local` (gitignored).

**Signing.** GCS: `File.getSignedUrl` (V4, `write`) with `accessibleAt`, `expires` (whole seconds, so
the URL says 900), `contentType` and the extension header `x-goog-content-length-range: n,n`; on
Cloud Functions the library signs through the IAM Credentials API's `signBlob` as the function's
service account, with no key file. R2: an `S3Client` for `https://<account>.r2.cloudflarestorage.com`,
region `auto`, path-style, and `requestChecksumCalculation`/`responseChecksumValidation` set to
`WHEN_REQUIRED`: since 3.729 the SDK otherwise signs a CRC32 of the empty body into every presigned
`PUT`, which the real upload then fails; `getSignedUrl` signs `content-type` and `content-length`
(`signableHeaders`). `functions/src/object-store.test.ts` checks both with made-up keys by rebuilding
the canonical request from the URL and the headers returned and verifying the signature (RSA-SHA256
for GCS with the key pair's public half, HMAC-SHA256 for R2), and reads sizes from a local server that
answers as each provider's API does (GCS's client skips authentication for a custom endpoint).

**Tests.** `npm run test:functions` builds, then runs Vitest (`functions/vitest.config.ts`) inside
`firebase emulators:exec --only firestore --project demo-cubetrace`: 94 tests in about 13 s, one file
at a time since they share the emulator's database; the handlers run with the Admin SDK against it
(data cleared before each test through the emulator's REST endpoint) and a fake bucket.
`METADATA_SERVER_DETECTION=none` keeps Google's auth library from looking for a Compute Engine
metadata server, which it otherwise does against the emulator too. Checked by hand on 2026-10-01 in
the Functions emulator (`emulators:exec --only functions,firestore`): with R2 and made-up keys in
`.env.local` and `.secret.local`, the CLI loaded both functions from `lib/` with the parameters and the
secrets, a call signed out came back 401, one without the session 404, and one with it 200 with two
presigned URLs, the quota and the intent written; with GCS and no Google credentials, signing failed
as `internal`, the cause (`Request failed with status code 403`, the metadata server's) in the log.

**Deploys.** `.github/workflows/firebase.yml` runs `npm ci` (the CLI builds the functions and loads
them) and `firebase deploy --only firestore:rules,functions --non-interactive`. Such a deploy fails
after deploying when the Artifact Registry repository of the functions' images has no cleanup policy:
the first one is run with `--force`, which sets a one-day policy (`functions/README.md`).

**`npm audit`.** The functions add two moderate findings, one chain: `uuid` 9.0.1 under `gaxios`
6.7.1 (`@google-cloud/storage`'s), GHSA-w5hq-g745-h8pq, a missing bounds check when `v3`, `v5` or
`v6` is given a buffer to write into; gaxios calls `v4()` for multipart boundaries only. The 5 high
findings of T3.0 are unchanged (the functions' Firestore has `@grpc/grpc-js` 1.14.5, past them).

## Session index (T3.1)

Added by T3.1 on 2026-10-01: the session index in Firestore, the Sessions page merging the device's
sessions with the cloud's, and the QA view (`docs/ARCHITECTURE.md`, "Session index";
`docs/DATA-MODEL.md` §10).

**The index wraps the session store.** `SessionIndexService` (`apps/web/src/app/cloud/`) gives
`SessionService` its store wrapped, so that every write the timer, the recording and the sync check
make (they all go through `SessionService`'s store) is followed, once it is in the origin private file
system, by its document, without anyone waiting for it: the index's operations run one after the
other in a queue of their own (so that a session's documents go in the order of its saves), and each
write is handed to Firestore, whose persistent cache holds it until the server has it. No new
dependency: `AccountBackend` (`firebase-sdk.ts`, still the only file that imports Firebase) gains the
writes (`setDoc` and `writeBatch` with `merge`, batches of at most 500 writes, the session first) and
the queries (`getDocs` of `where('owner', '==', uid)`, the sessions by `createdMs` descending with a
`limit`; `getDoc` of one session), whose results carry each document's `hasPendingWrites` and the
query's `fromCache`. An attempt's document is written with its `upload` only when it is created
(the first write of this page load, or one that the catch-up did not find in the index); its later
writes carry every other field, since the upload's functions own `upload` from then on. The unit
tests' fake (`fake-account.ts`) keeps an index in memory that merges writes as Firestore's `set` with
`merge` does, refuses what the rules refuse of an attempt (a new document without its `upload`, a
change to an existing one's, a deletion of one that is not there), lets a test change `upload` as the
functions do (`serverSetsUpload`), and can go offline (writes applied at once, confirmed on
`goOnline()`); the end-to-end fake (`e2e/helpers/account.ts`) keeps one in `localStorage`, which a
test seeds with another device's session. `cloud.spec.ts` checks with it, on the dev server, that a
demo session signed in stays on the device ("this device") beside the seeded session ("cloud", whose
page is read-only, and the device filter), that the same session marked as a real cube's in its
`session.json` is written by the next start's catch-up (its documents valid against the cloud
schemas, no moves) and then shows "both", that the QA view counts both devices' attempts by day, and
that signed out the Sessions page has no badge, filter or QA link and Firebase never loads. The fake
cube is always simulated, so the live writes of a real cube's session are the unit tests' and the
owner's (`docs/MANUAL-TESTS.md`, T3.1).

**A composite index for the sessions query.** Firestore serves an equality on `owner` with an order on
`createdMs` only from a composite index: `firebase/firestore.indexes.json`, named in `firebase.json`.
The emulator needs none, so the rules' tests pass without it; the project needs it deployed
(`firebase deploy --only firestore:indexes`), which `.github/workflows/firebase.yml` (`--only
firestore:rules,functions`) does not do yet. The attempts' query (the equality alone, ordered by
document id) needs no index of its own.

**The rules' tests** (`firebase/rules.test.ts`, 45 tests with T3.2's, about 10 s) write the documents
the app writes, built with core's `cloudSession`, `cloudAttempt` and `cloudAttemptFields` (the rules'
tests import `@cubetrace/core` through its workspace), in one batch, read them back with the app's
queries, and write an attempt's fields again over an `upload` that the functions changed, which stays;
each of the 13 clauses of the index's checks (the shapes, and `upload` left alone) fails at least one
test when removed (checked on 2026-10-01 against an emulator on other ports, 8181, so as not to meet
another run's on 8080: two `npm run test:rules` at once share that port, and the second one fails to
start its emulator).

**Sizes** (`ng build`, 2026-10-01, against `main` at d7fee3d, whose app is e0b6417's): the initial
bundle is 264.63 kB raw, 72.49 kB transferred (264.53 and 72.45 before): the only change in `main` is
the route of `/qa` (104 bytes, its path, title and lazy import). The index's code
(`SessionIndexService`, 14.4 kB raw) is a lazy chunk that the Timer, Sessions, session and QA pages
share; the Sessions page's chunk is 15.1 kB (8.2 before), the session page's 11.0 kB (9.1), the QA
page's 8.7 kB; Firebase's chunk is 637.3 kB raw, 160.8 kB transferred (619.1 and 156.6 before), for
the queries and batches.

## Uploads (T3.3)

Added by T3.3 on 2026-10-02: the upload queue (`packages/upload`), its place in the app, Settings →
Uploads, the queue's panel and indicator (`docs/ARCHITECTURE.md`, "Uploads"; `docs/DATA-MODEL.md` §7
`local` and §10 `uploads.json`).

**No new dependency.** `packages/upload` is a workspace of plain TypeScript over `@cubetrace/core` and
`@cubetrace/storage`, tested by Vitest in Node with fakes of every port (`testing.ts`: the functions
and their bucket, the PUTs, a clock with timers, storage and the network; `test-device.ts`: the session
store over the fake origin private file system, with sessions recorded into it). The app's Firebase
chunk gains `firebase/functions` for `httpsCallable` (`firebase-sdk.ts`, still the only file that
imports Firebase).

**`XMLHttpRequest` for the PUT.** `fetch()` gives no progress of an upload; an `XMLHttpRequest` does,
and sends a `File` of the origin private file system from the disk, with the `Content-Length` its size
(R2's signature binds it); the headers the signature asks for are set as given. The port types the
request's event handlers as methods, whose parameters TypeScript compares both ways, so that the DOM's
(`this` the request, a `ProgressEvent`) fit it.

**The queue in a lazy chunk of its own, out of the prefetch.** `UploadService` loads
`upload-runtime-<hash>.js` (27.2 kB raw, 9.3 kB transferred) through `UPLOAD_RUNTIME`, a dynamic import,
once an account is signed in with uploads on; `ngsw-config.json` takes it out of the `app` group and
into `uploads`, a lazy group, as `firebase-sdk-*.js` is in `account`. `account.spec.ts` checks on the
production build, signed out, that it is neither requested nor cached.

**The header's indicator, deferred twice.** `HeaderControls` holds `@if (signedIn) { @defer (on
immediate) { <app-upload-indicator /> } }`, so that the indicator (1.7 kB) and `UploadService` (a chunk
of 6.7 kB that the Sessions page and a session's page share) load only with an account signed in, and
the service, which starts the queue, exists on every page then. It injects what the queue needs
(`SessionService`, the index, the store) rather than an `Injector` to reach them later, since a lazy
chunk's use of `Injector` makes `main` export it: tried first, it reshuffled `main`'s exports and added
11 bytes. Without it `main` is byte for byte the same but for the build's commit and the lazy chunks'
hashes: the initial bundle is 264.63 kB raw, as before (`ng build`, 2026-10-02, against `main` at
9ad784b; the CLI's estimate of its transfer, 72.51 to 72.59 kB, moves with the hashes). The header's controls are 2.6 kB (2.3), the Sessions page 21.2 kB (15.1, the
panel), a session's page 11.4 kB (11.0), Settings 21.0 kB (18.9), Firebase 646.8 kB raw (637.3).

**One tab uploads: a Web Lock.** The queue holds `cubetrace.uploads` (`navigator.locks`) while it runs;
another tab's queue waits for it, its status `waiting`, and the browser releases it when the tab goes.

**The end-to-end suite's bucket.** The fake of Firebase (`e2e/helpers/account.ts`) plays the two
functions over its index; their URLs are on the app's own origin (`/e2e-bucket/<key>`), which a
Playwright route answers before the dev server sees them (`fakeBucket`): the same origin, so no CORS
preflight, and `route.request().postDataBuffer()` has the whole body of an `XMLHttpRequest` PUT of a
`Blob` or an origin private file system `File` (checked with 3 MB of each); the page's fake
`confirmUpload` asks the test for an object's size through `page.exposeFunction`. A test that runs no
bucket gets `functions/unavailable` from `signUpload`, which the queue tries again later, so the other
specs' documents stay as they were. `uploads.spec.ts` records with Chrome's fake camera, in the
`encoding` project.

**A page that goes away takes its last write with it.** The first runs of `uploads.spec.ts` sent
`session.json` again at each page load: the next page, which holds the lock once the old document is
gone, read `uploads.json` before the old page's last write had landed. The queue now writes its state
100 ms after a change rather than 1 s, and at once on
`pagehide` (`UploadQueue.flush`), and asks the index about every attempt `uploads.json` does not show as
all done, so that what the index confirmed is not sent again; the test waits until `uploads.json` says
the attempt is done before its next page load.

## The account's cubes (T3.4)

Added by T3.4 on 2026-10-02: Settings' cube MAC addresses synced with the account
(`docs/ARCHITECTURE.md`, "The account's cubes"; `docs/DATA-MODEL.md` §10).

**No new dependency.** `AccountBackend` gains `listCubes(uid)` (`getDocs` of `users/{uid}/cubes`: the
server's documents, or the cache's when the server is out of reach, each with `hasPendingWrites`, and
the query's `fromCache`), `saveCube` (`setDoc` without `merge`: a document is written whole) and
`deleteCube`; `firebase-sdk.ts` is still the only file that imports Firebase. The merge is plain
functions (`cloud/cube-merge.ts`), tested without Angular; `CubeSyncService` is tested with two
devices of one account, two fakes of the backend (`fake-account.ts`) sharing one map of cubes, each
device with its own `localStorage` and clock, and one page load at a time.

**Two devices in the end-to-end suite.** The fake of Firebase (`e2e/helpers/account.ts`) keeps an
account's cubes in the test's process when the test gives it a cloud (`fakeCloud()`, then
`fakeAccount(page, {cloud})` for each page): the pages reach it through `page.exposeFunction`, so that
two browser contexts signed in to the fake account are two devices of it. Without a cloud, the cubes
stay in the context's `localStorage`, as the index does. `cube-macs.spec.ts` types an address in one
context and finds it in the other after a reload, removes it there and finds it gone from the first,
and checks that an export holds no address.

**Sizes** (`ng build`, 2026-10-02, against `main` at fef1c8c): the initial bundle is unchanged,
264.63 kB raw; `main` is byte for byte `main`'s built with the same commit stamp, but for the lazy
chunks' hashes (with another stamp, the minifier also names the object that holds it otherwise). The
cube sync and the merge are in the lazy chunk that the header's controls and the Settings page
share, beside `AccountControl` (13.1 kB raw, 6.9 before); the Settings page is 22.1 kB (21.0),
Firebase's chunk 647.0 kB (646.8).

## Cloud end-to-end (T3.5)

Added by T3.5 on 2026-10-02: the Playwright project `cloud`, which runs the app's own Firebase SDK
against the Auth, Firestore and Functions emulators, the functions' local bucket and its sink
(`docs/ARCHITECTURE.md`, "Testing the cloud").

**No new dependency.** The emulators are the pinned CLI's: the Auth and Functions emulators are its
own Node code, and the Firestore emulator is the jar the rules' tests already download and CI
caches. The CLI starts the Auth emulator only when `firebase.json` names it (`emulators.auth`, port
9099); without the entry, `--only auth` says "Not starting the auth emulator, make sure you have run
firebase init". The tests read the emulators through their REST APIs with `fetch` (the token `Bearer
owner` reads past the rules), rather than through the Admin SDK, which is the functions' dependency
and not the end-to-end suite's (`apps/web/e2e/helpers/emulators.ts`).

**The project exists only inside the emulators.** `firebase emulators:exec` sets
`FIREBASE_EMULATOR_HUB`, with `GCLOUD_PROJECT`, `FIREBASE_AUTH_EMULATOR_HOST` and
`FIRESTORE_EMULATOR_HOST`, for the command it runs: with it, the config adds the project `cloud`
(`*.cloud.spec.ts`, which `chromium` ignores) and the sink in place of the production build, which
no cloud spec uses. `npm run e2e` therefore lists the 73 tests it listed before, and `npm run
e2e:cloud` runs the three cloud ones.

**Signing in without Google's page.** The app's Firebase chunk is the production one, reached
through `ACCOUNT_LOADER`; in development builds a `window.cubetraceE2eEmulators` (the emulators'
addresses, their project, and a Google ID token of unsigned claims) makes `connectFirebase` start
the app under `demo-cubetrace` with `connectAuthEmulator` (its banner, which would cover the bottom
of the page, left out), `connectFirestoreEmulator` and `connectFunctionsEmulator`, and Sign in call
`signInWithCredential(GoogleAuthProvider.credential(<claims>))`. The Auth emulator's Google provider
takes the claims as they are, so that a test signs in without a window and the same `sub` is the
same uid in another browser context; the test learns the uid from the emulator's `accounts:lookup`.
A custom token or an email and password were the other ways the emulator offers: the Google
credential keeps the provider the app has (`google.com`), with the account's name and email. Each
spec signs in an account of its own (Ada, Grace, Lin), so the three run in parallel on one set of
emulators, each one's documents and objects under its own uid.

**The local bucket.** `BUCKET_PROVIDER=local` (`functions/src/local.ts`) is the third provider
behind `ObjectStore`, given to the emulators' project alone by `functions/.env.demo-cubetrace`,
which the Functions emulator reads after `.env` ("Loaded environment variables from functions/.env,
functions/.env.demo-cubetrace") and `firebase.json` keeps out of the deployed source. Its server's
address, `LOCAL_BUCKET_URL`, is a variable of that file rather than a parameter (`params.ts`), which
every deploy would need a value for; the deploy's parameters and `functions/.env` are as they were
(`deploy.test.ts`). It works only where `FUNCTIONS_EMULATOR` is `true`, as the Functions emulator
sets it (and firebase-functions reads it); elsewhere every call fails, saying so. `local.test.ts` (4
tests, 98 with the others) checks its URLs and sizes, its refusals, and an upload signed, put and
confirmed through the deployed functions against a server of the test's.

**The sink.** `apps/web/e2e/helpers/bucket-sink.mts`, started by the config (`node
e2e/helpers/bucket-sink.mts 4600`, a port that `functions/.env.demo-cubetrace` names too), keeps
each PUT in memory by key when it is what its URL was made for (the content type, GCS's
`x-goog-content-length-range`, the exact size, the expiry: 403 or 400 otherwise, "ExpiredToken" for
a late one, which the queue signs again), answers `HEAD` and `GET` per object and `GET /?prefix=`
with a listing, and answers the browser's preflights from `bucket/cors.json`: the app at
`http://localhost:4200` puts across origins to `http://127.0.0.1:4600`, as it does to the bucket.

| Flow | Spec | What it checks |
|---|---|---|
| The account | `account.cloud.spec.ts` | Sign in in the header signs in Ada through the Auth emulator; `users/{uid}`, written through the rules, is valid against `user.schema.json`, with `createdMs` the emulator's creation time to the second and the device's label; a reload keeps the account and sees the device again (its time later); Sign out forgets it, across a reload; every request of the browser context went to `localhost` or `127.0.0.1`, but for Firestore's network probe (below). |
| Uploads | `uploads.cloud.spec.ts` | Chrome's fake camera, demo solve 0 at speed 20, as `uploads.spec.ts` records it: the attempt recorded with its two clips, the session marked as a real cube's, then the Sessions page: the queue's panel says "Up to date"; the session's and the attempt's documents valid against the cloud schemas, without moves, with the device and its camera; the six files in the sink under `users/<uid>/sessions/<id>/`, with the device's sizes and types, `attempt.json` and `session.json` byte for byte; the attempt's `upload` done, each file with its `doneMs`; `users/{uid}.quota` the day's six files and their bytes; the session's page says "uploaded" and the QA view counts the attempt, 0 B pending. |
| Two devices | `devices.cloud.spec.ts` | Two browser contexts sign in Lin: a MAC address typed on the "laptop" reaches `users/{uid}/cubes` (valid against `cloud-cube.schema.json`) and a session recorded there, marked as a real cube's, the index; the "phone" has the same uid, the address in Settings, the session as "cloud" with the laptop's label, read-only on its page, and `users/{uid}.devices` has both labels. |

**Times.** Locally on four CPUs, over five runs, the three tests took 37.3 to 42.6 s in Playwright
(two workers; the uploads flow 19.4 to 20.9 s), and `npm run e2e:cloud` 57 to 62 s with the
functions' build (about 11 s), the emulators' start (about 8 s) and `ng serve`'s. In CI, in the pull
request's first run, the `npm run e2e:cloud` step took 45 s: 31.0 s of tests (the uploads flow 17.7
s), the rest the build, the emulators and the servers; the `npm run e2e` step 3 min 55 s, and the
whole job 7 min 47 s (7 min 52 s in T2.14's last run, without the cloud step: a run's time varies by
more than the step adds).

**Firestore's network probe.** After a connection error of its transport (the closure library's
WebChannel, in `@firebase/webchannel-wrapper`), as when a page reloads or signs out, Firestore loads
`https://www.google.com/images/cleardot.gif` to test the network; the app does it in production too.
It reaches no service, and it is the one request off the machine that `account.cloud.spec.ts`
allows: the second full run met it, which an earlier check of every request's host had failed on.

**Sizes** (`ng build`, 2026-10-02, against `main` at 5c79af8): `main` is byte for byte the same but
for the version, the build's commit and the lazy chunks' hashes, so the initial bundle is 264.63 kB
raw, as before. Firebase's chunk is 650.7 kB raw (647.0), with `connectAuthEmulator`,
`connectFirestoreEmulator`, `connectFunctionsEmulator` and `signInWithCredential`, which a
production build never calls; the chunk of `ACCOUNT_LOADER` 6.8 kB (6.4), with the flag's reader.

**What the emulators log.** At each account the Auth emulator creates, the Functions emulator logs
"Firebase Authentication function was not triggered due to emulation error. Please file a bug.": the
Auth emulator offers each new account to the Functions emulator for the project's auth triggers, of
which there are none, and warns when nobody takes it. In the agents' containers, the CLI also warns
that each port is free on 127.0.0.1 but not on `::1`, which has no IPv6 there.
