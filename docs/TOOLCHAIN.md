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
| mediabunny | 1.60.0 | `packages/capture/package.json` | added by T2.3 to mux the encoded chunks into MP4 without re-encoding, in a worker (the clip worker since T2.4); MPL-2.0; brings `@types/dom-webcodecs` 0.1.13 and `@types/dom-mediacapture-transform` 0.1.12 (type declarations only); see "Clips" below |

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
| Recording (T2.4) | `recording.spec.ts` | Chrome's fake camera at 30 fps and its microphone, demo solve 0 at speed 20: four replays with the camera off, then four with it on, each waiting for the last one's clips; every attempt recorded has its two clips in OPFS, their frames files valid, each clip from its margin (2 s before the scramble's first turn, 3 s before the solve's) to at most one GOP earlier and to about 1 s after its segment; the viewer plays the last solve clip (`loadedmetadata`) with its moves, and Download gives the five files with the sizes of the record; the export validates; the median `timeMs` with the camera on is within 5 ms of the median with it off. In the capture lab, a 10 s clip saved mid-way: no frame dropped and no double interval in the second after it. The file's two tests run one after the other (`mode: 'default'`): each encodes 1080p30 in software. |
| Sync check (T2.5) | `sync-check.spec.ts` | Chrome's fake camera at 30 fps, demo solve 0 at speed 20: once the solve is recorded, the camera on; when it records, the check starts by itself (the capture worker's frames counted), the timer's status says `sync-check`, the scramble and "Attempt 2" stay; after 20 s it fails with "the cube did not move" (the demo has finished: the same outcome every run) and Retry, and attempt 2 is back with its scramble; Retry, Later and "Sync check" start and hide it; the export has no `clock.cameras` entry and the one attempt of the solve. In the capture lab, a 6 s check with the demo cube's turns reports its outcome and the capture worker's time per frame, which it prints. |
| Session with clips (T2.6) | `session-clips.spec.ts` | Chrome's fake camera at 30 fps and its microphone, demo solve 0 at speed 20: the solve that starts with the page, recorded before the camera is on, is deleted (Delete last); the camera on, the sync check that starts by itself is ended with Later; two replays, each with its two clips; then a new page load straight to the session's page: both attempts listed with a badge "2 clips, …", "4 clips, …" in its header, the first attempt's solve clip plays in the viewer, and the page's Export validates against schema 2; every clip of the records is a file in its attempt's folder in OPFS, the MP4 of the record's size and the frames file valid against its schema, with the record's frame count and first frame, and nothing else is there but `attempt.json`. |
| First render (T2.6) | `timer-render.spec.ts` | On the production build under `/cubetrace/`, after a demo solve (a session with a stored solve), the first animation frame that shows the clock comes within 2 s of `DOMContentLoaded`, with the camera setting off and on; with the camera (`getUserMedia`) and the storage (`navigator.storage.getDirectory`) each held back 3 s, the clock still comes within 2 s, and the solve list and the camera's preview after them. Recording is off in the file (no `MediaStreamTrackProcessor`), as in `timer-layout.spec.ts`. It prints the times: over three runs, the clock 44 to 83 ms after `DOMContentLoaded` with the camera off or on, the solve list 104 to 177 ms and the preview 137 to 194 ms; held back, the clock 39 to 104 ms, the list 3,056 to 3,121 ms and the preview 3,139 to 3,237 ms. |

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
  `session-clips.spec.ts` and `sync-check.spec.ts` record Chrome's fake camera, encoding 1080p30 VP9
  in software; they are the Playwright project `encoding`, limited to one worker (the project's
  `workers` option) and listed first, so that the next of them starts as soon as one ends, while the
  other specs, the project `chromium`, run in the other worker. Two encoders at once on four CPUs
  lose frames and hold back the demo cube's timers: when `session-clips.spec.ts` joined the suite,
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
microphone gives 48 kHz mono in 10 ms buffers.

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
Opus the dOps from the OpusHead description, its pre-skip included. The packets of both tracks go in
by time, so the file interleaves them in half-second chunks. The audio keeps its place by its own
timestamps (the capture clock is shared, `docs/DEVICES.md`): chunks that end before the first frame
are left out, and the one that overlaps it starts before 0, which mediabunny writes as an edit list.
The video's time scale is mediabunny's default, 57,600 per second, with no frame rate set, so the
frames keep their measured intervals to 17 µs (the exact times are in frames.json). A frame whose
chunk has no duration lasts until the next frame, and the last one the median interval. Muxing takes
2 ms for 1 s of the fake camera, 20 ms for 30 s (5 MB) and 50 ms for 90 s (15 MB) in Node on the
agents' containers (medians of the committed sample repeated); the bytes are the encoder's, never
decoded.

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
`getUserMedia({audio: true})`; a refusal records the video alone and says so. `SessionService`
emits `milestones$` (an attempt `armed`, `ended` with its record and its end, or `dropped` without a
record); the service saves the scramble clip `[scrambleStart − 2 s, scrambleDone + 1 s]` and the solve
clip `[solveStart − 3 s, end + 1 s]` a second and a quarter after their end, the quarter second for
the last frames to come out of the encoder (tens of milliseconds, more on a busy machine), so that
the cut is whole. `SessionService.attachClip` keeps a clip for the record of an attempt under way,
or saves the record again with the clip (its timing untouched); a clip of an attempt that went is
removed. The unit tests (`recording-service.spec.ts`) drive a real `SessionService` with the fake
cube on a fake clock (`session-harness.ts`) and a fake pipeline (`recording-testing.ts`).

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

## The sync check (T2.5)

Added by T2.5 on 2026-09-27: the motion of the frames in the capture worker
(`packages/capture/src/motion.ts`), the clapperboard (`clapperboard.ts`), and the check in the app
(`apps/web/src/app/camera/sync-run.ts`, `sync-service.ts`, `sync-check.ts`, and a section of the
capture lab).

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
cannot copy (no pixel format, or a frame marked to be shown turned or mirrored, which newer
browsers do instead of turning its pixels) are drawn into an `OffscreenCanvas` by the sharpness
meter's `LumaSampler` at 160 pixels. The worker measures a frame after handing it to the encoder, and
only while a check runs; the e2e runs measured 1.1 to 1.2 ms a frame at the median and 1.5 to 4.9 ms
at the 95th percentile while the same worker encoded 1080p30 VP9 (`docs/DEVICES.md`, "Camera lag").
The unit tests hold the median under 2 ms on synthetic 1080p frames (about 0.6 to 0.9 ms in Node).

**The frames' times** are those of the clips (`docs/DATA-MODEL.md` §9): each sample carries the
frame's timestamp and its arrival in the worker, and the check places its frames at their timestamp
plus the median arrival offset, so the onsets have none of the arrival's jitter. A move's time is
its `hostMs`, the arrival of its Bluetooth packet, as `docs/DATA-MODEL.md` §6 defines the offset.

**The clapperboard** follows the plan (an onset is the first frame above 4 times the still
picture's median energy after 500 ms under it, matched one to one to the nearest turn within 500 ms;
the offset is the median lag, the residual the spread from the 5th to the 95th percentile; fewer than
4 matches or a spread over 40 ms fail), with two additions. The threshold is at least 0.5 luma
levels, for a picture that does not change at all (its baseline is then 0; a camera's noise alone
keeps it above that). And only single turns are matched: moves with no other move within 500 ms
either way, as the check asks for. The demo cube's scramble and solve (and a solver's) come so close
together that any onset finds one within a few ms, so on the fake camera, whose test pattern jumps
every half second or so, a check could otherwise pass on noise and keep a wrong lag: before this rule
the lab's e2e check paired 6 and 7 of the pattern's onsets with the demo's turns at speed 1 (spreads
of 195 and 482 ms), and at the recording test's speed of 20, whose turns come 5 to 50 ms apart, every
onset during a replay finds a turn within 25 ms, which can make a narrow spread out of nothing.

**The check in the Timer** starts by itself when a session is under way with the camera recording, a
cube connected and no check of that camera in the session's `clock.cameras`, once per session and
camera, and only where an attempt starts: before the scramble's first turn, or between attempts
(not once a scramble has begun, nor while a solve is about to start, is under way or is paused);
"Sync check" runs it again under the same conditions, and "Later" ends it and hides it. It asks to
turn one face, pause, turn it back, five times over: ten single turns that leave the cube as it
was. It ends at 20 s, or as soon as the ten turns are matched within the spread and a second has
passed since the last turn and the last onset; the recording stopping or the cube disconnecting
end it as failed. While it runs the timer tracks no attempt (`SessionService.suspendForSyncCheck`,
refused while an attempt is armed or solving): the attempt waiting for its scramble is dropped
without a record, by the path "Mark as solved" takes, the cube's moves go to no attempt (they still
feed the session's coarse cube clock fit), the status line says "Sync check: …" (a timer phase of
its own, `sync-check`), and when the check ends (`resumeAfterSyncCheck`) the attempt begins again
with the same scramble and number as soon as the cube is solved, or "Solve the cube first" says
what to do. So no record holds the check's turns, and no scramble clip either (the restarted
attempt's clip begins 2 s before its own first turn). On success `SessionService` keeps the lag with
the matched pairs in `clock.cameras[label]` (`putCameraClock`), and `attachClip` gives each clip of
that camera attached from then on its `offsetMs` as `syncResidualMs`: clips saved before the check
keep null, and one saved within a second after it, whose frames were before it, gets the lag too.
The capture lab's check involves no session: the lab is a page reached by its address, whose load
starts no timer.

**Sizes** (`ng build`, 2026-09-27, against `main` at 01706c2, with T2.7): the initial bundle is
unchanged, 264.46 kB raw. The motion code is in the capture worker only, 18.2 kB raw, 6.2 kB
transferred (12.1 and 4.2 before). The clapperboard and the pipeline's `watchMotion` joined the
window side of `packages/capture`, the chunk the Timer's camera code and the capture lab share, 17.4
kB raw (14.0 before). The sync check's panel and `SyncService` are in the chunk of the camera's
preview, beside the time (T2.7), which the Timer page loads right after it renders: 14.6 kB raw,
4.4 kB transferred (6.1 and 2.1 before); `SyncRun`, which the preview and the capture lab share, is
a chunk of its own, 2.8 kB (1.1 kB gzipped); the capture lab's chunk is 19.2 kB (16.0), the chunk of
`SessionService` 24.1 kB (23.2: the suspension and `putCameraClock`), the Timer page's and Camera
settings' unchanged but for a status line (28.2 and 25.2 kB).

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
