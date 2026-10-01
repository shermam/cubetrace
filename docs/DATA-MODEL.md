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

Within version 2, two optional fields were added, so that the version 2 files written before them
stay valid, and no new version: a clip in `attempt.json` gained `truncatedStart` (§7, `docs/PLAN.md`
T2.9; the readers take a missing one as false), and a camera in `session.json` gained `microphone`
(§6, T2.12; the readers take a missing one as null).

The JSON Schemas (draft 2020-12) are in `packages/core/schema/`: `session.schema.json`,
`attempt.schema.json` and `frames.schema.json` for version 2, `session.v1.schema.json` and
`attempt.v1.schema.json` for version 1, `user.schema.json` for the account's record in Firestore
(§10), whose version 1 is its own, and `cloud-session.schema.json` and `cloud-attempt.schema.json`
for the documents of the session index in Firestore (§10), which have the version of the records
they copy (2).

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
    └── <camera>.solve.frames.json
```

`sessionId` is a UUID v4; `<camera>` is the camera's `label` (§6), unique within the session:
lowercase letters and digits in words joined by hyphens (`laptop`, `phone-front`, `phone-2`), so
that the file names split at their dots; `<segment>` is `scramble` or `solve`. A JSON file is
written whole under a temporary name next to it, `<name>.<random>.tmp`, then moved over `<name>`
in one step, so a file holds its previous content or the new one even when the page goes away
mid-write; readers ignore such leftover `*.tmp` files and remove them.

## 6. `session.json`

```jsonc
{
  "schema": 2,
  "id": "3f1c…",                         // UUID
  "createdMs": 1730640000000.0,          // host clock at creation
  "app": {"version": "0.2.0", "commit": "abc1234"},
  "host": {"label": "office-mbp", "userAgent": "…", "platform": "macOS", "isPhone": false},
  "cube": {"model": "GAN 12 ui FreePlay", "hardware": "…", "firmware": "…", "gyro": true},
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
  "summary": {"attempts": 0, "solved": 0, "dnf": 0}
}
```

`id` is lowercase, as `crypto.randomUUID()` writes it. `clock.cube` is the least-squares fit of the
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
<reason>` or `cloud: attempt <index> could not be deleted from the index: <reason>` (§10). `summary` is counted from the attempts: each one is solved or a DNF.

`cameras` lists the session's cameras: in phase 2 the host's own (`local: true`); remote cameras
come with phase 4. `label` names the camera in `clock.cameras`, in the clips' `camera` and in
their file names (§5). `facing` is the camera's `facingMode` when the browser says it (`user` for
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
  "scramble": "F2 U2 R B2 D' L B' L' B U2 L2 F2 U F2 U R2 D2 B2 U' L2 D'",
  "scrambledFacelets": "…54 chars…",
  "crossFace": "D",                      // null if DNF before cross
  "events": {                            // hostMs; null when it did not happen
    "scrambleShown": 0, "scrambleStart": 0, "scrambleDone": 0, "pickup": null, "solveStart": 0, "solveEnd": 0
  },
  "moves": [
    {"m": "U'", "hostMs": 1730640000123.4, "cubeMs": 9527, "phase": "scramble"}
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
  ]
}
```

`index` is 1-based. `scrambledFacelets` is the scramble applied to a solved cube, the state at
`scrambleDone`, where the solve starts. `movesQtm` counts the quarter turns of the solve's moves
(a `2` counts two); it equals Cubeast's `quarter_turns` on all 300 fixtures.
`tps = movesQtm / (timeMs / 1000)`, rounded to two decimals. Cubeast's `tps` is not comparable:
it divides its `slice_turns` (two turns of one face merged into one double, turns of opposite
faces into one slice) by the time, so it is lower (3.39 against our 3.87 on average over the
fixtures). The `moves` array is the raw stream in the order the cube reported it, one entry per
face turn, including the corrections of a mis-scramble. `slot` appears on the four f2l phases
only.

A **DNF** (`status: "dnf"`, which the solver can mark at any moment before solved) has `timeMs`,
`tps` and `events.solveEnd` null and `replayOk` false; `phases` are the phases completed before
it and `crossFace` is null if the cross was not; `movesQtm` counts the solve's moves made. If the
solve had not started, `events.solveStart` and `inspectionMs` are null too, and so is
`events.scrambleDone` if the scramble was not done; `scrambleExtraMoves` then counts the extra
moves made so far.

When moves went unseen (the cube's reported state differs from the simulated one), the app adopts
the reported state (a resync); an event that state completes (`scrambleDone`, `solveStart`,
`solveEnd`) takes the time of the report, and the unseen moves are missing from `moves`, so
`replayOk` is false if they were solve moves.

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
  "t0HostMs": 1730640017211.9,           // the first frame, on the host clock
  "dtMs": [0, 33.4, 33.3, 33.3, 66.7, 33.3, …],   // per frame, the time since the previous one
  "keyframes": [0, 30, 60, …],           // the frames a decoder can start at
  "arrival": {"offsetMs": 1730634807211.9, "residualP95Ms": 9.8}
}
```

Frame k is at host time `t0HostMs + dtMs[0] + dtMs[1] + … + dtMs[k]`, so `dtMs` has one entry
per frame and `dtMs[0]` is 0. The intervals come from the frames' own timestamps
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

### The session index: `sessions/{id}` and `sessions/{id}/attempts/{index}`, schema version 2

The index of an account's sessions (`docs/PLAN.md` T3.1): through it the Sessions page of each of the
account's devices lists the sessions of the others, and the QA view counts what was recorded and what
is uploaded. A session's document is its `session.json` (§6) with `owner`; an attempt's is its
`attempt.json` (§7) without `moves`, which stay on the device that recorded it (and go to the bucket
in the uploaded `attempt.json`, T3.3), with `owner`, `device` and `upload`. The documents keep the
schema version of the records they copy, 2; no other was ever written. `{id}` is the session's id,
`{index}` the attempt's index zero-padded to 4 digits, as its folder (§5), so that a session's
attempts sort by index.

```jsonc
// sessions/3f1c…
{
  "schema": 2, "id": "3f1c…", "createdMs": 1730640000000.0, "app": {…}, "host": {…},
  "cube": {…}, "cameras": […], "clock": {…}, "audio": true, "settings": {…}, "notes": "",
  "summary": {"attempts": 17, "solved": 16, "dnf": 1},   // session.json, field for field (§6)
  "owner": "Xb3…uid"                                     // the account that wrote it
}
// sessions/3f1c…/attempts/0017
{
  "schema": 2, "session": "3f1c…", "index": 17, "scramble": "…", "scrambledFacelets": "…",
  "crossFace": "D", "events": {…}, "clock": {…}, "result": {…}, "phases": […],
  "video": [{"camera": "laptop", "segment": "solve", "file": "laptop.solve.mp4", "bytes": 23734012, …}],
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
`<camera>.<segment>.mp4` and `<camera>.<segment>.frames.json`, and `session.json` on the attempt
the session's file went with): `bytes`, its size, and `doneMs`, when its upload was confirmed, in ms,
null until then. **The app writes `upload` once, when it creates the attempt's document**: `pending`,
with the files of the attempt's folder that the device has then and their sizes there (an
`attempt.json` as the store writes it, an MP4 as its clip's `bytes`, a frames file as the file system
has it; one that cannot be read there is left out), each `doneMs` null. An attempt's document is
created when the attempt ends, before its clips are cut, so its `files` names `attempt.json` alone,
and the clips' files are added by the uploads as they are signed; from then on only the functions
write `upload` (T3.2), and the rules refuse the app's changes to it.

**Writing.** With an account signed in, every save of a session (its creation, its summary after each
attempt, a note, a camera, a sync check) writes its document, and every save of an attempt (when it
ends, and again when a clip is attached) writes the attempt's, each merged into the stored one
(Firestore's `set` with `merge`: a field the server added stays): the first write of an attempt's
document carries its `upload`, the later ones every field but `upload`; the timer's Delete last
deletes the attempt's document. Firestore applies the writes to its cache in IndexedDB at once and sends them
when it can, offline after the network is back, across reloads; the saves of the records never wait
for them. **Demo sessions are never written**: a session whose cube is the fake cube
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
  `<camera>.<segment>.mp4`, `<camera>.<segment>.frames.json`), or `session.json`, the session's file,
  recorded on the attempt it was uploaded with.
- The objects are `users/{uid}/sessions/{id}/attempts/{index}/<path>`, and
  `users/{uid}/sessions/{id}/session.json` for the session's file, in the bucket of the configuration
  (`bucket/README.md`).

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
  functions do, past the rules).
- Nothing else: no other collection, no subcollection of a user's record until a task opens it
  (T3.4's cubes), and nothing for anyone signed out.
