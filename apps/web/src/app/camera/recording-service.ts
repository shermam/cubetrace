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
  type CaptureSupport,
  type FramingRect,
  type MotionMeterInfo,
  type MotionSample,
} from '@cubetrace/capture';

import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { StorageService } from '../device/storage-service';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { ClipsInFlight } from '../session/clips-in-flight';
import { SessionService, type AttemptMilestone } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import {
  CameraRecording,
  type CaptureStarter,
  type RecordingContext,
  type RecordingStatus,
  type RecordingTarget,
  type SavedClip,
} from './camera-recording';
import type { HostCamera } from './host-camera';
import { HostCamerasService } from './host-cameras-service';

// A camera's recording, which lives with it (`CameraRecording`, T5.5), exported here as before.
export {
  ENCODER_SETTLE_MS,
  LOAD_ADVICE,
  LOAD_SHARE,
  LOAD_WINDOW_MS,
  STATS_KEPT_MS,
  STORAGE_FULL,
  pipelineSummary,
  type CaptureStarter,
  type LatencyRestart,
  type PipelineSummary,
  type RecordingLoad,
  type RecordingStatus,
  type SavedClip,
} from './camera-recording';
// The clips' windows, which the remote cameras' cuts share (T4.2), live in clip-windows.ts.
export {
  CLIP_TAIL_MS,
  SCRAMBLE_CLIP_MAX_MS,
  SCRAMBLE_LEAD_MS,
  SOLVE_LEAD_MS,
} from './clip-windows';

export const CAPTURE_STARTER = new InjectionToken<CaptureStarter>('CAPTURE_STARTER', {
  providedIn: 'root',
  factory: () => ({
    support: () => captureSupport(),
    start: (video, audio, config) =>
      startCapture(new MediaStream(audio === null ? [video] : [video, audio]), config),
  }),
});

/** The usage of the origin's storage, for the meter. */
export interface StorageMeterValue {
  readonly usage: number;
  readonly quota: number;
  /** Of the quota, 0 to 100. */
  readonly percent: number;
}

/** The storage meter is read again this often, besides after every clip. */
export const STORAGE_REFRESH_MS = 60_000;

/**
 * The recording in the timer (docs/PLAN.md, T2.4; a pipeline per camera since T5.5). Every camera of
 * the host that is on (`HostCamerasService.cameras`) has its recording (`CameraRecording`): while a
 * session is under way (or a cube is connected, so that the first attempt of a session has its
 * margin), the capture pipeline runs on the camera's stream, at the video quality Settings say
 * (T2.10), the first camera's with the microphone's audio when Settings say so ("Record audio", raw
 * unless Settings say Voice, T2.12), the others' without sound; each starts again when its stream
 * changes or one of those settings does (the first camera's when another camera becomes the first:
 * the microphone goes with it), and stops when its camera goes off, no session is under way, or
 * storage is full (the timer goes on).
 *
 * Every attempt gets two clips from every camera, cut from the last 90 s each pipeline keeps in
 * memory, as `SessionService.milestones$` says, each under the label the session gives its camera
 * (T2.14: `laptop`, then `laptop-2`, in the cameras' order whichever pipeline starts first:
 * `putEntries`). The session's `cameras` holds each camera's entry while it records, the first one's
 * with its microphone. A clip saved, a clip that failed and a clip saved short of what was asked are
 * said here (`lastClip`, `failure`, `clipNotice`), whichever camera's; the rest is each recording's.
 * `status`, `stats`, `notices` and the like are the first camera's, for the parts that show one
 * recording; `recordings` and `recordingOf` give each.
 */
@Injectable({ providedIn: 'root' })
export class RecordingService {
  private readonly hosts = inject(HostCamerasService);
  private readonly session = inject(SessionService);
  private readonly cube = inject(CubeService);
  private readonly settings = inject(SettingsService);
  private readonly storageService = inject(StorageService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly starter = inject(CAPTURE_STARTER);
  private readonly diagnostics = inject(DiagnosticsService);

  private readonly recordingsSignal = signal<readonly CameraRecording[]>([]);
  private readonly lastClipSignal = signal<SavedClip | null>(null);
  private readonly failureSignal = signal<string | null>(null);
  private readonly clipNoticeSignal = signal<string | null>(null);

  /** The browser can record (Chrome); the APIs it lacks otherwise. */
  readonly support: CaptureSupport;
  /** Each camera's recording, in the cameras' order (`HostCamerasService.cameras`). */
  readonly recordings = this.recordingsSignal.asReadonly();
  /** The first camera's recording: the one with the microphone; null while no camera is on. */
  readonly primary = computed(() => this.recordingsSignal().at(0) ?? null);
  /** The first camera's {@link RecordingStatus}; `off` while no camera is on. */
  readonly status = computed<RecordingStatus>(() => this.primary()?.status() ?? 'off');
  /** The first camera's pipeline's counters, once per second; null while it is not running. */
  readonly stats = computed(() => this.primary()?.stats() ?? null);
  /** Why the first camera does not record: it could not start, it stopped, or storage is full. */
  readonly error = computed(() => this.primary()?.error() ?? null);
  /** What the first camera records otherwise than asked (`CameraRecording.notices`). */
  readonly notices = computed<readonly string[]>(() => this.primary()?.notices() ?? []);
  /** The last clip saved, whichever camera's. */
  readonly lastClip = this.lastClipSignal.asReadonly();
  /** The last clip that could not be saved, as its note says; null once dismissed. */
  readonly failure = this.failureSignal.asReadonly();
  /**
   * What the last clip saved short of what was asked lacks (T2.9): it begins late (its start was
   * older than the 90 s in memory), it has no sound and why, or its audio was moved onto the frames'
   * clock; as its notes say; null once dismissed.
   */
  readonly clipNotice = this.clipNoticeSignal.asReadonly();
  /** How many clips are being saved (cut, muxed and written) now, every camera's. */
  readonly savingClips = computed(() =>
    this.recordingsSignal().reduce((count, recording) => count + recording.savingClips(), 0),
  );
  /**
   * The microphone of the recording (T2.12), the first camera's: how it was asked for and what the
   * browser says it applied; null without one. The session's entry of the camera holds it.
   */
  readonly microphone = computed(() => this.primary()?.microphone() ?? null);
  /** The first camera's capture latency's drift from its sync check (T5.3); null otherwise. */
  readonly latencyDrift = computed(() => this.primary()?.latencyDrift() ?? null);
  /** The first camera's restart for its drifting latency (T5.3), while the drift lasts. */
  readonly restarted = computed(() => this.primary()?.restarted() ?? null);
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

  /** What each camera's recording works with. */
  private readonly context: RecordingContext;
  /** The recordings stopping for good (their cameras gone): a test's `settled` waits for them. */
  private readonly stopping = new Set<Promise<void>>();
  private refreshTimer: number | null = null;

  constructor() {
    this.support = this.starter.support();
    this.context = {
      session: this.session,
      settings: this.settings,
      storage: this.storageService,
      globals: this.globals,
      starter: this.starter,
      support: this.support,
      inFlight: inject(ClipsInFlight),
      diagnostics: this.diagnostics,
      putEntries: () => {
        this.putEntries();
      },
      several: () => this.several(),
      saved: (clip) => {
        this.lastClipSignal.set(clip);
      },
      failed: (line) => {
        this.failureSignal.set(line);
      },
      remarked: (text) => {
        this.clipNoticeSignal.set(text);
      },
    };
    const subscription = this.session.milestones$.subscribe((milestone) => {
      this.onMilestone(milestone);
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.stopRefreshing();
      for (const recording of this.recordingsSignal()) {
        void recording.stop();
      }
      this.recordingsSignal.set([]);
    });
    // The pipelines follow the cameras, the session and the settings.
    effect(() => {
      const cameras = this.hosts.cameras();
      const streams = cameras.map((camera) => camera.stream());
      const active = this.session.session() !== null || this.cube.status() === 'connected';
      const full = this.storageService.level() === 'full';
      const audio = this.settings.recordAudio();
      const processing = this.settings.microphoneProcessing();
      const quality = this.settings.videoQuality();
      untracked(() => {
        this.reconcile(cameras, streams, active, full, { audio, processing, quality });
      });
    });
    // Each camera's capture latency drifts from its last sync check (T5.3): its meter's median then,
    // kept in the session's `clock.cameras`; another camera starts from nothing.
    effect(() => {
      const session = this.session.session();
      for (const recording of this.recordingsSignal()) {
        const camera = recording.camera;
        const identity = camera.identity();
        const label =
          identity === null || camera.status() !== 'on'
            ? null
            : this.session.cameraLabel(identity);
        const check = label === null || session === null ? undefined : session.clock.cameras[label];
        const baseline =
          check === undefined || check.clapperboardSamples === 0
            ? null
            : (check.captureLatencyAtCheckMs ?? null);
        untracked(() => {
          recording.setDriftBaseline(label, baseline);
        });
      }
    });
    // The session's `cameras` holds each camera's entry while it records, the first one's with the
    // microphone, under the label the session gives the device (T2.14), in the cameras' order.
    effect(() => {
      this.session.session();
      this.settings.recordAudio();
      for (const recording of this.recordingsSignal()) {
        recording.status();
        recording.microphone();
        recording.camera.settings();
        recording.camera.framing();
      }
      untracked(() => {
        this.putEntries();
      });
    });
  }

  /** The recording of `camera`; null when it has none (it is not one of the host's cameras on). */
  recordingOf(camera: HostCamera): CameraRecording | null {
    return this.recordingsSignal().find((recording) => recording.camera === camera) ?? null;
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
  async settled(): Promise<void> {
    await Promise.all([
      ...this.recordingsSignal().map((recording) => recording.settled()),
      ...this.stopping,
    ]);
  }

  /**
   * The first camera's capture latency now (T5.3): the running median of its meter's last 10 s, ms;
   * null without one. A sync check keeps it as its baseline (`captureLatencyAtCheckMs`).
   */
  captureLatencyMs(): number | null {
    return this.primary()?.captureLatencyMs() ?? null;
  }

  /**
   * Measures the motion of the first camera's frames inside `rect` for the sync check
   * (`CameraRecording.watchMotion`); null while it does not record.
   */
  watchMotion(
    rect: FramingRect | null,
    onSample: (sample: MotionSample) => void,
    onError: (message: string) => void,
    onMeter?: (meter: MotionMeterInfo) => void,
  ): (() => void) | null {
    return this.primary()?.watchMotion(rect, onSample, onError, onMeter) ?? null;
  }

  /**
   * A recording for each camera on (a camera turned off has its recording stopped: its clips waiting
   * for their time saved first), each told what to record: the first one with the microphone.
   */
  private reconcile(
    cameras: readonly HostCamera[],
    streams: readonly (MediaStream | null)[],
    active: boolean,
    full: boolean,
    wanted: Omit<RecordingTarget, 'stream'>,
  ): void {
    if (streams.some((stream) => stream !== null)) {
      this.startRefreshing();
    } else {
      this.stopRefreshing();
    }
    const before = this.recordingsSignal();
    const next = cameras.map(
      (camera) =>
        before.find((recording) => recording.camera === camera) ??
        new CameraRecording(this.context, camera),
    );
    for (const recording of before) {
      if (!next.includes(recording)) {
        const stopped = recording.stop();
        this.stopping.add(stopped);
        void stopped.finally(() => this.stopping.delete(stopped));
      }
    }
    if (next.length !== before.length || next.some((recording, k) => recording !== before[k])) {
      this.recordingsSignal.set(next);
    }
    next.forEach((recording, k) => {
      recording.reconcile(streams[k] ?? null, active, full, {
        ...wanted,
        audio: wanted.audio && k === 0,
      });
    });
  }

  /**
   * Puts the entry of every camera recording in the session under way, in the cameras' order: the
   * labels the session gives them follow that order (`laptop`, `laptop-2`), whichever pipeline
   * started first.
   */
  private putEntries(): void {
    const audio = this.settings.recordAudio();
    for (const recording of this.recordingsSignal()) {
      recording.putEntry(audio);
    }
  }

  /** More than one camera records (or is starting to). */
  private several(): boolean {
    return (
      this.recordingsSignal().filter((recording) => {
        const status = recording.status();
        return status === 'starting' || status === 'recording';
      }).length > 1
    );
  }

  private onMilestone(milestone: AttemptMilestone): void {
    const recordings = this.recordingsSignal();
    for (const recording of recordings) {
      recording.onMilestone(milestone);
    }
    if (milestone.type === 'dropped') {
      // The clips saved for the attempt that went are removed, through any pipeline that runs.
      recordings.some((recording) => recording.removeClips(milestone.attempt, milestone.clips));
    }
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
