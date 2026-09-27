# Changelog

All notable changes to cubetrace. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

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
