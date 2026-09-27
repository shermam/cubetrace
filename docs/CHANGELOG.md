# Changelog

All notable changes to cubetrace. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Project scaffold (T1.0): the Angular app with a top navigation and four placeholder pages
  (Timer, Sessions, Settings, Probe); the Timer page shows the version of `@cubetrace/core`.
- Packages `@cubetrace/core` and `@cubetrace/gan` (placeholders), npm workspaces, strict
  TypeScript, ESLint and Prettier, Vitest and Playwright tests, CI, and the GitHub Pages deploy
  to https://shermam.github.io/cubetrace/.
- Installable app (T1.7): a web app manifest (standalone, any orientation, a cube icon) and a
  service worker that caches the app shell, so the installed app opens offline.
- Screen wake lock: a "Keep the screen on" switch in Settings and its status in the header; the
  lock is requested again whenever the page becomes visible.
- Storage persistence: Settings shows whether the browser keeps the app's data and how much it
  uses, with a "Keep my data" button.
- A dark theme and a layout that fits a phone in portrait and a laptop; the footer shows the
  version and the commit of the build.
- A banner on browsers that lack Web Bluetooth, the origin private file system or WebCodecs,
  naming what is missing.
- Device probe page (T1.8): `/probe` lists the cameras, opens the chosen one at 1920×1080 and
  ideally 60 fps, measures its frame timing with `requestVideoFrameCallback`, checks H.264
  encoder support, worker APIs, storage and Web Bluetooth, and gives a JSON report to copy or
  download for `docs/DEVICES.md`.
- Scrambles (T1.2): the Timer page shows a WCA random-state scramble generated in the browser by
  cubing.js, offline too once the app is installed.
- Attempts and sessions in `@cubetrace/core` (T1.4): the attempt state machine (scrambling, armed,
  solving, solved or DNF) that writes `attempt.json` with the CFOP phases, `session.json`, the cube
  clock fit, session statistics (mean, best, ao5, ao12, ao100, phase averages), the session store
  interface, and JSON Schemas of both files.
- Cube connection (T1.6a): a cube pill and a connect dialog for GAN cubes, a live Cube panel on the
  Timer page, a demo cube (`?demo=<n>&speed=<x>`), and settings for the host label, cube MAC
  addresses, inspection, auto-advance and demo speed.
