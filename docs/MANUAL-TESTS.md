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
| 2026-09-27 | MacBook Pro 2021, macOS 26.6.2 | 153.0.8010.53 | GAN 356 i3: `GANi3I1w`, 0.1, 7.76 | 0.1.0 · 21c7bca | connects and times as expected; 5 solves with clips; export in issue #32 and `fixtures/hardware/`; one issue reported separately |
| 2026-09-27 | ThinkPhone, Android 16 | 155.0.8059.16 | GAN 12 ui FreePlay: `uiFp 138`, 0.5, 8.62 | 0.1.0 · 25d22c7 | no issue found; 3 solves; MAC typed once (flag off); export in issue #20 and `fixtures/hardware/` |
| | ThinkPhone, Android: | | GAN 356 i3: | | pending (the cube was flat) |

## Round 2 (v0.2.0)

The second release's round (`docs/PLAN.md`, T2.6): the device's own camera, on
https://shermam.github.io/cubetrace/ once its footer reads `cubetrace 0.2.0 · <commit>`, on the
MacBook Pro 2021 (Chrome, its FaceTime camera) and on the ThinkPhone (Chrome for Android: the front
camera, the phone on its stand as the owner solves, then the rear camera), with the GAN 12 ui
FreePlay (and the GAN 356 i3, once charged, for its rows of Round 1). The coordinator asks the owner
to create the `v0.2.0` release from GitHub after it.

1. Before starting, fill in one row of the table per device and camera. Chrome's version is the
   first line of `chrome://version`; the cube's strings are in its details (click the cube pill once
   it is connected); the camera is the one chosen in Camera settings; the app's version and commit
   are in the page footer.
2. Go through the sections below in this order: **T2.1** (camera panel), **T2.4** (recording),
   **T2.10** (video quality), **T2.5** (sync check), **T2.7** (layout), then **T2.3** (clips, in the
   capture lab). Since T2.7, the "Camera section" of the T2.1 and T2.4 items is Camera settings, a
   disclosure below the Cube section, and the framing rectangle is moved after Framing → Edit. Tick
   an item when it passes on every row. When it fails or does something unexpected on a row, write
   the row (such as "ThinkPhone, rear") and what happened next to it.
3. Every failure becomes a GitHub issue with the row's device, Chrome version, camera and cube, the
   steps, what happened and what was expected (a screenshot, or the console line, when it shows it).
   The known limitations below are expected: report one only if it behaves otherwise than said.
4. At the end, attach to one issue (zip the files if GitHub refuses them):
   - one session export per device, of a session recorded with the camera on (Sessions → Export, or
     Export on the session's page): the records, with the clips' `video` entries and the sync
     check's `clock.cameras`;
   - the clips of one attempt per device: its clip badge, then Download (both MP4s, both frames files
     and `attempt.json`);
   - every console line that starts with `cubetrace:` (Ctrl+Shift+J, or ⌥⌘J on a Mac; for the phone,
     `chrome://inspect` on the laptop, as in T1.5): `cubetrace: clip failed: …` for a clip that
     could not be saved, `cubetrace: the cube disconnected …` for a disconnection, `cubetrace: sync
     check …` for every sync check that ended (since T2.8); and, for a sync check that fails, the
     file its "Download check data" saves (`cubetrace-sync-check-<time>.json`);
   - screenshots of the Timer page during a session with the camera on: on the MacBook at the size
     Chrome's window opens with, and on the phone in portrait, in Chrome and in the installed app.
5. Write into `docs/DEVICES.md`, "Manual round 2", or paste into the round's issue for the
   coordinator: per camera, the frame rate measured (Camera settings, Measured) and the sharpness
   with the cube in its rectangle, in focus, moving and covered, with the threshold that would
   separate them; per camera, the sync check's lag and spread, twice (its "Camera lag" table); after
   20 minutes of solves with the camera on, the phone on its stand, how warm it got, how much battery
   it used, the frames dropped (Camera settings, Recording) and how much the storage meter went up;
   the sizes of one attempt's clips per camera (scramble and solve, in MB) and the codecs Chrome
   chose; and the capture lab's `clock` values of its "VideoFrame.timestamp" section.

| Date | Device, OS | Chrome | Cube: model, hardware, firmware | Camera | App (footer) | Result |
|---|---|---|---|---|---|---|
| | MacBook Pro 2021, macOS: | | GAN 12 ui FreePlay: | FaceTime HD | | |
| | ThinkPhone, Android: | | GAN 12 ui FreePlay: | front | | |
| | ThinkPhone, Android: | | GAN 12 ui FreePlay: | rear | | |

**Known limitations** (from the phase 2 pull requests), not to be reported as surprises:

- H.264 and AAC are untested in CI: Playwright's Chromium has neither encoder, so every automated
  test records VP9 and Opus, and the round's clips are the first H.264 ones. The codecs are in Camera
  settings (Recording, "Codecs") and in each clip's `video` entry. Where Chrome has no AAC encoder the
  sound is Opus, which is fine: write it down.
- The sync check waits for a clean attempt start: it is due by itself only before a scramble's first
  turn, with a cube connected and the camera recording, once per session and camera, so a camera
  turned on mid-scramble or mid-solve gets its check at the next attempt. It matches single turns
  only: a turn with another move less than half a second before or after it does not count, so pause
  about a second after each turn. With the whole frame as the framing rectangle (or most of it) it
  asks first for a rectangle around the cube (T2.8).
- The first scramble after the camera is turned on needs 2 s of recording before its first turn: a
  scramble begun sooner loses its clip ("A clip could not be saved…"), which a T2.4 item uses on
  purpose.
- Demo mode needs the network: its solves are downloaded when a demo starts.
- A clip begins at the keyframe at or before its margin: 2 to 3 s before the scramble's first turn,
  3 to 4 s before the solve's.
- The sharpness threshold, 20, was set on Chrome's test camera only; this round sets it per camera.
- The clip viewer places each move at the time its Bluetooth packet arrived, without the camera's
  lag: the highlighted move can lead the picture by the sync check's X ms.
- From 95% of the storage quota the camera stops recording while the timer goes on. Exporting frees
  nothing (the export is the JSON records only): delete sessions, after downloading the clips to
  keep.
- Turning the phone while it records restarts the recording at the new frame size: the attempt under
  way can lose its clips. So does a change of Video quality or Record audio: change them between
  attempts.

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

## T2.3 — clips

On https://shermam.github.io/cubetrace/capture-lab, on the MacBook's FaceTime camera and on both
ThinkPhone cameras (Playwright's Chromium in CI encodes VP9 and Opus only, so H.264 and AAC clips are
muxed nowhere else). Next to each item, write the device, the camera and Chrome's version.

- [ ] Start, wait 5 s, "Mux and save the last 3 s": the status says Saved with the number of frames;
  "Last clip" lists `lab.solve.frames.json` and `lab.solve.mp4`; the video plays the camera's
  picture with its sound, upright on the phone held upright; the line under it says the video
  element's duration and the frames file's, about the same. In the JSON, write down `codec` (H.264,
  `avc1.640028` or `avc1.4d0028`, expected on both devices) and `audio` (`mp4a.40.2` or `opus`).
- [ ] Cut length 30, wait 35 s, "Mux and save the last 30 s": write down the time it says it took
  and the MP4's size; the counters' dropped frames stay as they were.

## T2.4 — recording

On https://shermam.github.io/cubetrace/, Timer page, with the GAN 12 ui FreePlay, on the MacBook's
FaceTime camera and on the ThinkPhone's front camera (the phone on a stand, as the owner solves),
then once with the rear camera. Next to each item, write the device, the camera, Chrome's version
and the numbers asked for. The clips of CI's runs are VP9 and Opus; these are the first H.264 and AAC
clips of the timer.

- [ ] Camera on, cube connected: the Camera section's Recording part says "Recording: every attempt
  gets its clips" (REC next to its title, "recording" in the section's summary), with the frames in,
  encoded and dropped, the seconds in memory and the codecs (write them down: H.264 `avc1.…` and
  `mp4a.40.2` expected). Chrome asks once for the microphone; with Settings → Camera → Record audio
  off, it does not, and the codecs say "no audio".
- [ ] Three solves: each row of the solve list gets a badge "2 clips, … MB" about a second after the
  solve (write down the sizes of one: about 20 MB per attempt at 1080p30 and the Standard video
  quality, T2.10).
- [ ] The badge opens the viewer: the solve's clip plays, upright, with sound; the moves on the right
  follow the video (the one the video shows is highlighted), and a click on a move goes to it. The
  scramble's clip plays too. Write down whether the highlighted move matches the cube in the picture
  within a frame or two (the clips' times come from the camera's frames; the moves' from Bluetooth).
- [ ] The scramble clip begins about 2 s (at most 3 s) before the first turn of the scramble, and
  ends about 1 s after its last turn; the solve clip begins about 3 s (at most 4 s) before the first
  turn of the solve and ends about 1 s after the cube is solved. Check it in the viewer: the first
  move's time in the list is the lead (2.xx s for the scramble, 3.xx s for the solve).
- [ ] Download in the viewer gives five files: both MP4s, both frames files and attempt.json (Chrome
  may ask once to allow multiple downloads: Allow). The MP4s play in the system's player (QuickTime,
  VLC or the phone's gallery).
- [ ] A DNF (Esc) during a solve: its row gets both clips, the solve clip ending about 1 s after the
  Esc. A DNF right after the scramble (before the first turn of the solve): only the scramble clip.
- [ ] "Mark as solved" in the middle of a solve: no row, and in the attempt's folder no clip is left
  (the scramble clip saved for it is removed; with the camera still on, the restarted attempt gets
  its own clips).
- [ ] The Sessions page shows the storage meter ("… of … (…%)") and, on each session with clips, "N
  clips, … MB". The export is still one JSON file (the clips are downloaded per attempt).
- [ ] Twenty minutes of solves with the camera on, on the phone on its stand, plugged in: write down
  how warm it gets (touch: cool, warm, hot), whether Chrome or the phone slows down, the dropped
  frames in the Recording part at the end (0 expected), and how much the storage meter went up.
- [ ] A failed clip: with the camera on, turn it off right after a solve (within a second): the
  solve's clip is still saved (the clips waiting for their time are saved at once when recording
  stops). To see a failure, start the camera and a solve at once (the first scramble within 2 s of
  Turn on): the Recording part says "A clip could not be saved…" once, Chrome's console (on the
  phone, `chrome://inspect`) has one line `cubetrace: clip failed: scramble of attempt N: …`, and the
  session's export has that line in `notes`; the attempt itself is saved as usual.

## T2.7 — layout

On https://shermam.github.io/cubetrace/, Timer page, with a cube connected and the camera on, on
the MacBook (Chrome at the size its window opens with, not full screen) and on the ThinkPhone
(Chrome, then the installed app). Since T2.7 the Camera section of the T2.1 and T2.4 items above is
**Camera settings**, a disclosure below the Cube section: the camera's picture is beside the time
(under it on the phone), and the framing rectangle is dragged after Framing → Edit. Next to each
item, write the device, Chrome's version and the window's size (`innerWidth` × `innerHeight` in the
console, or `chrome://inspect` on the phone).

- [ ] MacBook: the scramble (moves and picture), the time and the camera's preview are all in view
  together without scrolling, the preview beside the time, about 240 px high, and under it one line:
  the frame rate (about 30 fps), the sharpness (green when good, amber when soft), "recording" with
  a red dot during a session ("saving" for a moment after each scramble and solve), and storage in
  percent.
- [ ] ThinkPhone in portrait, in Chrome and in the installed app: scramble, time and preview (under
  the time, the width of the screen) in view together without scrolling, and nothing scrolls
  sideways. If the bottom of the preview is cut off in Chrome (with its address bar), write down by
  how much.
- [ ] The preview stays in view through a whole attempt, the page not moving: scrambling, armed,
  solving, and after the solve. It shows the framing rectangle; a front camera's preview is mirrored
  like a mirror.
- [ ] The sharpness number under the preview stays the same while a solve is under way (it is not
  measured then, so that no move of the solve waits for it) and changes again after it.
- [ ] Fifteen solves or more: the Timer page lists the last 12, newest first, with "N solves in this
  session · See all"; See all opens the session's page with all of them and the same ao12 as the
  Timer page (ao100 says "–" until the session has 100 attempts).
- [ ] The session's page: its date, device, cube, camera and clips with their size; a clip badge opens
  the viewer, which plays the clip and downloads the five files. The same for an older session,
  opened from the Sessions page (its date is a link). Reload the page: the same. Export saves the
  session's JSON; Delete… then Delete removes it and goes back to the Sessions page.
- [ ] Camera settings: closed the first time, until the camera is on; then open by themselves. Closed
  by hand, they stay closed across a reload, and opened, open. The camera picker, Turn on and off,
  the resolution, the frame rate, Record audio, the exposure, focus, white balance, zoom and torch
  (the ThinkPhone), and the framing (Edit, Full frame) are all in them.

## T2.5 — sync check

On https://shermam.github.io/cubetrace/, Timer page, with the GAN 12 ui FreePlay, on the MacBook's
FaceTime camera and on the ThinkPhone's front camera (the phone on its stand), then its rear camera.
Next to each item, write the device, the camera, Chrome's version and the numbers asked for. The
check measures how far the camera's frames lag the cube (`docs/PLAN.md`, T2.5; since T2.8 it looks
for each turn's motion in the frames around it, inside the framing rectangle): the lag goes into the
session (`clock.cameras`) and into every later clip of that camera (`syncResidualMs`), for the
training pipeline to subtract. While it runs, and until the cube has been still for a few seconds
after it, the timer tracks no attempt, so its turns are in no record.

- [ ] The framing hint (T2.8): camera on with the framing rectangle as the whole frame (Camera
  settings → Framing → Full frame), cube connected and solved, a new session (Sessions → New
  session, or the day's first attempt): once the line under the camera's picture says "recording",
  "Sync check" appears under that line with "Draw the framing rectangle around the cube first
  (Camera settings → Framing → Edit): the check looks for motion inside it.", "Edit the framing",
  "Start anyway" and "Later", and the timer's scramble is still there to turn. "Edit the framing"
  opens Camera settings to the rectangle over the larger picture: draw it around the cube and the
  hands, as they are while turning (well under two thirds of the frame). The hint then says "The
  framing rectangle is set: start the check with the cube in it." Press Done, then Start.
- [ ] A check: after Start (or by itself, at a new session's start, once the camera has a rectangle
  around the cube), it says "Turn one face, pause, turn it back; repeat five times" and counts down
  20 s for the first turn; the timer's status line says "Sync check: …" and the scramble waits. Turn
  one face a quarter turn, hold the cube and the hands still for about a second, turn it back, hold
  still again, five times over: the panel counts "Turn 1 of 10 · 1 seen by the camera", and so on
  (the second number is the turns whose motion the camera saw). It never gives up in the middle:
  take a longer pause once and see that it waits. About a second after the tenth turn it says
  "Camera lags the cube by X ms (±Y)". Write down X and Y. The status line then says "Sync check
  over: the attempt begins once the cube is still": turn the face once more and back within two
  seconds and see that the timer keeps waiting; hold still, and the timer is back on the same
  scramble and attempt number (the cube solved again), with none of those turns in the scramble.
- [ ] The offset is stable: "Sync check" (the line under the picture), the same turns: it says "…;
  was X ms". The two offsets are within 10 ms of each other and both spreads under 40 ms. Write down
  both checks.
- [ ] A failure says why and offers Retry and "Download check data": 20 s without turning ("the cube
  did not move"); the turns with the lens covered ("no motion seen in the framing rectangle"); the
  turns made quickly, without pauses ("fewer than 4 matches …", which says why the turns it counts
  were not matched). Retry runs it again; Later ends it and hides it, and the line under the picture
  then says "this camera has no check in this session". After each, the timer is back on its
  scramble once the cube is solved and still (turn the face back if it is not). For every failure
  without a clear reason, press "Download check data" and attach the file
  (`cubetrace-sync-check-<time>.json`: the camera, the framing rectangle, how the frames were read,
  every frame's motion, the cube's moves and what the check saw around each turn) to an issue with
  the console's `cubetrace: sync check …` line. After a success the same data is behind the small
  "Download check data" link.
- [ ] "Sync check" is not offered once a scramble has begun, nor during the solve, nor without a
  cube: the reason is written beside it ("Before the scramble's first turn, or after the solve.",
  "After the solve.", "Once a cube is connected."). It is offered again at the next attempt, before
  the scramble's first turn.
- [ ] Three solves after a check, then Sessions → Export: in `session.json`,
  `clock.cameras.<camera>` has `offsetMs` (X), `rttMs` and `driftPpm` 0, `clapperboardResidualMs`
  (Y), `clapperboardSamples` (10, or fewer when a turn was not seen; at least 4) and the matched
  `samples`; the attempts recorded after the check have `syncResidualMs` X in their `video` entries,
  those recorded before it null. The attempt that was waiting for the check has none of its turns in
  `moves`, and `scrambleCorrected` false unless its own scramble went wrong. Paste the
  `clock.cameras` entry here.
- [ ] https://shermam.github.io/cubetrace/capture-lab, each camera: Start, connect the cube with the
  cube button at the top, Sync check. Before turning, wave a hand in front of the camera: the two
  bars ("Mean difference" and "Changed area") jump, and the line under them says the frames' pixel
  format (such as NV12) and "copied out (VideoFrame.copyTo)"; write both down. Then the same turns
  (the lab watches the whole frame: keep the rest of the picture still). Write down the lag it says
  and "Measuring a frame took the capture worker … ms (95th percentile … ms)": the plan allows 2 ms
  per frame. When a check fails for no clear reason, "Download check data" and attach the file to an
  issue.
- [ ] Fill in the "Camera lag" table of `docs/DEVICES.md` from the numbers above (or paste them into
  the round's issue for the coordinator).

## T2.10 — video quality

On https://shermam.github.io/cubetrace/, Timer page, on the MacBook's FaceTime camera with the GAN 12
ui FreePlay. Next to the item, write Chrome's version and the numbers asked for. The first recordings
(`docs/DEVICES.md`) were at 8 Mbps, High since T2.10: 20–25 MB per solve clip.

- [ ] Standard quality, the default (Settings → Camera → Video quality says "Standard (4 Mbps, ≈ 20 MB
  per attempt)"): Camera settings' Recording part says the codecs at 4 Mbps ("avc1.640028 at 4 Mbps,
  mp4a.40.2" expected). After a solve, its "Last clip" line gives the solve clip's frames and size: a
  20 s solve clip (600 frames) is about 10 MB, half of the first recordings'; the row's badge ("2
  clips, … MB") about 20 MB for the attempt. Write down the frames and sizes of one attempt.
