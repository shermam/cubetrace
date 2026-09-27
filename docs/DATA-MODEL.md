# Data model, schema version 1

Everything the app records is JSON plus MP4. This document is the contract between the
timer (phase 1), the capture pipeline (phase 2), the upload (phase 3) and the training
pipeline that reads the dataset. Change it only with a PR that bumps `schema` and adds a
CHANGELOG entry; never rewrite stored files.

## 1. Time

- **Host clock.** Every timestamp is `hostMs`: `performance.timeOrigin + performance.now()`
  on the host device, a float in milliseconds. Monotonic within a session; comparable
  across sessions only approximately (wall clock).
- **Cube clock.** The cube's own millisecond counter, as delivered by the driver
  (`cubeMs`). Kept next to `hostMs` for every move; the per-session linear fit
  `hostMs ≈ a·cubeMs + b` and its residuals are stored in `session.json`.
- **Frame time** (phase 2): the host time of every video frame, in `*.frames.json`.

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
| `pickup` | optional: gyro quaternion changed beyond a threshold after `scramble_done` (cubes with a gyro) | cube |
| `solve_start` | first cube move after `scramble_done` | cube |
| `solve_end` | cube state is solved | simulator |

`inspection_ms = solve_start − (pickup ?? scramble_done)`. `time_ms = solve_end − solve_start`.
Moves between `scramble_start` and `scramble_done` have `phase: "scramble"`; between
`solve_start` and `solve_end`, `phase: "solve"`; moves after `scramble_done` and before
`solve_start` cannot exist by definition (the first one *is* `solve_start`). Extra moves
during a mis-scramble are part of the scramble phase; `result.scramble_corrected` is true
and `result.scramble_extra_moves` counts the moves beyond the scramble's own.

## 4. CFOP phases

Names, in order: `cross`, `f2l1`, `f2l2`, `f2l3`, `f2l4`, `eoll`, `ocll`, `pll`
(two-look OLL is the reference method; a one-look OLL solver completes `eoll` and `ocll`
on the same move). Colour-neutral: the cross face is whichever face completes a cross
first after `solve_start`, and it never changes.

| Phase | Ends at the first move after which… |
|---|---|
| `cross` | some face `X` has its four edges in place and oriented (all four edge stickers on `X` show `X`'s colour and the other sticker of each edge matches its adjacent centre); `X` becomes `crossFace`. Faces whose cross was already complete at `scramble_done` are excluded. If one move completes several crosses, the one with the most pairs in place wins, then the first in the order `U R F D L B`. |
| `f2l1`..`f2l4` | one more of the four corner–edge pairs of the first two layers (relative to `crossFace`) is fully in place, counting pairs only while the cross is complete; slots are numbered by completion order (pairs completed by the same move in a fixed order of the slots), and the record says which physical slot each was |
| `eoll` | all four last-layer edges show the last-layer colour on the last-layer face |
| `ocll` | all four last-layer corners do too |
| `pll` | the cube is solved |

Per phase: `startMs` (previous phase's `endMs`, or `solve_start` for the cross), `endMs`,
`moves` (count), `recognitionMs` (from `startMs` to the phase's first move) and
`executionMs` (from the phase's first move to `endMs`). A cross completed first by
accident is kept, as Cubeast keeps it, even when the solver then builds the first two
layers on another face.

Checked against the 300 Cubeast fixtures in T1.3: all 2400 phase boundaries agree within
±1 ms. Pairs count only while the cross is complete because, during an insertion that
takes a cross edge out, another pair can sit in place for a move or two: counting it ended
the phase before the insertion was over on 5 of the 300 solves (4 of them with the wrong
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

`sessionId` is a UUID v4; `<camera>` is a short label unique within the session
(`laptop`, `phone-1`, `phone-2`).

## 6. `session.json`

```jsonc
{
  "schema": 1,
  "id": "3f1c…",                         // UUID
  "createdMs": 1730640000000.0,          // host clock at creation
  "app": {"version": "0.1.0", "commit": "abc1234"},
  "host": {"label": "office-mbp", "userAgent": "…", "platform": "macOS", "isPhone": false},
  "cube": {"model": "GAN 12 ui FreePlay", "hardware": "…", "firmware": "…", "gyro": true},
  "cameras": [],                          // phase 2: [{label, local: bool, settings, capabilities, crop, mode}]
  "clock": {"cube": {"a": 1.0002, "b": 1730639990000.0, "residualP95Ms": 8.1, "samples": 1234},
            "cameras": {}},               // phase 2: per camera {offsetMs, rttMs, driftPpm, clapperboardResidualMs}
  "audio": true,
  "settings": {"inspection15s": false, "autoAdvance": true},
  "notes": "",
  "summary": {"attempts": 0, "solved": 0, "dnf": 0}
}
```

## 7. `attempt.json`

```jsonc
{
  "schema": 1,
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
  "result": {
    "timeMs": 20412, "inspectionMs": 4200, "movesQtm": 81, "tps": 3.97,
    "status": "solved",                  // "solved" | "dnf"
    "replayOk": true,                    // scrambledFacelets + solve moves reach solved in the simulator
    "scrambleCorrected": false, "scrambleExtraMoves": 0
  },
  "phases": [
    {"name": "cross", "startMs": 0, "endMs": 0, "moves": 8, "recognitionMs": 0, "executionMs": 0},
    {"name": "f2l1", "slot": "DFR", "startMs": 0, "endMs": 0, "moves": 9, "recognitionMs": 0, "executionMs": 0}
  ],
  "video": []                            // phase 2: [{camera, segment, file, bytes, codec, audio, width, height, crop, fpsNominal, frames, firstFrameHostMs, framesFile, syncResidualMs}]
}
```

`movesQtm` counts quarter turns (a `2` counts two). `tps = movesQtm / (timeMs / 1000)`.
The `moves` array is the raw stream in the order the cube reported it, one entry per face
turn, including the corrections of a mis-scramble.

## 8. Fixtures

`fixtures/solves.json`: real solves with `scramble`, `scrambled_facelets`, `solution` (the
raw `MOVE[ms]` stream on the cube clock), `moves` (parsed), `normalized`, the Cubeast result
columns and `cubeast_steps` (name, moves, recorded_moves, time, recognition_time,
execution_time, cumulative_time per step). `fixtures/identities.json`: solved state, the
`R` vector, states after short scrambles, sequences that return to solved, sequences that
do not. Generated from the owner's Cubeast export by a private script; treat as read-only.
