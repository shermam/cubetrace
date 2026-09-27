# Changelog

All notable changes to cubetrace. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- The scramble's moves are outlined as the cube makes them, as on Cubeast: green once made, yellow
  while a half turn is half made (one quarter turn of its two), red on the move where the cube left
  the scramble, next to the undo list as before; the whole scramble green once it is complete, until
  the solve starts. The demo cube now makes a scramble's half turns as two quarter turns, as a real
  cube does, so the yellow shows in demo mode too (T1.13).
- "Mark as solved", in the Timer page's Cube section and in the connected cube's details (the pill):
  it tells the cube that it is solved, for when the cube's own state and the cube in your hands went
  apart (turns made while it was asleep or disconnected). The attempt under way begins again with
  its scramble, and nothing is recorded; with the demo cube, the replay stops there (T1.14).
- A cube left 5 minutes without a turn is disconnected, to save its battery (Settings → Idle cube,
  0 to 60 minutes, 0 for never); the pill's tooltip and the Timer page say why, and Reconnect takes
  one click (T1.14).
- When the cube disconnects by itself, the reason says how long it had gone without a turn and
  whether the tab was in the background (and that GAN cubes go to sleep, after two minutes), and the
  browser's console gets one line with the details, to paste into an issue. Back in the tab, a
  connected cube is asked for its state, so that turns made meanwhile are caught up. The GAN driver
  now loads right after the page, so that the click on Connect does not wait for it (T1.14).

### Changed

- Connecting a cube takes one click (T1.12). "Connect a cube" on the Timer page (and in its Cube
  section) and the cube pill in the header, which now reads "Connect cube" or "Reconnect", open
  Chrome's list of Bluetooth devices at once; once the cube is connected, no dialog is left open.
  While it connects, the button says so, with Cancel next to it. The connect dialog opens only when
  it is needed: when the cube's MAC address has to be typed (the Chrome flag that makes it
  unnecessary is folded under the prompt), in a browser without Web Bluetooth, for the Details of a
  failed connection, and for a connected cube's details from the pill. A failure is written under
  the button and in the pill's tooltip, whose dot turns red. "Try the demo", next to "Connect a
  cube", starts the demo cube.

### Fixed

- A page reloaded or closed during a save no longer leaves an empty `session.json` or `attempt.json`
  behind: files are written under a temporary name and moved into place in one step. A file that
  cannot be read (empty, not JSON, or not its session's) is set aside instead of breaking the Timer
  page's resume and the whole Sessions page: the Sessions page still lists, exports and deletes the
  other sessions, shows a broken session as its own row, with the file and what is wrong, and can
  delete it, and names an attempt it left out; the Timer page starts a new session and says which
  file it could not read (issue #12, T1.11).

## 0.1.0 — 2026-09-27

The first release: phase 1 of `docs/PLAN.md`, a timer for a GAN Bluetooth cube in Chrome that keeps
every solve as data. Deployed at https://shermam.github.io/cubetrace/.

### Added

- The timer (T1.6b): a WCA random-state scramble made in the browser by cubing.js, as text and as a
  picture, with its progress and, when the cube leaves it, the moves that undo the detour; the
  attempt arms when the cube matches the scramble, the time starts with the first turn and stops
  when the cube is solved; "Solve the cube first" when a scramble is due on an unsolved cube; the
  next scramble at once after a solve; Skip scramble (N), DNF (Esc), Delete last (Delete) and New
  session.
- An optional 15-second inspection countdown (visual only: no +2 or DNF), from the moment the
  attempt arms or, on a cube with a gyroscope, from the pickup (T1.6b).
- The CFOP breakdown of the last solve and of the session average (cross, four F2L pairs, EOLL,
  OCLL, PLL), with each phase's time and moves; phases are detected on any cross colour and agree
  with Cubeast on all 2,400 phase boundaries of 300 of the owner's solves (T1.3, T1.6b).
- The solve list: time, the phases as a mini bar and flags (DNF, Corrected, No replay), with the
  session's count, mean, best, ao5 and ao12 (T1.4, T1.6b).
- Sessions kept in the browser's origin private file system as `session.json` and one
  `attempt.json` per attempt (`docs/DATA-MODEL.md`: every move on the host and cube clocks, the
  cube clock fit, the phases and the result), resumed after a reload; a cube that disconnects
  pauses the attempt until it is back; JSON Schemas of both files in `packages/core/schema/`
  (T1.4, T1.6b).
- The Sessions page: every stored session with its date, device, cube, attempts and mean; export
  one as a JSON file, or delete it (T1.6b).
- GAN cube connection over Web Bluetooth, from the cube pill in the header: Chrome's device picker,
  the MAC address read by Chrome with the flag `#enable-web-bluetooth-new-permissions-backend` or
  typed once and remembered for that cube, the cube's model, firmware, battery and gyroscope, and
  Disconnect and Reconnect (T1.5, T1.6a).
- The Cube section of the Timer page: the cube's state as a net, solved or not, and its last 20
  moves with their cube time, the gaps between them and the Bluetooth packet they came in (T1.6a).
- Demo mode: a fake cube that replays one of 30 recorded solves, from "Demo cube" in the connect
  dialog or `?demo=<0-29>&speed=<x>` on the Timer page, so the app can be tried without a cube
  (T1.6a).
- End-to-end tests of the timer's flows with the demo cube, which `&misscramble=<k>` makes turn a
  wrong face after scramble move k and undo it: full attempts checked against the recorded solves, a
  mis-scramble, a DNF, a reload mid-session, the inspection setting, and exports validated against
  the JSON Schemas (T1.9).
- Settings: this device's label, the cubes' MAC addresses, inspection, the next scramble right
  after a solve, and the demo speed; keep the screen on; keep my data (T1.6a, T1.7).
- An installable app that opens offline, keeps the screen on during a session (the header shows
  the wake lock), asks the browser to keep its data, fits a phone in portrait and a laptop in one
  dark theme, shows its version and commit in the footer, and names the missing APIs on browsers
  other than Chrome (T1.7).
- The device probe page, `/probe`: what the browser can do with its cameras, H.264 encoders,
  storage and Bluetooth, as a JSON report to copy or download for `docs/DEVICES.md` (T1.8).
- Development: npm workspaces (`apps/web` and `packages/core`, `gan`, `storage`), strict
  TypeScript, ESLint and Prettier, Vitest and Playwright tests driven by the fake cube, CI on every
  pull request and a GitHub Pages deploy from `main` (T1.0).
