# Data model, schema version 2

Everything the app records is JSON plus MP4. This document is the contract between the
timer (phase 1), the capture pipeline (phase 2), the upload (phase 3) and the training
pipeline that reads the dataset. Change it only with a PR that bumps `schema` and adds a
CHANGELOG entry; never rewrite stored files.

## Versions

Every JSON file says its version in `schema`. **Version 2** (`docs/PLAN.md` T2.0; written by the
builds after cubetrace 0.1.0) changed, from version 1 (written by 0.1.0):

- `attempt.json` (§7): `schema` is 2; `clock`, the cube clock fit of the attempt's own moves, is
  new; `video` holds the attempt's clips, which version 1 declared and left empty.
- `session.json` (§6): `schema` is 2; `cameras` and `clock.cameras` hold the cameras and their
  clock sync, which version 1 declared and left empty; `clock.cube` is unchanged, and now only a
  coarse summary: the fit that places a move on the host clock is its attempt's.
- `<camera>.<segment>.frames.json`, the frame times of a clip, is new (§9).

Within version 2, optional fields were added, so that the version 2 files written before them stay
valid, and no new version: a clip in `attempt.json` gained `truncatedStart` (§7, `docs/PLAN.md` T2.9;
the readers take a missing one as false) and `local` (§7, T3.3: false once its MP4 left the device
after its upload; a missing one means the file is there), and a camera in `session.json` gained
`microphone` (§6, T2.12; the readers take a missing one as null). Since T2.14 a camera's `label` is
one per device within its session (§6), which the schema always allowed (`laptop-2`); in the files
written before, two devices of one session could share a label, its entry then the last one's.
T3.7 added, optional in the same way, the cube's whole record: in `attempt.json`, `app` (the build
that wrote it), `gyro` (its gyroscope file, §11; read as null when missing), `resyncs` (the states
adopted after moves went unseen; read as none) and each move's `serial` and `packetLast`; in
`session.json`, `cube.productDate` (read as null) and `battery` (read as none); in the frames files,
`app`; and a new file per attempt, `gyro.json` (§11), with a version of its own, 1.

The JSON Schemas (draft 2020-12) are in `packages/core/schema/`: `session.schema.json`,
`attempt.schema.json` and `frames.schema.json` for version 2, `session.v1.schema.json` and
`attempt.v1.schema.json` for version 1, `gyro.schema.json` for the gyro files (§11), whose version 1
is its own, `user.schema.json` for the account's record in Firestore (§10), whose version 1 is its
own, `cloud-session.schema.json` and `cloud-attempt.schema.json` for the documents of the session
index in Firestore (§10), which have the version of the records they copy (2),
`cloud-cube.schema.json` for the account's cubes in Firestore (§10), whose version 1 is its own,
and `cloud-event.schema.json` for the account's diagnostics events there (§10, T3.9), whose version
1 is its own too.

**Reading older records.** Files of version 1 are never rewritten to upgrade them. The readers,
`parseSession` and `parseAttempt` in `packages/core/src/records.ts` (the app's session store
reads every file through them), accept versions 1 and 2, check a record against the schema of the
version it says it has, and upgrade a version 1 record in memory: `schema` becomes 2, `clock` is
null (no fit was kept, but every move has both clocks, so one can be fitted afterwards), and
`video`, `cameras` and `clock.cameras` stay empty. A record of another version, or one that breaks
the schema of its version, is refused with the field that is wrong. The app writes version 2 only:
a session begun under version 1 goes on with attempts of version 2, and its `session.json` is
written as version 2 with its next attempt, so one session's folder can hold attempts of both
versions; an export (Sessions → Export) holds version 2 records.

## 1. Time

- **Host clock.** Every timestamp is `hostMs`: `performance.timeOrigin + performance.now()`
  on the host device, a float in milliseconds. Monotonic within a session; comparable
  across sessions only approximately (wall clock).
- **Cube clock.** The cube's own millisecond counter, as delivered by the driver
  (`cubeMs`). Kept next to `hostMs` for every move. The linear fit `hostMs ≈ a·cubeMs + b` of
  each attempt's moves is stored in its `attempt.json` (`clock`, §7), and a coarse fit per
  connection in `session.json` (`clock.cube`, §6).
- **Frame time** (phase 2): the host time of every video frame, in `*.frames.json` (§9).

## 2. Cube state and moves

**Facelets.** A cube state is a 54-character string in Kociemba order: faces `U R F D L B`,
nine characters per face, each character the *colour* of the sticker named by the face it
belongs to when solved (`U`…`B`). Positions within a face are in reading order (row by row,
left to right, top to bottom) with the face viewed from outside: on `U` the top row is the
one adjacent to `B`; on `D` the top row is adjacent to `F`; on `R F L B` the top row is
adjacent to `U`. Solved is `"UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB"`;
after a single `R` it is `"UUFUUFUUFRRRRRRRRRFFDFFDFFDDDBDDBDDBLLLLLLLLLUBBUBBUBB"`
(`fixtures/identities.json`). This is the string the GAN driver's `FACELETS` event carries,
so a desync check is a string comparison.

"Solved" means every sticker matches its face's centre, which is orientation-independent:
centres never move in the cube's own frame, which is also the frame the cube reports moves
in.

**Moves.** Face turns only: `U D R L F B`, optionally followed by `'` (counter-clockwise)
or `2` (half turn). Written as in WCA notation, separated by single spaces. No wide moves,
no rotations, no slice letters in v1: the cube reports slices as two opposite face turns a
few milliseconds apart, and the dataset keeps them that way (the 24-symbol normalization
with `M S E` and doubles is a training-time step, described in the private design).

## 3. Events of an attempt

| Event | Definition | Source |
|---|---|---|
| `scramble_shown` | the scramble was displayed | app |
| `scramble_start` | first cube move after `scramble_shown` | cube |
| `scramble_done` | cube state equals the scramble's target state (the attempt is *armed*) | simulator |
| `pickup` | optional: gyro quaternion changed beyond a threshold after `scramble_done` (cubes with a gyro; the app uses a rotation of more than 15° from the orientation at `scramble_done`) | cube |
| `solve_start` | first cube move after `scramble_done` | cube |
| `solve_end` | cube state is solved | simulator |

`inspection_ms = solve_start − (pickup ?? scramble_done)`. `time_ms = solve_end − solve_start`.
Moves between `scramble_start` and `scramble_done` have `phase: "scramble"`; between
`solve_start` and `solve_end`, `phase: "solve"`; moves after `scramble_done` and before
`solve_start` cannot exist by definition (the first one *is* `solve_start`). Extra moves
during a mis-scramble are part of the scramble phase; `result.scrambleCorrected` is true (the
cube left the scramble's path at some point) and `result.scrambleExtraMoves` counts the moves
beyond the scramble's own, in quarter turns (the cube reports every move as a quarter turn, so
one wrong turn undone counts 2). Only the first `pickup` counts. Moves after `solve_end`, or
after the solver marks a DNF, are not part of the attempt. "Mark as solved" (the app telling the
cube that it is solved, when the cube's own state and the physical cube went apart) drops an attempt
that has not ended and begins it again, from the solved state, with the same scramble and index: a
reset never produces a record.

## 4. CFOP phases

Names, in order: `cross`, `f2l1`, `f2l2`, `f2l3`, `f2l4`, `eoll`, `ocll`, `pll`
(two-look OLL is the reference method; a one-look OLL solver completes `eoll` and `ocll`
on the same move). Colour-neutral: the cross face is whichever face completes a cross
first after `solve_start`, and it never changes.

| Phase | Ends at the first move after which… |
|---|---|
| `cross` | some face `X` has its four edges in place and oriented (all four edge stickers on `X` show `X`'s colour and the other sticker of each edge matches its adjacent centre); `X` becomes `crossFace`. Faces whose cross was already complete at `scramble_done` are excluded. If one move completes several crosses, the one with the most pairs in place wins, then the first in the order `U R F D L B`. |
| `f2l1`..`f2l4` | one more of the four corner–edge pairs of the first two layers (relative to `crossFace`) is fully in place, counting pairs only while the cross is complete; slots are numbered by completion order (pairs completed by the same move in a fixed order of the slots), and the record says which slot each was. A slot is named by its middle-layer edge position (`FR`, `FL`, `BL`, `BR` for a U or D cross). |
| `eoll` | all four last-layer edges show the last-layer colour on the last-layer face |
| `ocll` | all four last-layer corners do too |
| `pll` | the cube is solved |

A cross completed first by accident is kept, as Cubeast keeps it, even when the solver
then builds the first two layers on another face.

Per phase: `startMs` (previous phase's `endMs`, or `solve_start` for the cross), `endMs`,
`moves` (count), and `recognitionMs` and `executionMs`, which add up to `endMs − startMs`
and are split where the execution starts, as Cubeast splits phases:

- after the cross, at the phase's first move that does not turn the last-layer face (the
  face opposite `crossFace`): leading AUF turns are recognition, and a turn of any other
  face, the cross face included, starts the execution;
- a phase whose moves all turn the last-layer face (a PLL finished by an AUF alone) is all
  recognition, with `executionMs` 0, as Cubeast reports the 4 fixture solves where this
  happens;
- the cross's execution starts at its first move, whatever face that turns, so its
  recognition is 0 unless `solve_start` came before the first move (Cubeast's cross
  recognition is 0 on all 300 fixtures, 8 of which start with a last-layer turn);
- a phase with no moves (already satisfied when the previous one ended) has both 0.

Checked against the 300 Cubeast fixtures in T1.3: all 2400 phase boundaries agree within
±1 ms, and 2306 of the 2400 recognition times (96.1%). The other 94 come from Cubeast's
move merging, which the data model does not do (§2): Cubeast shows repeated turns of one
face as one move (`R R` as `R2`; 77 of them) and turns of opposite faces as a slice
(`F' B` as `S`; 17), stamped with their last turn, so its recognition ends at that later turn.
Pairs count only while the cross is complete because, during an insertion that takes a
cross edge out, another pair can sit in place for a move or two: counting it ended the
phase before the insertion was over on 5 of the 300 solves (4 of them with the wrong
slot), where Cubeast waits for the cross.

Later: with more data, evaluate choosing as the cross face the face whose first two layers
complete first (the solver's real cross), which would relabel solves like fixture 13.

## 5. Files

```
sessions/<sessionId>/
├── session.json
└── attempts/<index>/                  index is 1-based, zero-padded to 4 digits
    ├── attempt.json
    ├── <camera>.scramble.mp4          phase 2
    ├── <camera>.scramble.frames.json
    ├── <camera>.solve.mp4
    ├── <camera>.solve.frames.json
    └── gyro.json                      T3.7: the gyroscope samples of the attempt (§11)
uploads.json                           phase 3: the upload queue's state (§10)
```

`sessionId` is a UUID v4; `<camera>` is the camera's `label` (§6), one per device of the session:
lowercase letters and digits in words joined by hyphens (`laptop`, `phone-front`, `laptop-2`), so
that the file names split at their dots; `<segment>` is `scramble` or `solve`. `gyro.json` is there
for a cube with a gyroscope, when the attempt's window had a sample (§11), written a second after the
attempt ends, as the solve clip is. A JSON file is written whole under a temporary name next to it,
`<name>.<random>.tmp`, then moved over `<name>` in one step, so a file holds its previous content or
the new one even when the page goes away mid-write; readers ignore such leftover `*.tmp` files and
remove them. Every JSON file names the build that wrote it, `app` (the version and the commit of the
app, §6): `session.json` since version 1, the others since T3.7, so that the files of a buggy or an
older build can be told apart later, also within one session, which can outlive an update.

## 6. `session.json`

```jsonc
{
  "schema": 2,
  "id": "3f1c…",                         // UUID
  "createdMs": 1730640000000.0,          // host clock at creation
  "app": {"version": "0.2.0", "commit": "abc1234"},
  "host": {"label": "office-mbp", "userAgent": "…", "platform": "macOS", "isPhone": false},
  "cube": {"model": "GAN 12 ui FreePlay", "hardware": "…", "firmware": "…", "gyro": true,
           "productDate": null},        // T3.7: the production date, when the cube says it
  "cameras": [                            // empty without a camera
    {"label": "laptop", "local": true, "facing": "user", "deviceLabel": "FaceTime HD Camera",
     "settings": {"width": 1920, "height": 1080, "frameRate": 30, "…": "…"},
     "capabilities": {"…": "…"}, "constraints": {"width": {"ideal": 1920}, "…": "…"},
     "crop": {"x": 480, "y": 120, "w": 960, "h": 840}, "mode": "full",
     "microphone": {"label": "MacBook Pro Microphone (Built-in)", "processing": "raw",
                    "echoCancellation": false, "noiseSuppression": false, "autoGainControl": false,
                    "voiceIsolation": null, "sampleRate": 48000, "channelCount": 1}}
  ],
  "clock": {
    "cube": {"a": 1.0031, "b": 1730639990000.0, "residualP95Ms": 618.7, "samples": 1425},  // coarse
    "cameras": {"laptop": {"offsetMs": 41.5, "rttMs": 0, "driftPpm": 0,
                           "clapperboardResidualMs": 12.3, "clapperboardSamples": 5,
                           "samples": [{"moveHostMs": 1730640010000.5, "onsetHostMs": 1730640010040.5}, …]}}
  },
  "audio": true,
  "settings": {"inspection15s": false, "autoAdvance": true},
  "notes": "",
  "summary": {"attempts": 0, "solved": 0, "dnf": 0},
  "battery": [{"hostMs": 1730640000100.5, "level": 83}]   // T3.7: the cube's battery reports
}
```

`id` is lowercase, as `crypto.randomUUID()` writes it. `cube` is what the cube said in its hardware
message: `productDate` (T3.7) is its production date as the message has it, which a Gen4 cube says
and a Gen2 cube (the GAN 12 ui, the GAN 356 i3) does not, null then; absent from the files written
before T3.7, which read as null. `battery` (T3.7) is every battery report of the cube over the
session's connections, in order, each with the host time of the report and the level in percent,
consecutive equal levels coalesced (a GAN cube reports its battery once per connection, when asked,
and whenever the level changes); a session begins with the report of the connection it begins on,
and the file is saved again with each new entry. Empty when the cube reported none; absent from the
files written before T3.7, which read as empty. `clock.cube` is the least-squares fit of the
host time on the cube time over the moves that were the newest of their Bluetooth packet (the older
moves of a packet carry the packet's arrival time, so they are not samples): `residualP95Ms` is the
95th percentile (nearest rank) of the absolute residuals of the last 2000 of them, `samples` their
number, and before the first one the fit is `{"a": 1, "b": 0, "residualP95Ms": 0, "samples": 0}`.
The cube's clock restarts at 0 whenever the cube connects again, so the fit starts over with each
connection, and whenever the cube's clock starts again within one (§7): `clock.cube` is the fit of
the cube clock during which the session's last attempt ended, saved with every attempt (a session
recorded over several connections has moves on several cube clocks; every move keeps its `hostMs`).
It is only a coarse summary: within an attempt the cube's clock runs slow against the host's, while
across the pauses between attempts both advance equally, so one line through a connection that spans
pauses of minutes is off by hundreds of milliseconds at its ends (as in the example: ±600 ms over
the 14 minutes of the owner's first laptop session, `docs/DEVICES.md`); to place a move on the host
clock, use its attempt's `clock` (§7). `audio` is on by default (phase 2 records it with the video):
it is Settings' "Record audio" when the session began, and again when its camera last recorded;
whether a clip has sound is its own `audio` (§7). `notes` is free text, to which the app adds one
line per clip it could not save, `clip failed: <segment> of attempt <index>: <reason>`
(`docs/PLAN.md`, T2.4), so that a missing clip has its reason, and, since T2.9, one per clip that
begins later than asked, `clip truncated: <segment> of attempt <index> starts <s> s late (the buffer
held <s> s)` (§7); once per recording (from the camera's start to its stop), one per reason a clip
has no sound although the sound is recorded, `clip without audio: <segment> of attempt <index>:
<reason>` (no audio data from the microphone, no decoder config, no audio chunk in the clip's span,
the audio encoder's error), one when the sound's timestamps counted on another clock than the
frames' and were placed by their arrival times, `clip audio rebased: <segment> of attempt <index>:
audio timestamps rebased by <ms> ms`, and one when the audio encoder gave no complete decoder config
and the app made it from the encoder's settings, `clip audio described: <segment> of attempt
<index>: …`; and each notice of a recording, once, `notice: <text>` (the microphone refused, silent
or lost, no audio encoder; since T2.12, the browser's voice processing kept on although the
microphone was asked for raw, `notice: The microphone is not raw: …`, or the raw request refused);
and, since T3.1, once when the session index in the cloud refuses a write of the session's,
`cloud: the session could not be indexed: <reason>`, `cloud: attempt <index> could not be indexed:
<reason>` or `cloud: attempt <index> could not be deleted from the index: <reason>` (§10).
`summary` is counted from the attempts: each one is solved or a DNF.

`cameras` lists the session's cameras: in phase 2 the host's own (`local: true`); remote cameras
come with phase 4. `label` names the camera in `clock.cameras`, in the clips' `camera` and in
their file names (§5), and there is one per device within the session (`docs/PLAN.md` T2.14,
`labelFor` in `packages/core/src/session.ts`). A camera's own label comes from the host label and
where the camera faces: `laptop`, or `phone` when the host label says phone, followed by `-front` or
`-rear` when the facing is known (`phone-front`). The first device of the session with an own label
gets that label, and another device with the same one the first of `<label>-2`, `<label>-3`, …
that the session has not given (a laptop's built-in camera and a USB webcam used in one session
are `laptop` and `laptop-2`); a device used again in the session gets its label back, its entry
replaced by the camera as it was opened again, so that the session's entries, its `clock.cameras`
and its clips always name the same device. The app tells two devices apart by the browser's name
for them (`deviceLabel`) and, for two of one name (two webcams of one model), by the browser's id
for them, which no record keeps (it identifies the browser's installation): it knows the ids of the
cameras that recorded since the page loaded, so after a reload a camera of a shared name takes the
first label of that name. A new session starts again from the camera's own label. In the files
written before T2.14, a second device took the label of the first, whose entry it replaced, and the
clips of both name it. `facing` is the camera's `facingMode` when the browser says it (`user` for
a front camera, `environment` for a rear one), `unknown` otherwise; `deviceLabel` is the browser's
name for it (`MediaDeviceInfo.label`). `settings`, `capabilities` and `constraints` are snapshots,
as JSON, of `getSettings()` when the camera was opened, of `getCapabilities()`, and of the
constraints the app opened it with, with whatever keys the browser reports (the schema only checks
that they are objects). `crop` is the framing rectangle, the part of the frame the model trains
on, in whole pixels of the camera's frames as recorded (after rotation: a phone in portrait gives
1080×1920 frames), `x` and `y` its top-left corner and `w` and `h` its size, or null for the whole
frame. `mode` is `full` when whole frames are recorded (always in phase 2, where the rectangle is
metadata for training) and `crop` when only the rectangle is (later).

`microphone` is the microphone of the camera's sound when it last recorded (`docs/PLAN.md` T2.12),
null when it recorded without one (Record audio off, the microphone refused or absent). `label` is
the browser's name for it (`MediaStreamTrack.label`). `processing` is how the app asked for it: `raw`,
the default, with the browser's voice processing asked off (echo cancellation, noise suppression,
automatic gain control and voice isolation false, one channel at 48 kHz as ideals), since that
processing takes a cube's click for noise; or `voice`, the browser's defaults (Settings' "Voice",
for speech). The rest is what the browser says it applied, from the microphone track's
`getSettings()`, each null when the browser does not report it: `echoCancellation`,
`noiseSuppression`, `autoGainControl` and `voiceIsolation` are true when that processing is on
(Chrome's echo cancellation modes, `all` and `remote-only`, count as on), `sampleRate` is in hertz
and `channelCount` the number of channels. The browser may keep some processing on although raw was
asked for (the session's `notes` then say so, above), and gives the device's own format, ideals
notwithstanding: Chromium's fake microphone, raw, gives 44.1 kHz in two channels (48 kHz in one with
its voice processing). The device's id is not kept. The field is absent from the files written
before it existed, which read as null: their microphone, when they had one, was opened with the
browser's defaults (`getUserMedia({audio: true})`), voice processing on.

`clock.cameras` holds each camera's clock sync, by label (from the clapperboard, `docs/PLAN.md`
T2.5, T2.8 and T2.11: one face flicked and flicked back, five times over, so up to ten single turns,
watched by the camera while attempt tracking is suspended). Each turn matched in the frames gives a
lag: the host time of the middle of the turn's motion in the frames (the centroid of the picture's
change around its peak) minus the host time of the turn; the fifth of those lags farthest from their
median, rounded up, are left out (two of ten). `offsetMs` is how far the camera's frames lag the
cube: the median of the lags kept. `clapperboardResidualMs` is the range of the lags kept (the
largest minus the smallest), `clapperboardSamples` their number, and `samples`, when kept, the pairs
kept: `moveHostMs`, the turn, and `onsetHostMs`, the middle of its motion since T2.11 (the name is
older: until T2.11 it was the first frame of the motion's rise, `offsetMs` the median over every
turn matched and `clapperboardResidualMs` their spread from the 5th to the 95th percentile; the
schema is unchanged). `rttMs` and `driftPpm` are the round-trip time and the drift of a remote
camera's clock sync (phase 4); a local camera shares the host's clock and has 0 for both. A clip's
`syncResidualMs` (§7) is its camera's `offsetMs` when it was recorded.

## 7. `attempt.json`

```jsonc
{
  "schema": 2,
  "session": "3f1c…",
  "index": 17,
  "app": {"version": "0.4.0", "commit": "abc1234"},   // T3.7: the build that wrote the record
  "scramble": "F2 U2 R B2 D' L B' L' B U2 L2 F2 U F2 U R2 D2 B2 U' L2 D'",
  "scrambledFacelets": "…54 chars…",
  "crossFace": "D",                      // null if DNF before cross
  "events": {                            // hostMs; null when it did not happen
    "scrambleShown": 0, "scrambleStart": 0, "scrambleDone": 0, "pickup": null, "solveStart": 0, "solveEnd": 0
  },
  "moves": [
    {"m": "U'", "hostMs": 1730640000123.4, "cubeMs": 9527, "phase": "scramble",
     "serial": 213, "packetLast": true}  // T3.7: the cube's move counter and the packet flag
  ],
  "clock": {"a": 1.00701, "b": 1730639990529.6, "residualP95Ms": 14.3, "samples": 112},
  "result": {
    "timeMs": 20412, "inspectionMs": 4200, "movesQtm": 81, "tps": 3.97,
    "status": "solved",                  // "solved" | "dnf"
    "replayOk": true,                    // scrambledFacelets + solve moves reach solved in the simulator
    "scrambleCorrected": false, "scrambleExtraMoves": 0
  },
  "phases": [
    {"name": "cross", "startMs": 0, "endMs": 0, "moves": 8, "recognitionMs": 0, "executionMs": 0},
    {"name": "f2l1", "slot": "FR", "startMs": 0, "endMs": 0, "moves": 9, "recognitionMs": 0, "executionMs": 0}
  ],
  "video": [                             // empty without a camera
    {"camera": "laptop", "segment": "solve", "file": "laptop.solve.mp4", "bytes": 23734012,
     "codec": "avc1.640028", "audio": "mp4a.40.2", "width": 1920, "height": 1080,
     "crop": {"x": 480, "y": 120, "w": 960, "h": 840}, "fpsNominal": 30, "frames": 721,
     "firstFrameHostMs": 1730640017211.9, "framesFile": "laptop.solve.frames.json",
     "syncResidualMs": 41.5, "truncatedStart": false}
                                         // "local": false once the MP4 left the device (T3.3)
  ],
  "gyro": {                              // T3.7: the attempt's gyroscope file (§11); null without one
    "file": "gyro.json", "samples": 1234, "fromHostMs": 1730639998012.5,
    "toHostMs": 1730640023340.7, "rateHz": 48.7, "truncatedStart": false
  },
  "resyncs": [                           // T3.7: the states adopted after moves went unseen; [] when none
    {"hostMs": 1730640001450.5, "facelets": "…54 chars…", "state": "scrambling"}
  ]
}
```

`index` is 1-based. `app` (T3.7) is the build that wrote the record, as `session.json` has it (§6);
absent from the files written before T3.7. `scrambledFacelets` is the scramble applied to a solved
cube, the state at `scrambleDone`, where the solve starts. `movesQtm` counts the quarter turns of
the solve's moves (a `2` counts two); it equals Cubeast's `quarter_turns` on all 300 fixtures.
`tps = movesQtm / (timeMs / 1000)`, rounded to two decimals. Cubeast's `tps` is not comparable:
it divides its `slice_turns` (two turns of one face merged into one double, turns of opposite
faces into one slice) by the time, so it is lower (3.39 against our 3.87 on average over the
fixtures). The `moves` array is the raw stream in the order the cube reported it, one entry per
face turn, including the corrections of a mis-scramble. Since T3.7 each move keeps `serial`, the
cube's move counter as its packet carried it (0 to 255, wrapping; null for a source without one),
and `packetLast`, whether the move was the newest of its Bluetooth packet, the one whose arrival
its `hostMs` measures (the older moves of a packet, recovered from its counter, share its time;
only `packetLast` moves are samples of `clock`, below); both absent from the files written before.
`slot` appears on the four f2l phases only.

A **DNF** (`status: "dnf"`, which the solver can mark at any moment before solved) has `timeMs`,
`tps` and `events.solveEnd` null and `replayOk` false; `phases` are the phases completed before
it and `crossFace` is null if the cross was not; `movesQtm` counts the solve's moves made. If the
solve had not started, `events.solveStart` and `inspectionMs` are null too, and so is
`events.scrambleDone` if the scramble was not done; `scrambleExtraMoves` then counts the extra
moves made so far.

When moves went unseen (the cube's reported state differs from the simulated one), the app adopts
the reported state (a resync); an event that state completes (`scrambleDone`, `solveStart`,
`solveEnd`) takes the time of the report, and the unseen moves are missing from `moves`, so
`replayOk` is false if they were solve moves. Since T3.7 `resyncs` logs each such adoption, in
order: `hostMs`, when the cube reported the state (the app asks for it when the tab comes back into
view and when the cube reconnects, and the cube sends it on its own now and then); `facelets`, the
state adopted; `state`, the attempt's state when the report came, during which the moves went
unseen (`scrambling`, `armed` or `solving`). Empty when none; absent from the files written before
T3.7, which read as empty.

`gyro` (T3.7) says what the attempt's gyroscope file holds (`gyro.json` in its folder, §11): `file`,
its name; `samples`; `fromHostMs` and `toHostMs`, the host times of its first and last samples;
`rateHz`, the samples per second over that span, to one decimal (0 with fewer than two samples);
and `truncatedStart`, whether the samples did not reach back to the window's start, 2 s before the
first scramble turn. Null without a file: a cube without a gyroscope (`cube.gyro` false in
`session.json`), or no sample in the attempt's window; absent from the files written before T3.7,
which read as null. The record is saved with `gyro` null when the attempt ends and again with the
summary a second later, when the file is written; the upload queue sends the attempt once it is
(§10).

`clock` is the cube clock fit of the attempt: the least-squares line `hostMs ≈ a·cubeMs + b` over
the attempt's moves that were the newest of their Bluetooth packet (as in §6: the older moves of a
packet carry the packet's arrival time), from its first move to `solveEnd` or the DNF, which are the
moves of `moves`. `residualP95Ms` is the 95th percentile (nearest rank) of their absolute residuals
(of the last 2000 if there are more), `samples` their number, and `clock` is null without two of
them at different cube times (a DNF before the second move). When the cube's clock starts again
during the attempt, so does the fit, which then covers the moves from there on (`samples` counts
those): when the cube reconnects, since its count restarts at 0, and when a pause between two moves
outlasts the cube's count of it (the GAN 356 i3 reports 65,535 ms for any longer pause,
`docs/DEVICES.md`). The app sees either as a move whose cube time, counted from the previous move in
the fit, is more than 1 s plus 1% of the host time between them behind its host time
(`CLOCK_RESTART_MS` and `CLOCK_RESTART_DRIFT` in `packages/core/src/clock.ts`), which the Bluetooth
jitter and the drift never cause; the moves before it are on the cube's previous clock, of which the
record keeps no fit, and their `hostMs` places them. Records written before the fit started again
with the cube's clock (`docs/PLAN.md` T2.9) may have one line through both clocks (attempt 6 of
`fixtures/hardware/2026-09-27-macbook-pro-2021-gan356i3.json`: a slope of −0.81, a `residualP95Ms`
of 48 s). The fit belongs to the attempt, not to the session: while it is turned the cube's clock
runs about 0.7% slow, steadily, and across the pauses between attempts both clocks advance equally,
so each attempt's line holds to the Bluetooth jitter, while one line through a session is off by
0.7% of every pause (`docs/DEVICES.md`, measured on the owner's cube in round 1). `a·cubeMs + b`
places a move on the host clock without the jitter of its `hostMs`, which is when its packet
arrived.

`video` lists the attempt's clips, one per camera and segment, files in the attempt's folder (§5):
the scramble and the solve, each with a margin before and after (`docs/PLAN.md` T2.4): the scramble
from 2 s before `scrambleStart`, but at most 60 s before `scrambleDone` (T2.9: a pause inside a
scramble is not worth minutes of video), to 1 s after `scrambleDone`, the solve from 3 s before
`solveStart` to 1 s after `solveEnd` or the DNF (none when the solve did not start). A clip begins
at the keyframe at or before its margin, so up to one keyframe interval (a second) earlier:
`firstFrameHostMs` is where it really begins. When its start is older than what the capture holds in
memory (the last 90 s), the clip begins at the oldest keyframe held, later than asked, and
`truncatedStart` is true (`notes` in `session.json` says how late, §6); the field is absent from the
files written before it existed (`docs/PLAN.md` T2.9), which read as false. A camera that was off
has no clips; a clip that could not be saved is missing, and `notes` in `session.json` (§6) says
why. `file` is `<camera>.<segment>.mp4` and `framesFile` `<camera>.<segment>.frames.json`, the times
of its frames (§9); `bytes` is the MP4's size; `codec` and `audio` are the codec strings of its
video and audio tracks (`avc1.640028`, `mp4a.40.2`), `audio` null without an audio track (when the
sound was recorded and a clip has none, `notes` in `session.json` says why, §6); `width` and
`height` are those of the encoded frames; `crop` is the camera's framing rectangle (§6) when the
clip was recorded. `fpsNominal` is the frame rate the camera's track reported and `frames` the
number of frames in the clip; the actual frame times are in the frames file, and a camera may
deliver fewer frames than its track says (`docs/DEVICES.md`). `firstFrameHostMs` is the host time of
the first frame (`t0HostMs` of the frames file), and `syncResidualMs` the camera's lag behind the
cube when the clip was recorded (`offsetMs` of `clock.cameras`, §6), null before a sync check.
`camera` is the label of the camera that recorded the clip, that of its entry in the session's
`cameras` and in `clock.cameras` (§6): an attempt during which the camera changed has its scramble
from one camera and its solve from the other.

`local` is false once the clip's MP4 is no longer on the device that recorded it: the upload queue
deleted it after the bucket confirmed it, by policy (`docs/PLAN.md` T3.3: "Keep local copies" off,
or the browser's storage past 70%); its frames file stays, and so does `attempt.json`, which the queue
saves with `local` false before it deletes the file. While the MP4 is there the field is absent, true
is never written, and the files written before T3.3 have none. The `attempt.json` uploaded to the
bucket never has it, since every clip is beside it there: the queue uploads the record without it, so
deleting a clip does not change the uploaded file. The pages say "in the cloud" for such a clip, in
place of playing or downloading it.

`packages/core/schema/session.schema.json` and `attempt.schema.json` (JSON Schema draft
2020-12) are §6 and this section in machine-readable form, for version 2; the version 1 files
are `session.v1.schema.json` and `attempt.v1.schema.json`.

## 8. Fixtures

`fixtures/solves.json`: real solves with `scramble`, `scrambled_facelets`, `solution` (the
raw `MOVE[ms]` stream on the cube clock), `moves` (parsed), `normalized`, the Cubeast result
columns and `cubeast_steps` (name, moves, recorded_moves, time, recognition_time,
execution_time, cumulative_time per step). `fixtures/identities.json`: solved state, the
`R` vector, states after short scrambles, sequences that return to solved, sequences that
do not. Generated from the owner's Cubeast export by a private script; treat as read-only.
`fixtures/hardware/`: session exports of the owner's manual rounds on real hardware (schema version
1 from round 1, version 2 with clips from the GAN 356 i3's), described in
`fixtures/hardware/README.md`; read-only too.

## 9. `frames.json`

`<camera>.<segment>.frames.json`, next to its clip (§5), holds the host time of every frame of the
clip (phase 2):

```jsonc
{
  "schema": 2,
  "camera": "laptop",
  "segment": "solve",
  "app": {"version": "0.4.0", "commit": "abc1234"},   // T3.7: the build that wrote the file
  "t0HostMs": 1730640017211.9,           // the first frame, on the host clock
  "dtMs": [0, 33.4, 33.3, 33.3, 66.7, 33.3, …],   // per frame, the time since the previous one
  "keyframes": [0, 30, 60, …],           // the frames a decoder can start at
  "arrival": {"offsetMs": 1730634807211.9, "residualP95Ms": 9.8}
}
```

`app` (T3.7) is the build that wrote the file, as `session.json` has it (§6); absent from the files
written before. Frame k is at host time `t0HostMs + dtMs[0] + dtMs[1] + … + dtMs[k]`, so `dtMs` has
one entry per frame and `dtMs[0]` is 0. The intervals come from the frames' own timestamps
(`VideoFrame.timestamp`: steady and exact for intervals, so that a dropped frame shows as a double
interval), never from when the frames reached the page, which jitters by ±10 ms and more
(`docs/DEVICES.md`). They are kept in steps of 0.1 ms without drifting: with `tₖ` the timestamp
of frame k in ms, `dtMs[k] = r(tₖ − t₀) − r(tₖ₋₁ − t₀)`, where `r` rounds to 0.1 ms, so that the
sums are the frames' times rounded to 0.1 ms (rounding each interval instead would add up to a
frame's time over a long clip). The frame rate is what these intervals say, whatever `fpsNominal`
says. `keyframes` are the indices of the keyframes, increasing and beginning with 0: a clip begins
at a keyframe.

`t0HostMs` places the clip on the host clock. `arrival` is the fit of the frames' arrival times on
their own timestamps, over the clip (`docs/PLAN.md` T2.2): the arrival time of a frame is the host
clock when the capture worker received it, and `offsetMs` is the median of arrival time minus
timestamp (in ms), so that `t0HostMs`, the first frame's timestamp plus `offsetMs`, has none of the
jitter of a single arrival; `residualP95Ms` is the 95th percentile of the absolute residuals, that
jitter. These times are when the frames reached the browser, later than the light by the camera's
own latency: that lag is the clip's `syncResidualMs` (§7), measured by the clapperboard (§6), for
the training pipeline to subtract.

## 10. Cloud records

From phase 3 the app keeps an index of the dataset in Firestore, in the Firebase project
`cubetrace-cacd9` (`docs/PLAN.md`, phase 3), beside the files of §5, which stay the records. A
document is what Firestore stores (numbers, strings, booleans, null, maps, lists); each kind of
document has its own schema version, as each file has. `firebase/firestore.rules` decides who may
read and write which (below).

### `users/{uid}`, schema version 1

The record of an account, `{uid}` its Firebase Authentication user id (`docs/PLAN.md` T3.0). The app
writes it at each sign-in, and at each start with an account signed in (once per page load), merged
into the stored document (Firestore's `set` with `merge`), so that `devices` gathers every device:

```jsonc
{
  "schema": 1,
  "createdMs": 1790000000000,            // when the account was created
  "displayName": "Ada Lovelace",         // null without one
  "email": "ada@example.com",            // null without one
  "devices": {"office-mbp": 1790000123456.7, "Android phone": 1790000200000.2}
}
```

`createdMs` is Firebase Authentication's creation time of the account, in ms since 1970 (to the
second): the same on every device, so that every sign-in writes the value already there, which the
rules never let change. `displayName` and `email` are the Google account's. `devices` has an entry per
host label (Settings → This device, `host.label` in §6): that device's host clock (§1) when it last
signed in or started signed in. The app does not wait for the write: Firestore applies it to its
cache in IndexedDB at once and sends it when it can, after the network is back or after a reload;
when the server refuses it, Settings → Account says so and the console has
`cubetrace: The account's record (users/{uid}) could not be saved: …`.
`packages/core/schema/user.schema.json` (`USER_SCHEMA`) is this record in machine-readable form: what
the app writes. The document also holds `quota`, the upload quota, which only the functions write
(below, "Uploads").

### The account's cubes: `users/{uid}/cubes/{name}`, schema version 1

Settings' list of the cubes' MAC addresses (Settings → Cube MAC addresses, where the connect
dialog's "Remember it for this cube" keeps one too; `docs/PLAN.md` T3.4, issue #21), one document
per cube, so that an address typed once on a device of the account, such as a phone whose Chrome
cannot read it, is known on its other devices. `{name}`, the document's id, is the cube's Bluetooth
name as Settings has it: as Chrome's list of devices shows it, such as `GAN12ui_AB12` (Settings
matches names ignoring case).

```jsonc
// users/Xb3…uid/cubes/GAN12ui_AB12
{
  "schema": 1,
  "name": "GAN12ui_AB12",            // the document's id
  "mac": "AB:12:CD:34:EF:56",         // six hex bytes, upper case, colons between them
  "updatedMs": 1790000123456.7,       // when the entry last changed, on the changing device's clock
  "device": "office-mbp"              // the host label of the device that wrote it
}
```

`mac` is the address as Settings keeps it, normalized (`normalizeMac` of `packages/gan`): 17
characters. `updatedMs` is when the entry last changed, in ms on the host clock (§1) of the device
that changed it; each entry of Settings' list keeps it too (the settings in `localStorage`,
`cubetrace.settings`, are version 2 since T3.4: an entry stored before has none, and gets the time
it is first read, written back at once). A change is dated later than the entry it replaces, also
when that entry came from a device whose clock runs ahead. `device` is the host label (Settings →
This device, `host.label` in §6) of the device that wrote the document. An entry whose name cannot
be a document's id (empty, with a `/`, `.` or `..`, `__…__`, or over 1,500 bytes) stays on its
device, and Settings says so. `packages/core/schema/cloud-cube.schema.json` (`CLOUD_CUBE_SCHEMA`) is
this document in machine-readable form, and `parseCloudCube` (`packages/core/src/records.ts`) its
reader, which refuses a document of another version.

**Writing and merging.** Signed in, each change of the list writes its entry's document whole
(Firestore's `set`, without merge) or deletes it; an entry renamed, if only in case, writes its new
document and deletes the old one. Nothing waits for the server: Firestore applies the writes to its
cache at once and sends them when it can, offline once the network is back. At each sign-in, and at
each start signed in (once per page load), the device reads the account's cubes and merges them with
its list, by name ignoring case: their union, where of two copies of a cube the one with the later
`updatedMs` wins (for equal times, the account's, so that every device ends with the same), the
account's replacing the device's entry and the device's written to the account; and a deletion on
either side carried to the other. For the deletions, the device keeps, per account, each document's
`updatedMs` as it last read it from the server or had a write of it confirmed (`localStorage`
`cubetrace.cubeSync`, with the time of the last merge with the server's documents, which Settings
shows): an entry missing on one side in a version the server held was deleted on that side, and is
deleted on the other; one missing in a version the server never held is new there, and is added. A
change on one side wins over a deletion on the other. Read from the cache, the server out of reach,
a missing document is never taken for a deletion, and the merge is not the last one Settings shows.
A document that cannot be read (of another version) is left as it is, on both sides, and said; a
write the server refuses is said in Settings and once in the console (`cubetrace: cloud: The cube …
could not be saved to your account: …`), and tried again at the next change of the list or the next
start. Signed out, nothing is read or written, and the list is the device's alone.

**Never in the dataset.** The addresses are the account's, not the dataset's: no file of §5 holds
one (`cube` in session.json names the cube's model, hardware and firmware, never its address), so
neither an export (Sessions → Export) nor the uploads (T3.3: `attempt.json`, `session.json`, the
clips and their frames files) nor the session index (below) carries one.
`apps/web/src/app/session/session-macs.spec.ts` checks it on a session recorded with an address
typed and kept, and `apps/web/e2e/cube-macs.spec.ts` on an export, signed in with the list synced.

### The session index: `sessions/{id}` and `sessions/{id}/attempts/{index}`, schema version 2

The index of an account's sessions (`docs/PLAN.md` T3.1): through it the Sessions page of each of the
account's devices lists the sessions of the others, and the QA view counts what was recorded and what
is uploaded. A session's document is its `session.json` (§6) with `owner`; an attempt's is its
`attempt.json` (§7) without `moves`, which stay on the device that recorded it (and go to the bucket
in the uploaded `attempt.json`, T3.3), with `owner`, `device` and `upload`. So the fields of T3.7
reach Firestore with the records: `app`, `gyro` and `resyncs` on an attempt's document, `battery` and
`cube.productDate` on a session's (the QA view counts the attempts with a gyro file and the median of
their rates from `gyro`). The documents keep the schema version of the records they copy, 2; no
other was ever written. `{id}` is the session's id,
`{index}` the attempt's index zero-padded to 4 digits, as its folder (§5), so that a session's
attempts sort by index.

```jsonc
// sessions/3f1c…
{
  "schema": 2, "id": "3f1c…", "createdMs": 1730640000000.0, "app": {…}, "host": {…},
  "cube": {…}, "cameras": […], "clock": {…}, "audio": true, "settings": {…}, "notes": "",
  "summary": {"attempts": 17, "solved": 16, "dnf": 1},   // session.json, field for field (§6)
  "battery": [{"hostMs": 1730640000100.5, "level": 83}],
  "owner": "Xb3…uid"                                     // the account that wrote it
}
// sessions/3f1c…/attempts/0017
{
  "schema": 2, "session": "3f1c…", "index": 17, "app": {…}, "scramble": "…", "scrambledFacelets": "…",
  "crossFace": "D", "events": {…}, "clock": {…}, "result": {…}, "phases": […],
  "video": [{"camera": "laptop", "segment": "solve", "file": "laptop.solve.mp4", "bytes": 23734012, …}],
  "gyro": {"file": "gyro.json", "samples": 1234, …}, "resyncs": [],
                                                         // attempt.json without "moves" (§7)
  "owner": "Xb3…uid",
  "device": {"host": "office-mbp", "cameras": ["laptop"]},
  "upload": {                                           // as the app creates it; the functions' then
    "state": "pending",                                  // "pending" | "uploading" | "done" | "failed"
    "files": {"attempt.json": {"bytes": 6120, "doneMs": null}}
  }
}
```

`owner` is the Firebase Authentication uid of the account that wrote the document, which the rules
require on both kinds. `device` is what recorded the attempt, by which the QA view groups the
attempts: `host`, its session's host label (`host.label`, Settings → This device), and `cameras`, the
labels of its session's cameras, in their order. `upload` is the state of the attempt's upload
(below, "Uploads"): `state` is `pending` before anything is sent, `uploading`, `done` once every file
is confirmed, or `failed`; `files` has an entry per file, by name (`attempt.json`, each clip's
`<camera>.<segment>.mp4` and `<camera>.<segment>.frames.json`, `gyro.json` (T3.7), and
`session.json` on the attempt the session's file went with): `bytes`, its size, and `doneMs`, when
its upload was confirmed, in ms, null until then. **The app writes `upload` once, when it creates the
attempt's document**: `pending`, with the files of the attempt's folder that the device has then and
their sizes there (an `attempt.json` as the store writes it, an MP4 as its clip's `bytes`, a frames
file or the gyro file as the file system has it; one that cannot be read there is left out), each
`doneMs` null. An attempt's document is created when the attempt ends, before its clips are cut and
its gyro file is written, so its `files` names `attempt.json` alone, and the other files are added by
the uploads as they are signed; from then on only the functions write `upload` (T3.2), and the rules
refuse the app's changes to it.

**Writing.** With an account signed in, every save of a session (its creation, its summary after each
attempt, a note, a camera, a sync check) writes its document, and every save of an attempt (when it
ends, again when a clip is attached, and when its clips leave the device once uploaded, T3.3) writes
the attempt's, each merged into the stored one
(Firestore's `set` with `merge`: a field the server added stays): the first write of an attempt's
document carries its `upload`, the later ones every field but `upload`; the timer's Delete last
deletes the attempt's document. Firestore applies the writes to its cache in IndexedDB at once and
sends them when it can, offline after the network is back, across reloads; the saves of the records
never wait for them. **Demo sessions are never written**: a session whose cube is the fake cube
(`cube.hardware` is `simulated`). A session saved while no account is signed in on the device (made
signed out, or changed after a sign-out, or before a remembered account has loaded) is written whole,
its document and its attempts' in one batch, by the catch-up that runs when an account signs in, and
at each start signed in: the sessions of the device that are not in the account's index, the oldest
first, at most 300 documents at a time (the rest wait for the next start). For each one, it first asks
the index which of its attempts are there (`where('owner', '==', uid)` on its attempts; the server, or
offline the cache): those it writes without their `upload`, the others it creates with theirs; a
session whose attempts cannot be asked for waits for the next catch-up. Which sessions of the
device are all in an account's index is kept on the device (`localStorage` `cubetrace.sessionIndex`,
by uid, with when the server last confirmed a write, the QA view's last sync). Deleting a session on
a device deletes that device's copy only: its documents stay in the index, as its uploads will in the
bucket. A write the server refuses (the rules, a document too large) is said once per session and
page load: in the console (`cubetrace: cloud: …`), on the Sessions page, and in the session's
`notes`, `cloud: attempt 17 could not be indexed: <reason>` (§6), unless the notes have that line;
the session is then written whole again by the next catch-up.

**Reading.** The Sessions page reads the account's 100 newest sessions,
`where('owner', '==', uid)` ordered by `createdMs` descending (the composite index of
`firebase/firestore.indexes.json`, owner ascending and `createdMs` descending, serves the query; the
emulator needs none); a session's page reads its document and its attempts
(`where('owner', '==', uid)`, by document id); the QA view the attempts of the 50 newest sessions.
Offline, the queries read Firestore's cache, with this device's unsent writes in it. The app reads the
documents with `parseCloudSession` and `parseCloudAttempt` (`packages/core/src/records.ts`), which
accept exactly what the schemas accept and leave out, with why, a document of another version.
`packages/core/schema/cloud-session.schema.json` (`CLOUD_SESSION_SCHEMA`) and
`cloud-attempt.schema.json` (`CLOUD_ATTEMPT_SCHEMA`) are this section in machine-readable form; they
keep every field of `session.schema.json` and `attempt.schema.json` as those have them.

### Uploads: `users/{uid}.quota` and an attempt's `upload` (T3.2)

The functions (`functions/README.md`) keep two fields through the Admin SDK, past the rules:

```jsonc
// users/{uid}
"quota": {"day": "2026-10-01", "bytes": 43000, "files": 3}

// sessions/{id}/attempts/{index}
"upload": {
  "state": "uploading",                  // "pending" | "uploading" | "done" | "failed"
  "files": {                             // by file name in the attempt's folder (§5)
    "attempt.json": {"bytes": 18220, "doneMs": 1790889065000},
    "laptop.solve.mp4": {"bytes": 23734012, "doneMs": null}
  }
}
```

- `quota` is what `signUpload` has signed for the account on `day`, the UTC day (`YYYY-MM-DD`): the
  bytes and the files, every signature counted, a file signed again included; a call on another day
  counts from zero. The account reads it with its record and can neither write it nor delete a record
  that holds it (the rules, below). When the record is not there yet, the functions create the
  document with `quota` alone, and the app's next merge adds the record's fields.
- An attempt's document id is its folder's name (§5): `0001` for `index` 1, `0017`, `12345`. The
  functions find the attempt of a call's `attemptIndex` by it.
- `upload` is created with the attempt (T3.1: `pending`, with the files the device has then, each
  `doneMs` null; the app never writes it again, and the rules refuse it to). `signUpload` sets
  `state` to `uploading` and `files[path]` to `{bytes, doneMs: null}` for each file it signs (a file
  signed again starts again); `confirmUpload` sets a file's `doneMs`, the server's clock in ms since
  1970, once its object is in the bucket with that size, and `state` to `done` once every file of
  `files` has one. The functions never write `pending` or `failed`, and keep any other field of
  `upload` as it is. `path` is the file's name in the attempt's folder (`attempt.json`,
  `<camera>.<segment>.mp4`, `<camera>.<segment>.frames.json`, `gyro.json`), or `session.json`, the
  session's file, recorded on the attempt it was uploaded with; at most 33 files in one call. An
  attempt with one camera and a gyroscope is six files (T3.7: `gyro.json` after the clips), plus
  `session.json` now and then, each signature a file of the day's quota: with the default 1,200
  files a day, at most 200 attempts with their clips and gyro files upload in a day (240 before
  T3.7, at five files), fewer with `session.json`.
- The objects are `users/{uid}/sessions/{id}/attempts/{index}/<path>`, and
  `users/{uid}/sessions/{id}/session.json` for the session's file, in the bucket of the configuration
  (`bucket/README.md`).

### The upload queue on the device: `uploads.json` (T3.3)

Not a cloud record, but what this device knows of its uploads: the upload queue
(`docs/ARCHITECTURE.md`, "Uploads") keeps its state in `uploads.json`, at the root of the origin
private file system beside `sessions/` (§5), written whole under a temporary name and moved into
place as the records are, a tenth of a second after a change (and at once when the page goes away),
so that a reload, or the next start, resumes where the queue was. Its own version is 1; a file of
another version, or not JSON, reads as empty, and an entry that is not well formed is left out (the
index then says what is uploaded, below).

```jsonc
{
  "schema": 1,
  "accounts": {                          // by uid: each account's uploads apart
    "Xb3…uid": {
      "pausedUntilMs": null,             // the day's quota used up until then (resetsAtMs); null
      "sessions": {
        "3f1c…": {
          "sessionJson": {"hash": "6229c326114b0d16", "bytes": 2714},   // last confirmed; null before
          "attempts": {
            "0001": {                    // the attempt's folder
              "scrambleShown": 1790898235052.3,
              "files": {
                "attempt.json": {"bytes": 16210, "hash": "a8bfb37157785f79", "state": "done",
                                 "tries": 1, "doneMs": 1790898238715},
                "laptop.solve.mp4": {"bytes": 913384, "state": "done", "tries": 1,
                                     "doneMs": 1790898238779, "local": false},
                "laptop.solve.frames.json": {"bytes": 948, "state": "pending", "tries": 1,
                                             "error": "the bucket answered 503"},
                "session.json": {"bytes": 2714, "hash": "6229c326114b0d16", "state": "uploading",
                                 "tries": 1}
              }
            }
          }
        }
      }
    }
  }
}
```

A file's `state` is `pending` (to sign and send), `uploading` (signed and being sent, or sent and
being confirmed), `done` (confirmed in the bucket) or `failed` (refused for good, until Retry);
`bytes` is its size, what it is signed for; `tries` the PUTs begun (and the confirmations asked for a
file that may have been sent before a reload); `error` why its last try failed; `doneMs` when the
bucket confirmed it, on the server's clock (`upload.files[path].doneMs` of the index); `local` false
for a clip's MP4 deleted from the device; `hash` for `attempt.json` and `session.json`, made from
their records, a 64-bit hash of the text uploaded (two FNV-1a passes), by which the queue tells that
a record changed since. `tries` 0, `error` null and `doneMs` null are left out. `scrambleShown` is
the attempt's `events.scrambleShown`, which tells it from another attempt that took its index after
Delete last (whose upload starts afresh). `session.json` is listed with the attempt it rides with,
and `sessionJson` is the session's file last confirmed. A file `uploading` when the page went is
confirmed first at the next start (its PUT may have finished) and sent again only when the bucket
does not have it. For an attempt this file does not know, or not as all done, the queue asks the
index for its `upload`, and takes as done a file that the index confirmed with the same size: a device
whose `uploads.json` was lost, or written late, sends nothing twice. A session deleted from the device
leaves the file at the queue's next look.

### The diagnostics events: `users/{uid}/events/{eventId}`, schema version 1

The account's log of the app's own use (`docs/PLAN.md` T3.9, `docs/DIAGNOSTICS.md`): one document
per event, created by the device that saw it, never changed or deleted by the app, which the
coordinator's round report reads as the evidence of the manual rounds and the QA view sums.
`{eventId}` is made on the device: the event's time as 13 digits, a dash and 8 random hex digits
(`eventId` in `packages/core/src/cloud-event.ts`), so that a device's ids sort by time.

```jsonc
// users/Xb3…uid/events/1790000012345-a1b2c3d4
{
  "schema": 1,
  "tsMs": 1790000012345.5,                       // when it happened: host ms (§1) on the device's clock
  "kind": "attempt.done",                         // what: a dotted lowercase name of the catalogue, ≤ 64 characters
  "app": {"version": "0.4.0", "commit": "abc1234"}, // the build that wrote it, as session.json's app
  "device": {"label": "office-mbp", "platform": "macOS", "installed": false},
  "session": "3f1c…",                             // the session it belongs to, when it belongs to one
  "attempt": 17,                                  // the attempt it belongs to (its index), when it does
  "data": {"status": "solved", "timeMs": 14990, "clips": 2, "replayOk": true, "gyroRateHz": 49.8}
}
```

`device` is the host label the account records (`host.label` of §6), the host's platform
(`host.platform`) and whether the app ran installed (display mode `standalone`). `data` holds the
event's facts, by name (`docs/DIAGNOSTICS.md` names each kind's): at most 32, each a text of at most
500 characters, a number, a boolean or null, or a map of those (one level of nesting at most).
Never a MAC address, an email, a file's contents, a user agent or another account's uid: the
builder, `cloudEvent`, holds every event to the shapes above, cuts longer texts and scrubs what
looks like a MAC address or an email. `packages/core/schema/cloud-event.schema.json`
(`CLOUD_EVENT_SCHEMA`) is this document in machine-readable form, `parseCloudEvent` its reader.

**Writing.** Signed in, with Settings → Account → Diagnostics on (the default), the app queues the
events in memory and writes them in one batch (Firestore's `writeBatch`, each document `set`
whole) 5 s after the first of them, at 20 of them, and when the page is hidden or goes away;
Firestore's persistent cache carries a batch while the device is offline. Signed out, the events
wait in memory (the last 500) for a sign-in during the page's life, and are gone with the page;
nothing of them is kept on the device but the day's count, for the cap of 2,000 events a device
writes in a local day (`localStorage` `cubetrace.diagnostics`), past which only the `error.*` kinds
go. A write the server refuses is said once in the console (`cubetrace: diagnostics: …`) and
dropped: the diagnostics never record themselves.

**Reading.** The QA view reads the account's 500 newest events (`orderBy('tsMs', 'desc')`, a
single-field index, which Firestore keeps by itself); the round report reads every account's events
of the last days with the Admin SDK, past the rules (`npm run round-report`, `docs/DIAGNOSTICS.md`).

### The rules

`firebase/firestore.rules`, tested against the Firestore emulator by `firebase/rules.test.ts`
(`npm run test:rules`, in CI) and deployed on merge by `.github/workflows/firebase.yml`:

- `users/{uid}`: only the account `uid` reads, writes and deletes it; it writes only the record's
  fields (`schema` 1, `createdMs` a number, `displayName` and `email` text or null, `devices` a map),
  and never changes `createdMs` once set. `quota` is the functions': the account reads it, never
  creates, changes or removes it, and cannot delete a record that holds it, which would start the
  day's count again.
- `sessions/{id}` and `sessions/{id}/attempts/{index}`: only the account that `owner` names reads,
  updates and deletes one; a new one must name its writer as `owner`, an attempt only under a session
  of the same `owner` (in the same batch or before); `owner` never changes. A query must ask for the
  account's own documents (`where('owner', '==', uid)`). Their shape (T3.1): a session's document has
  an integer `schema` and its path's `id`; an attempt's an integer `schema`, its path's session as
  `session` and its path's index as `index` (`0017` is 17), `device` and `upload` maps, and no
  `moves`; and the account never changes an attempt's `upload` once the document exists (the
  functions do, past the rules). The fields of T3.7, where a document has them: a session's `cube`
  is a map whose `productDate`, if there, is text or null, and its `battery` a list; an attempt's
  `app` is a map of exactly `version` and `commit`, both text, its `gyro` null or a map of exactly
  `file` (`gyro.json`), `samples` (an integer from 1), `fromHostMs`, `toHostMs` and `rateHz`
  (numbers, the rate from 0) and `truncatedStart` (a boolean), and its `resyncs` a list.
- `users/{uid}/cubes/{name}` (T3.4): only the account `uid` reads, lists, writes and deletes them; a
  document must be whole and valid after every write: `schema` 1, its path's name as `name`, `mac`
  six hex bytes in upper case with colons between them, `updatedMs` a number from 0, `device` a
  non-empty text, and no other field.
- `users/{uid}/events/{eventId}` (T3.9): only the account `uid` creates and reads (lists) them;
  nothing updates or deletes one, not even the account. A new document must be whole and valid:
  `schema` 1, `tsMs` a number, `kind` a dotted lowercase name of at most 64 characters, `app` a map
  of exactly `version` and `commit` (text), `device` a map of exactly `label` (non-empty text),
  `platform` (text) and `installed` (a boolean), `session` (if there) a non-empty text, `attempt`
  (if there) an integer from 1, `data` a map of at most 32 fields, and no other field; its id the
  event's time as 13 digits and 8 hex digits.
- Nothing else: no other collection, no other subcollection of a user's record, and nothing for
  anyone signed out.

## 11. `gyro.json`

`gyro.json`, next to `attempt.json` in the attempt's folder (§5), holds the cube's gyroscope reports
over the attempt's window (T3.7): from 2 s before the first scramble turn (the scramble clip's
margin; from 2 s before the scramble was shown, for an attempt without a turn) to 1 s after
`solveEnd` or the DNF (the clips' margin), one continuous stretch, the inspection and the pickup in
it. Its schema version, 1, is its own (`packages/core/schema/gyro.schema.json`; the reader is
`parseGyro`).

```jsonc
{
  "schema": 1,
  "session": "3f1c…",
  "index": 17,
  "app": {"version": "0.4.0", "commit": "abc1234"},   // the build that wrote the file
  "t0HostMs": 1730639998012.5,           // the first sample, on the host clock
  "dtMs": [0, 20.1, 19.9, …],            // per sample, the time since the previous one (§9's convention)
  "q": [x, y, z, w, x, y, z, w, …],      // unit quaternions, flat, four per sample, to 5 decimals
  "v": [x, y, z, x, y, z, …],            // the angular velocity's raw integers, flat, three per sample; null when the cube gives none
  "truncatedStart": false                // true when the buffer did not reach back to the window's start
}
```

Sample k is at host time `t0HostMs + dtMs[0] + … + dtMs[k]`; its quaternion is `q[4k..4k+3]` and
its velocity `v[3k..3k+2]`. `dtMs` is kept as the frames files keep their intervals (§9): the
differences of the sample times rounded to 0.1 ms, so that the sums do not drift, `dtMs[0]` 0. The
host time of a sample is when its Bluetooth packet reached the page, as a move's `hostMs` is (whole
milliseconds from the driver, so the intervals are whole too); the cube's own clock is not in the
gyro packets. `q` is the orientation as the cube reports it, to 5 decimals (the packets carry 15-bit
fractions), `x, y, z, w` with the scalar last. **The cube's frame**, as the driver states it:
right-handed, +X through the red face, +Y through the blue face, +Z through the white face. The
yaw (the turn about the vertical) has an arbitrary reference and drifts, since the cube has no
magnetometer; the pitch and roll are gravity's. The clip viewer (T3.8) shows a 3D cube from these
samples: at the host time a frame shows (the clip's `firstFrameHostMs` plus the time into the clip,
less the camera's lag, `syncResidualMs` of §7) it takes the sample there, or the slerp of the two
around it (the first or last sample beyond the file's span; nothing before the first sample of a
truncated file), relative to the sample at the clip's first frame by default, so that the yaw's
reference does not matter, or raw on request; the cube's frame above is carried into cubing.js's
(+X through R, +Y through U, +Z through F: `(x, y, z) → (x, z, −y)`). `v` is the angular velocity per axis as the cube reports it, raw: the Gen2 cubes (the
GAN 12 ui FreePlay, the GAN 356 i3) send 4-bit signed values, −7 to 7, per packet, in the cube's
units; null when the cube's gyro packets carry none (a sample without one among others is 0).

The samples come from a ring buffer of the page's gyro events (`GyroBuffer` in
`packages/core/src/gyro.ts`): typed arrays holding the last 10 minutes, sized for 100 Hz (a GAN cube
reports at 50 to 100 Hz; a faster cube keeps less time), filled without allocating per event. The
buffer is the page's, not a connection's: the host clock runs on across the cube's reconnections, so
an attempt that spans one keeps its samples from before it, with the gap between them in `dtMs`. A
window older than the buffer begins at its oldest sample and says `truncatedStart` (the first
attempt of a page whose demo cube connected a moment before its scramble, say). The file is written
once per attempt, a second after its end (`GYRO_TAIL_MS` plus `GYRO_SETTLE_MS`, 250 ms, for the last
reports to arrive), with or without a camera, as compact JSON with a final newline, under a
temporary name moved into place (§5); `attempt.json` is then saved again with its summary, `gyro`
(§7), and the upload queue sends both (§10). No file for a cube without a gyroscope (`cube.gyro`
false), or an attempt without a sample in its window; a file that could not be written is noted in
the session's `notes`, `gyro failed: attempt <index>: <reason>` (§6), and the record keeps `gyro`
null. The pickup (§3) is detected as before, from the live events; the file is the record of them.
Size: about 46 bytes a sample, so about 92 KiB for a 20 s solve at 50 Hz (a 15 s scramble, 3 s of
inspection and the margins, 2,049 samples) and 183 KiB at 100 Hz. The rate of the owner's cubes is
measured by the first capture after T3.7 (`docs/DEVICES.md`).
