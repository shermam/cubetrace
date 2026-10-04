// The live preview (docs/RTC.md §10, docs/PLAN.md T4.3): a small video track of the phone's camera,
// sent over the connection that carries the data channel, for the host to frame the cube by. It is
// never data: nothing of it is recorded, and the phone's own recording is not touched (the same
// camera track feeds both, the preview's encoder scaling it down). The phone adds a send-only video
// transceiver before its first offer (webrtc.ts), so that turning the picture on and off needs no
// new offer: it sends its camera's track capped by `PREVIEW_ENCODING` once the host asks for it
// (`preview` of the protocol), and nothing otherwise. Plain TypeScript: the types and the reading of
// the statistics; the browser's API is webrtc.ts's.

/**
 * How the preview is encoded (`RTCRtpEncodingParameters`): a fifth of the camera's resolution (384 ×
 * 216 of a 1920 × 1080 camera, 216 × 384 of a phone's upright frames), at most 300 kbps and 15 frames
 * a second, so that its encoder costs the phone a few milliseconds a frame beside the recording's.
 */
export const PREVIEW_ENCODING = {
  scaleResolutionDownBy: 5,
  maxBitrate: 300_000,
  maxFramerate: 15,
} as const;

/** The preview's video over one connection: the phone sends it, the host receives it. */
export interface PreviewChannel {
  /**
   * The phone: sends `track` as the preview, capped as {@link PREVIEW_ENCODING} says, or nothing
   * (null: the encoder stops). The host's resolves and does nothing.
   */
  send(track: MediaStreamTrack | null): Promise<void>;
  /** The host: the track the phone's offer brought; null before it came, and on the phone. */
  readonly track: MediaStreamTrack | null;
  /** The host: calls `next` with the track when it comes (at once with the one there is). */
  onTrack(next: (track: MediaStreamTrack) => void): () => void;
  /** The statistics of the preview's stream: sent on the phone, received on the host; null when none. */
  stats(): Promise<PreviewStats | null>;
}

/** What the browser says of the preview's stream (`RTCOutboundRtpStreamStats`, `…Inbound…`). */
export interface PreviewStats {
  /** The frames encoded (the phone) or decoded (the host) since the stream began. */
  frames: number;
  /** The frames a second the browser measures now; null when it does not say. */
  fps: number | null;
  /** The size of the frames encoded or decoded last; null when it does not say. */
  width: number | null;
  height: number | null;
  /** The bytes sent or received since the stream began (the payload). */
  bytes: number;
  /** The phone: the encoder's time on all those frames, in ms (`totalEncodeTime`); null otherwise. */
  encodeMs: number | null;
  /** The encoder's or the decoder's implementation (`libvpx`, a hardware codec's name); null. */
  implementation: string | null;
  /** The phone: why the encoder holds the quality back now (`none`, `cpu`, `bandwidth`, `other`). */
  qualityLimitation: string | null;
  /** The phone: how long the encoder was held back by the CPU since the stream began, in s. */
  cpuLimitedSeconds: number | null;
}

/**
 * The preview's statistics in `report` (the values of an `RTCStatsReport`): of the video stream sent
 * (`outbound`, the phone) or received (`inbound`, the host); null when the report has none.
 */
export function previewStats(
  report: Iterable<unknown>,
  direction: 'outbound' | 'inbound',
): PreviewStats | null {
  const type = `${direction}-rtp`;
  for (const entry of report) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Reflect.get(entry, 'type') !== type ||
      Reflect.get(entry, 'kind') !== 'video'
    ) {
      continue;
    }
    const number = (key: string): number | null => {
      const value: unknown = Reflect.get(entry, key);
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const text = (key: string): string | null => {
      const value: unknown = Reflect.get(entry, key);
      return typeof value === 'string' ? value : null;
    };
    const durations: unknown = Reflect.get(entry, 'qualityLimitationDurations');
    const cpu: unknown =
      typeof durations === 'object' && durations !== null
        ? Reflect.get(durations, 'cpu')
        : undefined;
    const outbound = direction === 'outbound';
    const encodeSeconds = number('totalEncodeTime');
    return {
      frames: number(outbound ? 'framesEncoded' : 'framesDecoded') ?? 0,
      fps: number('framesPerSecond'),
      width: number('frameWidth'),
      height: number('frameHeight'),
      bytes: number(outbound ? 'bytesSent' : 'bytesReceived') ?? 0,
      encodeMs: outbound && encodeSeconds !== null ? encodeSeconds * 1000 : null,
      implementation: text(outbound ? 'encoderImplementation' : 'decoderImplementation'),
      qualityLimitation: outbound ? text('qualityLimitationReason') : null,
      cpuLimitedSeconds: outbound && typeof cpu === 'number' && Number.isFinite(cpu) ? cpu : null,
    };
  }
  return null;
}
