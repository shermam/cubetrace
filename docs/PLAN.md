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
| **1. The timer, on any device** | cube connection, scrambles, state tracking, mis-scramble guidance, timer, colour-neutral CFOP breakdown validated against the Cubeast fixtures, session records staged in OPFS, PWA, probe page, fake cube, e2e suite, GitHub Pages deploy. Replaces Cubeast for daily practice. | ✅ v0.1.0 (2026-09-27) |
| **2. The host's own camera** | WebCodecs pipeline, ring buffer, two-segment cuts with audio, MP4 via mediabunny, `frames.json`, sharpness meter, clapperboard. Solo mode and laptop-only rigs produce paired data. | ✅ 0.2.0 (2026-10-01: the fixes from the owner's first recordings, T2.8–T2.13, merged; the full round 2 skipped by the owner's decision; the tag from the GitHub UI pending) |
| 3. Cloud | Firebase auth, session index, upload queue with signed URLs (R2 or GCS by configuration), budget alert, QA view across devices. | ✅ 0.3.0 (2026-10-02: T3.0–T3.6 merged and deployed; the tag from the GitHub UI on 2896591 or later). Follow-ups on the board: T3.7 (the cube's whole record) and T3.8 (the 3D cube in the clip viewer), for 0.4.0 |
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
| T1.14 | `gan`+`web`: Mark as solved (cube reset), idle auto-disconnect, disconnect diagnostics, driver preload | T1.12 | ✅ #18 |

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

## Phase 2 task board — the host's own camera

Same rules as phase 1: one task per PR, branch `task/<id>-<slug>`, the coordinator reviews and
squash-merges, statuses in this table. The measurements behind the choices are in
`docs/DEVICES.md` (both default cameras deliver 30 fps; sensor timestamps are steady while the
callback jitters ±10 ms; `MediaStreamTrackProcessor` is main-thread only; hardware H.264 at
1080p60 on both devices; about 10 GB of local quota) and in the private design (§6 time, §7 the
pipeline, §9 the data model).

| Id | Task | Depends on | Status |
|---|---|---|---|
| T2.0 | `core`: schema 2 (per-attempt clock fit, video and camera entries, `frames.json`), readers for schemas 1 and 2 | — | ✅ #24 |
| T2.1 | `capture`+`web`: camera panel: choose, open, preview, controls, sharpness meter, framing rectangle | — | ✅ #25 |
| T2.2 | `capture`: encoder pipeline in a worker, ring buffer, cuts | — | ✅ #26 |
| T2.3 | `capture`: MP4 muxing (mediabunny) and OPFS clip writing | T2.2 | ✅ #27 |
| T2.4 | `web`: recording in the timer: two clips per attempt, storage meter, clip viewer, downloads | T2.0, T2.1, T2.3 | ✅ #28 |
| T2.5 | `capture`+`web`: clapperboard and per-camera sync residual | T2.4 | ✅ #29 |
| T2.6 | e2e for recording, docs, `v0.2.0`, manual round 2 | T2.5 | ✅ #31 (tag `v0.2.0` after the owner's round 2) |
| T2.7 | `web`: timer layout with the camera always in view, the last 12 solves on the timer, a session history page | T2.4 | ✅ #30 |
| T2.8 | `capture`+`web`: sync check that works on real cameras: event-locked motion detection, changed-area metric, diagnostics download | T2.5 | ✅ #35 |
| T2.9 | `capture`+`core`+`web`: clips clipped, never refused, for a start older than the buffer; the scramble clip's 60 s window; the clock fit restarts with the cube; audio never silently absent | T2.5 | ✅ #37 |
| T2.10 | `capture`+`web`: video quality setting, 4 Mbps by default | T2.4 | ✅ #36 |
| T2.11 | `capture`+`web`: the sync check measures the middle of each turn's motion, with a trimmed spread | T2.8 | ✅ #39 |
| T2.12 | `web`+`core`: the microphone recorded raw, the processing applied kept in the record | T2.9 | ✅ #43 |
| T2.13 | `web`: on a phone, the picture and the scramble in view together: the scramble over the pinned picture | T2.7 | ✅ #41 |
| T2.14 | `capture`+`web`+`core`: camera labels unique per device within a session | T2.1 | ✅ #48 |

Waves: {T2.0, T2.1, T2.2} → T2.3 → T2.4 → {T2.5, T2.7} → T2.6 → {T2.8, T2.9, T2.10} (from the owner's
first recordings, issues #33 and #34; all merged on 2026-09-27). Rules for every phase 2 task: nothing of
the capture code in the initial bundle (lazy chunks; check `ng build`); the worker code is plain
TypeScript in `packages/capture` (no Angular), tested in Node where it is pure and in Playwright
with Chrome's fake camera (`--use-fake-device-for-media-stream`, see `apps/web/e2e/probe.spec.ts`)
where it needs a browser; every new dependency named and justified in the PR (mediabunny is the
one expected); no personal data in fixtures.

Follow-ups found with the owner's first recordings, not scheduled (candidates for tasks after
round 2): (a) the worker's clock against the page's after the machine sleeps: each context has its
own `timeOrigin` and the monotonic clock stops in sleep, so the frame and clip times of a worker
created after a sleep could be off by the sleep, which the sync check's frame-clock self-check
(T2.8) would report as "the frame clock is wrong"; the fix measures the worker–page offset and
corrects frame and clip times; (b) ~~sub-frame onsets in the sync check: the spread is quantized to
frames on top of the cube's Bluetooth jitter (T2.8)~~, moot since T2.11, whose event, the centroid of
a turn's motion, falls between frames; (c) a quality, audio or microphone (T2.12) change
mid-attempt restarts the pipeline and empties the buffer, so that attempt's clips begin late (flagged
`truncatedStart` since T2.9): a guard could defer the restart to the end of the attempt;
(d) crop-at-source (the design's later phase), the biggest lever left on clip size after T2.10;
(e) ~~camera labels unique per device within a session: `cameraLabel` derives `laptop`, `phone-front`
and `phone-rear` from the host and the facing, so two cameras of a laptop (the FaceTime camera and a
USB webcam, issue #40) share `laptop`, `putCamera` replaces the entry and `putCameraClock` the sync
result, and earlier clips then point at the wrong device; a second device under a label should get
`laptop-2`, or the clip should name the device~~, done by T2.14: a second device under a label gets
`laptop-2`.

### T2.0 — `core`: schema 2, per-attempt clock fit, readers for schemas 1 and 2

**Goal.** The records phase 2 writes, defined before anything writes them, and the clock fit
where the data showed it belongs: per attempt (`docs/DEVICES.md`: the cube's clock runs 0.7% slow
within attempts, both clocks advance equally across pauses, one fit per session drifts by 0.7% of
each pause).

**Scope.** `packages/core/src/{attempt,session,clock,schemas,records}.ts`,
`packages/core/schema/{session,attempt}.schema.json` (now version 2) plus the version 1 files kept
as `*.v1.schema.json`, `docs/DATA-MODEL.md` (schema 2: the changes below, a `frames.json` section,
a "reading older records" paragraph), tests.

**Contracts.**
- `attempt.json` version 2 adds `clock: {a, b, residualP95Ms, samples} | null`: the least-squares
  fit of `hostMs` on `cubeMs` over the attempt's own `packetLast` moves, from its first move to
  `solveEnd` (or the DNF); `null` with fewer than 2 samples. `CubeMoveInput` gains
  `packetLast?: boolean` (default true); `AttemptMachine` keeps one `CubeClockFit` per attempt and
  `toRecord()` fills `clock`.
- `attempt.json.video[]` entries are validated (they were declared empty in version 1):
  `{camera, segment: 'scramble' | 'solve', file, bytes, codec, audio: string | null, width, height,
  crop: {x, y, w, h} | null, fpsNominal, frames, firstFrameHostMs, framesFile, syncResidualMs:
  number | null}`.
- `session.json` version 2: `cameras[]` entries validated: `{label, local: true, facing: 'user' |
  'environment' | 'unknown', deviceLabel, settings, capabilities, constraints, crop, mode: 'full' |
  'crop'}` (`settings`/`capabilities`/`constraints` are the snapshots as JSON, unknown keys
  allowed); `clock.cameras[label] = {offsetMs, rttMs, driftPpm, clapperboardResidualMs,
  clapperboardSamples, samples?: [{moveHostMs, onsetHostMs}]}`; `clock.cube` stays, documented as a
  coarse per-connection summary.
- `frames.json` (per clip): `{schema: 2, camera, segment, t0HostMs, dtMs: number[] (per frame,
  first 0, 0.1 ms resolution, from the frames' own timestamps), keyframes: number[] (indices),
  arrival: {offsetMs, residualP95Ms}}` — see T2.2 for how `t0HostMs` is derived.
- `records.ts`: `parseAttempt(json: unknown): AttemptRecord` and `parseSession(json)` accept
  versions 1 and 2 and return version 2 objects (`clock: null`, `video: []`, `cameras: []` where
  missing); the schemas validate each version by its `schema` field; `SESSION_SCHEMA`/
  `ATTEMPT_SCHEMA` are version 2, `*_V1` exported too. The app (SessionService, the stores) reads
  through `parseAttempt`/`parseSession` and writes version 2.

**Tests.** Fixture replays (all `packetLast`, cube ms as both clocks) give `a ≈ 1`, `b ≈ 0`,
residual 0. **Real-hardware regression:** every attempt of `fixtures/hardware/*.json`, replayed
through the machine with its own `hostMs`/`cubeMs`, gives `clock.a` within 1.0069–1.0072 and
`residualP95Ms` under 20 ms (the numbers in `docs/DEVICES.md`). Version 1 exports in
`fixtures/hardware/` parse, upgrade and validate as version 2; a version 2 record validates;
version 1 records still validate against the v1 schemas.

**Acceptance.**
- [ ] DATA-MODEL says "schema 2" with every change above and a CHANGELOG entry; no stored file is rewritten.
- [ ] The hardware regression test passes on both exports.
- [ ] T1.9's export validation still passes (it validates whatever version the app writes).

### T2.1 — `capture`+`web`: camera panel

**Goal.** A camera the solver can see, judge and adjust before recording: the right device,
1080p, the real frame rate, manual exposure where it exists, a sharpness number, and the
framing rectangle the model will be trained on.

**Scope.** `packages/capture/src/{camera,sharpness,framing}.ts` (plain TS: constraint building
from a chosen `{deviceId, width, height, fps}` and the exposure/focus options, capability and
settings snapshots as JSON, the sharpness metric on a `VideoFrame`/`ImageData`), `apps/web/src/app/camera/*`
(`CameraService` with signals: devices, selected, `MediaStream`, settings, capabilities,
sharpness, framing; a `CameraPanel` on the Timer page below the Cube section), Settings (camera
choices persist per device label).

**Behaviour.** Enumerate cameras after a permission prompt; front/rear labels on phones;
open the chosen one at `{width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 60}}`
then read `getSettings()` and show the real values; a preview `<video>` (mirrored on screen for
a front camera, never in the data); controls shown only when the capability exists: exposure
mode auto/manual with exposure time and ISO, focus mode auto/manual with distance, white
balance, zoom (`applyConstraints` with `advanced`), and "Reset to auto"; the sharpness meter:
variance of the Laplacian of the luma of a 320-px-wide downscale of the framing rectangle,
every 10th frame through `requestVideoFrameCallback`, shown as a number and a bar with a
"good / soft" threshold calibrated on the fake camera and adjustable; the framing rectangle
drawn on the preview and dragged/resized (default: full frame; stored per camera label in
Settings; `mode` stays `'full'` in phase 2: the rectangle is metadata for training, not a
crop at the source); Camera on/off; permission and device errors in plain words; the session's
`cameras[]` entry built from all of this (label `laptop` or `phone` from the host label plus
`-front`/`-rear` when known) for T2.4 to store.

**Tests.** Unit: constraint building, capability parsing, the sharpness metric on synthetic
images (flat = 0, edges high), framing maths. Playwright with the fake camera: the panel lists
it, opens it, shows settings, the meter updates, the rectangle persists across a reload.

**Acceptance.**
- [ ] On the fake camera in CI the panel works end to end; on the real devices the owner checks in round 2 that manual exposure appears on the ThinkPhone and not on the MacBook (`docs/DEVICES.md`).
- [ ] Nothing of it in the initial bundle.

### T2.2 — `capture`: encoder pipeline, ring buffer, cuts

**Goal.** Continuous encoding of the camera into memory, from which any interval of the last
90 s can be cut without re-encoding.

**Scope.** `packages/capture/src/{pipeline,protocol,ring-buffer,cut,capture-worker}.ts`, tests.

**Contracts.**
- Main thread: `startCapture(stream: MediaStream, config: CaptureConfig) → CaptureHandle` creates
  `MediaStreamTrackProcessor`s for the video track and the audio track (audio optional), transfers
  their `readable` streams to a module `Worker` (`capture-worker.ts`, its own lazy chunk), and
  exposes `cut(startHostMs, endHostMs): Promise<Cut>`, `stats: signal-free observable of
  {fps, encodedFps, dropped, queue, bufferSeconds, bufferBytes}` (a callback or an
  `EventTarget`), `stop()`. A typed message protocol between window and worker (`protocol.ts`).
- Worker: `VideoEncoder` configured from the track settings: codec `avc1.640028` (High 4.0), else
  `avc1.4d0028` (Main), each tried with `hardwareAcceleration: 'prefer-hardware'` then
  `'no-preference'` through `isConfigSupported`; if no H.264 encoder exists (Chromium in CI has
  none), `vp09.00.40.08` (VP9) so that the pipeline and the tests still run, with the codec recorded
  in the clip; `avc: {format: 'avc'}`; bitrate 8 Mbps at 1080p30 and 12 at 60; `latencyMode:
  'quality'`; a keyframe forced every 1 s (`encode(frame, {keyFrame: true})`); `AudioEncoder` AAC-LC
  `mp4a.40.2` 128 kbps at the track's sample rate, else Opus, else no audio, recorded. Backpressure:
  when `encodeQueueSize` exceeds 8, frames are dropped and counted, never queued without bound.
- **Frame times.** For each `VideoFrame` the worker records `timestamp` (µs, the frame's own
  clock, exact for intervals) and the arrival `hostMs = performance.timeOrigin + performance.now()`
  in the worker (Unix-epoch based, so the same scale as the window's `hostMs`). Per clip, the
  arrival-on-timestamp fit (median offset, residual p95) gives `t0HostMs` for the first frame
  without the ±10 ms callback jitter; `dtMs` comes from `timestamp` deltas. Measure and write in
  `docs/DEVICES.md` what `timestamp` is on the fake camera (from 0 at the first frame? capture time?)
  and leave a note for the owner's round on the real devices.
- **Ring buffer.** Encoded chunks with their metadata (`type`, `timestamp`, `byteLength`, arrival
  hostMs, keyframe flag) in memory, bounded by both 90 s and 160 MB; eviction by whole GOPs so the
  buffer always starts at a keyframe; audio chunks likewise, evicted to the same horizon.
- **Cut.** `cut(start, end)` returns the chunks from the last keyframe at or before `start` to the
  last frame at or before `end`, the audio chunks overlapping that span, and the frames'
  metadata; ArrayBuffers transferred, never copied twice; a cut whose start is older than the
  buffer returns what exists and says `truncatedStart: true`.

**Tests.** Vitest on the ring buffer and the cut (synthetic chunks: keyframe rules, eviction by
GOP, truncation, audio overlap, memory bound). Playwright with the fake camera: the pipeline
starts, `stats` show ~30 fps encoded, a cut of the last 3 s returns chunks beginning with a
keyframe, the codec chosen is reported; measure and print the encoded bitrate.

**Acceptance.**
- [ ] 10 s of the fake camera at 1080p30 encode with 0 drops in CI, and the cut returns within 50 ms.
- [ ] The worker chunk is lazy; the main bundle is unchanged.

### T2.3 — `capture`: MP4 muxing and OPFS clip writing

**Goal.** A cut becomes a file any tool can play, plus its `frames.json`, in the attempt's folder.

**Scope.** `packages/capture/src/{mux,clip-writer}.ts` (run in the worker), `fixtures/media/`
(a tiny encoded sample for the Node tests, generated once from the fake camera and committed,
under 300 kB), tests; dependency **mediabunny** (1.60.0 at the time of writing; MPL-2.0),
justified in the PR and in `docs/TOOLCHAIN.md`.

**Contracts.** `muxClip(cut, meta): Promise<{mp4: ArrayBuffer, frames: FramesJson}>` with
mediabunny: `Output` + `Mp4OutputFormat({fastStart: 'in-memory'})` + `BufferTarget`; the video
packets through `EncodedPacket.fromEncodedChunk`, the audio packets likewise, no re-encoding;
timestamps rebased so the clip starts at 0. `writeClip(root, sessionId, index, camera, segment,
mp4, frames): Promise<VideoClip>` writes `<camera>.<segment>.mp4` and `<camera>.<segment>.frames.json`
into `sessions/<id>/attempts/<index>/` with `FileSystemSyncAccessHandle` in the worker, under a
temporary name moved into place (as T1.11 does), and returns the `video[]` entry (T2.0's shape)
with `bytes`, `codec`, `audio`, `width`, `height`, `frames`, `firstFrameHostMs`, `framesFile`.

**Tests.** Node: muxing the committed sample gives an MP4 whose `ftyp`/`moov` parse (mediabunny
can read it back: track count, duration, codec); a synthetic cut with a truncated start is
rejected with a clear error. Playwright: a clip from the fake camera plays in a `<video>`
(`loadedmetadata`, duration within 10% of the cut length).

**Acceptance.**
- [ ] The clip plays in Chrome and its duration and frame count match `frames.json`.
- [ ] mediabunny is in the worker chunk only.

### T2.4 — `web`: recording in the timer

**Goal.** The first paired data: every attempt gets its two clips, automatically.

**Scope.** `apps/web/src/app/camera/*` (recording state), `session/session-service.ts` (the cut
hooks), `timer/*` (clip badges on the solve list, a clip viewer), `sessions/*` (bytes per session,
download), Settings (Camera on/off, Keep clips), `docs/DATA-MODEL.md` if anything needed
clarifying, `docs/MANUAL-TESTS.md` T2 section started.

**Behaviour.** With the camera on and a session active, the pipeline runs; on `scrambleDone`
the scramble segment `[scrambleStart − 2 s, scrambleDone + 1 s]` is cut (one second after the
event, so the margin exists), muxed and written; on `solveEnd` or DNF the solve segment
`[solveStart − 3 s, end + 1 s]`; the attempt's record is saved again with `video[]` filled
(upsert). Failures never touch the attempt's timing data: a clip that fails is logged in the
session's `notes` and shown once. Storage: a meter in the Camera panel and on the Sessions page
(usage/quota from `navigator.storage.estimate()`); warn at 80%, stop recording (not timing) at
95%. The solve list shows a clip badge per attempt; the viewer plays a clip from OPFS (object URL)
with the attempt's moves listed by time next to it; "Download" gives the two MP4s and the
`attempt.json`. Demo mode with the fake camera works end to end (that is what CI runs).

**Tests.** Unit with a fake pipeline (the cut intervals, the upsert, the failure path, the
storage thresholds). Playwright, fake camera + `?demo=0&speed=20`: after one solve, both clips
exist in OPFS, `video[]` has two valid entries, the viewer plays the solve clip, the export
validates against schema 2.

**Acceptance.**
- [ ] The e2e flow passes in CI under 4 minutes total for the suite.
- [ ] Recording never delays the timer: the solve's `timeMs` in the record is unchanged by the camera (compare with the camera off in the same e2e).

### T2.5 — `capture`+`web`: clapperboard and per-camera sync residual

**Goal.** Know, per session and camera, how far the video lags the cube, so that the training
pipeline can subtract it.

**Scope.** `packages/capture/src/{motion,clapperboard}.ts` (worker-side motion energy per frame
inside the framing rectangle: mean absolute luma difference on a 160-px downscale; onset
detection against a quiet baseline), `apps/web/src/app/camera/*` ("Sync check" at session start
when a camera is on, and on demand), `session.json.clock.cameras[label]` (T2.0's shape),
`attempt.json.video[].syncResidualMs` from then on.

**Behaviour.** The app asks the solver to turn one face, pause, turn it back, five times over
(ten single turns, the cube ends solved; attempt tracking is suspended meanwhile, so the turns
never enter a record) and watches 20 s, or until all ten turns are matched; onsets = frames where the energy rises above 4× the baseline's median
after at least 500 ms of quiet; each onset is matched to the nearest cube move within 500 ms;
offset = median of (onsetHostMs − moveHostMs), spread = p95 − p5; fewer than 4 matches or a
spread over 40 ms (a frame at 30 fps; since T2.8 the onsets are found around each turn on the changed
area of the picture and the limit is 50 ms plus a frame interval) → "Sync check failed: …" with the reason and a Retry; the
result is written to `clock.cameras[label]` with the five pairs, and shown as "camera lags the
cube by X ms (±Y)". Later clips carry `syncResidualMs = offsetMs`.

**Tests.** Unit on synthetic energy series (clean onsets, noise, missing turn, extra motion).
Playwright: the flow with the fake camera and the demo cube reaches a result or the graceful
failure (the fake camera has no onsets; the test asserts the failure text and the Retry).

**Acceptance.**
- [ ] On the owner's devices in round 2 the spread is under the limit (50 ms plus a frame interval since T2.8: 83 ms at 30 fps) and the offset is stable across two checks (recorded in `docs/DEVICES.md`).

### T2.7 — `web`: timer layout, last 12 solves, session history page

**Goal.** Two things the owner saw on the desktop the day the camera panel landed: the solve
list grows without bound and pushes the camera preview below the fold, so the scramble and the
live picture (which is how you know the cube is in frame) are not visible together.

**Scope.** `apps/web/src/app/timer/*` (layout and the solve list), `apps/web/src/app/camera/*`
(the preview split from the controls), `apps/web/src/app/sessions/*` (a session page), routes,
e2e layout checks, `docs/MANUAL-TESTS.md`.

**Behaviour.**
- **Layout.** Wide screens (from 60rem): left column scramble (text, picture, progress, undo)
  then the clock with the **camera preview beside it** (a fixed box of about 16:9 at ~240 px high,
  the preview only: mirrored for a front camera, the framing rectangle drawn on it, the sharpness
  number and the recording status in one line); right column the breakdown, the session stats
  and the **last 12 solves**. The camera's controls (device, resolution, exposure, focus, torch,
  framing editing) move under a "Camera settings" disclosure that is closed by default; the live
  cube net and move log stay in their collapsible Cube section. On a phone (portrait): scramble,
  clock, the preview (same box, full width), breakdown, last solves. No horizontal overflow at
  320 px; nothing under the fold that the solver needs during a solve.
- **Last 12 solves** on the timer, newest first, each with time, phases mini-bar, flags and clip
  badge; a footer line "N solves in this session · See all" linking to the session page.
- **Session page** `/sessions/<id>`: the session's header (date, device, cube, camera, counts, mean,
  best, ao5/ao12/ao100), the full attempt list (all of T2.4's per-attempt actions: viewer,
  download), export and delete; reachable from the Sessions list (each row links to it) and from
  "See all". The current session's page updates live.

**Tests.** Unit for the list slicing and the stats footer; Playwright: at 1280×800 with the fake
camera on and the demo cube, the scramble, the clock and the preview are all within the viewport
while a solve list of 15 attempts exists (seed through the demo at high speed or a fixture store
state), the list shows 12 rows and "15 solves · See all", the session page shows 15; at 390×844
no horizontal overflow and the preview sits under the clock. Screenshots in the PR.

**Acceptance.**
- [ ] Owner's visual check on the MacBook and the ThinkPhone (round 2).
- [ ] The timer page's initial render does not wait for the camera or the list.

### T2.6 — e2e for recording, docs, `v0.2.0`, manual round 2

**Scope.** Any e2e flow the tasks above left out; `docs/MANUAL-TESTS.md` "Round 2" (both devices:
sharpness meter, exposure controls on the phone, 30 minutes of recording: heat, battery, dropped
frames, storage growth, clips play, the sync check twice); README (recording), CHANGELOG 0.2.0,
versions 0.2.0, `docs/DEVICES.md` updated from the round; the coordinator tags after the round.

### T2.9 — `capture`+`core`+`web`: clips never refused for an old start, the scramble clip's window, the clock fit across a reconnection, audio never silently absent

**Goal.** Three defects of attempt 6 of the owner's GAN 356 i3 session (issues #34 and #33,
`fixtures/hardware/2026-09-27-macbook-pro-2021-gan356i3.json`): its scramble clip was refused, since
the scramble's first turn (a sync check's turn that entered the attempt) was 7 minutes older than
the 90 s in memory; its clock fit went through a reconnection of the cube, whose count restarted
(561,080 ms back to 10,977), and recorded a slope of −0.81; and none of the session's clips has an
audio track, although Chrome was given the microphone and no notice said so.

**Scope.** In `packages/capture/src/`: `cut`, `mux`, `ring-buffer`, `capture-worker`, `clip-worker`,
`clip-writer`, `protocol`, `pipeline` and a new `audio-config`; in `packages/core/src/`: `clock`,
`records`, `attempt`, with `packages/core/schema/attempt.schema.json`; in
`apps/web/src/app/camera/`: `recording-service` and `recording-panel`; the solve list, the clip
viewer and the capture lab's counters; the fixture and the tests that read it; `docs/DATA-MODEL.md`
§6 and §7, `docs/DEVICES.md`, `docs/MANUAL-TESTS.md`.

**Behaviour.**
- **A cut whose start is older than the buffer is clipped, not refused.** It begins at the buffer's
  first keyframe; the muxer writes it and says how late it begins (`lateMs`); its `video[]` entry
  says `truncatedStart: true` (optional in the schema, read as false in the files written before);
  the recording saves it as any other clip, with a notice ("Scramble clip of attempt 6 starts
  434.1 s late: the buffer holds 90 s") and a line in the session's notes (`clip truncated: …`); the
  solve lists and the clip viewer mark it "late".
- **The scramble clip's window** runs from `max(scrambleStart − 2 s, scrambleDone − 60 s)` to
  `scrambleDone + 1 s` (`SCRAMBLE_CLIP_MAX_MS`): a scramble takes 10 to 15 s, and a pause inside it
  is not worth minutes of video. The solve clip's is unchanged; a solve longer than the buffer is
  clipped and flagged.
- **The clock fit starts again with the cube's clock**: a sample whose cube time, counted from the
  fit's previous sample, is more than 1 s plus 1% of the host time between them behind its host time
  drops the samples before it (`CLOCK_RESTART_MS`, `CLOCK_RESTART_DRIFT`): a reconnection, which
  restarts the cube's count, and the i3's 16-bit count of a pause over 65.5 s. `samples` counts the
  run since.
- **Audio never silently absent.** The capture worker's counters say where the audio is
  (`audioState`: off, waiting, encoding, stopped; `audioChunks`), and the Recording part says it
  when it is not being encoded; 3 s after the first frame without audio from the microphone, a
  notice says so; the notices of a recording stay together, and each is noted in the session. A clip
  without sound while audio is recorded says why (no audio data, no decoder config, no chunk in the
  clip's span with how far the audio's timestamps are from the frames', the encoder's error), in a
  notice and in the notes. When the encoder's first chunk has no decoder config, one is made from
  its config (for AAC-LC with the AudioSpecificConfig), and the session's notes say so once (`clip
  audio described: …`), so that a clip with its sound still tells which cause it was; when the
  audio's timestamps count on another clock than the frames' (arrival offsets more than 100 ms
  apart), the buffer, the cut and the muxer place it by the arrival offsets, and the clip's notes
  say by how much.

**Tests.** Unit: the cut of a truncated start, the mux of it (`lateMs`), the clip worker's answer
with its report; the restart rule on synthetic samples (a reconnection, a count that falls behind
without going back, the jitter and a slow clock that do not restart it, the boundary); the reader
and the schema on `truncatedStart` (the mutation corpus); the ring buffer and the cut with audio on
another clock; the muxer's reasons for a clip without sound; the AAC decoder config the worker
makes, read back from the MP4; the worker's audio state and its notice after 3 s; the recording's
window, notices and notes; the late marks. The fixture: attempts 1–5 keep their recorded fits;
attempt 6's recorded fit is the bug, its replayed fit the 112 moves after the reconnection. E2E: the
capture lab's clips have their sound (asserted, no longer conditional: Chrome's fake microphone
gives Opus), and a clip asked from before the buffer began is saved, flagged and plays.

**Acceptance.**
- [ ] The owner, on the MacBook: an attempt with a 3-minute pause inside the scramble saves both
  clips.
- [ ] The owner, on the MacBook: a clip plays with sound, or its notice and the session's notes name
  why not.
- [ ] The owner: the panel names the audio state (Camera settings, Recording: the codec while it
  encodes, else where the audio is).
- [ ] A solve after a cube reconnection has a sane `clock` in the export (a slope within 1% of 1).
### T2.10 — `capture`+`web`: video quality setting, 4 Mbps by default

**Goal.** Clips that a laptop's or a phone's storage can hold. The first recordings on the MacBook
(`docs/DEVICES.md`, "First recordings") used all of the 8 Mbps asked for at 1080p30: 35–42 MB per
attempt, 4.5–5.5 GB a day at the owner's cadence, so the ~10 GB local quota fills in two days (CI's
fake camera compresses to about 1.2 Mbps, which hid it). 4 Mbps at 1080p30 is plenty for the hands and
the cube; the rest becomes a setting (issue #33, its bitrate half; the clips' missing audio track is
T2.9).

**Scope.** `packages/capture/src/{bitrate,protocol,capture-worker}.ts` (the rule, the start config's
quality, the counters' bitrate), `apps/web/src/app/settings/*` (the setting),
`apps/web/src/app/camera/*` (the choices' texts, Camera settings, the restart, the recording panel),
the capture lab's counters, e2e, README, `docs/DEVICES.md`, `docs/MANUAL-TESTS.md`, CHANGELOG.

**Behaviour.**
- **Setting** `videoQuality`: `standard` (the default), `high` or `maximum`, kept with the other
  settings; settings stored without it read `standard`. In Settings → Camera and in the Timer's Camera
  settings, next to the resolution and the frame rate; each choice says its bitrate at the resolution
  and frame rate asked for ("Best" counts 30 fps) and about what an attempt's clips take at it (40 s of
  clips): "Standard (4 Mbps, ≈ 20 MB per attempt)", High 8 Mbps and ≈ 40 MB, Maximum 12 and ≈ 60.
- **Bitrate**, `videoBitrate(width, height, fps, quality)` in the capture package: 4, 8 and 12 Mbps at
  1080p30, in proportion to the pixels at other sizes (1280×720: 0.44×), 1.5× above 45 fps. High is
  the rule of the first recordings: 8 Mbps at 1080p30, 12 at 1080p60.
- **Plumbing.** The pipeline's start config carries the quality; the worker configures its encoder
  with it, again when the frames change size; its `stats` carry the configured `bitrate`. A change of
  the setting starts the recording again, as a change of Record audio does: the clips waiting for
  their time are saved first with what the buffer has, and the new buffer starts empty.
- **Recording panel.** The codecs line gives the bitrate ("avc1.640028 at 4 Mbps, mp4a.40.2"); under
  the storage meter, "≈ 20 MB per attempt at this quality", at the bitrate recording, else at the one
  Settings give.

**Tests.** Unit: the rule (the three qualities at 1080p30, a phone's portrait frames, 1280×720, 60 fps,
High equal to the former rule), the worker's encoder configs and counters at a quality and after a
resize, the start config's default, the setting's default, persistence and validation (a stored record
without it reads Standard), the restart, the choices' texts, the panel's lines. Playwright (`encoding`
project): High in Settings, then the Timer with the fake camera recording says "8 Mbps"; Standard in
Camera settings says "4 Mbps", also after a reload; no sideways scroll at 320 px.

**Acceptance.**
- [ ] CI green; the recording's counters say the bitrate of the quality chosen.
- [ ] Settings stored before this change read Standard.
- [ ] Owner: clip sizes at Standard on the MacBook (round 2): a 20 s solve clip about 10 MB, and "4 Mbps" in Camera settings.

### T2.11 — `capture`+`web`: the sync check measures the middle of each turn's motion, with a trimmed spread

**Goal.** A sync check that passes on the owner's MacBook as the owner makes it. The first two
checks of round 2 (issue #38, `fixtures/sync/`: the FaceTime camera at 1080p30, the GAN 356 i3 held
in the air close to the camera with both hands, U and U′ turned with the fingers, the rectangle
around the cube and the hands) found every turn and failed with spreads of 341 and 343 ms: T2.8's
onset, the first frame of a turn's window to rise above its baseline, came from 381 ms before the
move to 8 ms after it, catching the hand getting ready a varying time before the turn, while the
peak of each turn's motion came within 90 ms before and 130 ms after its move. The cube reports a
turn in the middle of the face's motion: the middle of the turn's motion is the event to match.

**Scope.** `packages/capture/src/clapperboard.ts` and its tests, with a new
`clapperboard-hardware.test.ts`; `fixtures/sync/` (the two checks' data files and a README);
`apps/web/src/app/camera/{sync-run,sync-check,sync-report}.ts` and their specs, with a new
`sync-run.spec.ts`; the timer's status line, the capture lab's sync section, the e2e texts; the
comments on the clapperboard's fields in `packages/core/src/session.ts` (the schema is unchanged);
README, `docs/{ARCHITECTURE,TOOLCHAIN,DATA-MODEL,DEVICES,MANUAL-TESTS,CHANGELOG}.md`.

**Behaviour.**
- **The event.** T2.8's window, baseline, peak gate and rise stay; a matched turn's time is
  `eventHostMs`, the centroid of `max(0, changed − baseline)²` over the frames within 150 ms of its
  peak (`EVENT_HALF_WINDOW_MS`), at the frames' own times. The peak is the window's highest frame, or
  an earlier peak whose rise above the baseline is at least 0.8 of the highest's
  (`EARLIER_PEAK_SHARE`): what follows a turn in its window can move the picture as much as the turn
  (the synthetic scene's fidgets; two of the owner's turns, 0.95 and 0.98 as much), while the hand
  getting ready before it moved it at most 0.68 as much. The first rise stays in each turn's analysis
  as `onsetHostMs`, for the diagnostics. One motion per turn: when two turns' peaks are within 150 ms
  of each other, the turn whose move is nearer keeps it and the other takes the peak of its window
  more than 150 ms from it, or is `taken`.
- **The spread.** `offsetMs` is the median of the lags kept: the matched lags less the ⌈20%⌉
  farthest from the median of all (2 of 6 to 10, 1 of 4 or 5, none of fewer than 4, which fail
  anyway); `clapperboardResidualMs` their range, against T2.8's limit (50 ms plus the median frame
  interval); `clapperboardSamples` their count and `samples` the pairs kept, whose `onsetHostMs` is
  the event (the schema is unchanged). The analysis says `estimator: 'motion-centre'`, `kept` and
  `dropped` (the pairs left out, with their lags); a wide spread says "spread over 83 ms at 30 fps
  (91.2 ms over the 8 turns kept of 10)".
- **The instruction.** "Hold the cube still inside the rectangle. With one finger, flick one face;
  keep your other hand and the cube still; after a second, flick it back. Five times." The check
  shows "Hold still…" for its first second, "wait a second before the first turn", and counts no turn
  made then, so that every turn counted has a baseline; the timer's status line says it in short.
- **The diagnostics.** The data file (version 2) and the console line carry the estimator, the turns
  kept and the lags left out, and each turn's event; the capture lab says the spread over the turns
  kept of those matched, and its check ends early once all ten turns are matched and it passes.

**Tests.** Node: the two checks replayed from their files, through a copy of T2.8's estimator (the
day's lags, turn by turn; spreads of 341.4 and 343.5 ms: both fail) and through the new one (38.3 ms
with a spread of 51.2 over 8 turns of 10, and 18.7 ms with 70.9 over 7 of 9: both pass, 20 ms
apart); synthetic series for the centroid and its weights, the trimmed spread and its ties,
`dropped`, the messages, a later motion as strong as the turn and an earlier one weaker, the one
turn per motion, also across the edge of a window; the synthetic film (T2.5's detector matches 0 of
10 turns, the new one all ten, each on its own motion, with a lag of 127 ms and a spread of 20 ms).
App: the second of stillness and the count, the texts, the report, the lab's early end. E2E: the new
texts.

**Acceptance.**
- [ ] CI green; the two checks of issue #38 pass in `clapperboard-hardware.test.ts`, and T2.8's
  estimator fails them there as it did on the day.
- [ ] Owner, on the MacBook: two checks on the FaceTime camera pass and agree within 25 ms.

### T2.12 — `web`+`core`: the microphone recorded raw, the processing applied kept in the record

**Goal.** Clips whose sound has the cube's clicks. The owner's ThinkPhone clips of round 2 (Android
16, Chrome 155) have sound, and a TV's voices came through clearly, but the cube's own sounds were
missing: the recording opened the microphone with `getUserMedia({audio: true})`, so Chrome applied
its voice processing (echo cancellation, noise suppression, automatic gain control; on Android the
platform's voice pipeline too), which takes a turn's click for noise. For the dataset the clicks are
signal (each turn clicks; the sound can time the moves), so the microphone is recorded raw, and the
record says what the browser applied. The MacBook's export of the same round (issue #40) explained
the clips without sound before T2.9, which this task writes down: its microphone's timestamps count
on a clock of their own (`docs/DEVICES.md`, "Audio").

**Scope.** `apps/web/src/app/camera/` (a new `microphone.ts`: the request, the record of what the
browser applied and the texts; `recording-service`, `recording-panel`, Camera settings),
`apps/web/src/app/settings/*` (the setting), the capture lab's request, the fake browser's
microphone; `packages/core/src/{session,records}.ts` and `packages/core/schema/session.schema.json`
(`cameras[].microphone`), with the test records and the tests that read them; e2e; README,
`docs/{DATA-MODEL,DEVICES,MANUAL-TESTS,TOOLCHAIN,CHANGELOG}.md`.

**Behaviour.**
- **Raw by default.** The recording asks for `{audio: {echoCancellation: false, noiseSuppression:
  false, autoGainControl: false, voiceIsolation: false, channelCount: {ideal: 1}, sampleRate: {ideal:
  48000}}}` (`voiceIsolation`, a newer constraint, through a typed extension of TypeScript's DOM lib,
  which lacks it). Should the browser refuse it with an `OverconstrainedError` (booleans and ideals
  never should), it asks again with `{audio: true}`, and a notice says so. The capture lab asks for
  the microphone raw too.
- **Setting** `microphoneProcessing`: `raw`, the default, or `voice`, the browser's defaults (for
  someone who wants speech), kept with the other settings; settings stored without it read `raw`. In
  Settings → Camera and in the Timer's Camera settings, next to Record audio, with one line of help:
  "Raw keeps the cube's clicks; Voice lets the browser suppress noise for speech." A change starts the
  recording again as one of Record audio does, while the sound is recorded (without it, a change
  waits for Record audio).
- **What the browser applied, in the record.** After `getUserMedia`, the track's `getSettings()`:
  `session.cameras[].microphone = {label, processing, echoCancellation, noiseSuppression,
  autoGainControl, voiceIsolation, sampleRate, channelCount}`, `processing` what was asked for, each
  setting null when the browser does not report it, the device's id not kept; null when the camera
  records without a microphone. Optional in the JSON (schema 2 is otherwise unchanged and
  `additionalProperties: false` stays): `parseSession` reads a missing one as null, and `putCamera`
  writes it with the camera's entry.
- **Recording panel.** The codecs line ends with "mic raw" or "mic voice", and with "mic: the browser
  kept processing on" when Raw was asked for and `getSettings()` reports any processing on; a notice
  then names it ("The microphone is not raw: the browser kept its noise suppression on …"), noted
  once in the session as T2.9's notices are.

**Tests.** Unit: the request, raw and voice; the fallback after an `OverconstrainedError`, and none
after another refusal or for Voice; what the record keeps of `getSettings()` (a setting not reported
or not a switch or a count is null; Chrome's echo cancellation modes are on; no device id); the
setting's default, persistence and migration; the restart on a change, only while the sound is
recorded; `putCamera` writing `microphone`; the reader and the schema on it (the mutation corpus:
absent and null valid, wrong types invalid); the panel's texts and the notice. Playwright (`encoding`
project), with Chrome's fake microphone: the codecs line says "mic raw" and the export's
`cameras[0].microphone` says `processing: 'raw'` with every processing off, as the fake device
reports it (at 44.1 kHz in two channels: its own format); Voice in Camera settings starts the
recording again, which says "mic voice", and the export says the processing on; the setting survives
a reload.

**Acceptance.**
- [ ] CI green; the export of a session recorded with Chrome's fake microphone has
  `cameras[0].microphone.processing` `raw` and the processing off.
- [ ] Settings stored before this change read Raw; sessions written before it read with no microphone.
- [ ] Owner, on the ThinkPhone (round 2): cube clicks audible in a ThinkPhone clip, and the panel says
  "mic raw" (`docs/MANUAL-TESTS.md`, T2.12).
- [ ] Owner: each device's `cameras[].microphone` in `docs/DEVICES.md`, "Audio".

### T2.13 — `web`: on a phone, the picture and the scramble in view together: the scramble over the pinned picture

**Goal.** What the owner found solving on the ThinkPhone in portrait: the scramble and the camera's
picture cannot be seen at the same time. T2.7's column puts the picture under the time, so with the
page scrolled to the scramble the picture is out of view, and the hands drift out of the frame
unnoticed. His suggestion: the picture behind the scramble, the scramble on a transparent ground.

**Scope.** `apps/web/src/app/timer/*` (the page's layout, `timer-layout.ts` for its choice, the
scramble over the picture), `apps/web/src/app/camera/camera-preview.ts` (its form over a phone's
page), `apps/web/src/app/settings/*` (one setting), `matchMedia` in `BROWSER_GLOBALS`, e2e
`timer-layout.spec.ts`, README, `docs/{MANUAL-TESTS,CHANGELOG,TOOLCHAIN}.md`.

**Behaviour.**
- **A phone with the camera on** (a window narrower than 60rem, T2.7's breakpoint): one part pinned at
  the top of the window (`position: sticky; top: 0`, over the rest, on the page's background so that
  nothing shows through beside it): the camera's picture from edge to edge at the frames' proportions,
  at most 42% of the window's height (16:9 at 390 px wide is 219 px high; a phone's upright frames
  come between bars), with the framing rectangle, the preview's line over its top left corner on a
  dark ground of its own, and the scramble over its lower part on a dark strip (black at 60%, a thin
  light top edge; the moves white, as large as elsewhere and in the same colours, with a shadow; the
  heading, "Scramble" or "Next scramble", the progress, "0 / 21", and the undo guidance there as
  before, the guidance tinted rather than opaque; no picture of the cube), as tall as its lines. The
  time right under the pinned part, the sync check under the time (out of the pinned part), then the
  breakdown, the last solves and the two sections. While the picture's code loads, a black box of
  16:9 holds its place.
- **A phone with the camera off:** T2.7's column, with the scramble's card pinned the same way and a
  band of the page's background above and under it.
- **Setting** `scrambleOverPicture`, "Scramble over the picture (phone)" in Settings → Timer, on by
  default; settings stored without it read on. Off: T2.7's column, nothing pinned.
- **Wide windows** (from 60rem): unchanged. The header scrolls away as before.

**Tests.** Unit: the layout's choice (`timerLayout`) in every case, and the media query's signal
(it follows `change`, stops with its component, and is false without `matchMedia`); the setting's
default, persistence and the settings stored before it; its switch in Settings → Timer; the scramble
over the picture (no picture of the cube; the progress and the undo guidance); the preview's form over
the page (the frames' proportions, no sync check); the Timer page's elements in each layout, as the
camera, the setting and the window change. Playwright at 390×844 with Chrome's fake camera and the
demo cube: every move of the scramble, the picture and the time in the window after a load; scrolled
until the breakdown and the solves come under the pinned part, the picture and every move still at
the top, and the time gone under them; the strip's ground at least 50% black, its moves white, and at
least 4.5:1 over a mid-grey picture for the moves, the heading and the green of a move made; nothing
wider than the screen at 320 px; the camera off, the scramble's card pinned; with the setting off,
T2.7's assertions (the preview under the time); at 1280×800, T2.7's assertions and nothing pinned.
Screenshots in the PR.

**Acceptance.**
- [ ] CI green; the initial bundle within 2 kB of `main`'s.
- [ ] Settings stored before this change read on.
- [ ] Owner, on the ThinkPhone: the hands stay in view while reading the scramble.

### T2.14 — `capture`+`web`+`core`: camera labels unique per device within a session

**Goal.** Follow-up (e), from the owner's two laptop cameras (issue #40): the FaceTime camera and a
Logitech C930e webcam both get the session label `laptop`, since the label comes from the host and
the facing, not from the device. Within one session, a switch of cameras made `putCamera` replace
the first camera's entry and `putCameraClock` its sync result (the Logitech lags 177 ms, the
FaceTime 19 to 38), and the earlier clips, whose `camera` is `laptop`, then described the wrong
device.

**Scope.** `packages/core/src/session.ts` (`labelFor`, `sameCamera`, `CameraIdentity`),
`packages/capture/src/camera.ts` (`cameraLabel` is a camera's own label),
`apps/web/src/app/session/session-service.ts` (`cameraLabel`, `putCamera`),
`apps/web/src/app/camera/{camera,recording,sync}-service.ts`, e2e `camera-labels.spec.ts` (in the
`encoding` project), README,
`docs/{ARCHITECTURE,DATA-MODEL,DEVICES,CHANGELOG,TOOLCHAIN,MANUAL-TESTS}.md`.

**Behaviour.**
- **The rule** (`labelFor(cameras, camera)`, pure, in core): a camera's own label is the host's and
  the facing's (`cameraLabel`: `laptop`, `phone-front`); in a session it is that of the entry of the
  same device when the session has one, else its own label when no entry has it, else the first free
  `<label>-2`, `<label>-3`, …. Two cameras are the same device when the browser names them alike
  (`deviceLabel`) and, when both ids are known, gives them the same device id. The records never
  keep the id (an identifier of the browser's installation): the session service knows the ids of
  the cameras put since the page loaded, so after a reload a camera of a shared name takes the first
  label of that name. A new session starts again from the own label.
- **The session decides.** `SessionService.cameraLabel(identity)` is a camera's label in the current
  session; `putCamera(camera, audio, deviceId)` stores the camera under it, replacing the entry of
  the same device, and returns the entry, whose label the recording gives the camera's clips
  (`video[].camera`, `<label>.<segment>.mp4`). The recording puts the entry again when a pipeline
  starts, so that a new run never cuts clips under the previous camera's label, and a clip saved
  after a switch keeps the framing of its own camera (devices compared, not labels).
- **What is keyed by label follows:** `clock.cameras[label]` (the sync check labels its result by
  the session's label for the device: a camera switched to that has no check in the session is due
  one, one switched back to finds its own, and the Timer's line under the picture says the check of
  the camera that is on), `attachClip`'s `syncResidualMs`, the index documents' `device.cameras` and
  the session page's cameras. Settings' choices per camera (the camera picked on a host, the manual
  controls, the framing rectangles) are keyed by the browser's name for the device already, and
  stay.

**Tests.** Unit: `labelFor` (a session without cameras; a second device under `laptop` gets
`laptop-2`, a third `laptop-3`, a free number first; each device its label back through switches; a
device whose own label changed keeps its entry's; two cameras of one name told apart by their ids)
and `sameCamera`; the session service (labels per device, the same device's entry replaced, the ids
per session and never in the record, a new session starting again, a resumed session's labels by
name); the camera service's identity; the recording (a switch and back: two entries; across switches
the clips, their files, their lags and the index documents, valid against the schemas; a switch in
the middle of an attempt: the scramble clip the first camera's, the solve clip the second's, each
with its framing); the sync check per camera and the Timer's sync line. Playwright with Chromium's
`device-count=3` (its `fake_device_1` sends Y16 frames that the encoder refuses, so the test uses
`fake_device_0` and `fake_device_2`): a solve with each camera, then with the first again; the
export has the two entries, `laptop` and `laptop-2`, each attempt's clips are named after its camera
in its folder, and the session page names both.

**Acceptance.**
- [ ] CI green; the initial bundle unchanged (264.63 kB raw, as `main`'s: the services that label
  the cameras are in lazy chunks).
- [ ] Owner, on a laptop with two cameras (the FaceTime camera and the Logitech webcam): one
  session, a solve and a sync check with each camera; the export has `laptop` and `laptop-2`, each
  with its lag in `clock.cameras`, and each attempt's clips under the label of the camera that
  recorded them (`docs/MANUAL-TESTS.md`, T2.14).

## Phase 3 task board — cloud

Prerequisites, all done on 2026-09-27: the Firebase project `cubetrace-cacd9` (Blaze on a Google
Cloud free-trial billing account with R$ 1,761 of credit until 2026-12-27, Google sign-in, Firestore
in `nam5`, a web app registered, `shermam.github.io` authorized) and the bucket decision: **Google
Cloud Storage during the trial, Cloudflare R2 as the later option**, both by configuration
(`docs/USER-ACTIONS.md`). The coordinator deploys with a service-account
key held only by the coordinator session; a GitHub Actions workflow deploys on merge with a
second key. Phase 3 starts after T2.4, because it changes the same `SessionService`.

| Id | Task | Depends on | Status |
|---|---|---|---|
| T3.0 | `web`: Firebase in the app: config, Google sign-in, `users/{uid}`, Firestore rules with emulator tests, deploy workflow | T2.4 | ✅ #42 (rules deployed by the coordinator on 2026-10-01; the workflow waits for the `FIREBASE_SERVICE_ACCOUNT` secret) |
| T3.1 | `web`: Firestore session index; the Sessions page merges local and cloud sessions; QA view | T3.0 | ✅ #45 |
| T3.2 | `functions`: `signUpload` and `confirmUpload` with presigned URLs for R2 (S3 SigV4) or GCS by configuration, quotas, secrets, bucket CORS | T3.0 | ✅ #44 (deployed 2026-10-01: rules, functions, bucket `cubetrace-data`) |
| T3.3 | `upload`: the upload queue: per attempt JSON and clips, resumable, retried, throttled, persistent; local clips deleted after confirmation by policy | T3.1, T3.2 | ✅ #46 |
| T3.4 | `web`: cube MAC addresses synced per user (issue #21) | T3.0 | ✅ #47 |
| T3.5 | e2e against the emulators, docs, `v0.3.0`, manual round 3 (two devices, one dataset, `rclone ls` on the training machine) | T3.3, T3.4 | ✅ #49 |
| T3.6 | `web`: the app installed on Android signs in with the popup; the redirect flow removed (issue #50) | T3.0 | ✅ #51 (2026-10-02; confirmed by the owner on the ThinkPhone the same day: the installed app signs in, issue #50 closed) |
| T3.7 | `gan`, `core`, `storage`, `upload`, `functions`, `web`: the cube's whole record — the gyroscope stream in a `gyro.json` per attempt, each move's counter and packet flag, a resync log, the battery readings and the production date, and the app's version and commit in every file it writes (found by the owner in the first downloads) | T3.5 | ✅ #52 (2026-10-02; the gyro rate of the owner's cubes is measured by the first capture: `docs/DEVICES.md`) |
| T3.8 | `web`: a 3D cube in the clip viewer that follows the video: its orientation from `gyro.json`, its turns from the moves, the camera's lag applied; no live 3D cube on the timer page (the owner's decision: the solver watches the real cube, and WebGL would compete with the capture) | T3.7 | ⬜ |
| T3.9 | `web`, `core`, `firebase`, `scripts`: diagnostics events in the account (`users/{uid}/events`, create-only by the owner, nothing while signed out): evidence for the manual rounds' items without the owner writing them up, a Settings switch, and a report script the coordinator runs with the service-account key to tick the rounds' checklists | T3.1 | 🔄 in progress (2026-10-02) |

Waves: T3.0 → {T3.1, T3.2, T3.4} → T3.3 → T3.5.

### T3.0 — Firebase in the app

`firebase` (12.19 at the time of writing; modular `firebase/app`, `firebase/auth`,
`firebase/firestore`) as a dependency of `apps/web`; `apps/web/src/environments/firebase.ts` with
the project's public web config (the owner pastes it; it is public by design; the file is
committed); `AuthService` (Google provider; popup on desktop, redirect in the installed app on
Android; the header shows the account and Sign in / Sign out; the app works signed out exactly as
today); `users/{uid}` (created on first sign-in: `createdMs`, `displayName`, `devices: {label:
lastSeenMs}`); Firestore rules in `firebase/firestore.rules` (a user reads and writes only
`users/{uid}` and sessions whose `owner` is the uid; attempts under them; nothing public) with
`@firebase/rules-unit-testing` against the Firestore emulator in CI (`actions/setup-java`,
`firebase emulators:exec`); `firebase.json`, `.firebaserc`; `.github/workflows/firebase.yml`
deploying rules (and later functions) on merge with the `FIREBASE_SERVICE_ACCOUNT` secret.
Owner actions: add `shermam.github.io` to Authentication → Settings → Authorized domains; paste
the web config; create the two keys (`docs/USER-ACTIONS.md`).

**Outcome (2026-10-01, PR #42).** Firebase 12.19.0, modular, in one lazy chunk
(`firebase-sdk-<hash>.js`, 619 kB raw, 157 kB transferred) behind `ACCOUNT_LOADER`: loaded on Sign
in, or as the app starts when `localStorage` remembers a sign-in (`cubetrace.account`); the service
worker leaves it out of the prefetched shell (a lazy `account` group, told apart by `namedChunks`,
whose longer chunk names add 64 bytes to the initial bundle, 264.53 kB raw against 264.46; its code
is unchanged). `AuthService`: a popup, or a redirect in the app installed on Android, whose outcome
the next start reads (a redirect that comes back without an account says so); `user`, `status`,
`error`, and `recordError` for `users/{uid}`, which is merged at each sign-in and at each start
signed in, never awaited, through Firestore's persistent cache. `createdMs` is Firebase
Authentication's creation time of the account, the same on every device, so that the merge needs no
read and the rules can keep it unchanged. The rules also keep the client to the record's fields
(T3.2's quota will be out of its reach) and create an attempt only under a session of the same
owner; for T3.1, attempts carry `owner` too, and queries must ask `where('owner', '==', uid)`. The
Firebase CLI runs through npx, pinned (15.32.1), not as a devDependency. The question left for
manual round 3, whether the redirect completes in the installed app on the ThinkPhone, was answered
there on 2026-10-02: it does not (issue #50; Chrome's partitioned third-party storage cuts the
outcome off, as feared), and T3.6 below made the popup the one flow.

### T3.1 — Firestore session index and the merged Sessions page

When signed in, every `saveSession` also writes `sessions/{id}` (the record plus `owner`) and
every `saveAttempt` writes `sessions/{id}/attempts/{index}` (the record without `moves`, plus
`upload: {state: 'pending' | 'uploading' | 'done' | 'failed', files: {path: {bytes, doneMs}}}` and
`device`); Firestore's persistent local cache queues writes offline; demo sessions (`cube.hardware
=== 'simulated'`) never sync. The Sessions page merges OPFS and cloud sessions by id with badges
(this device, cloud, both) and a device filter; a QA view lists attempts per day per device with
bytes uploaded and pending.

**Outcome (2026-10-01, PR #45).** The documents are §10 of `docs/DATA-MODEL.md`: a session's is its
session.json with `owner`; an attempt's its attempt.json without `moves`, with `owner`, `device`
(its session's host label and camera labels) and `upload` (written once, when the document is
created: `pending`, the files of its folder the device has then, by name with their sizes, `doneMs`
null; then the functions' alone, T3.2, which the rules hold the app to), both of the records' schema
version, 2, with JSON Schemas (`cloud-session.schema.json`, `cloud-attempt.schema.json`) and readers
(`parseCloudSession`, `parseCloudAttempt`) in `packages/core`; `{index}` is the folder's zero-padded
index. `SessionIndexService` wraps `SessionService`'s store: after each local save, with an account
signed in, the document goes through Firestore's persistent cache (`set` with `merge`), never
awaited; Delete last deletes the attempt's document; deleting a session keeps its documents (the
device's copy is staging, the index the dataset's). A save without an account (signed out, or before
a remembered one has loaded) takes the session off the device's list of indexed sessions, kept per
account in `localStorage` (`cubetrace.sessionIndex`), and the catch-up, at a sign-in and at each
start signed in, writes the sessions not on it, the oldest first, each with its attempts in one
batch, at most 300 documents a run, after asking the index which of their attempts are there (those
are written without `upload`, the others created with it). A refusal is said once per session and
page load (the console, the Sessions page, a `cloud: …` line in the session's notes), and the
session goes back to the catch-up. `AccountBackend` gained `saveSessionIndex(session, attempts?)`,
`saveAttemptIndex`, `deleteAttemptIndex`, `listSessions(uid, limit)`, `getSession(id)` and
`listAttempts(uid, sessionId)`: the attempts' query takes the uid too, since the rules want
`where('owner', '==', uid)` on every query; the listings give each document's `pending` and the
query's `fromCache`. The sessions query needs a composite index (`owner` ascending, `createdMs`
descending, `firebase/firestore.indexes.json`), which the emulator does not and which the workflow
does not deploy yet (`--only firestore:rules,functions`): `firebase deploy --only firestore:indexes`
with the rules. The QA view's "last sync" is this device's: when the server last confirmed one of
its index writes (kept per account), with what still waits to be sent; another device's is not
stored. The initial bundle gained the `/qa` route (104 bytes) and nothing else; Firebase's chunk 18
kB raw (4 kB transferred). An attempt's document is created when the attempt ends, before its clips
are cut, so its `upload.files` names `attempt.json` alone, and the clips' files come with their
signatures (T3.2); the QA view counts the clips that `upload.files` does not name yet as pending, at
their `video[].bytes`.

### T3.2 — `functions`: signed uploads

`functions/` (Node 22, TypeScript, `firebase-functions` v7 `onCall`, auth required):
`signUpload({sessionId, attemptIndex, files: [{path, bytes, contentType}]})` checks ownership and
the user's daily quota (`users/{uid}.quota`, bytes and files), records the intent on the attempt
document and returns `[{path, url, headers, expiresAt}]` with presigned `PUT` URLs (15 minutes):
provider `r2` through the S3 SigV4 presigner (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
against `https://<account>.r2.cloudflarestorage.com`), provider `gcs` through
`@google-cloud/storage` v4 signed URLs; `BUCKET_PROVIDER` (`gcs` first), bucket name and account id as
parameters, the R2 keys as secrets (`defineSecret`) only when the provider is `r2`; object keys `users/{uid}/sessions/{id}/attempts/{index}/<file>`;
`confirmUpload({sessionId, attemptIndex, files})` verifies each object's size with the SDK and
marks the attempt `upload.state = 'done'`. `bucket/cors.json` for R2 (PUT and GET from
`https://shermam.github.io` and `http://localhost:4200`); a `functions/README.md` for deploying; the
coordinator deploys first with the session key, the workflow thereafter.

**Outcome (2026-10-01, PR #44).** `functions/` is a workspace (ES modules, Node 22): firebase-functions
7.4, firebase-admin 14.5, `@google-cloud/storage` 8.2, the AWS SDK 3.1145, pinned exactly because Cloud
Build installs `functions/package.json` without the lockfile. The API as written, plus: the attempt's
document id, and the `{index}` of its objects, is its folder's name (`0001`), which T3.1 must use;
`session.json` rides with an attempt (a `files[].path`, recorded on that attempt, its object the
session's); each URL binds the content type and the exact size (GCS `x-goog-content-length-range`, R2
`content-length`), so the bucket never holds more than the quota counted; the quota counts every
signature, a file signed again included (`users/{uid}.quota = {day, bytes, files}`, UTC, 6 GB and 1,200
files; a call that does not fit is refused whole, with `resetsAtMs`); the attempt is checked before
anything is signed, and the URLs are signed before the quota is counted, so a bucket that cannot sign
records and counts nothing; `confirmUpload` answers
`{state, confirmed, pending}`. The parameters are in `functions/.env`, committed, because a deploy
without prompts needs a value for each (the CLI does not take the defaults then), and the R2 secrets
are declared only when that file says `r2`, because a declared secret must exist in Secret Manager for
any deploy. The rules keep the quota the functions': readable, never written by the client, and a
record that holds one cannot be deleted. For T3.1: that id, and `upload` written only when the attempt
is created (`{state: 'pending', files: {}}`), never again, or a later `saveAttempt` overwrites the
functions' intent. For T3.3: sign once Firestore has sent the documents (`waitForPendingWrites`), else
`not-found`; `PUT` a `Blob` with exactly the headers returned. The first deploy takes `--force` once,
for Artifact Registry's cleanup policy (`functions/README.md`); the bucket, its CORS and the functions'
account's roles are in `bucket/README.md` and `docs/USER-ACTIONS.md`.

### T3.3 — the upload queue

`packages/upload` (plain TS over `SessionStore`, a `signUpload` port and a `fetch`/`XMLHttpRequest`
port): per attempt, `attempt.json`, the clips and their `frames.json`, plus `session.json` once per
session and again when it changes; two uploads at a time; retries with exponential backoff;
progress per file (`XMLHttpRequest` for upload progress); the queue state in OPFS (`uploads.json`)
so a reload resumes; a "Wi-Fi only" setting on devices that expose `navigator.connection`; after
`confirmUpload`, local clips are deleted by policy: "Keep local copies" on (default on laptops)
or off (default on phones), and in any case oldest uploaded clips first when storage passes 70%.
UI: a queue panel on the Sessions page (pending, uploading with progress, done, failed with
Retry) and a header indicator.

**Outcome (2026-10-02, PR #46).** `packages/upload` is the queue over three ports, tested in Node with
fakes (46 tests): the device (`UploadSource`, whose OPFS implementation reads the session store, the
attempts' files and `uploads.json`, and deletes a clip once its record says so), the cloud
(`UploadCloud`: the index's `upload`, `waitForPendingWrites`, `signUpload`, `confirmUpload`) and the PUT
(`XMLHttpRequest`, for progress), with the clock, storage, network and Web Lock beside them; its rules
are `docs/ARCHITECTURE.md` "Uploads", its state `docs/DATA-MODEL.md` §10. Three refinements of the
contract: `session.json` goes again once it has stayed the same for two minutes (every attempt changes
its summary; each upload of it is a file of the 400-a-day quota), not with every attempt; 408 and 429,
which say to come back, are tried again as a 5xx; a quota pause lasts at least a minute, whatever
`resetsAtMs` says, so that a device whose clock runs ahead does not ask again and again. A reload asks
the index about every attempt `uploads.json` does not show as all done: a page that goes away takes
its last write of the file with it (the e2e met it: the next page, holding the lock, read the file
before the old page's write landed), so the state is written 100 ms after a change and at once on
`pagehide`, and what the index confirmed with the same size is not sent again. `video[].local` (false
once a clip's MP4 left the device) is an optional field of version 2, in both attempt schemas and the
reader; the rules check no field of `video`, so none changed (a test writes such an attempt again over
an upload the functions marked done). In the app, `UploadService` loads the queue from its own lazy
chunk (`upload-runtime-<hash>.js`, 27.2 kB raw, a lazy group of the service worker) once an account is
signed in with uploads on; it injects what the queue needs (`SessionService`, the index, the store)
rather than an `Injector`, which `main` would have had to export, and only the header's indicator, a
nested deferred block that a signed-in account loads, makes it on every page; `main` is byte for byte
the same but for the build's commit and the lazy chunks' hashes (the initial bundle 264.63 kB raw, as
before; the CLI's estimate of its transfer moves by a few tens of bytes with the hashes). `SessionChanges` turns the store's writes into events (after the
index's), `ClipsInFlight` holds an attempt back while the recording has a clip of it to save, and
`SessionService.markClipsGone` saves `local: false` before a clip is deleted. Firebase's chunk gains
`firebase/functions` (646.8 kB raw, 637.3 before). The e2e fake of Firebase plays the two functions
over its index and a bucket that the test runs (a route on the app's own origin keeps each PUT's
bytes, `exposeFunction` lets the fake `confirmUpload` ask for a size); T3.5 replaces it with the
emulators. Open for the manual round (`docs/MANUAL-TESTS.md`, T3.3): GCS's CORS and signatures with
`XMLHttpRequest` on both devices, Wi-Fi only on the ThinkPhone, and the 70% rule on a phone's quota.

### T3.4 — cube MAC addresses synced per user

Issue #21: `users/{uid}/cubes/{name}` mirrors Settings' cube list; union on sign-in, newest
`updatedAt` wins; never in exports or uploads.

**Outcome (2026-10-02, PR #47).** `users/{uid}/cubes/{name}` is `{schema: 1, name, mac, updatedMs,
device}` (§10 of `docs/DATA-MODEL.md`: `schema` beside the contract's fields, as every document
there says its version), with `cloud-cube.schema.json`, `cloudCube`, `isCubeDocumentName` and
`parseCloudCube` in core, and rules that open the cubes to their account alone and hold each
document whole and valid after every write (22 tests in a block of their own). `CubeSyncService`
(`apps/web/src/app/cloud/`), made by the header's controls on every page (the lazy chunk of
`AccountControl`; `main` byte for byte the same but for the build's commit and the lazy chunks'
hashes), merges Settings' list with the account's at each sign-in and each start signed in, then
writes or deletes a document at every change of the list, never awaited. The merge (`cube-merge.ts`,
pure functions): the union by name ignoring case; of two copies the later `updatedMs`, both ways
(equal times: the account's); the deletions carried both ways without tombstones, by what the device
knows the server holds (per account, each document's `updatedMs` as last read from the server or
confirmed, `localStorage` `cubetrace.cubeSync`): an entry missing on one side in a version the
server held was deleted there; a listing from the cache never deletes. Settings' entries have
`updatedMs` (the stored settings are version 2; 0.2.0's entries get the time of their first read,
written back at once; an edit is dated after the copy it replaces, even one from a clock ahead). The
writes on their way are kept per account across a sign-out, as Firestore keeps them; a name that
cannot be a document's id stays on its device. No record holds an address, so neither an export nor
an upload nor the index does (`session-macs.spec.ts`, `cube-macs.spec.ts`). The e2e fake of Firebase
gained a cloud that two browser contexts share, two devices of one account. The production rules
must be deployed for the merge's read to work (until then Settings says the cubes could not be
read); open for the manual round (`docs/MANUAL-TESTS.md`, T3.4): the ThinkPhone's typed address on
the MacBook.

### T3.5 — e2e, docs, `v0.3.0`, manual round 3

Playwright against the Auth and Firestore emulators in CI and a local `PUT` sink for uploads
(`BUCKET_PROVIDER=local` in the emulated function returning URLs to a test server started by the
e2e config); `docs/MANUAL-TESTS.md` "Round 3" (sign in on both devices, record on both, one merged
list, uploads reach R2, `rclone ls` from the training machine); README; CHANGELOG 0.3.0.

**Outcome (2026-10-02, PR #49).** `npm run e2e:cloud` builds the functions and runs Playwright's
project `cloud` inside `firebase emulators:exec --only auth,firestore,functions --project
demo-cubetrace`, in CI after `npm run e2e`; the config has that project, and the bucket sink in
place of the production build, only when `FIREBASE_EMULATOR_HUB` says the emulators run, so
`npm run e2e` keeps its 73 tests, and `firebase.json` names the Auth emulator, which the CLI does
not start otherwise. The app is the dev server's with the real Firebase chunk: in development builds
`ACCOUNT_LOADER` reads `window.cubetraceE2eEmulators`, and `connectFirebase` starts the app under
the emulators' project and connects Authentication (without its banner), Firestore and the functions
to them; Sign in is then `signInWithCredential` with a Google ID token of unsigned claims, which the
Auth emulator's Google provider takes: no window, the provider and the account's name kept, and the
same `sub` the same uid in a second browser context (a custom token, or an email and password, were
the other ways). The functions gained `BUCKET_PROVIDER=local` (`local.ts`): URLs
`http://127.0.0.1:4600/<key>` that carry the type, the exact size and the expiry, with GCS's
headers, and sizes by `HEAD`, every call failing unless `FUNCTIONS_EMULATOR` is `true`;
`functions/.env.demo-cubetrace` gives it to the emulators' project alone, the server's address a
variable rather than a parameter, so that the production `.env` and the deploy's parameters are
unchanged (and `firebase.json` keeps the file out of the deployed source). The sink
(`apps/web/e2e/helpers/bucket-sink.mts`) holds each PUT to what its URL says and answers the
preflights from `bucket/cors.json`; the tests read the emulators through their REST APIs. Three
specs, an account each: the account and `users/{uid}` through the rules; a session recorded with the
fake camera, indexed, its six files in the sink and confirmed, the quota, the Sessions page, the
session's page and the QA view; two browser contexts of one account (the session as "cloud", the
cube's MAC address). The one request off the machine is Firestore's network probe
(`www.google.com/images/cleardot.gif`, after a connection error of its transport), which the
account's flow allows. The cloud project takes 37 to 43 s locally (57 to 62 s with the build and the
emulators) and 45 s in CI (31 s of tests), where the whole job took 7 min 47 s (7 min 52 s before
it); `main` is unchanged but for its stamps, and Firebase's chunk is 3.7 kB larger. Open: the round
(`docs/MANUAL-TESTS.md`, "Round 3"), then the `v0.3.0` release from the GitHub UI; and the daily
quota, 400 files, at most 80 attempts with their clips, below the design's cadence (raised to 6 GB and 1,200 files a day by the coordinator on 2026-10-02)
(`functions/.env`).

### T3.6 — Sign-in in the installed app on Android (issue #50)

The first sign-in from the app installed on the ThinkPhone (Chrome's WebAPK, display mode
`standalone`) ended with "Signing in did not finish: Google sent the page back without an account":
T3.0's redirect, whose outcome comes back through Firebase's helper frame on
`cubetrace-cacd9.firebaseapp.com`, a third party to the app on `shermam.github.io`, which Chrome's
partitioned third-party storage keeps from the app. Contract: one sign-in flow, the popup, in the
installed app too (Chrome opens it there as a Custom Tab over the app, which closes itself when
Google is done); the redirect flow removed from `AuthService`, `AccountBackend`, `firebase-sdk.ts`
and both fakes; a `redirect` value of `cubetrace.account` left by 0.3.0 read as nothing and removed
at start, never an error; in the installed app, a popup blocked or closed before Google is done
says to sign in once in Chrome itself, at the app's address, and to open the installed app again
(Chrome's installed apps share the site's storage with its tabs); the messages in a tab unchanged;
no version bump, no change to the workflow, the Firebase configuration or the dependencies.

**Outcome (2026-10-02, PR #51).** `signInWithPopup` everywhere: `SignInFlow`, `signInFlow()`, the
redirect branches of `signIn()` and `resume()`, `RedirectLostError` and the `redirect` value of
`cubetrace.account` are gone, with `signInWithRedirect` and `redirectResult` from `AccountBackend`,
`firebase-sdk.ts` (which keeps `browserPopupRedirectResolver`, passed per call so that a remembered
start opens no iframe) and both fakes; `installedApp()` (display mode `standalone`) is what is left
of the choice, and `AuthService` hands it to `authErrorMessage` as an `AuthErrorContext`, so that
`auth/popup-blocked`, `auth/popup-closed-by-user` and `auth/cancelled-popup-request` say, in the
installed app alone, "Google's window did not finish signing in from the installed app. Open the
app's address in Chrome itself and sign in there once: the installed app shares its storage with
Chrome, so that signs it in too. Then open the installed app again." Why the popup should work where
the redirect did not: its outcome goes from Google's window to the app's by messages, not through
the helper frame's storage, and the owner's laptop, the same Chrome with the same partitioning,
signs in with it already. Why the helper on the app's own domain (Firebase's other options: the
app's domain as `authDomain`, a reverse proxy of `/__/auth/`, the helper's files served with the
app) is not the fix here: each needs the app's host to serve or proxy those paths, which GitHub
Pages cannot. In `auth-service.spec.ts`, six tests in place of the three redirect ones (the
installed app on Android signs in with the popup; a stale `redirect` forgotten at start, signed out,
nothing said, Firebase not loaded; the three codes' installed-app message, and a Chrome tab's
sign-in reaching the installed app's next start; the other messages unchanged there) and two in
place of five for `installedApp()` (the user agent no longer matters); the e2e fakes lost their
redirect members and no end-to-end test changed. Left for the owner on the ThinkPhone, after the
deploy: Sign in from the installed app, the Custom Tab, and whether the app comes back signed in
(`docs/MANUAL-TESTS.md`, round 3); if the Custom Tab does not come back signed in either, plan B is
Google Identity Services giving an ID token to `signInWithCredential`, without Firebase's helper at
all, which needs the app's origin among the OAuth client's authorized JavaScript origins in the
Google Cloud console.

### T3.7 — the cube's whole record: `gyro.json` per attempt, move counters, resyncs, battery, the app's build in every file

The owner downloaded an attempt's files and found no gyroscope data, and no app version or commit
in them: the driver decoded the cube's gyro packets and the app used them for the pickup event
only, and `attempt.json` and the frames files named no build, although a session can outlive an
update. Contract: everything the cube provides is kept now, to be trimmed later if useless, and
every file says which build wrote it, so that the data of a buggy or an older version can be
excluded or repaired later. (1) `gyro.json`, one per attempt, next to `attempt.json` (schema 1:
`t0HostMs`, `dtMs` in the frames files' convention, `q` flat to 5 decimals, `v` the Gen2 velocity's
raw integers or null, `truncatedStart`), the window from 2 s before `scrambleStart` to 1 s after the
end, from a ring buffer of the connection's gyro events in typed arrays sized by time (the last 10
minutes), written once per attempt when the record is written after its end margin, with or without
a camera; no file for a cube without a gyro or an attempt without samples; the pickup detection as it
was; `CubeGyroEvent` gains `v`. (2) `attempt.json` (schema 2, the new fields optional): `app`,
`gyro` (the file's summary or null), `resyncs` (the states adopted after moves went unseen), each
move's `serial` and `packetLast`; the frames files gain `app`. (3) `session.json`:
`cube.productDate`, `battery` (every report, consecutive equal levels coalesced). (4) The cloud: the
index copies the new fields; the rules, the cloud schemas and `cloud.ts` follow. (5) The upload:
`gyro.json` the attempt's sixth file, in the functions' allow-list, counted by the quota, kept on the
device when the clips go; the clip viewer's Download includes it; the QA view counts the attempts
with one and says their median rate. (6) The fake cube gains a gyroscope option for the e2e suite
and the demo. (7) The docs. (8) Nothing on the per-event path allocates or stringifies. (9) No
version bump, no workflow change, no new dependency.

**Outcome (2026-10-02, PR #52).** As contracted, with these choices. The ring buffer
(`GyroBuffer`, `packages/core/src/gyro.ts`) is the page's rather than a connection's: the host
clock runs on across the cube's reconnections, so an attempt that spans one keeps its samples from
before it (a gap in `dtMs`), and nothing of another cube can reach a window, since a different cube
starts a new session seconds later; its capacity is 10 minutes at 100 Hz (60,000 samples, 1.6 MB of
typed arrays), evicted by time as well, so a slower cube keeps 10 minutes too. The file is written
by `SessionService` 1 s + 250 ms after the end (`GYRO_TAIL_MS` + `GYRO_SETTLE_MS`, the latter the
time the recording gives the encoder), through a `write` on `ATTEMPT_FILES` over the storage
package's new `writeAttemptFile` (one step, as the records), then `attachGyro` saves the record
with `gyro`; `ClipsInFlight` holds the attempt for the upload meanwhile, so the record goes once;
a failure is noted (`gyro failed: attempt <i>: …`) and the record keeps `gyro` null. A window older
than the buffer begins at its oldest sample with `truncatedStart` (the first attempt of a page whose
cube connected a moment before its scramble). `v` is null when no sample of the window has a
velocity (a Gen3 cube has no gyro at all; the Gen2 and Gen4 cubes always send one). `resyncs[].state`
is the attempt's state when the report came, during which the moves went unseen. The battery event
gained its host time; a session begins with the connection's latest report, and the report that
arrives right after the hardware event that began a session saves it once more. The frames file's
`app` travels with the clip's request (`SaveClipParams.app`) through the capture worker to the clip
worker, so the muxer and its tests are unchanged. The rules check the new fields' shape where a
document has them (the catch-up writes older records without them). The e2e: `?gyro=1` gives the
demo cube a gyroscope (a 30°/s turn about its white axis while a replay turns, at 50 Hz, velocity
`[0, 0, 2]`); one new recording test checks the file's span, the record, the download of six files and
the export, with the camera off and on; the cloud e2e now records with the gyro on and sees the sixth
file reach the sink (seven signatures with `session.json`). Size: about 46 bytes a sample, 92 KiB for
a 20 s solve at 50 Hz (2,049 samples over a 41 s window) and 183 KiB at 100 Hz. `main` is unchanged
in size (264.63 kB raw initial). Left for the owner: the gyro rate of each cube from the first capture
(`docs/DEVICES.md`), and the item of `docs/MANUAL-TESTS.md` "After T3.7".

### T3.9 — diagnostics events in the account: evidence for the manual rounds without the owner writing it up, and a report script for the coordinator

`docs/MANUAL-TESTS.md` asks the owner to go through checklists on each device and write the results
into issues; the owner has no time for that and uses the app daily (130 to 150 attempts a day on a
laptop and an Android phone, signed in). Contract: (1) events `users/{uid}/events/{eventId}`
(schema 1; `tsMs`, `kind` ≤ 64, `app`, `device` {label, platform, installed}, `session` and
`attempt` when they belong to one, `data` of at most 32 facts, texts ≤ 500 characters, one level of
nesting; never a MAC address, an email, a file's contents, a user agent or another uid), created by
the client in batches, never updated or deleted (rules, tests, a JSON Schema and a parser in core);
(2) a `DiagnosticsService` with `record(kind, data, scope?)`, cheap, never throwing, batching every
5 s, at 20, and when the page hides or goes away, Firestore's cache carrying the batch offline; only
signed in and with the setting on, the events raised signed out kept in a ring of the last 500 and
written at a sign-in during the page's life; a cap of 2,000 a local day, then `error.*` alone;
Settings → Account → Diagnostics, on by default, off after one last `settings.changed`; (3) a
catalogue derived from the checklists, each item mapped to the kinds that are its evidence, in
`docs/DIAGNOSTICS.md`; (4) a Diagnostics section of the QA view over the last 500 events; (5)
`round-report`, for the coordinator, reading every account's events with a key named by
`GOOGLE_APPLICATION_CREDENTIALS` and printing the counts per device and day, the checklists with
✅ ⬜ ❗ and the facts, and the last 20 failures, its table logic unit-tested over a fixture; (6)
tests for all of it, one end-to-end flow with the fake account and the events seen by the cloud
project; (7) the docs; (8) the costs measured; (9) no version bump, no workflow change, no new
runtime dependency.

**Outcome (2026-10-02).** As contracted, with these choices. `DiagnosticsService` is a sink the
services write into, with no dependency on them (no cycle): `AuthService` hands it the account
(`attach`) and records the sign-ins; `SessionService` keeps the session and attempt under way on it,
and records `attempt.done` only once the attempt's clips and gyro file are in (`ClipsInFlight`, at
most 15 s), so that one event counts them; `CubeService` records how the address came, never which,
and a failure's kind, never its message (which may name the address typed); `UploadService` diffs
the queue's views into `upload.state` once per state reached; the service itself watches the settings the
checklists name, the wake lock, the storage's persistence and the network, and records the pages
from the router (injected optionally, so the services' unit tests need none). `cloudEvent` in core
sanitizes every event (a list reads as one text) and scrubs MAC addresses and emails out of every
text, which the end-to-end flow checks on a run's events. The rules check the id's shape too. The
catalogue has 35 kinds; the checklists' 110 items map to them in `docs/DIAGNOSTICS.md`, whose table
the report's own list generates and the report's test holds to the doc, and every kind named to the
shape core asks (the type of `record`'s kind asks for the dot too): 92 items have an event as
evidence, 18 have none (the layouts, the colours, the camera's controls, the net, the lab, signed-out
states, the files searched for an address) and stay the owner's with the round, and 58 of the 92
keep something for the owner's eyes beside their evidence. The script lives under `functions/scripts/`
(firebase-admin is the functions' dependency; the deploy ignores the folder), runs on Node 22 as it
is, reads each account's events in turn rather than a collection group (no index to deploy), and
names an account by its uid's first characters. Measured in the end-to-end flows (annotated
`events per attempt`): 3 events per attempt without uploads (`attempt.done` and two `clip.saved`),
6 with them (three `upload.state`); the demo flow's steady-state attempt shows 7, four of them the
demo cube's reconnection at each replay, which a real cube does not do. So about 1,000 a day at
150 attempts, under the cap and far under Firestore's 20,000 free writes.
Found on the way: a batch flushed at `pagehide` is not sure to reach the SDK's cache when the page
unloads at once (a reload, a closed tab), so the last seconds of events before one can be lost
(`docs/DIAGNOSTICS.md`; the cloud e2e awaits the attempt's events on the timer page for that reason);
and the kind `download` had no dot, so `cloudEvent` refused it in silence until the type of
`record`'s kind asked for one (it is `files.downloaded`). The QA view reads the events beside the
index (one more read). The initial bundle is 264.57 kB raw
against `main`'s 264.63 (its transfer estimate within a few tens of bytes of 72.6 kB, as before):
the same code but for the minifier's names; the writer rides in the chunk of `SettingsService` and
the services, which every page loads
right after the first render, 68.7 kB raw against 57.7 (21.3 kB transferred against 18.2), and the
QA page grows by its section, 16.2 kB raw against 9.5.

## Phases 4 and 5

Outlines only, written into boards when phase 3 ends: **4. Remote cameras** — WebRTC pairing by
QR code, the data-channel clock sync of the private design (§6), remote cuts and clip transfer in
16–64 KB messages with backpressure, the desk rig with one or two phones; **5. Community** —
consent flow, quotas, delete-my-data, community mode (§12 of the private design). Two decisions
already taken that they must respect: the bucket provider is a configuration, and audio is
recorded by default.
