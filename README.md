# cubetrace

A Chrome web app that records speedcube solves in sync with a GAN Bluetooth cube: a
Cubeast-like timer (scrambles, CFOP breakdown) whose side effect is a dataset of video and
move logs. It runs on a laptop or on a phone alone; phones can join as extra cameras.

**Status:** phase 1 scaffold. The app has its four pages (Timer, Sessions, Settings, Probe) as
placeholders; the plan is in [`docs/PLAN.md`](docs/PLAN.md).

## Repository

```
apps/web/        Angular app (standalone components, SCSS, routing, no SSR); Playwright tests in apps/web/e2e/
packages/core/   @cubetrace/core: cube simulator, scrambles, attempt state machine, CFOP phases (plain TypeScript)
packages/gan/    @cubetrace/gan: GAN Bluetooth driver wrapper and the fake cube (plain TypeScript)
fixtures/        real solves used as test oracles (read-only)
docs/            plan, architecture, data model, toolchain, changelog
```

## Requirements

Node.js 22 (at least 22.22.3, which Angular CLI 22.2 requires) and npm 10. The app targets
Chrome (Web Bluetooth, WebCodecs) on Android, macOS and Windows.

## Commands

Run from the repository root.

| Command | What it does |
|---|---|
| `npm ci` | install everything (npm workspaces: `apps/*`, `packages/*`) |
| `npm start` | dev server on http://localhost:4200 (`ng serve`) |
| `npm run build` | production build into `apps/web/dist/web/browser` (`ng build`) |
| `npm test` | package tests (Vitest), then the app's tests (`ng test`, single run, jsdom) |
| `npm run test:watch` | package tests in watch mode; for the app, `npm run test -w @cubetrace/web` |
| `npm run e2e` | Playwright end-to-end tests in Chromium (starts `ng serve` on port 4200 and a production build on port 4300, unless servers already run there) |
| `npm run lint` | type-check, `eslint .`, then `ng lint` for the app |
| `npm run format` / `npm run format:check` | Prettier write / check |

Before the first `npm run e2e` on a new machine: `npx playwright install chromium`.
Exact versions and the reasons behind the setup are in [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).

## Deploy

Every push to `main` builds the app with `--base-href /cubetrace/` and publishes it to
GitHub Pages, at https://shermam.github.io/cubetrace/ (`.github/workflows/pages.yml`). Pages
must be enabled once by the owner (Settings → Pages → Source: GitHub Actions; see
[`docs/USER-ACTIONS.md`](docs/USER-ACTIONS.md)). Pull requests and pushes run
`.github/workflows/ci.yml`: lint, format check, tests, build and the end-to-end tests.

## Documentation

- [`CLAUDE.md`](CLAUDE.md): rules for everyone working in the repository
- [`docs/PLAN.md`](docs/PLAN.md): phases, tasks and acceptance criteria
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): modules and their contracts
- [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md): the JSON the app produces
- [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md): versions, commands and toolchain decisions
- [`docs/MANUAL-TESTS.md`](docs/MANUAL-TESTS.md): checks that need a real cube or phone
- [`docs/USER-ACTIONS.md`](docs/USER-ACTIONS.md): things only the owner can do
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## License

[MIT](LICENSE)
