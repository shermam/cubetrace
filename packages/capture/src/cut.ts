// Cuts: an interval of host time taken out of the ring buffer without re-encoding (docs/PLAN.md,
// T2.2), with the per-frame times that frames.json keeps (docs/DATA-MODEL.md §9). Pure TypeScript:
// no browser API, so it is tested in Node with synthetic chunks.
import type { FramesJson } from '@cubetrace/core';

import type { AudioTrackInfo, EncodedChunkRecord, RingBuffer, VideoTrackInfo } from './ring-buffer';

/**
 * Where a stream's timestamps sit on the host clock (frames.json's `arrival`): the median of
 * `arrivalHostMs − timestampUs / 1000` over its chunks (the capture clock and the host clock advance
 * together, so one offset maps one onto the other), and the 95th percentile (nearest rank) of the
 * absolute residuals `|arrivalHostMs − (timestampUs / 1000 + offsetMs)|`, the arrivals' jitter.
 */
export type ArrivalFit = FramesJson['arrival'];

/**
 * The frames of a cut as frames.json keeps them (docs/DATA-MODEL.md §9): `t0HostMs`, the first
 * frame's timestamp plus the arrival offset, so free of the arrival jitter; `dtMs`, the intervals
 * from the timestamps at 0.1 ms without drift; `keyframes`, their indices; `arrival`, the fit. The
 * muxer (T2.3) adds `schema`, `camera` and `segment`.
 */
export type CutFrames = Pick<FramesJson, 't0HostMs' | 'dtMs' | 'keyframes' | 'arrival'>;

export interface CutVideo extends VideoTrackInfo {
  /** From the last keyframe at or before the start to the last frame at or before the end. */
  readonly chunks: readonly EncodedChunkRecord[];
}

export interface CutAudio extends AudioTrackInfo {
  /** Every audio chunk that overlaps the video's span (same capture clock, docs/DEVICES.md). */
  readonly chunks: readonly EncodedChunkRecord[];
  /** The audio's own arrival fit; its offset matches the video's when both share the clock. */
  readonly arrival: ArrivalFit | null;
}

export interface Cut {
  /** The interval asked for, host ms. */
  readonly startHostMs: number;
  readonly endHostMs: number;
  /** The start is older than the buffer: the cut begins at the buffer's first keyframe instead. */
  readonly truncatedStart: boolean;
  /** The end is later than the newest frame in the buffer (the camera or the encoder is behind). */
  readonly truncatedEnd: boolean;
  readonly video: CutVideo;
  /** Null when the buffer has no audio track. */
  readonly audio: CutAudio | null;
  readonly frames: CutFrames;
}

/** How `cut` hands out the chunks' bytes. */
export interface CutOptions {
  /**
   * Whether each chunk comes with a copy of its bytes (the default), which the cut owns and can
   * transfer to the window. False shares the buffer's own bytes, which the buffer never changes
   * (eviction only lets go of them): for a cut used in the worker itself, such as the muxer's
   * (T2.3), which must then neither transfer nor change them.
   */
  readonly copy?: boolean;
}

/**
 * The chunks for `[startHostMs, endHostMs]`: the video from the last keyframe at or before the
 * start to the last frame at or before the end, and the audio chunks that overlap that span, each
 * with a copy of its bytes (the buffer keeps its own, so overlapping cuts work; the copies move to
 * the window without another copy, see `cutBuffers`) unless `options.copy` is false. Frame times on
 * the host clock are the frames' timestamps plus the buffer's arrival offset. Throws a RangeError
 * when the interval is empty or inverted, or nothing is buffered at or before its end.
 */
export function cut(
  buffer: RingBuffer,
  startHostMs: number,
  endHostMs: number,
  options: CutOptions = {},
): Cut {
  const take = options.copy === false ? (chunk: EncodedChunkRecord) => chunk : copyChunk;
  if (!Number.isFinite(startHostMs) || !Number.isFinite(endHostMs) || endHostMs < startHostMs) {
    throw new RangeError(
      `Cannot cut from ${String(startHostMs)} to ${String(endHostMs)}: not an interval.`,
    );
  }
  const video = buffer.video;
  const track = buffer.videoTrack;
  if (video.length === 0 || track === null) {
    throw new RangeError('Nothing is buffered yet.');
  }
  const offsetMs = arrivalFit(video).offsetMs;
  const hostMs = (chunk: EncodedChunkRecord): number => chunk.timestampUs / 1000 + offsetMs;
  const last = lastAtOrBefore(video, endHostMs, hostMs);
  if (last < 0) {
    throw new RangeError(
      `Nothing is buffered at or before ${String(endHostMs)}: the buffer begins at ` +
        `${String(round(hostMs(video[0]), 1))}.`,
    );
  }
  const truncatedStart = startHostMs < hostMs(video[0]);
  let first = truncatedStart ? 0 : lastAtOrBefore(video, startHostMs, hostMs);
  while (first > 0 && video[first].type !== 'key') {
    first -= 1;
  }
  const newest = video[video.length - 1];
  const chunks = video.slice(first, last + 1).map(take);
  const spanStartUs = chunks[0].timestampUs;
  const lastChunk = chunks[chunks.length - 1];
  const spanEndUs = lastChunk.timestampUs + lastChunk.durationUs;
  const fit = arrivalFit(chunks);
  return {
    startHostMs,
    endHostMs,
    truncatedStart,
    truncatedEnd: hostMs(newest) + newest.durationUs / 1000 < endHostMs,
    video: { ...track, chunks },
    audio: cutAudio(buffer, spanStartUs, spanEndUs, take),
    frames: {
      t0HostMs: round(chunks[0].timestampUs / 1000 + fit.offsetMs, 2),
      dtMs: frameIntervals(chunks),
      keyframes: chunks.flatMap((chunk, index) => (chunk.type === 'key' ? [index] : [])),
      arrival: fit,
    },
  };
}

/** The ArrayBuffers a cut owns, each once: the transfer list that moves it to the window. */
export function cutBuffers(value: Cut): ArrayBuffer[] {
  return [...value.video.chunks, ...(value.audio?.chunks ?? [])].map((chunk) => chunk.data);
}

/** The arrival offset and residual of a stream's chunks (see `ArrivalFit`); needs one chunk. */
export function arrivalFit(chunks: readonly EncodedChunkRecord[]): ArrivalFit {
  const offsets = chunks
    .map((chunk) => chunk.arrivalHostMs - chunk.timestampUs / 1000)
    .sort((a, b) => a - b);
  const middle = Math.floor(offsets.length / 2);
  const offsetMs =
    offsets.length % 2 === 1 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
  const residuals = offsets.map((offset) => Math.abs(offset - offsetMs)).sort((a, b) => a - b);
  return {
    offsetMs: round(offsetMs, 2),
    residualP95Ms: round(residuals[Math.ceil(0.95 * residuals.length) - 1], 2),
  };
}

/**
 * Per frame, the time since the previous one in ms at 0.1 ms resolution, the first 0. Rounded as
 * offsets from the first frame and then differenced, so that their running sum gives every frame's
 * offset to within 0.05 ms however long the clip.
 */
export function frameIntervals(chunks: readonly EncodedChunkRecord[]): number[] {
  if (chunks.length === 0) {
    return [];
  }
  const firstUs = chunks[0].timestampUs;
  let previous = 0;
  return chunks.map((chunk) => {
    const tenths = Math.round((chunk.timestampUs - firstUs) / 100);
    const dt = (tenths - previous) / 10;
    previous = tenths;
    return dt;
  });
}

function cutAudio(
  buffer: RingBuffer,
  spanStartUs: number,
  spanEndUs: number,
  take: (chunk: EncodedChunkRecord) => EncodedChunkRecord,
): CutAudio | null {
  const track = buffer.audioTrack;
  if (track === null) {
    return null;
  }
  const chunks = buffer.audio
    .filter(
      (chunk) =>
        chunk.timestampUs < spanEndUs && chunk.timestampUs + chunk.durationUs > spanStartUs,
    )
    .map(take);
  return { ...track, chunks, arrival: chunks.length > 0 ? arrivalFit(chunks) : null };
}

/** The index of the last chunk whose host time is at or before `limitMs`, or −1. */
function lastAtOrBefore(
  chunks: readonly EncodedChunkRecord[],
  limitMs: number,
  hostMs: (chunk: EncodedChunkRecord) => number,
): number {
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (hostMs(chunks[middle]) <= limitMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low - 1;
}

function copyChunk(chunk: EncodedChunkRecord): EncodedChunkRecord {
  return { ...chunk, data: chunk.data.slice(0) };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
