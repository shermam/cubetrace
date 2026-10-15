import { computed, signal } from '@angular/core';
import {
  LatencyDrift,
  NO_AUDIO_DATA,
  type CaptureConfig,
  type CaptureHandle,
  type CaptureStats,
  type CaptureSupport,
  type ClipReport,
  type FramingRect,
  type MotionMeterInfo,
  type MotionSample,
  type VideoQuality,
} from '@cubetrace/capture';
import {
  sameCamera,
  type AttemptRecord,
  type CameraInfo,
  type MicrophoneInfo,
  type MicrophoneProcessing,
  type VideoClip,
  type VideoSegment,
} from '@cubetrace/core';

import { APP_BUILD } from '../../environments/version';
import { hostNow, type BrowserGlobals } from '../device/browser-globals';
import { STORAGE_STOP_PERCENT, type StorageService } from '../device/storage-service';
import type { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { e2eCapture } from '../rtc/e2e-remote';
import type { ClipsInFlight } from '../session/clips-in-flight';
import {
  withCameraLag,
  type AttemptMilestone,
  type AttemptRef,
  type SessionService,
} from '../session/session-service';
import type { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { clipWindow } from './clip-windows';
import type { HostCamera } from './host-camera';
import { signedMs } from './latency-words';
import { openMicrophone } from './microphone';
import { solveMotionPeak } from './solve-motion';

/**
 * Starts the capture pipeline (@cubetrace/capture's `startCapture`) on a video track and, when there
 * is one, an audio track; the unit tests give a fake.
 */
export interface CaptureStarter {
  support(): CaptureSupport;
  start(
    video: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    config: CaptureConfig,
  ): CaptureHandle;
}

/**
 * `off`: not recording (the camera is off, no session is under way, or storage is full: `error`
 * says so then). `starting`: the pipeline is starting (the microphone's permission included).
 * `recording`: the last 90 s are in memory, from which the clips are cut. `error`: it could not
 * start, or it stopped; `error` says why.
 */
export type RecordingStatus = 'off' | 'starting' | 'recording' | 'error';

/** A clip saved, with the attempt it belongs to. */
export interface SavedClip {
  readonly index: number;
  readonly clip: VideoClip;
}

/**
 * A clip is saved this long after its end, so that the frames up to its end have come out of the
 * encoder (tens of milliseconds) and are in the buffer: its cut is then whole.
 */
export const ENCODER_SETTLE_MS = 250;

/** The counters of the last minutes are kept this long for each clip's summary (T5.3), ms. */
export const STATS_KEPT_MS = 180_000;

/**
 * A camera that records less than this share of its frame rate (T5.5: its encoded frames per second
 * against the rate its track reports) for {@link LOAD_WINDOW_MS} while several cameras record is said
 * once per recording: the laptop may not encode them all.
 */
export const LOAD_SHARE = 0.8;

/** How long a camera records under {@link LOAD_SHARE} of its frame rate before it is said, ms. */
export const LOAD_WINDOW_MS = 10_000;

/** What the load notice says (T5.5), after the camera's own numbers. */
export const LOAD_ADVICE =
  'Two cameras may be more than this laptop encodes: turn one off or lower its resolution.';

/** The notice when recording stopped because storage is full. */
export const STORAGE_FULL =
  `Storage is ${String(STORAGE_STOP_PERCENT)}% full: recording stopped (the timer goes on). ` +
  'Export or delete sessions to record again.';

/**
 * The capture pipeline over a clip's span (T5.3, `clip.saved`'s `pipeline`), from its counters of
 * each second, for what the capture latency's meter cannot say alone: where frames queued.
 */
export interface PipelineSummary {
  /**
   * The median share of the frames read in a second that were already waiting when the worker asked
   * for them (`CaptureLatencyStats.waiting`): near 1 when frames queue before the worker and the queue
   * never drains, near 0 when the worker waits for each frame; to 0.01. Null without counters.
   */
  readonly waitingShare: number | null;
  /** The most frames the encoder held when given one, over the span. */
  readonly queueMax: number | null;
  /** The most frames given to the encoder whose chunks had not come out, at a second's end. */
  readonly pendingMax: number | null;
  /**
   * The median time the page's thread took to take the worker's counters (their `postedHostMs` to
   * their arrival), ms to 0.1: a measure of how busy the page's thread was.
   */
  readonly mainDelayMs: number | null;
  /** The seconds of counters over the span. */
  readonly seconds: number;
}

/** The counters of one second, as they came to the page. */
export interface StatsEntry {
  readonly atMs: number;
  readonly stats: CaptureStats;
}

/**
 * The pipeline over `[fromMs, toMs]` from the counters that came then (T5.3): see
 * {@link PipelineSummary}.
 */
export function pipelineSummary(
  entries: readonly StatsEntry[],
  fromMs: number,
  toMs: number,
): PipelineSummary {
  const inSpan = entries.filter((entry) => entry.atMs >= fromMs && entry.atMs <= toMs);
  const latencies = inSpan.flatMap((entry) =>
    entry.stats.latency === null ? [] : [entry.stats.latency],
  );
  const shares = inSpan.flatMap((entry) => {
    const waiting = entry.stats.latency?.waiting;
    return waiting === undefined || entry.stats.fps <= 0
      ? []
      : [Math.min(1, waiting / entry.stats.fps)];
  });
  const delays = inSpan.map((entry) => Math.max(0, entry.atMs - entry.stats.postedHostMs));
  const round = (value: number, step: number): number => Math.round(value / step) * step;
  return {
    waitingShare: shares.length === 0 ? null : round(middle(shares), 0.01),
    queueMax: latencies.length === 0 ? null : Math.max(...latencies.map((l) => l.queueMax)),
    pendingMax: latencies.length === 0 ? null : Math.max(...latencies.map((l) => l.pending)),
    mainDelayMs: delays.length === 0 ? null : Math.round(middle(delays) * 10) / 10,
    seconds: inSpan.length,
  };
}

/** A restart of the recording for a drifting capture latency (T5.3): when, and the drift then. */
export interface LatencyRestart {
  readonly atMs: number;
  readonly deltaMs: number;
}

/**
 * A camera that records under {@link LOAD_SHARE} of its frame rate (T5.5): what it encodes and what
 * its track reports, frames per second.
 */
export interface RecordingLoad {
  readonly encodedFps: number;
  readonly nominalFps: number;
}

/**
 * What a camera's pipeline is to run on: the camera's stream, with or without the microphone (raw or
 * with the browser's voice processing), at a video quality.
 */
export interface RecordingTarget {
  readonly stream: MediaStream;
  readonly audio: boolean;
  /** How the microphone is asked for (T2.12); it matters only with `audio`. */
  readonly processing: MicrophoneProcessing;
  readonly quality: VideoQuality;
}

/** What every camera's recording shares: the app's services, and what it tells the recording service. */
export interface RecordingContext {
  readonly session: SessionService;
  readonly settings: SettingsService;
  readonly storage: StorageService;
  readonly globals: BrowserGlobals;
  readonly starter: CaptureStarter;
  readonly support: CaptureSupport;
  /** The attempts whose clips are still to come, for the upload queue (T3.3). */
  readonly inFlight: ClipsInFlight;
  readonly diagnostics: DiagnosticsService;
  /**
   * Puts the entries of the cameras recording in the session under way, in their order, so that the
   * first gets `laptop` and the next `laptop-2` (T2.14) whichever pipeline starts first.
   */
  readonly putEntries: () => void;
  /** More than one camera records (T5.5): the words and notes name the camera. */
  readonly several: () => boolean;
  /** A clip was saved: the last one, as the panel says. */
  readonly saved: (clip: SavedClip) => void;
  /** A clip could not be saved: its note's line, as the panel says it once. */
  readonly failed: (line: string) => void;
  /** A clip was saved short of what was asked: what it lacks, as the panel says it once. */
  readonly remarked: (text: string) => void;
}

/** A clip waiting for its time, which `save` saves. */
interface PlannedClip {
  readonly timer: number;
  readonly attempt: AttemptRef;
  readonly save: () => Promise<void>;
}

/**
 * The camera of the clips: its entry in the session, under the label the session gives the device
 * (T2.14), and its device id, which the records never keep.
 */
interface RecordedCamera {
  readonly entry: CameraInfo;
  readonly deviceId: string | null;
}

/** The microphone open for a run of the pipeline, and what the browser applied to it. */
interface OpenMicrophone {
  readonly stream: MediaStream;
  /** Null when the stream has no audio track. */
  readonly info: MicrophoneInfo | null;
}

/**
 * The recording of one camera of the host (docs/PLAN.md T2.4; one per camera since T5.5, which
 * `RecordingService` makes and runs): the capture pipeline on the camera's stream, with the
 * microphone's audio when it is the first camera and Settings say so ("Record audio", raw unless
 * Settings say Voice, T2.12), at the video quality Settings say (T2.10); it starts again when the
 * stream changes or one of those does, and stops when the camera goes off, no session is under way,
 * or storage is full (the timer goes on).
 *
 * Every attempt gets two clips from it, cut from the last 90 s the pipeline keeps in memory, as
 * `SessionService.milestones$` says (`clipWindow`); each is saved one second (and
 * {@link ENCODER_SETTLE_MS}) after its end, in the attempt's folder under the label the session gives
 * the camera (`laptop`, `laptop-2`), with the camera's framing rectangle as its `crop`, and added to
 * the attempt's record (`SessionService.attachClip`). A clip whose start is older than the buffer
 * begins at its oldest keyframe (`truncatedStart`, T2.9), said and noted, as is a clip without sound
 * while audio is recorded, with why. A clip that fails is said once and noted; the attempt is
 * untouched. A clip of an attempt that went meanwhile is removed again. Stopping saves the clips
 * still waiting for their time at once, with what the buffer has. Its capture latency's drift from
 * its sync check (T5.3), the solves' motion meter, and the restart for a drifting latency are its
 * own; so is the load notice (T5.5: under 80% of its frame rate for 10 s while several cameras
 * record).
 */
export class CameraRecording {
  private readonly statusSignal = signal<RecordingStatus>('off');
  private readonly statsSignal = signal<CaptureStats | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  private readonly noticesSignal = signal<readonly string[]>([]);
  private readonly savingSignal = signal(0);
  private readonly microphoneSignal = signal<MicrophoneInfo | null>(null);
  private readonly latencyDriftSignal = signal<number | null>(null);
  private readonly restartedSignal = signal<LatencyRestart | null>(null);
  private readonly loadSignal = signal<RecordingLoad | null>(null);
  private readonly audioSignal = signal(false);

  /** See {@link RecordingStatus}. */
  readonly status = this.statusSignal.asReadonly();
  /** The pipeline's counters, once per second; null while it is not running. */
  readonly stats = this.statsSignal.asReadonly();
  /** Why it is not recording: it could not start, it stopped, or storage is full. */
  readonly error = this.errorSignal.asReadonly();
  /**
   * What it records otherwise than asked, since the pipeline started: no audio (the microphone
   * refused, silent or lost, or no encoder for it), the clip worker failed, or more frames than the
   * laptop encodes (T5.5). Each stays until recording starts again, one after the other rather than
   * the last alone, and is noted in the session (`notice: …`), so that none goes unseen (T2.9).
   */
  readonly notices = this.noticesSignal.asReadonly();
  /** How many of its clips are being saved (cut, muxed and written) now. */
  readonly savingClips = this.savingSignal.asReadonly();
  /**
   * The microphone of the recording (T2.12): how it was asked for and what the browser says it
   * applied, from the last start of the pipeline; null when that recording has no microphone
   * (Record audio off, another camera's clips have it, the microphone refused).
   */
  readonly microphone = this.microphoneSignal.asReadonly();
  /** The pipeline runs with the microphone asked for: the first camera's, with Record audio on. */
  readonly audio = this.audioSignal.asReadonly();
  /**
   * While the capture latency of the camera drifts from its value at the camera's last sync check
   * (T5.3, issue #67: `LatencyDrift`, more than 30 ms for 5 s, over the last 10 s): by how much, ms,
   * as the status line says it (`latency +75 ms`); null otherwise, and without a check.
   */
  readonly latencyDrift = this.latencyDriftSignal.asReadonly();
  /**
   * The last time the recording started again for a drifting capture latency (T5.3, "Restart the
   * recording when its latency drifts"), while the drift lasts; null otherwise.
   */
  readonly restarted = this.restartedSignal.asReadonly();
  /**
   * While the camera records under {@link LOAD_SHARE} of its frame rate, once it did for
   * {@link LOAD_WINDOW_MS} with several cameras recording (T5.5): its numbers; null otherwise.
   */
  readonly load = this.loadSignal.asReadonly();
  /** The camera's label in the session under way (`laptop`, `laptop-2`); its own label without one. */
  readonly label = computed(() => {
    const identity = this.camera.identity();
    return identity === null ? null : this.context.session.cameraLabel(identity);
  });

  private handle: CaptureHandle | null = null;
  /** What the pipeline runs on, or is starting on; null when it is to be stopped. */
  private target: RecordingTarget | null = null;
  private microphoneStream: MediaStream | null = null;
  /** The camera's entry while it records: the label and framing of its clips. */
  private cameraEntry: RecordedCamera | null = null;
  /** Incremented by every start and stop: a slower, older start then knows it lost. */
  private generation = 0;
  /** The clips waiting for their time, by attempt and segment. */
  private readonly planned = new Map<string, PlannedClip>();
  /** The clips being saved: a stop waits for them. */
  private readonly saving = new Set<Promise<void>>();
  /** The end of the last start or stop queued: they run one at a time. */
  private queue: Promise<void> = Promise.resolve();
  /** The lines noted once per start of the pipeline (notices, a clip's missing audio). */
  private readonly notedThisRun = new Set<string>();
  /** The run of the pipeline whose `recording.started` was recorded (its first stats). */
  private announced: CaptureHandle | null = null;
  /** The capture latency's drift from the camera's sync check (T5.3), and the camera it watches. */
  private drift = new LatencyDrift();
  private driftLabel: string | null = null;
  /** The counters of the last {@link STATS_KEPT_MS}, for each clip's summary (T5.3). */
  private recentStats: StatsEntry[] = [];
  /** The attempt whose solve the motion meter measures (T5.3); null while it is off. */
  private metering: AttemptRef | null = null;
  /** The attempt after whose solve clip the pipeline starts again for its latency (T5.3). */
  private restartAfter: AttemptRef | null = null;
  /** The pipeline started again during the drift under way: once per drift. */
  private restartedForDrift = false;
  /** Since when, on the host clock, the camera records under its share of its frame rate (T5.5). */
  private lowSinceMs: number | null = null;
  /** The run of the pipeline whose load was said (once per recording, T5.5). */
  private loadSaid: CaptureHandle | null = null;

  constructor(
    private readonly context: RecordingContext,
    /** The camera it records. */
    readonly camera: HostCamera,
  ) {}

  /** Resolves once the starts and stops asked for so far are done (for tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * The camera's capture latency now (T5.3): the running median of the meter's last 10 s, ms; null
   * without one. The sync check keeps it as its baseline (`captureLatencyAtCheckMs`).
   */
  captureLatencyMs(): number | null {
    return this.drift.p50Ms;
  }

  /**
   * Measures the motion of the camera's frames inside `rect` (frame pixels; null for the whole
   * frame) for the sync check (T2.5, `SyncService`), through the pipeline's `watchMotion`, until the
   * returned function is called; null while it does not record. `onMeter` hears how the frames are
   * read (T2.8).
   */
  watchMotion(
    rect: FramingRect | null,
    onSample: (sample: MotionSample) => void,
    onError: (message: string) => void,
    onMeter?: (meter: MotionMeterInfo) => void,
  ): (() => void) | null {
    const handle = this.handle;
    if (handle === null || this.statusSignal() !== 'recording') {
      return null;
    }
    return handle.watchMotion(rect, onSample, onError, onMeter);
  }

  /**
   * The capture latency's drift is measured from the camera's last sync check (T5.3): `label` is the
   * camera's label in the session (null while it is not on), `baselineMs` its meter's median at that
   * check, kept in the session's `clock.cameras` (null without one); another camera starts from
   * nothing.
   */
  setDriftBaseline(label: string | null, baselineMs: number | null): void {
    if (label !== this.driftLabel) {
      this.driftLabel = label;
      this.drift = new LatencyDrift();
      this.latencyDriftSignal.set(null);
      this.restartedSignal.set(null);
      this.restartedForDrift = false;
    }
    if (baselineMs !== this.drift.baselineMs) {
      this.drift.setBaseline(baselineMs);
    }
  }

  /**
   * Starts, restarts or stops the pipeline as the camera (its `stream`), the session (`active`),
   * storage (`full`) and the settings (`wanted`) say. A restart, like a stop, saves the clips waiting
   * for their time with what the buffer has. How the microphone is asked for restarts it only while
   * the audio is recorded.
   */
  reconcile(
    stream: MediaStream | null,
    active: boolean,
    full: boolean,
    wanted: Omit<RecordingTarget, 'stream'>,
  ): void {
    const recording = stream !== null && active && !full && this.context.support.supported;
    if (!recording) {
      if (this.target === null && this.handle === null) {
        this.showIdle(stream, full);
        return;
      }
      this.target = null;
      const generation = ++this.generation;
      const stats = this.statsSignal();
      this.context.diagnostics.record('recording.stopped', {
        camera: this.cameraEntry?.entry.label ?? null,
        why:
          stream === null
            ? 'camera-off'
            : !active
              ? 'no-session'
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
          this.showIdle(stream, full);
        }
      });
      return;
    }
    const target = this.target;
    if (
      target?.stream === stream &&
      target.audio === wanted.audio &&
      target.quality === wanted.quality &&
      (!wanted.audio || target.processing === wanted.processing)
    ) {
      return;
    }
    const generation = ++this.generation;
    const next: RecordingTarget = { stream, ...wanted };
    this.target = next;
    void this.serially(async () => {
      await this.stopPipeline();
      if (generation === this.generation) {
        await this.startPipeline(generation, next);
      }
    });
  }

  /**
   * Stops the pipeline for good (the camera turned off or gone): the clips waiting for their time are
   * saved first, with what the buffer has.
   */
  async stop(): Promise<void> {
    if (this.target !== null || this.handle !== null) {
      const stats = this.statsSignal();
      this.context.diagnostics.record('recording.stopped', {
        camera: this.cameraEntry?.entry.label ?? null,
        why: 'camera-off',
        dropped: stats?.dropped ?? null,
        bufferSeconds: stats?.bufferSeconds ?? null,
        encodedFps: stats?.encodedFps ?? null,
      });
    }
    this.target = null;
    ++this.generation;
    await this.serially(() => this.stopPipeline());
    this.showIdle(null, false);
  }

  /**
   * Puts the entry of the camera recording, with the microphone of the recording, in the session
   * under way (`SessionService.putCamera`, which gives the device its label in the session, T2.14),
   * with `audio` as the session's `audio`, and keeps it for the clips; without a session, keeps it
   * under the camera's own label, a new session's. Nothing while the camera is not on, nor while it
   * does not record.
   */
  putEntry(audio: boolean): void {
    const status = this.statusSignal();
    if (status !== 'starting' && status !== 'recording') {
      return;
    }
    const info = this.camera.cameraInfo();
    if (info === null) {
      return;
    }
    const entry: CameraInfo = { ...info, microphone: this.microphoneSignal() };
    const deviceId = this.camera.deviceId();
    this.cameraEntry = {
      entry: this.context.session.putCamera(entry, audio, deviceId) ?? entry,
      deviceId,
    };
  }

  /** An attempt's milestone (`SessionService.milestones$`): a clip to plan, the meter, the restart. */
  onMilestone(milestone: AttemptMilestone): void {
    const attempt = milestone.attempt;
    switch (milestone.type) {
      case 'armed':
      case 'ended': {
        const window = clipWindow(milestone);
        if (window !== null) {
          this.plan(
            attempt,
            window.segment,
            window.startMs,
            window.endMs,
            milestone.type === 'ended' ? milestone.record : null,
          );
        }
        if (milestone.type === 'armed') {
          this.meterSolve(attempt);
        } else {
          this.considerRestart(attempt, milestone.record);
        }
        break;
      }
      case 'dropped':
        if (this.metering !== null && sameAttempt(this.metering, attempt)) {
          this.stopMeter();
        }
        // Its clips waiting for their time are not saved (those already saved are removed by the
        // recording service, `removeClips`).
        for (const [key, planned] of this.planned) {
          if (sameAttempt(planned.attempt, attempt)) {
            this.planned.delete(key);
            this.clearTimer(planned.timer);
            this.context.inFlight.end(attempt.session, attempt.index);
          }
        }
        break;
    }
  }

  /**
   * Removes the files of `clips`, the clips kept for an attempt that went without a record (the
   * phones' too: any pipeline's clip worker deletes them by name); false, doing nothing, while this
   * camera's pipeline does not run.
   */
  removeClips(attempt: AttemptRef, clips: readonly VideoClip[]): boolean {
    const handle = this.handle;
    if (handle === null) {
      return false;
    }
    for (const clip of clips) {
      this.remove(handle, attempt, clip);
    }
    return true;
  }

  /** The status while the pipeline does not run, and why. */
  private showIdle(stream: MediaStream | null, full: boolean): void {
    this.statsSignal.set(null);
    this.loadSignal.set(null);
    if (stream !== null && full) {
      this.statusSignal.set('error');
      this.errorSignal.set(STORAGE_FULL);
    } else if (stream !== null && !this.context.support.supported) {
      this.statusSignal.set('error');
      this.errorSignal.set(
        `This browser cannot record video (no ${this.context.support.missing.join(', ')}): recording needs Chrome.`,
      );
    } else {
      this.statusSignal.set('off');
      this.errorSignal.set(null);
    }
    this.noticesSignal.set([]);
  }

  private async startPipeline(generation: number, target: RecordingTarget): Promise<void> {
    const { stream, audio, processing, quality } = target;
    this.statusSignal.set('starting');
    this.errorSignal.set(null);
    this.noticesSignal.set([]);
    this.notedThisRun.clear();
    this.statsSignal.set(null);
    this.loadSignal.set(null);
    this.lowSinceMs = null;
    this.audioSignal.set(audio);
    const video = stream.getVideoTracks().at(0);
    if (video === undefined) {
      this.fail(generation, 'The camera sends no video.');
      return;
    }
    const microphone = audio ? await this.openMicrophone(generation, processing) : null;
    if (generation !== this.generation) {
      stopStream(microphone?.stream ?? null);
      return;
    }
    this.microphoneStream = microphone?.stream ?? null;
    this.microphoneSignal.set(microphone?.info ?? null);
    const audioTrack = microphone?.stream.getAudioTracks().at(0) ?? null;
    let handle: CaptureHandle;
    try {
      handle = this.context.starter.start(video, audioTrack, {
        audio: audioTrack !== null,
        quality,
        ...e2eCapture(this.context.globals),
      });
    } catch (error: unknown) {
      this.fail(generation, `Recording could not start: ${errorMessage(error)}`);
      return;
    }
    this.handle = handle;
    // The clips of this run take the entry of its camera from now on, not the last camera's; every
    // camera's entry goes in, in their order, so that their labels do not depend on which starts first.
    this.context.putEntries();
    // The latency's readings start again with the run (its floor is the track's, T5.3), and a solve
    // under way keeps its motion meter.
    this.drift.restart();
    this.recentStats = [];
    if (this.metering !== null && this.context.settings.motionMeter()) {
      handle.meterMotion(true, this.camera.framing());
    }
    handle.onStats((stats) => {
      if (this.handle !== handle) {
        return;
      }
      this.statsSignal.set(stats);
      const nowMs = hostNow(this.context.globals);
      this.recentStats = [
        ...this.recentStats.filter((entry) => nowMs - entry.atMs <= STATS_KEPT_MS),
        { atMs: nowMs, stats },
      ];
      this.watchLatency(stats);
      this.watchLoad(handle, stats, nowMs);
      if (this.statusSignal() === 'starting' && stats.bufferSeconds > 0) {
        this.statusSignal.set('recording');
      }
      if (this.announced !== handle && stats.codec !== null) {
        this.announced = handle;
        this.started(stats, target, microphone?.info ?? null);
      }
      if (stats.audioState === 'encoding' && this.noticesSignal().includes(NO_AUDIO_DATA)) {
        // The microphone was late, not silent: its sound is recorded now (the note stays).
        this.noticesSignal.update((notices) => notices.filter((n) => n !== NO_AUDIO_DATA));
      }
    });
    handle.onError((error) => {
      if (this.handle !== handle) {
        return;
      }
      if (error.fatal) {
        // The buffer stays: the clips waiting for their time are still cut from it.
        this.statusSignal.set('error');
        this.errorSignal.set(`Recording stopped: ${error.message}`);
        this.context.diagnostics.record('error.app', {
          where: 'recording',
          message: `Recording stopped: ${error.message}`,
        });
      } else {
        this.addNotice(error.message);
      }
    });
    void this.context.storage.refresh();
  }

  /**
   * The microphone, asked for as `processing` says (T2.12, `openMicrophone`), with what the browser
   * says it applied; its notice (the browser kept some processing on, or refused the raw request)
   * is shown with the recording's. Null, with a notice, when it cannot be had: the video is recorded
   * anyway.
   */
  private async openMicrophone(
    generation: number,
    processing: MicrophoneProcessing,
  ): Promise<OpenMicrophone | null> {
    const opened = await openMicrophone(this.context.globals.navigator?.mediaDevices, processing);
    if (generation !== this.generation) {
      stopStream(opened.stream);
      return null;
    }
    if (opened.notice !== null) {
      this.addNotice(opened.notice);
    }
    return opened.stream === null ? null : { stream: opened.stream, info: opened.info };
  }

  /**
   * `recording.started` (T3.9, docs/DIAGNOSTICS.md): what this run of the pipeline records, once its
   * encoder is chosen: the codecs and the bitrate, the quality asked for, the camera's frame size and
   * rate, and the microphone, as asked for and as the browser applied it.
   */
  private started(
    stats: CaptureStats,
    target: RecordingTarget,
    microphone: MicrophoneInfo | null,
  ): void {
    const entry = this.cameraEntry?.entry;
    const settings = entry?.settings ?? {};
    this.context.diagnostics.record('recording.started', {
      camera: entry?.label ?? null,
      codec: stats.codec,
      audioCodec: stats.audioCodec,
      bitrate: stats.bitrate,
      quality: target.quality,
      audio: target.audio,
      processing: microphone?.processing ?? null,
      applied:
        microphone === null
          ? null
          : {
              echoCancellation: microphone.echoCancellation,
              noiseSuppression: microphone.noiseSuppression,
              autoGainControl: microphone.autoGainControl,
              voiceIsolation: microphone.voiceIsolation,
            },
      width: numberOf(settings['width']),
      height: numberOf(settings['height']),
      fps: numberOf(settings['frameRate']),
    });
  }

  /**
   * Shows a notice with the others of this run of the pipeline, and notes it once in the session
   * under way, if any: a notice is not to be missed because another came after it (issue #33).
   */
  private addNotice(message: string): void {
    if (!this.noticesSignal().includes(message)) {
      this.noticesSignal.update((notices) => [...notices, message]);
      this.context.diagnostics.record('recording.notice', {
        message,
        camera: this.cameraEntry?.entry.label ?? null,
      });
    }
    const session = this.context.session.session();
    if (session !== null) {
      this.noteOnce(session.id, `notice: ${message}`);
    }
  }

  /**
   * Stops the pipeline: the clips waiting for their time are saved at once, with what the buffer
   * has, and written before the workers stop; then the microphone is let go.
   */
  private async stopPipeline(): Promise<void> {
    const handle = this.handle;
    const microphone = this.microphoneStream;
    this.handle = null;
    this.microphoneStream = null;
    for (const [key, planned] of this.planned) {
      this.planned.delete(key);
      this.clearTimer(planned.timer);
      void planned.save();
    }
    this.statsSignal.set(null);
    // The clips asked for are cut before the pipeline stops (it frees the buffer).
    await Promise.all(this.saving);
    await handle?.stop();
    stopStream(microphone);
  }

  private fail(generation: number, message: string): void {
    if (generation !== this.generation) {
      return;
    }
    this.statusSignal.set('error');
    this.errorSignal.set(message);
    this.context.diagnostics.record('error.app', { where: 'recording', message });
  }

  /**
   * Saves the clip of `segment` once its end is in the buffer, if the pipeline runs now; a solve
   * clip with its attempt's `record`, whose moves place its motion (T5.3).
   */
  private plan(
    attempt: AttemptRef,
    segment: VideoSegment,
    startMs: number,
    endMs: number,
    record: AttemptRecord | null = null,
  ): void {
    const handle = this.handle;
    const recorded = this.cameraEntry;
    if (handle === null || recorded === null) {
      return;
    }
    const key = `${attempt.session}/${String(attempt.index)}/${String(attempt.scrambleShown)}/${segment}`;
    const save = (): Promise<void> => {
      const saving = this.save(handle, recorded, attempt, segment, startMs, endMs, record);
      this.saving.add(saving);
      this.savingSignal.set(this.saving.size);
      void saving.finally(() => {
        this.saving.delete(saving);
        this.savingSignal.set(this.saving.size);
        // Saved in its record (or failed, or its attempt gone): its upload need not wait for it.
        this.context.inFlight.end(attempt.session, attempt.index);
        if (segment === 'solve') {
          this.solveSaved(attempt);
        }
      });
      return saving;
    };
    const delay = Math.max(0, endMs + ENCODER_SETTLE_MS - hostNow(this.context.globals));
    const timer = this.setTimer(() => {
      this.planned.delete(key);
      void save();
    }, delay);
    const previous = this.planned.get(key);
    if (previous !== undefined) {
      this.clearTimer(previous.timer);
      this.context.inFlight.end(attempt.session, attempt.index);
    }
    this.context.inFlight.begin(attempt.session, attempt.index);
    this.planned.set(key, { timer, attempt, save });
  }

  /**
   * Saves one clip and adds it to its attempt's record; a failure is said and noted, and a clip
   * whose attempt went meanwhile is removed again.
   */
  private async save(
    handle: CaptureHandle,
    recorded: RecordedCamera,
    attempt: AttemptRef,
    segment: VideoSegment,
    startHostMs: number,
    endHostMs: number,
    record: AttemptRecord | null,
  ): Promise<void> {
    const session = this.context.session;
    if (!session.hasAttempt(attempt)) {
      return;
    }
    const fpsNominal = frameRateOf(recorded.entry);
    let clip: VideoClip;
    let report: ClipReport;
    try {
      // The session's folder exists once its creation is written.
      await session.whenSaved();
      const saved = await handle.saveClip({
        startHostMs,
        endHostMs,
        sessionId: attempt.session,
        index: attempt.index,
        camera: recorded.entry.label,
        segment,
        fpsNominal,
        // The frames file names the build that wrote it (T3.7).
        app: APP_BUILD,
      });
      // A solve clip says where its motion peaked around the solve's moves (T5.3); its camera's lag
      // from them is added with its sync check's lag when it is attached (`withCameraLag`).
      const peak = segment === 'solve' ? solveMotionPeak(saved.motion, record) : null;
      clip = {
        ...saved.clip,
        crop: this.cropNow(recorded),
        ...(segment === 'solve'
          ? { motionPeakMs: peak?.peakMs ?? null, motionSpreadMs: peak?.spreadMs ?? null }
          : {}),
      };
      report = saved.report;
    } catch (error: unknown) {
      this.failed(attempt, segment, recorded.entry.label, errorMessage(error));
      return;
    }
    let attached: Awaited<ReturnType<SessionService['attachClip']>>;
    try {
      attached = await session.attachClip(attempt, clip);
    } catch (error: unknown) {
      this.failed(
        attempt,
        segment,
        clip.camera,
        `its record could not be saved (${errorMessage(error)})`,
      );
      return;
    }
    if (attached === 'gone') {
      // The attempt went while its clip was saved: its files go too.
      this.remove(handle, attempt, clip);
      return;
    }
    // The clip as its record has it: its camera's lags from the session's check (T2.5, T5.3).
    const current = session.session();
    const lagged = withCameraLag(clip, current?.id === attempt.session ? current : null);
    this.context.saved({ index: attempt.index, clip: lagged });
    this.context.diagnostics.record(
      'clip.saved',
      {
        segment,
        camera: clip.camera,
        bytes: clip.bytes,
        frames: clip.frames,
        codec: clip.codec,
        audioCodec: clip.audio,
        audio: clip.audio !== null,
        truncatedStart: clip.truncatedStart,
        lateMs: report.lateMs,
        bufferSeconds: report.bufferSeconds,
        syncResidualMs: lagged.syncResidualMs,
        audioRebasedMs: report.audioRebasedMs,
        kept: attached === 'kept',
        // T5.3 (issue #67): the frames' latencies, the clip's cadence, its motion lag, and what the
        // pipeline's counters said over its span.
        captureLatencyMs: clip.captureLatencyMs ?? null,
        encodeLatencyMs: clip.encodeLatencyMs ?? null,
        frameIntervalMs: report.frameIntervalMs,
        motionPeakMs: lagged.motionPeakMs ?? null,
        motionSpreadMs: lagged.motionSpreadMs ?? null,
        motionLagMs: lagged.motionLagMs ?? null,
        pipeline: { ...pipelineSummary(this.recentStats, startHostMs, endHostMs + 2000) },
      },
      { session: attempt.session, attempt: attempt.index },
    );
    this.remark(attempt, clip, report);
    void this.context.storage.refresh();
  }

  /**
   * The words for a clip of `segment` of attempt `index`: "solve of attempt 3", and the camera's
   * label after it while several cameras record (T5.5: "solve of attempt 3 (laptop-2)").
   */
  private clipWords(segment: VideoSegment, index: number, camera: string): string {
    const what = `${segment} of attempt ${String(index)}`;
    return this.context.several() ? `${what} (${camera})` : what;
  }

  /**
   * Says what a clip saved short of what was asked lacks, and notes it in its session (T2.9): that
   * it begins late (every such clip), that it has no sound and why, and that its audio was moved
   * onto the frames' clock (each once per run of the pipeline, since every clip then has it). That
   * the capture made its audio's decoder config is only noted, once: the clip has its sound, and the
   * note says which of the causes of issue #33 the device had.
   */
  private remark(attempt: AttemptRef, clip: VideoClip, report: ClipReport): void {
    const what = this.clipWords(clip.segment, attempt.index, clip.camera);
    const name = `${clip.segment === 'scramble' ? 'Scramble' : 'Solve'} clip of attempt ${String(attempt.index)}${this.context.several() ? ` (${clip.camera})` : ''}`;
    const said: string[] = [];
    if (clip.truncatedStart) {
      const late = (report.lateMs / 1000).toFixed(1);
      said.push(
        `${name} starts ${late} s late: the buffer holds ${report.bufferSeconds.toFixed(0)} s.`,
      );
      this.note(
        attempt.session,
        `clip truncated: ${what} starts ${late} s late (the buffer held ${report.bufferSeconds.toFixed(1)} s)`,
      );
    }
    if (report.audioMissing !== null) {
      said.push(`${name} has no sound: ${report.audioMissing}.`);
      this.context.diagnostics.record(
        'audio.missing',
        { segment: clip.segment, cause: report.audioMissing, camera: clip.camera },
        { session: attempt.session, attempt: attempt.index },
      );
      this.noteOnce(
        attempt.session,
        `clip without audio: ${what}: ${report.audioMissing}`,
        `audio missing: ${report.audioMissing}`,
      );
    }
    if (report.audioRebasedMs !== 0) {
      const rebase = `audio timestamps rebased by ${report.audioRebasedMs.toFixed(0)} ms`;
      said.push(`${name}: ${rebase}.`);
      this.noteOnce(attempt.session, `clip audio rebased: ${what}: ${rebase}`, 'audio rebased');
    }
    if (report.audioConfigMade) {
      this.noteOnce(
        attempt.session,
        `clip audio described: ${what}: the audio encoder gave no complete decoder config; the capture made it from the encoder's settings`,
        'audio config made',
      );
    }
    if (said.length > 0) {
      this.context.remarked(said.join(' '));
    }
  }

  /** Writes a line into a session's notes, and into the console as `cubetrace: …`. */
  private note(sessionId: string, line: string): void {
    console.warn(`cubetrace: ${line}`);
    this.context.session.addNote(sessionId, line).catch(() => undefined);
  }

  /** {@link note}, unless a line of the same `kind` was noted since the pipeline started. */
  private noteOnce(sessionId: string, line: string, kind = line): void {
    if (!this.notedThisRun.has(kind)) {
      this.notedThisRun.add(kind);
      this.note(sessionId, line);
    }
  }

  /**
   * Removes the files of a clip whose attempt went (best effort: with no pipeline, they stay until a
   * clip of the same name replaces them); a newer clip that took their name stays.
   */
  private remove(handle: CaptureHandle | null, attempt: AttemptRef, clip: VideoClip): void {
    void handle
      ?.deleteClip({
        sessionId: attempt.session,
        index: attempt.index,
        camera: clip.camera,
        segment: clip.segment,
        firstFrameHostMs: clip.firstFrameHostMs,
      })
      .catch(() => false);
  }

  /**
   * The framing rectangle now, as the clip's `crop`, while the camera open is the one that recorded
   * the clip (the same device, T2.14); else the one the camera recorded with.
   */
  private cropNow(recorded: RecordedCamera): VideoClip['crop'] {
    const now = this.camera.cameraInfo();
    const open = this.camera.identity();
    const same =
      open !== null && sameCamera({ ...recorded.entry, deviceId: recorded.deviceId }, open);
    return now !== null && same ? now.crop : recorded.entry.crop;
  }

  /** Says once that a clip failed, and notes it in its session, unless its attempt is gone. */
  private failed(attempt: AttemptRef, segment: VideoSegment, camera: string, reason: string): void {
    if (!this.context.session.hasAttempt(attempt)) {
      return;
    }
    const line = `clip failed: ${this.clipWords(segment, attempt.index, camera)}: ${reason}`;
    this.context.failed(line);
    this.context.diagnostics.record(
      'clip.failed',
      { segment, reason, camera },
      { session: attempt.session, attempt: attempt.index },
    );
    this.note(attempt.session, line);
  }

  /**
   * The capture latency's drift (T5.3), from the counters of each second: `recording.latency` when
   * the drift rule says so (`LatencyDrift`: once the running median of the last 10 s has sat more
   * than 30 ms from the camera's sync check for 5 s, and once back within for 5 s, a minute apart at
   * most), with what the counters say of where the frames waited; the status line's word.
   */
  private watchLatency(stats: CaptureStats): void {
    const latency = stats.latency;
    const capture = latency?.capture ?? null;
    const event = this.drift.update(
      hostNow(this.context.globals),
      capture === null ? null : { p50: capture.p50, p95: capture.p95 },
    );
    const drifting = this.drift.driftingSinceMs !== null;
    // While it drifts, the last delta known (the readings start again with a run of the pipeline).
    this.latencyDriftSignal.set(
      drifting ? (this.drift.deltaMs ?? this.latencyDriftSignal()) : null,
    );
    if (!drifting) {
      this.restartedForDrift = false;
      this.restartedSignal.set(null);
    }
    if (event === null) {
      return;
    }
    this.context.diagnostics.record('recording.latency', {
      camera: this.cameraEntry?.entry.label ?? null,
      why: event.why,
      baselineMs: event.baselineMs,
      p50Ms: event.p50Ms,
      p95Ms: event.p95Ms,
      deltaMs: event.deltaMs,
      basis: capture?.basis ?? null,
      encodeP50Ms: latency?.encode?.p50 ?? null,
      waiting: latency?.waiting ?? null,
      fps: stats.fps,
      queueMax: latency?.queueMax ?? null,
      pending: latency?.pending ?? null,
      frameIntervalMs: latency?.frameIntervalMs ?? null,
      restartOn: this.context.settings.restartOnLatencyDrift(),
    });
  }

  /**
   * The load (T5.5): while several cameras record, a camera that encodes under {@link LOAD_SHARE} of
   * the frame rate its track reports for {@link LOAD_WINDOW_MS} is said once per recording (a notice,
   * `recording.notice`, the session's notes), and its line says so while it lasts.
   */
  private watchLoad(handle: CaptureHandle, stats: CaptureStats, nowMs: number): void {
    const nominal = numberOf(this.cameraEntry?.entry.settings['frameRate']);
    const low =
      nominal !== null &&
      nominal > 0 &&
      stats.bufferSeconds > 0 &&
      this.context.several() &&
      stats.encodedFps < LOAD_SHARE * nominal;
    if (!low) {
      this.lowSinceMs = null;
      this.loadSignal.set(null);
      return;
    }
    this.lowSinceMs ??= nowMs;
    if (nowMs - this.lowSinceMs < LOAD_WINDOW_MS) {
      return;
    }
    this.loadSignal.set({ encodedFps: stats.encodedFps, nominalFps: nominal });
    if (this.loadSaid !== handle) {
      this.loadSaid = handle;
      const label = this.cameraEntry?.entry.label ?? 'This camera';
      this.addNotice(
        `${label} records ${String(Math.round(stats.encodedFps))} of its ${String(Math.round(nominal))} frames a second. ${LOAD_ADVICE}`,
      );
    }
  }

  /**
   * The attempt is armed: its solve comes next, and the capture measures the motion of its frames
   * inside the framing rectangle until its solve clip is saved (T5.3, "Measure the motion during
   * solves").
   */
  private meterSolve(attempt: AttemptRef): void {
    const handle = this.handle;
    if (handle === null || !this.context.settings.motionMeter()) {
      return;
    }
    this.metering = attempt;
    handle.meterMotion(true, this.camera.framing());
  }

  /** The motion meter goes off (the solve clip saved, the attempt gone). */
  private stopMeter(): void {
    this.metering = null;
    this.handle?.meterMotion(false, null);
  }

  /**
   * The attempt ended: when the capture latency had drifted since before its scramble's first turn
   * and still does, so through the whole attempt, the recording starts again once its solve clip is
   * saved (T5.3: "Restart the recording when its latency drifts"), once per drift.
   */
  private considerRestart(attempt: AttemptRef, record: AttemptRecord): void {
    const since = this.drift.driftingSinceMs;
    const began = record.events.scrambleStart ?? record.events.scrambleShown;
    if (
      this.context.settings.restartOnLatencyDrift() &&
      since !== null &&
      since <= began &&
      !this.restartedForDrift
    ) {
      this.restartAfter = attempt;
    }
  }

  /** The attempt's solve clip is saved (or failed): the meter goes off, and a restart may come. */
  private solveSaved(attempt: AttemptRef): void {
    if (this.metering !== null && sameAttempt(this.metering, attempt)) {
      this.stopMeter();
    }
    if (this.restartAfter !== null && sameAttempt(this.restartAfter, attempt)) {
      this.restartAfter = null;
      this.restartForLatency(attempt);
    }
  }

  /**
   * Starts the recording again between attempts for a capture latency that drifted for a whole
   * attempt (T5.3, issue #67's mitigation): `recording.restarted`, the session's note and the status
   * line say so; its readings begin again, and the drift is said recovered once back within 30 ms.
   */
  private restartForLatency(attempt: AttemptRef): void {
    const target = this.target;
    if (target === null || this.handle === null) {
      return;
    }
    const deltaMs = this.latencyDriftSignal() ?? 0;
    const label = this.cameraEntry?.entry.label ?? null;
    this.restartedForDrift = true;
    this.restartedSignal.set({ atMs: hostNow(this.context.globals), deltaMs });
    this.context.diagnostics.record(
      'recording.restarted',
      {
        why: 'latency',
        camera: label,
        deltaMs,
        baselineMs: this.drift.baselineMs,
        p50Ms: this.drift.p50Ms,
        p95Ms: this.drift.p95Ms,
      },
      { session: attempt.session, attempt: attempt.index },
    );
    this.note(
      attempt.session,
      `recording restarted: the capture latency of ${label ?? 'the camera'} was ${signedMs(deltaMs)} from its sync check's for a whole attempt (after attempt ${String(attempt.index)})`,
    );
    const generation = ++this.generation;
    void this.serially(async () => {
      await this.stopPipeline();
      if (generation === this.generation) {
        await this.startPipeline(generation, target);
      }
    });
  }

  /** Runs `task` after the starts and stops before it. */
  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setTimer(callback: () => void, ms: number): number {
    const set =
      this.context.globals.setTimeout ?? ((cb: () => void, delay: number) => setTimeout(cb, delay));
    return set(callback, ms);
  }

  private clearTimer(handle: number): void {
    const clear =
      this.context.globals.clearTimeout ??
      ((timer: number) => {
        clearTimeout(timer);
      });
    clear(handle);
  }
}

/** The median of `values` (at least one), the mean of the middle two for an even count. */
function middle(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

/** `value` when it is a finite number (a camera's settings as JSON); null otherwise. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The frame rate the camera's track reports, for the clips' `fpsNominal`; 30 if it says none. */
function frameRateOf(entry: CameraInfo): number {
  const rate = entry.settings['frameRate'];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 30;
}

function sameAttempt(p: AttemptRef, q: AttemptRef): boolean {
  return p.session === q.session && p.index === q.index && p.scrambleShown === q.scrambleShown;
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}
