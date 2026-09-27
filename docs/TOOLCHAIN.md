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
| rxjs, tslib | 7.8.2, 2.8.1 | `apps/web/package.json`; rxjs also `packages/gan/package.json` | Angular runtime dependencies; rxjs is also the type of `CubeConnection.events$` |
| gan-web-bluetooth (the owner's fork) | 3.0.2 plus 3 commits: git `52417a1` | `packages/gan/package.json` | GAN cube driver, a git dependency pinned to that commit; see "GAN driver" below |
| `@angular/service-worker` | 22.2.0 | `apps/web/package.json` | added by `ng add @angular/pwa@22.2.0` (T1.7); `@angular/pwa` itself is only the schematic and is not installed |
| cubing (cubing.js) | 0.63.7 | `packages/core/package.json`, `apps/web/package.json` | added by T1.2 for scrambles; the app uses it directly for the scramble picture (`cubing/twisty`, T1.6b); MPL-2.0 or GPL-3.0; needs Node 22.3 or later; see "cubing.js" below |

## Commands

| Root script | Runs |
|---|---|
| `npm start` | `ng serve` in `apps/web` (extra arguments after `--` go to `ng`), after `scripts/write-version.mts` and `scripts/write-demo-solves.mts` |
| `npm run build` | `ng build` in `apps/web`, production configuration, output `apps/web/dist/web/browser`, after `scripts/write-version.mts` and `scripts/write-demo-solves.mts` |
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

The whole suite (34 tests, two workers) took 44 s and 59 s in CI in the pull request's first two
runs (the `npm run e2e` step, servers included; T1.6b's suite took 40 s), and 58 to 60 s locally on
four CPUs in three runs in a row on 2026-09-27.
