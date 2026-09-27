import { Component, computed, inject } from '@angular/core';

import { SessionService } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { formatBytes } from '../shared/format-bytes';
import { StorageMeter } from '../shared/storage-meter';
import { CameraService } from './camera-service';
import { RecordingService, STORAGE_FULL } from './recording-service';
import { attemptSizeText, bitrateText, expectedBitrate } from './video-quality';

/**
 * The recording's part of Camera settings (docs/PLAN.md, T2.4): whether it records and why not,
 * the pipeline's counters (frames in, encoded and dropped, the buffer, the codecs and the video's
 * bitrate), the last clip saved, a clip that failed (once, until dismissed), and the storage meter
 * with what an attempt takes at the video quality (T2.10). The logic is the `RecordingService`'s;
 * this only shows it.
 */
@Component({
  selector: 'app-recording-panel',
  imports: [StorageMeter],
  template: `
    <section class="recording" aria-labelledby="recording-heading">
      <h3 id="recording-heading">
        Recording
        @if (recording.status() === 'recording') {
          <span class="rec" data-testid="recording-badge">REC</span>
        }
      </h3>
      <p class="state" data-testid="recording-state" [attr.data-status]="recording.status()">
        {{ line() }}
      </p>
      @if (recording.stats(); as stats) {
        <dl
          class="facts"
          data-testid="recording-stats"
          [attr.data-buffer-seconds]="stats.bufferSeconds"
          [attr.data-dropped]="stats.dropped"
          [attr.data-fps]="stats.encodedFps"
        >
          <dt>Frames</dt>
          <dd>{{ frames() }}</dd>
          <dt>In memory</dt>
          <dd data-testid="recording-buffer">{{ buffer() }}</dd>
          <dt>Codecs</dt>
          <dd data-testid="recording-codecs">{{ codecs() }}</dd>
        </dl>
      }
      @if (error(); as error) {
        <p class="error" role="alert" data-testid="recording-error">{{ error }}</p>
      }
      @if (recording.notice(); as notice) {
        <p class="notice" role="status" data-testid="recording-notice">{{ notice }}</p>
      }
      @if (recording.failure(); as failure) {
        <p class="error" role="alert" data-testid="recording-failure">
          A clip could not be saved, and the session's notes say so: {{ failure }}
          <button type="button" class="link" (click)="recording.dismissFailure()">Dismiss</button>
        </p>
      }
      @if (lastClip(); as last) {
        <p class="muted" data-testid="recording-last-clip">{{ last }}</p>
      }
      <app-storage-meter />
      <p class="estimate" data-testid="recording-estimate">{{ estimate() }}</p>
      <p class="hint">
        While the camera is on and a session is under way, the last 90 s are kept in memory, and
        every attempt gets two clips in its folder: its scramble from 2 s before the first turn to 1
        s after, and its solve from 3 s before the first turn to 1 s after. The solve list shows
        them. Their sound and size: Record audio and Video quality, above.
      </p>
    </section>
  `,
  styles: `
    .recording {
      display: grid;
      gap: var(--space-2);
    }

    h3 {
      display: flex;
      gap: var(--space-2);
      align-items: center;
      margin: 0;
      font-size: 1rem;
    }

    p {
      margin: 0;
    }

    .rec {
      padding: 0 var(--space-2);
      border-radius: 999px;
      background: var(--danger);
      color: var(--on-accent);
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.05em;
    }

    .state,
    .muted,
    .estimate,
    .hint,
    dt {
      color: var(--text-muted);
    }

    .state,
    .estimate {
      font-size: 0.875rem;
    }

    .hint {
      font-size: 0.75rem;
    }

    .error {
      color: var(--danger);
    }

    .notice {
      color: var(--warn);
    }

    .facts {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--space-1) var(--space-3);
      margin: 0;
      font-size: 0.875rem;
    }

    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }

    .link {
      margin-left: var(--space-2);
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent);
      text-decoration: underline;
    }
  `,
})
export class RecordingPanel {
  protected readonly recording = inject(RecordingService);
  private readonly camera = inject(CameraService);
  private readonly session = inject(SessionService);
  private readonly settings = inject(SettingsService);

  protected readonly line = computed(() => {
    switch (this.recording.status()) {
      case 'off':
        return this.camera.stream() === null
          ? 'Off: the camera is off.'
          : 'Off: it starts with the session, once a cube is connected.';
      case 'starting':
        return 'Starting…';
      case 'recording':
        return this.session.session() === null
          ? 'Recording, for the session that starts with the next attempt.'
          : 'Recording: every attempt gets its clips.';
      case 'error':
        return 'Not recording.';
    }
  });
  /** The error, but the storage meter's: it says that one itself. */
  protected readonly error = computed(() => {
    const error = this.recording.error();
    return error === STORAGE_FULL ? null : error;
  });
  protected readonly frames = computed(() => {
    const stats = this.recording.stats();
    return stats === null
      ? ''
      : `${String(stats.fps)} per second in, ${String(stats.encodedFps)} encoded, ` +
          `${String(stats.dropped)} dropped`;
  });
  protected readonly buffer = computed(() => {
    const stats = this.recording.stats();
    return stats === null
      ? ''
      : `${stats.bufferSeconds.toFixed(1)} s, ${formatBytes(stats.bufferBytes)}`;
  });
  /** "avc1.640028 at 4 Mbps, mp4a.40.2": the video's codec and bitrate, then the audio's codec. */
  protected readonly codecs = computed(() => {
    const stats = this.recording.stats();
    if (stats === null) {
      return '';
    }
    const video =
      stats.codec === null
        ? 'choosing…'
        : stats.bitrate === null
          ? stats.codec
          : `${stats.codec} at ${bitrateText(stats.bitrate)}`;
    return `${video}, ${stats.audioCodec ?? 'no audio'}`;
  });
  /**
   * What an attempt's clips take at the video quality: at the bitrate recording now, else at the one
   * Settings' resolution and frame rate give.
   */
  protected readonly estimate = computed(() => {
    const bitrate =
      this.recording.stats()?.bitrate ??
      expectedBitrate(
        this.settings.videoQuality(),
        this.settings.cameraResolution(),
        this.settings.cameraFrameRate(),
      );
    return `${attemptSizeText(bitrate)} at this quality`;
  });
  protected readonly lastClip = computed(() => {
    const last = this.recording.lastClip();
    if (last === null) {
      return null;
    }
    const { clip, index } = last;
    return (
      `Last clip: the ${clip.segment} of attempt ${String(index)}, ${String(clip.frames)} frames, ` +
      `${formatBytes(clip.bytes)}.`
    );
  });
}
