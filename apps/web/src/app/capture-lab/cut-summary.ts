import type { ArrivalFit, Cut, CutFrames } from '@cubetrace/capture';

/**
 * What the capture lab prints about a cut: everything but the encoded bytes, plus the raw frame
 * times that docs/DEVICES.md ("VideoFrame.timestamp") is measured from.
 */
export interface CutSummary {
  /** The interval asked for, host ms, and its length in seconds. */
  readonly requested: {
    readonly startHostMs: number;
    readonly endHostMs: number;
    readonly seconds: number;
  };
  /** From the request to the answer, ms. */
  readonly latencyMs: number;
  /** The page's `performance.timeOrigin`: host ms minus this is the page's `performance.now()`. */
  readonly timeOrigin: number;
  readonly truncatedStart: boolean;
  readonly truncatedEnd: boolean;
  /** What the frames' timestamps are (docs/DEVICES.md, "VideoFrame.timestamp"); null without frames. */
  readonly clock: FrameClock | null;
  readonly video: {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly decoderConfig: {
      readonly codec: string;
      readonly descriptionBytes: number | null;
    } | null;
    readonly chunks: number;
    readonly bytes: number;
    readonly firstType: 'key' | 'delta' | null;
    /** From the first frame's timestamp to the end of the last frame. */
    readonly durationMs: number;
    /** Encoded bits per millisecond of video. */
    readonly bitrateKbps: number;
    readonly timestampsUs: readonly number[];
    readonly arrivalsHostMs: readonly number[];
  };
  readonly audio: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    readonly chunks: number;
    readonly bytes: number;
    readonly firstTimestampUs: number | null;
    readonly firstArrivalHostMs: number | null;
    readonly arrival: ArrivalFit | null;
  } | null;
  readonly frames: CutFrames;
}

/** The frames' clock against the host clock, from a cut's frames. */
export interface FrameClock {
  /** The first frame's `timestamp`, µs: near 0 when the clock starts with the camera. */
  readonly firstTimestampUs: number;
  /**
   * The median of `timestamp / 1000` minus the page's `performance.now()` when the frame reached
   * the worker, ms: steady when the timestamps count on the clock of `performance.now()`.
   */
  readonly timestampMinusPageNowMs: number;
  /**
   * How much `arrival − timestamp / 1000` grows per minute, from the first third of the frames to
   * the last (medians, so a stalled frame does not count): 0 when both clocks run together.
   */
  readonly arrivalDriftMsPerMinute: number | null;
  /** The audio's arrival offset minus the video's: a few ms when both share one clock. */
  readonly audioMinusVideoOffsetMs: number | null;
}

export interface CutRequestTiming {
  readonly startHostMs: number;
  readonly endHostMs: number;
  readonly latencyMs: number;
  readonly timeOrigin: number;
}

export function summarizeCut(cut: Cut, timing: CutRequestTiming): CutSummary {
  const chunks = cut.video.chunks;
  const first = chunks.at(0);
  const last = chunks.at(-1);
  const durationMs =
    first === undefined || last === undefined
      ? 0
      : (last.timestampUs + last.durationUs - first.timestampUs) / 1000;
  const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const description = cut.video.decoderConfig?.description;
  const audio = cut.audio;
  return {
    requested: {
      startHostMs: timing.startHostMs,
      endHostMs: timing.endHostMs,
      seconds: round((timing.endHostMs - timing.startHostMs) / 1000, 3),
    },
    latencyMs: round(timing.latencyMs, 1),
    timeOrigin: timing.timeOrigin,
    truncatedStart: cut.truncatedStart,
    truncatedEnd: cut.truncatedEnd,
    clock: frameClock(cut, timing.timeOrigin),
    video: {
      codec: cut.video.codec,
      width: cut.video.width,
      height: cut.video.height,
      decoderConfig:
        cut.video.decoderConfig === null
          ? null
          : {
              codec: cut.video.decoderConfig.codec,
              descriptionBytes: description === undefined ? null : description.byteLength,
            },
      chunks: chunks.length,
      bytes,
      firstType: first?.type ?? null,
      durationMs: round(durationMs, 3),
      bitrateKbps: durationMs > 0 ? round((bytes * 8) / durationMs, 1) : 0,
      timestampsUs: chunks.map((chunk) => chunk.timestampUs),
      arrivalsHostMs: chunks.map((chunk) => round(chunk.arrivalHostMs, 3)),
    },
    audio:
      audio === null
        ? null
        : {
            codec: audio.codec,
            sampleRate: audio.sampleRate,
            numberOfChannels: audio.numberOfChannels,
            chunks: audio.chunks.length,
            bytes: audio.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
            firstTimestampUs: audio.chunks.at(0)?.timestampUs ?? null,
            firstArrivalHostMs: audio.chunks.at(0)?.arrivalHostMs ?? null,
            arrival: audio.arrival,
          },
    frames: cut.frames,
  };
}

function frameClock(cut: Cut, timeOrigin: number): FrameClock | null {
  const chunks = cut.video.chunks;
  const first = chunks.at(0);
  if (first === undefined) {
    return null;
  }
  const minutes = chunks.map((chunk) => chunk.timestampUs / 60e6);
  const offsets = chunks.map((chunk) => chunk.arrivalHostMs - chunk.timestampUs / 1000);
  const third = Math.floor(chunks.length / 3);
  const run = third > 0 ? median(minutes.slice(-third)) - median(minutes.slice(0, third)) : 0;
  const audioOffset = cut.audio?.arrival?.offsetMs;
  return {
    firstTimestampUs: first.timestampUs,
    timestampMinusPageNowMs: round(
      median(chunks.map((chunk) => chunk.timestampUs / 1000 - (chunk.arrivalHostMs - timeOrigin))),
      2,
    ),
    arrivalDriftMsPerMinute:
      run > 0
        ? round((median(offsets.slice(-third)) - median(offsets.slice(0, third))) / run, 2)
        : null,
    audioMinusVideoOffsetMs:
      audioOffset === undefined ? null : round(audioOffset - cut.frames.arrival.offsetMs, 2),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  // No −0 (from a tiny negative difference) in the JSON or the comparisons.
  return rounded === 0 ? 0 : rounded;
}
