# cubetrace — rules for everyone (humans and agents) working in this repo

cubetrace is a Chrome web app that records speedcube solves in sync with a GAN Bluetooth
cube: a Cubeast-like timer (scrambles, CFOP breakdown) whose side effect is a dataset of
video + move logs. It runs on a laptop or on a phone alone; phones can join as extra
cameras over WebRTC; everything is processed in the browser and uploaded to one dataset.

**Read first:** `docs/PLAN.md` (phases, tasks, acceptance criteria — your task is one row
of it), `docs/ARCHITECTURE.md` (modules and their contracts), `docs/DATA-MODEL.md` (the
JSON the app produces). The full design, including the reasoning and the measurements
behind the numbers, is in the owner's private repo; in this coordination environment it is
readable at `/home/user/aulas-mestrado/random-research/cube-capture-app/DESIGN.md`.

## Toolchain (pinned by T1.0; do not change without a PR that says why)

- Node 22, npm 10, npm workspaces: `apps/web` (Angular, PWA) and `packages/*` (plain
  TypeScript libraries: `core`, `gan`, later `capture`). Libraries never import Angular.
- TypeScript `strict`, no `any` (use `unknown` and narrow), ESLint + Prettier, both clean.
- Tests: Vitest for `packages/*` (runs in Node, no browser); Angular's test runner for the
  app; Playwright with Chromium for end-to-end flows, driven by the fake cube.
- Chrome-only browser APIs are fine (Web Bluetooth, WebCodecs, OPFS); guard them so the
  app still renders elsewhere with a clear message.
- Dependencies: `cubing` (cubing.js) for scrambles and the cube picture, `rxjs`,
  `mediabunny` (phase 2), the GAN driver fork `github.com/shermam/gan-web-bluetooth`
  (MIT). Add nothing else without a sentence in the PR saying why.

## Workflow

- **One task per PR.** Branch `task/<id>-<slug>` from the latest `main` (`git fetch origin
  main` first). Never commit to `main`; never force-push a shared branch.
- Commit messages and code comments in English. PR title `T1.3: colour-neutral CFOP phase
  detector`. PR body: what and why (two paragraphs max), how it was tested (commands and
  results), the acceptance criteria from `docs/PLAN.md` with each one checked or marked
  not done and why, and anything that needs a human with a real cube or phone.
- CI must be green before review. Run `npm run lint && npm test && npm run build` (and
  `npm run e2e` when the app changes, `npm run e2e:cloud` when the cloud code does) locally before pushing.
- The coordinator reviews and merges. If you are blocked, or a criterion cannot be met,
  write it in the PR body and stop; do not widen the task to work around it.
- Update `docs/PLAN.md` only in the "Status" column of your own task, and `docs/DATA-MODEL.md`
  or `docs/ARCHITECTURE.md` when your change alters a contract. Add a `docs/CHANGELOG.md`
  entry for user-visible changes.

## Code rules that matter here

- Device-dependent behaviour (Bluetooth, camera, storage quotas) lives behind interfaces
  in `packages/*` with a fake implementation next to it; the app is developed and tested
  with the fakes. Every path that needs real hardware gets a checklist item in
  `docs/MANUAL-TESTS.md`.
- Time is always milliseconds in the host clock (`performance.timeOrigin + performance.now()`),
  as a number; cube time is kept alongside as `cubeMs`, never substituted.
- Cube state is a 54-character Kociemba facelet string (`docs/DATA-MODEL.md` §2); moves are
  face turns `U D R L F B` with `'` and `2`; nothing else in v1.
- No secrets in the repo, ever: no service-account keys, no tokens, no MAC addresses. The Firebase
  web config in `apps/web/src/environments/firebase.ts` is public by design and is committed (T3.0).
  Configuration that differs per deployment goes through `environment.ts` placeholders
  documented in `docs/USER-ACTIONS.md`.
- Fixtures in `fixtures/` are real solves (scramble, raw move stream, Cubeast's phase
  timings). Tests compare against them; do not edit them by hand.
