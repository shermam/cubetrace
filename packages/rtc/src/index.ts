// Public API of @cubetrace/rtc: the connection between the host and a remote camera (docs/RTC.md,
// docs/PLAN.md T4.0). Plain TypeScript: no Angular, and no browser global is touched at import time;
// only WebRtcTransport (webrtc.ts) uses the browser's WebRTC API, when it is made.

// The data channel's protocol: the messages and their wire form.
export type {
  CameraState,
  ClipAck,
  Clock,
  ControlMessage,
  Cut,
  CutClip,
  CutDone,
  CutFailed,
  DeviceInfo,
  DeviceRole,
  FileAbort,
  FileAck,
  FileBegin,
  FileChunk,
  FileDone,
  FileInfo,
  FileKind,
  FileResume,
  Hello,
  Leave,
  Message,
  Ping,
  Pong,
  ThermalHint,
  Thumbnail,
  WireFrame,
} from './protocol';
export {
  CHUNK_HEADER_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  THUMBNAIL_HEADER_BYTES,
  decode,
  encode,
} from './protocol';
export { Crc32, crc32 } from './crc32';

// The transport: the interface over a data channel, the pair in memory, the real one over WebRTC.
export type {
  MemoryLinkOptions,
  MemoryTransportStats,
  Timers,
  Transport,
  TransportState,
} from './transport';
export { MemoryTransport, REAL_TIMERS } from './transport';
export { MessageLink } from './link';
export type { WebRtcTransportOptions } from './webrtc';
export { CONNECT_TIMEOUT_MS, DATA_CHANNEL_LABEL, STUN_SERVERS, WebRtcTransport } from './webrtc';

// The file transfer: the paced sender, the assembling receiver, the stores.
export type {
  FileDescription,
  FileReceiverOptions,
  FileSenderOptions,
  FileSource,
  IncomingFile,
  IncomingFiles,
  ReceivedFile,
  SendProgress,
  SendResult,
  TransferFailure,
} from './transfer';
export {
  ACK_EVERY_BYTES,
  BUFFERED_AMOUNT_LOW_THRESHOLD,
  CHUNK_BYTES,
  FileReceiver,
  FileSender,
  MAX_CHECKSUM_RETRIES,
  MemoryIncomingFiles,
  SMALL_CHUNK_BYTES,
  TransferError,
  blobSource,
  bytesSource,
} from './transfer';

// The clock sync's plumbing (the maths is core's RemoteClockFit).
export { ClockPinger, PING_INTERVAL_MS, answerPings } from './clock-sync';

// The pairing token.
export type { PairingInput, PairingRefusal } from './pairing';
export {
  CAMERA_PATH,
  PAIRING_TTL_MS,
  TOKEN_ALPHABET,
  TOKEN_LENGTH,
  checkPairing,
  generateToken,
  hashToken,
  isTokenHash,
  normalizeToken,
  pairingOf,
  pairingUrl,
  parsePairingInput,
} from './pairing';

// The signaling over Firestore, and in memory.
export type {
  IceCandidate,
  IncomingOffer,
  PairingCheck,
  Signaling,
  SignalingBackend,
  SignalingDocument,
  SignalingRole,
} from './signaling';
export { FirestoreSignaling, MemorySignaling, MemorySignalingBackend } from './signaling';

// Fakes for the tests of this package and of the app's services.
export { FakeTimers } from './testing';
