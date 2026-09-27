// MP4 muxing (docs/PLAN.md, T2.3): a cut's encoded chunks, as the encoders made them, put into an
// MP4 file with mediabunny, without re-encoding, and the frame times of its frames.json
// (docs/DATA-MODEL.md §9). The clip worker muxes and writes the clip (clip-worker.ts,
// clip-writer.ts; the capture worker did until T2.4), so mediabunny is in that worker's chunk only:
// the package's index does not export this file. mediabunny's muxer touches no browser API, so this is tested in Node on a cut recorded
// from Chrome's fake camera (fixtures/media/).
import type { FramesJson, VideoSegment } from '@cubetrace/core';
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';

import { clipFiles } from './clip-files';
import type { Cut, CutVideo } from './cut';
import type { AudioReport } from './protocol';
import type { EncodedChunkRecord } from './ring-buffer';

/** Which clip of an attempt a cut becomes (docs/DATA-MODEL.md §5). */
export interface ClipMeta {
  /** The camera's label (`laptop`, `phone-front`). */
  readonly camera: string;
  readonly segment: VideoSegment;
  /**
   * The capture's audio when the cut was made (the capture worker's report), so that a clip without
   * sound says why; without it, a cut without an audio track is taken to have been asked for none.
   */
  readonly audio?: AudioReport;
}

/** What the MP4 holds, for the clip's `video[]` entry (docs/DATA-MODEL.md §7). */
export interface MuxedClipInfo {
  /** The video track's codec string (`avc1.640028`, `vp09.00.40.08`): its decoder config's. */
  readonly codec: string;
  /** The audio track's codec string (`mp4a.40.2`, `opus`); null when the MP4 has no audio track. */
  readonly audio: string | null;
  /** Of the encoded frames. */
  readonly width: number;
  readonly height: number;
  /** The video frames in the MP4, one per `frames.dtMs` entry. */
  readonly frames: number;
  /** From the first frame to the end of the last one, ms: the video track's duration. */
  readonly durationMs: number;
  /** The cut's start was older than the buffer: the clip begins at its first keyframe instead. */
  readonly truncatedStart: boolean;
  /** How much later than asked the clip begins, ms, to 0.1 ms: 0 unless `truncatedStart`. */
  readonly lateMs: number;
  /**
   * Why the MP4 has no audio track although audio was recorded (see `ClipReport.audioMissing`); null
   * when it has one, or none was asked for.
   */
  readonly audioMissing: string | null;
  /** How far its audio was moved onto the frames' clock, ms (`CutAudio.rebaseMs`); 0 without. */
  readonly audioRebasedMs: number;
}

export interface MuxedClip {
  /** The MP4 file, metadata first (`moov` before `mdat`), so that a player starts at once. */
  readonly mp4: ArrayBuffer;
  /** The clip's frames.json: the cut's frame times with `schema`, `camera` and `segment`. */
  readonly frames: FramesJson;
  readonly info: MuxedClipInfo;
}

/** One packet on its way into the MP4, in seconds from the clip's first frame. */
interface Placed {
  readonly kind: 'video' | 'audio';
  readonly packet: EncodedPacket;
}

/**
 * The MP4 of `cut` and its frames.json. The video chunks go in as they are (no re-encoding) with
 * the encoder's decoder config (for H.264 its `description`, the avcC; VP9 needs its codec string
 * only), and so do the audio chunks. Times are rebased so that the clip starts at 0 at its first
 * frame (a keyframe); the audio keeps its place relative to the video by its own timestamps, which
 * count on the frames' clock on the devices measured (docs/DEVICES.md), or else by the cut's
 * `rebaseMs` (issue #33): the chunks that end before the first frame are left out, one that overlaps
 * it is kept, and the MP4's edit list trims its part before 0. Packets of both tracks go in time
 * order, so the file interleaves them. A frame without a duration (Chrome's fake camera gives 0)
 * lasts until the next one; the last such frame, the median interval.
 *
 * A cut whose start is older than the buffer (`truncatedStart`) is muxed from its first keyframe,
 * and `info` says how late it begins (T2.9: a clip is never lost for an old start); one whose end is
 * later than the newest frame (`truncatedEnd`) is muxed too: it is short by the encoder's latency
 * when cut right after its end. A clip without an audio track while the capture records audio says
 * why in `info.audioMissing`. Rejects a cut without frames, one that does not begin at a keyframe,
 * and one without the video's decoder config.
 */
export async function muxClip(cut: Cut, meta: ClipMeta): Promise<MuxedClip> {
  clipFiles(meta.camera, meta.segment);
  const video = cut.video;
  const chunks = video.chunks;
  const first = chunks.at(0);
  if (first === undefined) {
    throw new Error('Cannot mux an empty cut: it has no video frames.');
  }
  if (first.type !== 'key') {
    throw new Error('Cannot mux a cut that does not begin with a keyframe.');
  }
  const videoConfig = videoDecoderConfig(video);
  const originUs = first.timestampUs;
  const { audio, missing } = audioToKeep(cut, originUs, meta.audio);

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSource = new EncodedVideoPacketSource(videoCodecOf(videoConfig.codec));
  output.addVideoTrack(videoSource);
  const audioSource =
    audio === null ? null : new EncodedAudioPacketSource(audioCodecOf(audio.config.codec));
  if (audioSource !== null) {
    output.addAudioTrack(audioSource);
  }
  await output.start();
  try {
    const placed = interleave(
      packets('video', chunks, originUs),
      // The audio's origin on its own clock: the first frame's timestamp less the rebase.
      audio === null ? [] : packets('audio', audio.chunks, originUs - audio.rebaseUs),
    );
    let describedVideo = false;
    let describedAudio = false;
    for (const { kind, packet } of placed) {
      if (kind === 'video') {
        await videoSource.add(packet, describedVideo ? undefined : { decoderConfig: videoConfig });
        describedVideo = true;
      } else if (audioSource !== null && audio !== null) {
        await audioSource.add(packet, describedAudio ? undefined : { decoderConfig: audio.config });
        describedAudio = true;
      }
    }
    await output.finalize();
  } catch (error: unknown) {
    await output.cancel().catch(() => undefined);
    throw error;
  }
  const mp4 = output.target.buffer;
  if (mp4 === null) {
    throw new Error('mediabunny finished the MP4 without its bytes.');
  }
  const last = chunks[chunks.length - 1];
  return {
    mp4,
    frames: {
      schema: 2,
      camera: meta.camera,
      segment: meta.segment,
      t0HostMs: cut.frames.t0HostMs,
      dtMs: [...cut.frames.dtMs],
      keyframes: [...cut.frames.keyframes],
      arrival: { ...cut.frames.arrival },
    },
    info: {
      codec: videoConfig.codec,
      audio: audio === null ? null : audio.config.codec,
      width: video.width,
      height: video.height,
      frames: chunks.length,
      durationMs: (last.timestampUs + durationUs(chunks, chunks.length - 1) - originUs) / 1000,
      truncatedStart: cut.truncatedStart,
      lateMs: cut.truncatedStart
        ? Math.max(0, Math.round((cut.frames.t0HostMs - cut.startHostMs) * 10) / 10)
        : 0,
      audioMissing: missing,
      audioRebasedMs: audio === null ? 0 : audio.rebaseUs / 1000,
    },
  };
}

/**
 * The encoder's decoder config with the frame size mediabunny requires (`codedWidth` and
 * `codedHeight`, which Chrome's encoders give; the cut's size where they are missing).
 */
function videoDecoderConfig(video: CutVideo): VideoDecoderConfig {
  const config = video.decoderConfig;
  if (config === null) {
    throw new Error("Cannot mux a cut without the video encoder's decoder config.");
  }
  return {
    ...config,
    codedWidth: config.codedWidth ?? video.width,
    codedHeight: config.codedHeight ?? video.height,
  };
}

/** The audio a clip keeps: its chunks, their decoder config, their shift to the frames' clock. */
interface KeptAudio {
  readonly config: AudioDecoderConfig;
  readonly chunks: readonly EncodedChunkRecord[];
  readonly rebaseUs: number;
}

/**
 * The audio chunks that do not end before the first frame (placed on the frames' clock), with their
 * decoder config; or none, and why when audio was recorded (`report`): no audio data from the
 * microphone, the audio stopped (the encoder's error), no decoder config, no chunk in the clip's
 * span (with how far the audio's timestamps are from the frames').
 */
function audioToKeep(
  cut: Cut,
  originUs: number,
  report: AudioReport | undefined,
): { readonly audio: KeptAudio | null; readonly missing: string | null } {
  const audio = cut.audio;
  const rebaseUs = Math.round((audio?.rebaseMs ?? 0) * 1000);
  const chunks =
    audio?.chunks.filter((chunk) => {
      const placedUs = chunk.timestampUs + rebaseUs;
      return placedUs >= originUs || placedUs + chunk.durationUs > originUs;
    }) ?? [];
  if (audio !== null && audio.decoderConfig !== null && chunks.length > 0) {
    return { audio: { config: audio.decoderConfig, chunks, rebaseUs }, missing: null };
  }
  if (report?.state === 'off' || (report === undefined && audio === null)) {
    return { audio: null, missing: null };
  }
  const error = report?.error ?? null;
  let missing: string;
  if (report !== undefined && report.data === 0) {
    missing = 'no audio data: the microphone sent nothing (muted, or held by another app)';
  } else if (audio === null) {
    missing = error !== null ? `the audio stopped (${error})` : 'the audio encoder had not started';
  } else if (audio.decoderConfig === null) {
    missing = 'no decoder config: the audio encoder never described its output';
  } else if (error !== null) {
    missing = `the audio stopped (${error})`;
  } else {
    const offset = audio.offsetFromVideoMs;
    missing =
      offset === null
        ? "no audio chunk in the clip's span: none was in memory"
        : `no audio chunk in the clip's span (the audio's timestamps are ${offset.toFixed(1)} ms from the video's)`;
  }
  return { audio: null, missing };
}

/** mediabunny's name for the codec family of a WebCodecs video codec string. */
function videoCodecOf(codec: string): VideoCodec {
  if (codec.startsWith('avc1.') || codec.startsWith('avc3.')) {
    return 'avc';
  }
  if (codec.startsWith('vp09.')) {
    return 'vp9';
  }
  throw new Error(`Cannot mux video coded as ${codec}: the capture encodes H.264 or VP9.`);
}

/** mediabunny's name for the codec family of a WebCodecs audio codec string. */
function audioCodecOf(codec: string): AudioCodec {
  if (codec.startsWith('mp4a.40.')) {
    return 'aac';
  }
  if (codec === 'opus') {
    return 'opus';
  }
  throw new Error(`Cannot mux audio coded as ${codec}: the capture encodes AAC or Opus.`);
}

/** The chunks as packets, their times in seconds from `originUs`. */
function packets(
  kind: 'video' | 'audio',
  chunks: readonly EncodedChunkRecord[],
  originUs: number,
): Placed[] {
  return chunks.map((chunk, index) => ({
    kind,
    packet: new EncodedPacket(
      new Uint8Array(chunk.data),
      chunk.type,
      (chunk.timestampUs - originUs) / 1e6,
      durationUs(chunks, index) / 1e6,
    ),
  }));
}

/**
 * How long chunk `index` lasts, µs: its own duration, or where it has none (0), the time to the
 * next chunk, or for the last one the median of the intervals between the chunks (0 for a single
 * chunk without a duration).
 */
function durationUs(chunks: readonly EncodedChunkRecord[], index: number): number {
  const chunk = chunks[index];
  if (chunk.durationUs > 0) {
    return chunk.durationUs;
  }
  const next = chunks.at(index + 1);
  if (next !== undefined) {
    return Math.max(0, next.timestampUs - chunk.timestampUs);
  }
  const intervals = chunks
    .slice(1)
    .map((later, at) => later.timestampUs - chunks[at].timestampUs)
    .filter((interval) => interval > 0)
    .sort((a, b) => a - b);
  return intervals.length === 0 ? 0 : intervals[Math.floor(intervals.length / 2)];
}

/** Both tracks' packets in time order, video first at equal times (each list is in order). */
function interleave(video: readonly Placed[], audio: readonly Placed[]): Placed[] {
  const merged: Placed[] = [];
  let v = 0;
  let a = 0;
  while (v < video.length || a < audio.length) {
    if (
      a >= audio.length ||
      (v < video.length && video[v].packet.timestamp <= audio[a].packet.timestamp)
    ) {
      merged.push(video[v]);
      v += 1;
    } else {
      merged.push(audio[a]);
      a += 1;
    }
  }
  return merged;
}
