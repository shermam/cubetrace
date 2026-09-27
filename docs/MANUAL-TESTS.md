# Manual tests (real hardware)

Agents cannot run these; the owner does, after the coordinator asks. Each task that adds a
hardware path appends its checklist here. Record the date, the device, the browser version
and the result next to each item.

## Round 1 (v0.1.0)

The first release's round (`docs/PLAN.md`, T1.10): the T1.5, T1.6 and T1.7 sections below, on
https://shermam.github.io/cubetrace/, on one laptop (Chrome, macOS or Windows) and on the
ThinkPhone (Chrome for Android), with both cubes. The coordinator tags `v0.1.0` after it.

1. Before starting, fill in one row of the table per device and cube. Chrome's version is the first
   line of `chrome://version`; the cube's strings are in the connect dialog once it is connected
   (Model, Hardware, Firmware); the app's version and commit are in the page footer.
2. Tick an item below when it passes on every row. When it fails or does something unexpected on
   a row, write the row (such as "ThinkPhone, 356 i3") and what happened next to it.
3. Every failure becomes a GitHub issue with the row's device, Chrome version and cube, the steps,
   what happened and what was expected (a screenshot, or the move log, when it shows it).
4. At the end, export each device's session (Sessions → Export) and attach the files to one issue.
   Attach them rather than paste them: an export takes about 16 kB per attempt, and an issue holds
   65,536 characters (zip the files if GitHub refuses `.json`).

| Date | Device, OS | Chrome | Cube: model, hardware, firmware | App (footer) | Result |
|---|---|---|---|---|---|
| | laptop: | | GAN 12 ui FreePlay: | | |
| | laptop: | | GAN 356 i3: | | |
| | ThinkPhone, Android: | | GAN 12 ui FreePlay: | | |
| | ThinkPhone, Android: | | GAN 356 i3: | | |

## T1.5 — cube connection

Through the connect dialog (T1.6a: click the cube pill in the header, or "Connect a cube" on the
Timer page), in a current Chrome (the driver needs the Observable API). The flag below is
`chrome://flags/#enable-web-bluetooth-new-permissions-backend` (`docs/TOOLCHAIN.md`, "GAN driver");
the dialog names it, with a Copy button. The moves are read in the Timer page's Cube section (click
"Cube", under the solve list, to open it), whose move log lists the last 20 moves, newest first: the move, its cube ms, the gap to the move before on
the cube's clock ("Gap") and on this device's clock ("Host"), and ■ on the last move of each
Bluetooth packet.

- [ ] Connect the GAN 12 ui FreePlay on a laptop (Chrome, macOS or Windows) with the flag on:
  the picker lists the cube, no MAC address is asked for, and model, firmware and battery appear
  within 5 s. Write down the model string the cube reports.
- [ ] Same with the flag off: the dialog names the flag and asks for the MAC address; typing it
  connects (`AB:12:CD:34:EF:56`, `ab-12-cd-34-ef-56` and `ab12cd34ef56` are all accepted). A
  wrong address fails within 5 s with a message that names the address. With "Remember it for
  this cube" on, the next connection does not ask (Settings → Cube MAC addresses lists it).
- [ ] Same on the ThinkPhone (Chrome for Android).
- [ ] Same with the GAN 356 i3.
- [ ] Scramble the cube, then connect: the state shown right after connecting is the cube's.
- [ ] Turn faces slowly and fast: every move appears in the move log in order, with
  `cubeMs` increasing; slices appear as two moves a few ms apart (Gap). In fast bursts, moves that
  arrived in one Bluetooth packet share `hostMs` (Host 0) and only the last has `packetLast` (■).
- [ ] Walk away 30 s, turn: the connection is still alive (or reconnects and says so).
- [ ] Turn the cube off and on: the pill says "No cube" and the dialog gives the reason, then
  Reconnect connects it again.
- [ ] Disconnect from the app, then connect again without reloading the page.

## T1.6 — timer

On the Timer page, with a cube connected as in T1.5. The page shows the scramble (moves and picture)
with its progress, the time with the attempt's number (under a result, also that attempt's number
and whether its record is saved, such as "#3 · Saved"), the buttons Skip scramble (N), DNF (Esc),
Delete last (Delete) and New session, the CFOP breakdown, the solve list with its statistics, and
the Cube section. Sessions are kept in the browser's origin private file system (a warning under the
time says so when a browser has none).

- [ ] Connect the cube while it is scrambled: the page says "Solve the cube first"; solve it: attempt
  1 begins with the scramble on screen, and the picture matches it (white on top, green in front).
- [ ] Ten attempts in a row: each is armed exactly when the cube matches the scramble (the progress
  reads n / n, the status says Ready); the timer starts on the first turn and stops on solved; the
  time matches a stopwatch within 0.2 s; the next scramble is there at once.
- [ ] Mis-scramble on purpose (one wrong turn): the undo list shows the inverse move, greys it out
  when made and clears; the attempt arms afterwards, and its row in the solve list says Corrected.
  (Without a cube, `/?demo=0&speed=1&misscramble=5` shows the same with the demo cube.)
- [ ] CFOP breakdown looks right for a solve you narrate (cross, four pairs, two-look OLL, PLL): the
  last solve's bar has its eight phases in order; hovering (or tapping) a segment gives its ms and
  moves; "Numbers" lists them next to the session average.
- [ ] Esc during a solve: the time and the row say DNF, and the next attempt begins when the cube is
  solved again. Delete right after a solve: the row goes, and the attempt on screen takes its number.
  N before the first turn: a new scramble, and nothing is recorded.
- [ ] Settings → 15-second inspection on: once armed, the time counts down from 15 (red at 0; no
  penalty is recorded). On the GAN 12 ui (it has a gyroscope), lift the cube once armed: the count
  starts again from the pickup (a turn of more than 15° from where the cube was when armed). Write
  down whether putting the cube down after the last scramble move already counts as the pickup.
- [ ] Settings → "Next scramble right after a solve" off: after a solve the time stays, and Next
  scramble (N) begins the next attempt.
- [ ] Turn the cube off in the middle of a solve: the time stops; turn it on and Reconnect: the same
  attempt goes on and ends when the cube is solved.
- [ ] Reload the page mid-session, then close the browser and open the app again: the solve list is
  still there and the next attempt has the next number (the session is read back from the origin
  private file system).
- [ ] Sessions page: the session is listed with its date, host label, cube model, attempts and mean.
  Export downloads `cubetrace-session-<id>.json` with `session` and `attempts`; it validates against
  `packages/core/schema/` (docs/DATA-MODEL.md §6 and §7). Delete asks first, then removes it.
- [ ] While a cube is connected during a session the header says "Screen on"; after the cube
  disconnects it says "Screen may sleep" again.

## T1.7 — PWA on the phone

On https://shermam.github.io/cubetrace/. The timer keeps the screen on by itself while a cube is
connected during a session (T1.6 section); the switch in Settings keeps it on at any time, which the
wake lock items below check.

- [ ] ThinkPhone (Chrome for Android): menu → Install app (or Add to Home screen). The home
  screen shows the cube icon and the name "cubetrace"; opened from there, the app has no address
  bar (standalone).
- [ ] Rotate the phone: the app follows (`orientation: "any"`) and no page scrolls sideways,
  in portrait or in landscape.
- [ ] Settings → Keep the screen on: the header says "Screen on"; leave the phone untouched
  longer than its screen timeout: the screen stays on. Switch to another app and back: still
  "Screen on" (the lock is requested again). Switch it off: "Screen may sleep", and the screen
  turns off after the timeout.
- [ ] Settings → Keep my data, in the installed app: the status becomes "Persistent" (Chrome
  grants it to installed apps). If it stays "Best effort", write down the Chrome version here.
- [ ] The footer shows `cubetrace <version> · <commit>` with the last commit on `main`. After a
  new deploy, the new commit appears from the second launch (the service worker updates in the
  background).
- [ ] Airplane mode, then open the app from the home screen: it opens, from the service
  worker's cache.
- [ ] Laptop (Chrome, macOS or Windows): the install button in the address bar installs it as a
  window; there is no banner about missing APIs.
- [ ] Firefox or Safari on any device: a banner names the missing APIs and says the app needs
  Chrome; the pages still render.
