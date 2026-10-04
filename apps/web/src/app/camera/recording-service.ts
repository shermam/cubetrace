import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  NO_AUDIO_DATA,
  captureSupport,
  startCapture,
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
  type CameraInfo,
  type MicrophoneInfo,
  type MicrophoneProcessing,
  type VideoClip,
  type VideoSegment,
} from '@cubetrace/core';

import { APP_BUILD } from '../../environments/version';
import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { STORAGE_STOP_PERCENT, StorageService } from '../device/storage-service';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { ClipsInFlight } from '../session/clips-in-flight';
import { SessionService, type AttemptMilestone, type AttemptRef } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { CameraService } from './camera-service';
import { clipWindow } from './clip-windows';
import { openMicrophone } from './microphone';

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

export const CAPTURE_STARTER = new InjectionToken<CaptureStarter>('CAPTURE_STARTER', {
  providedIn: 'root',
  factory: () => ({
    support: () => captureSupport(),
    start: (video, audio, config) =>
      startCapture(new MediaStream(audio === null ? [video] : [video, audio]), config),
  }),
});

/**
 * `off`: not recording (the camera is off, no session is under way, or storage is full: `error`
 * says so then). `starting`: the pipeline is starting (the microphone's permission included).
 * `recording`: the last 90 s are in memory, from which the clips are cut. `error`: it could not
 * start, or it stopped; `error` says why.
 */
export type RecordingStatus = 'off' | 'starting' | 'recording' | 'error';

/** The usage of the origin's storage, for the meter. */
export interface StorageMeterValue {
  readonly usage: number;
  readonly quota: number;
  /** Of the quota, 0 to 100. */
  readonly percent: number;
}

/** A clip saved, with the attempt it belongs to. */
export interface SavedClip {
  readonly index: number;
  readonly clip: VideoClip;
}

// The clips' windows, which the remote cameras' cuts share (T4.2), live in clip-windows.ts.
export {
  CLIP_TAIL_MS,
  SCRAMBLE_CLIP_MAX_MS,
  SCRAMBLE_LEAD_MS,
  SOLVE_LEAD_MS,
} from './clip-windows';

/**
 * A clip is saved this long after its end, so that the frames up to its end have come out of the
 * encoder (tens of milliseconds) and are in the buffer: its cut is then whole.
 */
export const ENCODER_SETTLE_MS = 250;

/** The storage meter is read again this often, besides after every clip. */
export const STORAGE_REFRESH_MS = 60_000;

/** The notice when recording stopped because storage is full. */
export const STORAGE_FULL =
  `Storage is ${String(STORAGE_STOP_PERCENT)}% full: recording stopped (the timer goes on). ` +
  'Export or delete sessions to record again.';

/** A clip waiting for its time, which `save` saves. */
interface PlannedClip {
  readonly timer: number;
  readonly attempt: AttemptRef;
  readonly save: () => Promise<void>;
}

/**
 * What the pipeline is to run on: the camera's stream, with or without the microphone (raw or with
 * the browser's voice processing), at a video quality.
 */
interface Target {
  readonly stream: MediaStream;
  readonly audio: boolean;
  /** How the microphone is asked for (T2.12); it matters only with `audio`. */
  readonly processing: MicrophoneProcessing;
  readonly quality: VideoQuality;
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
 * The recording in the timer (docs/PLAN.md, T2.4). While the camera is on (`CameraService.stream`)
 * and a session is under way (or a cube is connected, so that the first attempt of a session has its
 * margin), the capture pipeline runs on the camera's stream, with the microphone's audio when
 * Settings says so ("Record audio"), the microphone raw unless Settings say Voice (T2.12: the
 * browser's voice processing takes the cube's clicks for noise), at the video quality Settings says
 * (T2.10); it starts again when the stream changes (another camera, another resolution) or one of
 * those settings does, and stops when the camera goes off, no session is under way, or storage is
 * {@link STORAGE_STOP_PERCENT}% full (the timer goes on).
 *
 * Every attempt gets two clips, cut from the last 90 s the pipeline keeps in memory, as
 * `SessionService.milestones$` says: once the scramble is done, the scramble clip
 * `[max(scrambleStart − 2 s, scrambleDone − 60 s), scrambleDone + 1 s]`; once the attempt ended
 * (solved or a DNF), the solve clip `[solveStart − 3 s, end + 1 s]`, none when the solve never
 * started. Each is saved one second (and {@link ENCODER_SETTLE_MS}) after its end, in the attempt's
 * folder, with the camera's framing rectangle as its `crop`, and added to the attempt's record
 * (`SessionService.attachClip`, which saves the record again: its timing never changes). A clip whose
 * start is older than the buffer begins at its oldest keyframe instead (`truncatedStart`, T2.9): it
 * is saved, said (`clipNotice`) and noted in the session's `notes`, as is a clip without sound while
 * audio is recorded, with why. The session's `cameras` holds the camera's entry while it records,
 * with its microphone and what the browser applied to it (`microphone`, T2.12; a notice says when
 * the browser kept its voice processing on although Raw was asked for), under the label the session
 * gives the device (T2.14: `laptop`, then `laptop-2` for another camera of the laptop), which names
 * the camera's clips and their files and finds its sync check for them. A clip that fails is said
 * once (`failure`, the console) and noted in the session's `notes`; the attempt is untouched. A
 * clip of an attempt that went meanwhile (a reset, Delete last) is removed again. Stopping saves
 * the clips still waiting for their time at once, with what the buffer has.
 */
@Injectable({ providedIn: 'root' })
export class RecordingService {
  private readonly camera = inject(CameraService);
  private readonly session = inject(SessionService);
  private readonly cube = inject(CubeService);
  private readonly settings = inject(SettingsService);
  private readonly storageService = inject(StorageService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly starter = inject(CAPTURE_STARTER);
  /** The attempts whose clips are still to come, for the upload queue (T3.3). */
  private readonly inFlight = inject(ClipsInFlight);
  private readonly diagnostics = inject(DiagnosticsService);

  private readonly statusSignal = signal<RecordingStatus>('off');
  private readonly statsSignal = signal<CaptureStats | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  private readonly noticesSignal = signal<readonly string[]>([]);
  private readonly lastClipSignal = signal<SavedClip | null>(null);
  private readonly failureSignal = signal<string | null>(null);
  private readonly clipNoticeSignal = signal<string | null>(null);
  private readonly savingSignal = signal(0);
  private readonly microphoneSignal = signal<MicrophoneInfo | null>(null);

  /** See {@link RecordingStatus}. */
  readonly status = this.statusSignal.asReadonly();
  /** The pipeline's counters, once per second; null while it is not running. */
  readonly stats = this.statsSignal.asReadonly();
  /** Why it is not recording: it could not start, it stopped, or storage is full. */
  readonly error = this.errorSignal.asReadonly();
  /**
   * What it records otherwise than asked, since the pipeline started: no audio (the microphone
   * refused, silent or lost, or no encoder for it), or the clip worker failed. Each stays until
   * recording starts again, one after the other rather than the last alone, and is noted in the
   * session (`notice: …`), so that none goes unseen (T2.9, issue #33).
   */
  readonly notices = this.noticesSignal.asReadonly();
  /** The last clip saved. */
  readonly lastClip = this.lastClipSignal.asReadonly();
  /** The last clip that could not be saved, as its note says; null once dismissed. */
  readonly failure = this.failureSignal.asReadonly();
  /**
   * What the last clip saved short of what was asked lacks (T2.9): it begins late (its start was
   * older than the 90 s in memory), it has no sound and why, or its audio was moved onto the frames'
   * clock; as its notes say; null once dismissed.
   */
  readonly clipNotice = this.clipNoticeSignal.asReadonly();
  /** How many clips are being saved (cut, muxed and written) now: the Camera preview says so. */
  readonly savingClips = this.savingSignal.asReadonly();
  /**
   * The microphone of the recording (T2.12): how it was asked for and what the browser says it
   * applied, from the last start of the pipeline; null when that recording has no microphone
   * (Record audio off, the microphone refused). The session's camera entry holds it as its
   * `microphone`.
   */
  readonly microphone = this.microphoneSignal.asReadonly();
  /** The origin's storage: usage, quota and the share in use; null until read. */
  readonly storage = computed<StorageMeterValue | null>(() => {
    const usage = this.storageService.usage();
    const percent = this.storageService.percent();
    return usage === null || percent === null
      ? null
      : { usage: usage.usage, quota: usage.quota, percent };
  });
  /** `ok`, `warn` from 80% (export or delete sessions), `full` from 95% (recording stops). */
  readonly storageLevel = this.storageService.level;
  /** The browser can record (Chrome); the APIs it lacks otherwise. */
  readonly support: CaptureSupport;

  private handle: CaptureHandle | null = null;
  /** What the pipeline runs on, or is starting on; null when it is to be stopped. */
  private target: Target | null = null;
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
  private refreshTimer: number | null = null;
  /** The lines noted once per start of the pipeline (notices, a clip's missing audio). */
  private readonly notedThisRun = new Set<string>();
  /** The run of the pipeline whose `recording.started` was recorded (its first stats). */
  private announced: CaptureHandle | null = null;

  constructor() {
    this.support = this.starter.support();
    const subscription = this.session.milestones$.subscribe((milestone) => {
      this.onMilestone(milestone);
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.stopRefreshing();
      this.generation++;
      this.target = null;
      void this.serially(() => this.stopPipeline());
    });
    // The pipeline follows the camera, the session and the settings.
    effect(() => {
      const stream = this.camera.stream();
      const active = this.session.session() !== null || this.cube.status() === 'connected';
      const full = this.storageService.level() === 'full';
      const audio = this.settings.recordAudio();
      const processing = this.settings.microphoneProcessing();
      const quality = this.settings.videoQuality();
      untracked(() => {
        this.reconcile(stream, active, full, { audio, processing, quality });
      });
    });
    // The session's `cameras` holds the camera's entry while it records, with its microphone, under
    // the label the session gives the device (T2.14).
    effect(() => {
      const status = this.statusSignal();
      const session = this.session.session();
      this.camera.settings();
      this.camera.framing();
      const audio = this.settings.recordAudio();
      this.microphoneSignal();
      if (session === null || (status !== 'starting' && status !== 'recording')) {
        return;
      }
      untracked(() => {
        this.putEntry(audio);
      });
    });
  }

  /** Forgets the failure shown. */
  dismissFailure(): void {
    this.failureSignal.set(null);
  }

  /** Forgets the last clip's notice. */
  dismissClipNotice(): void {
    this.clipNoticeSignal.set(null);
  }

  /** Resolves once the starts and stops asked for so far are done (for tests). */
  settled(): Promise<void> {
    return this.queue;
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
   * Starts, restarts or stops the pipeline as the camera, the session and the settings say. A
   * restart, like a stop, saves the clips waiting for their time with what the buffer has. How the
   * microphone is asked for restarts it only while the audio is recorded.
   */
  private reconcile(
    stream: MediaStream | null,
    active: boolean,
    full: boolean,
    wanted: Omit<Target, 'stream'>,
  ): void {
    if (stream === null) {
      this.stopRefreshing();
    } else {
      this.startRefreshing();
    }
    const recording = stream !== null && active && !full && this.support.supported;
    if (!recording) {
      if (this.target === null && this.handle === null) {
        this.showIdle(stream, full);
        return;
      }
      this.target = null;
      const generation = ++this.generation;
      const stats = this.statsSignal();
      this.diagnostics.record('recording.stopped', {
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
    const next: Target = { stream, ...wanted };
    this.target = next;
    void this.serially(async () => {
      await this.stopPipeline();
      if (generation === this.generation) {
        await this.startPipeline(generation, next);
      }
    });
  }

  /** The status while the pipeline does not run, and why. */
  private showIdle(stream: MediaStream | null, full: boolean): void {
    this.statsSignal.set(null);
    if (stream !== null && full) {
      this.statusSignal.set('error');
      this.errorSignal.set(STORAGE_FULL);
    } else if (stream !== null && !this.support.supported) {
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
    this.notedThisRun.clear();
    this.statsSignal.set(null);
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
      handle = this.starter.start(video, audioTrack, { audio: audioTrack !== null, quality });
    } catch (error: unknown) {
      this.fail(generation, `Recording could not start: ${errorMessage(error)}`);
      return;
    }
    this.handle = handle;
    // The clips of this run take the entry of its camera from now on, not the last camera's.
    this.putEntry(audio);
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
        this.diagnostics.record('error.app', {
          where: 'recording',
          message: `Recording stopped: ${error.message}`,
        });
      } else {
        this.addNotice(error.message);
      }
    });
    void this.storageService.refresh();
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
    const opened = await openMicrophone(this.globals.navigator?.mediaDevices, processing);
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
   * Puts the entry of the camera recording, with the microphone of the recording, in the session
   * under way (`SessionService.putCamera`, which gives the device its label in the session, T2.14),
   * with `audio` as the session's `audio`, and keeps it for the clips; without a session, keeps it
   * under the camera's own label, a new session's. Nothing while the camera is not on.
   */
  private putEntry(audio: boolean): void {
    const info = this.camera.cameraInfo();
    if (info === null) {
      return;
    }
    const entry: CameraInfo = { ...info, microphone: this.microphoneSignal() };
    const deviceId = this.camera.deviceId();
    this.cameraEntry = {
      entry: this.session.putCamera(entry, audio, deviceId) ?? entry,
      deviceId,
    };
  }

  /**
   * `recording.started` (T3.9, docs/DIAGNOSTICS.md): what this run of the pipeline records, once its
   * encoder is chosen: the codecs and the bitrate, the quality asked for, the camera's frame size and
   * rate, and the microphone, as asked for and as the browser applied it.
   */
  private started(stats: CaptureStats, target: Target, microphone: MicrophoneInfo | null): void {
    const entry = this.cameraEntry?.entry;
    const settings = entry?.settings ?? {};
    this.diagnostics.record('recording.started', {
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
      this.diagnostics.record('recording.notice', { message });
    }
    const session = this.session.session();
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
    this.diagnostics.record('error.app', { where: 'recording', message });
  }

  private onMilestone(milestone: AttemptMilestone): void {
    const attempt = milestone.attempt;
    switch (milestone.type) {
      case 'armed':
      case 'ended': {
        const window = clipWindow(milestone);
        if (window !== null) {
          this.plan(attempt, window.segment, window.startMs, window.endMs);
        }
        break;
      }
      case 'dropped':
        // Its clips waiting for their time are not saved; those already saved are removed.
        for (const [key, planned] of this.planned) {
          if (sameAttempt(planned.attempt, attempt)) {
            this.planned.delete(key);
            this.clearTimer(planned.timer);
            this.inFlight.end(attempt.session, attempt.index);
          }
        }
        for (const clip of milestone.clips) {
          this.remove(this.handle, attempt, clip);
        }
        break;
    }
  }

  /** Saves the clip of `segment` once its end is in the buffer, if the pipeline runs now. */
  private plan(attempt: AttemptRef, segment: VideoSegment, startMs: number, endMs: number): void {
    const handle = this.handle;
    const recorded = this.cameraEntry;
    if (handle === null || recorded === null) {
      return;
    }
    const key = `${attempt.session}/${String(attempt.index)}/${String(attempt.scrambleShown)}/${segment}`;
    const save = (): Promise<void> => {
      const saving = this.save(handle, recorded, attempt, segment, startMs, endMs);
      this.saving.add(saving);
      this.savingSignal.set(this.saving.size);
      void saving.finally(() => {
        this.saving.delete(saving);
        this.savingSignal.set(this.saving.size);
        // Saved in its record (or failed, or its attempt gone): its upload need not wait for it.
        this.inFlight.end(attempt.session, attempt.index);
      });
      return saving;
    };
    const delay = Math.max(0, endMs + ENCODER_SETTLE_MS - hostNow(this.globals));
    const timer = this.setTimer(() => {
      this.planned.delete(key);
      void save();
    }, delay);
    const previous = this.planned.get(key);
    if (previous !== undefined) {
      this.clearTimer(previous.timer);
      this.inFlight.end(attempt.session, attempt.index);
    }
    this.inFlight.begin(attempt.session, attempt.index);
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
  ): Promise<void> {
    if (!this.session.hasAttempt(attempt)) {
      return;
    }
    const fpsNominal = frameRateOf(recorded.entry);
    let clip: VideoClip;
    let report: ClipReport;
    try {
      // The session's folder exists once its creation is written.
      await this.session.whenSaved();
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
      clip = { ...saved.clip, crop: this.cropNow(recorded) };
      report = saved.report;
    } catch (error: unknown) {
      this.failed(attempt, segment, errorMessage(error));
      return;
    }
    let attached: Awaited<ReturnType<SessionService['attachClip']>>;
    try {
      attached = await this.session.attachClip(attempt, clip);
    } catch (error: unknown) {
      this.failed(attempt, segment, `its record could not be saved (${errorMessage(error)})`);
      return;
    }
    if (attached === 'gone') {
      // The attempt went while its clip was saved: its files go too.
      this.remove(handle, attempt, clip);
      return;
    }
    this.lastClipSignal.set({ index: attempt.index, clip });
    this.diagnostics.record(
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
        syncResidualMs: clip.syncResidualMs,
        audioRebasedMs: report.audioRebasedMs,
        kept: attached === 'kept',
      },
      { session: attempt.session, attempt: attempt.index },
    );
    this.remark(attempt, clip, report);
    void this.storageService.refresh();
  }

  /**
   * Says what a clip saved short of what was asked lacks, and notes it in its session (T2.9): that
   * it begins late (every such clip), that it has no sound and why, and that its audio was moved
   * onto the frames' clock (each once per run of the pipeline, since every clip then has it). That
   * the capture made its audio's decoder config is only noted, once: the clip has its sound, and the
   * note says which of the causes of issue #33 the device had.
   */
  private remark(attempt: AttemptRef, clip: VideoClip, report: ClipReport): void {
    const what = `${clip.segment} of attempt ${String(attempt.index)}`;
    const name = `${clip.segment === 'scramble' ? 'Scramble' : 'Solve'} clip of attempt ${String(attempt.index)}`;
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
      this.diagnostics.record(
        'audio.missing',
        { segment: clip.segment, cause: report.audioMissing },
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
      this.clipNoticeSignal.set(said.join(' '));
    }
  }

  /** Writes a line into a session's notes, and into the console as `cubetrace: …`. */
  private note(sessionId: string, line: string): void {
    console.warn(`cubetrace: ${line}`);
    this.session.addNote(sessionId, line).catch(() => undefined);
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
  private failed(attempt: AttemptRef, segment: VideoSegment, reason: string): void {
    if (!this.session.hasAttempt(attempt)) {
      return;
    }
    const line = `clip failed: ${segment} of attempt ${String(attempt.index)}: ${reason}`;
    this.failureSignal.set(line);
    this.diagnostics.record(
      'clip.failed',
      { segment, reason },
      { session: attempt.session, attempt: attempt.index },
    );
    this.note(attempt.session, line);
  }

  private startRefreshing(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    const tick = (): void => {
      void this.storageService.refresh();
      this.refreshTimer = this.setTimer(tick, STORAGE_REFRESH_MS);
    };
    tick();
  }

  private stopRefreshing(): void {
    if (this.refreshTimer !== null) {
      this.clearTimer(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Runs `task` after the starts and stops before it. */
  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setTimer(callback: () => void, ms: number): number {
    const set =
      this.globals.setTimeout ?? ((cb: () => void, delay: number) => setTimeout(cb, delay));
    return set(callback, ms);
  }

  private clearTimer(handle: number): void {
    const clear =
      this.globals.clearTimeout ??
      ((timer: number) => {
        clearTimeout(timer);
      });
    clear(handle);
  }
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
