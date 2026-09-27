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
| 2026-09-27 | MacBook Pro 2021, macOS 26.6.2 | 153.0.8010.53 | GAN 12 ui FreePlay: `uiFp 138`, 0.5, 8.62 | 0.1.0 · ec373da | no issue found; 12 solves; export in issue #19 and `fixtures/hardware/` |
| | laptop: | | GAN 356 i3: | | pending (the cube was flat) |
| 2026-09-27 | ThinkPhone, Android 16 | 155.0.8059.16 | GAN 12 ui FreePlay: `uiFp 138`, 0.5, 8.62 | 0.1.0 · 25d22c7 | no issue found; 3 solves; MAC typed once (flag off); export in issue #20 and `fixtures/hardware/` |
| | ThinkPhone, Android: | | GAN 356 i3: | | pending (the cube was flat) |

## T1.5 — cube connection

In a current Chrome (the driver needs the Observable API). Connecting takes one click (T1.12):
"Connect a cube" on the Timer page, or the cube pill in the header ("Connect cube", or "Reconnect"
once a cube has been connected), opens Chrome's list of Bluetooth devices at once; choosing the cube
there connects it, and the page stays as it was, with the pill showing the cube. While it connects,
the button says "Connecting…" next to a Cancel. The app's dialog opens by itself only when the
driver asks for the cube's MAC address, which it does when Chrome cannot read it: without the flag
`chrome://flags/#enable-web-bluetooth-new-permissions-backend` (`docs/TOOLCHAIN.md`, "GAN driver"),
whose address and steps, with a Copy button, are folded under the prompt ("Let Chrome read the
address by itself"). A failure is written under the button, with a Details link to the dialog, and
in the pill's tooltip, whose dot turns red. Clicking the pill of a connected cube opens its details
(model, hardware, firmware, battery, gyroscope) and Disconnect. The moves are read in the Timer
page's Cube section (click "Cube", under the solve list, to open it), whose move log lists the last
20 moves, newest first: the move, its cube ms, the gap to the move before on the cube's clock
("Gap") and on this device's clock ("Host"), and ■ on the last move of each Bluetooth packet.

- [ ] Connect the GAN 12 ui FreePlay on a laptop (Chrome, macOS or Windows) with the flag on:
  one click on "Connect a cube" opens the picker, which lists the cube; choose it: no MAC address
  is asked for, no dialog opens, and the pill shows the model and the battery within 5 s (click it
  for the firmware). Write down the model string the cube reports.
- [ ] Same with the flag off: after the picker, the dialog asks for the MAC address, with the flag
  folded under it; typing it connects and closes the dialog (`AB:12:CD:34:EF:56`,
  `ab-12-cd-34-ef-56` and `ab12cd34ef56` are all accepted). A wrong address fails within 5 s with a
  message under the button that names the address. With "Remember it for this cube" on, the next
  connection does not ask (Settings → Cube MAC addresses lists it). Cancel on the prompt closes the
  dialog, and the message under the button says that no address was given.
- [ ] Close Chrome's picker without choosing: "No cube was chosen…" appears under the button, and no
  dialog opens; Details opens it with the message, the Bluetooth hint (and the flag's steps when the
  flag is off), Connect cube and Demo cube.
- [ ] Same on the ThinkPhone (Chrome for Android).
- [ ] Same with the GAN 356 i3.
- [ ] Scramble the cube, then connect: the state shown right after connecting is the cube's.
- [ ] Turn faces slowly and fast: every move appears in the move log in order, with
  `cubeMs` increasing; slices appear as two moves a few ms apart (Gap). In fast bursts, moves that
  arrived in one Bluetooth packet share `hostMs` (Host 0) and only the last has `packetLast` (■).
- [ ] Walk away 30 s, turn: the connection is still alive (or reconnects and says so).
- [ ] Turn the cube off and on: the pill says "Reconnect" (its tooltip gives the reason); one click
  on it opens the picker, and choosing the cube connects it again.
- [ ] Disconnect from the app (the pill, then Disconnect), then connect again without reloading the
  page.
- [ ] Mark as solved (T1.14). Disconnect the cube (the pill, then Disconnect), scramble it while it
  is disconnected, and connect it again: write down whether the net (the Cube section) matches the
  cube in your hands. Solve the cube in your hands, then click "Mark as solved" (in the Cube section,
  or in the pill's details): the net shows solved at once, the attempt on screen begins again with
  the same scramble and number, and nothing is added to the solve list; scrambling as shown arms it
  as usual, and its solve is recorded. Then turn one face and back: the move log shows exactly those
  two moves and the net follows them (no stray moves after the reset). (Without a cube:
  `/?demo=0&speed=0.25`, open the Cube section and click it during the scramble: the demo cube stops,
  solved.)
- [ ] Idle disconnection (T1.14). Settings → Idle cube shows 5. Set it to 1, connect the cube and
  leave it still: after one minute the pill says "Reconnect", and its tooltip and the Timer page,
  under the button, say "Disconnected after 1 minute without a turn, to save the cube's battery."
  One click on Reconnect connects it again. Turning a face now and then keeps it connected. In a
  background tab the disconnection can come up to a minute late: Chrome throttles the timers of
  hidden tabs, which is fine. Set it back to 5 (0 never disconnects).
- [ ] Disconnect diagnostics (T1.14). With Settings → Idle cube at 0, connect the cube, switch to
  another tab or app and leave the cube untouched for 10 minutes, then come back. Write down whether
  the cube was still connected. If it was not, the reason under Reconnect (and in the pill's
  tooltip) says how long the cube had gone without a turn and whether this tab was in the
  background. Open Chrome's console (Ctrl+Shift+J, or ⌥⌘J on a Mac; for the phone, chrome://inspect
  on a laptop, with the phone plugged in over USB and USB debugging on) and paste into the issue the
  line that starts with `cubetrace: the cube disconnected`, with the reason shown. It looks like this
  (the times in ms; `hiddenMs` is how long the tab had been hidden, `null` if it was visible):

  ```
  cubetrace: the cube disconnected {"reason":"The Bluetooth connection was closed.","idleMs":372104,"visibilityState":"hidden","hiddenMs":311875,"connectedMs":905233,"battery":83,"model":"GAN12ui"}
  ```

  Do the same whenever the cube disconnects by itself. If it was still connected, turn a face: the
  move log follows (back in the tab, the app asked the cube for its state).

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
- [ ] Scramble colours (T1.13), as on Cubeast: each move of the scramble text gets a green box once
  made; a half turn (`R2`) gets a yellow box after its first quarter turn and turns green after the
  second, turned either way. A wrong turn puts a red box on the move where the cube left the
  scramble, with the undo list as above; undoing it removes the red. Once the scramble is complete
  every move is green until the first turn of the solve, then the text is plain. Nothing in the text
  shifts when a box appears. Write down whether the colours keep up with fast turning.
  (Without a cube: `/?demo=0&speed=1&misscramble=5`.)
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

## T2.1 — camera panel

On https://shermam.github.io/cubetrace/, Timer page, the Camera section below the Cube section, on
the MacBook and on the ThinkPhone (both cameras). Next to each item, write the device, the camera,
Chrome's version and what the panel said (the Track and Measured lines, the sharpness numbers).

- [ ] MacBook, FaceTime camera: Turn on asks for the camera once; the picker shows "FaceTime HD
  Camera (…)"; the preview shows the laptop's view, not mirrored (this camera does not say which way
  it faces); Track "1920×1080 at 30 fps" and Measured about "30.0 fps, frames 1920×1080"; the
  controls say "This camera has no manual controls" (`docs/DEVICES.md`: no exposure, focus or white
  balance on it).
- [ ] ThinkPhone: the picker says "Front camera" and "Rear camera"; the front camera's preview is
  mirrored like a mirror, the rear camera's is not. Held upright, Measured says frames 1080×1920 and
  about 30 fps, whatever Track claims (60 fps on both cameras, `docs/DEVICES.md`).
- [ ] ThinkPhone, front and rear: Exposure (Mode, Time, ISO), Focus, White balance and Zoom appear;
  the rear camera also has Torch, which lights and goes off.
- [ ] Manual exposure on the phone: Exposure → Manual keeps the picture as it was; Time down to
  about 2 ms (1/500 s) darkens it, ISO up brightens it again. Turn the camera off and on, and reload:
  Manual and the same time come back. Reset to auto: the camera reopens, every control on Auto.
- [ ] Focus on the front camera (it lists only manual focus): Focus → Manual, move Distance, then
  Focus → Auto: the focus is automatic again (the panel reopens the camera for it when the camera
  does not go back by itself). Write down whether the preview blinked (it reopened).
- [ ] Settings → Frame rate "Exactly 60 fps", then the Timer page, on each camera, at 1920×1080 and
  at 1280×720: either Measured says about 60 fps (this camera has 60 fps: write it down) or the
  notice says it has no 60 fps mode and Measured says 30. Then back to "Best (asks for 60 fps)".
- [ ] Sharpness meter, with the cube held in the framing rectangle in the room's usual light: write
  down the number. Cover the lens: it drops near 0 and says soft. Turn a face fast: it drops while
  the cube moves. Point it at something sharp and well lit: good. From those numbers, is the
  threshold (Settings, 20 by default) between sharp and soft? Write down the value that would be.
- [ ] Framing rectangle: drag its inside, then a corner, with the mouse on the laptop and a finger on
  the phone; the page does not scroll while a finger drags the rectangle. Reload: the rectangle is
  where it was left, for that camera. On the phone, turn to landscape: the rectangle is the full
  frame there; back to portrait, the portrait rectangle is back.
- [ ] Camera on across reloads: on, reload: it opens again by itself with the section open; off,
  reload: it stays off. While it is on, the Sessions and Settings pages keep it on (the camera light
  stays on); Turn off turns it off.
- [ ] Permission: block the camera for the site (the camera icon in the address bar, or the site
  settings) and Turn on: the panel says the permission was denied and how to allow it. On the Mac,
  with Chrome denied the camera in System Settings → Privacy & Security → Camera, it names that
  setting instead.
- [ ] Another app holding the camera (a video call on the laptop): Turn on says the camera is in use
  by another app.
