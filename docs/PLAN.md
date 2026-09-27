# Implementation plan

How to read this: each task is one pull request by one implementer, with a goal, a scope,
the contracts it must expose, the tests it must add, and acceptance criteria that the
reviewer checks literally. Do the task as written; if something in it is wrong or
impossible, say so in the PR and stop rather than improvising around it. The coordinator
keeps the status column current.

Status legend: ⬜ not started · 🟦 in progress (branch named) · 🟨 in review (PR number) ·
✅ merged (PR number) · ⛔ blocked (reason).

## Phases

| Phase | Delivers | Status |
|---|---|---|
| **1. The timer, on any device** | cube connection, scrambles, state tracking, mis-scramble guidance, timer, colour-neutral CFOP breakdown validated against the Cubeast fixtures, session records staged in OPFS, PWA, probe page, fake cube, e2e suite, GitHub Pages deploy. Replaces Cubeast for daily practice. | 🟦 |
| 2. The host's own camera | WebCodecs pipeline, ring buffer, two-segment cuts with audio, MP4 via mediabunny, `frames.json`, sharpness meter, clapperboard. Solo mode and laptop-only rigs produce paired data. | ⬜ |
| 3. Cloud | Firebase auth, session index, upload queue with signed URLs (R2 or GCS by configuration), budget alert, QA view across devices. | ⬜ |
| 4. Remote cameras | WebRTC pairing by QR, clock sync, remote cuts, clip transfer over the data channel. | ⬜ |
| 5. Community | consent flow, quotas, delete-my-data, community mode. | ⬜ |

## Phase 1 task board

| Id | Task | Depends on | Status |
|---|---|---|---|
| T1.0 | Scaffold: workspaces, Angular app, packages, lint, tests, CI, Pages deploy | — | ✅ #1 |
| T1.1 | `core`: notation and the cube simulator (Kociemba facelets) | T1.0 | ✅ #2 |
| T1.2 | `core`: scramble generation (cubing.js), target state, scramble progress and undo guidance | T1.1 | ✅ #5 |
| T1.3 | `core`: colour-neutral CFOP phase detector, validated against the fixtures | T1.1 | ✅ #7 |
| T1.4 | `core`: attempt state machine, records, cube clock fit, statistics, JSON Schemas, store interface | T1.2, T1.3 | ✅ #8 |
| T1.5 | `gan`: driver wrapper (Web Bluetooth), MAC provider, support check, fake cube | T1.1 | ✅ #6 |
| T1.6a | `web`: cube connection: connect dialog, `CubeService`, status pill, live cube panel (net, move log), settings, demo mode | T1.5 | ✅ #9 |
| T1.6b | `web`: timer page, breakdown chart, solve list, sessions page, OPFS store, `SessionService` | T1.4, T1.6a | ✅ #10 |
| T1.7 | `web`: PWA (manifest, service worker), wake lock, storage persistence, responsive layouts, version display | T1.0 | ✅ #3 |
| T1.8 | `web`: device probe page (`/probe`) | T1.0 | ✅ #4 |
| T1.9 | end-to-end suite with the fake cube; JSON Schema validation of exports | T1.6 | ✅ #14 |
| T1.10 | docs, CHANGELOG, `v0.1.0`, manual test round with the owner | T1.7, T1.8, T1.9 | ✅ #11 (tag `v0.1.0` after the owner's round) |
| T1.11 | `storage`: atomic OPFS writes and tolerant reads (issue #12) | T1.6b | ✅ #15 |
| T1.13 | `core`+`web`: scramble tokens coloured as they are made (done, half made, wrong) | T1.2, T1.6b | ✅ #16 |
| T1.12 | `web`: one-click cube connection; the dialog only for the MAC prompt, details and errors | T1.6a | ✅ #17 |
| T1.14 | `gan`+`web`: Mark as solved (cube reset), idle auto-disconnect, disconnect diagnostics, driver preload | T1.12 | 🟨 #18 |

Waves for parallel work: T1.0 → {T1.1, T1.7, T1.8} → {T1.2, T1.3, T1.5} → {T1.4, T1.6a} → T1.6b →
{T1.9, T1.10}. T1.6 was split into T1.6a and T1.6b on 2026-09-27 so that the owner can test the
driver on the real cubes while T1.4 is built.

**Definition of done for phase 1:** every task merged; CI green on `main`; the app deployed
on GitHub Pages; the owner's manual test round (`docs/MANUAL-TESTS.md`, T1.5–T1.7 sections)
passed on one laptop and on the ThinkPhone with both cubes, or the failures filed as issues
and fixed.

---

## T1.0 — Scaffold

**Goal.** A repository where `npm ci && npm run lint && npm test && npm run build && npm run e2e`
passes in CI, with the app deployable to GitHub Pages, so every later task only adds code.

**Scope.**

```
package.json                 npm workspaces: ["apps/*", "packages/*"]; root scripts (below)
apps/web/                    Angular application (latest stable; standalone components; SCSS; routing; no SSR)
packages/core/               plain TS library "@cubetrace/core" with src/index.ts, a trivial function, one Vitest test
packages/gan/                plain TS library "@cubetrace/gan" (placeholder index.ts)
tsconfig.base.json           strict; paths "@cubetrace/*" -> "packages/*/src/index.ts" (verify the Angular build resolves it)
vitest.config.ts             root config for packages/**/src/**/*.test.ts (environment: node)
eslint.config.js             flat config: typescript-eslint (strict), angular-eslint for apps/web; Prettier via eslint-config-prettier
.prettierrc, .editorconfig
apps/web/e2e/                Playwright config + smoke test (app loads, shows the title); uses Chromium
.github/workflows/ci.yml     on push and pull_request to main: Node 22, npm ci, lint, test, build, playwright install --with-deps chromium, e2e; upload playwright-report on failure
.github/workflows/pages.yml  on push to main: build with --base-href /cubetrace/, copy index.html to 404.html, actions/configure-pages (try enablement: true), upload-pages-artifact, deploy-pages; permissions pages: write, id-token: write
README.md                    what it is, how to run (npm start), test, build, deploy; links to docs/
LICENSE                      MIT, "Copyright (c) 2026 shermam"
docs/TOOLCHAIN.md            the exact versions installed (node, npm, angular, typescript, vitest, playwright, cubing) and the commands
docs/CHANGELOG.md            "Unreleased" section
```

Root scripts: `start` (ng serve), `build` (ng build), `lint` (eslint . and ng lint),
`test` (vitest run, then ng test in headless single-run mode), `test:watch`, `e2e`
(playwright test), `format` (prettier --write), `format:check`.

**Behaviour.** The app has four routes with placeholder pages: `/` (Timer), `/sessions`,
`/settings`, `/probe`, and a top navigation. Nothing functional yet.

**Decisions to make and record in `docs/TOOLCHAIN.md`:** the Angular version installed and
its test runner (use Angular's default; if it is Vitest, share the root config); whether
`ng build` resolves the `paths` mapping to `packages/*/src` directly (preferred) or the
packages need a build step (then add `tsc -b` to `build` and document it).

**Tests.** The core placeholder test; the e2e smoke test; CI runs both.

**Acceptance.**
- [ ] `npm ci && npm run lint && npm test && npm run build && npm run e2e` pass locally and in CI (link the green run).
- [ ] `apps/web` imports `@cubetrace/core` and the built app calls the placeholder function (visible on the Timer page as the version string).
- [ ] The Pages workflow runs on merge; if the deploy step fails only because Pages is not enabled yet (`docs/USER-ACTIONS.md`), say so in the PR; the build step must succeed.
- [ ] No `any`, lint and format clean, `docs/TOOLCHAIN.md` written.

---

## T1.1 — `core`: notation and the cube simulator

**Goal.** The pure functions everything else stands on: parse and format moves, apply moves
to a Kociemba facelet string, test solvedness, read pieces.

**Scope.** `packages/core/src/notation.ts`, `packages/core/src/cube.ts`,
`packages/core/src/pieces.ts`, tests next to them, `packages/core/src/index.ts` exports.

**Contracts.**

```ts
// notation.ts
export type Face = 'U' | 'D' | 'R' | 'L' | 'F' | 'B';
export interface Move { face: Face; turns: 1 | 2 | 3 }          // 3 = counter-clockwise (')
export class NotationError extends Error {}
export function parseMoves(text: string): Move[];               // "R U2 F'" ; tokens separated by whitespace; throws NotationError on anything else (wide moves, rotations, slices are errors in v1)
export function parseMove(token: string): Move;
export function formatMove(m: Move): string;                    // "R" | "R2" | "R'"
export function formatMoves(ms: readonly Move[]): string;
export function inverse(m: Move): Move;
export function inverseSequence(ms: readonly Move[]): Move[];   // reversed and inverted
export function quarterTurns(ms: readonly Move[]): number;      // turns === 2 counts 2

// cube.ts
export type Facelets = string;                                  // 54 chars, see docs/DATA-MODEL.md §2
export const SOLVED: Facelets;
export const FACE_ORDER: readonly Face[];                       // ['U','R','F','D','L','B']
export function faceletsOf(f: Facelets, face: Face): string;    // the 9 chars of one face
export function assertFacelets(f: string): asserts f is Facelets; // 54 chars, 9 of each colour, centres in place
export function applyMove(f: Facelets, m: Move): Facelets;
export function applyMoves(f: Facelets, ms: readonly Move[]): Facelets;
export function isSolved(f: Facelets): boolean;                 // every sticker equals its face's centre (index 4 of the face)
export function isSolvedIgnoringOrientation(f: Facelets): boolean; // same thing, documented alias (centres never move)

// pieces.ts — piece-level reads for the phase detector
export type CornerPos = 'URF' | 'UFL' | 'ULB' | 'UBR' | 'DFR' | 'DLF' | 'DBL' | 'DRB';
export type EdgePos = 'UR' | 'UF' | 'UL' | 'UB' | 'DR' | 'DF' | 'DL' | 'DB' | 'FR' | 'FL' | 'BL' | 'BR';
export const CORNER_FACELETS: Record<CornerPos, [number, number, number]>; // facelet indices, first is the U/D sticker
export const EDGE_FACELETS: Record<EdgePos, [number, number]>;             // first is the U/D sticker for U/D edges, the F/B sticker for FR FL BL BR
export function cornerAt(f: Facelets, pos: CornerPos): [string, string, string];
export function edgeAt(f: Facelets, pos: EdgePos): [string, string];
export function adjacentFaces(face: Face): Face[];              // the four faces around one, in clockwise order seen from that face
export function opposite(face: Face): Face;
```

**Implementation notes.** Represent a move as a permutation of the 54 indices and derive the
six quarter-turn permutations from the standard cubie tables (Kociemba's, 1-based within
each face, U=1–9, R=10–18, F=19–27, D=28–36, L=37–45, B=46–54):

```
corners  URF: U9 R1 F3   UFL: U7 F1 L3   ULB: U1 L1 B3   UBR: U3 B1 R3
         DFR: D3 F9 R7   DLF: D1 L9 F7   DBL: D7 B9 L7   DRB: D9 R9 B7
edges    UR: U6 R2   UF: U8 F2   UL: U4 L2   UB: U2 B2   DR: D6 R8   DF: D2 F8   DL: D4 L8   DB: D8 B8
         FR: F6 R4   FL: F4 L6   BL: B6 L4   BR: B4 R6
```

Verify these tables against the geometry in a test (each corner's three facelets are on
three mutually adjacent faces at the shared corner; each edge's two are on adjacent faces at
the shared edge) rather than trusting them, and verify every permutation against
`fixtures/identities.json` (`after_R` in particular) and against all 300 fixtures.

**Tests.**
- `applyMoves(SOLVED, parseMoves(s.scramble)) === s.scrambled_facelets` for every fixture.
- `isSolved(applyMoves(s.scrambled_facelets, moves of s.solution)) === true` for every fixture.
- identities: `return_to_solved` sequences reach `SOLVED`; `not_solved` do not; `X X X X` is identity for every face; `applyMoves(f, inverseSequence(ms))` undoes `applyMoves(f, ms)` on random sequences.
- notation: round trip parse/format; every invalid token throws.
- pieces: `cornerAt(SOLVED, 'URF')` is `['U','R','F']`; after `R`, `edgeAt(f, 'UR')` is `['F','R']`.

**Acceptance.**
- [ ] All tests above pass; the fixture loop runs in under 2 s.
- [ ] No dependency added.
- [ ] `docs/DATA-MODEL.md` §2 unchanged (the implementation follows the document, not the other way round).

---

## T1.2 — `core`: scrambles, target state, progress and undo guidance

**Goal.** Generate WCA random-state scrambles in the browser, know the target state, and
follow the cube through the scramble with exact "you are here" and "undo this" guidance.

**Scope.** `packages/core/src/scramble.ts` + tests; the dependency `cubing`.

**Contracts.**

```ts
export function generateScramble(): Promise<string>;            // cubing/scramble randomScrambleForEvent("333").toString(), normalized to our notation (no trailing spaces; "U2'" never appears; if cubing.js ever emits a token we do not accept, throw)
export function scrambleTarget(scramble: string): Facelets;     // applyMoves(SOLVED, parseMoves(scramble))
export interface ScrambleProgress {
  matched: number;            // scramble moves reached so far (0..n)
  total: number;
  done: boolean;              // current state equals the target
  diverged: boolean;          // the cube is off the scramble path
  undo: Move[];               // moves to make, in order, to get back to the last matched state (empty when not diverged)
  extraMoves: number;         // moves made that were not part of the scramble path (grows with mistakes and their corrections)
}
export class ScrambleTracker {
  constructor(scramble: string, start: Facelets = SOLVED);
  onMove(m: Move): ScrambleProgress;
  readonly progress: ScrambleProgress;
  readonly state: Facelets;
}
```

**Algorithm for the tracker.** Precompute `expected[k]` = state after the first `k` scramble
moves. Keep `current` and `matched`. On each move: update `current`; look for the largest
`k` in `[matched, min(n, matched + 2)]` with `expected[k] === current` (a `U2` may arrive as
two `U`s; a wrong then corrected move returns to `expected[matched]`). If found: `matched = k`,
`diverged = false`, `undo = []`, and the moves since the last match are discarded. If not:
`diverged = true`, append the move to a `sinceMatch` list, `undo = inverseSequence(sinceMatch)`,
`extraMoves += 1`. `done = current === target`. Note that a solver may also "fix" a
mis-scramble by a different path; the state check catches that (some later move will match
an `expected[k]`).

**Tests.**
- Executing each fixture's scramble exactly gives `matched === total`, `done`, no divergence.
- A scramble with `U2` executed as `U U` is tracked to done.
- Wrong move then its inverse: diverged after the first, `undo` equals `[inverse]`, matched again after the second, `extraMoves === 2`.
- Two wrong moves: `undo` has two entries in the right order.
- `generateScramble()` (Vitest, Node): returns 15–30 tokens that `parseMoves` accepts and whose target is not solved; run 20 times.

**Acceptance.**
- [ ] Tests pass in Node (cubing.js's scramble worker works under Vitest; if it needs a flag or a polyfill, document it in `docs/TOOLCHAIN.md`).
- [ ] The Timer page shows a real generated scramble as text (the picture is T1.6) and the browser build works with cubing.js's worker (a Playwright check that the scramble text matches `/^([UDRLFB][2']? ?){15,30}$/`).
- [ ] `cubing` is the only dependency added.

---

## T1.3 — `core`: colour-neutral CFOP phase detector

**Goal.** Given the scrambled state and the timed solve moves, produce the eight phase
boundaries with recognition and execution times, matching Cubeast on the fixtures.

**Scope.** `packages/core/src/phases.ts` + tests; a report of agreement with the fixtures in
the PR.

**Contracts.**

```ts
export interface TimedMove { m: Move; ms: number }               // ms in any single clock (cube ms in tests, host ms in the app)
export type PhaseName = 'cross' | 'f2l1' | 'f2l2' | 'f2l3' | 'f2l4' | 'eoll' | 'ocll' | 'pll';
export interface PhaseRecord {
  name: PhaseName; slot?: EdgePos;                                 // slot: the F/B–R/L edge position of the pair (e.g. 'FR'), for f2l phases
  startMs: number; endMs: number; moves: number;                   // moves: face turns in the phase
  recognitionMs: number; executionMs: number;
  endMoveIndex: number;                                            // index into the input array of the move that completed the phase
}
export interface PhaseReport { crossFace: Face | null; phases: PhaseRecord[]; solvedAtMove: number | null; complete: boolean }
export function detectPhases(scrambled: Facelets, moves: readonly TimedMove[], opts?: { crossFace?: Face }): PhaseReport;
export function crossComplete(f: Facelets, face: Face): boolean;
export function f2lSlotsComplete(f: Facelets, crossFace: Face): EdgePos[];   // which of the four slots are done
export function eollComplete(f: Facelets, crossFace: Face): boolean;
export function ocllComplete(f: Facelets, crossFace: Face): boolean;
```

**Definitions** are in `docs/DATA-MODEL.md` §4; implement them literally with `pieces.ts`.
The cross face is the first face whose cross completes after the first move (faces whose
cross is complete in `scrambled` are excluded); `opts.crossFace` forces it. If a pair
completes on a different face that also has a complete cross before any pair completes on
the current cross face, switch `crossFace` and recompute from the start with the forced
face (record `crossFaceSwitched: true` in the report if this happens; add the field).

Timing: `startMs` of the cross is the first move's `ms`; each later phase starts at the
previous `endMs`. `recognitionMs = ms(first move of the phase) − startMs`, `executionMs =
endMs − ms(first move of the phase)`; for the cross, recognition is 0 by construction unless
`opts.solveStartMs` is given (then recognition = first move − solveStartMs; add the option).
A phase that is already satisfied when the previous ends (skip, e.g. OCLL solved by the EOLL
alg) gets `moves: 0`, zero durations, the same `endMoveIndex` as the previous phase.

**Validation against Cubeast** (the acceptance test): for every fixture, run `detectPhases`
with `ms` = the cube ms of `moves`, and compare each phase's `endMs − firstMoveMs` with
Cubeast's `cubeast_steps[i].cumulative_time`. Cubeast's step names map 1:1 (`Cross`, `F2L
Slot 1..4`, `EOLL`, `OCLL`, `PLL`). Report a table: per phase, the share of fixtures within
±1 ms, and list every mismatch with both values. Investigate the largest classes of
mismatch (candidates: Cubeast's `time` may be measured from a timer start slightly before
the first move; F2L pairs completing simultaneously; the last-layer AUF conventions) and
either match Cubeast or document why ours is right. Target: **≥ 95% of (fixture, phase)
pairs within ±1 ms**; below that, the PR explains what differs and the reviewer decides.

**Tests.** The validation above as a Vitest test with the threshold; unit tests of each
predicate on hand-built states (e.g. `crossComplete(applyMoves(SOLVED, ["U"]), 'D')` is true
and `crossComplete(applyMoves(SOLVED, ["D"]), 'D')` is false — the D cross's edges moved
relative to their side centres? Check: a `D` turn moves the D-edges' side stickers away from
their centres, so the cross is *not* complete; write the test accordingly).

**Acceptance.**
- [ ] Validation table in the PR; threshold met or the shortfall explained.
- [ ] Runs over all 300 fixtures in under 2 s.
- [ ] `docs/DATA-MODEL.md` §4 updated only if a definition had to change, with the reason.

**Outcome (2026-09-27, PR #7).** Merged with `docs/DATA-MODEL.md` §4 as the source of truth
where it differs from the contract above: there is no cross-face switch and no
`crossFaceSwitched` field (the first cross completed is kept, as Cubeast keeps it; the rule
above fired on one fixture and disagreed with the reference there); F2L pairs count only while
the cross is complete; `recognitionMs`/`executionMs` are split as Cubeast splits them (leading
last-layer turns are recognition); slots are named by their middle-layer edge (`FR`). Result on
the 300 fixtures: 2400/2400 boundaries and 2306/2400 recognition times within ±1 ms. Extra
exports: `PHASE_NAMES`, `DetectPhasesOptions` (`crossFace`, `solveStartMs`).

---

## T1.4 — `core`: attempt state machine, records, clock fit, statistics, schemas, store interface

**Goal.** Turn cube events into the events and records of `docs/DATA-MODEL.md`, deterministically
and testably, with no UI involved.

**Scope.** `packages/core/src/attempt.ts`, `session.ts`, `clock.ts`, `stats.ts`, `store.ts`,
`packages/core/schema/{session,attempt}.schema.json`, tests.

**Contracts.**

```ts
// attempt.ts
export type AttemptState = 'scrambling' | 'armed' | 'solving' | 'solved' | 'dnf';
export interface CubeMoveInput { m: Move; cubeMs: number; hostMs: number }
export interface AttemptOptions { session: string; index: number; scramble: string; scrambleShownMs: number; crossFace?: Face }
export class AttemptMachine {
  constructor(opts: AttemptOptions);
  readonly state: AttemptState;
  readonly scrambleProgress: ScrambleProgress;
  readonly facelets: Facelets;
  onMove(input: CubeMoveInput): AttemptState;      // drives scrambling → armed → solving → solved
  onPickup(hostMs: number): void;                   // optional gyro-derived pickup, only meaningful while armed
  onFacelets(reported: Facelets): { consistent: boolean };   // desync check; on mismatch the caller decides (resync = adopt reported)
  resync(reported: Facelets): void;
  markDnf(hostMs: number): void;
  toRecord(): AttemptRecord;                        // docs/DATA-MODEL.md §7, video: []
}
export interface AttemptRecord { /* exactly §7 */ }

// session.ts
export interface SessionRecord { /* exactly §6 */ }
export function createSession(input: { host: HostInfo; cube: CubeInfo; settings: SessionSettings; appVersion: string; commit: string; nowMs: number }): SessionRecord;
export function summarize(session: SessionRecord, attempts: readonly AttemptRecord[]): SessionRecord['summary'];

// clock.ts — host ≈ a·cube + b, updated online, robust to BLE packet bunching
export class CubeClockFit {
  addSample(cubeMs: number, hostMs: number, packetLast: boolean): void;   // only packetLast samples enter the regression
  toHost(cubeMs: number): number;
  readonly params: { a: number; b: number; residualP95Ms: number; samples: number };
}

// stats.ts
export function mean(ms: readonly number[]): number; export function best(ms: readonly number[]): number;
export function aoN(ms: readonly number[], n: 5 | 12 | 100): number | null;   // WCA trimmed average of the last n; null if fewer than n
export function phaseAverages(attempts: readonly AttemptRecord[]): Record<PhaseName, { meanMs: number; meanMoves: number }>;

// store.ts
export interface SessionStore {
  createSession(s: SessionRecord): Promise<void>;
  saveSession(s: SessionRecord): Promise<void>;
  saveAttempt(a: AttemptRecord): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  loadAttempts(sessionId: string): Promise<AttemptRecord[]>;
  deleteSession(sessionId: string): Promise<void>;
  exportSession(sessionId: string): Promise<{ session: SessionRecord; attempts: AttemptRecord[] }>;
}
export class MemorySessionStore implements SessionStore {}
```

Schemas: JSON Schema (draft 2020-12) for `session.json` and `attempt.json` matching the
document; a test validates records produced by the machine with `ajv` (dev dependency).

**Behaviour.** `onMove` while `scrambling` feeds the `ScrambleTracker`; when `done`, state
becomes `armed` and `events.scrambleDone` is set; the next move is `solveStart` and state
`solving`; every move updates facelets; when solved, `solveEnd`, phases via `detectPhases`
(host ms), `result` computed (`timeMs`, `inspectionMs` from `pickup ?? scrambleDone`,
`movesQtm`, `tps`, `replayOk` by re-simulating from `scrambledFacelets` with the solve moves,
`scrambleCorrected`, `scrambleExtraMoves` from the tracker). Moves are recorded with `phase`.

**Tests.** Replay every fixture: scramble moves with synthetic timings (100 ms apart), then
the solution moves with their cube ms as both `cubeMs` and `hostMs`; expect `solved`,
`replayOk`, eight phases, `movesQtm === s.quarter_turns` (check Cubeast's definition of
`quarter_turns` on the fixtures; adjust if it counts differently and document), and
`timeMs === last move ms − first move ms`. Plus: U2-as-two-U scramble; mis-scramble with
undo; DNF; `onFacelets` mismatch detection; clock fit with bunched packets (synthetic:
`hostMs = 1.0001·cubeMs + 5000 + noise`, packets of up to 7 moves sharing `hostMs`) recovers
`a` within 1e-4 and `b` within 5 ms; `aoN` matches WCA examples; schemas validate every
record from the fixture replay.

**Acceptance.**
- [ ] All tests pass; the fixture replay finishes in under 3 s.
- [ ] Records validate against the schemas; the schemas match `docs/DATA-MODEL.md` (any deviation is a documented fix to the document).
- [ ] `ajv` is the only dependency added (dev).

---

## T1.5 — `gan`: driver wrapper, support check, fake cube

**Goal.** One typed event stream for the app, whether the source is a real GAN cube over
Web Bluetooth or the fake cube replaying a fixture.

**Scope.** `packages/gan/src/{types,connection,support,fake}.ts`, tests; the driver
dependency decision (see notes); `docs/MANUAL-TESTS.md` T1.5 section already lists the
hardware checks.

**Contracts.**

```ts
export type CubeEvent =
  | { type: 'move'; m: Move; cubeMs: number; hostMs: number; serial?: number }
  | { type: 'facelets'; facelets: Facelets; hostMs: number }
  | { type: 'gyro'; q: [number, number, number, number]; hostMs: number }
  | { type: 'battery'; level: number }
  | { type: 'hardware'; model: string; hardware: string; firmware: string; gyro: boolean }
  | { type: 'disconnected'; reason?: string };
export interface CubeConnection {
  readonly events$: Observable<CubeEvent>;         // rxjs
  requestFacelets(): Promise<void>;
  requestBattery(): Promise<void>;
  disconnect(): Promise<void>;
  readonly kind: 'gan' | 'fake';
}
export type MacProvider = (device: { name?: string; id: string }, isFallback: boolean) => Promise<string | null>;
export function connectGanCube(opts: { macProvider: MacProvider }): Promise<CubeConnection>;
export interface BluetoothSupport { available: boolean; canReadMacAutomatically: boolean; hint: string; flagUrl?: string }
export function checkBluetoothSupport(nav: Navigator | undefined): BluetoothSupport;
export class FakeCube implements CubeConnection {
  constructor(opts: { start?: Facelets; speed?: number; now?: () => number });
  play(moves: readonly { m: Move; ms: number }[]): Promise<void>;   // emits move events on the fixture's schedule divided by speed; cubeMs continues across plays
  turn(m: Move): void;                                                 // one immediate move (manual driving in tests)
  readonly facelets: Facelets;                                         // simulated with @cubetrace/core
}
```

**Notes.**
- The driver: try `npm install github:shermam/gan-web-bluetooth` first; if the package
  needs a build the install does not run, vendor its `src/` under
  `packages/gan/vendor/gan-web-bluetooth/` with its MIT license file and a note of the
  commit hash. Record the choice in `docs/TOOLCHAIN.md`.
- Map the driver's `MOVE` (`move`, `cubeTimestamp`, `localTimestamp`), `FACELETS`
  (`facelets`, Kociemba string; assert it with `assertFacelets` and drop it with a console
  warning if it fails), `GYRO`, `BATTERY`, `HARDWARE`, `DISCONNECT` events. `hostMs` =
  `performance.timeOrigin + localTimestamp` (the driver's `localTimestamp` is
  `performance.now()`-based; verify in the source and note if not). Mark `packetLast` where
  the driver exposes packet boundaries; if it does not, treat a move whose `hostMs` differs
  from the next move's as `packetLast` (the caller can do this; document).
- Request `FACELETS` immediately after connecting (the Gen2 driver ignores moves until
  the first facelets event) and expose the first facelets as part of the connect promise.
- `checkBluetoothSupport`: `navigator.bluetooth` present; `getDevices`/`watchAdvertisements`
  present ⇒ `canReadMacAutomatically`; the hint names the Chrome flag the driver's README
  names (read it from the fork) with a `chrome://flags/#…` URL, and the manual-MAC path.
- The fake cube is the development and CI cube; it must be good: a `play()` that honours
  the fixture's inter-move gaps (with `speed` to accelerate), `turn()` for scripted
  scenarios, facelets that track the moves, and a deterministic `now`.

**Tests.** FakeCube replays a fixture with fake timers, events in order, `cubeMs` monotonic,
facelets end solved for a full scramble + solution; `checkBluetoothSupport(undefined)` gives
`available: false` with a hint; mapping of driver events to `CubeEvent` on hand-built
samples (no Bluetooth in tests).

**Acceptance.**
- [ ] Tests pass; the driver builds in the app bundle (a Playwright check that the connect dialog renders the support hint is enough; connecting needs hardware and is in `docs/MANUAL-TESTS.md`).
- [ ] The vendor or dependency choice is documented with the commit hash.

---

## T1.6a — `web`: cube connection, live cube panel, settings, demo mode

**Goal.** The app talks to a cube, real or fake, before the timer exists: connect, see the
cube's state and moves live, and store the settings the timer will need. Split from T1.6 on
2026-09-27 so that the owner can run the T1.5 manual tests on the real cubes while T1.4 is built.

**Scope.** `apps/web/src/app/cube/{cube-service,demo,…}.ts`, `apps/web/src/app/connect/…`,
`apps/web/src/app/settings/…` (extended), a live cube panel on the timer page, the status pill
in the header, `apps/web/e2e/cube.spec.ts`, the wording of `docs/MANUAL-TESTS.md` T1.5, a
CHANGELOG line.

**Behaviour.**
- **`CubeService`** (Angular, signals, `providedIn: 'root'`): owns at most one `CubeConnection`
  from `@cubetrace/gan`. `connect()` calls `connectGanCube` with a `MacProvider` that answers
  from the stored MACs (by device name) first and, on the fallback call, asks the user through
  the dialog; `connectDemo(solve, speed)` uses a `FakeCube`; `disconnect()`. Signals: `status`
  (`'disconnected' | 'connecting' | 'connected'`), `kind`, `hardware`, `battery`, `facelets`
  (updated on every move and facelets event), `solved` (computed with `isSolved`), `moves` (the
  last 200 `CubeMoveEvent`s), `lastError`. It exposes the current connection's `events$` (an
  Observable that follows the connection) for T1.6b's `SessionService`. On a `disconnected`
  event the status goes back to `'disconnected'` with the reason; no automatic reconnection (Web
  Bluetooth needs a user gesture): a "Reconnect" action instead.
- **Connect dialog** (a native `<dialog>`, opened from the status pill and from the timer page):
  the result of `checkBluetoothSupport` (its `hint`; when `flagUrl` is set, the flag's name, a
  copy button, since `chrome://` URLs cannot be links, and the three steps: paste it in the
  address bar, set Enabled, relaunch); "Connect cube" (disabled when `available` is false) and
  "Demo cube" (a random demo solve at speed 1, or the URL's `?demo=<index>&speed=<n>`); the MAC
  prompt when the driver asks (device name shown, input validated with `normalizeMac`, a
  "remember for this cube" switch that stores it in Settings); while connecting, a spinner;
  connected: model, hardware, firmware, battery, gyro, and "Disconnect"; errors in plain words
  (the first-facelets timeout → "The cube did not send its state: is it on and nearby?"; a MAC
  error names the address).
- **Status pill** in the header (`app.html`, next to the wake-lock status): "No cube" /
  "Connecting…" / "<model> · <battery>%" with a dot; clicking it opens the dialog.
- **Live cube panel** on the timer page (in the "solves" region for now; T1.6b moves it into a
  collapsible "Cube" section): a 2D net of the 54 facelets in the six colours (U white, R red,
  F green, D yellow, L orange, B blue) updated live; "Solved" / "Not solved"; the move log: the
  last 20 moves, newest first, each with the move, its `cubeMs`, the gap to the previous move
  in ms and a marker on `packetLast`. The manual tests of `docs/MANUAL-TESTS.md` T1.5 read
  this log.
- **Demo mode** (`demo.ts`): `?demo=<index>&speed=<n>` on the timer route connects a `FakeCube`
  on load and replays demo solve `<index>`: its scramble moves 100 ms apart, then its solution
  moves with their cube timings, both divided by `speed` (the fake cube's `speed` option).
  `DemoSolve = { index, scramble, scrambledFacelets, moves }` is exposed for T1.6b, which sets
  the attempt's scramble from it. The demo solves are a slim copy of `fixtures/solves.json`:
  the first 30 solves, only `scramble`, `scrambled_facelets`, `moves` and `time_ms`, under
  100 kB, written by a script wired like `apps/web/scripts/write-version.mts`, loaded only when
  a demo starts (a lazy chunk or a fetch from `public/`), never in the initial bundle and not
  prefetched by the service worker.
- **Settings** (`SettingsService`: signals plus `localStorage` through `BROWSER_GLOBALS`, so the
  tests use `fake-browser.ts`): host label (default a short name from the platform, such as
  "macOS laptop" or "Android phone"; editable), cube MACs by device name (add, edit, remove;
  validated), demo speed (default 1), inspection 15 s (off), auto-advance (on). The Settings
  page shows them under the T1.7 sections (screen, storage), which stay. T1.6b reads
  `SettingsService`.

**Tests.** Unit: `CubeService` with a `FakeCube` (connect → hardware, battery, facelets; moves
logged in order; disconnect → status and reason), the MAC provider (a stored MAC wins; the
fallback asks), `SettingsService` round trip with the fake browser, `demo.ts` (query parsing,
defaults, bad values), the dialog's states. Playwright (`cube.spec.ts`): (1) `/?demo=0&speed=20`:
the pill shows "Fake cube · 100%", the log fills with moves in cube order with increasing
`cubeMs`, and at the end the panel says Solved; (2) without `?demo`: the dialog opens, "Connect
cube" is disabled with the support hint (headless Chromium has no Web Bluetooth), "Demo cube"
connects; (3) Settings: a MAC entered survives a reload, an invalid one is refused.

**Acceptance.**
- [ ] `/?demo=0&speed=20` on the Pages deploy shows a live net and a move log without a cube.
- [ ] `docs/MANUAL-TESTS.md` T1.5 can be run with this build (the coordinator asks the owner after the merge).
- [ ] No business logic in components: cube state comes from `@cubetrace/core` and `@cubetrace/gan`.
- [ ] The initial bundle grows only by the pill and the dialog; the demo data loads only in demo mode.

---

## T1.6b — `web`: the timer

**Goal.** The Cubeast feel: scramble at the top with its picture, a big timer, the solve list,
the CFOP breakdown chart, driven by the cube (real or fake) through T1.6a's `CubeService`,
persisting every attempt.

**Scope.** `apps/web/src/app/{timer,sessions,shared}/…`, a `SessionService` (Angular, signals)
wrapping `AttemptMachine` and consuming `CubeService.events$`, `packages/storage` with
`OpfsSessionStore` (browser only) implementing `SessionStore`, one Playwright flow.

**Behaviour.**
- **Timer page**: scramble text (large, monospace) and `<twisty-player>` (2D or 3D, small,
  `experimental-setup-alg` = scramble, no controls); the status pill's state (connected /
  battery / attempt state); scramble progress `k / n` with the undo guidance list when diverged
  (inverse moves greyed out as done); the timer display `m:ss.cc` (10 ms resolution) running
  from `solveStart` to `solveEnd`; optional inspection counter (15 s WCA style; setting) from
  `armed` or `pickup`; on solved: the time, the phase chart, auto-advance to the next
  scramble (pre-generated during the solve so it appears instantly); buttons: Skip
  scramble, DNF, Delete last, New session. Keyboard: `Esc` DNF, `Delete` delete last, `N`
  skip. T1.6a's live cube panel becomes a collapsible "Cube" section. If the cube is not
  solved when a scramble is due, the page says "Solve the cube first" and the attempt starts
  when it is (the machine is constructed from a solved cube).
- **Demo mode**: with `?demo=<index>`, the attempt's scramble is the demo solve's scramble
  (T1.6a's `DemoSolve`), so the replay arms and solves it.
- **Breakdown chart**: hand-written SVG stacked horizontal bar, eight segments in fixed
  colours with a legend; last solve and session average; hover/tap shows ms and moves.
- **Solve list**: index, time, the eight phase times as a mini bar, flags (DNF, corrected);
  session stats: count, mean, best, ao5, ao12.
- **Sessions page**: sessions from the store (date, host, attempts, mean); export one
  session as a single JSON file (`{session, attempts}`); delete.
- **Persistence**: `OpfsSessionStore` writes `sessions/<id>/session.json` and
  `attempts/<index>/attempt.json` as in `docs/DATA-MODEL.md` §5; the current session id in
  `localStorage`; reload resumes the session (attempts listed, next index correct). The wake
  lock is requested while a session is active.
- **Clock**: `hostMs` from `performance.timeOrigin + performance.now()`; cube fit via
  `CubeClockFit`, its params saved into `session.json` on every attempt.

**Tests.** Angular unit tests for `SessionService` with `MemorySessionStore` and the fake
cube (one full attempt); one Playwright flow (`?demo=0&speed=20`): the attempt reaches
solved, the displayed time is within 5% of the fixture's duration / 20, eight phases are
shown, the session appears on the Sessions page after reload, export downloads a JSON that
parses. (The full suite is T1.9.)

**Acceptance.**
- [ ] The flow above passes in CI.
- [ ] Visual check by the reviewer on the Pages deploy: it looks like a timer app, not a form.
- [ ] `docs/MANUAL-TESTS.md` T1.6 section is accurate for what was built.
- [ ] No business logic in components: state transitions come from `@cubetrace/core`.

---

## T1.7 — `web`: PWA and device basics

**Goal.** Installable, stays awake, keeps its storage, fits a phone.

**Scope.** `@angular/pwa` (manifest, `ngsw-config.json` caching the app shell and cubing.js's
worker files), `WakeLockService` (request on session start; re-request on
`visibilitychange`; status in the UI), `navigator.storage.persist()` at first session with
the result shown in Settings, responsive layout (phone portrait: scramble, timer, chart
stacked; laptop: two columns), a version string (package version + short commit SHA injected
at build) in the footer, a banner when required APIs are missing (not Chrome).

**Tests.** Lighthouse-style checks are not required; a Playwright test that the manifest
and service worker are served on the built app, and that the layout has no horizontal
overflow at 390×844 and at 1280×800.

**Acceptance.**
- [ ] Installable on Chrome for Android (manual, `docs/MANUAL-TESTS.md` T1.7); manifest `orientation: "any"`.
- [ ] Wake lock requested and visible; storage persistence requested and visible.
- [ ] Both viewport tests pass.

---

## T1.8 — `web`: device probe page

**Goal.** A page the owner opens on each device to learn what the browser can do with its
cameras, encoders, storage and Bluetooth, producing a JSON report for `docs/DEVICES.md`.

**Scope.** `/probe` route; no recording, no dependencies.

**Behaviour.** After camera permission: list `enumerateDevices()` video inputs; for the
selected device open it at 1920×1080 with `frameRate: {ideal: 60}` and show
`getSettings()`, `getCapabilities()` (every key, raw), then measure 10 s of
`requestVideoFrameCallback`: achieved fps, interval p50/p95/max, and the distribution of
`captureTime − performance.now()` and of `mediaTime` deltas; `VideoEncoder.isConfigSupported`
for `avc1.640028` at 1920×1080 at 30 and 60 fps with `prefer-hardware` and
`no-preference`, and for `avc1.4d0028`; `MediaStreamTrackProcessor` and `VideoEncoder`
presence in a worker; `navigator.storage.estimate()` and `persisted()`; `navigator.bluetooth`
and `getDevices`/`watchAdvertisements` presence; user-agent client hints (`platform`,
`model`, `architecture`, `bitness`). A "Copy report" button copies JSON; a "Download"
button saves `probe-<label>-<date>.json`. Every step guarded: a missing API is a row in the
report, not an exception.

**Tests.** A Playwright test with Chrome's fake camera (`--use-fake-device-for-media-stream`,
`--use-fake-ui-for-media-stream`) that the page produces a report with the expected keys.

**Acceptance.**
- [ ] Runs on the desktop fake camera in CI; the report has the sections above.
- [ ] Nothing crashes on a browser without the APIs (a Firefox-like `navigator` in a unit test).

---

## T1.9 — end-to-end suite and export validation

**Goal.** The flows a user does, automated with the fake cube, so every later PR is checked
against them.

**Scope.** `apps/web/e2e/*.spec.ts`; the JSON Schemas from T1.4 used with `ajv` in a test
that validates an exported session.

**Flows.** (1) Full attempt with `?demo=<i>&speed=20` for three fixtures: solved, time within
tolerance, eight phases, the cross face equals the fixture's (compute it with core in the
test). (2) Mis-scramble: a demo mode option that injects one wrong move at scramble move 5:
the undo guidance appears with the inverse, then clears; the attempt arms; the export has
`scrambleCorrected: true` and `scrambleExtraMoves: 2`. (3) DNF via `Esc`, then a new
attempt. (4) Reload mid-session: the session resumes with the right next index. (5) Export
validates against both schemas. (6) Settings: toggling inspection shows the inspection
counter on the next attempt.

**Acceptance.**
- [ ] All flows pass in CI in under 3 minutes.
- [ ] Flaky tests are fixed, not retried into passing.

---

## T1.10 — docs, changelog, `v0.1.0`, manual test round

**Goal.** A first release the owner can use daily.

**Scope.** README (screenshots from the Pages deploy, how to connect, the flag, demo mode),
`docs/CHANGELOG.md` `0.1.0`, statuses in this file, a `v0.1.0` tag by the coordinator after
the owner's manual round, and issues for whatever the round finds.

**Acceptance.**
- [ ] The owner completes `docs/MANUAL-TESTS.md` T1.5–T1.7 on a laptop and on the ThinkPhone, both cubes, and the results are recorded in that file.
- [ ] Every failure is an issue with the device, browser version and steps; blockers are fixed before the tag.

---

## Phase 2 onwards

Task lists for phases 2–5 will be written the same way when phase 1 is done; their scope
is in `docs/ARCHITECTURE.md` and the private design. Two decisions already taken that later
phases must respect: the bucket provider is a configuration (both R2 and GCS are supported
through the same signed-URL function), and audio is recorded by default.
