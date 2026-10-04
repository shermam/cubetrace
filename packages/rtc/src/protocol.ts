// The messages of the data channel between the host and a remote camera (docs/RTC.md, docs/PLAN.md
// T4.0), and their wire form. Control messages go as JSON text frames; the two bulky kinds, a file's
// chunk and a thumbnail, as binary frames with a small header. The protocol is versioned: each side
// says its version in `hello`, and a side that gets another version leaves. Within a version, a
// reader ignores the fields it does not know, so that a build that adds an optional field still
// talks to the build before it; what a message must carry is checked, and a frame that is not a
// message of this protocol is refused with a ProtocolError. Plain TypeScript: no browser API.
import {
  RecordError,
  parseCameraInfo,
  type AppBuild,
  type CameraInfo,
  type CropRect,
  type VideoSegment,
} from '@cubetrace/core';

/** The version of this protocol, which `hello` carries. */
export const PROTOCOL_VERSION = 1;

/** The two roles of the connection (docs/ARCHITECTURE.md, "Roles and devices"). */
export type DeviceRole = 'host' | 'camera';

/** The device at one end of the connection, as `hello` names it. */
export interface DeviceInfo {
  /** Its host label (Settings → This device). */
  label: string;
  /** Its platform, such as `Android` or `macOS`. */
  platform: string;
}

/**
 * The first message each side sends once the channel opens: the protocol's version, the role, the
 * device, the build, and, from the camera device, its camera as its own session.json would describe
 * it (the host relabels it and marks it remote). The camera device sends it again when its camera
 * changes.
 */
export interface Hello {
  type: 'hello';
  v: number;
  role: DeviceRole;
  device: DeviceInfo;
  app: AppBuild;
  /** The camera device's camera; null from the host, and before the phone has opened a camera. */
  camera: CameraInfo | null;
}

/** The host's ping, with its clock's time; the clock sync's `t1` (docs/RTC.md). */
export interface Ping {
  type: 'ping';
  t1: number;
}

/** The camera device's answer: the host's `t1`, and its own clock when it received and answered. */
export interface Pong {
  type: 'pong';
  t1: number;
  t2: number;
  t3: number;
}

/**
 * A thermal hint from the camera device: `throttled` when its frame rate fell below what the camera
 * promised for a while (the phone is hot), `ok` otherwise, null when it cannot tell.
 */
export type ThermalHint = 'ok' | 'throttled' | null;

/** The camera device's state, sent every 2 s and at each change the host should see at once. */
export interface CameraState {
  type: 'state';
  /** When it was taken, on the camera device's clock. */
  remoteMs: number;
  /** Whether the capture pipeline runs (the ring buffer fills). */
  recording: boolean;
  /** The framing rectangle, in the pixels of the frames as recorded; null for the whole frame. */
  framing: CropRect | null;
  /** The frames' size as recorded; null before the first frame. */
  frame: { width: number; height: number } | null;
  /** Frames per second over the last second; null before the first. */
  fps: number | null;
  /** The sharpness of the framing rectangle (`@cubetrace/capture`'s metric); null when not measured. */
  sharpness: number | null;
  /** The phone's battery, 0 to 1, and whether it charges; null when the browser does not say. */
  battery: { level: number; charging: boolean } | null;
  thermal: ThermalHint;
  /** Clips cut and staged on the phone that the host has not acknowledged yet. */
  pendingClips: number;
}

/**
 * The clock sync as the host sees it, sent back to the camera device after each answer it took
 * (T4.1): whether the fit has converged, the phone's clock minus the host's, and the least round
 * trip; the phone shows them, since only the host measures.
 */
export interface Clock {
  type: 'clock';
  converged: boolean;
  offsetMs: number;
  rttMs: number;
}

/** A small JPEG of the camera's picture, every 2 s, for the host's list (a binary frame). */
export interface Thumbnail {
  type: 'thumbnail';
  /** When the picture was taken, on the camera device's clock. */
  remoteMs: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

/**
 * The host asks for a clip: the window of one segment of an attempt, in the camera device's clock
 * (the host converts its own times with the clock fit), the milestone that decided it, and the label
 * the session gives the phone's camera, after which the clip's files are named (T4.2).
 */
export interface Cut {
  type: 'cut';
  attempt: number;
  /**
   * The attempt's `events.scrambleShown` on the host clock (T4.2), which tells it from an attempt
   * begun again with the same index (after Mark as solved, or Delete last); every answer about the
   * clip carries it back.
   */
  scrambleShown: number;
  segment: VideoSegment;
  fromRemoteMs: number;
  toRemoteMs: number;
  /** Why the window is what it is: the timer's milestone (`armed`, `ended`), as the recording names it. */
  reason: string;
  /** The camera's label in the host's session (`phone-rear`): the files are `<camera>.<segment>.*`. */
  camera: string;
}

/** The kinds of file a camera device sends: a clip's MP4 and its frames file. */
export type FileKind = 'mp4' | 'frames';

/** A file the camera device cut and staged, as `cut-done` lists them. */
export interface FileInfo {
  name: string;
  bytes: number;
  kind: FileKind;
}

/**
 * What the camera device's capture said of a clip it cut (T4.2), for the host's `video[]` entry
 * (docs/DATA-MODEL.md §7) and its notes: the codecs, the frames' size and count, the camera's frame
 * rate and framing, and how the clip falls short of the window asked for. Its times are in the frames
 * file, which the host converts.
 */
export interface CutClip {
  /** The video track's codec string (`avc1.640028`, `vp09.00.40.08`). */
  codec: string;
  /** The audio track's codec string (`mp4a.40.2`, `opus`), or null without one. */
  audio: string | null;
  /** Of the encoded frames. */
  width: number;
  height: number;
  /** The frame rate the phone's camera track reports. */
  fpsNominal: number;
  /** The frames in the clip. */
  frames: number;
  /** The phone's framing rectangle when it cut, in the pixels of its frames; null for the whole frame. */
  crop: CropRect | null;
  /** The clip begins later than asked: the window's start was older than the phone's buffer. */
  truncatedStart: boolean;
  /** How much later than asked it begins, in ms; 0 when it begins where asked. */
  lateMs: number;
  /** Seconds of video the phone's buffer held when it cut. */
  bufferSeconds: number;
  /** Why the clip has no sound although the phone records it; null when it has, or none is recorded. */
  audioMissing: string | null;
}

/**
 * The camera device cut and staged the segment's files, which it sends next (and offers again,
 * this first, over each connection until the host answers with `clip-ack`).
 */
export interface CutDone {
  type: 'cut-done';
  attempt: number;
  /** The cut's `scrambleShown`. */
  scrambleShown: number;
  segment: VideoSegment;
  files: FileInfo[];
  /** What the capture said of the clip (T4.2). */
  clip: CutClip;
}

/** The camera device could not cut the segment (the window is older than its buffer, an encoder error). */
export interface CutFailed {
  type: 'cut-failed';
  attempt: number;
  /** The cut's `scrambleShown`. */
  scrambleShown: number;
  segment: VideoSegment;
  reason: string;
}

/**
 * The sender begins a file (or begins it again after a reconnection): `id` names it in this
 * connection's chunk frames; `name`, `attempt` and `segment` say which file it is. The receiver
 * answers with `file-resume`, saying from which offset it wants the bytes.
 */
export interface FileBegin {
  type: 'file-begin';
  id: number;
  name: string;
  bytes: number;
  kind: FileKind;
  attempt: number | null;
  segment: VideoSegment | null;
}

/** A piece of a file: its bytes from `offset` (a binary frame). */
export interface FileChunk {
  type: 'file-chunk';
  id: number;
  offset: number;
  bytes: Uint8Array;
}

/**
 * The receiver's progress: the highest offset up to which it has every byte, and, after a
 * `file-done` whose length and checksum matched, `done`: the file is complete and kept.
 */
export interface FileAck {
  type: 'file-ack';
  id: number;
  offset: number;
  done: boolean;
}

/** The sender sent the last chunk: the CRC-32 of the whole file, for the receiver to check. */
export interface FileDone {
  type: 'file-done';
  id: number;
  crc32: number;
}

/**
 * The receiver asks for the file from `offset`: its answer to `file-begin` (0 for a file it has
 * nothing of, the bytes it holds for one begun again), and to a `file-done` whose checksum did not
 * match (0: again from the start).
 */
export interface FileResume {
  type: 'file-resume';
  id: number;
  offset: number;
}

/** Either side gives the file up: the receiver drops what it holds, the sender keeps its copy. */
export interface FileAbort {
  type: 'file-abort';
  id: number;
  reason: string;
}

/**
 * The host's word on a clip the camera device sent (T4.2): `stored` when its files are in the
 * attempt's folder and the clip in the attempt's record; not, with why, when the host will not take
 * it (the attempt is gone, its frames file could not be read). Either way the camera device deletes
 * its copy; until it hears this, it keeps the clip and offers it again over the next connection.
 */
export interface ClipAck {
  type: 'clip-ack';
  attempt: number;
  /** The cut's `scrambleShown`. */
  scrambleShown: number;
  segment: VideoSegment;
  stored: boolean;
  reason: string;
}

/** A side leaves on purpose (the phone's Leave, the host's Remove), with why. */
export interface Leave {
  type: 'leave';
  reason: string;
}

/**
 * The host's sync check of the phone's camera (T4.3): from now until `sync-stop` with the same `id`
 * (or the connection's end), the phone measures the motion of each of its frames inside its framing
 * rectangle, as the host's capture worker measures its own camera's for its check, and sends it
 * (`sync-motion`); the host matches it against the cube's turns. A new `sync-start` ends the one
 * before.
 */
export interface SyncStart {
  type: 'sync-start';
  id: number;
}

/** The host's check `id` ended: the phone stops measuring. */
export interface SyncStop {
  type: 'sync-stop';
  id: number;
}

/**
 * One frame's motion during the host's sync check (T4.3), as the phone's capture worker measured it
 * (`MotionSample` of @cubetrace/capture), its times on the phone's clock: the host places them on its
 * own with the clock sync.
 */
export interface MotionReport {
  /** The frame's own `VideoFrame.timestamp`, in µs. */
  timestampUs: number;
  /** When the frame reached the phone's capture worker, on the phone's clock, in ms. */
  arrivalMs: number;
  /** When its motion reached the phone's page, on the same clock, in ms. */
  receivedMs: number;
  /** The mean absolute difference of its luma from the frame before's, in luma levels. */
  mean: number;
  /** The share of the region's pixels whose luma changed by more than 12 levels, 0 to 1. */
  changed: number;
  /** The capture worker's time on it, in ms. */
  costMs: number;
}

/** The motion of the frames measured since the last `sync-motion` of the check `id`, in order. */
export interface SyncMotion {
  type: 'sync-motion';
  id: number;
  frames: MotionReport[];
}

/**
 * How the phone's capture worker reads the frames of the check `id` (`MotionMeterInfo` of
 * @cubetrace/capture): sent first, and when it changes.
 */
export interface SyncMeter {
  type: 'sync-meter';
  id: number;
  meter: {
    /** The frames' pixel format (`NV12`); null when the browser gives none. */
    format: string | null;
    /** Read out of the frame's planes (`copy`) or drawn into a canvas (`draw`). */
    path: 'copy' | 'draw';
    frameWidth: number;
    frameHeight: number;
    /** The region measured, in frame pixels: the framing rectangle clamped to the frame. */
    region: CropRect;
    planeWidth: number;
    planeHeight: number;
    changeLevels: number;
  };
}

/**
 * The phone cannot measure the frames of the check `id` (it does not record, their pixels cannot be
 * read): the host's check ends as failed, with `message`.
 */
export interface SyncError {
  type: 'sync-error';
  id: number;
  message: string;
}

/**
 * Whether the host wants the live preview (T4.3): a small video track of the phone's camera over the
 * same connection, for the host to frame by (Camera settings → Cameras → "Live preview from phones").
 * Sent once the hellos are exchanged and whenever the setting changes; the phone sends no picture
 * before it.
 */
export interface Preview {
  type: 'preview';
  on: boolean;
}

/** Every message of the protocol. */
export type Message =
  | Hello
  | Ping
  | Pong
  | Clock
  | CameraState
  | Thumbnail
  | Cut
  | CutDone
  | CutFailed
  | ClipAck
  | FileBegin
  | FileChunk
  | FileAck
  | FileDone
  | FileResume
  | FileAbort
  | Leave
  | SyncStart
  | SyncStop
  | SyncMotion
  | SyncMeter
  | SyncError
  | Preview;

/** The messages that go as JSON text. */
export type ControlMessage = Exclude<Message, FileChunk | Thumbnail>;

/** A frame as the channel carries it: text for a control message, bytes for a chunk or a thumbnail. */
export type WireFrame = string | Uint8Array;

/** The first byte of a binary frame says what it is. */
const CHUNK_FRAME = 0x01;
const THUMBNAIL_FRAME = 0x02;

/** A chunk frame's header: the kind, the file's id (4 bytes) and the offset (8 bytes), big-endian. */
export const CHUNK_HEADER_BYTES = 13;

/** A thumbnail frame's header: the kind, the time (8 bytes), the width and the height (2 bytes each). */
export const THUMBNAIL_HEADER_BYTES = 13;

/** The most characters of the texts a message carries. */
const MAX_TEXT = 1000;

/** A file's name: a plain name, no path (docs/DATA-MODEL.md §5 names the clips' files). */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;

/** A camera's label (docs/DATA-MODEL.md §5): lowercase letters and digits in words joined by hyphens. */
const CAMERA_LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/**
 * The most frames one `sync-motion` carries: the phone sends a batch about four times a second, so
 * a few dozen at 60 fps; more is not a batch of this protocol.
 */
export const MAX_MOTION_FRAMES = 240;

/** What {@link decode} throws for a frame that is not a message of this protocol. */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

/** The wire form of a message: JSON text, or a binary frame for a chunk or a thumbnail. */
export function encode(message: Message): WireFrame {
  switch (message.type) {
    case 'file-chunk': {
      const frame = new Uint8Array(CHUNK_HEADER_BYTES + message.bytes.length);
      const view = new DataView(frame.buffer);
      view.setUint8(0, CHUNK_FRAME);
      view.setUint32(1, message.id);
      view.setUint32(5, Math.floor(message.offset / 2 ** 32));
      view.setUint32(9, message.offset >>> 0);
      frame.set(message.bytes, CHUNK_HEADER_BYTES);
      return frame;
    }
    case 'thumbnail': {
      const frame = new Uint8Array(THUMBNAIL_HEADER_BYTES + message.jpeg.length);
      const view = new DataView(frame.buffer);
      view.setUint8(0, THUMBNAIL_FRAME);
      view.setFloat64(1, message.remoteMs);
      view.setUint16(9, message.width);
      view.setUint16(11, message.height);
      frame.set(message.jpeg, THUMBNAIL_HEADER_BYTES);
      return frame;
    }
    default:
      return JSON.stringify(message);
  }
}

/**
 * The message of a frame, checked: a text frame is a control message, a binary frame a chunk or a
 * thumbnail. Throws a {@link ProtocolError} on anything else. A binary frame's bytes are a view into
 * the frame, not a copy.
 */
export function decode(frame: string | ArrayBuffer | ArrayBufferView): Message {
  if (typeof frame === 'string') {
    return decodeControl(frame);
  }
  const bytes =
    frame instanceof ArrayBuffer
      ? new Uint8Array(frame)
      : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  if (bytes.length === 0) {
    throw new ProtocolError('An empty binary frame.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (bytes[0]) {
    case CHUNK_FRAME: {
      if (bytes.length < CHUNK_HEADER_BYTES) {
        throw new ProtocolError(`A chunk frame of ${String(bytes.length)} bytes: too short.`);
      }
      return {
        type: 'file-chunk',
        id: view.getUint32(1),
        offset: view.getUint32(5) * 2 ** 32 + view.getUint32(9),
        bytes: bytes.subarray(CHUNK_HEADER_BYTES),
      };
    }
    case THUMBNAIL_FRAME: {
      if (bytes.length < THUMBNAIL_HEADER_BYTES) {
        throw new ProtocolError(`A thumbnail frame of ${String(bytes.length)} bytes: too short.`);
      }
      const remoteMs = view.getFloat64(1);
      if (!Number.isFinite(remoteMs)) {
        throw new ProtocolError('A thumbnail frame whose time is not finite.');
      }
      return {
        type: 'thumbnail',
        remoteMs,
        width: view.getUint16(9),
        height: view.getUint16(11),
        jpeg: bytes.subarray(THUMBNAIL_HEADER_BYTES),
      };
    }
    default:
      throw new ProtocolError(`A binary frame of an unknown kind, ${String(bytes[0])}.`);
  }
}

// ---- The control messages' checks ----

type Json = Record<string, unknown>;

function decodeControl(text: string): ControlMessage {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProtocolError('A text frame that is not JSON.');
  }
  if (!isObject(json)) {
    throw new ProtocolError(`A text frame that is not an object: ${show(json)}.`);
  }
  const type = json['type'];
  switch (type) {
    case 'hello':
      return {
        type,
        v: int(json, 'v', 0),
        role: oneOf(json, 'role', ['host', 'camera']),
        device: device(field(json, 'device')),
        app: build(field(json, 'app')),
        camera: camera(json['camera']),
      };
    case 'ping':
      return { type, t1: num(json, 't1') };
    case 'pong':
      return { type, t1: num(json, 't1'), t2: num(json, 't2'), t3: num(json, 't3') };
    case 'clock':
      return {
        type,
        converged: bool(json, 'converged'),
        offsetMs: num(json, 'offsetMs'),
        rttMs: num(json, 'rttMs', 0),
      };
    case 'state':
      return state(json);
    case 'cut':
      return {
        type,
        attempt: int(json, 'attempt', 1),
        scrambleShown: num(json, 'scrambleShown'),
        segment: segment(json, 'segment'),
        fromRemoteMs: num(json, 'fromRemoteMs'),
        toRemoteMs: num(json, 'toRemoteMs'),
        reason: text_(json, 'reason'),
        camera: cameraLabel(json, 'camera'),
      };
    case 'cut-done':
      return {
        type,
        attempt: int(json, 'attempt', 1),
        scrambleShown: num(json, 'scrambleShown'),
        segment: segment(json, 'segment'),
        files: list(json, 'files').map(fileInfo),
        clip: cutClip(field(json, 'clip')),
      };
    case 'cut-failed':
      return {
        type,
        attempt: int(json, 'attempt', 1),
        scrambleShown: num(json, 'scrambleShown'),
        segment: segment(json, 'segment'),
        reason: text_(json, 'reason'),
      };
    case 'clip-ack':
      return {
        type,
        attempt: int(json, 'attempt', 1),
        scrambleShown: num(json, 'scrambleShown'),
        segment: segment(json, 'segment'),
        stored: bool(json, 'stored'),
        reason: text_(json, 'reason'),
      };
    case 'file-begin':
      return {
        type,
        id: int(json, 'id', 0),
        name: fileName(json, 'name'),
        bytes: int(json, 'bytes', 0),
        kind: oneOf(json, 'kind', ['mp4', 'frames']),
        attempt: json['attempt'] === null ? null : int(json, 'attempt', 1),
        segment: json['segment'] === null ? null : segment(json, 'segment'),
      };
    case 'file-ack':
      return {
        type,
        id: int(json, 'id', 0),
        offset: int(json, 'offset', 0),
        done: bool(json, 'done'),
      };
    case 'file-done':
      return { type, id: int(json, 'id', 0), crc32: int(json, 'crc32', 0, 0xffffffff) };
    case 'file-resume':
      return { type, id: int(json, 'id', 0), offset: int(json, 'offset', 0) };
    case 'file-abort':
      return { type, id: int(json, 'id', 0), reason: text_(json, 'reason') };
    case 'leave':
      return { type, reason: text_(json, 'reason') };
    case 'sync-start':
    case 'sync-stop':
      return { type, id: int(json, 'id', 0) };
    case 'sync-motion': {
      const frames = list(json, 'frames');
      if (frames.length > MAX_MOTION_FRAMES) {
        throw new ProtocolError(
          `frames must hold at most ${String(MAX_MOTION_FRAMES)} frames, got ${String(frames.length)}.`,
        );
      }
      return { type, id: int(json, 'id', 0), frames: frames.map(motionReport) };
    }
    case 'sync-meter':
      return { type, id: int(json, 'id', 0), meter: motionMeter(field(json, 'meter')) };
    case 'sync-error':
      return { type, id: int(json, 'id', 0), message: text_(json, 'message') };
    case 'preview':
      return { type, on: bool(json, 'on') };
    case 'file-chunk':
    case 'thumbnail':
      throw new ProtocolError(`A ${type} message as text: it goes as a binary frame.`);
    default:
      throw new ProtocolError(`A message of an unknown type, ${show(type)}.`);
  }
}

function state(json: Json): CameraState {
  const framing = json['framing'];
  const frame = json['frame'];
  const battery = json['battery'];
  return {
    type: 'state',
    remoteMs: num(json, 'remoteMs'),
    recording: bool(json, 'recording'),
    framing:
      framing === null || framing === undefined
        ? null
        : {
            x: int(field(json, 'framing'), 'x', 0),
            y: int(field(json, 'framing'), 'y', 0),
            w: int(field(json, 'framing'), 'w', 1),
            h: int(field(json, 'framing'), 'h', 1),
          },
    frame:
      frame === null || frame === undefined
        ? null
        : {
            width: int(field(json, 'frame'), 'width', 1),
            height: int(field(json, 'frame'), 'height', 1),
          },
    fps: nullable(json, 'fps', (j, k) => num(j, k, 0)),
    sharpness: nullable(json, 'sharpness', (j, k) => num(j, k, 0)),
    battery:
      battery === null || battery === undefined
        ? null
        : {
            level: num(field(json, 'battery'), 'level', 0, 1),
            charging: bool(field(json, 'battery'), 'charging'),
          },
    thermal:
      json['thermal'] === null || json['thermal'] === undefined
        ? null
        : oneOf(json, 'thermal', ['ok', 'throttled']),
    pendingClips: int(json, 'pendingClips', 0),
  };
}

function device(json: Json): DeviceInfo {
  return { label: text_(json, 'label'), platform: text_(json, 'platform') };
}

function build(json: Json): AppBuild {
  return { version: text_(json, 'version'), commit: text_(json, 'commit') };
}

/** The camera device's camera, checked as a session.json entry by core's reader. */
function camera(value: unknown): CameraInfo | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return parseCameraInfo(value);
  } catch (error: unknown) {
    if (error instanceof RecordError) {
      throw new ProtocolError(`hello.camera is not a camera: ${error.detail}.`);
    }
    throw error;
  }
}

function fileInfo(value: unknown): FileInfo {
  if (!isObject(value)) {
    throw new ProtocolError(`A file of cut-done that is not an object: ${show(value)}.`);
  }
  return {
    name: fileName(value, 'name'),
    bytes: int(value, 'bytes', 0),
    kind: oneOf(value, 'kind', ['mp4', 'frames']),
  };
}

/** What the capture said of a clip (`cut-done`'s `clip`), checked. */
function cutClip(json: Json): CutClip {
  const crop = json['crop'];
  const fpsNominal = num(json, 'fpsNominal', 0);
  if (fpsNominal === 0) {
    throw new ProtocolError('fpsNominal must be a number > 0, got 0.');
  }
  return {
    codec: text_(json, 'codec'),
    audio: nullable(json, 'audio', text_),
    width: int(json, 'width', 1),
    height: int(json, 'height', 1),
    fpsNominal,
    frames: int(json, 'frames', 1),
    crop:
      crop === null || crop === undefined
        ? null
        : {
            x: int(field(json, 'crop'), 'x', 0),
            y: int(field(json, 'crop'), 'y', 0),
            w: int(field(json, 'crop'), 'w', 1),
            h: int(field(json, 'crop'), 'h', 1),
          },
    truncatedStart: bool(json, 'truncatedStart'),
    lateMs: num(json, 'lateMs', 0),
    bufferSeconds: num(json, 'bufferSeconds', 0),
    audioMissing: nullable(json, 'audioMissing', text_),
  };
}

/** One frame's motion of `sync-motion`, checked. */
function motionReport(value: unknown): MotionReport {
  if (!isObject(value)) {
    throw new ProtocolError(`A frame of sync-motion that is not an object: ${show(value)}.`);
  }
  return {
    timestampUs: num(value, 'timestampUs'),
    arrivalMs: num(value, 'arrivalMs'),
    receivedMs: num(value, 'receivedMs'),
    mean: num(value, 'mean', 0, 255),
    changed: num(value, 'changed', 0, 1),
    costMs: num(value, 'costMs', 0),
  };
}

/** How the phone's capture worker reads the frames (`sync-meter`'s `meter`), checked. */
function motionMeter(json: Json): SyncMeter['meter'] {
  const region = field(json, 'region');
  return {
    format: nullable(json, 'format', text_),
    path: oneOf(json, 'path', ['copy', 'draw']),
    frameWidth: int(json, 'frameWidth', 1),
    frameHeight: int(json, 'frameHeight', 1),
    region: {
      x: int(region, 'x', 0),
      y: int(region, 'y', 0),
      w: int(region, 'w', 1),
      h: int(region, 'h', 1),
    },
    planeWidth: int(json, 'planeWidth', 1),
    planeHeight: int(json, 'planeHeight', 1),
    changeLevels: num(json, 'changeLevels', 0),
  };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  // JSON.stringify gives undefined for undefined and functions, whatever its type says.
  const text: unknown = JSON.stringify(value);
  const shown = typeof text === 'string' ? text : String(value);
  return shown.length > 40 ? `${shown.slice(0, 37)}…` : shown;
}

function field(json: Json, key: string): Json {
  const value = json[key];
  if (!isObject(value)) {
    throw new ProtocolError(`${key} must be an object, got ${show(value)}.`);
  }
  return value;
}

function num(json: Json, key: string, min = -Infinity, max = Infinity): number {
  const value = json[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ProtocolError(
      `${key} must be a number${min === -Infinity ? '' : ` ≥ ${String(min)}`}, got ${show(value)}.`,
    );
  }
  return value;
}

function int(json: Json, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = json[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(`${key} must be an integer ≥ ${String(min)}, got ${show(value)}.`);
  }
  return value;
}

function bool(json: Json, key: string): boolean {
  const value = json[key];
  if (typeof value !== 'boolean') {
    throw new ProtocolError(`${key} must be true or false, got ${show(value)}.`);
  }
  return value;
}

function text_(json: Json, key: string): string {
  const value = json[key];
  if (typeof value !== 'string' || value.length > MAX_TEXT) {
    throw new ProtocolError(
      `${key} must be a string of at most ${String(MAX_TEXT)} characters, got ${show(value)}.`,
    );
  }
  return value;
}

function fileName(json: Json, key: string): string {
  const value = json[key];
  if (typeof value !== 'string' || !FILE_NAME.test(value) || value.includes('..')) {
    throw new ProtocolError(`${key} must be a file name without a path, got ${show(value)}.`);
  }
  return value;
}

function cameraLabel(json: Json, key: string): string {
  const value = json[key];
  if (typeof value !== 'string' || value.length > 100 || !CAMERA_LABEL.test(value)) {
    throw new ProtocolError(
      `${key} must be a camera label (lowercase letters and digits in words joined by hyphens), got ${show(value)}.`,
    );
  }
  return value;
}

function oneOf<const T extends readonly string[]>(json: Json, key: string, values: T): T[number] {
  const value = json[key];
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ProtocolError(`${key} must be one of ${values.join(', ')}, got ${show(value)}.`);
  }
  return value;
}

function segment(json: Json, key: string): VideoSegment {
  return oneOf(json, key, ['scramble', 'solve']);
}

function list(json: Json, key: string): unknown[] {
  const value = json[key];
  if (!Array.isArray(value)) {
    throw new ProtocolError(`${key} must be an array, got ${show(value)}.`);
  }
  return value as unknown[];
}

function nullable<T>(json: Json, key: string, read: (json: Json, key: string) => T): T | null {
  const value = json[key];
  return value === null || value === undefined ? null : read(json, key);
}
