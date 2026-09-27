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
  captureSupport,
  startCapture,
  type CaptureConfig,
  type CaptureHandle,
  type CaptureStats,
  type CaptureSupport,
} from '@cubetrace/capture';
import type { CameraInfo, VideoClip, VideoSegment } from '@cubetrace/core';

import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { STORAGE_STOP_PERCENT, StorageService } from '../device/storage-service';
import { SessionService, type AttemptMilestone, type AttemptRef } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { CameraService } from './camera-service';

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

/** The scramble clip begins this long before the first scramble turn (docs/PLAN.md, T2.4). */
export const SCRAMBLE_LEAD_MS = 2000;

/** The solve clip begins this long before the first solve turn. */
export const SOLVE_LEAD_MS = 3000;

/** Both clips end this long after their segment: the scramble done, the cube solved or the DNF. */
export const CLIP_TAIL_MS = 1000;

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

/** What the pipeline is to run on: the camera's stream, with or without the microphone. */
interface Target {
  readonly stream: MediaStream;
  readonly audio: boolean;
}

/**
 * The recording in the timer (docs/PLAN.md, T2.4). While the camera is on (`CameraService.stream`)
 * and a session is under way (or a cube is connected, so that the first attempt of a session has its
 * margin), the capture pipeline runs on the camera's stream, with the microphone's audio when
 * Settings says so ("Record audio"); it starts again when the stream changes (another camera,
 * another resolution) or the setting does, and stops when the camera goes off, no session is under
 * way, or storage is {@link STORAGE_STOP_PERCENT}% full (the timer goes on).
 *
 * Every attempt gets two clips, cut from the last 90 s the pipeline keeps in memory, as
 * `SessionService.milestones$` says: once the scramble is done, the scramble clip
 * `[scrambleStart − 2 s, scrambleDone + 1 s]`; once the attempt ended (solved or a DNF), the solve
 * clip `[solveStart − 3 s, end + 1 s]`, none when the solve never started. Each is saved one second
 * (and {@link ENCODER_SETTLE_MS}) after its end, in the attempt's folder, with the camera's framing
 * rectangle as its `crop`, and added to the attempt's record (`SessionService.attachClip`, which saves
 * the record again: its timing never changes). The session's `cameras` holds the camera's entry
 * while it records. A clip that fails is said once (`failure`, the console) and noted in the session's
 * `notes`; the attempt is untouched. A clip of an attempt that went meanwhile (a reset, Delete last)
 * is removed again. Stopping saves the clips still waiting for their time at once, with what the
 * buffer has.
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

  private readonly statusSignal = signal<RecordingStatus>('off');
  private readonly statsSignal = signal<CaptureStats | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  private readonly noticeSignal = signal<string | null>(null);
  private readonly lastClipSignal = signal<SavedClip | null>(null);
  private readonly failureSignal = signal<string | null>(null);

  /** See {@link RecordingStatus}. */
  readonly status = this.statusSignal.asReadonly();
  /** The pipeline's counters, once per second; null while it is not running. */
  readonly stats = this.statsSignal.asReadonly();
  /** Why it is not recording: it could not start, it stopped, or storage is full. */
  readonly error = this.errorSignal.asReadonly();
  /** What it records otherwise than asked: no audio (the microphone refused, or lost). */
  readonly notice = this.noticeSignal.asReadonly();
  /** The last clip saved. */
  readonly lastClip = this.lastClipSignal.asReadonly();
  /** The last clip that could not be saved, as its note says; null once dismissed. */
  readonly failure = this.failureSignal.asReadonly();
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
  private microphone: MediaStream | null = null;
  /** The camera's entry while it records: the label and framing of its clips. */
  private cameraEntry: CameraInfo | null = null;
  /** Incremented by every start and stop: a slower, older start then knows it lost. */
  private generation = 0;
  /** The clips waiting for their time, by attempt and segment. */
  private readonly planned = new Map<string, PlannedClip>();
  /** The clips being saved: a stop waits for them. */
  private readonly saving = new Set<Promise<void>>();
  /** The end of the last start or stop queued: they run one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private refreshTimer: number | null = null;

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
      untracked(() => {
        this.reconcile(stream, active, full, audio);
      });
    });
    // The session's `cameras` holds the camera's entry while it records.
    effect(() => {
      const status = this.statusSignal();
      const session = this.session.session();
      this.camera.settings();
      this.camera.framing();
      const audio = this.settings.recordAudio();
      if (session === null || (status !== 'starting' && status !== 'recording')) {
        return;
      }
      untracked(() => {
        const info = this.camera.cameraInfo();
        if (info !== null) {
          this.cameraEntry = info;
          this.session.putCamera(info, audio);
        }
      });
    });
  }

  /** Forgets the failure shown. */
  dismissFailure(): void {
    this.failureSignal.set(null);
  }

  /** Resolves once the starts and stops asked for so far are done (for tests). */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Starts, restarts or stops the pipeline as the camera, the session and the settings say. */
  private reconcile(
    stream: MediaStream | null,
    active: boolean,
    full: boolean,
    audio: boolean,
  ): void {
    if (stream === null) {
      this.stopRefreshing();
    } else {
      this.startRefreshing();
    }
    const wanted = stream !== null && active && !full && this.support.supported;
    if (!wanted) {
      if (this.target === null && this.handle === null) {
        this.showIdle(stream, full);
        return;
      }
      this.target = null;
      const generation = ++this.generation;
      void this.serially(async () => {
        await this.stopPipeline();
        if (generation === this.generation) {
          this.showIdle(stream, full);
        }
      });
      return;
    }
    const target = this.target;
    if (target?.stream === stream && target.audio === audio) {
      return;
    }
    const generation = ++this.generation;
    this.target = { stream, audio };
    void this.serially(async () => {
      await this.stopPipeline();
      if (generation === this.generation) {
        await this.startPipeline(generation, stream, audio);
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
    this.noticeSignal.set(null);
  }

  private async startPipeline(
    generation: number,
    stream: MediaStream,
    audio: boolean,
  ): Promise<void> {
    this.statusSignal.set('starting');
    this.errorSignal.set(null);
    this.noticeSignal.set(null);
    this.statsSignal.set(null);
    const video = stream.getVideoTracks().at(0);
    if (video === undefined) {
      this.fail(generation, 'The camera sends no video.');
      return;
    }
    const microphone = audio ? await this.openMicrophone(generation) : null;
    if (generation !== this.generation) {
      stopStream(microphone);
      return;
    }
    this.microphone = microphone;
    const audioTrack = microphone?.getAudioTracks().at(0) ?? null;
    let handle: CaptureHandle;
    try {
      handle = this.starter.start(video, audioTrack, { audio: audioTrack !== null });
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
    });
    handle.onError((error) => {
      if (this.handle !== handle) {
        return;
      }
      if (error.fatal) {
        // The buffer stays: the clips waiting for their time are still cut from it.
        this.statusSignal.set('error');
        this.errorSignal.set(`Recording stopped: ${error.message}`);
      } else {
        this.noticeSignal.set(error.message);
      }
    });
    void this.storageService.refresh();
  }

  /** The microphone, or null with a notice when it cannot be had: the video is recorded anyway. */
  private async openMicrophone(generation: number): Promise<MediaStream | null> {
    const media = this.globals.navigator?.mediaDevices;
    if (typeof media?.getUserMedia !== 'function') {
      this.noticeSignal.set('Recording without audio: this browser gives no microphone.');
      return null;
    }
    try {
      return await media.getUserMedia({ audio: true });
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.noticeSignal.set(`Recording without audio: ${microphoneProblem(error)}`);
      }
      return null;
    }
  }

  /**
   * Stops the pipeline: the clips waiting for their time are saved at once, with what the buffer
   * has, and written before the workers stop; then the microphone is let go.
   */
  private async stopPipeline(): Promise<void> {
    const handle = this.handle;
    const microphone = this.microphone;
    this.handle = null;
    this.microphone = null;
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
  }

  private onMilestone(milestone: AttemptMilestone): void {
    const attempt = milestone.attempt;
    switch (milestone.type) {
      case 'armed':
        this.plan(
          attempt,
          'scramble',
          milestone.scrambleStart - SCRAMBLE_LEAD_MS,
          milestone.scrambleDone + CLIP_TAIL_MS,
        );
        break;
      case 'ended': {
        const solveStart = milestone.record.events.solveStart;
        if (solveStart !== null) {
          this.plan(attempt, 'solve', solveStart - SOLVE_LEAD_MS, milestone.endMs + CLIP_TAIL_MS);
        }
        break;
      }
      case 'dropped':
        // Its clips waiting for their time are not saved; those already saved are removed.
        for (const [key, planned] of this.planned) {
          if (sameAttempt(planned.attempt, attempt)) {
            this.planned.delete(key);
            this.clearTimer(planned.timer);
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
    const entry = this.cameraEntry ?? this.camera.cameraInfo();
    if (handle === null || entry === null) {
      return;
    }
    const key = `${attempt.session}/${String(attempt.index)}/${String(attempt.scrambleShown)}/${segment}`;
    const save = (): Promise<void> => {
      const saving = this.save(handle, entry, attempt, segment, startMs, endMs);
      this.saving.add(saving);
      void saving.finally(() => this.saving.delete(saving));
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
    }
    this.planned.set(key, { timer, attempt, save });
  }

  /**
   * Saves one clip and adds it to its attempt's record; a failure is said and noted, and a clip
   * whose attempt went meanwhile is removed again.
   */
  private async save(
    handle: CaptureHandle,
    entry: CameraInfo,
    attempt: AttemptRef,
    segment: VideoSegment,
    startHostMs: number,
    endHostMs: number,
  ): Promise<void> {
    if (!this.session.hasAttempt(attempt)) {
      return;
    }
    const fpsNominal = frameRateOf(entry);
    let clip: VideoClip;
    try {
      // The session's folder exists once its creation is written.
      await this.session.whenSaved();
      const saved = await handle.saveClip({
        startHostMs,
        endHostMs,
        sessionId: attempt.session,
        index: attempt.index,
        camera: entry.label,
        segment,
        fpsNominal,
      });
      clip = { ...saved, crop: this.cropNow(entry) };
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
    void this.storageService.refresh();
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

  /** The framing rectangle now, as the clip's `crop`, or the one the camera recorded with. */
  private cropNow(entry: CameraInfo): VideoClip['crop'] {
    const now = this.camera.cameraInfo();
    return now !== null && now.label === entry.label ? now.crop : entry.crop;
  }

  /** Says once that a clip failed, and notes it in its session, unless its attempt is gone. */
  private failed(attempt: AttemptRef, segment: VideoSegment, reason: string): void {
    if (!this.session.hasAttempt(attempt)) {
      return;
    }
    const line = `clip failed: ${segment} of attempt ${String(attempt.index)}: ${reason}`;
    console.warn(`cubetrace: ${line}`);
    this.failureSignal.set(line);
    this.session.addNote(attempt.session, line).catch(() => undefined);
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

/** The frame rate the camera's track reports, for the clips' `fpsNominal`; 30 if it says none. */
function frameRateOf(entry: CameraInfo): number {
  const rate = entry.settings['frameRate'];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 30;
}

function sameAttempt(p: AttemptRef, q: AttemptRef): boolean {
  return p.session === q.session && p.index === q.index && p.scrambleShown === q.scrambleShown;
}

/** Why the microphone could not be had, in plain words. */
function microphoneProblem(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : null;
  switch (name) {
    case 'NotAllowedError':
      return 'the microphone was not allowed (Chrome asks once; the site settings can change it).';
    case 'NotFoundError':
      return 'this device has no microphone.';
    case 'NotReadableError':
      return 'the microphone is in use by another app.';
    default:
      return `the microphone could not be opened (${errorMessage(error)}).`;
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}
