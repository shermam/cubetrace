import { videoBitrate, type VideoQuality } from '@cubetrace/capture';

import {
  CAMERA_RESOLUTION_SIZE,
  VIDEO_QUALITIES,
  VIDEO_QUALITY_TEXT,
  type CameraFrameRate,
  type CameraResolution,
} from '../settings/settings-service';

// The texts of the video quality (docs/PLAN.md, T2.10), in Settings and in the Timer page's Camera
// settings: each quality's bitrate at the resolution and frame rate asked for, and about what an
// attempt's clips take at it. They come from @cubetrace/capture's bitrate rule, the one the capture
// worker encodes with, so this file is camera code: SettingsService, which every page loads, does
// not import it.

/**
 * Seconds of video in an attempt's two clips, for the estimates: 34–41 s in the owner's first
 * recordings (a scramble of 13–16 s and a solve of 20–25 s, with their margins; docs/DEVICES.md,
 * "First recordings"), rounded up, which also covers the sound (128 kbps, 3% of Standard).
 */
export const ATTEMPT_CLIP_SECONDS = 40;

/** A choice of the video quality, as Settings and Camera settings list it. */
export interface VideoQualityOption {
  readonly value: VideoQuality;
  /** "Standard (4 Mbps, ≈ 20 MB per attempt)". */
  readonly label: string;
}

/**
 * The bitrate `quality` gives at the resolution and frame rate asked for. "Best" counts 30 fps,
 * what every camera measured so far delivers at 1080p (docs/DEVICES.md), and "Exactly 60 fps" 60;
 * the encoder takes the frames' real size and rate, which the recording's counters show with its
 * bitrate.
 */
export function expectedBitrate(
  quality: VideoQuality,
  resolution: CameraResolution,
  rate: CameraFrameRate,
): number {
  const { width, height } = CAMERA_RESOLUTION_SIZE[resolution];
  return videoBitrate(width, height, rate === '60' ? 60 : 30, quality);
}

/** A bitrate in megabits per second, to a tenth: "4 Mbps", "1.8 Mbps". */
export function bitrateText(bitsPerSecond: number): string {
  const mbps = Math.round(bitsPerSecond / 100_000) / 10;
  return `${Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1)} Mbps`;
}

/** About what an attempt's two clips take at `bitsPerSecond`, in bytes. */
export function attemptBytes(bitsPerSecond: number): number {
  return Math.round((bitsPerSecond * ATTEMPT_CLIP_SECONDS) / 8);
}

/** "≈ 20 MB per attempt": {@link attemptBytes} in whole megabytes. */
export function attemptSizeText(bitsPerSecond: number): string {
  return `≈ ${String(Math.round(attemptBytes(bitsPerSecond) / 1_000_000))} MB per attempt`;
}

/**
 * The video qualities with their bitrate and size per attempt at the resolution and rate asked for.
 */
export function videoQualityOptions(
  resolution: CameraResolution,
  rate: CameraFrameRate,
): VideoQualityOption[] {
  return VIDEO_QUALITIES.map((value) => {
    const bitrate = expectedBitrate(value, resolution, rate);
    return {
      value,
      label: `${VIDEO_QUALITY_TEXT[value]} (${bitrateText(bitrate)}, ${attemptSizeText(bitrate)})`,
    };
  });
}
