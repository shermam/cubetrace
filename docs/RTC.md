# Remote cameras: the connection between the host and a phone

Phase 4 (`docs/PLAN.md`, the phase 4 board) lets a phone join a session as a camera: it films from
another angle, records its own camera at full quality into its own ring buffer, and hands the host the
clips of each attempt, all on the host clock. This document is the contract of that connection, as
T4.0 built it in `packages/rtc` (the code), `packages/core` (the clock maths, the records' fields,
the documents' shapes) and `firebase/firestore.rules` (the signaling's rules): the messages of the
data channel, the file transfer, the clock sync, the signaling and the pairing token, and what each
side does when something fails. The pages that use it came with T4.1 (§8 below: the lifecycle as the host's Cameras section and
the phone's Camera page run it); the cuts and the transfer come with T4.2, the sync check and the
live preview with T4.3. `docs/ARCHITECTURE.md` ("Remote cameras") places it in the app.

**Stream for control, record locally for data.** One `RTCPeerConnection` between the two devices,
made with Google's public STUN server (`stun:stun.l.google.com:19302`) and no TURN relay: on one Wi-Fi
the two connect directly, on a network with client isolation (a guest or office network) they do
not, and the office rig stays the laptop's own webcam. One reliable, ordered data channel
(`cubetrace`, `ordered: true`, no retransmit limit) carries everything of this document: the clock
pings, the camera's state and thumbnails, the cut commands, and the clip files themselves, as bytes.
A low-bitrate video track for the live preview comes with T4.3 and is never data. Nothing is
transcoded on the host.

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
| `hello` | both | `v` (1), `role` (`host`, `camera`), `device: {label, platform}`, `app: {version, commit}`, `camera` (the phone's camera as its own session.json would describe it: a `CameraInfo`, read by core's `parseCameraInfo`; null from the host) | once the channel opens; the phone again when its camera changes |
| `ping` | host | `t1`, the host clock | every 2 s (`PING_INTERVAL_MS`) |
| `pong` | phone | `t1` back, `t2` (when the ping came) and `t3` (when the answer goes), on the phone's clock | at once, for each ping |
| `clock` | host | `converged`, `offsetMs` (the phone's clock minus the host's), `rttMs` (the least round trip kept): the sync as the host measures it, for the phone to show (T4.1; additive within version 1) | after each answer it took |
| `state` | phone | `remoteMs`, `recording`, `framing` (the rectangle or null), `frame: {width, height}`, `fps`, `sharpness`, `battery: {level, charging}`, `thermal` (`ok`, `throttled`, null), `pendingClips`; each nullable field null when unknown | every 2 s, and at each change the host should see at once |
| `thumbnail` | phone | `remoteMs`, `width`, `height`, `jpeg` (a JPEG of at most 320 px on its longer side) | every 2 s (binary) |
| `cut` | host | `attempt`, `segment` (`scramble`, `solve`), `fromRemoteMs`, `toRemoteMs` (the window, in the phone's clock, converted by the host with the clock fit), `reason` (the timer's milestone: `armed`, `ended`) | when the host cuts its own camera |
| `cut-done` | phone | `attempt`, `segment`, `files: [{name, bytes, kind}]` | the segment's files are muxed and staged |
| `cut-failed` | phone | `attempt`, `segment`, `reason` | the window was older than the buffer, an encoder error |
| `file-begin` | sender | `id` (this connection's number for the file), `name`, `bytes`, `kind` (`mp4`, `frames`), `attempt`, `segment` (null for a file of neither) | a file starts, or starts again after a reconnection |
| `file-resume` | receiver | `id`, `offset` | the answer to `file-begin` (the bytes it already holds: 0 for a new file), and to a `file-done` whose checksum did not match (0: again from the start) |
| `file-chunk` | sender | `id`, `offset`, `bytes` (binary: a 13-byte header, the kind `0x01`, the id as 4 bytes, the offset as 8 bytes, big-endian, then the bytes) | every chunk |
| `file-ack` | receiver | `id`, `offset` (the highest offset up to which every byte is held), `done` | every 1 MB (`ACK_EVERY_BYTES`), and once with `done: true` when the file is complete and checked |
| `file-done` | sender | `id`, `crc32` (of the whole file) | after the last chunk |
| `file-abort` | either | `id`, `reason` | the sender gives the file up (the checksum refused three times), or the receiver cannot take it (no room, a chunk that does not fit) |
| `leave` | either | `reason` | the phone's Leave, the host's Remove, a protocol version that does not match |

The thumbnail's binary frame is a 13-byte header too: the kind `0x02`, the time as a float64, the
width and the height as 2 bytes each, then the JPEG. `MessageLink` wraps a transport, decodes each
frame and hands the message to the handlers of its type (`link.on('pong', …)`), reports a frame that
is not a message (`onError`) and drops it, and sends messages encoded (`link.send`, or `trySend`,
which does nothing on a closed transport).

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
the frames file first (T4.2 decides the order; the transfer takes any). The numbers: chunks of 64 KB
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
(`MemoryIncomingFiles` in the tests; T4.2's keeps them in the origin private file system): on
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
acknowledged, so this happens only when the acknowledgement itself was lost with the connection.

## 4. The clock sync (`packages/core/src/remote-clock.ts`, `packages/rtc/src/clock-sync.ts`)

The dataset stays on the host clock. The phone keeps its own (`performance.timeOrigin +
performance.now()`), and the host measures the offset between the two over the data channel, as NTP
does: the host sends `ping {t1}`; the phone answers `pong {t1, t2, t3}`, `t2` when the ping came and
`t3` when the answer leaves, on its clock; the host receives it at `t4`. Each round trip is a sample:

```
offset = ((t2 − t1) + (t3 − t4)) / 2      the phone's clock minus the host's, the legs taken symmetric
rtt    = (t4 − t1) − (t3 − t2)            the round trip, without the phone's time to answer
```

`RemoteClockFit` keeps the last 60 samples (`REMOTE_CLOCK_WINDOW`). Of them, the samples whose round
trip is within 1.5× the least of the window (`REMOTE_CLOCK_RTT_FACTOR`), or 3 ms over it when that
is more (`REMOTE_CLOCK_RTT_ALLOWANCE_MS`, T4.1), are the estimate's: a longer trip had more room
for an asymmetry between the two legs, which the offset cannot see. The allowance is for the links
whose least trip is a millisecond (two pages of one browser, an Ethernet cable): 1.5× it would keep
only the samples that met no work at all on either main thread (4 of 31 in a minute, measured in
the end-to-end suite between two pages encoding video), while a trip 3 ms over the least is off by
1.5 ms at most, under what the factor already admits from a 6 ms trip up; on a Wi-Fi of 5 ms and
more nothing changes. The offset is
the median of their offsets. Once the kept samples span more than 60 s (`REMOTE_CLOCK_DRIFT_SPAN_MS`),
a least-squares line `offset(t) = a + b·(t − t₀)` through them (host times counted from their mean,
so that wall-clock values lose no precision) gives the drift, `driftPpm = b · 10⁶` (50 ppm is 3 ms a
minute). `toHostMs(remoteMs)` and `toRemoteMs(hostMs)` use the line when there is one and the median
before; they are exact inverses. `converged` (`REMOTE_CLOCK_CONVERGED`) is true when at least 10 kept
samples span 10 s or more and their residuals from the estimate spread by less than 3 ms between the
10th and the 90th percentile; it is withdrawn when the window's samples no longer agree (the network
got busy, the phone slept and its clock stopped) and comes back once the window has turned over. The
record for `clock.cameras[label].remote` (`params`) is `{offsetMs, driftPpm, rttMs (the least round
trip), samples (the kept ones), residualP95Ms, since (the host time of the oldest kept sample)}`.

The simulations in `remote-clock.test.ts` (a phone clock with an offset and a drift; a network with a
base round trip and an exponential jitter on each leg, as queues give): the offset within 1 ms of the
truth at round trips of 5, 20 and 40 ms with 1, 2 and 3 ms of jitter, converged; a drift of 37, −80
and 0 ppm fitted to 0.8 ppm over a simulated hour, with the conversions within 1 ms thirty seconds
before and after the newest sample; on a busy network (40 ms, 30 ms of jitter) the offset stays within
2 ms but the sync is not called converged. The convergence rule wants the kept trips to agree within
about 3 ms, which a phone awake on a quiet Wi-Fi gives and a phone in Wi-Fi power saving (round trips
of 100 ms and more between bursts) does not: T4.3 measures this on the ThinkPhone.

`ClockPinger` (the host) pings every 2 s and adds each answer to the fit, ignoring an answer to a ping
it did not send (an old one after a reconnection) and a sample whose clocks ran backwards;
`answerPings` (the phone) answers. T4.1's `RemoteCamerasService` owns one pinger per phone, keeps the
fit across the phone's reconnections, sends `clock` back after each answer, and writes the fit's
record into the session when it converges and every minute after (§8).

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
the data channel opens on both sides ─▶ hello ─▶ pings, state, thumbnails …
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
`local` may be false, and then `remote: {label, platform}` names the device it runs on (its host label
and platform, as its own records have them); a camera clock may carry `remote`, the clock fit's
record above, beside the clapperboard's result (`rttMs` and `driftPpm` repeat the fit's). The host
gives a remote camera its label with `labelFor`, as any camera (`phone-rear`, a second phone
`phone-2-rear`); its clips are `video[]` entries like any other, named after it. In Firestore the
session's document gains `pairing`, the peer documents and their candidates get schemas of their own
(`cloud-peer.schema.json`, `cloud-candidate.schema.json`) and readers (`parseCloudPeer`,
`parseCloudCandidate`, `parseSessionPairing`), and the rules open all of it to the session's owner
alone.

## 7. Failure modes

| What happens | The host | The phone |
|---|---|---|
| The token is wrong, expired or already taken | `watchOffers` gives a peer whose `tokenHash` is not the pairing's (nor a reconnecting camera's): the host deletes its documents and shows nothing | `checkPairing` said so before any document was written; the page says to ask for a new code; a call the host never answers fails after 30 s |
| Another version of the app on the phone | `hello.v` differs: `leave` with the reason, the connection closed, the camera not registered | the same; the page says to update |
| The peer connection fails (the Wi-Fi dropped, the phone changed networks) | the transport reports `failed` or `closed`; the camera's entry says reconnecting for five minutes, during which a call with its token is answered again; then it goes; the clips in flight wait in the store | `restartIce()` then a new offer through the same peer document; once the transport ends, a new peer document (a new `call`) with the same token hash every few seconds for five minutes (the host answers a camera it lists as reconnecting), then the page says the host is gone |
| The channel closes in the middle of a file | the receiver keeps the bytes held in its store; the attempt waits (`ClipsInFlight`, 120 s) | the sender's promise rejects with `closed`; the file is kept and sent again over the next connection, from the receiver's offset |
| A chunk is corrupted (a bit flipped, a misplaced chunk) | the checksum at `file-done` does not match: `file-resume` from 0 | the file goes again, twice at most, then `file-abort`: the clip stays on the phone, the attempt's notes say it is missing |
| The receiver cannot store a file (no room) | `file-abort` with the reason; the failure reported | the send rejects with `aborted`; the clip stays on the phone |
| The clocks disagree (the phone slept, its clock stopped) | the new samples disagree with the window's: `converged` is withdrawn, the state says syncing, and comes back once the window turned over (two minutes at 2 s) | nothing to do; the host converts with the fit it has |
| A busy network (round trips of tens of ms, scattered) | the offset stays within a few ms, the sync is not called converged; T4.1 shows the round trip and the spread | nothing to do |
| A frame that is not a message (a bug, another app on the channel) | `MessageLink.onError` reports it; the frame is dropped, the connection kept | the same |
| The phone leaves (Leave, the tab closed) | `leave` over the channel when there was time: the camera goes from the list at once (its entry stays in the session), the transport closed and the peer document deleted with its candidates; the pending clips of the attempt are missing | Leave sends `leave` and closes the connection 250 ms later, once the word is out; a page that goes (`pagehide`) sends it and leaves the connection to the browser |
| The host removes the camera or ends the session | `leave`, the connection closed 250 ms later, the peer document deleted with its candidates; a host page that goes (`pagehide`) sends `leave` and deletes the documents, as far as there is time | the page says the host let it go, with the reason; without the word (the host's page died), `onClosed('the documents are gone')` ends the transport and the phone calls again for five minutes, then says the host is gone |

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
   camera as its own session.json would describe it (`local: true`; the host relabels it).
3. **The answer.** The host answers the first peer whose `tokenHash` is the pairing's, before it
   expires, and closes the pairing: the token is taken once. Anything else that offers (a wrong or a
   stale token) has its documents deleted, which ends the phone's call at once rather than after 30 s.
   The host sends its `hello` as the channel opens and waits 10 s for the phone's: another protocol
   version, or no hello, is sent away (`leave` with the reason, `rtc.failed`).
4. **Connected.** The host puts the camera into the session (`SessionService.putCamera`: `local:
   false`, `remote: {label, platform}` from the phone's hello, the label the session gives the device,
   `phone-rear` or `phone-rear-2`, two phones told apart by their host labels), pings every 2 s
   (`ClockPinger`, one `RemoteClockFit` per phone, kept across its reconnections) and sends `clock`
   after each answer; when the fit converges, and every minute after, the fit's record goes into
   `clock.cameras[label].remote` (the clapperboard fields stay at 0 until T4.3 measures the lag) and
   into the diagnostics (`rtc.clock`). The phone answers the pings, sends `state` and a `thumbnail`
   (a JPEG of at most 320 px from its preview) every 2 s, and `hello` again when its camera changes
   (another camera, the framing). The host's list shows the name, the label, the state, the sync, the
   latest report and the picture; the phone shows the host, the state, the clock as reported, the
   battery and a thermal hint (the frame rate under 80% of the camera's nominal), and holds the wake
   lock.
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
   session (the session records what filmed it). `pagehide` on either side sends `leave` and leaves
   the connection to the browser (the host deletes the documents too, as far as there is time).
7. **Diagnostics** (`docs/DIAGNOSTICS.md`): `rtc.paired`, `rtc.connected`, `rtc.disconnected`,
   `rtc.clock` and `rtc.failed`, on both devices.
