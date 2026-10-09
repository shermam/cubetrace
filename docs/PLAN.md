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
| 3. Cloud | Firebase auth, session index, upload queue with signed URLs (R2 or GCS by configuration), budget alert, QA view across devices. | ✅ 0.3.0 (2026-10-02: T3.0–T3.6 merged and deployed; the tag from the GitHub UI on 2896591 or later). Follow-ups T3.6–T3.9 merged the same day (the installed app's sign-in, the cube's whole record, the 3D cube in the clip viewer, the diagnostics events), for 0.4.0 |
| 4. Remote cameras | WebRTC pairing by QR, clock sync, remote cuts, clip transfer over the data channel. | ✅ 0.4.0 (2026-10-04: T4.0–T4.4, T4.2a and T4.2b merged and deployed; the tag from the GitHub UI on 16ad587). Open: #61 closes when a pairing stays converged for 20 minutes; the measured cells of `docs/DEVICES.md` |
| 5. The rig's eyes and hands | The phone's picture at full size with its health, remote camera controls from the laptop, the host's capture latency measured per attempt. | in progress (2026-10-09: the board below, T5.1–T5.4; issue #67) |
| 6. Community | consent flow, quotas, delete-my-data, community mode. | ⬜ |

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
Found after phase 3 (2026-10-03), also unscheduled: (f) the clip viewer's drag turns cubing.js's camera
orbit, whose latitude stops at the poles and which has no roll, so some orientations of the cube in the
picture cannot be reached by dragging (issue #57; the fix rotates the puzzle itself with a view
quaternion in place of the orbit); (g) ~~after the phone deleted uploaded clips by policy, the queue
re-uploaded `attempt.json` for some 35 old attempts at once (14 KB each, harmless, but every file
counts against the day's quota): the record's re-saves that change nothing the dataset holds should
not re-sign the file~~, done by T4.2a (#63): the deletion saves nothing, the device keeping which
clips it holds in `uploads.json` and the attempts' folders; (h) a diagnostics batch flushed as the
page unloads can be lost (T3.9): a `keepalive` REST write would close it; (i) the other
`settings.changed` events, `wake.lock` and
`storage.persistence` are recorded in effects (T3.9), so a change followed at once by an unload loses
its event (the Diagnostics switch itself settles before the page goes since #59), and a switch toggled
before `AuthService` attaches the account goes to the ring, which a toggle off then clears. (j) ~~The remote camera's picture on the host (T4.1) is the thumbnail at the bottom of the Camera
panel, too far from the host's preview to keep the cube in the phone's frame while solving (issue #60):
T4.3's live preview belongs next to the host's preview on the Timer page, the thumbnail staying in the
Cameras list as the pairing's state~~, done by T4.3 (#65): each phone's live picture is a tile
over the Timer page's preview, a tap swapping it with the main picture, its thumbnail the fallback. (k) ~~The remote clock fit never converged in the first real
pairing (two connections of 12 and 4 minutes on the home Wi-Fi, no `rtc.clock` event; issue #61):
`REMOTE_CLOCK_CONVERGED` was tuned on loopback and simulations; T4.2 was told not to gate the cuts on
`converged` (the current estimate, a padded window, the numbers in the record); T4.3 measures the real
round trips and tunes the criterion~~, done by T4.2b (#64): the fit keeps at least its ten samples of
least round trip of two minutes, converges within 5 ms and is withdrawn by a sample its round trip
cannot explain, the host pings every 500 ms until it converges, and `rtc.clock` says the window's
round trips every minute, converged or not; T4.3 measures the Wi-Fi again. (l) ~~New session right
after a solve lets the paired phone go before its last clips come (T4.2 notes them missing): the host
should hold its `leave` at the session's end while cuts are unanswered, for a bounded time (10–15
s)~~, done by T4.2b (#64): the host keeps the phone until its clips of the ended session are stored,
refused or given up, 15 s at most. (m) ~~A paired phone adds about six diagnostics events per
attempt on the host, so the daily cap of 2,000 (`DAILY_CAP`, T3.9) is reached at about 155 attempts a
day with the owner's cadence of 130–170: raise it (Firestore's cost is nothing at that scale)~~, done by
T4.2a (#63): the cap is 5,000. (n) "attempt N could not be indexed: Missing or insufficient permissions" on the
phone (3 times on 2026-10-03/04): a record re-saved in a later page load rewrote its index document with
`upload` reset to pending, which the rules refuse (`keepsUpload`); #63 removed the main trigger (the re-save
when clips are deleted by policy); a late re-save of an older attempt (a remote clip after a host reload)
still hits the index's per-page-load `created` and the refused `upload`. (o) When core's reader gains a
defaulted field, every older record reads back as a new text and the queue signs its `attempt.json` once
more at the next reload of its session (T3.7 did this once for all earlier records): hash the file as
written, or leave the reader's defaults out of the hash. (p) The peer documents of a call no host page ever took
(`sessions/{id}/peers/{peerId}` with their candidates) are never deleted: the host deletes them when a
connection ends or a call is refused, and the hour's cleanup of the phase 4 design was not built; harmless
at one solver, a Cloud Function or a startup sweep later. (q) The phone's goodbye reads twice ("The host let
this camera go: The host let the camera go: the session ended."); a unit spec asserts the text, so both
change together. (r) An attempt's index document can stay at `upload.state: uploading` although every
file is in the bucket (session 8afffe34, attempts 180 and 183 on 2026-10-04: six objects each in the bucket,
one file each unconfirmed in the index, after the refused index write of (n)); the round report then counts
the attempt as not uploaded (item 3.3.4, 54 of 55). The queue should write the index's `done` again when
`uploads.json` has every file done and the index disagrees, and the report could read the bucket's listing.

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
| T3.8 | `web`: a 3D cube in the clip viewer that follows the video: its orientation from `gyro.json`, its turns from the moves, the camera's lag applied; no live 3D cube on the timer page (the owner's decision: the solver watches the real cube, and WebGL would compete with the capture) | T3.7 | ✅ #54 (2026-10-02; the frame mapping did not match exactly at the owner's first look, issue #55: T3.10) |
| T3.10 | `web`, `core`, `firebase`: the viewer's cube under the video, seen straight on; viewpoint presets and drag (the player's camera orbit), a mirror switch, the choice saved per camera on the device and in `users/{uid}.viewer` (issue #55) | T3.8 | ✅ #56 (2026-10-02; the owner calibrates on a real clip: "After T3.10") |
| T3.9 | `web`, `core`, `firebase`, `scripts`: diagnostics events in the account (`users/{uid}/events`, create-only by the owner, nothing while signed out): evidence for the manual rounds' items without the owner writing them up, a Settings switch, and a report script the coordinator runs with the service-account key to tick the rounds' checklists | T3.1 | ✅ #53 (2026-10-02; 35 kinds, 92 of the 110 checklist items with event evidence; the coordinator runs `npm run round-report`) |

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
written at a sign-in during the page's life; a cap of 2,000 a local day (5,000 since T4.2a), then
`error.*` alone;
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

### T3.8 — `web`: a 3D cube in the clip viewer that follows the video: its orientation from `gyro.json`, its turns from the moves, the camera's lag applied

Since T3.7 each attempt of a cube with a gyroscope has a `gyro.json` beside its clips. The owner
wants to see, in the clip viewer, a 3D cube beside the video that tilts and rotates as the real one
did and turns with the moves, in time with the picture; no live 3D cube on the Timer page (the
solver watches the real cube, and WebGL would compete with the capture pipeline). Contract: (1)
cubing.js's `<twisty-player>` in the viewer's body beside the video, 3D, no control panel, no drag
input, transparent background, hint facelets off, from the scramble view's lazy chunk
(`TWISTY_LOADER`), as tall as the video on a laptop and under it on a phone; shown whenever a local
clip plays, and when the attempt has no gyro file the cube still turns with the moves and a line
says the orientation is not recorded. (2) Time: the video's `t` shows the world at host time
`firstFrameHostMs + t·1000 − lag`, `lag` the clip's `syncResidualMs` (0 when null); the cube's state
then is the record's moves at or before it on the segment's starting state (the scramble as the
setup alg for the solve clip, solved for the scramble clip, a mis-scramble's corrections included);
its orientation the gyro sample then (slerp between neighbours; the first or last sample beyond the
span; nothing before a truncated file's first sample); the moves list applies the same lag. (3)
Following: every frame while it plays (`requestVideoFrameCallback`, else `requestAnimationFrame`) and
on `seeked`, `timeupdate` and pause; the next move added with `experimentalAddMove` so that it
animates, at a tempo that completes a turn in about 100 ms; after a seek, or when more than one move
passed since the last frame, the state rebuilt without animation; the orientation set on the
puzzle's `Object3D` through `experimentalCurrentThreeJSPuzzleObject()` and rendered through the
vantages, only when it changed; nothing while the dialog is closed, everything released when it
closes. (4) Frames: the cube's +X red, +Y blue, +Z white; cubing.js's +X R, +Y U, +Z F; `(x, y, z) →
(x, z, −y)`, a rotation of −90° about X, `q → r·q·r⁻¹`, in a pure module with the slerp (shorter
arc), the interpolation (binary search) and the reference; by default relative to the clip's first
sample (`conj(q_ref)·q`), "Re-zero" takes the current time, "Raw" shows the samples as they are; a
manual item ("After T3.8") checks the mapping on a real recording, the mapping in one constant. (5)
`gyro.json` read through `ATTEMPT_FILES` and `parseGyro`, failures shown in one line. (6) Tests: unit
for the pure module, the time mapping with and without lag, the interpolation, the moves-so-far and
the rebuild-versus-animate decision; component tests of the viewer with `TWISTY_LOADER` replaced;
one end-to-end flow with `?gyro=1` and the camera on, watching the puzzle object's quaternion and
the highlighted move while a clip plays, and the line of a clip without a gyro file. (7) Docs. (8)
The lazy chunk's size before and after, and the per-frame cost. (9) Nothing else: no version bump, no
workflow change, no new dependency.

**Outcome (2026-10-02).** As contracted, with these choices. The maths live in `packages/core`
(`orientation.ts`: a `[x, y, z, w]` tuple type, `multiply`, `conjugate`,
`slerp` along the shorter arc with a linear fallback for near-equal orientations, `orientationAt`
over a `GyroTrack` whose sample times are the file's intervals summed in tenths of a millisecond,
`referenceAt`, `shownOrientation`, `toPlayerFrame` with the constant `CUBE_TO_PLAYER = (−√½, 0, 0,
√½)`, and `cubeStep`; `clip.ts`: a clip's time on the host clock with the camera's lag, `clipHostMs`
and `clipSeconds`), so that the end-to-end flow computes from the gyro file the app wrote what the
viewer must show, and the player's driving in `clip-cube.ts` (`ClipCube` over a `CubePlayer`
interface of the six members used: `alg`, `experimentalSetupAlg`, `timestamp`,
`experimentalAddMove`, `experimentalCurrentThreeJSPuzzleObject`, `experimentalCurrentVantages`,
which the compiler checks against cubing.js's `TwistyPlayer` in the spec), so that the viewer's tests
run on a fake `<twisty-player>` defined in jsdom and never load cubing.js. The player's alg is the
moves shown so far and its setup the segment's start: a move on is `experimentalAddMove` (no
cancellation, so the alg stays the record's moves, one per turn), whose catch-up animation cubing.js
runs over 500 ms divided by `tempoScale`, set to 5; a rebuild sets `alg` to the moves up to the time
and `timestamp` to `end`. The orientation compares as `1 − |a·b| < 1e-9` (q and −q alike, a hundredth
of a degree) before a render. The reference is the sample at the host time of the clip's first frame
(the lag applied), or the file's first sample when the clip begins before a truncated file; before
a truncated file's first sample the cube is shown upright and the line says from when the
orientation is recorded. Sizing is by CSS alone: on a laptop the body's columns are the video, the
cube and the 9rem moves list, the cube's column the share `height / (width + height)` of the clip's
frames of what the video and the cube have (`--cube-share`), which makes the square as tall as the
16:9 picture; on a phone the cube is 12rem under the video. `session-page.spec.ts` now replaces
`TWISTY_LOADER` too, since the viewer would load cubing.js in jsdom. The known limitation of round 2
("the highlighted move can lead the picture by the sync check's lag") is closed. Found on the way:
the demo's gyroscope starts over at each replay (`replayDemo` connects a new fake cube, its angle
from 0) while the page's gyro buffer keeps the previous cube's samples, so a demo attempt's file
begins with the previous cube's orientation and jumps to the new one's: the viewer's reference is
then the previous cube's, and the solve's turn runs from about 37° away back towards it, which an
early version of the end-to-end check, polling the quaternion while the video played, caught only
when a poll fell in that second (it failed under the full suite's load); the check now seeks to
the solve's middle, plays to the end and seeks back, and compares the quaternion, the alg and the
highlighted move with what core computes from the file at those moments. Sizes
(`ng build`, against `main` at 4be2a6d): the initial bundle is unchanged (264.57 kB raw); the
viewer's lazy chunk (`clip-viewer-<hash>.js`, the pages' `@defer`) is 18.5 kB raw, 6.4 kB gzipped,
against 11.4 and 4.2 (the cube's driving, the controls and the styles); the chunk of core and the
services, which every page loads after its first render, is 71.1 kB raw against 68.7 (the CLI's
transfer estimate 22.1 kB against 21.2: the orientation maths, the clip's time mapping and
`parseGyro`'s reader); the scramble view's chunk (`cubing/twisty`, 116.5 kB raw, 32.8 kB gzipped) is
unchanged and shared, `TWISTY_LOADER` now in a module of its own (`twisty-loader.ts`, a 163-byte
chunk; the Timer page's chunk is 31.2 kB as before), so that the viewer does not pull the scramble
view in; cubing.js's 3D code, `twisty-dynamic-3d` (509.2 kB raw, 131.9 kB gzipped; the CLI's estimate
108.9 kB), was already emitted and prefetched by the service worker and is now loaded, by cubing.js
itself, the first time a clip is opened; all the scripts together 3,540.7 kB raw against 3,531.1
(1,010.5 kB gzipped against 1,007.1). Per frame: one scan
of the segment's moves (at most a few hundred), one binary search over the samples, one slerp, one
`quaternion.set` and one `scheduleRender` when the orientation changed, plus cubing.js's own render
of a move in progress. Left for the owner: the frame mapping on a real recording
(`docs/MANUAL-TESTS.md`, "After T3.8"), since the driver's documentation of the gyro's axes is all
it rests on. The owner's first look at a real clip (issue #55, 2026-10-02, a screen capture) liked
the cube but found its tilt not matching the hands' exactly, which two things in the viewer kept
from a fair comparison — cubing.js's camera looks at the puzzle from above and to the right by
default, so an upright cube already looked tilted, and the reference is the clip's first frame,
where the cube is held at any angle — and asked for the cube under the video and for controls of the
view; T3.10 below answers with the straight-on view, the presets, the drag and the mirror, kept per
camera.

### T3.10 — `web`, `core`, `firebase`: the clip viewer's cube under the video, seen straight on, with viewpoint presets, drag, a mirror switch and the choice saved per camera (issue #55)

The owner's first look at the 3D cube on a real clip (issue #55) asked for three things: the cube
under the video, not beside it; a view from which its tilt can be compared with the hands' (the
default view of cubing.js looks from above and to the right, and the reference frame is wherever the
cube was held at the clip's first frame); and controls to set the view by hand, since cameras in
other places are coming (a phone behind the cube while the laptop films from the front), so that the
face a video shows and the side a tilt goes differ per camera. The frame mapping (`CUBE_TO_PLAYER`,
`(x, y, z) → (x, z, −y)`, the orientation relative to a reference as `conj(ref)·q`) matches the
driver author's own three.js sample (`new THREE.Quaternion(qx, qz, -qy, qw)`, premultiplied by the
conjugate of the first sample), so it stays the default. Contract: (1) layout: the cube under the
video, as wide as it and about half its height on a laptop (the dialog `min(56rem, calc(100vw −
2·gutter))` wide, the moves beside the player's column as before; on a phone the video, the cube,
the moves), its controls under it in one or two rows, the segment buttons above the video. (2) A
straight-on view by default: cubing.js's camera latitude 0 and longitude 0, so that "upright" is
drawn upright and a tilt to the right shows to the right. (3) Presets and drag: "Turn ◀ / ▶" (90° of
longitude), "Tilt ▲ / ▼" (90° of latitude, within what the camera allows), "Behind" (longitude 180°),
"Reset view" (0, 0), and a drag with the mouse or a finger through cubing.js's own drag input (a
click adds no move), the orbit read back after a drag so that it can be saved. (4) Mirror: a select
under the cube, none | left–right | up–down | front–back | all, applied to the orientation shown
(`orientation.ts`, pure, tested): a reflection across a plane turns a rotation about an axis `n` by
`θ` into one about the reflected axis by `−θ`, so `(x, y, z, w)` becomes `(x, −y, −z, w)` across the
plane normal to X, `(−x, y, −z, w)` for Y, `(−x, −y, z, w)` for Z, and the conjugate for all three,
applied to the relative orientation in cubing.js's axes. (5) Saved per camera label (the clip's
`camera`): in `SettingsService` (`localStorage`, a map by label) and, signed in, as a `viewer` map
on `users/{uid}` (`{[label]: {latitude, longitude, mirror}}`, `docs/DATA-MODEL.md` §10, the
record's schema, the rules' allow-list and a shape check with tests), written with a merge when the
user changes it, read once at sign-in (`AccountBackend` gains a read of the record) and merged with
the device's (the account's wins for a label the device has not set); "Re-zero" and "Raw" per clip,
not saved; a clip of a camera with no saved choice uses the defaults. (6) One line of help under the
controls. (7) Tests: the mirrors, the per-label merge, the record's `viewer` (parse, schema, rules),
the viewer's controls, and T3.8's component and end-to-end tests updated for the layout, with the
saved viewpoint restored on a second open. (8) Docs. (9) Nothing else: no version bump, no workflow
change, no new dependency, no live 3D cube on the Timer page, the frame-mapping constant unchanged.

**Outcome (2026-10-02).** As contracted, with these choices. The player's camera: the attributes
`camera-latitude="0"`, `camera-longitude="0"`, `camera-latitude-limit="90"` and
`camera-distance="5"` give the first render the straight-on view (cubing.js's defaults are 35° and
30°, its latitude limit 35°, its distance 6; at 5 the cube is a fifth larger and its space diagonal,
0.87 from the centre, still fits the 20° of vertical field, 0.88 at that distance, so no tilt clips a
corner); every later view is one request of the model,
`experimentalModel.twistySceneModel.orbitCoordinatesRequest.set({latitude, longitude})`, both
angles at once, since the two setters would make the model report an intermediate orbit; and the
orbit is read back through `orbitCoordinates.addFreshListener`, which reports once at first and
then at each change, the drags and their inertia included. `ClipCube` keeps the orbit reported, the
orbit requested and whether the model has echoed it: a report before the echo (the model's own
default orbit, racing the first request) is not a drag, the echo opens the gate, and what follows is
the user's; a view is not requested when the camera is within a tenth of a degree of it (the orbit a
drag leaves is saved rounded to a tenth, and asking for it again would move nothing), and the
presets build on `target`, the request on its way when there is one, so that two quick clicks add up.
cubing.js keeps the longitude in (−180, 180], as the choice does, so "Behind" reads 180 on both
sides, and `sameOrbit` takes −180 and 180 for one longitude all the same. The mirror is applied after the frame change, in cubing.js's axes (reflecting the relative
orientation before the frame change across the corresponding plane of the cube's frame gives the
same, which a test shows). The choice is normalized (tenths of a degree) and compared by what it
shows; the defaults for a camera without an entry are never stored (so a drag back to the front, or
Reset view on a fresh camera, leaves nothing), while Reset view on a camera with an entry keeps the
defaults in it; at most 8 cameras, the oldest dropped first. The rules check each entry of `viewer`
by its place in the map's list of values (the rules language cannot loop): 16 entries exceeded the
engine's budget of 1,000 expressions per request in the emulator (both the create and the update
statements are evaluated), 8 fit with room, so the cap is 8 in the rules, the schema and the device;
Firestore itself refuses an empty label before the rules see it. The sync (`ViewerSyncService`,
made by the header's controls as the cube sync is): the record read once per sign-in or start signed
in, the merge as contracted, then the account written the device's choices that differ from or are
missing in it, and from then on each change a second after the last (a drag is one write), the
cameras changed in one merge, against what the account is known to hold; a write lost with the page
is made up by the next start's merge; nothing is written at sign-in when the device has no choice, so
the account's record stays exactly the sign-in's (the cloud end-to-end test of T3.5 still holds). The
drag's `touch-action: none` keeps a finger on the cube from scrolling the dialog. A slice move (M, S,
E) is a check of the orientation (the owner's second look at the capture): the cube reports a slice as
two opposite outer-layer turns relative to its core (`docs/DATA-MODEL.md` §2) while the core itself
rotates with the middle layer, which the gyro records, so that shown together the two turns and the
core's rotation reproduce the middle layer turning in space; outer layers that seem to turn mean the
orientation shown is off (or lags the turns' animation), which the "After T3.10" item says. Sizes
(`ng build`, against `main` at e6c9942): the initial bundle is unchanged (264.57 kB raw, `main`
261.5 kB byte for byte the same but for the lazy chunks' hashes); the viewer's lazy chunk
(`clip-viewer-<hash>.js`) is 23.7 kB raw, 7.8 kB gzipped, against 18.5 and 6.4 (the controls, the
orbit's driving and the styles); the header's controls chunk, which every page loads after its first
render, 5.7 kB raw, 2.4 kB gzipped, against 2.7 and 1.2 (`ViewerSyncService`); the chunk of core and
the services 73.3 kB raw, 25.1 kB gzipped, against 71.1 and 24.4 (the mirrors, the choice's model
and Settings' map); the Settings page's chunk unchanged; all the scripts together 3,551.2 kB raw
against 3,540.7 (1,018.0 kB gzipped against 1,014.7). Per frame nothing was added to T3.8's loop but
the mirror's four sign changes; a drag costs, per report, a settings write (one JSON of a few
kilobytes in `localStorage`) and, signed in, nothing until a second after the last one.
Found on the way: the fake of the player's model first kept the longitude in [−180, 180), as
cubing.js's `modIntoRange(v, 180, −180)` reads at a glance, and the real player, in the end-to-end
run, reported a view from behind as 180: the fake now does as the player does, and the orbit's
comparison took ±180 for one longitude from the start, so nothing in the viewer depended on it; the
clip viewer's spec, the sync's and the settings' each caught a test written against a stale
assumption (the lag of the fake clip in an expected angle, two preset clicks before the model's
report, the defaults rule); the component's dialog scrolls on a short laptop screen (a
16:9 video at the column's width plus half of it again exceed 790 px of viewport), which the video's
and the cube's maximum heights limit. Left for the owner: the calibration on a real recording
(`docs/MANUAL-TESTS.md`, "After T3.10"), the drag with a finger on the ThinkPhone, and whether the
straight-on view and a mirror make the tilt match; a mapping that no mirror fixes is still
`CUBE_TO_PLAYER` alone.

## Phase 4 task board — remote cameras

**What phase 4 delivers.** The desk rig: the laptop hosts the session (the cube, the timer, the
attempt's assembly, the upload) while one or two phones film it from other angles, each phone
recording its own camera at full quality and handing the host two clips per attempt, so that an
attempt's folder holds `laptop.solve.mp4`, `phone-rear.solve.mp4`, their scramble clips and frames
files, all on the host clock, uploaded as today. The private design's §3, §4, §6 and §7 are the
reference; the decisions below are its decisions made concrete against the code as it is after
phase 3 (T2.0–T2.14, T3.0–T3.10).

**Decisions.**

- **Same app, two roles.** The device that opens a session is the *host*; a phone that joins it is a
  *camera device*: the same build, on a page of its own (`/camera`), running the capture pipeline
  of phase 2 (`packages/capture`: WebCodecs in a worker, the ring buffer, the cuts, the MP4s) and
  nothing of the timer. Both devices are signed in to the same account (phase 3): the pairing's
  documents live under the account's own data, and the rules let no one else read or write them.
  A LAN-only pairing without the account is v2 (design §13.13).
- **Stream for control, record locally for data** (design §4). The connection carries the clock
  pings, the cut commands, the camera's state, a preview the host can frame by, and finally the
  finished clip files, over one reliable ordered data channel; a low-bitrate video track for the
  live preview comes in T4.3 and is never data. Nothing is transcoded on the host.
- **Transport and signaling.** `RTCPeerConnection` with Google's public STUN server and no TURN:
  the home Wi-Fi connects the two directly, a guest or office network with client isolation does
  not, and the office rig stays the laptop's own webcam (design §4). Signaling is the FirebaseRTC
  pattern on the modular SDK: `sessions/{id}/peers/{peerId}` holds the offer and the answer, with
  `callerCandidates` and `calleeCandidates` under it; owner-only rules with shape checks; the host
  deletes a peer's documents when its connection ends or its call is refused (the hour's cleanup of
this design was not built: follow-up (p)). The QR the host shows is the app's URL
  with the session id and a one-time pairing token (`/camera?session=<id>&token=<t>`; the token is
  also typed by hand); the host accepts the first peer that presents it and refuses the token again.
- **Time.** The dataset stays on the host clock. The phone keeps its own (`performance.timeOrigin +
  performance.now()`); the host measures the offset over the data channel (the host sends `t1`, the
  phone answers with `t1, t2, t3`, the host receives at `t4`; the offset from the samples of least
  round trip, a linear drift fit over the session: design §6), converts the phone's frame times to
  the host clock when it stores a clip (`t0HostMs` converted, the phone's own `t0RemoteMs` kept
  beside it in the frames file), and records the fit in `session.json` as
  `clock.cameras[label].remote = {offsetMs, driftPpm, rttMs, samples, residualP95Ms}`. The
  clapperboard sync check (T2.8, T2.11) then measures the phone camera's own lag, as it does for the
  laptop's, and `syncResidualMs` means the same thing for every clip.
- **Cuts and transfer.** The host decides the windows (the margins of T2.4 and T2.9) and sends each
  `cut` in the phone's clock at the moment it cuts its own camera (`milestones$`: `armed`, `ended`,
  `dropped`); the phone cuts from its ring buffer, muxes, stages the MP4 and the frames file in its
  OPFS, and sends them in messages of 16–64 KB paced by `bufferedAmountLowThreshold`, resumable by
  offset after a reconnection, acknowledged by the host, then deleted on the phone. The host writes
  them into the attempt's folder under the camera's label, attaches them to the record
  (`attachClip`), and the upload queue sends them with the attempt (`ClipsInFlight` holds the attempt
  until the remote clips are in, up to a limit; a clip that comes later is uploaded as an addition).
- **Labels and records.** A remote camera is a camera of the session like any other
  (`session.cameras[]`, `labelFor`: `phone-rear`, `phone-front`, a second phone `phone-rear-2`), with
  a `remote` field naming the device (its host label and platform); its clips are `video[]` entries
  with the same fields, their `camera` the label; a sync check's result is `clock.cameras[label]` as
  today. Schemas stay at version 2 with the new fields optional, like T3.7's.
- **The host arms as today.** Remote cameras are additive: an attempt never waits for a phone to
  be framed, synced or connected; what a phone misses is a missing clip, noted in the session's
  notes, never a lost attempt.
- **Tests without hardware.** `packages/rtc` keeps the transport and the signaling behind
  interfaces with in-memory fakes, so that the unit tests and the fast end-to-end suite run
  without WebRTC; the end-to-end suite pairs two pages of one browser through a fake signaling on
  a `BroadcastChannel` and the real `RTCPeerConnection` on the loopback interface; the cloud suite
  signals through the Firestore emulator.
- **Decisions of earlier phases that hold:** the bucket provider is a configuration; audio is
  recorded by default, on the phones too; the `cubing.js`, mediabunny and Firebase choices stand.

| Id | Task | Depends on | Status |
|---|---|---|---|
| T4.0 | `rtc`: the data-channel protocol, chunked transfer with backpressure and resume, the clock sync maths, Firestore signaling with rules and the pairing token, in-memory fakes | T3.5 | ✅ #58 (2026-10-03) |
| T4.1 | `web`: the Camera page (join by QR or token, preview, framing, sharpness, state) and the host's Cameras panel (Add camera, the list, thumbnails); the connection's lifecycle; the clock sync running; the camera registered in the session | T4.0 | ✅ #59 (2026-10-03) |
| T4.2 | `web`, `capture`, `upload`: remote cuts and clip transfer into the attempt's folder and record; the upload of remote clips, late clips as additions; diagnostics events | T4.1 | ✅ #62 (2026-10-04) |
| T4.2a | `upload`, `web`: deleting an uploaded clip leaves its record as uploaded (no `attempt.json` re-signed; `local` from the folder); the diagnostics daily cap 5,000; the clock record's effect on `session.json` measured | T4.2 | ✅ #63 (2026-10-04) |
| T4.2b | `core`, `rtc`, `web`: the clock fit keeps its ten least round trips (two-minute window, 5 ms spread, a clock-jump check), 500 ms pings until converged, `rtc.clock` with the link's distribution; the first call retries, the host's hello second (a lost-hello bug); the leave at New session held for the last clips (15 s) | T4.2a | ✅ #64 (2026-10-04) |
| T4.3 | `web`, `capture`: the sync check on a remote camera; frame times converted with the drift fit; the live preview track; measurements in `docs/DEVICES.md` | T4.2 | ✅ #65 (2026-10-04) |
| T4.4 | the desk rig: docs, "After T4" items, the round report's checklist, `0.4.0` | T4.3 | ✅ #66 (2026-10-04) |

Waves: T4.0 → T4.1 → T4.2 → T4.3 → T4.4, one agent at a time.

### T4.0 — `rtc`: protocol, transfer, clock sync, signaling

**Goal.** Everything of the connection that needs no browser: a new workspace package
`packages/rtc` with the typed messages of the data channel, the chunked file transfer, the clock
sync maths, the signaling over Firestore, and the fakes the tests of T4.1–T4.3 drive.

**Scope.** `packages/rtc/src/`: `protocol.ts` (the messages, versioned: `hello` with the device's
host label, platform, build and camera capabilities; `ping`/`pong` with `t1, t2, t3`; `state`
(the camera's framing, sharpness, recording, battery and thermal hints, pending clips); `thumbnail`
(a JPEG of at most 320 px, every 2 s); `cut` (attempt, segment, from and to in the phone's clock,
the window's reason) and `cut-done`/`cut-failed`; `file-begin` (name, bytes, kind), `file-chunk`
(offset, bytes), `file-ack` (offset), `file-done`, `file-resume` (name, offset); `leave`), encoded
as JSON control frames and binary chunk frames; `transfer.ts` (the sender paced by
`bufferedAmountLowThreshold`, 16–64 KB chunks, resume from the last acknowledged offset, the
receiver assembling into a writable, integrity by length and a rolling checksum); `clock.ts` in
`packages/core` (`RemoteClockFit`: the offset from the least-round-trip samples of a sliding
window, a linear drift fit once the span allows, `toHostMs(remoteMs)`, `toRemoteMs(hostMs)`, the
fit's record for `clock.cameras[label].remote`, converged when the offset's spread is under 3 ms
over ten samples); `signaling.ts` (the `Signaling` interface: create an offer document, answer,
exchange candidates, close; `FirestoreSignaling` on the account backend, `MemorySignaling` for the
tests); `transport.ts` (the `Transport` interface over a data channel: send a frame, receive
frames, `bufferedAmount` and its low event, close; `MemoryTransport`, a pair joined in memory with
an optional delay and loss for the tests; `WebRtcTransport` on `RTCPeerConnection`, with ICE
restart on failure and the public STUN server); the pairing token (`pairing.ts`: 8 base32
characters, the URL for the QR, parse). Firestore: `sessions/{id}/peers/{peerId}` with `offer`,
`answer`, `callerCandidates/{id}`, `calleeCandidates/{id}`, the token's hash in the session's
`pairing` field written by the host; rules: the owner only, shapes checked, no reads by others;
tests in `firebase/rules.test.ts`. `AccountBackend` gains the few calls the signaling needs
(write and watch a peer document and its candidate collections), implemented in `firebase-sdk.ts`
and both fakes. Docs: `docs/DATA-MODEL.md` §6 (`clock.cameras[label].remote`, `cameras[].remote`),
§10 (the peer documents), a new `docs/RTC.md` (the protocol, the transfer, the clock sync, the
failure modes), `docs/ARCHITECTURE.md` (the package), `docs/TOOLCHAIN.md`.

**Acceptance.** Unit tests: the protocol's encoding both ways; the transfer of a 40 MB blob over
a `MemoryTransport` with a 200 ms delay and 1% loss in under what the pacing allows, resumed after a
cut in the middle, the checksum refusing a corrupted chunk; the clock fit's offset within 1 ms of a
simulated truth under 5–40 ms round trips with jitter, the drift fit within 10 ppm over a simulated
hour, convergence declared and withdrawn correctly; the signaling's offer–answer–candidates
sequence over `MemorySignaling`; the rules accepting the owner's documents and refusing everyone
else's and every wrong shape. No change to the app's pages; the bundle's initial size unchanged.

**Outcome (2026-10-03).** As contracted, with these choices. The protocol (`docs/RTC.md` §1) gained
`file-abort`, so that either side can give a file up with a reason (the sender after three refused
checksums, the receiver for a chunk that leaves a gap or a store with no room); the file messages
carry an `id` the sender numbers in `file-begin` beside the file's `name`, and the binary chunk
header is the id and the offset (13 bytes); `file-ack` says `done` once the file is complete and
checked, so that a periodic ack at the file's size is never taken for the end; a reader ignores the
fields it does not know within a version. The receiver never gives a file up on a checksum: it
discards and asks for it again from 0, and the sender counts (`MAX_CHECKSUM_RETRIES`, 2). The
`Transport` reports frames and state through callbacks (`onFrame`, `onBufferedAmountLow`,
`onStateChange`) rather than an async iterable, which the data channel's events map onto directly;
`MemoryTransport.pair` models the network as a reliable channel over a lossy link (a lost frame
arrives late and holds back those behind it, never drops), with a bandwidth and jitter, so that the
pacing has something to wait for; the clock the tests drive is `FakeTimers`, with `run(promise)`.
The `Signaling` interface is one peer connection's path for one role (`sendDescription`,
`sendCandidate`, `onDescription`, `onCandidate`, `onClosed`, `close`); `FirestoreSignaling` is a
session's for either device over a `SignalingBackend` of nine calls, which `AccountBackend`
extends (a type-only import of the package in the app; the bundle unchanged); `MemorySignaling` joins
a host and a phone over `MemorySignalingBackend`, and the unit-test fake of the account delegates to
one, so that T4.1's services pair in memory. The peer document carries `tokenHash`, so that the host
can check the token a peer presents against its pairing; `watchPeers` takes the account's uid for
`where('owner', '==', uid)`; the candidates, which carry no owner, are opened by the rules to the
session's owner (one `get` of the session's document per request), only under a peer that exists;
and a get of a deleted peer document is the owner's too, so that the phone's watcher sees the
deletion rather than a refusal. The token is Crockford's base32 (no I, L, O, U; the lookalikes read
as 1 and 0 when typed) and the pairing lasts 10 minutes by default; `checkPairing` reads the session
document's `pairing` alone, so that a record of another version still pairs. `RemoteClockFit`
measures the convergence spread on the residuals from the estimate (the line, once there is one), so
that a drift does not withdraw it; its `samples` are the kept ones and `since` the oldest of them.
The numbers (the simulations in `remote-clock.test.ts` and `transfer.test.ts`): the offset within
1 ms at round trips of 5, 20 and 40 ms with 1, 2 and 3 ms of exponential jitter per leg; the drift
fitted to 0.8 ppm over an hour; on a busy network (40 ms, 30 ms of jitter) the offset within 2 ms but
not converged, which the 3 ms rule makes a requirement on the Wi-Fi (a phone in power saving will not
converge: for T4.3 to measure); 40 MB over 200 ms at 20 MB/s with 1% loss in 2.9 s (14.5 MB/s; the
wire 2.1 s, the three retransmissions 1.8 s; at most 262,242 bytes queued: the threshold and one
chunk), the resume after a cut sending only the bytes left, a flipped bit caught and the file sent
again. `CameraInfo.local` is a boolean now (a remote camera's `remote` required exactly when it is
false, in the schema by `if`/`then` and in the readers); `parseCameraInfo` reads a camera alone, for
the phone's `hello`. The rules' tests grew from 135 to 180; the bundle's initial size is 264.57 kB
raw, as on `main`.

### T4.1 — the Camera page and the host's Cameras panel

**Goal.** A phone joins a session and is seen by the host: the connection's whole life, without
cuts yet.

**Scope.** `apps/web/src/app/camera-device/`: the `/camera` page, reached from the QR's URL or by
typing the token; it asks for the camera (the phone's rear camera by default, the controls of
T2.1), starts the capture pipeline with recording on (the ring buffer runs from the start), shows
its preview with the framing guide and the sharpness meter, the host's name, the connection's state
(joining, connected, reconnecting, left), the clock sync's state (syncing, converged, the round
trip), the battery and a thermal hint when the frame rate drops, and a Leave button; it holds the
wake lock and asks the user to keep the screen on and the phone plugged in; it reconnects by
itself (ICE restart, then a new offer) and resumes. The host (`apps/web/src/app/camera/`): a
Cameras section of the camera panel with Add camera (the QR and the URL), the list of remote
cameras (name, state, the latest thumbnail, the sync state, the sharpness), Remove; the remote
camera registered in the session (`putCamera` with `remote`, `labelFor`), its clock fit kept by a
`RemoteCamerasService` that owns the peers, the pings every 2 s and the fits. Settings: nothing new
beyond the phone's camera choice, which the Camera page keeps per device. Diagnostics: `rtc.paired`,
`rtc.connected`, `rtc.disconnected` (with the reason and the duration), `rtc.clock` (the offset and
the round trip at convergence) on both devices. Docs: `docs/ARCHITECTURE.md` ("Remote cameras"),
`docs/RTC.md`, `README.md`, `docs/MANUAL-TESTS.md` ("After T4.1": pair the ThinkPhone with the
MacBook on the home Wi-Fi, read the round trip and the offset, walk away and back, lock and unlock
the phone), `docs/DIAGNOSTICS.md`.

**Acceptance.** Unit tests of the services with the fakes; an end-to-end test with two pages of one
browser (the host with the fake cube and a fake camera, the camera device with a fake camera),
paired through a `BroadcastChannel` signaling and the real `RTCPeerConnection` on loopback: the host
lists the phone's camera with a thumbnail within 5 s, the sync converges, the camera is in
`session.json`'s `cameras[]` with `remote`, Leave removes it; the cloud suite pairs through the
Firestore emulator. Nothing changes for a session without remote cameras.

**Outcome (2026-10-03).** As contracted, with these choices. **The host.** `RemoteCamerasService`
(`apps/web/src/app/camera/`) owns the pairing and the peers; the Cameras section (`RemoteCameras`)
loads behind `@defer (when addRequests() > 0)` from a placeholder's Add camera in Camera settings, so
that a session without remote cameras downloads nothing of `@cubetrace/rtc` (one lazy chunk of
42.7 kB raw with the QR encoder; the initial bundle 265.96 kB raw against 264.57 kB on `main`, the
framework's deferred-block runtime); not `on interaction`, which rendered the block in the click's
own dispatch under `ng serve` and lost the press. The pairing lives in the session's document, so
Add camera needs the account and a session under way, and `SessionIndexService.indexForPairing`
writes a demo session's document too (this once and at its later saves; its attempts never): the
end-to-end suite pairs demo sessions, and the owner can try the rig without a cube. The QR code is
drawn by the app (`qr-code.ts`: byte mode, level M, versions 1–10, 250 lines; its test reads the
codes back with `jsqr`, a devDependency), the token shown under it as two halves. The first peer that
presents the token is answered and the pairing closed; a camera whose connection ended without a
`leave` stays listed as reconnecting for five minutes, during which its token is taken again (only
then: a second phone shown the same code cannot take a connected camera's place); a stale or wrong
offer has its documents deleted, which ends the phone's call at once. `hello` is answered within
10 s or the peer is sent away (another protocol version too). The camera's entry goes into the
session with `local: false` and `remote`, under the label the session gives it (`phone-rear`,
`phone-rear-2`: two phones told apart by their host labels), and the fit's record into
`clock.cameras[label].remote` at convergence and every minute after, the clapperboard fields at 0
until T4.3. **The phone.** `CameraDeviceService` and `CameraDeviceCapture`
(`apps/web/src/app/camera-device/`): the pipeline runs from the moment the page opens, through
`microphone.ts`'s `openMicrophone` (taken out of `RecordingService`, which the page does not use: it
follows the host's session and cube and would bring the timer onto the phone); `CameraService` gained
a role, the camera device's with a camera choice of its own and the rear camera by default
(`CameraChoice.facing`); a code typed without its link finds the session among the account's newest
20 by the token's hash; the page keeps a code across the sign-in; the reconnection calls again every
3 s for five minutes (each call fails after `WebRtcTransport`'s 30 s), then says the host is gone.
**Both sides** send `leave` and close the connection 250 ms later (`RTCPeerConnection.close` drops
what the channel holds; the word was lost in the first tests) and, on `pagehide`, send it and leave
the connection to the browser. The protocol gained `clock` (host to phone: `converged`, `offsetMs`,
`rttMs`), additive within version 1. **The clock fit** keeps a trip 3 ms over the least when that
is more than 1.5× it (`REMOTE_CLOCK_RTT_ALLOWANCE_MS`): between two pages of one browser the least
trip is 1.1 ms and 1.5× it kept 4 of 31 trips in a minute (the main threads encode video and measure
sharpness), so the fit never converged; the allowance keeps about half, is stricter than the factor
from a 6 ms trip up, and changes nothing on a Wi-Fi. The `FramingEditor` and the `SharpnessMeter`
left `CameraPanel` as components, reused on the Camera page. **Diagnostics:** `rtc.paired`,
`rtc.connected`, `rtc.disconnected`, `rtc.clock`, `rtc.failed`, and the "After T4.1" checklist (8
items) in `docs/DIAGNOSTICS.md` and the round report. **Tests:** the services with the account fake's
memory signaling, a memory connector that plays the SDP dance (`rtc-testing.ts`) and the harness's
fake clock (the host's 13, the phone's 15, the capture's 4, the two components' 10, the QR encoder's
9); the end-to-end pair over a `BroadcastChannel` signaling (`e2e/helpers/signaling.ts`) and the real
`RTCPeerConnection` on the machine's interface, in the encoding project, and the cloud pair through
the Firestore emulator. Counts and sizes in the pull request (#59).

### T4.2 — remote cuts and clip transfer

**Goal.** The attempt's folder gets the phone's two clips, named after the phone's camera, uploaded
with the attempt.

**Scope.** The host's `RecordingService` (or a `RemoteCutsService` beside it) sends `cut` for every
remote camera at the moments it cuts its own (`armed` → the scramble clip, `ended` → the solve clip,
`dropped` → nothing), the window in the phone's clock through the fit, and marks the attempt in
`ClipsInFlight` per expected remote clip; the phone cuts, muxes and stages (the clip worker of
phase 2, the files named `<label>.<segment>.*`), then transfers both files (the frames file first);
the host writes them into the attempt's folder (`writeAttemptFile`/the clip writer's atomic move),
converts the frames file's times to the host clock (`t0HostMs` from `t0RemoteMs` through the fit,
the fit's values in the file's `arrival` or a `remote` field), attaches the clip (`attachClip`:
`camera`, `firstFrameHostMs`, `truncatedStart`, the sizes) and acknowledges; the phone deletes its
copy once acknowledged and keeps it otherwise (a reconnection resumes the transfer; a phone that
rejoins the same session offers its pending clips first). A limit on the wait (120 s after the
attempt's end): after it the attempt goes to the upload queue without the clip and the session's
notes say which camera's clip is missing; a clip that arrives later is attached and uploaded as an
addition (`packages/upload`: an attempt whose files grew is signed again for the new files only).
Settings: "Record remote cameras" on by default. The QA view counts clips per camera label.
Diagnostics: `remote.cut` (sent, done, failed, with the window and the delay), `remote.clip`
(received, bytes, transfer time, throughput), `remote.clip.late`, `remote.clip.missing`. Docs:
`docs/DATA-MODEL.md` §5 (the files of several cameras), §7, §9 (`t0RemoteMs`), `docs/RTC.md`,
`docs/ARCHITECTURE.md`, `docs/MANUAL-TESTS.md` ("After T4.2": three solves with the phone paired,
the attempts' folders with four clips, the viewer switching cameras, the bucket's listing),
`docs/DIAGNOSTICS.md`.

**Acceptance.** The end-to-end pair records a demo attempt with the camera on both pages: the
attempt's folder on the host has the laptop's and the phone's clips, `attempt.json` lists four
clips with the right labels, the frames file of a remote clip has `t0RemoteMs` and a `t0HostMs`
that differs by the fake transport's offset, the upload (fake signer) sends nine files; a transfer
cut by closing the channel mid-file resumes after the reconnection; a phone that never answers
leaves a note and an attempt uploaded on time. Unit tests of the wait, the late addition and the
conversion.

**Outcome (2026-10-03).** As contracted, with these choices. **The clock estimate, a decision taken
on the coordinator's instruction:** the first real hardware test found that the remote clock fit
never converged on the home Wi-Fi, so nothing of T4.2 depends on `RemoteClockFit.converged`. The
cuts and the conversions use `clockEstimate` (`apps/web/src/app/camera/remote-estimate.ts`): the
fit's own estimate from 3 kept samples, before that the offset of the window's least-round-trip
sample (core's fit gained `least` and `rttP95Ms`); a cut waits only for the sync's first answer (10 s
at most). The window is widened on each side by the kept trips' 95th percentile plus the residuals',
and by 500 ms at least (`CUT_MARGIN_MS`: half a round trip is a symmetric path's worst error, Wi-Fi
power saving's 100–300 ms bursts are covered several times over, for about a second more video per
clip); the host trims nothing. The records say what each relied on: the frames file's `remote`
(`converged`, `samples`, `rttMs`, `residualP95Ms`, `offsetMs`, `driftPpm`, `since`, `takenMs`), each
`remote.cut` event (`converged`, `marginMs`), and a first cut writes the estimate into
`clock.cameras[label].remote` with `converged: false` when there is none (convergence overwrites it,
with `converged: true`). `REMOTE_CLOCK_CONVERGED` and the keep rule are unchanged. **The host.**
`RemoteCutsService` beside `RecordingService`, on the same milestones and windows (`clip-windows.ts`,
taken out of `RecordingService`); one `ClipsInFlight` entry per clip expected, released when it is
stored or given up 120 s after the attempt's end (`REMOTE_CLIP_WAIT_MS`); the files into the page's
memory, not OPFS (a clip is a few MB, and the page that holds the bytes is the one a reconnection
resumes into); the frames file converted by core's new `remoteFrames` (read by the new `parseFrames`)
and written before the MP4, the clip attached, then the new `clip-ack`. A clip given up is still
taken when it comes, noted late and uploaded as an addition; a phone that left (or was let go) gives
its clips up at once, a host page that goes gives up nothing. **The phone.** `CameraDeviceClips`
saves each cut through the capture's clip worker into `camera-clips/` (`SaveClipParams.staging`),
with an index (`clip-staging.ts`), offers its staged clips first over every connection to the session
until the host's `clip-ack`, stored or not, and deletes other sessions' clips when it joins one and
those older than a day when the Camera page opens. **The protocol** stays at version 1: `cut` gained
`camera` and `scrambleShown`, `cut-done` the capture's facts (`clip`) and `scrambleShown`,
`cut-failed` `scrambleShown`, and `clip-ack` is new, all additive (no build before cuts). **The
records:** `frames.json` keeps schema 2 with `t0RemoteMs` and `remote`, each requiring the other; the
remote clock record may say `converged`; a remote camera's clock entry before its sync check gives its
clips no `syncResidualMs`. The upload queue needed no change (a test shows an attempt held for a
remote clip, sent without it once released, and the late clip signed alone with `attempt.json`). The
QA view counts clips per camera label, the viewer names each clip's camera, "Record remote cameras" is
on by default in the Cameras section, and the round report has six "After T4.2" items. **Measured:**
the initial bundle 264.96 kB raw as on `main`; the Cameras section's chunk 40.45 kB against 26.72 kB,
the Camera page's 41.74 kB against 31.97 kB, the shared `@cubetrace/rtc` chunk 24.30 kB against
17.19 kB (the file transfer). `npm test` 1,349 package tests and 810 app tests; the end-to-end suite 79
in 7.9 min, the two tests of `remote-clips.spec.ts` 36 s and 40 s (a phone's clock 5 s ahead, read
back within 20 ms; a transfer cut past 100 kB and resumed); the cloud suite 4. **Left for later:** New
session right after a solve lets the phone go before its last clips come (they are noted missing); a
host page that reloads in the middle of a transfer starts that file again from 0 with the next
pairing; a phone adds about six events per attempt on the host, so a day with a phone reaches the
diagnostics' daily cap of 2,000 at about 155 attempts (5,000 since T4.2a); the convergence criterion
itself is T4.3's. PR
#62.

**After CI's runs of the PR** (each of its two runs failed one test of `remote-clips.spec.ts` in the
pair's fixture, never in the clips): the fixture waited for 4 samples on the host's sync line, which
counts the trips the clock fit keeps (`params.samples`: those within the band, 1.5 times the least
round trip or 3 ms over it), not the pings answered. Between two pages of one browser that both
encode, every ping is answered (16 of 16 in 30 s in a probe, and still with both pages' CPU
throttled 4, 12 and 25 times) but the fit's round trips have medians of 17 to 18 ms against a least
of 2 to 3 ms, so the band keeps 1 to 4: the e2e pair's kept count is low under load because of the
band, not because pings go unanswered (the fit's retuning is its own task, with issue #61's Wi-Fi).
The fixture now waits for what the tests need (the phone connected, an answer of the clock sync, whose
least-round-trip estimate places the clock within a few ms on loopback, and 6 s connected, for the
next attempt's lead and margin in the phone's buffer), a failed precondition prints the phone's pill
and problem line and the host's state and sync lines, and CI prints every failed test's
`error-context.md`. The first run's refusal (the phone joining for about 11 s, then refused) did not
reproduce here, even at 25 times; its timing is one of the two 10 s hello waits, the only deadlines of
that length on the path (the phone's first call does not retry, and the host's wait closes the
signaling under a phone still connecting), which a starved runner can miss, and the clock bend
touches neither; the next failure prints its reason.

### T4.2a — the record unchanged when its clips leave the device; the diagnostics' daily cap

**Goal.** Follow-ups (g) and (m), from the owner's account on 2026-10-03 (1,199 files signed against
the cap of 1,200, 228 of them `attempt.json` alone, in bursts after `storage.deleted`): deleting
uploaded clips by policy signs nothing again, and a day of solves with a paired phone stays within
the diagnostics' daily cap. Also: what the remote clock fit's record, written into `session.json`
every minute (T4.1), does to the queue.

**What changed.** (g) The deletion saved the whole record again only to set `video[].local` false
(`SessionService.markClipsGone`), and the save reached the queue as any other. The queue's hash leaves
`local` out, so a save from the timer's own copy signed nothing; but for any session but the current
one the record was read back through core's reader, which writes the defaults of the fields added
since the file was written (`truncatedStart`, `gyro`, `resyncs`), and any copy not byte for byte the
uploaded one is a new text to the queue: `attempt.json` again, alone. The re-save also rewrote the
attempt's index document, which, in a later page load than the one that created it, carries `upload`
all pending, which the rules refuse (`keepsUpload`): a note in the session, and its `session.json`
again. Now `releaseClips` (was `markClipsGone`) checks that the attempt is still there and has the
timer's copy of the current session say the clips are gone, in memory, and saves nothing;
`uploads.json` keeps `local` false; the queue keeps an MP4 missing from its folder done when
`uploads.json` (or the index, when that is lost) has it done; `clipsOnDevice`, around
`SessionService`'s store, sets `local` false on read from the attempts' folders (`AttemptFiles.list`)
and saves attempts without it, so that neither the record nor its index document holds device state.
Records written before keep their `local`, read as before. (m) `DAILY_CAP` is 5,000 (2,000 before).

**Outcome (2026-10-04).** As above. Measured: a record the store reads back otherwise than it was
uploaded, deleted by policy, is signed twice with the earlier release and once now (`queue.test.ts`,
and a check against the earlier hook by hand); the end-to-end flow (one page, records this build
wrote) signed `attempt.json` once before the change too, while its deletion wrote the attempt's index
document again (2 writes of it against 1, its `upload` reset to pending in the fake index) and the
device's `attempt.json` changed; now the file is unchanged byte for byte, the document not written,
and `attempt.json` signed once by the end of the test. Not changed: a reader that gains a defaulted
field gives every older record a new text, which the queue signs once more the next time it reads
that record's session from the device (at a start, or its 10-minute look at a session not settled):
by the code, T3.7's reader did so once for every record written before it. **The clock fit's record
every minute** (item 3): each write restarts the queue's two minutes of quiet for `session.json`
(`SESSION_QUIET_MS`), so it is not signed at all while a converged phone stays connected: in a
two-hour simulation (171 attempts, 1,026 files, a 10-minute pause), `session.json` is signed twice
without a phone (in the pause, and 1.7 min after the last attempt), never with the phone connected
throughout, and once, 2.1 min after its last record, when the phone leaves at 120 min; a host page
closed meanwhile sends it at its next start. Acceptable, and unchanged: it costs no quota and loses
nothing (the index has the session's document as it changes); writing the fit every 10 minutes
instead would let `session.json` go after each quiet window, up to six times an hour. PR #63.

### T4.2b — the remote clock fit retuned for real links, the pairing hardened, the leave held at New session

**Goal.** Follow-ups (k) and (l), and PR #62's one refusal at pairing, before T4.3 builds on the
clock sync: the fit converges on the owner's home Wi-Fi and between the end-to-end pair's loaded
pages, a pairing survives a missed deadline, and New session right after a solve keeps the phone's
last clips (issue #61, addressed; T4.3 measures the Wi-Fi again and may tune further).

**What changed.** (A) The clock fit (`packages/core/src/remote-clock.ts`, `docs/RTC.md` §4): the
band of the least round trip (1.5 times it, or 3 ms over it) kept 2 to 14 samples of 60 at the 36
cuts of the owner's 20.7-minute pairing on 2026-10-04 (the least trip 5.4 to 8.5 ms; those kept
agreed, their residuals' 95th percentile 0.7 to 1.7 ms), the count flapped around the ten that
convergence asks for, and 10 of the 36 cuts went converged; between two loaded pages of one browser
(CI) it kept 1 to 4 of 16. The estimate now stands on the band and on at least the 10 samples of
least round trip of the window, as a clock filter takes them (`REMOTE_CLOCK_MIN_KEPT`; the lower
half of a window of fewer than 20). The window is the last two minutes (`REMOTE_CLOCK_WINDOW_MS`; at
most 240 samples), not the last 60, so that the drift fit has its minute whatever the pings' rate.
Converged needs, as before, ten kept samples over ten seconds, their residuals spreading by less
than 5 ms (3 ms before), and now also no sample of the window farther from the estimate than half
its round trip and those 5 ms: a sample's offset is off by at most half its round trip whatever the
network did, so one farther off says that a clock moved (a phone that slept), and the sync is
withdrawn at that sample. `ClockPinger` pings every 500 ms until an answer leaves the fit converged,
or for a minute at most, then every 2 s. The `rtc.clock` event goes once a minute of the connection,
converged or not (`syncing` before convergence), with the window's round trips (`rttP50Ms`,
`rttP95Ms`, `windowSamples`, `keptShare`). (B) The pairing: the phone makes a first call that fails
again with the same token every 3 s until the pairing's ten minutes from its check are up (joining,
with why), and the host keeps the camera it took the token for listed as connecting, answering its
calls, until the pairing's ten minutes from the take are up; each side's hello wait is 15 s (10 s
before) and ends when the connection closes first; a late failure of a call that a newer one
replaced no longer touches the newer one; and the host says its hello once the phone's came: it
spoke first, the moment its channel opened, and that hello now and then never reached the phone's
page (7 of about 115 hello exchanges in the end-to-end runs while this was tested, the host's later
frames received; it had gone out before the phone's page had its channel open, as far as the clocks
tell), most likely what refused PR #62's first CI run rather than a starved runner. (C) At the
session's end, a camera connected with clips of the session still to come stays, listed as "waiting
for the phone's last clips (n)", until they are stored, refused or given up, or 15 s
(`FINISH_WAIT_MS`), then is let go as before; each remote camera belongs to the session it was
paired in, so that its clips go into that session's attempts and it is asked for nothing of the
next. The end-to-end reads of an attempt's files try again when they find no file (the app moves a
new file over the old, and a poll that hit that instant ended at once, once in the New session
test's runs).

**Decisions where the brief left room.** At least ten samples of least round trip, a count rather
than the suggested quarter of the window: with the faster first pings a quarter of a window of 120
samples keeps trips far over the least, and in the simulations it converged later and flapped more
(the home Wi-Fi: 18 s and 0 to 2 withdrawals in 20 minutes with a 5 ms spread, against 12 s and
none; two loaded pages: 2 to 15 withdrawals in 10 minutes against 1 to 3). A spread of 5 ms rather
than one relative to the kept trips' spread: a relative one let the busy network (40 ms, 30 ms of
jitter) converge, which must not; the check of each sample against its own round trip is what
catches a clock that moved, at once (after a simulated sleep, the phone's clock 100 ms back, the
band's rule claimed convergence 100 ms off for 53 samples in 11 of 20 pairings, T4.2b for 1). A
window of two minutes in time, which is the 60 samples of before at 2 s. The host's reservation of a
taken token lasts the pairing's ten minutes from the take, and the phone's retries the same from its
check, which comes first, so that a retry is always answered (no API change for the pairing's
expiry). Hello waits of 15 s. The host speaking second, rather than both sides at once with the
retry to catch a lost hello (18 s more for such a pairing). The leave a turn after the last clip's
acknowledgement, so that the phone hears `file-ack` before `leave`; a camera whose connection ends
while it waits for its last clips is let go at once (no offer of its session is watched any more).
The end-to-end test of New session lets the host wait 60 s rather than 15 (`finishWaitMs`), so that
a slow runner's transfer is not taken for the bound, which the unit tests hold.

**Outcome (2026-10-04).** As above, PR #64. Measured, the simulations (`remote-clock.test.ts`; the
band alone pinged every 2 s, T4.2b as `ClockPinger` pings): on the home Wi-Fi's (seeds 1 to 3, 20
minutes; least trip 5.4 to 8.5 ms, median 12 to 15) the band kept 3 to 26 of 60 (10 to 12 at the
median), converged after 98 to 104 s and was withdrawn 13 to 15 times; T4.2b converges after 10.5 to
12 s, is never withdrawn, its offset within 1.1 to 1.5 ms of the truth at the 99th percentile while
converged (2.3 ms at worst, two samples of one pairing) and 0.7 ms at the end, the drift 3 to 16 ppm
at the end for a true 5; between two loaded pages (5 minutes) the band converged after 130 s once
and never twice, T4.2b after 13.5 to 22 s, withdrawn 1 to 5 times, within 1.9 ms; the simulations of
T4.0 give their numbers as before; a phone's clock 100 ms back (20 pairings): the band's rule
claimed convergence 100 ms off for 53 samples in 11 pairings, T4.2b for 1. The end-to-end pair
(`remote-camera.spec.ts` three times each, on the development machine): converged 11.1 s after the
phone connected, the test 21.2 to 21.4 s; with `main`, 22.3, 42.5 and 78.7 s, the test 32.6 to 89.6
s. The host's hello was lost in 7 of about 115 exchanges of the end-to-end runs while it spoke
first, in none of 76 since. Bundle: the initial 264.96 kB unchanged; the Cameras section's chunk
42.91 kB (40.45 before), the Camera page's 42.07 kB (41.74), the `@cubetrace/rtc` chunk 24.88 kB
(24.30), core's shared chunk 80.29 kB (79.62). Tests: 1,356 package and 824 app unit tests (1,351
and 813 before), 80 end-to-end (79), 4 cloud.

### T4.3 — the sync check on a remote camera, the drift fit applied, the live preview

**Goal.** A remote clip's `syncResidualMs` means the same as a local one's, and the host frames the
phone by a live picture.

**Scope.** The clapperboard for a remote camera: the host runs the check as today (hold still, the
countdown, ten single turns) and sends the turns' host times, in the phone's clock, to the phone,
which runs the capture's clapperboard analysis on its own frames (`packages/capture`'s
`clapperboard.ts`, the changed-area metric, the centroid estimator and the trimmed spread of T2.11)
and answers with the offset and the spread; the host stores `clock.cameras[label]` with `remote`
beside it and applies the result to the phone's later clips as T2.8 does for the laptop's. The
frame times of remote clips converted with the drift fit at the clip's time, not the offset at
pairing. The live preview: the phone adds a video track from its camera stream, sent at a fifth of
the resolution and at most 300 kbps (`RTCRtpSender.setParameters`), shown beside the host's own
preview in the Timer page's always-visible preview area (a small tile per remote camera, tappable to
swap with the main picture; issue #60: the thumbnail at the bottom of the Camera panel was too far
from the host's preview to keep the cube in the phone's frame), the thumbnail kept in the Cameras
list as the pairing's state and as the fallback when the track does not flow; measured on the
ThinkPhone: the encoder's extra cost, the frame rate of the recording with and without it. Settings
→ Cameras: "Live preview from phones" on by default. `docs/DEVICES.md`: the "Remote cameras" table
(seeded by T4.2b) completed from the owner's pairings with T4.2b's `rtc.clock` fields (the window's
sample count, the kept share, the round trips' p50 and p95), the clock sync's spread, the data
channel's throughput, the transfer time of an attempt's clips, the sync residual of the phone's camera,
the phone's temperature after 20 minutes; `REMOTE_CLOCK_*` tuned again only if those numbers say so
(issue #61 closes when a pairing stays converged for 20 minutes on the home Wi-Fi). `docs/MANUAL-TESTS.md` ("After T4.3": a sync check on the paired phone, the residual
and the spread; the preview; twenty minutes of solves on the rig).

**Acceptance.** The end-to-end pair runs a sync check on the remote camera with the fake cube's
turns and a synthetic motion on the phone page's fake camera, the result stored and applied; the
preview track's presence asserted; unit tests of the conversion with drift.

**Outcome (2026-10-04).** As contracted, PR #65, with these choices. **The remote check's division
of labour**, as the coordinator's guidance preferred rather than the scope's letter: the phone
measures and the host matches. On `sync-start` the phone's capture worker measures each frame's
motion inside the phone's framing rectangle (the meter of the host's own check) and the phone sends
the series every 250 ms (`sync-motion`, `sync-meter`, `sync-error`; `sync-stop` ends it), each
frame's arrival and reception on its clock; the host converts them with the clock estimate of each
batch and runs the same `SyncRun` and `detectClapperboard` on the cube's turns, which never leave
the host clock: one code path, one `sync.check` shape (with `remote: true`, the phone and the clock
sync that placed the frames), one "Download check data". A phone's check starts from its own line
under the Timer page's preview, is never due by itself (the laptop's is), asks for the framing on
the phone while the phone's rectangle is wide (Start anyway), and ends as failed when the phone
cannot measure (its recording stopped included), leaves or loses its connection. **The result**:
`offsetMs` of a remote camera is the lag of its frames behind the cube on the host clock once
converted (`docs/DATA-MODEL.md` §6: the camera's latency and the phone's delivery, plus the clock
estimate's error during the check), kept in `clock.cameras[label]` beside the clock sync's record,
which its later records keep; `withSyncResidual` gives the phone's later clips their
`syncResidualMs`. **The drift at the clip's time**: the estimate is a line frozen when taken
(`RemoteClockFit.line()`, `RemoteClockLine`), taken with each cut and applied at the clip's first
frame when its files come; the frames file's `remote.offsetMs` is the offset applied there. **The
live preview**: a send-only video transceiver in the phone's first offer (no renegotiation; the
offer 2,740 characters with it, 458 without), capped by `PREVIEW_ENCODING` (a fifth of the
resolution, 300 kbps, 15 fps) and toggled with `replaceTrack` and `setParameters` at the host's
`preview` word ("Live preview from phones", Camera settings → Cameras, on by default); on the Timer
page, a tile per phone in the top right corner of the host's preview (`RemotePreviews`, deferred
until a phone is listed), the live video while the receiving track is unmuted, the thumbnail
otherwise, a tap to swap with the main picture, the first phone's picture the main one without a
camera of the host's own; the Timer page reaches the phones through `RemoteCameraRegistry`, without
the `rtc` chunk. **The measurement**: `preview.started` (the recording over the span without the
preview) and `preview.stopped` (the encoder's frames, rate, bitrate, ms per frame, implementation,
quality limitation and CPU share, and the recording over the span with it); the round report's
"After T4.3" items (4.3.1–4.3.5) read them with the check's and the clips' events (`remote.clip` now
says the lag its clip took). **The e2e**: the phone's page films a synthetic camera (the test
replaces `getUserMedia` with a 640 × 360 canvas whose square flips when told, so nothing enters the
app) and the test turns the demo cube through the dev server's `ng` API. Measured: the e2e found 122
to 148 ms in 13 runs for a synthetic lag of 120 ms (136 at the median; the flips 118 to 128 ms after
their turns as the pages' timers made them; the spread 2 to 42 ms); the preview in the e2e 128 × 72
at 15 fps, 4 kbps, 0.36 ms a frame (`libvpx`), the recording at 30.2 fps meanwhile; the conversion
in the simulations: a clip 10 minutes into a session with 50 ppm of drift within 1 ms (29 ms with
the offset at pairing), 20 minutes of the home Wi-Fi's clips within 0.64 to 0.89 ms at worst, a clip
after a five-minute sleep within 1 ms (five minutes off with the estimate when its files came).
Bundle: the initial 264.96 kB unchanged; the phone's Camera page chunk 48.85 kB (42.07 before), the
Cameras section's 45.91 kB (42.91), the `@cubetrace/rtc` chunk 28.08 kB (24.88), the sync check's
19.89 kB (15.09), core's shared chunk 81.21 kB (80.29), and the new `remote-previews` chunk 7.12 kB,
loaded once a phone is listed. Tests: 1,384 package and 841 app unit tests (1,356 and 824 before),
81 end-to-end (80), 4 cloud (4). Found on the way and fixed: the pipeline ends a motion watch
silently when it stops (the phone now says `sync-error`); the pair's fixture took "connected for 6
s" for 6 s of the phone's buffer, and its "recording" checks matched "not recording" (the phone's
capture has its first frames 2.2 to 3.3 s after its camera opens, after the connection, with the
preview or without it: it now waits for 6 s of the phone's recording); `uploads.spec.ts` read
`uploads.json` while the queue replaced it (`NotReadableError`, now read again); a unit test counted
a hello's wait to the half second after a real `crypto.subtle` hash (now waits for the call). Left
for later: the measured cells of `docs/DEVICES.md`'s Remote cameras table and its new table of the
preview's cost (the method is there, cell by cell from the events), the ThinkPhone's numbers with
and without the preview, and any retuning of `REMOTE_CLOCK_*`, which waits for them; issues #60 and
#61 for the coordinator to close.

### T4.4 — the desk rig, docs, `0.4.0`

**Goal.** Phase 4 usable at the owner's desk, documented, released.

**Scope.** `README.md` (the rig: how to pair, where to put the phones, the lamp, what to expect),
`docs/ARCHITECTURE.md` and `docs/DATA-MODEL.md` read through for phase 4, `docs/MANUAL-TESTS.md`
("After T4": the whole rig once, two phones if the second one is at hand), the round report's
checklist (`functions/scripts/report.mts`: the T4 items with their events), `docs/CHANGELOG.md`
(`## 0.4.0`, the Unreleased section of T3.6–T3.10 and T4.0–T4.3 folded in), the versions `0.4.0`
everywhere, `docs/USER-ACTIONS.md` (the release from the GitHub UI). No new behaviour unless the
rounds of T4.1–T4.3 found something small.

**Acceptance.** Everything green; the owner creates the release.

**Outcome (2026-10-04).** As contracted, PR #66. `README.md` has "The desk rig" (pairing, the
phone's place and framing, the lamp, the sync checks with the lags measured so far, what an attempt
and a session's end bring, a second phone, the records) and "Known limitations" (follow-ups (a),
(c), (d), (f), (h), (i), (n), (o), #61, the cells of `docs/DEVICES.md`). The read-through against
the code fixed `docs/DATA-MODEL.md` (the clock record's `samples` are the band and at least the ten
least round trips since T4.2b, not "within 1.5× the least"; nothing deletes the peer documents
"after an hour"; the example of a session with a phone's camera; ten files with a phone's clips),
`docs/ARCHITECTURE.md` (phase 4's events in the diagnostics' diagram, `files.downloaded`, the clip
converted at its cut, the uploads with a phone's clips, the cloud project's pairing), `docs/RTC.md`
(a second phone is `phone-rear-2`; the decisions above still say `phone-rear-2` and "after an
hour") and the quota of before 2026-10-03 in the README and round 3. `docs/MANUAL-TESTS.md` "After
T4" (ten items, a second phone if at hand) with items 4.4.1–4.4.10 in the round report and
`docs/DIAGNOSTICS.md`; the CHANGELOG's 0.4.0 (T3.6 was in 0.3.0); versions 0.4.0 and the lockfile;
the release and the round in `docs/USER-ACTIONS.md`. One change to the app: the clip viewer's
Download line counted four clips as "both clips".

## Phase 5 task board — the rig's eyes and hands

**What phase 5 delivers.** The owner runs the desk rig alone, the phone on a tripod out of reach:
everything he needs to see of the phone (its picture at full size, its sharpness, its frame rate, its
battery, whether it is hot) is on the Timer page in front of him, and everything he needs to change on
it (focus, exposure, white balance, zoom, the torch) is changed from the laptop. The two sessions of
2026-10-09 are the brief: a phone whose focus went manual by itself at solve 31 blurred twenty solves
before it was seen in a tile the size of a stamp; a phone that ran hot; and, found in the data
afterwards, the laptop's own capture latency rising by 75 ms from attempt 38 on in both sessions with no
sign in the app (issue #67).

**Decisions.**

- **Same protocol version.** New messages and fields are additive within version 1, as T4.2's and
  T4.3's were (`docs/RTC.md` §1): a phone on an older build drops what it does not know (`onError`),
  and the host says so where a control is missing.
- **The phone keeps its own controls panel; the host's is the same component over messages.** The
  truth about a phone's controls is its track (`getCapabilities()`, `getSettings()`): the host shows
  what the phone reports and sends what to change; the phone applies it through `CameraService`
  exactly as its own panel does (persisted per camera as today), and reports the outcome. A mode the
  camera changes on its own (the focus of 2026-10-09) is a *drift*: seen on both devices and undone
  by the device that owns the camera.
- **The picture first.** A phone's live preview is shown at the host's own picture's size by default
  ("Pictures from phones", Camera settings → Cameras: same size, or small tiles; a phone host keeps
  tiles), and under it a status line that is the twin of the host's own, from the `state` messages.
- **No temperature API exists in the web platform.** The app reports what the browser gives: the
  Battery Status API (level, charging; already in `state`), the Compute Pressure API's state where the
  browser has it (`PressureObserver`, launched in Chrome 125; the sources `cpu` and, where listed,
  `thermals`; feature-detected, null elsewhere), and the frame-rate drop the phone already detects.
  These are the phone's "health" on the host: in the status line and in the events.
- **The host's capture latency is measured, not assumed.** A latency meter in the pipeline and a
  per-attempt lag estimate from the motion around the cube's moves, recorded per clip beside the sync
  check's number, with a warning when they drift (issue #67).

| Id | Task | Depends on | Status |
|---|---|---|---|
| T5.1 | `web`, `rtc`: the phone's picture at the host's picture's size on the Timer page, with its status line (frame rate, sharpness, recording, battery, pressure or thermal, connection) and the layout setting; the Compute Pressure state in the phone's `state` and in the minute's `rtc.clock` event | T4.4 | ✅ 2026-10-09 (#68) |
| T5.2 | `rtc`, `capture`, `web`: remote camera controls from the host: the phone's capabilities and values reported, the host's panel per phone, apply and Reset to auto over the channel, a watchdog that reports and undoes a mode the camera changed on its own; events; docs | T5.1 | 🔄 PR #69 |
| T5.3 | `capture`, `core`, `web`: the host's capture latency (issue #67): a latency meter in the pipeline, a per-attempt lag estimate from the motion per camera, both recorded per clip; a warning on the preview; the cause found and fixed or mitigated | T5.1 | – |
| T5.4 | docs, "After T5" items, the round report's checklist, `0.5.0` | T5.2, T5.3 | – |

Waves: T5.1 → T5.2 → T5.3 → T5.4, one agent at a time.

### T5.1 — the phone's picture at full size, and its status line

**Goal.** On the Timer page the host sees a phone's picture as large as its own, and under it what the
phone reports, so that a soft focus, a dropped frame rate, a low battery or a hot phone is seen at a
glance, not in Camera settings.

**Scope.** (1) **The layout.** `RemotePreviews` (T4.3) gains a second layout, `equal`: the host's own
picture and each phone's in a cell of its own, each cell the size the single picture has today (16:9, a
phone's upright frames between bars, the framing rectangle drawn), stacked under one another at the
preview's width in the Timer page's `columns` layout (the clock beside the stack), side by side when
the window is wide enough for two cells beside the clock (the agent measures and picks the breakpoint;
`timer-page.ts`'s `app-camera-preview` width rules and the `live` container query adjusted); T4.3's
tiles with the tap-to-swap stay as the layout `tiles`. The setting "Pictures from phones" (Camera
settings → Cameras, `SettingsService`): "same size as mine" (the default on a host that is not a phone)
or "small tiles" (the default on a phone host; the only layout in T2.13's overlay). A `settings.changed`
event names it. (2) **The status line.** Under each phone's picture (and in its tile's caption, in short),
the twin of `CameraPreview`'s line, from the phone's last `state`: the frame rate (`fpsText`), the
sharpness with the host's threshold and the same good (green) and soft (amber) colouring, the recording
word (recording, not recording, in the host's `rec` style), the battery (`83%`, `charging`; amber under
20% and not charging, red under 10%), the health word (T4.1's `hot: the frame rate dropped` in amber; the
pressure state when the phone reports one: `pressure fair` in amber, `serious` and `critical` in red),
the connection when it is not plainly connected (`reconnecting…`, `clock syncing…`), and `no report for
10 s` in red when the state messages stop while connected. (3) **The pressure.** The phone's `state`
gains `pressure: 'nominal' | 'fair' | 'serious' | 'critical' | null` and `pressureSource: 'cpu' |
'thermals' | null`, from a `PressureObserver` (the source `thermals` when `PressureObserver.knownSources`
lists it, else `cpu`; `sampleInterval` 2 s; feature-detected; null where the browser has none or
refuses); `protocol.ts`'s decoding takes a `state` without them (an older build's); the phone's own
page shows the state beside the thermal hint ("the phone is under serious pressure: it may be hot").
(4) **The events.** The host's minute `rtc.clock` event of each phone (T4.2b) gains `report: {fps,
sharpness, battery, thermal, pressure}` from the phone's last state, so that the round report and
`docs/DEVICES.md` have a phone's health over a session; `docs/DIAGNOSTICS.md` says so, and the round
report's "After T5.1" items read them (the status line's facts beside the item). (5) **Docs.**
`docs/RTC.md` §1 (`state`'s new fields) and §10 (the layout); `docs/USER-ACTIONS.md`; `README.md`'s rig
section; `docs/MANUAL-TESTS.md` "After T5.1": the equal layout on the MacBook with the ThinkPhone and
with the Moto g60 (the two pictures the same size; the window narrowed: stacked), the line's words when
the phone's focus is set to manual on its own panel (sharpness soft), when the phone is unplugged and
low, when it is hot (after twenty minutes: the pressure word, if the phone's Chrome has the API: write
`'PressureObserver' in window` from the phone's console if unsure), tiles chosen and back.

**Acceptance.** Unit tests: the layout decision (host or phone, the setting, the width), the status
line's words and colours from a `state` (the battery levels, the pressure states, the thermal hint, a
stale report, a reconnecting phone), the `state`'s encoding and decoding with and without the new
fields, the pressure observer behind a fake (`PressureObserver` absent, present with `cpu` only, with
`thermals`, refusing). The e2e pair: in the equal layout two pictures of the same size (their bounding
boxes within 2 px), the phone's line reads its fake camera's state, the setting switches to tiles and
back, the preview's encoding parameters are T4.3's (the picture's size on the host changes nothing on
the phone). Lint, unit and e2e green; the bundle's chunks noted in the Outcome.

**Outcome (2026-10-09).** As contracted, PR #68, with these choices. **The breakpoint for two
pictures beside the clock is a `live` column of 72rem**, measured with the dev server: the clock's
section at its narrowest (its time at 3rem holds "1:02.34" from 236 px; its four buttons take four
rows under 270 px, three from 270, two from 300) is 17.17rem (275 px) beside two cells of 53.83rem
and their gap, and then about as tall as the two pictures with their lines (277 against 262 px). The
Timer page's 80rem can never hold that column (55rem at most), so `app.scss` lets the page widen to
120rem from a 97rem (1,552 px) window when two pictures or more are in cells; narrower, the pictures
stand one under the other beside the clock (the owner's MacBook window: one under the other up to
1,551 px, side by side from 1,552). "Pictures from phones" defaults by device (`SettingsService.isPhone`:
tiles on a phone, same size elsewhere, stored as null until chosen, as `wifiOnly` does), not by the
Timer layout of the moment, which the window's width would change under the user; `remotePicturesLayout`
forces tiles in the overlay. The status line is `remoteStatusLine(input, form)` (`remote-status.ts`:
the form `line` for the Timer page, `list` for the Cameras section; `shortParts` for a tile's caption,
which says only what is wrong); the battery's amber and red hold only while the phone is unplugged (a
plugged-in phone is plain at any level); "no report for N s" counts from a reconnection's start, so a
phone just back from a drop is not red at once. The pressure observer (`pressure.ts`, with its fake)
observes `thermals` where `knownSources` lists it and falls back on `cpu` when that source is refused;
null only when every source is refused, none is listed or there is no observer; the phone's page says
`fair (thermals)` beside its thermal hint. The minute's `rtc.clock` `report` is flat (an event's facts
nest one level only: `batteryLevel`, `batteryCharging`, plus `soft` by the host's threshold, `recording`,
`pressureSource`, `ageMs`). Tests: 1,390 package tests (1,386 before) and 870 app tests (841); the e2e
pair measures the two boxes at 426.66 × 239.98 px, one under the other at 1,280 px and side by side at
1,700 px, within 2 px, the line's words from a planted battery (15%, unplugged) and pressure (fair,
thermals), tiles and back, T4.3's preview caps unchanged (scale 5, 300 kbps, 15 fps). Bundle (raw):
initial 265.11 kB (264.96 before), `remote-previews` 10.04 kB (7.12), a new shared chunk of 5.58 kB
with the status line, `remote-cameras` 47.40 kB (45.91), `camera-device-page` 51.36 kB (48.85),
`timer-page` 31.66 kB (31.22). **Open:** whether the ThinkPhone's and the Moto g60's Chrome have
`PressureObserver` ("After T5.1" says how to check: `'PressureObserver' in window` and
`PressureObserver.knownSources` through `chrome://inspect`); 71rem would put the pictures side by side
from 1,536 px at the cost of a fourth row of buttons; the overlay's pinned picture keeps the 427 px
`max-width` in a laptop window of 427–960 px (before this PR too).

### T5.2 — remote camera controls

**Goal.** The phone's exposure, focus, white balance, zoom and torch are set from the laptop while the
phone sits on its tripod, and a mode the phone's camera changes on its own is seen and undone.

**Scope.** (1) **`rtc`**, three messages, additive within version 1 (`docs/RTC.md` §1, and a §11): `controls`
from the phone: `controls` (`@cubetrace/capture`'s `CameraControls` as `controlsOf` gives them: the
modes and the ranges), `values` (`ControlValues`: what the track's settings say now), `applied`
(`ControlValues`: what the app last set, the persisted ones included), `drift` (below; an empty list
otherwise), `remoteMs`; sent after `hello` (and again with a new hello when the camera changes), after
each `set-controls` it applied, and whenever the watchdog sees a change; `set-controls` from the host:
`values` (the `ControlValues` to change; one or several), or `reset: true` (Reset to auto); `controls-failed`
from the phone: `message`, when applying throws (a value the camera refuses, a camera gone). Bounds and
`decode` checks as the others'. (2) **The phone.** `CameraDeviceService` answers `set-controls` through
`CameraService.setControl` and `resetControls` (the same path as its own panel: persisted per camera
label in Settings as today), then sends `controls`. **The watchdog** (`ControlsWatch`, in `web`, used by
both roles): every 2 s while the camera is on and no slider is being moved, the track's `getSettings()`
modes and values against what the app applied (or against the automatic mode of each group where
nothing was applied); a difference that holds for two readings is a drift, `{name, expected, actual}`
per control, reported (`controls` with `drift`, and the phone's page: "the camera set the focus to manual
by itself"); with the setting "Keep the camera's modes" (Settings → Camera, on by default, both roles)
the device re-applies its values once per drift and counts it; a drift that returns after three
re-applications within a minute is left alone and said ("the camera keeps setting the focus to manual:
set it by hand"). (3) **The host.** `CameraControls` (T2.1) made a view over a `ControlsSource`
(the open camera's `CameraService` today; a `RemoteControlsSource` per phone over its last `controls` and
`set-controls`), shown under each phone in the Cameras section (Camera settings → Cameras) with "Reset
to auto"; a change in flight (sent, the `controls` answer not yet in, 3 s at most, then "the phone did
not answer") disables the group; a phone that never sends `controls` shows "this phone's build has no
remote controls"; a drift on a phone on its status line of the Timer page (T5.1: "focus went manual on
the phone" in red, with Reset, which sends `set-controls` with the automatic modes) and in the Cameras
list. (4) **Diagnostics.** `remote.controls` (the host: `camera`, `peer`, `set` (the names), `outcome`
`ok`, `failed`, `no-answer`), `controls.drift` (either side: `camera`, `drift`, `reapplied`, `gaveUp`),
in `docs/DIAGNOSTICS.md`; the round report's "After T5.2" items. (5) **Docs.** `docs/RTC.md` §1 and §11;
`docs/USER-ACTIONS.md`; `docs/MANUAL-TESTS.md` "After T5.2": from the MacBook, the Moto g60's focus set to
manual and a distance chosen, back to auto, the zoom, the torch; the drift provoked (the focus set to
manual on the phone's own panel while Keep the camera's modes is on: undone within 4 s and said on both
devices; then off: said and left); the same on the ThinkPhone; the host's own camera's watchdog with its
own panel.

**Acceptance.** Unit tests: the messages' encode and decode and their bounds; the phone's handling
(`set-controls` → `setControl` calls → the `controls` answer; `reset`; a throw → `controls-failed`); the
watchdog (a drift after two readings, not one; none while a slider moves; the re-application; the give-up
after three in a minute; the setting off); the host's source (the panel's groups from a `controls`
message, a change sent and in flight, the timeout, Reset). The e2e pair: the fake camera's track gains
`getCapabilities()` with focus modes and a focus distance and `applyConstraints` bookkeeping (the e2e's
synthetic camera of T4.3); the host sets manual focus and a distance, the phone's page shows them; Reset
to auto; a drift injected on the phone is undone and shown on the host. Lint, unit and e2e green.

### T5.3 — the host's capture latency, measured per attempt (issue #67)

**Goal.** The lag of the host's own camera is known for every attempt and not only at the sync check,
the latency growth of 2026-10-09 is seen as it happens, and its cause is found and fixed, or
mitigated.

**Scope.** (1) **The evidence** is issue #67's: the MacBook's frames arrived about 75 ms later relative
to the cube from attempt 38 on in both sessions of the day (the lag 58 → 133 ms, the frame cadence 30.3
→ 29.3 fps, no gaps, no event), and recovered once in the evening when the phone's sync checks ran; the
phones' frames were unaffected; the same effect probably sits in the 2026-10-05 session. (2) **A latency
meter** in the capture pipeline (`packages/capture`): per frame, the delay from the camera's own timestamp
(`VideoFrame.timestamp`) to the host time the pipeline stamps the frame with, and from that to its encode;
their p50 and p95 per attempt in the clip's `video[]` entry (`captureLatencyMs: {p50, p95}`,
`encodeLatencyMs`; schema 2, additive, `docs/DATA-MODEL.md`) and in `clip.saved`; a `recording.latency`
event when the p50 drifts by more than 30 ms from its value at the camera's last sync check, and the word
`latency +75 ms` in amber on the preview's status line (the phone's own pipeline the same, reported in
`state`'s `latencyMs`, shown on the host's line of T5.1). (3) **A lag estimate from the motion, per attempt
and camera**: the capture worker measures each frame's motion inside the framing rectangle for the sync
check already (T4.3's meter); for every solve the host runs the same estimator over the solve's turns
(the cube's moves are the clapperboard: `clapperboard.ts`'s centroid estimator and trimmed spread of
T2.11 over all of them, or the motion-energy peak around the onsets if the estimator wants more
separated turns) and records `motionLagMs` and its spread in the clip's entry, for the laptop's clips in
this task and for a phone's where its `sync-motion` series over the solve is cheap enough (else noted
as a follow-up); the Timer page says when a camera's `motionLagMs` sits more than 30 ms from its
`syncResidualMs`. (4) **The cause**, as far as the meter on the MacBook shows it over forty attempts
(the ring buffer's eviction, the encoder's queue, the OPFS writes of an attempt's files, the remote
clips' transfer, GC): the fix if it is in the app (a bounded queue that drops a frame rather than
delays it; a stage moved off the capture worker), or a mitigation (a restart of the pipeline between
attempts when the latency has drifted, said on the status line), with the measurement in the Outcome.
(5) **Docs.** `docs/DATA-MODEL.md`, `docs/DIAGNOSTICS.md`, `docs/DEVICES.md` (the MacBook's latency over a
session, once measured), `docs/MANUAL-TESTS.md` "After T5.3": forty solves on the rig with the meter,
the words on the line, the recorded `motionLagMs` against the sync check's number.

**Acceptance.** Unit tests of the meter's statistics and the drift rule, and of the motion estimator on
synthetic frames with a known delay (a planted motion a known number of frames after each turn); the
e2e's recording has the fields; the forty-attempt run is the owner's, in the "After T5" round (T5.4).

### T5.4 — docs, "After T5", `0.5.0`

**Goal.** The rig's new eyes and hands documented and tried once, as a release.

**Scope.** `README.md` ("The desk rig": the equal pictures, the remote controls, the health line, what
to do when a phone runs hot: the live preview off, the screen dim, a stand away from the lamp, a break
between sets); `docs/USER-ACTIONS.md`; `docs/CHANGELOG.md` `0.5.0` and `package.json`; `docs/MANUAL-TESTS.md`
"After T5" (the whole rig once with the ThinkPhone and the Moto g60: the pictures, the controls from the
MacBook, a provoked drift, the health line over twenty minutes, the latency meter's words over forty
solves); the round report's checklist for T5.1–T5.3 (`functions/scripts/report.mts`, `docs/DIAGNOSTICS.md`
"After T5"); `docs/DEVICES.md`: the Moto g60's row (its camera, 1080 × 1920 at 60 nominal and 30
measured, about 5 Mbps; its lag about 30 ms by the video against 37 to 92 ms by its remote checks on
2026-10-09, the check matching 5 to 7 turns of 10 on it), and the MacBook's latency over a session.

**Acceptance.** Lint, unit, e2e and cloud suites green; the deployed footer reads `cubetrace 0.5.0`; the
tag by the owner.

## Phase 6

Outline only, written into a board when phase 5 ends: **Community** — the versioned consent flow
(the TCLE and Plataforma Brasil's approval first), per-account quotas, delete-my-data (files and
index entries), community mode, audio opt-in for others, the face-in-frame warning, pseudonymous
ids, the dataset's license as a separate opt-in (§12 of the private design). The decisions of
phases 3 and 4 hold: the bucket provider is a configuration, audio is recorded by default for the
owner.
