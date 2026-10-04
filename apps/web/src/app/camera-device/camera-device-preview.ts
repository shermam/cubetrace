import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { CaptureStats } from '@cubetrace/capture';
import {
  PREVIEW_ENCODING,
  type MessageLink,
  type PreviewChannel,
  type PreviewStats,
  type Transport,
} from '@cubetrace/rtc';

import { CameraService } from '../camera/camera-service';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { errorMessage } from '../shared/error-message';
import { CameraDeviceCapture } from './camera-device-capture';

/** How often the preview's statistics are read while it is sent, ms: its last facts at a stop. */
export const PREVIEW_STATS_MS = 5000;

/** Why the preview stopped: the host's setting, the camera, the connection. */
export type PreviewStop = 'off' | 'camera' | 'connection';

/** The recording's counters over a span of seconds (`CaptureStats`, once a second). */
interface Span {
  startedMs: number;
  seconds: number;
  fps: number;
  encodedFps: number;
  minFps: number | null;
  droppedFrom: number | null;
  droppedTo: number | null;
}

/** What is sent now: the channel, the track, since when, and the preview's last statistics. */
interface Sending {
  readonly channel: PreviewChannel;
  track: MediaStreamTrack;
  readonly sinceMs: number;
  last: PreviewStats | null;
  timer: unknown;
}

/**
 * The live preview of the camera device (docs/PLAN.md T4.3, docs/RTC.md §10): while the host asks
 * for it (`preview` of the protocol, its "Live preview from phones"), the phone sends its camera's
 * track over the connection's preview channel, which the transport caps at a fifth of the resolution,
 * 300 kbps and 15 fps (`PREVIEW_ENCODING`); another camera's track replaces it as the camera changes;
 * the host's word off, the camera off or the connection's end stop it. The recording is the capture
 * pipeline's and is not touched: the same camera track feeds both. For the owner's measurement of
 * what the preview costs the phone ("with and without"), each start says, in `preview.started`, how
 * the recording went in the span before it (without the preview: its frame rate measured, encoded,
 * the frames dropped), and each stop, in `preview.stopped`, how the preview's encoder went (its
 * frames, rate, bitrate, time per frame, implementation, the share of time the CPU held it back) and
 * the recording in the same span (with it).
 */
@Injectable({ providedIn: 'root' })
export class CameraDevicePreview {
  private readonly camera = inject(CameraService);
  private readonly capture = inject(CameraDeviceCapture);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly timers = inject(RTC_TIMERS);

  private readonly wantedSignal = signal(false);
  private readonly channelSignal = signal<PreviewChannel | null>(null);
  private readonly sendingSignal = signal(false);

  /** The phone sends its live picture to the host now. */
  readonly sending = this.sendingSignal.asReadonly();
  /** The host asked for the live picture (its setting), over the current connection. */
  readonly wanted = this.wantedSignal.asReadonly();

  private current: Sending | null = null;
  private span: Span = emptySpan(0);
  /** The sends and stops in order: the channel's calls never overtake one another. */
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    this.span = emptySpan(this.timers.now());
    effect(() => {
      const channel = this.channelSignal();
      const wanted = this.wantedSignal();
      const track = this.camera.stream()?.getVideoTracks().at(0) ?? null;
      untracked(() => {
        this.reconcile(channel, wanted, track);
      });
    });
    effect(() => {
      const stats = this.capture.stats();
      untracked(() => {
        if (stats !== null) {
          this.count(stats);
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.stop('connection');
    });
  }

  /**
   * A connection with the host is open: its `preview` word is heard, and its transport's preview
   * channel used (none on a transport without media). Returns what lets it go, which stops the
   * preview.
   */
  attach(link: MessageLink, transport: Transport): () => void {
    this.wantedSignal.set(false);
    this.channelSignal.set(transport.preview ?? null);
    const off = link.on('preview', (message) => {
      this.wantedSignal.set(message.on);
    });
    return () => {
      off();
      if (this.channelSignal() === (transport.preview ?? null)) {
        this.channelSignal.set(null);
        this.wantedSignal.set(false);
      }
    };
  }

  /** Resolves once the sends and stops asked for so far are done (for the tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  private reconcile(
    channel: PreviewChannel | null,
    wanted: boolean,
    track: MediaStreamTrack | null,
  ): void {
    const current = this.current;
    if (channel === null || !wanted || track === null) {
      if (current !== null) {
        this.stop(channel === null ? 'connection' : wanted ? 'camera' : 'off');
      }
      return;
    }
    if (current?.channel === channel) {
      if (current.track !== track) {
        current.track = track;
        this.serially(() => channel.send(track));
      }
      return;
    }
    if (current !== null) {
      this.stop('connection');
    }
    this.begin(channel, track);
  }

  private begin(channel: PreviewChannel, track: MediaStreamTrack): void {
    const now = this.timers.now();
    const settings = track.getSettings();
    this.diagnostics.record('preview.started', {
      width: settings.width ?? null,
      height: settings.height ?? null,
      scale: PREVIEW_ENCODING.scaleResolutionDownBy,
      maxKbps: PREVIEW_ENCODING.maxBitrate / 1000,
      maxFps: PREVIEW_ENCODING.maxFramerate,
      ...spanFacts(this.span, now),
    });
    this.span = emptySpan(now);
    const sending: Sending = { channel, track, sinceMs: now, last: null, timer: null };
    this.current = sending;
    this.sendingSignal.set(true);
    this.serially(() => channel.send(track));
    this.poll(sending);
  }

  /** Reads the preview's statistics every {@link PREVIEW_STATS_MS} while it is sent. */
  private poll(sending: Sending): void {
    sending.timer = this.timers.setTimeout(() => {
      sending.timer = null;
      if (this.current !== sending) {
        return;
      }
      void sending.channel.stats().then((stats) => {
        if (stats !== null) {
          sending.last = stats;
        }
      });
      this.poll(sending);
    }, PREVIEW_STATS_MS);
  }

  private stop(why: PreviewStop): void {
    const sending = this.current;
    if (sending === null) {
      return;
    }
    this.current = null;
    this.sendingSignal.set(false);
    if (sending.timer !== null) {
      this.timers.clearTimeout(sending.timer);
    }
    const span = this.span;
    const now = this.timers.now();
    this.span = emptySpan(now);
    this.serially(async () => {
      // The statistics before the encoder stops (none once the connection ended: the last read).
      const stats = (await sending.channel.stats()) ?? sending.last;
      if (why !== 'connection') {
        await sending.channel.send(null);
      }
      const seconds = (now - sending.sinceMs) / 1000;
      this.diagnostics.record('preview.stopped', {
        why,
        seconds: Math.round(seconds),
        ...encoderFacts(stats, seconds),
        ...spanFacts(span, now),
      });
    });
  }

  /** One second of the recording's counters, into the span under way. */
  private count(stats: CaptureStats): void {
    const span = this.span;
    span.seconds += 1;
    span.fps += stats.fps;
    span.encodedFps += stats.encodedFps;
    span.minFps = span.minFps === null ? stats.fps : Math.min(span.minFps, stats.fps);
    span.droppedFrom ??= stats.dropped;
    span.droppedTo = stats.dropped;
  }

  private serially(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      console.warn(`cubetrace: camera device: the live preview: ${errorMessage(error)}`);
    });
  }
}

function emptySpan(startedMs: number): Span {
  return {
    startedMs,
    seconds: 0,
    fps: 0,
    encodedFps: 0,
    minFps: null,
    droppedFrom: null,
    droppedTo: null,
  };
}

/**
 * The recording over a span, as the events say it: how long (s), its frame rate measured (the mean
 * and the least of its seconds), encoded, and the frames dropped (when one pipeline ran throughout).
 */
function spanFacts(span: Span, nowMs: number): Record<string, number | null> {
  const round1 = (value: number): number => Math.round(value * 10) / 10;
  const dropped =
    span.droppedFrom === null || span.droppedTo === null || span.droppedTo < span.droppedFrom
      ? null
      : span.droppedTo - span.droppedFrom;
  return {
    spanSeconds: Math.round((nowMs - span.startedMs) / 1000),
    recordingSeconds: span.seconds,
    recordingFps: span.seconds === 0 ? null : round1(span.fps / span.seconds),
    recordingFpsMin: span.minFps === null ? null : round1(span.minFps),
    recordingEncodedFps: span.seconds === 0 ? null : round1(span.encodedFps / span.seconds),
    recordingDropped: dropped,
  };
}

/** The preview's encoder over its `seconds`, from its statistics (null facts without them). */
function encoderFacts(
  stats: PreviewStats | null,
  seconds: number,
): Record<string, string | number | null> {
  const round1 = (value: number): number => Math.round(value * 10) / 10;
  if (stats === null) {
    return { frames: null, fps: null, kbps: null, encodeMsPerFrame: null, encoder: null };
  }
  return {
    frames: stats.frames,
    fps: seconds > 0 ? round1(stats.frames / seconds) : null,
    kbps: seconds > 0 ? Math.round((stats.bytes * 8) / seconds / 1000) : null,
    encodeMsPerFrame:
      stats.encodeMs === null || stats.frames === 0
        ? null
        : Math.round((stats.encodeMs / stats.frames) * 100) / 100,
    encoder: stats.implementation,
    sentWidth: stats.width,
    sentHeight: stats.height,
    qualityLimitation: stats.qualityLimitation,
    cpuLimitedShare:
      stats.cpuLimitedSeconds === null || seconds <= 0
        ? null
        : Math.round((stats.cpuLimitedSeconds / seconds) * 100) / 100,
  };
}
