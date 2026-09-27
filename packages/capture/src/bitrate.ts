// The video encoder's bitrate (docs/PLAN.md, T2.10; issue #33): a quality sets it at 1920×1080 and
// 30 fps, and the frame size and rate scale it. The first recordings on a real camera used all of the
// 8 Mbps asked for then, 35–42 MB per attempt (docs/DEVICES.md, "First recordings"), so Standard, the
// default, asks half of that. Plain TypeScript, for the capture worker, which configures its encoder
// with it, and for the app, which shows the bitrate of each quality.

/**
 * How much the video encoder is asked to keep of the picture: `standard` (the default), `high` (the
 * 8 Mbps at 1080p30 of the first recordings) or `maximum`.
 */
export type VideoQuality = 'standard' | 'high' | 'maximum';

/** Each quality's bitrate at 1920×1080 and 30 fps, bits per second. */
export const BITRATE_AT_1080P30: Readonly<Record<VideoQuality, number>> = {
  standard: 4_000_000,
  high: 8_000_000,
  maximum: 12_000_000,
};

/** Above this frame rate a frame size takes {@link HIGH_FRAME_RATE_FACTOR} times its bitrate. */
const HIGH_FRAME_RATE_FPS = 45;

/**
 * Twice the frames for 1.5 times the bits: consecutive frames differ less at 60 fps (the 8 and
 * 12 Mbps of 1080p30 and 1080p60 before T2.10).
 */
const HIGH_FRAME_RATE_FACTOR = 1.5;

/**
 * The bitrate the video encoder is configured with, bits per second: the quality's at 1080p30
 * ({@link BITRATE_AT_1080P30}), in proportion to the pixels at other frame sizes (1280×720 takes 0.44
 * times as much, a phone's 1080×1920 as much as 1920×1080), and 1.5 times as much above 45 fps.
 * `high` is the rule every recording had before T2.10: 8 Mbps at 1080p30, 12 at 1080p60.
 */
export function videoBitrate(
  width: number,
  height: number,
  fps: number,
  quality: VideoQuality,
): number {
  const rate = fps > HIGH_FRAME_RATE_FPS ? HIGH_FRAME_RATE_FACTOR : 1;
  return Math.round((BITRATE_AT_1080P30[quality] * rate * width * height) / (1920 * 1080));
}
