import { Component, computed, inject } from '@angular/core';
import type { CaptureStats } from '@cubetrace/capture';
import type { MicrophoneInfo } from '@cubetrace/core';

import { SessionService } from '../session/session-service';
import { DEFAULT_CAMERA, SettingsService } from '../settings/settings-service';
import { formatBytes } from '../shared/format-bytes';
import { StorageMeter } from '../shared/storage-meter';
import type { CameraRecording, RecordingStatus } from './camera-recording';
import { microphoneText } from './microphone';
import { RecordingService, STORAGE_FULL } from './recording-service';
import { attemptSizeText, bitrateText, expectedBitrate } from './video-quality';

/** A camera's recording as its block of the panel says it (T5.5: a block per camera). */
interface RecordingBlock {
  readonly recording: CameraRecording;
  /** Its camera's label in the session (`laptop-2`), for its heading when there are several. */
  readonly label: string | null;
  readonly status: RecordingStatus;
  readonly line: string;
  readonly stats: CaptureStats | null;
  readonly frames: string;
  readonly buffer: string;
  readonly codecs: string;
  /** Its error, but the storage meter's: it says that one itself. */
  readonly error: string | null;
  readonly notices: readonly string[];
}

/**
 * The recording's part of Camera settings (docs/PLAN.md, T2.4): whether it records and why not,
 * the pipeline's counters (frames in, encoded and dropped, the buffer, the codecs and the video's
 * bitrate, where the audio is when it is not being encoded, T2.9, and whether the microphone is
 * raw, T2.12), the notices of this recording (no audio, and why; the browser's voice processing
 * kept on), the last clip saved, a clip that failed or was saved short of what was asked (once,
 * until dismissed), and the storage meter with what an attempt takes at the video quality (T2.10).
 * Since T5.5 the state, the counters, the codecs and the notices are each camera's, a block each,
 * named when there are several (the first camera's codecs say the microphone; another's say its
 * clips have no sound, the microphone recording with the first), and what an attempt takes adds
 * every camera's. The logic is the `RecordingService`'s; this only shows it.
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
      @for (block of blocks(); track block.recording) {
        <div class="camera" data-testid="recording-camera" [attr.data-label]="block.label">
          @if (several()) {
            <h4 data-testid="recording-camera-name">{{ block.label }}</h4>
          }
          <p class="state" data-testid="recording-state" [attr.data-status]="block.status">
            {{ block.line }}
          </p>
          @if (block.stats; as stats) {
            <dl
              class="facts"
              data-testid="recording-stats"
              [attr.data-buffer-seconds]="stats.bufferSeconds"
              [attr.data-dropped]="stats.dropped"
              [attr.data-fps]="stats.encodedFps"
            >
              <dt>Frames</dt>
              <dd>{{ block.frames }}</dd>
              <dt>In memory</dt>
              <dd data-testid="recording-buffer">{{ block.buffer }}</dd>
              <dt>Codecs</dt>
              <dd data-testid="recording-codecs">{{ block.codecs }}</dd>
            </dl>
          }
          @if (block.error; as error) {
            <p class="error" role="alert" data-testid="recording-error">{{ error }}</p>
          }
          @for (notice of block.notices; track notice) {
            <p class="notice" role="status" data-testid="recording-notice">{{ notice }}</p>
          }
        </div>
      } @empty {
        <p class="state" data-testid="recording-state" data-status="off">Off: the camera is off.</p>
      }
      @if (recording.failure(); as failure) {
        <p class="error" role="alert" data-testid="recording-failure">
          A clip could not be saved, and the session's notes say so: {{ failure }}
          <button type="button" class="link" (click)="recording.dismissFailure()">Dismiss</button>
        </p>
      }
      @if (recording.clipNotice(); as clipNotice) {
        <p class="notice" role="status" data-testid="recording-clip-notice">
          {{ clipNotice }} The session's notes say so.
          <button type="button" class="link" (click)="recording.dismissClipNotice()">
            Dismiss
          </button>
        </p>
      }
      @if (lastClip(); as last) {
        <p class="muted" data-testid="recording-last-clip">{{ last }}</p>
      }
      <app-storage-meter />
      <p class="estimate" data-testid="recording-estimate">{{ estimate() }}</p>
      <p class="hint">
        While the camera is on and a session is under way, the last 90 s are kept in memory, and
        every attempt gets two clips in its folder: its scramble from 2 s before the first turn (at
        most a minute before it is done) to 1 s after, and its solve from 3 s before the first turn
        to 1 s after. The solve list shows them. Their sound and size: Record audio, Microphone and
        Video quality, above.
      </p>
    </section>
  `,
  styles: `
    .recording {
      display: grid;
      gap: var(--space-2);
    }

    .camera {
      display: grid;
      gap: var(--space-2);
    }

    h4 {
      margin: 0;
      font-size: 0.875rem;
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
  private readonly session = inject(SessionService);
  private readonly settings = inject(SettingsService);

  /** Several cameras record (T5.5): each block is named. */
  protected readonly several = computed(() => this.recording.recordings().length > 1);
  /** Each camera's recording, as its block says it. */
  protected readonly blocks = computed<readonly RecordingBlock[]>(() => {
    const recordings = this.recording.recordings();
    const first = recordings.at(0);
    const firstLabel = first === undefined ? null : this.recording.labelOf(first.camera);
    const session = this.session.session() !== null;
    return recordings.map((one) => {
      const status = one.status();
      const stats = one.stats();
      const error = one.error();
      return {
        recording: one,
        label: this.recording.labelOf(one.camera),
        status,
        line: stateLine(status, one.camera.stream() !== null, session),
        stats,
        frames:
          stats === null
            ? ''
            : `${String(stats.fps)} per second in, ${String(stats.encodedFps)} encoded, ` +
              `${String(stats.dropped)} dropped`,
        buffer:
          stats === null
            ? ''
            : `${stats.bufferSeconds.toFixed(1)} s, ${formatBytes(stats.bufferBytes)}`,
        codecs:
          stats === null
            ? ''
            : codecsText(
                stats,
                one.microphone(),
                one !== first && this.settings.recordAudio() ? firstLabel : null,
              ),
        error: error === STORAGE_FULL ? null : error,
        notices: one.notices(),
      };
    });
  });
  /**
   * What an attempt's clips take at the video quality: every camera's, at the bitrate it records at
   * now, else at the one its resolution and frame rate give (Settings' without a camera on).
   */
  protected readonly estimate = computed(() => {
    const quality = this.settings.videoQuality();
    const recordings = this.recording.recordings();
    const expected = (label: string): number => {
      const mode = this.settings.cameraModeFor(label);
      return expectedBitrate(quality, mode.resolution, mode.frameRate);
    };
    const bitrates =
      recordings.length === 0
        ? [expected(DEFAULT_CAMERA)]
        : recordings.map((one) => one.stats()?.bitrate ?? expected(one.camera.label()));
    const total = bitrates.reduce((sum, bitrate) => sum + bitrate, 0);
    return `${attemptSizeText(total)} at this quality${bitrates.length > 1 ? `, ${String(bitrates.length)} cameras` : ''}`;
  });
  protected readonly lastClip = computed(() => {
    const last = this.recording.lastClip();
    if (last === null) {
      return null;
    }
    const { clip, index } = last;
    const camera = this.several() ? ` (${clip.camera})` : '';
    return (
      `Last clip: the ${clip.segment} of attempt ${String(index)}${camera}, ` +
      `${String(clip.frames)} frames, ${formatBytes(clip.bytes)}.`
    );
  });
}

/** What a camera's recording does, in words. */
function stateLine(status: RecordingStatus, streaming: boolean, session: boolean): string {
  switch (status) {
    case 'off':
      return streaming
        ? 'Off: it starts with the session, once a cube is connected.'
        : 'Off: the camera is off.';
    case 'starting':
      return 'Starting…';
    case 'recording':
      return session
        ? 'Recording: every attempt gets its clips.'
        : 'Recording, for the session that starts with the next attempt.';
    case 'error':
      return 'Not recording.';
  }
}

/**
 * "avc1.640028 at 4 Mbps, mp4a.40.2, mic raw": the video's codec and bitrate, then the audio's
 * codec, or where the audio is when it is not being encoded (T2.9), then, with a microphone, how
 * it records (T2.12): "mic raw", "mic voice", or "mic: the browser kept processing on"; a camera
 * after the first while the sound is recorded (T5.5): "no sound (the microphone records with
 * laptop)", `withFirst` being the first camera's label.
 */
function codecsText(
  stats: CaptureStats,
  microphone: MicrophoneInfo | null,
  withFirst: string | null,
): string {
  const video =
    stats.codec === null
      ? 'choosing…'
      : stats.bitrate === null
        ? stats.codec
        : `${stats.codec} at ${bitrateText(stats.bitrate)}`;
  if (withFirst !== null) {
    return `${video}, no sound (the microphone records with ${withFirst})`;
  }
  const mic =
    microphone === null || stats.audioState === 'off' ? '' : `, ${microphoneText(microphone)}`;
  return `${video}, ${audioText(stats)}${mic}`;
}

/**
 * The audio's part of the codecs line: its codec while it is encoded, else where it is (T2.9): none
 * asked for, nothing from the microphone yet, or stopped (a notice says why).
 */
function audioText(stats: CaptureStats): string {
  switch (stats.audioState) {
    case 'encoding':
      return stats.audioCodec ?? 'no audio';
    case 'off':
      return 'no audio';
    case 'waiting':
      return 'no audio yet (waiting for the microphone)';
    case 'stopped':
      return 'audio stopped';
  }
}
