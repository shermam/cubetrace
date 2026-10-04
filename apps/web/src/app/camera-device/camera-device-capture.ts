import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import {
  NO_AUDIO_DATA,
  type CaptureHandle,
  type CaptureStats,
  type CaptureSupport,
  type SaveClipParams,
  type SavedClip,
  type VideoQuality,
} from '@cubetrace/capture';
import type { MicrophoneInfo, MicrophoneProcessing } from '@cubetrace/core';

import { CAPTURE_STARTER, type RecordingStatus } from '../camera/recording-service';
import { CameraService } from '../camera/camera-service';
import { openMicrophone } from '../camera/microphone';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { STORAGE_STOP_PERCENT, StorageService } from '../device/storage-service';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';

/** What the pipeline is to run on: the camera's stream, with or without the microphone, at a quality. */
interface Target {
  readonly stream: MediaStream;
  readonly audio: boolean;
  readonly processing: MicrophoneProcessing;
  readonly quality: VideoQuality;
}

/**
 * The recording of a camera device (docs/PLAN.md T4.1): the capture pipeline of phase 2
 * (`@cubetrace/capture`'s `startCapture`: WebCodecs in a worker, the ring buffer of the last 90 s)
 * on the phone's camera, with the microphone as Settings say (Record audio, Raw or Voice: the same
 * `openMicrophone` as the host's recording) at the video quality of Settings, while the Camera page
 * wants it (`setWanted`), so that the ring buffer fills from the moment the phone is a camera and
 * the first cut of T4.2 has its margin. It starts again when the stream changes (another camera,
 * another resolution) or one of those settings does, and stops when the camera goes off, the page
 * lets it go, or storage is {@link STORAGE_STOP_PERCENT}% full. No session of its own: the host's
 * cuts come through `CameraDeviceClips` (T4.2), which saves them with {@link saveClip}; the
 * `RecordingService` of the host is not used here, since it follows the host's session and cube and
 * would bring the timer's code onto the phone's page.
 */
@Injectable({ providedIn: 'root' })
export class CameraDeviceCapture {
  private readonly camera = inject(CameraService);
  private readonly settings = inject(SettingsService);
  private readonly storage = inject(StorageService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly starter = inject(CAPTURE_STARTER);
  private readonly diagnostics = inject(DiagnosticsService);

  private readonly wantedSignal = signal(false);
  private readonly statusSignal = signal<RecordingStatus>('off');
  private readonly statsSignal = signal<CaptureStats | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  private readonly noticesSignal = signal<readonly string[]>([]);
  private readonly microphoneSignal = signal<MicrophoneInfo | null>(null);

  /** The Camera page wants the pipeline running. */
  readonly wanted = this.wantedSignal.asReadonly();
  /** `off`, `starting`, `recording` (the ring buffer fills), `error` (`error` says why). */
  readonly status = this.statusSignal.asReadonly();
  /** The pipeline's counters, once per second; null while it is not running. */
  readonly stats = this.statsSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  /** What it records otherwise than asked, since the pipeline started (no audio, and why). */
  readonly notices = this.noticesSignal.asReadonly();
  /** The microphone of the recording, as the browser applied it; null without one. */
  readonly microphone = this.microphoneSignal.asReadonly();
  /** The browser can record (Chrome); the APIs it lacks otherwise. */
  readonly support: CaptureSupport;

  private handle: CaptureHandle | null = null;
  private microphoneStream: MediaStream | null = null;
  private target: Target | null = null;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private announced: CaptureHandle | null = null;

  constructor() {
    this.support = this.starter.support();
    effect(() => {
      const wanted = this.wantedSignal();
      const stream = this.camera.stream();
      const full = this.storage.level() === 'full';
      const audio = this.settings.recordAudio();
      const processing = this.settings.microphoneProcessing();
      const quality = this.settings.videoQuality();
      untracked(() => {
        this.reconcile(wanted, stream, full, { audio, processing, quality });
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.target = null;
      void this.serially(() => this.stopPipeline());
    });
  }

  /** The Camera page wants the pipeline running (true), or lets it go. */
  setWanted(on: boolean): void {
    this.wantedSignal.set(on);
  }

  /** Resolves once the starts and stops asked for so far are done (for tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * Saves a clip from the pipeline's buffer (`CaptureHandle.saveClip`: cut, muxed and written by the
   * clip worker), for the host's cuts (T4.2, `CameraDeviceClips`). Rejects while the pipeline does
   * not run.
   */
  saveClip(params: SaveClipParams): Promise<SavedClip> {
    const handle = this.handle;
    if (handle === null) {
      return Promise.reject(new Error('the phone is not recording'));
    }
    return handle.saveClip(params);
  }

  private reconcile(
    wanted: boolean,
    stream: MediaStream | null,
    full: boolean,
    asked: Omit<Target, 'stream'>,
  ): void {
    const recording = wanted && stream !== null && !full && this.support.supported;
    if (!recording) {
      if (this.target === null && this.handle === null) {
        this.showIdle(wanted, stream, full);
        return;
      }
      this.target = null;
      const generation = ++this.generation;
      const stats = this.statsSignal();
      this.diagnostics.record('recording.stopped', {
        why: !wanted
          ? 'left'
          : stream === null
            ? 'camera-off'
            : full
              ? 'storage-full'
              : 'unsupported',
        dropped: stats?.dropped ?? null,
        bufferSeconds: stats?.bufferSeconds ?? null,
        encodedFps: stats?.encodedFps ?? null,
      });
      void this.serially(async () => {
        await this.stopPipeline();
        if (generation === this.generation) {
          this.showIdle(wanted, stream, full);
        }
      });
      return;
    }
    const target = this.target;
    if (
      target?.stream === stream &&
      target.audio === asked.audio &&
      target.quality === asked.quality &&
      (!asked.audio || target.processing === asked.processing)
    ) {
      return;
    }
    const generation = ++this.generation;
    const next: Target = { stream, ...asked };
    this.target = next;
    void this.serially(async () => {
      await this.stopPipeline();
      if (generation === this.generation) {
        await this.startPipeline(generation, next);
      }
    });
  }

  private showIdle(wanted: boolean, stream: MediaStream | null, full: boolean): void {
    this.statsSignal.set(null);
    if (wanted && stream !== null && full) {
      this.statusSignal.set('error');
      this.errorSignal.set(
        `Storage is ${String(STORAGE_STOP_PERCENT)}% full: recording stopped. Export or delete sessions to record again.`,
      );
    } else if (wanted && stream !== null && !this.support.supported) {
      this.statusSignal.set('error');
      this.errorSignal.set(
        `This browser cannot record video (no ${this.support.missing.join(', ')}): recording needs Chrome.`,
      );
    } else {
      this.statusSignal.set('off');
      this.errorSignal.set(null);
    }
    this.noticesSignal.set([]);
  }

  private async startPipeline(generation: number, target: Target): Promise<void> {
    const { stream, audio, processing, quality } = target;
    this.statusSignal.set('starting');
    this.errorSignal.set(null);
    this.noticesSignal.set([]);
    this.statsSignal.set(null);
    const video = stream.getVideoTracks().at(0);
    if (video === undefined) {
      this.fail(generation, 'The camera sends no video.');
      return;
    }
    const microphone = audio
      ? await openMicrophone(this.globals.navigator?.mediaDevices, processing)
      : null;
    if (generation !== this.generation) {
      stopStream(microphone?.stream ?? null);
      return;
    }
    if (microphone?.notice !== null && microphone?.notice !== undefined) {
      this.addNotice(microphone.notice);
    }
    this.microphoneStream = microphone?.stream ?? null;
    this.microphoneSignal.set(microphone?.info ?? null);
    const audioTrack = microphone?.stream?.getAudioTracks().at(0) ?? null;
    let handle: CaptureHandle;
    try {
      handle = this.starter.start(video, audioTrack, { audio: audioTrack !== null, quality });
    } catch (error: unknown) {
      this.fail(generation, `Recording could not start: ${errorMessage(error)}`);
      return;
    }
    this.handle = handle;
    handle.onStats((stats) => {
      if (this.handle !== handle) {
        return;
      }
      this.statsSignal.set(stats);
      if (this.statusSignal() === 'starting' && stats.bufferSeconds > 0) {
        this.statusSignal.set('recording');
      }
      if (this.announced !== handle && stats.codec !== null) {
        this.announced = handle;
        const settings = video.getSettings();
        this.diagnostics.record('recording.started', {
          camera: this.camera.identity()?.label ?? null,
          codec: stats.codec,
          audioCodec: stats.audioCodec,
          bitrate: stats.bitrate,
          quality,
          audio,
          processing: microphone?.info?.processing ?? null,
          width: settings.width ?? null,
          height: settings.height ?? null,
          fps: settings.frameRate ?? null,
          remote: true,
        });
      }
      if (stats.audioState === 'encoding' && this.noticesSignal().includes(NO_AUDIO_DATA)) {
        this.noticesSignal.update((notices) => notices.filter((n) => n !== NO_AUDIO_DATA));
      }
    });
    handle.onError((error) => {
      if (this.handle !== handle) {
        return;
      }
      if (error.fatal) {
        this.statusSignal.set('error');
        this.errorSignal.set(`Recording stopped: ${error.message}`);
        this.diagnostics.record('error.app', {
          where: 'recording',
          message: `Recording stopped: ${error.message}`,
        });
      } else {
        this.addNotice(error.message);
      }
    });
    void this.storage.refresh();
  }

  private addNotice(message: string): void {
    if (!this.noticesSignal().includes(message)) {
      this.noticesSignal.update((notices) => [...notices, message]);
      this.diagnostics.record('recording.notice', { message });
    }
  }

  private async stopPipeline(): Promise<void> {
    const handle = this.handle;
    const microphone = this.microphoneStream;
    this.handle = null;
    this.microphoneStream = null;
    this.statsSignal.set(null);
    await handle?.stop();
    stopStream(microphone);
  }

  private fail(generation: number, message: string): void {
    if (generation !== this.generation) {
      return;
    }
    this.statusSignal.set('error');
    this.errorSignal.set(message);
    this.diagnostics.record('error.app', { where: 'recording', message });
  }

  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}
