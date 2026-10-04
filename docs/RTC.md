# Remote cameras: the connection between the host and a phone

Phase 4 (`docs/PLAN.md`, the phase 4 board) lets a phone join a session as a camera: it films from
another angle, records its own camera at full quality into its own ring buffer, and hands the host the
clips of each attempt, all on the host clock. This document is the contract of that connection, as
T4.0 built it in `packages/rtc` (the code), `packages/core` (the clock maths, the records' fields,
the documents' shapes) and `firebase/firestore.rules` (the signaling's rules): the messages of the
data channel, the file transfer, the clock sync, the signaling and the pairing token, and what each
side does when something fails. The pages that use it came with T4.1 (§8 below: the lifecycle as the host's Cameras section and
the phone's Camera page run it), the cuts and the clips' transfer with T4.2 (§9), the sync check of
the phone's camera and the live preview with T4.3 (§10). `docs/ARCHITECTURE.md` ("Remote cameras")
places it in the app.

**Stream for control, record locally for data.** One `RTCPeerConnection` between the two devices,
made with Google's public STUN server (`stun:stun.l.google.com:19302`) and no TURN relay: on one Wi-Fi
the two connect directly, on a network with client isolation (a guest or office network) they do
not, and the office rig stays the laptop's own webcam. One reliable, ordered data channel
(`cubetrace`, `ordered: true`, no retransmit limit) carries everything of this document: the clock
pings, the camera's state and thumbnails, the cut commands, and the clip files themselves, as bytes.
Since T4.3 a low-bitrate video track, the live preview, goes over the same connection (§2, §10): it
is never data, and nothing of it is recorded. Nothing is transcoded on the host.

**Roles.** The device that opened the session is the *host*; the phone is a *camera device*. Over
the signaling the phone is the *caller* (it creates the peer document with its offer) and the host
the *callee* (it answers). Over the data channel the host asks and the phone answers: the host pings,
cuts and acknowledges; the phone reports its state, sends thumbnails, cuts and sends files. Both
sides are signed in to the same account, and the pairing's documents are the account's own.

## 1. The protocol (`packages/rtc/src/protocol.ts`)

The messages are typed (`Message`), encoded with `encode` and decoded with `decode`, which refuses
anything that is not a message of this protocol with a `ProtocolError`. Control messages go as JSON
text frames; a file's chunk and a thumbnail go as binary frames, so that their bytes are not
base64-encoded. The protocol is versioned: `PROTOCOL_VERSION` is 1, each side says its version in
`hello`, and a side that receives another version sends `leave` and closes. Within a version a reader
ignores the fields it does not know, so that a build that adds an optional field still talks to the
build before it (the two devices run the same deployment, but a phone's installed app may lag a day);
what a message must carry is checked field by field, with bounds (texts of at most 1,000 characters, a
file name without a path).

| Message | From | Fields | When |
|---|---|---|---|
| `hello` | both | `v` (1), `role` (`host`, `camera`), `device: {label, platform}`, `app: {version, commit}`, `camera` (the phone's camera as its own session.json would describe it: a `CameraInfo`, read by core's `parseCameraInfo`; null from the host) | the phone once its channel opens, the host in answer (T4.2b); the phone again when its camera changes |
| `ping` | host | `t1`, the host clock | every 500 ms until the clock sync converges, for a minute at most, then every 2 s (`PING_INTERVAL_MS`, §4) |
| `pong` | phone | `t1` back, `t2` (when the ping came) and `t3` (when the answer goes), on the phone's clock | at once, for each ping |
| `clock` | host | `converged`, `offsetMs` (the phone's clock minus the host's), `rttMs` (the least round trip kept): the sync as the host measures it, for the phone to show (T4.1; additive within version 1) | after each answer it took |
| `state` | phone | `remoteMs`, `recording`, `framing` (the rectangle or null), `frame: {width, height}`, `fps`, `sharpness`, `battery: {level, charging}`, `thermal` (`ok`, `throttled`, null), `pendingClips`; each nullable field null when unknown | every 2 s, and at each change the host should see at once |
| `thumbnail` | phone | `remoteMs`, `width`, `height`, `jpeg` (a JPEG of at most 320 px on its longer side) | every 2 s (binary) |
| `cut` | host | `attempt`, `scrambleShown` (the attempt's, on the host clock: an attempt begun again with the same index has another), `segment` (`scramble`, `solve`), `fromRemoteMs`, `toRemoteMs` (the window in the phone's clock, through the host's clock estimate and widened by its margin on each side, §9), `reason` (the timer's milestone: `armed`, `ended`), `camera` (the label the session gives the phone's camera: its files' first name) | when the host cuts its own camera; sent again as it was over a new connection while unanswered |
| `cut-done` | phone | `attempt`, `scrambleShown`, `segment`, `files: [{name, bytes, kind}]` (the frames file first), `clip` (what the capture said of it: `codec`, `audio`, `width`, `height`, `fpsNominal`, `frames`, `crop`, `truncatedStart`, `lateMs`, `bufferSeconds`, `audioMissing`) | the clip is muxed and staged; offered again over each connection until the host's `clip-ack` |
| `cut-failed` | phone | `attempt`, `scrambleShown`, `segment`, `reason` | the capture could not cut it: the phone not recording, an encoder error, no room |
| `clip-ack` | host | `attempt`, `scrambleShown`, `segment`, `stored` (the clip is in the attempt's folder and record), `reason` (why not) | the clip is stored, or will not be taken (its attempt gone, its frames file unreadable): the phone deletes its copy either way |
| `file-begin` | sender | `id` (this connection's number for the file), `name`, `bytes`, `kind` (`mp4`, `frames`), `attempt`, `segment` (null for a file of neither) | a file starts, or starts again after a reconnection |
| `file-resume` | receiver | `id`, `offset` | the answer to `file-begin` (the bytes it already holds: 0 for a new file), and to a `file-done` whose checksum did not match (0: again from the start) |
| `file-chunk` | sender | `id`, `offset`, `bytes` (binary: a 13-byte header, the kind `0x01`, the id as 4 bytes, the offset as 8 bytes, big-endian, then the bytes) | every chunk |
| `file-ack` | receiver | `id`, `offset` (the highest offset up to which every byte is held), `done` | every 1 MB (`ACK_EVERY_BYTES`), and once with `done: true` when the file is complete and checked |
| `file-done` | sender | `id`, `crc32` (of the whole file) | after the last chunk |
| `file-abort` | either | `id`, `reason` | the sender gives the file up (the checksum refused three times), or the receiver cannot take it (no room, a chunk that does not fit) |
| `leave` | either | `reason` | the phone's Leave, the host's Remove, a protocol version that does not match |
| `sync-start` | host | `id` (the check's number on the host's page) | a sync check of the phone's camera starts (T4.3, §10); a new one ends the one before |
| `sync-stop` | host | `id` | the check ended (done, failed, put off) |
| `sync-motion` | phone | `id`, `frames: [{timestampUs, arrivalMs, receivedMs, mean, changed, costMs}]` (each frame's own timestamp, its arrival in the capture worker and its reception by the page on the phone's clock, its mean change and its changed area inside the framing rectangle, the worker's time on it; at most 240, `MAX_MOTION_FRAMES`) | every 250 ms while the check measures, when there is something to send |
| `sync-meter` | phone | `id`, `meter: {format, path, frameWidth, frameHeight, region, planeWidth, planeHeight, changeLevels}` (how the capture worker reads the frames) | first, and when it changes |
| `sync-error` | phone | `id`, `message` | the phone cannot measure (it does not record, its recording stopped during the check, its frames cannot be read): the host's check ends as failed |
| `preview` | host | `on` | after the hellos, and whenever "Live preview from phones" changes (T4.3, §10): whether the phone sends its live picture |

The thumbnail's binary frame is a 13-byte header too: the kind `0x02`, the time as a float64, the
width and the height as 2 bytes each, then the JPEG. `MessageLink` wraps a transport, decodes each
frame and hands the message to the handlers of its type (`link.on('pong', …)`), reports a frame that
is not a message (`onError`) and drops it, and sends messages encoded (`link.send`, or `trySend`,
which does nothing on a closed transport). The fields of the cuts and `clip-ack` came with T4.2,
additive within version 1: no build before T4.2 cuts. The sync messages and `preview` came with T4.3,
additive the same way: a phone of a build before T4.3 drops them as frames that are not messages
(`onError`), sends no picture, and a check of its camera ends without frames.

## 2. The transport (`transport.ts`, `webrtc.ts`)

`Transport` is one end of the channel: `send(frame)`, `onFrame`, `bufferedAmount` and its
`bufferedAmountLowThreshold` with `onBufferedAmountLow` (the data channel's own flow control),
`maxMessageSize` (the SCTP transport's, null when unknown), `onStateChange` (`connecting`, `open`,
`closed`, `failed`, with why) and `close`.

`WebRtcTransport.connect({signaling, …})` is the real one: it makes the `RTCPeerConnection` (the STUN
server above, or the configuration given), and for the signaling's role runs the dance. The caller
creates the data channel, makes its offer when the connection asks for negotiation, sets it as its
local description and sends it through the signaling; the callee receives the channel, and for each
offer that comes sets it as its remote description, makes its answer and sends it. Each side sends
its ICE candidates as they trickle (`onicecandidate`), and adds the other's as they come, holding
back those that arrive before the remote description is set. `connect` resolves once the channel is
open, and rejects when the connection failed or closed before, or after 30 s (`CONNECT_TIMEOUT_MS`).
Frames are sent as text or as an `ArrayBuffer` copy of the bytes; `binaryType` is `arraybuffer`. When
the connection's state is `failed`, the caller calls `restartIce()`, which brings a new offer through
the same signaling (the peer document's offer replaced, its answer cleared), and the callee answers
it; `disconnected` is left to ICE, which comes back by itself when it can. Closing the transport
closes the channel, the connection and the signaling. This file alone in the package touches the
browser's WebRTC API: the unit tests never load it, and the end-to-end suite of T4.1 covers it.

**The live preview's video** (T4.3, §10). A caller made with `preview: true` (the phone,
`apps/web/src/app/rtc/transport-connector.ts`) adds a send-only video transceiver before its data
channel, so that its first offer carries a video section beside the channel's and the picture turns
on and off with no new offer, no renegotiation through the signaling: the transceiver's encoding is
inactive and capped by `PREVIEW_ENCODING` (`preview.ts`: `scaleResolutionDownBy` 5, `maxBitrate`
300 kbps, `maxFramerate` 15), without a track until `preview.send(track)`, which replaces the track
and then activates the encoding with the caps (`RTCRtpSender.replaceTrack`, `setParameters`), and to
stop deactivates it before it drops the track: never an active encoding without a track, nor a track
sent uncapped. The callee takes the track of an offer that brings one (`ontrack`); Chrome's receiving
track is muted while no frame comes, which is how the host tells a picture that flows. Both ends read
the stream's statistics (`preview.stats()`, `previewStats`: frames encoded or decoded, the frame rate,
the size, the bytes, the encoder's time and implementation, why the quality is held back and for how
long by the CPU). The offer grows from 458 to 2,740 characters with the video section (the answer
2,440), far under the 20,000 the signaling's rules allow; a renegotiation was not needed, and the
signaling documents, which hold one offer and one answer, are unchanged.

`MemoryTransport.pair({delayMs, jitterMs, bytesPerSecond, loss, retransmitMs, maxMessageSize,
timers})` joins two ends in memory for the tests, as a reliable channel over a network behaves: each
end drains its queue into the network at the bandwidth (so that `bufferedAmount` fills and the low
event fires as the real channel's do), a frame reaches the other end after the delay plus a random
share of the jitter, and a frame "lost" (the share `loss`) is never dropped but arrives
`retransmitMs` late, holding back every frame behind it (the head-of-line blocking of an ordered
channel). Closing one end closes the other at once and drops what was on its way, as a cut connection
does. `transform` lets a test corrupt or drop frames. `FakeTimers` (`testing.ts`) is the clock the
tests drive: `advance(ms)`, or `run(promise)`, which fires the timers one by one, letting the pending
promises settle between them, until the promise settles.

## 3. The file transfer (`transfer.ts`)

Each clip's MP4 and frames file goes from the phone to the host over the data channel, in order,
the frames file first (§9; the transfer takes any order). The numbers: chunks of 64 KB
(`CHUNK_BYTES`), or 16 KB (`SMALL_CHUNK_BYTES`) when the channel says its `maxMessageSize` is under
64 KB; the channel's low threshold set to 256 KB (`BUFFERED_AMOUNT_LOW_THRESHOLD`); an
acknowledgement every 1 MB (`ACK_EVERY_BYTES`).

**Pacing.** `FileSender.send(file)` sends `file-begin`, waits for the receiver's `file-resume`, then
sends the chunks from the offset it asked for: before each chunk, if the channel's `bufferedAmount`
is above the threshold it waits for the low event, so that at most the threshold and one chunk are
queued on the channel, never a message too large for it, and the sending never stalls the channel's
other messages for long (a ping waits behind at most 320 KB). The last chunk is followed by
`file-done` with the CRC-32 of the whole file (`crc32.ts`, table-driven, rolling: the sender updates
it as it reads, the receiver as it writes). The send resolves on the receiver's `file-ack` with
`done`, with how many bytes were resumed from and how many times the file was sent again. The
simulation in `transfer.test.ts` moves 40 MB over a 200 ms link of 20 MB/s with 1% of the frames lost
in 2.9 s (14.5 MB/s), the wire alone taking 2.1 s and the three retransmissions 1.8 s: nothing of the
pacing is idle time.

**Receiving.** `FileReceiver` listens on a link and puts the files into an `IncomingFiles` store
(`MemoryIncomingFiles` in the tests; the host's keeps them in the page's memory until the clip's
record is written, §9: a clip is a few megabytes, and the page that holds the bytes is the one the
next connection resumes into): on
`file-begin` it opens the file in the store, which gives what it already holds of a file of that name
and size (nothing for a new one), and answers `file-resume` with that offset; it appends each chunk in
order (a chunk that repeats bytes already held is skipped; one that leaves a gap, or goes past the
announced size, ends the file with a `file-abort`), acknowledges every megabyte, and at `file-done`
checks the length and the checksum: when both match it finishes the file in the store, sends
`file-ack` with `done` and reports it (`onReceived`); when they do not, it discards what it holds and
answers `file-resume` from 0. The sender then sends the file again, at most `MAX_CHECKSUM_RETRIES` (2)
times, before it gives up with `file-abort` and a `TransferError` whose reason is `checksum`; the
receiver, told, drops the file and reports the failure (`onFailed`).

**Resume.** The store outlives the connection. When the channel closes in the middle of a file, the
sender's promise rejects with a `TransferError` of reason `closed` and the phone keeps its copy; over
the next connection it sends the file again (`file-begin`, the same name and size), the receiver
answers with the bytes it holds, and the sender goes on from there, reading the bytes before the
offset once more for the checksum, which covers the whole file. A file the receiver already completed
goes again from 0 if it is sent again (the store opens a fresh file): the phone deletes its copy once
the host's `clip-ack` says what became of the clip, so this happens only when that word was lost
with the connection (and the host, which has the clip, answers the file's offer at once).

## 4. The clock sync (`packages/core/src/remote-clock.ts`, `packages/rtc/src/clock-sync.ts`)

The dataset stays on the host clock. The phone keeps its own (`performance.timeOrigin +
performance.now()`), and the host measures the offset between the two over the data channel, as NTP
does: the host sends `ping {t1}`; the phone answers `pong {t1, t2, t3}`, `t2` when the ping came and
`t3` when the answer leaves, on its clock; the host receives it at `t4`. Each round trip is a sample:

```
offset = ((t2 − t1) + (t3 − t4)) / 2      the phone's clock minus the host's, the legs taken symmetric
rtt    = (t4 − t1) − (t3 − t2)            the round trip, without the phone's time to answer
```

**The samples kept** (T4.2b). `RemoteClockFit` looks at the samples of the last two minutes
(`REMOTE_CLOCK_WINDOW_MS`, at most 240 of them, `REMOTE_CLOCK_WINDOW`: two minutes of the first
pings at 500 ms; the last 60 samples before T4.2b, the same at the steady 2 s). A sample's offset is
off the truth by half the difference between its two legs, so by at most half its round trip, and a
short trip had little room for an asymmetry; so the estimate stands on the samples of least round
trip, as a clock filter takes them: those within a band of the window's least trip, 1.5 times it
(`REMOTE_CLOCK_RTT_FACTOR`) or 3 ms over it when that is more (`REMOTE_CLOCK_RTT_ALLOWANCE_MS`,
T4.1: a loopback's or an Ethernet cable's least trip is a millisecond), and at least the 10 of least
round trip, however jittery the link (`REMOTE_CLOCK_MIN_KEPT`; the lower half of the window while it
holds fewer than 20, so that the trip of a burst never decides a median of two). The offset is the
median of their offsets. Once the kept samples span more than 60 s (`REMOTE_CLOCK_DRIFT_SPAN_MS`), a
least-squares line `offset(t) = a + b·(t − t₀)` through them (host times counted from their mean, so
that wall-clock values lose no precision) gives the drift, `driftPpm = b · 10⁶` (50 ppm is 3 ms a
minute). `toHostMs(remoteMs)` and `toRemoteMs(hostMs)` use the line when there is one and the median
before; they are exact inverses.

**Why at least ten.** The band alone is a share of the least trip, and a link whose trips jitter by
more than that share keeps a handful of them. The owner's home Wi-Fi on 2026-10-04 (the ThinkPhone
paired to the MacBook for 20.7 minutes, 18 attempts, read from the diagnostics events): the least
round trip 5.4 to 8.5 ms, the phone's clock 238 to 245 ms behind the laptop's (moving by about 7 ms
in 20 minutes, a few ppm); the band kept 2 to 14 samples of the 60 at the 36 cuts (7 at the median),
and those agreed (their residuals' 95th percentile 0.7 to 1.7 ms), but their count flapped around the
ten that convergence asked for: the fit converged twice and was withdrawn twice, and 10 of the 36 cuts
went with it converged; the day before, two pairings of 12 and 4 minutes never converged (issue #61).
Two pages of one browser that both encode video (the end-to-end pair on CI, T4.2's probe): every ping
answered, the least trip 2 to 3 ms, the median 17 to 18, the band keeping 1 to 4 of 16. A count rather
than a share of the window, so that the faster pings of the start keep better trips, not more of them.

**Converged** (`REMOTE_CLOCK_CONVERGED`) when at least 10 kept samples span 10 s or more, their
residuals from the estimate spread by less than 5 ms between the 10th and the 90th percentile, and no
sample of the window is farther from the estimate than half its round trip and those 5 ms: such a
sample says that a clock moved (the phone slept, and its clock stopped), and the sync is withdrawn at
that sample, rather than once enough such samples are kept for the spread to show it. The spread
allowed was 3 ms until T4.2b: the ten trips of least round trip of a jittery Wi-Fi reach about 4 ms
over the least, so their offsets spread by 2.5 to 3.5 ms, and 3 ms flapped as the band's count did;
5 ms is a sixth of a frame at 30 fps, and still refuses a busy network (10 ms and more). `converged`
is withdrawn when the window's samples no longer agree (the network got busy, a clock moved) and
comes back once the window has turned over (two minutes). The record for `clock.cameras[label].remote`
(`params`) is `{offsetMs, driftPpm, rttMs (the least round trip), samples (the kept ones),
residualP95Ms, since (the host time of the oldest kept sample)}`; `window` gives the diagnostics the
window's round trips, kept or not (their median and 95th percentile, how many, how many kept).

**The simulations** in `remote-clock.test.ts` (a phone clock with an offset and a drift; a network of
two legs, each a base and an exponential wait, as queues give). Those of T4.0 give the numbers they
gave, the band keeping all or nearly all of their samples: the offset within 1 ms at round trips of 5,
20 and 40 ms with 1, 2 and 3 ms of jitter, converged; a drift of 37, −80 and 0 ppm fitted to 0.8 ppm
over an hour; on a busy network (40 ms, 30 ms of jitter) the offset within 0.3 ms, never converged.
Pinged as `ClockPinger` pings (below), the first three converge after 10 s rather than 18 to 20 s at
2 s, and are never withdrawn (at 40 ms, the band's rule was withdrawn up to four times in two
minutes). The two of T4.2b, against the band alone (the rule of T4.0 to T4.2, kept in the test for
comparison) pinged every 2 s as it was, three pairings each:

| Simulation | The band alone, pinged every 2 s | T4.2b |
|---|---|---|
| The home Wi-Fi: each leg 2.8 ms and a wait of 5 ms on average, one ping in 20 held 100 to 300 ms on its way to the phone (Wi-Fi power saving), so the least trip about 6 ms and the median 14; the phone 240 ms behind, drifting by 5 ppm; 20 minutes | kept 3 to 26 of 60 (10 to 12 at the median); converged after 98 to 104 s, withdrawn 13 to 15 times | converged after 10.5 to 12 s, never withdrawn; the offset within 1.1 to 1.5 ms of the truth at the 99th percentile of the samples while converged, 0.7 ms at the end (2.3 ms at worst: two samples of one pairing, while a drift of 50 ppm was fitted through ten samples) |
| Two loaded pages of one browser: each leg 1 ms and a wait of 9 ms on average, so the least trip 2 to 3 ms and the median 16 to 19; 5 minutes | kept 1 to 10 of 60; converged after 130 s in one pairing, never in the two others | converged after 13.5 to 22 s, withdrawn 1 to 5 times; the offset within 1.9 ms while converged |

The drift fitted through the ten or so samples a jittery Wi-Fi keeps in two minutes is rough: on the
home Wi-Fi's simulation, 3 to 16 ppm at the end for a true 5, and 23 to 50 ppm at worst while
converged, one to three milliseconds a minute, which the offset's errors above include.

**The estimate at a clip's own time** (T4.3). What converts a time is a line: `RemoteClockFit.line()`
freezes the fit's estimate (`RemoteClockLine`: its offset at its newest kept sample and its drift;
before the drift is fitted, the median offset and no drift), and the app's clock estimate
(`remote-estimate.ts`, which before 3 kept samples takes the offset of the window's least-round-trip
sample) is that line with the fit's record. The host takes the estimate when it sends a cut and keeps
it with the cut; the clip's frame times are converted with it when the files come, at the clip's own
first frame (the line's value at `t0RemoteMs`), so that a file that comes late (the phone away, or
asleep with its clock stopped, which moves the live fit) is converted as it was when it was cut. A
clip the host did not cut (one offered after the host's page loaded again) takes the estimate when
its file comes. The simulations (`remote-frames.test.ts`, on `remote-clock-sim.ts`): a clip 10
minutes into a session with 50 ppm of drift converts within 1 ms of the truth (29 ms off with the
offset at pairing); the clips of 20 minutes on the simulated home Wi-Fi within 0.64 to 0.89 ms at
worst over three pairings (with the estimate 3 s later, when the files come: 0.67 to 1.12 ms); a clip
whose files come after a five-minute sleep within 1 ms with the line of its cut, five minutes off
with the fit's estimate then. The sync check's frames (§10) are converted with the estimate of the
moment each batch comes, a quarter of a second after them.

**The pings** (`clock-sync.ts`). `ClockPinger` (the host) pings every 500 ms (`FAST_PING_INTERVAL_MS`)
until an answer leaves the fit converged, or for the first minute at most (`FAST_PINGS_MS`), then
every 2 s (`PING_INTERVAL_MS`): a new connection's fit has its ten samples over ten seconds in about
ten seconds, and a fit kept across a reconnection, converged still, is back at the steady rate at its
first answer. It adds each answer to the fit, ignoring an answer to a ping it did not send (an old one
after a reconnection) and a sample whose clocks ran backwards; `answerPings` (the phone) answers.
T4.1's `RemoteCamerasService` owns one pinger per phone, keeps the fit across the phone's
reconnections, sends `clock` back after each answer, writes the fit's record into the session when it
converges and every minute after (§8), and says how the sync goes in the diagnostics every minute of
the connection, converged or not (`rtc.clock`, `docs/DIAGNOSTICS.md`).

## 5. The signaling and the pairing token (`signaling.ts`, `pairing.ts`)

Before the data channel exists, the offer, the answer and the ICE candidates travel through
Firestore, the FirebaseRTC pattern on the modular SDK (`docs/DATA-MODEL.md` §10 has the documents and
the rules):

```
host                                   Firestore                                   phone
publishPairing(token)  ─▶  sessions/{id}.pairing = {tokenHash, expiresMs}
show the QR: /camera?session=<id>&token=<t>  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─▶  scan, or type the token
                                                                      checkPairing(token): the hash matches, not expired
                           sessions/{id}/peers/{peerId} = {offer, tokenHash, state: offered}  ◀─  call(): createOffer
watchOffers ◀─  the peer owned by the account, offered  ─ check its tokenHash against the pairing
answer: {answer, state: answered}  ─▶  the document  ─▶  the phone's watchPeer: setRemoteDescription
calleeCandidates/{id}  ─▶ ◀─  callerCandidates/{id}        each side writes its own, watches the other's
the data channel opens on both sides ─▶ the phone's hello ─▶ the host's ─▶ pings, state, thumbnails …
```

`FirestoreSignaling` is one session's signaling for either device, over a `SignalingBackend` (the
few Firestore calls, which the app's `AccountBackend` implements: `getSession`, `writePairing`,
`createPeer`, `updatePeer`, `deletePeer`, `watchPeers`, `watchPeer`, `addCandidate`,
`watchCandidates`). The host: `publishPairing(token, ttl)` writes the token's SHA-256 and the expiry
into the session's document (10 minutes by default, `PAIRING_TTL_MS`), `closePairing` clears it, and
`watchOffers` gives, once per peer document in the `offered` state with an offer and owned by the
account, the peer and the host's `Signaling` with it (T4.1 answers only a peer whose `tokenHash` is
the pairing's and before it expires, the first one, and then closes the pairing: the token is taken
once). The phone: `checkPairing(token)` reads the session document's `pairing` alone (`ok`,
`no-session`, `no-pairing`, `expired`, `wrong-token`), and `call({tokenHash})` gives its `Signaling`,
whose first `sendDescription` creates the peer document with the offer and the hash.

A `Signaling` is one peer connection's path for one role: `sendDescription` (the caller's offer,
which creates the document, or replaces its offer and clears the answer at an ICE restart; the
callee's answer), `sendCandidate`, `onDescription` (the other side's, the one known when the handler
subscribes first, then each change), `onCandidate` (each of the other side's, the ones already there
first; told apart by document id), `onClosed` (the other side left, or the documents are gone),
`onError` (the backend's refusals) and `close`: the phone marks its document `closed`, the host
deletes the peer with both candidate collections. `MemorySignalingBackend` is the backend in memory
(the documents in maps, the watchers told asynchronously, the writes listed), and `MemorySignaling`
joins a host and a phone over one: `signaling.test.ts` runs the whole sequence on it, with an ICE
restart, the closings from both sides, the refusals and the junk documents.

**The token** (`pairing.ts`): 8 characters of Crockford's base32 alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`:
no I, L, O or U), 40 bits from `crypto.getRandomValues`, meant to be typed: `normalizeToken` takes
any case, ignores spaces and hyphens, and reads I, l and L as 1 and O and o as 0. The host shows
it under the QR code, whose URL is the camera page with the session and the token
(`pairingUrl`: `https://shermam.github.io/cubetrace/camera?session=<id>&token=<t>`;
`parsePairingInput` reads that URL or a token typed by hand). The token itself is never stored: the
documents hold `hashToken(token)`, SHA-256 as 64 lowercase hex digits (`crypto.subtle`), and
`checkPairing` compares hashes. The pairing is a second factor on top of the account: both devices are
signed in to the same account already, and the token says which session, on which host, the phone
means to join, and that the host wants it now.

## 6. The records (`docs/DATA-MODEL.md` §6, §10)

The schemas stay at version 2 with new optional fields, as T3.7's: in `session.json` a camera's
`local` may be false, and then `remote: {label, platform}` names the device it runs on (its host
label and platform, as its own records have them); a camera clock may carry `remote`, the clock
fit's record above, beside the clapperboard's result (`rttMs` and `driftPpm` repeat the fit's; the
lag of the phone's own sync check since T4.3, §10, `docs/DATA-MODEL.md` §6 says what it means). The
host gives a remote camera its label with `labelFor`, as any camera (`phone-rear`, a second phone
`phone-rear-2`, two phones told apart by their host labels); its clips are `video[]` entries like
any other, named after it. In Firestore the session's document gains `pairing`, the peer documents
and their candidates get schemas of their own (`cloud-peer.schema.json`,
`cloud-candidate.schema.json`) and readers (`parseCloudPeer`, `parseCloudCandidate`,
`parseSessionPairing`), and the rules open all of it to the session's owner alone. Since T4.2 the
`remote` record of a camera clock may say `converged`: false for the estimate a first cut relied on
before the fit converged (§9), true once it did; a remote camera's frames file keeps the phone's
first frame time as `t0RemoteMs` and the estimate that converted it as `remote`
(`docs/DATA-MODEL.md` §9): since T4.3 the estimate of its cut, its `offsetMs` the one applied at the
first frame.

## 7. Failure modes

| What happens | The host | The phone |
|---|---|---|
| The token is wrong, expired or already taken | `watchOffers` gives a peer whose `tokenHash` is not the pairing's (nor a reconnecting camera's, nor one connecting that has not connected yet): the host deletes its documents and shows nothing | `checkPairing` said so before any document was written; the page says to ask for a new code; a call the host never answers fails after 30 s |
| A first call fails (the connection not made, a hello that a busy page sent late or that never came, T4.2b) | the camera stays listed as connecting (`rtc.failed`), and a call that presents its token again is answered, until the pairing's ten minutes from the moment the token was taken are up; then it goes | the page stays joining and says why, and calls again with the same token every 3 s until the pairing's ten minutes from its check are up; then it says the host could not be reached |
| Another version of the app on the phone | `hello.v` differs: `leave` with the reason, the connection closed, the camera not registered | the same; the page says to update |
| The peer connection fails (the Wi-Fi dropped, the phone changed networks) | the transport reports `failed` or `closed`; the camera's entry says reconnecting for five minutes, during which a call with its token is answered again; then it goes; the clips in flight wait in the store | `restartIce()` then a new offer through the same peer document; once the transport ends, a new peer document (a new `call`) with the same token hash every few seconds for five minutes (the host answers a camera it lists as reconnecting), then the page says the host is gone |
| The channel closes in the middle of a file | the receiver keeps the bytes held in the page's memory; the attempt waits for the clip (`ClipsInFlight`) until 120 s after its end | the sender's promise rejects with `closed`; the clip stays staged and is offered again, first thing, over the next connection: the file goes on from the receiver's offset |
| A chunk is corrupted (a bit flipped, a misplaced chunk) | the checksum at `file-done` does not match: `file-resume` from 0 | the file goes again, twice at most, then `file-abort`: the clip stays on the phone and is offered again over the next connection; past the wait, the attempt's notes say it is missing |
| The phone never answers a cut (asleep, its page frozen, its capture stopped) | 120 s after the attempt's end, the attempt goes to the upload queue without the clip and the session's notes say `remote clip missing: … from <label>: …` (`remote.clip.missing`); a clip that comes later is attached, noted late and uploaded as an addition | a cut it could not save is answered `cut-failed`, which the host gives up at once |
| The clock sync never converges (Wi-Fi power saving, a busy network) | the cuts and the conversions go with the estimate there is (§9), the window widened by its margin; the records say `converged` false; `rtc.clock` says every minute how the link behaves (`syncing`, the window's round trips, T4.2b) | nothing to do |
| The host page reloads, or another host page pairs the phone | the clips expected are not given up (no note): the attempt is uploaded without them; the phone, paired again with a new code, offers them first, and the host takes those of attempts it has, as additions | the staged clips are kept, and offered to the next connection to the same session; another session's join deletes them |
| The receiver cannot store a file (no room) | `file-abort` with the reason; the failure reported | the send rejects with `aborted`; the clip stays on the phone |
| The clocks disagree (the phone slept, its clock stopped) | the first sample after is farther from the estimate than its round trip allows: `converged` is withdrawn at once, the state says syncing, and comes back once the window turned over (two minutes) | nothing to do; the host converts with the fit it has |
| A busy network (round trips of tens of ms, scattered) | the offset stays within a few ms, the sync is not called converged; T4.1 shows the round trip and the spread | nothing to do |
| A frame that is not a message (a bug, another app on the channel) | `MessageLink.onError` reports it; the frame is dropped, the connection kept | the same |
| The phone cannot measure during a sync check (it stopped recording, its frames cannot be read) | the check ends as failed with the phone's words (`sync-error`), Retry measures the phone again; nothing is kept | `sync-error`, and it stops measuring |
| The phone goes during a sync check (Leave, its connection ends) | the check ends as failed (`the phone's connection ended`); the lag the session has stays | the measuring stops with the connection |
| The live preview does not flow (the setting off, the phone's camera off or changing, a busy network) | the remote track is muted: the tile shows the latest thumbnail, every 2 s, until frames come again | sends nothing, or the camera's new track once it has one |
| The phone leaves (Leave, the tab closed) | `leave` over the channel when there was time: the camera goes from the list at once (its entry stays in the session), the transport closed and the peer document deleted with its candidates; the clips it has not sent are given up at once (the notes say they are missing), and still taken if it pairs again and offers them | Leave sends `leave` and closes the connection 250 ms later, once the word is out; a page that goes (`pagehide`) sends it and leaves the connection to the browser |
| The host removes the camera or ends the session | `leave`, the connection closed 250 ms later, the peer document deleted with its candidates; the clips the phone has not sent are given up (the notes say so); at the session's end (New session), a camera with clips of the session still to come is kept until they are stored, refused or given up, 15 s at most, listed as waiting for its last clips (T4.2b), then let go the same way (what is still to come then is noted missing); a host page that goes (`pagehide`) sends `leave` and deletes the documents, as far as there is time | the page says the host let it go, with the reason; without the word (the host's page died), `onClosed('the documents are gone')` ends the transport and the phone calls again for five minutes, then says the host is gone |

## 8. The lifecycle (T4.1)

How the host's Cameras section (`apps/web/src/app/camera/remote-cameras-service.ts`) and the phone's
Camera page (`apps/web/src/app/camera-device/camera-device-service.ts`) run the connection
(`docs/ARCHITECTURE.md`, "Remote cameras", has the pieces; `docs/PLAN.md` T4.1 the contract):

1. **Add camera.** With the account signed in and a session under way, the host makes sure the
   session's document is in the index (`SessionIndexService.indexForPairing`: a demo session's
   document goes too, this once, so that the pairing has a document to live in; its attempts never),
   generates a token, publishes its hash (`publishPairing`, 10 minutes) and shows the QR code (the
   URL of §5, drawn by `qr-code.ts`), the URL and the token; it watches the session's offers from
   then on. A second Add camera replaces the pairing; Cancel, the expiry and the session's end close
   it. The whole section, `@cubetrace/rtc` with it, is a lazy chunk that loads at the first Add
   camera: a session without remote cameras downloads none of it.
2. **The phone.** The Camera page (`/camera`) takes the code from the URL, or typed (a token alone
   names no session: the newest of the account's sessions whose `pairing` holds its hash is the one).
   Signed out, it keeps the code and shows Sign in. It turns the camera on (the rear one by default:
   the camera device has a choice of its own in Settings, apart from the Timer page's), runs the
   capture pipeline from then on (the ring buffer, so that T4.2's first cut has its margin), checks
   the pairing, calls (`call`, `WebRtcTransport.connect` as the caller) and sends `hello` with its
   camera as its own session.json would describe it (`local: true`; the host relabels it). Since
   T4.3 its transport carries the live preview's transceiver (§2), and the host says whether it wants
   the picture (`preview`) as soon as the hellos are exchanged.
3. **The answer.** The host answers the first peer whose `tokenHash` is the pairing's, before it
   expires, and closes the pairing: the token is taken once, and stays the phone's for the pairing's
   ten minutes (`PAIRING_TTL_MS`, T4.2b): until it connects, the camera is listed as connecting and a
   call that presents the token again is answered, as a reconnecting camera's is. Anything else that
   offers (a wrong or a stale token) has its documents deleted, which ends the phone's call at once
   rather than after 30 s. The phone sends its `hello` as its channel opens, and the host answers it
   with its own; each waits 15 s for the other's (10 s until T4.2b), or until the connection closes
   first: another protocol version is sent away (`leave` with the reason, `rtc.failed`), and no hello
   is a failed call (`rtc.failed`). The host spoke first until T4.2b, the moment its channel opened,
   and that hello now and then never reached the phone's page, while the host's frames after it did
   (7 of about 115 hello exchanges in the end-to-end runs while T4.2b was tested, and most likely PR
   #62's first CI run): it had gone out before the phone's page had its own channel open, as far as
   the clocks tell, by some milliseconds; the phone says hello only once its channel is open, so the
   host's answer finds it open. A first call that fails (the connection not made, the other side's
   hello not come) is made again by the phone, with the same token, every 3 s until the pairing's ten
   minutes from its check are up, the page saying joining and why meanwhile (T4.2b: one missed
   deadline was the end of the pairing before); a code the check refuses (wrong, expired, taken) is
   still refused at once.
4. **Connected.** The host puts the camera into the session (`SessionService.putCamera`:
   `local: false`, `remote: {label, platform}` from the phone's hello, the label the session gives
   the device, `phone-rear` or `phone-rear-2`, two phones told apart by their host labels), pings
   (`ClockPinger`, one `RemoteClockFit` per phone, kept across its reconnections: every 500 ms until
   the fit converges, then every 2 s, §4) and sends `clock` after each answer; when the fit
   converges, and every minute after, the fit's record goes into `clock.cameras[label].remote` (the
   clapperboard fields stay at 0 until a sync check of the camera measures its lag, §10, which the
   later records keep), and every minute of the connection,
   converged or not, the sync goes into the diagnostics (`rtc.clock`, with the window's round trips
   since T4.2b). The phone answers the pings, sends `state` and a `thumbnail` (a JPEG of at most 320
   px from its preview) every 2 s, and `hello` again when its camera changes (another camera, the
   framing). The host's list shows the name, the label, the state, the sync, the latest report and
   the picture; the phone shows the host, the state, the clock as reported, the battery and a
   thermal hint (the frame rate under 80% of the camera's nominal), and holds the wake lock.
5. **A drop.** The transport restarts ICE by itself (§2). Once it ends without a `leave`, the host
   lists the camera as reconnecting for five minutes and answers a call that presents its token again
   (only while reconnecting: a second phone shown the same code cannot take a connected camera's
   place); the phone calls again every 3 s (each call fails after 30 s without an answer) until it is
   back or five minutes passed, then says the host is gone. A host page that reloads publishes
   nothing by itself: the owner adds the camera again, with a new code.
6. **Leaving.** Leave on the phone, Remove on the host and the session's end send `leave` and close
   the connection 250 ms later, once the word is out (`RTCPeerConnection.close` drops what the channel
   still holds); the host deletes the peer document with its candidates whenever its transport closes
   (`Signaling.close`), and a phone that left goes from the list at once, its entry kept in the
   session (the session records what filmed it). At the session's end (New session, the session
   deleted), a camera connected with clips of the session still to come (asked for, or on their way)
   stays (T4.2b, follow-up (l) of `docs/PLAN.md`: New session right after a solve let the phone go
   before its last clips came): the list says `waiting for the phone's last clips (n)`, the host asks
   it for nothing of the next session and brings its clips into the ended session's attempts, and
   says `leave` once they are stored, refused or given up (a turn after the last clip's
   acknowledgement), or when 15 s are up (`FINISH_WAIT_MS`: the phone's clip is ready about a second
   after its window's end, and a transfer took 1.8 s at the median and 8 s at most on the owner's
   Wi-Fi), which gives up the rest with a note; Remove, the phone's Leave or its connection ending
   let it go at once. The next session's pairing is published as ever. `pagehide` on either side
   sends `leave` and leaves the connection to the browser (the host deletes the documents too, as far
   as there is time).
7. **Diagnostics** (`docs/DIAGNOSTICS.md`): `rtc.paired`, `rtc.connected`, `rtc.disconnected`,
   `rtc.clock` and `rtc.failed`, on both devices.

## 9. The clips (T4.2)

How the host's `RemoteCutsService` (`apps/web/src/app/camera/remote-cuts-service.ts`) and the phone's
`CameraDeviceClips` (`apps/web/src/app/camera-device/camera-device-clips.ts`) bring each attempt's
clips from the phone into the host's attempt folder (`docs/PLAN.md` T4.2 has the contract):

1. **The cut.** The host cuts its own camera at the attempt's milestones (`RecordingService`): the
   scramble's clip once the attempt is armed, the solve's once it ended, nothing of an attempt that
   went without a record. At the same moments, with the same windows (`clip-windows.ts`), it asks each
   camera of the Cameras section for its clip (`cut`, once per label: the label is the files' first
   name), and holds the attempt back from the upload queue for each clip expected (`ClipsInFlight`).
   A camera reconnecting gets its cuts when it is back. With "Record remote cameras" off (Camera
   settings → Cameras; on by default) nothing is asked.
2. **The window in the phone's clock.** The host converts the window with the camera's clock
   estimate (`remote-estimate.ts`), converged or not: the fit's own (the kept samples' median offset,
   and the drift once they span a minute) from 3 kept samples (`ESTIMATE_MIN_SAMPLES`), the offset of
   the window's least-round-trip sample before; a cut waits for the clock sync's first answer (at
   most 10 s: a phone paired again starts a new fit), never for convergence, which a busy Wi-Fi may
   never give (the first pairing on real hardware never converged on the owner's home Wi-Fi, and
   T4.2b revisited the criterion, §4). The window is widened on each side by the estimate's margin, the
   95th percentile of the kept round trips plus that of the residuals, and 500 ms at least
   (`CUT_MARGIN_MS`: half a round trip is the most a symmetric path's offset is off by, and the
   Wi-Fi's power-saving bursts of 100 to 300 ms are covered several times over, for about a second
   more video per clip, half a megabyte at 4 Mbps); the host trims nothing. The first cut of a camera
   writes the estimate it relied on into `clock.cameras[label].remote` with `converged: false` when
   there is no record there yet; the fit's convergence overwrites it as T4.1 writes it. A cut sent
   is sent again as it was (the same window) over a new connection while the phone has not answered.
3. **The phone's clip.** The phone cuts once the window's end is in its buffer, and the encoder had
   its 250 ms, through the capture's clip worker, into `camera-clips/sessions/<sessionId>/attempts/<index>/`
   of its origin private file system, apart from its own sessions (`SaveClipParams.staging`): the
   MP4 and the frames file (`phone-rear.solve.mp4`, `phone-rear.solve.frames.json`, its times on the
   phone's clock), with `camera-clips/index.json`, the clips staged, written whole in one step as the
   records are. A cut asked again is cut once; one of the same attempt and segment with another
   `scrambleShown` (the attempt begun again) replaces the older clip. A cut the capture cannot save
   is answered `cut-failed`, and the host gives the clip up at once.
4. **The files.** The phone offers each staged clip (`cut-done`, with what the capture said of it)
   and sends its frames file, then its MP4 (`FileSender`). The host takes them into memory
   (`FileReceiver`; a file cut in the middle goes on from the bytes held over the next connection of
   the same page), checks the frames file (`parseFrames`) and writes it into the attempt's folder with
   its times on the host clock (`remoteFrames`: `t0RemoteMs` the phone's first frame time, `t0HostMs`
   that time through the estimate the cut was sent with, at the clip's own time since T4.3 (§4), the
   estimate itself in `remote`, with `converged` and when it was taken), then the MP4; the clip goes
   into the attempt's record (`attachClip`: `firstFrameHostMs` the converted time; `syncResidualMs`
   the camera's lag once a sync check of it measured one in the session, §10, none before) and the
   host says so (`clip-ack`, `stored`). A clip the host does not take (its
   attempt deleted or dropped, its frames file unreadable) is answered `stored: false` with why;
   either way the phone deletes its copy.
5. **The wait.** The host waits for an attempt's remote clips until 120 s after its end
   (`REMOTE_CLIP_WAIT_MS`): then the attempt goes to the upload queue without them, and the session's
   notes name the camera (`remote clip missing: solve of attempt 7 from phone-rear: no clip within
   120 s of the attempt's end`). A clip the phone could not cut, or of a phone that left or was let
   go (Leave, Remove, five minutes away), is given up at once; at the session's end, the phone is let
   go once its clips of the session are in, or after 15 s (§8, T4.2b), and those still to come then
   are given up. A clip given up that comes later is still attached and noted (`remote clip late:
   …`), and uploaded as an addition: the upload queue signs only the files not uploaded yet, with
   `attempt.json` again. Each camera's clips are its session's: those that come after the session
   ended go into its attempts (`SessionService.attachClip` takes an attempt of a session that is no
   longer the current one).
6. **Kept until the host's word.** The phone keeps a staged clip until its `clip-ack`, and offers the
   clips staged for the session first, the oldest first, over each connection: a reconnection, the
   Camera page loaded again, the phone paired again with a new code (a host page loaded again takes
   the clips of attempts it has, as additions). When the phone joins a session, the clips staged for
   other sessions are deleted, and when the Camera page opens, those staged more than a day ago
   (`STAGED_MAX_AGE_MS`): a phone keeps no clip that no host will ask for. The page says how many
   clips wait, and `state.pendingClips` tells the host.
7. **Diagnostics** (`docs/DIAGNOSTICS.md`): `remote.cut` (sent, done, failed), `remote.clip` (the
   bytes, the transfer's time and throughput, the bytes resumed), `remote.clip.late`,
   `remote.clip.missing`; the QA view counts the clips by camera label.

## 10. The sync check of a remote camera and the live preview (T4.3)

How the host's `SyncService` (`apps/web/src/app/camera/sync-service.ts`) measures a phone's camera
against the cube, and how the phone's live picture reaches the Timer page (`docs/PLAN.md` T4.3 has
the contract):

1. **Starting it.** Each phone of the Cameras section with a camera has a line of its own under the
   Timer page's preview (`Sync: phone-rear has no check in this session`, or its lag, with "Sync
   check"). It can start once the phone is connected to the session under way, its clock sync has
   had an answer (its frames can be placed on the host clock) and it records, wherever the attempt
   lets a check start (no scramble begun, no solve); the line says why not otherwise. The check is the
   one of the host's own camera (T2.5, T2.8, T2.11: hold still, the countdown, a face flicked and
   flicked back five times, the timer tracking no attempt meanwhile), the panel naming the phone's
   label. While the phone's framing rectangle, as its `state` reports it, is the whole frame or most
   of it, the panel asks for a rectangle drawn on the phone first (its Camera page), with Start
   anyway. A phone's check is never due by itself (the host's own camera's is, once it records, and
   two in a row would ask too much of the solver); its line says the phone has none.
2. **Who measures, who matches.** The host sends `sync-start`. The phone (`CameraDeviceSync`) asks
   its capture worker to measure each frame's motion inside its framing rectangle
   (`CameraDeviceCapture.watchMotion`: the meter of the host's own check, `motion.ts` of
   `@cubetrace/capture`, the changed area of the frame's luma downscaled to 160 pixels wide, 320 for
   a wide rectangle), and sends the measures every 250 ms (`sync-motion`) with how the worker reads
   the frames (`sync-meter`), until `sync-stop`, the connection's end or five minutes. The host
   (`RemoteCamerasService.watchMotion`) puts each frame's arrival and reception on its own clock with
   the clock estimate of the moment its batch came (§4), keeps the frame's own timestamp, and hands it
   to the same `SyncRun` as its own camera's frames: `detectClapperboard` places each frame by its
   timestamp and the median arrival offset, and matches the motion against the cube's turns, which
   never leave the host clock. One code path for every camera, so the same result, the same
   diagnostics and the same check data to download; the phone holds no copy of the matching, and
   sends about six numbers a frame (a few kB a second). A phone that cannot measure says
   `sync-error`, which ends the check as failed with its words; so do its leaving and its
   connection's end, and a recording that stops during the check (the camera off or changed). The
   Timer page reaches the phones through `RemoteCameraRegistry`, which the Cameras section's service
   fills: neither the check nor the preview area loads the `rtc` chunk.
3. **What it measures, and where it goes.** The lag of the phone's frames behind the cube on the host
   clock, once their times are converted: the camera's own latency and the phone's delivery of the
   frame to its capture worker, as a local camera's lag is, plus what the clock estimate is off by
   during the check (a few ms on a converged fit), so measured on top of the clock sync rather than
   added to it (`docs/DATA-MODEL.md` §6). It goes into `clock.cameras[label]` beside the clock sync's
   record (`remote`: the record there, or, when there is none yet, the clock estimate at the check's
   end; `rttMs` and `driftPpm` repeat it), which the clock sync's later records keep, and
   the phone's later clips take it as their `syncResidualMs` (`withSyncResidual`), as T2.8 gives a
   local camera's clips theirs. The end-to-end pair (two pages of one browser, a synthetic camera
   whose square flips 120 ms after each of the demo cube's turns, the phone's clock 5 s ahead) finds
   126 and 135 ms: the frame that first shows a flip comes with the canvas's next capture, up to a
   frame later, and reaches the worker a few ms after.
4. **The live preview.** The phone's connection carries the preview's transceiver (§2). As soon as
   the hellos are exchanged, and whenever the setting changes, the host says whether it wants the
   picture (`preview`, "Live preview from phones" in Camera settings → Cameras, on by default). The
   phone (`CameraDevicePreview`) then sends its camera's track, the one its recording reads (the
   preview's encoder scales it down; the recording is not touched), another camera's track replacing
   it as the camera changes, and stops when the host says off, the camera goes off or the connection
   ends. The host (`RemoteCamerasService`) takes the track into the camera's entry, and the Timer
   page's `RemotePreviews`, deferred inside the preview until a phone with a camera is listed, shows
   each phone's picture as a tile in the top right corner of the host's preview: its live video while
   the track flows (unmuted), its latest thumbnail otherwise, its framing rectangle over it. A tap
   swaps a tile with the main picture, a tap on this device's tile swaps back, and without a camera of
   the host's own the first phone's picture is the main one (issue #60: the thumbnail at the bottom of
   Camera settings was too far from the preview to keep the cube in the phone's frame). The Cameras
   list keeps its thumbnail every 2 s, the pairing's state.
5. **What the preview costs the phone.** Each start says, in `preview.started`, how the recording
   went over the span before it (without the preview: its frame rate measured, the least of its
   seconds, the frames encoded a second and those dropped), and each stop, in `preview.stopped`, how
   the preview's encoder went (its frames, frame rate, bitrate, time per frame, implementation, the
   size it sent, why it held the quality back and the share of time the CPU did) and the recording
   over the same span (with the preview). The owner's measurement on the ThinkPhone
   (`docs/MANUAL-TESTS.md`, "After T4.3") switches the setting off and on in turns while recording,
   and compares the spans. In the end-to-end pair (a still 640 × 360 canvas): 128 × 72 at 15 fps,
   4 kbps, 0.36 ms of `libvpx` per frame, the recording at 30.2 fps meanwhile.
6. **Diagnostics** (`docs/DIAGNOSTICS.md`): `sync.check` with `remote: true`, the phone's `peer` and
   the clock sync that placed its frames (`clockConverged`, `clockOffsetMs`, `clockRttMs`,
   `clockSamples`); `preview.started` and `preview.stopped` on the phone.
