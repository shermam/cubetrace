# Manual tests (real hardware)

Agents cannot run these; the owner does, after the coordinator asks. Each task that adds a
hardware path appends its checklist here. Record the date, the device, the browser version
and the result next to each item.

## T1.5 — cube connection

Through the connect dialog (T1.6a: click the cube pill in the header, or "Connect a cube" on the
Timer page), in a current Chrome (the driver needs the Observable API). The flag below is
`chrome://flags/#enable-web-bluetooth-new-permissions-backend` (`docs/TOOLCHAIN.md`, "GAN driver");
the dialog names it, with a Copy button. The moves are read in the Timer page's Cube panel, whose
move log lists the last 20 moves, newest first: the move, its cube ms, the gap to the move before on
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

- [ ] Ten attempts in a row: each is armed exactly when the cube matches the scramble;
  the timer starts on the first turn and stops on solved; the time matches a stopwatch
  within 0.2 s.
- [ ] Mis-scramble on purpose (one wrong turn): the undo guidance shows the inverse move,
  clears when done, the attempt arms afterwards and is tagged as corrected.
- [ ] CFOP breakdown looks right for a solve you narrate (cross, four pairs, two-look OLL,
  PLL).
- [ ] Reload the page mid-session: the session and its attempts are still there.
- [ ] Export the session: the JSON validates against `docs/DATA-MODEL.md`.

## T1.7 — PWA on the phone

On https://shermam.github.io/cubetrace/ after the Pages deploy. Until T1.6 the wake lock is
turned on with the switch in Settings; from T1.6 on, the timer turns it on during a session.

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
