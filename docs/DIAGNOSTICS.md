# Diagnostics

The app's own log of its use, kept in the account (`docs/PLAN.md` T3.9): signed in, each device
writes an event for the facts that `docs/MANUAL-TESTS.md` asked the owner to write down (the app
started on which build, a cube connected and how its address came, an attempt ended and with what,
a clip saved or not, a sync check's lag, an upload's state, an error), into `users/{uid}/events` in
Firestore (`docs/DATA-MODEL.md` §10). The coordinator reads them with the round report below and
ticks the rounds' checklists from them; the owner looks only at what the events cannot show (the
"Still needs eyes" column). Signed out, nothing leaves the device, as the README promises: the
events raised then wait in memory for a sign-in during the page's life, and are gone with the page.

## The event

One document per event, `users/{uid}/events/{eventId}`, created whole by the device that saw it
and never changed or deleted by the app (the rules, `firebase/firestore.rules`); its id is the
event's time as 13 digits, a dash and 8 random hex digits, so that a device's ids sort by time.

```jsonc
// users/Xb3…uid/events/1790000012345-a1b2c3d4
{
  "schema": 1,
  "tsMs": 1790000012345.5,                       // host ms on the device's clock (§1 of the data model)
  "kind": "attempt.done",                         // the catalogue below
  "app": {"version": "0.4.0", "commit": "abc1234"}, // the build that wrote it
  "device": {"label": "office-mbp", "platform": "macOS", "installed": false},
  "session": "3f1c…",                             // when it belongs to a session
  "attempt": 17,                                  // when it belongs to an attempt (its index)
  "data": {"status": "solved", "timeMs": 14990, "clips": 2, "replayOk": true, "gyroRateHz": 49.8}
}
```

`device.label` is the host label the account records (Settings → This device), `platform` the
host's (`host.platform` of session.json) and `installed` whether the app ran installed (display
mode `standalone`). `data` holds the event's facts, named per kind below: at most 32, each a text
of at most 500 characters, a number, a boolean or null, or a map of those (one level of nesting).
The builder (`cloudEvent` in `packages/core/src/cloud-event.ts`) holds every event to those shapes,
cuts longer texts and scrubs what looks like a MAC address or an email out of every text; the JSON
Schema is `packages/core/schema/cloud-event.schema.json` and the reader `parseCloudEvent`.

**Never in an event**: a MAC address, an email, a file's contents, a user agent, a video, a move
list, or another account's uid. The cube's events say how its address came (`stored`, `driver`,
`typed`), never which; `cubes.synced` counts the cubes, never names them; a failure to connect says
its kind, never its message, which may name the address typed; the device is its label and
platform, not its user agent. `apps/web/e2e/diagnostics.spec.ts` searches a run's events for an
address, an email and a user agent.

## The writer

`DiagnosticsService` (`apps/web/src/app/diagnostics/diagnostics-service.ts`), made on every page
load by the header's controls: `record(kind, data, scope?)`, called where a fact is known (the
services, never a template), never throws and never waits. An event is queued in memory and the
queue goes to Firestore in one batch (`AccountBackend.saveEvents`, a `writeBatch`) 5 s after its
first event, as soon as 20 are queued, and when the page is hidden (`visibilitychange`) or goes away
(`pagehide`); offline, Firestore's persistent cache carries the batch until the network is back,
across reloads. A batch flushed as the page goes away is not sure to arrive, though: the SDK
persists it in a moment the page may not have when it unloads at once (a reload, a closed tab), so
the last seconds of events before one can be lost; a page hidden and alive (a phone backgrounded,
another tab in front) has that moment, and the app's own navigation never unloads. An attempt's
`attempt.done` waits for its clips (a remote camera's too, T4.2) and gyro file (at most 15 s) and is
lost the same way if the page unloads before. The session and attempt under way (which `SessionService` keeps) go on every event
recorded without a scope of its own.

- **Signed in only.** With no account signed in, the events wait in a ring of the last 500 and go
  when a sign-in comes during the page's life (so that a session's start recorded before the
  sign-in is not lost); a reload empties the ring. A sign-out writes what is queued first, so that
  nothing goes under the next account.
- **The setting.** Settings → Account → Diagnostics, on by default: off, the app records one last
  `settings.changed` (`diagnostics` false), writes it, and keeps nothing more, not even the ring;
  on again, it records `settings.changed` (`diagnostics` true) and goes on. When the page is hidden
  or goes away, the switch's new value takes effect before what is queued is written, so its event
  goes with that batch even when the page is left right after the toggle.
- **The daily cap.** A device writes at most 2,000 events a local day, counted in `localStorage`
  (`cubetrace.diagnostics`, with the build last seen, for `app.start`); past it, only the `error.*`
  kinds go until the next day. An attempt with the camera on costs 3 events (`attempt.done`, two
  `clip.saved`), 6 with uploads (three `upload.state`): the end-to-end flows measure it and annotate
  their reports (`events per attempt`; the demo flow shows 7, four of them the demo cube's
  reconnection at each replay, `cube.disconnected`, `cube.connected` and the wake lock going and
  coming with it, which a real cube's session does not have). At the owner's cadence (130 to 150
  attempts a day) a device writes about 900 events of its attempts and about a hundred of the rest
  (the starts, the pages, the cube, the camera, the settings), so about 1,000 a day, within the cap
  and far under Firestore's free tier of 20,000 writes a day (the session index's writes, about
  three per attempt, come on top). A phone paired as a camera (T4.2) adds 6 events per attempt on
  the host (each clip's `remote.cut` sent and done, and its `remote.clip`) and none on the phone
  unless a cut fails: about 1,900 a day with a phone, still within the cap, which a day of more
  than about 155 attempts with a phone would reach (the `error.*` kinds go on all the same).
- **What goes wrong stays out.** A kind that is not one, facts that cannot be made into an event, a
  batch the server refuses: said once in the console (`cubetrace: diagnostics: …`) and dropped; the
  diagnostics never record themselves.

## The catalogue

Each kind with when it is recorded and what its `data` holds. Where a fact is null, the app did not
know it (a camera without a frame rate, a cube without a production date).

| Kind | When | `data` |
|---|---|---|
| `app.start` | The page loaded and the storage's persistence is known (a few ms in). | `installed`, `online`, `persisted` (`persistent`, `best-effort`, `unknown`, `unsupported`), `previousVersion` and `previousCommit` (the build last seen on this device; null on its first start), `updated` (that build differs: the update evidence), `firstStart` |
| `account.signin` | A sign-in ended: with the popup (`outcome` `ok`), a remembered account at start (`resumed`), or not (`failed`). | `outcome`, `installed`, `code` (failed: Firebase's, such as `auth/popup-closed-by-user`, or the error's name), `resumed` (a failed start) |
| `account.signout` | Sign out, written before the account goes. | `installed` |
| `network.changed` | The window's `online` or `offline` event. | `online` |
| `page.viewed` | The router ended a navigation (a session page carries the session viewed). | `page` (`timer`, `sessions`, `session`, `qa`, `settings`, `probe`, `capture-lab`), `demo` (the address asked for the demo) |
| `settings.changed` | A setting the checklists name changed (not its first value): `hostLabel`, `inspection`, `autoAdvance`, `scrambleOverPicture`, `idleDisconnectMinutes`, `cameraResolution`, `cameraFrameRate`, `sharpnessThreshold`, `recordAudio`, `microphoneProcessing`, `videoQuality`, `demoSpeed`, `uploadSessions`, `wifiOnly`, `keepLocalCopies`, `diagnostics`, `recordRemoteCameras` (T4.2). Settings → Keep the screen on is no setting: `wake.lock` says whether the lock is wanted. | `key`, `value` |
| `wake.lock` | The screen wake lock's status changed. | `status` (`active`, `inactive`, `error`, `unsupported`), `wanted` (the Settings switch) |
| `storage.persistence` | The browser's answer on keeping the data changed (Keep my data, the first session). | `state` (`persistent`, `best-effort`, `unsupported`), `refused` |
| `cube.connected` | A cube said what it is, right after connecting. | `kind` (`gan`, or `fake` for the demo cube), `model`, `hardware`, `firmware`, `gyro`, `productDate`, `mac` (`stored`: Settings' list, typed here before or synced from the account; `driver`: read by Chrome from the advertisement, the flag; `typed`: the connect dialog; `none`: the demo), `ms` (from the click to the connection), `battery` |
| `cube.failed` | Connecting failed. | `reason` (`cancelled`: the picker closed; `no-bluetooth`; `blocked`; `no-mac`: the prompt cancelled; `mac-unreadable`; `no-state`: the cube did not send its state, a wrong address; `disconnected`; `not-gan`; `unreachable`; `other`; `demo`: the demo solves could not be loaded), `mac` (as above), `ms` |
| `cube.disconnected` | A connection ended, whether the app asked for it or not: the facts `CubeService` logs as `cubetrace: the cube disconnected`. | `kind`, `requested`, `reason` (the connection's, or the app's), `idleMs` (since the last turn, or since connecting), `visibilityState`, `hiddenMs` (how long the tab had been hidden; null if visible), `connectedMs`, `battery`, `model`, `moves` (reported by the connection) |
| `cube.reset` | Mark as solved. | `kind` |
| `cube.resync` | The cube reported a state the attempt did not have: adopted. | `state` (the attempt's state before), `after` |
| `cubes.synced` | Settings' cube list merged with the account's (a sign-in, a start signed in). | `count` (the list after the merge), `cloud` (the account's documents read), `unreadable`, `fromServer` (not the cache) |
| `session.started` | A session was created. | `host`, `platform`, `isPhone`, `model`, `hardware` (`simulated` for the demo), `firmware`, `gyro`, `productDate`, `audio`, `inspection15s`, `autoAdvance`, `battery`, `storage` (`opfs` or `memory`) |
| `session.deleted` | A session deleted from the device (Sessions, a session's page). | `current` (the session being recorded), `attempts` (known for the current session) |
| `attempt.done` | An attempt ended (solved or a DNF), once its clips (a remote camera's too, T4.2) and gyro file were saved or known absent (at most 15 s after the end), so that it counts them. | `status`, `timeMs`, `inspectionMs`, `movesQtm`, `tps`, `replayOk`, `scrambleCorrected`, `scrambleExtraMoves`, `phases` (count), `pickup` (present), `clockResidualP95Ms`, `clockSamples`, `clockA` (the fit's slope), `gyroSamples`, `gyroRateHz`, `gyroTruncated`, `resyncs` (count), `clips` (count), `clipsLate` (truncated starts), `clipBytes`, `syncResidualMs` (of its clips), `scrambleMs` (first turn to done), `settledMs` (from the end to this event), `settled` (nothing of it was still to come) |
| `attempt.deleted` | Delete last. | `status`, `timeMs`, `clips` |
| `camera.on` | The camera came on (not a reopening of the same camera: a resolution changed, its controls reset). | `label` (the browser's name of the camera), `facing`, `width`, `height`, `fps` (the track's settings), `asked` (the mode asked for), `notes` (fallbacks on the way) |
| `camera.switched` | Another camera took the open one's place. | As `camera.on`, and `from` |
| `camera.off` | Turn off. | `label` |
| `recording.started` | The pipeline chose its encoder (its first stats); on a camera device (T4.1) too. | `camera` (the label in the session; the phone's own label on a camera device), `codec`, `audioCodec`, `bitrate`, `quality`, `audio` (asked for), `processing` (`raw`, `voice`; null without a microphone), `applied` (`echoCancellation`, `noiseSuppression`, `autoGainControl`, `voiceIsolation` as the browser applied them; the host only), `width`, `height`, `fps`, `remote` (true on a camera device) |
| `recording.stopped` | The pipeline is to stop. | `why` (`camera-off`, `no-session`, `storage-full`, `unsupported`; `left` when the Camera page of a camera device closes, T4.1), `dropped` (frames, at the stop), `bufferSeconds`, `encodedFps` |
| `recording.notice` | A notice of the recording (no audio and why, the microphone not raw, the clip worker failed), once per run. | `message` |
| `clip.saved` | A clip was written and added to its attempt's record. | `segment`, `camera`, `bytes`, `frames`, `codec`, `audioCodec`, `audio` (present), `truncatedStart`, `lateMs`, `bufferSeconds`, `syncResidualMs`, `audioRebasedMs`, `kept` (for a record still to come) |
| `clip.failed` | A clip could not be saved (`cubetrace: clip failed: …`). | `segment`, `reason` |
| `audio.missing` | A clip has no sound although the sound is recorded. | `segment`, `cause` |
| `sync.check` | A sync check ended (`cubetrace: sync check …`). | `outcome` (`ok`, `failed`), `reason` and `message` (failed), `camera` (the label in the session), `offsetMs`, `spreadMs`, `previousOffsetMs`, `matched`, `of` (turns), `kept`, `moves`, `frames`, `durationMs`, `frameIntervalMs`, `wide` (the framing rectangle was the whole frame), `costMs` (per frame), `saved` (into the session) |
| `upload.state` | An attempt's upload reached a state for the first time in this page load (`pending`, `uploading`, `done`, `failed`; not `waiting` for its clips; the queue's moves back and forth between pending and uploading as it works through the files are not repeated). | `state`, `files`, `bytes`, `sent`, `tries`, `error`, `failedFile` |
| `upload.paused` | What holds the queue changed: paused. | `reason` (`offline`, `wifi`, `quota`), `untilMs` (quota), `left` (attempts) |
| `upload.resumed` | The queue goes on. | – |
| `storage.deleted` | Uploaded clips were deleted from the device by policy. | `files`, `bytes`, `usageBefore`, `usageAfter`, `percent` (after) |
| `clips.viewed` | The clip viewer opened an attempt. | `clips`, `local` (still on the device), `gyro` |
| `files.downloaded` | Files handed to the user. | `what` (`clips`: the viewer's Download; `export`: Sessions → Export or a session's page; `sync-check`: Download check data; `probe`: the probe's report), `files` (count), `names`, `attempts` (an export) |
| `rtc.paired` | A remote camera paired (T4.1, `docs/RTC.md` §8): the hellos exchanged. On the host: the phone; on the phone: the host. | host: `peer` (the phone's host label), `platform`, `camera` (its label in the session), `facing`, `deviceLabel`, `version` and `commit` (the phone's build), `ms` (from the offer to the hellos); phone: `host`, `platform`, `session`, `version`, `commit`, `ms` |
| `rtc.connected` | A connection with a remote camera opened: the first one, or one made again after a drop. | As `rtc.paired`'s device facts, and `reconnection` |
| `rtc.disconnected` | A connection with a remote camera ended: the other side left (`left: …`, `host left: …`), the host removed the camera or the session ended (the host), the transport closed or failed (the reason), five minutes without the other side (`gave up: …`). | `reason`, `durationMs` (the connection's), `connectedMs` (host: since the pairing), `peer` / `host`, `camera` |
| `rtc.clock` | The clock sync of a remote camera (the host): at convergence, once a minute while converged, and when convergence is withdrawn. | `camera`, `peer`, `why` (`converged`, `minute`, `withdrawn`), `converged`, `offsetMs`, `rttMs`, `driftPpm`, `samples`, `residualP95Ms` |
| `rtc.failed` | A step of the pairing or the connection failed (either side). | `step` (host: `pairing`, `watch`, `connect`, `hello`, `version`; phone: `session`, `check`, `connect`, `hello`, `version`), `reason`, `peer` (host) |
| `remote.cut` | A remote camera's cut (T4.2, `docs/RTC.md` §9). On the host: sent (once per clip, as soon as the camera is connected and its clock sync has an answer, converged or not), answered with the phone's offer (`done`), or not cut (`failed`, a failure); on the phone: not cut (`failed`). | `outcome` (`sent`, `done`, `failed`), `camera` (the label in the session), `peer` (the host: the phone's host label), `segment`, `reason` (sent: `armed` or `ended`; failed: the phone's words), `windowMs` (the host's window), `marginMs` (how far the window is widened on each side), `waitedMs` (from the milestone to the cut sent), `offsetMs`, `rttMs`, `samples` and `converged` (the clock estimate the cut relied on), `delayMs` (done, failed: from the window's end), `files`, `bytes`, `truncatedStart`, `lateMs` (done: what the phone's capture said) |
| `remote.clip` | A remote camera's clip is in its attempt's folder and record (the host). | `camera`, `peer`, `segment`, `bytes` (both files), `mp4Bytes`, `transferMs` (from the phone's offer to the record), `bytesPerSecond`, `resumedBytes` (held from an earlier connection: a transfer resumed), `late` (it was given up before), `kept` (for a record still to come), `converged` (the clock estimate its times were converted with), `offsetMs` (`t0RemoteMs` minus `t0HostMs`), `truncatedStart` |
| `remote.clip.late` | A remote clip given up came after all: attached to its attempt, noted, and uploaded as an addition (the host). | `camera`, `peer`, `segment`, `afterEndMs` (from the attempt's end), `afterMissedMs` (from when it was given up) |
| `remote.clip.missing` | A remote clip expected is given up (a failure): its attempt goes to the upload queue without it, and the session's notes name the camera (the host). | `camera`, `peer`, `segment`, `reason` (`wait`: none within 120 s of the attempt's end; `cut-failed`: the phone could not cut it; `left`: the phone left or was let go; `refused`: its frames file could not be read), `message`, `afterEndMs` |
| `error.app` | What the app says in the console as `cubetrace: …` (a record that could not be saved, the index refusing a write, a cube's write refused, the camera refused, the recording stopped, the uploads not starting, a gyro file not written, the account's record not saved, the cube's state not reset, the clip viewer's choices not read or saved). | `where` (`store`, `index`, `cubes`, `camera`, `recording`, `uploads`, `gyro`, `account`, `cube`, `viewer`), `message`, `label` (the camera) |

## The checklists, read from the events

The items of `docs/MANUAL-TESTS.md` (rounds 1 to 3 and the items after T3.7, T4.1 and T4.2), each with the kinds
whose presence, with their facts, is its evidence, and what still needs the owner's eyes. The round
report evaluates the same table (`functions/scripts/report.mts`, `CHECKLIST`; the test holds the
two to each other): ✅ the evidence is there, with the facts beside it; ⬜ it is not; ❗ the events
show a failure (an `error.*`, a `clip.failed`, an `upload.state` failed, a `sync.check` failed, a
`cube.failed` other than the user's, a `remote.cut` failed, a `remote.clip.missing`). An item whose evidence is `–` has no event that could show it:
the owner does it with the round, as before. The owner does nothing else for the rounds: solving,
with the camera on and signed in, on both devices, is the round.

#### Round 1 (v0.1.0) — T1.5 — cube connection

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 1.5.1 | GAN 12 ui on a laptop with the flag on: no address asked, connected within 5 s | `cube.connected` | – |
| 1.5.2 | Flag off: the address typed connects; a wrong one fails within 5 s; remembered, the next connection does not ask; Cancel says no address was given | `cube.connected`, `cube.failed` | that the failure names the address typed, and the dialog with the flag folded under it |
| 1.5.3 | Chrome's picker closed without choosing: "No cube was chosen…", no dialog | `cube.failed` | the Details dialog with the hint, Connect cube and Demo cube |
| 1.5.4 | The same on the ThinkPhone | `cube.connected` | – |
| 1.5.5 | The same with the GAN 356 i3 | `cube.connected` | – |
| 1.5.6 | Scramble the cube, then connect: the state shown is the cube's | – | the net right after connecting |
| 1.5.7 | Faces turned slowly and fast: every move in order, cube time increasing, packets flagged | `attempt.done` | the move log itself (Gap, Host, ■) |
| 1.5.8 | Walk away 30 s, turn: the connection is still alive | `cube.disconnected`, `cube.connected` | – |
| 1.5.9 | Cube turned off and on: Reconnect connects it again | `cube.disconnected`, `cube.connected` | – |
| 1.5.10 | Disconnect from the app, then connect again without reloading | `cube.disconnected`, `cube.connected`, `app.start` | – |
| 1.5.11 | Mark as solved (T1.14): the net solved at once, the attempt begun again, nothing added, no stray moves after | `cube.reset`, `attempt.done` | whether the net matched the cube after the reconnection, and the two moves after the reset |
| 1.5.12 | Idle disconnection (T1.14): set to 1, the cube disconnects after a minute without a turn; Reconnect takes one click | `settings.changed`, `cube.disconnected`, `cube.connected` | – |
| 1.5.13 | Disconnect diagnostics (T1.14): 10 minutes in another tab or app, idle at 0: whether the cube stays connected, and the facts of the disconnection | `cube.disconnected` | – |

#### Round 1 (v0.1.0) — T1.6 — timer

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 1.6.1 | Connected while scrambled: "Solve the cube first"; solved: attempt 1 begins, the picture matches | – | the status line and the scramble picture |
| 1.6.2 | Ten attempts in a row: armed when the cube matches, started on the first turn, stopped on solved, the next scramble at once | `attempt.done` | the time against a stopwatch (0.2 s) |
| 1.6.3 | A mis-scramble: the undo list, then the attempt arms and its row says Corrected | `attempt.done` | the undo list greying out |
| 1.6.4 | Scramble colours (T1.13) keep up with fast turning | – | the boxes on the scramble text |
| 1.6.5 | CFOP breakdown looks right for a solve narrated: eight phases in order | `attempt.done` | the phases against the solve narrated |
| 1.6.6 | Esc during a solve: DNF; Delete right after: the row goes; N before the first turn: a new scramble | `attempt.done`, `attempt.deleted` | N before the first turn (nothing is recorded, so nothing is shown) |
| 1.6.7 | 15-second inspection: the countdown once armed, started again from the pickup on the 12 ui | `settings.changed`, `attempt.done` | whether putting the cube down after the scramble already counts as the pickup |
| 1.6.8 | "Next scramble right after a solve" off: the time stays, Next begins the next attempt | `settings.changed`, `attempt.done` | – |
| 1.6.9 | Cube turned off mid-solve: the time stops; back on and reconnected, the same attempt ends | `cube.disconnected`, `cube.connected`, `attempt.done` | – |
| 1.6.10 | Reload mid-session, close and reopen: the solve list is back and the next attempt has the next number | `app.start`, `attempt.done`, `session.started` | – |
| 1.6.11 | Sessions page: the session listed; Export downloads the JSON; Delete asks first, then removes it | `page.viewed`, `files.downloaded`, `session.deleted` | that the export validates against the schemas (the coordinator, with ajv) |
| 1.6.12 | "Screen on" while a cube is connected during a session; "Screen may sleep" after it disconnects | `wake.lock`, `cube.disconnected` | – |

#### Round 1 (v0.1.0) — T1.7 — PWA on the phone

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 1.7.1 | Installed on the ThinkPhone: opened from the home screen, standalone | `app.start` | the icon and the name on the home screen |
| 1.7.2 | Rotate the phone: the app follows, nothing scrolls sideways | – | the layout in landscape |
| 1.7.3 | Keep the screen on: "Screen on", kept past the timeout and across apps; off: "Screen may sleep" | `wake.lock` | the screen staying on past the timeout |
| 1.7.4 | Keep my data in the installed app: Persistent | `app.start`, `storage.persistence` | – |
| 1.7.5 | The footer shows the build; after a deploy the new commit appears from the second launch | `app.start` | – |
| 1.7.6 | Airplane mode, opened from the home screen: it opens from the cache | `app.start` | – |
| 1.7.7 | Laptop: installed as a window; no banner about missing APIs | `app.start` | the banner |
| 1.7.8 | Firefox or Safari: the banner names the missing APIs; the pages render | – | the banner (those browsers record nothing) |

#### Round 2 (v0.2.0) — T2.1 — camera panel

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.1.1 | MacBook, FaceTime camera: 1920×1080 at 30 fps, no manual controls | `camera.on`, `recording.started` | the preview (not mirrored) and the controls line |
| 2.1.2 | ThinkPhone: Front and Rear cameras, the front mirrored; upright frames at about 30 fps | `camera.on`, `camera.switched` | the mirroring and the measured size |
| 2.1.3 | ThinkPhone: Exposure, Focus, White balance, Zoom; Torch on the rear camera | – | the controls |
| 2.1.4 | Manual exposure on the phone: time and ISO, kept across off, on and reload; Reset to auto | – | the picture and the controls |
| 2.1.5 | Focus on the front camera: Manual, then Auto again (reopened if needed) | – | the preview blinking |
| 2.1.6 | "Exactly 60 fps" on each camera and resolution: 60 fps measured, or the notice and 30 | `settings.changed`, `camera.on`, `camera.switched`, `recording.started` | the measured frame rate and the notice |
| 2.1.7 | Sharpness meter: the numbers with the cube sharp, covered, moving, and the threshold between them | `settings.changed` | the numbers (the meter is not in the events) |
| 2.1.8 | Framing rectangle: dragged, kept per camera across reloads and orientations | `sync.check` | the rectangle itself |
| 2.1.9 | Camera on across reloads: on, it opens again by itself; off, it stays off | `app.start`, `camera.on` | the camera light on the other pages |
| 2.1.10 | Permission denied: the panel says so and how to allow it (the system setting on a Mac) | `error.app` | the words |
| 2.1.11 | Another app holding the camera: "in use by another app" | `error.app` | – |

#### Round 2 (v0.2.0) — T2.3 — clips

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.3.1 | Capture lab: a 3 s clip plays with its sound; its codecs written down | `page.viewed` | the lab (its clips are not events) |
| 2.3.2 | Capture lab: a 30 s cut, its time and size; no frame dropped | `page.viewed` | the lab |

#### Round 2 (v0.2.0) — T2.4 — recording

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.4.1 | Camera on, cube connected: recording, with H.264 and AAC; without Record audio, "no audio" | `recording.started`, `settings.changed` | – |
| 2.4.2 | Three solves: each row gets "2 clips" about a second after; about 20 MB per attempt | `attempt.done`, `clip.saved` | – |
| 2.4.3 | The badge opens the viewer: the clips play with sound, the moves follow, a click seeks | `clips.viewed` | the highlighted move against the picture |
| 2.4.4 | The scramble clip begins 2–3 s before the first turn, the solve clip 3–4 s; both end 1 s after | `clip.saved` | the first move's time in the viewer's list |
| 2.4.5 | Download in the viewer gives five files, six with gyro.json; the MP4s play | `files.downloaded` | the MP4s in the system player |
| 2.4.6 | A DNF during a solve: both clips; a DNF right after the scramble: the scramble clip only | `attempt.done` | – |
| 2.4.7 | Mark as solved mid-solve: no row, no clip left; the restarted attempt gets its own | `cube.reset`, `attempt.done` | the attempt's folder |
| 2.4.8 | Sessions page: the storage meter and "N clips, … MB" per session; the export is one JSON file | `page.viewed`, `files.downloaded` | the meter |
| 2.4.9 | Twenty minutes of solves with the camera on, the phone on its stand: warmth, slowdowns, frames dropped, storage used | `recording.started`, `recording.stopped`, `attempt.done` | how warm the phone got |
| 2.4.10 | A clip at the edge: camera off right after a solve still saves the clip; a scramble within 2 s of Turn on gets a late clip | `clip.saved`, `camera.off` | – |

#### Round 2 (v0.2.0) — T2.9 — a long scramble, a reconnection, the sound

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.9.1 | A scramble with a 3-minute pause: both clips, the scramble clip about 61 s, not late | `attempt.done`, `clip.saved` | – |
| 2.9.2 | A solve after a reconnection: the clock fit from the moves after it (a 0.99–1.01, residual tens of ms) | `cube.disconnected`, `cube.connected`, `attempt.done` | – |
| 2.9.3 | The sound: the audio codec in the Codecs line; a clip plays with sound, or the notes say why not | `recording.started`, `audio.missing`, `clip.saved` | the sound itself |

#### Round 2 (v0.2.0) — T2.7 — layout

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.7.1 | MacBook: scramble, time and preview in view together, the line under the preview | – | the layout |
| 2.7.2 | ThinkPhone in portrait with the scramble over the picture off: all in view, nothing sideways | `settings.changed` | the layout |
| 2.7.3 | The preview stays in view through an attempt; the front camera mirrored | – | the layout |
| 2.7.4 | The sharpness number stays the same during a solve | – | the meter |
| 2.7.5 | Fifteen solves or more: the last 12 listed, See all opens the session page with the same ao12 | `attempt.done`, `page.viewed` | the ao12 on both pages |
| 2.7.6 | The session's page: its facts, a clip badge that opens the viewer and downloads the files, Export, Delete | `page.viewed`, `clips.viewed`, `files.downloaded`, `session.deleted` | – |
| 2.7.7 | Camera settings: closed until the camera is on, then open; kept as left across reloads | – | the disclosure |

#### Round 2 (v0.2.0) — T2.13 — the scramble over the picture (phone)

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.13.1 | The picture at the top with the scramble over it; readable while solving; the setting off and on | `settings.changed`, `attempt.done` | the strip, the hands and the moves on it |

#### Round 2 (v0.2.0) — T2.5 — sync check

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.5.1 | The framing hint (T2.8): with the whole frame as the rectangle, the check asks for one first | `sync.check` | the hint and its buttons |
| 2.5.2 | A check: "Hold still", the countdown, "Turn n of 10", then "Camera lags the cube by X ms (±Y)"; the attempt back on its scramble | `sync.check` | the panel through the check |
| 2.5.3 | The offset is stable: two checks of one camera within 25 ms, both spreads under 83 ms | `sync.check` | – |
| 2.5.4 | A failure says why (did not move, no motion, fewer than 4 matches), with Retry and the check data | `sync.check`, `files.downloaded` | – |
| 2.5.5 | Not offered once a scramble has begun, nor during a solve, nor without a cube | – | the line under the picture |
| 2.5.6 | Three solves after a check: clock.cameras in the export, the later clips with syncResidualMs | `sync.check`, `clip.saved` | the export (the coordinator) |
| 2.5.7 | Capture lab: the motion bars, the pixel format, the lag and the cost per frame | `page.viewed` | the lab |
| 2.5.8 | The "Camera lag" table of docs/DEVICES.md | `sync.check` | the coordinator writes it from the checks above |

#### Round 2 (v0.2.0) — T2.10 — video quality

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.10.1 | Standard quality: 4 Mbps, a 20 s solve clip about 10 MB, about 20 MB per attempt | `recording.started`, `clip.saved` | – |

#### Round 2 (v0.2.0) — T2.12 — the microphone

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.12.1 | A clip's sound has the cube's clicks; the panel says mic raw, no notice that the browser kept processing on | `recording.started`, `recording.notice`, `clip.saved` | the clicks in the sound |

#### Round 2 (v0.2.0) — T2.14 — two cameras in one session

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 2.14.1 | FaceTime then the Logitech then FaceTime again: laptop and laptop-2, a check each, the clips named after them | `camera.switched`, `sync.check`, `clip.saved` | the export (the coordinator) |

#### Round 3 (v0.3.0) — T3.0 — account

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 3.0.1 | Signed out: Sign in in the header; no request to Firebase over a reload and a demo solve | – | DevTools → Network (events signed out are written later, and say nothing of requests) |
| 3.0.2 | Sign in opens Google's window; the header shows the account; users/{uid} has the laptop's label | `account.signin` | users/{uid} in the Firebase console (the coordinator) |
| 3.0.3 | Reload: still signed in; Sign out, then Google's window closed without choosing: the cancellation said | `account.signin`, `account.signout` | – |
| 3.0.4 | The ThinkPhone, the installed app: Sign in with Google comes back signed in (T3.6) | `account.signin` | – |
| 3.0.5 | Signed in, airplane mode, the installed app opens signed in, the timer works and a solve is saved | `app.start`, `account.signin`, `attempt.done` | – |
| 3.0.6 | Sign out: Sign in again; a reload stays signed out, no Firebase request | `account.signout`, `app.start` | the Network panel |

#### Round 3 (v0.3.0) — T3.1 — the session index

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 3.1.1 | Signed in, a solve on the real cube: sessions/{id} and its attempt in the console, with device, video and upload | `attempt.done`, `error.app` | the documents in the Firebase console (the coordinator, or the QA view) |
| 3.1.2 | On the ThinkPhone, the MacBook's session as "cloud" (read-only), the phone's own as "both", the device filter | `page.viewed` | the badges and the filter |
| 3.1.3 | A solve on the phone, then the MacBook's Sessions page reloaded: the phone's session as "cloud" | `attempt.done`, `page.viewed` | the badge |
| 3.1.4 | Sessions recorded signed out: once signed in, the catch-up writes them ("both") | `account.signout`, `attempt.done`, `account.signin` | the document appearing in the console |
| 3.1.5 | Airplane mode on the phone, a solve: a dashed badge, a write waiting; back online, the document reaches the console | `network.changed`, `app.start`, `attempt.done` | the dashed badge |
| 3.1.6 | The QA view on each device: today's attempts per device, and this device's last sync | `page.viewed` | the numbers |
| 3.1.7 | Signed out on a device: the Sessions page without badges, filter or QA link | – | the page (the events say nothing of the account) |

#### Round 3 (v0.3.0) — T3.3 — uploads

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 3.3.1 | The MacBook: Upload sessions and Keep local copies on, no Wi-Fi only | `settings.changed` | Settings → Uploads |
| 3.3.2 | A solve with the camera on: ↑ 1 then nothing, "Up to date", the files in the bucket, upload.state done | `attempt.done`, `upload.state` | the bucket (the coordinator, with gcloud or rclone) |
| 3.3.3 | The QA view: today's row counts the attempt, its bytes uploaded, Pending 0 B | `page.viewed` | the numbers |
| 3.3.4 | Twenty solves in a row: the attempts upload as they come; session.json again two minutes after the last | `attempt.done`, `upload.state` | the functions' log for session.json (the coordinator) |
| 3.3.5 | Wi-Fi off during an upload: "Offline", then on by itself; a reload resumes without a second signature | `upload.paused`, `upload.resumed`, `app.start` | the functions' log (the coordinator) |
| 3.3.6 | Keep local copies off: the uploaded clips leave the device, "in the cloud", storage down | `settings.changed`, `storage.deleted` | the badges and the viewer |
| 3.3.7 | ThinkPhone, Wi-Fi only on, on mobile data: "Waiting for Wi-Fi"; Wi-Fi on: uploaded, the clips in the cloud | `upload.paused`, `upload.resumed`, `storage.deleted` | – |
| 3.3.8 | Wi-Fi only off on the phone, on mobile data: it uploads | `settings.changed`, `upload.state` | navigator.connection, if it waited anyway |
| 3.3.9 | A demo session signed in: nothing in the panel, nothing in the bucket | `session.started`, `upload.state` | – |
| 3.3.10 | Upload sessions off: a new solve stays on the device; on again, it goes; sign out mid-upload, sign in, it resumes | `settings.changed`, `upload.state`, `account.signout`, `account.signin` | – |
| 3.3.11 | Storage past 70% on the phone: the oldest uploaded clips deleted until under 60% | `storage.deleted` | – |

#### Round 3 (v0.3.0) — T3.4 — the cubes' MAC addresses, synced

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 3.4.1 | The ThinkPhone before signing in: the cube typed in round 1 still listed | – | Settings → Cube MAC addresses |
| 3.4.2 | Sign in on the ThinkPhone: "Synced with your account", the document in the console | `cubes.synced` | the document (the coordinator) |
| 3.4.3 | The MacBook, reloaded: the phone's cube listed; with the flag off it connects without asking | `cubes.synced`, `cube.connected` | – |
| 3.4.4 | Edit and Remove on the MacBook follow in the console; the ThinkPhone, reloaded, follows; typed again, it comes back | `cubes.synced` | the console and the lists |
| 3.4.5 | Airplane mode on the ThinkPhone, Remove: "1 change waits to be sent"; online, it goes | – | Settings (the merges carry no deletions) |
| 3.4.6 | Sign out on the MacBook: the list stays; a cube added signed out reaches the console at the next sign-in | `account.signout`, `cubes.synced` | the console |
| 3.4.7 | No MAC address in an export, nor in the uploaded attempt.json and session.json | – | the files (the coordinator searches them); the events themselves carry none by construction |

#### After T3.7 — the cube's whole record

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 3.7.1 | One attempt with the camera on: gyro.json beside the record, six files downloaded, the build and the moves' counters in attempt.json, the QA view's Gyro column | `attempt.done`, `files.downloaded`, `upload.state` | attempt.json's fields and the session's battery in the console (the coordinator) |

#### After T4.1 — T4.1 — remote cameras

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 4.1.1 | The pairing: the QR scanned on the ThinkPhone, "Connected" within a few seconds, the MacBook lists the phone with a picture every 2 s and its report | `rtc.paired`, `rtc.connected` | the picture and the report line; the time from the scan to "Connected" |
| 4.1.2 | The clock sync: synced within about 25 s, the round trip and the offset on both devices, synced over five minutes | `rtc.clock` | the phone's Clock line against the MacBook's |
| 4.1.3 | The code typed: Remove, Add camera again, the code typed on the phone: connected again, the same label | `rtc.disconnected`, `rtc.paired`, `rtc.connected` | the code typed in lower case with spaces |
| 4.1.4 | Walk away and back: reconnecting on both within half a minute, connected again within a minute without a new code | `rtc.disconnected`, `rtc.connected` | how long each took |
| 4.1.5 | Lock and unlock the phone: 20 s survived; 6 minutes let go after 5 and paired again with a new code; the screen on while connected | `rtc.disconnected`, `rtc.paired`, `wake.lock` | what Android did to the page in the background |
| 4.1.6 | Leave: the list empty at once, the entry kept, `session.json` with `remote` and the clock fit | `rtc.disconnected` | the session's page and the export (the coordinator) |
| 4.1.7 | A second phone listed as `phone-rear-2`; a phone with a used code refused | `rtc.paired`, `rtc.failed` | – |
| 4.1.8 | A demo session pairs, and is listed as "both" | `rtc.paired`, `session.started` | the Sessions page |

#### After T4.2 — T4.2 — remote clips

| # | Item | Evidence | Still needs eyes |
|---|---|---|---|
| 4.2.1 | Three solves with the phone paired: each attempt gets the phone's two clips within seconds of its end, its window widened by the margin, the clock sync converged or not | `remote.cut`, `remote.clip` | the phone's Clips line, back to none after each attempt |
| 4.2.2 | The attempt's folder has four clips, the laptop's and the phone's, attempt.json names them by label; the clip viewer switches between the cameras | `attempt.done`, `clips.viewed` | the viewer's buttons and pictures; attempt.json (the coordinator) |
| 4.2.3 | The bucket: the attempt's folder lists nine files, the phone's clips beside the laptop's | `upload.state` | the bucket's listing (the coordinator) |
| 4.2.4 | Walk away right after a solve, the phone's clip on its way: back in reach, the clip comes, its transfer resumed where it stopped | `remote.clip`, `rtc.connected` | the phone's Clips line while away |
| 4.2.5 | The phone's Wi-Fi off once its clip is cut, for three minutes: two minutes after the end the attempt is uploaded without it and the notes name the camera; Wi-Fi on, the clip comes late and is uploaded as an addition | `remote.clip.missing`, `remote.clip.late`, `upload.state` | the session's notes; the bucket's listing after the addition (the coordinator) |
| 4.2.6 | "Record remote cameras" off: the phone stays connected and records nothing for the session; on again, the next attempt has its clips | `settings.changed`, `remote.cut` | the phone's Clips line |

## The QA view

Sessions → QA view, signed in, has a Diagnostics section under the attempts' table: the account's
last 500 events (`orderBy('tsMs', 'desc')`, no composite index needed), aggregated on the device
(`apps/web/src/app/diagnostics/diagnostics-summary.ts`): per device its last `app.start` with the
build, its events and failures; the counts by kind over the last 7 days; the last 20 failures, with
what their facts say went wrong. Refresh reads them again.

## The round report

For the coordinator, with a service-account key of the project (never an agent's, `docs/USER-ACTIONS.md`):

```
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm run round-report -- --days 7 > report.md
```

`functions/scripts/round-report.mts` (Node 22 runs it as it is; it lives under `functions/` because
`firebase-admin` is the functions' dependency, and the deploy ignores the folder) reads every
account's `users/{uid}/events` of the last `--days` (7 by default; `--limit`, 20,000 per account;
`--uid`, one account) with the Admin SDK, past the rules, and prints Markdown: the events per device
and UTC day (attempts, clips, uploads done, failures, every kind's count), the checklists above
with ✅ ⬜ ❗ and the facts (the builds, the counts, the values measured), and the last 20 failures.
The key's path comes from `GOOGLE_APPLICATION_CREDENTIALS` alone, read by the Admin SDK; nothing
prints it, and the report names an account by the first characters of its uid, never an email.
`functions/scripts/report.test.ts` runs the table's logic over a fixture of events, without
Firestore (`npm test` runs it with the packages' tests).
