// The in-memory ring buffer of encoded chunks (docs/PLAN.md, T2.2): the last 90 s of the camera and
// the microphone, from which a cut takes any interval without re-encoding. Pure TypeScript: no
// browser API, so it is tested in Node with synthetic chunks.

/** One encoded chunk, video or audio, as the buffer keeps it. */
export interface EncodedChunkRecord {
  readonly kind: 'video' | 'audio';
  /** A keyframe (`key`) decodes on its own; a `delta` needs the chunks since the last keyframe. */
  readonly type: 'key' | 'delta';
  /** The frame's (or the chunk's first sample's) own timestamp in µs: exact for intervals. */
  readonly timestampUs: number;
  readonly durationUs: number;
  readonly byteLength: number;
  /**
   * Host ms (`performance.timeOrigin + performance.now()` in the worker) when the frame reached the
   * worker; for audio, when the audio data holding the chunk's first sample did, plus that sample's
   * offset in it.
   */
  readonly arrivalHostMs: number;
  /** The encoded bytes, owned by the buffer. */
  readonly data: ArrayBuffer;
}

/** What the buffer's video is: the encoder's codec and frame size, and its decoder config. */
export interface VideoTrackInfo {
  /** The codec string the encoder was configured with (`avc1.640028`, `vp09.00.40.08`, ...). */
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  /** `metadata.decoderConfig` of the encoder's output (its `description` copied): null until it comes. */
  readonly decoderConfig: VideoDecoderConfig | null;
}

export interface AudioTrackInfo {
  /** `mp4a.40.2` (AAC-LC) or `opus`. */
  readonly codec: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly decoderConfig: AudioDecoderConfig | null;
}

/** Both bounds hold at once; eviction happens in whole groups of pictures (GOPs). */
export interface RingBufferBounds {
  /** Seconds of video, from the first frame's timestamp to the end of the last. */
  readonly maxSeconds: number;
  /** Bytes of video and audio together. */
  readonly maxBytes: number;
}

export const DEFAULT_BOUNDS: RingBufferBounds = { maxSeconds: 90, maxBytes: 160_000_000 };

/**
 * Beyond this difference between the audio's arrival offset and the video's (ms), the audio's
 * timestamps are taken to count on a clock of their own, and are put on the frames' clock by that
 * difference (issue #33). On the devices measured both count on the system's monotonic clock, and
 * the offsets differ by a few ms, the pipelines' latencies (docs/DEVICES.md).
 */
export const AUDIO_REBASE_MS = 100;

/** The newest chunks of each kind whose arrival offsets the audio's placement is the median of. */
const OFFSET_WINDOW = 256;

/**
 * Encoded chunks in the order the encoders produced them. The video always starts at a keyframe:
 * when a bound is exceeded, the oldest GOP (a keyframe and the deltas up to the next keyframe) goes
 * as a whole, never the GOP being written, and the audio goes up to the same horizon (the chunks
 * that end at or before the first frame). Chunks must come in timestamp order, as WebCodecs
 * encoders without frame reordering emit them.
 *
 * The audio's timestamps are compared with the frames' as they are when both count on one clock,
 * and otherwise through their arrival offsets (`audioOffsetFromVideoMs`, `audioRebaseUs`), measured
 * at every keyframe: so that audio on a clock of its own is neither dropped at once nor kept for
 * ever (issue #33).
 */
export class RingBuffer {
  readonly bounds: RingBufferBounds;
  #video: EncodedChunkRecord[] = [];
  #audio: EncodedChunkRecord[] = [];
  #bytes = 0;
  #discarded = 0;
  #videoTrack: VideoTrackInfo | null = null;
  #audioTrack: AudioTrackInfo | null = null;
  /** The audio's arrival offset minus the video's, measured at the last keyframe; null before. */
  #audioOffsetFromVideoMs: number | null = null;

  constructor(bounds: Partial<RingBufferBounds> = {}) {
    this.bounds = { ...DEFAULT_BOUNDS, ...bounds };
  }

  /** The video chunks, oldest first; the first is a keyframe. */
  get video(): readonly EncodedChunkRecord[] {
    return this.#video;
  }

  /** The audio chunks, oldest first. */
  get audio(): readonly EncodedChunkRecord[] {
    return this.#audio;
  }

  /** Seconds of video held: from the first frame's timestamp to the end of the last frame. */
  get bufferSeconds(): number {
    if (this.#video.length === 0) {
      return 0;
    }
    const first = this.#video[0];
    const last = this.#video[this.#video.length - 1];
    return (last.timestampUs + last.durationUs - first.timestampUs) / 1e6;
  }

  /** Bytes of video and audio held. */
  get bufferBytes(): number {
    return this.#bytes;
  }

  /** Delta chunks refused because no keyframe preceded them (they could not be decoded). */
  get discarded(): number {
    return this.#discarded;
  }

  get videoTrack(): VideoTrackInfo | null {
    return this.#videoTrack;
  }

  get audioTrack(): AudioTrackInfo | null {
    return this.#audioTrack;
  }

  /**
   * The audio's arrival offset minus the video's, ms: each the median of `arrivalHostMs −
   * timestampUs / 1000` over the newest chunks of its kind, measured at every keyframe. A few ms
   * when the audio's timestamps count on the frames' clock; null until both kinds are held.
   */
  get audioOffsetFromVideoMs(): number | null {
    return this.#audioOffsetFromVideoMs;
  }

  /**
   * What to add to an audio chunk's timestamp for the frames' timestamp of the same moment, µs: 0
   * when both count on one clock (their arrival offsets within {@link AUDIO_REBASE_MS}), else the
   * difference of the arrival offsets.
   */
  get audioRebaseUs(): number {
    const offset = this.#audioOffsetFromVideoMs;
    return offset === null || Math.abs(offset) <= AUDIO_REBASE_MS ? 0 : Math.round(offset * 1000);
  }

  /** Describes the video to come; the decoder config arrives later with the encoder's output. */
  setVideoTrack(track: Omit<VideoTrackInfo, 'decoderConfig'>): void {
    this.#videoTrack = { ...track, decoderConfig: null };
  }

  setVideoDecoderConfig(config: VideoDecoderConfig): void {
    if (this.#videoTrack !== null) {
      this.#videoTrack = { ...this.#videoTrack, decoderConfig: config };
    }
  }

  setAudioTrack(track: Omit<AudioTrackInfo, 'decoderConfig'>): void {
    this.#audioTrack = { ...track, decoderConfig: null };
  }

  setAudioDecoderConfig(config: AudioDecoderConfig): void {
    if (this.#audioTrack !== null) {
      this.#audioTrack = { ...this.#audioTrack, decoderConfig: config };
    }
  }

  /** Adds a chunk, then evicts whole GOPs (and the audio before them) until both bounds hold. */
  push(chunk: EncodedChunkRecord): void {
    if (chunk.kind === 'video') {
      if (this.#video.length === 0 && chunk.type !== 'key') {
        this.#discarded += 1;
        return;
      }
      this.#video.push(chunk);
    } else {
      this.#audio.push(chunk);
    }
    this.#bytes += chunk.byteLength;
    // At every keyframe (once a second), and as soon as both kinds are held, before the first
    // frame evicts any audio.
    if ((chunk.kind === 'video' && chunk.type === 'key') || this.#audioOffsetFromVideoMs === null) {
      this.#measureAudioOffset();
    }
    this.#evict();
  }

  /** Forgets every chunk (the track descriptions stay). */
  clear(): void {
    this.#video = [];
    this.#audio = [];
    this.#bytes = 0;
    this.#audioOffsetFromVideoMs = null;
  }

  #measureAudioOffset(): void {
    if (this.#video.length > 0 && this.#audio.length > 0) {
      this.#audioOffsetFromVideoMs =
        medianOffsetMs(this.#audio.slice(-OFFSET_WINDOW)) -
        medianOffsetMs(this.#video.slice(-OFFSET_WINDOW));
    }
  }

  #evict(): void {
    const { maxSeconds, maxBytes } = this.bounds;
    while (this.bufferSeconds > maxSeconds || this.#bytes > maxBytes) {
      const nextGop = this.#video.findIndex((chunk, index) => index > 0 && chunk.type === 'key');
      if (nextGop < 0) {
        break;
      }
      this.#bytes -= byteSum(this.#video.splice(0, nextGop));
      this.#evictAudioBefore(this.#video[0].timestampUs);
    }
    if (this.#video.length > 0) {
      this.#evictAudioBefore(this.#video[0].timestampUs);
    } else {
      this.#evictAudioAlone(maxSeconds, maxBytes);
    }
  }

  /** Drops the audio that ends at or before the first frame, whose timestamp is `frameUs`. */
  #evictAudioBefore(frameUs: number): void {
    // The first frame's time on the audio's clock.
    const horizonUs = frameUs - this.audioRebaseUs;
    const keep = this.#audio.findIndex((chunk) => chunk.timestampUs + chunk.durationUs > horizonUs);
    const drop = keep < 0 ? this.#audio.length : keep;
    if (drop > 0) {
      this.#bytes -= byteSum(this.#audio.splice(0, drop));
    }
  }

  /** Before the first keyframe, the audio is bounded on its own. */
  #evictAudioAlone(maxSeconds: number, maxBytes: number): void {
    const newest = this.#audio.at(-1);
    if (newest === undefined) {
      return;
    }
    const horizonUs = newest.timestampUs + newest.durationUs - maxSeconds * 1e6;
    let drop = 0;
    let bytes = this.#bytes;
    for (const chunk of this.#audio) {
      if (chunk.timestampUs >= horizonUs && bytes <= maxBytes) {
        break;
      }
      bytes -= chunk.byteLength;
      drop += 1;
    }
    if (drop > 0) {
      this.#audio.splice(0, drop);
      this.#bytes = bytes;
    }
  }
}

function byteSum(chunks: readonly EncodedChunkRecord[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
}

/** The median of `arrivalHostMs − timestampUs / 1000` over `chunks` (at least one). */
function medianOffsetMs(chunks: readonly EncodedChunkRecord[]): number {
  const offsets = chunks
    .map((chunk) => chunk.arrivalHostMs - chunk.timestampUs / 1000)
    .sort((a, b) => a - b);
  const middle = Math.floor(offsets.length / 2);
  return offsets.length % 2 === 1 ? offsets[middle] : (offsets[middle - 1] + offsets[middle]) / 2;
}
