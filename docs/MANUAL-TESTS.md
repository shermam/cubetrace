# Manual tests (real hardware)

Agents cannot run these; the owner does, after the coordinator asks. Each task that adds a
hardware path appends its checklist here. Record the date, the device, the browser version
and the result next to each item.

## T1.5 — cube connection

- [ ] Connect the GAN 12 ui FreePlay on a laptop (Chrome, macOS or Windows): the connect
  screen finds the cube, reads the MAC automatically with the flag on, and shows model,
  firmware, battery within 5 s.
- [ ] Same with the flag off: the screen explains the flag and offers manual MAC entry;
  manual entry connects.
- [ ] Same on the ThinkPhone (Chrome for Android).
- [ ] Same with the GAN 356 i3.
- [ ] Turn faces slowly and fast: every move appears in the move log in order, with
  `cubeMs` increasing; slices appear as two moves a few ms apart.
- [ ] Walk away 30 s, turn: the connection is still alive (or reconnects and says so).
- [ ] Turn the cube off and on: the app shows disconnected, then reconnects on request.

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

- [ ] Install to the home screen on the ThinkPhone; open it; the screen stays on during a
  session (wake lock); orientation behaves as set.
