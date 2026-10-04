import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isWideFraming } from '@cubetrace/capture';
import type { CameraClock } from '@cubetrace/core';

import { APP_BUILD } from '../../environments/version';
import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SessionService, type TimerPhase } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';
import { CameraService } from './camera-service';
import { RecordingService } from './recording-service';
import { RemoteCameraRegistry, type RemoteCameraEntry } from './remote-camera-registry';
import {
  syncReport,
  syncReportFileName,
  syncSummaryLine,
  type SyncReport,
  type SyncReportContext,
} from './sync-report';
import { SyncRun, type SyncOutcome } from './sync-run';

/** The timer's phases in which no check starts: a solve is about to start, under way or paused. */
const SOLVING: ReadonlySet<TimerPhase> = new Set<TimerPhase>(['armed', 'solving', 'paused']);

/**
 * Why a check cannot start now: no recording to measure, no cube to turn, the session not read yet,
 * a scramble begun (the check starts from where the attempt starts, the cube as the scramble found
 * it), a solve about to start or under way, or a check running; and, for a remote camera (T4.3), the
 * phone not connected to this session, its clock sync without an answer yet (its frames cannot be
 * placed on the host clock), or the phone not recording.
 */
export type SyncBlock =
  | 'not-recording'
  | 'no-cube'
  | 'loading'
  | 'scrambling'
  | 'solving'
  | 'running'
  | 'remote-gone'
  | 'remote-syncing'
  | 'remote-not-recording';

/** A check that ended, as the panel says it. */
export interface SyncCheckResult {
  /** The camera it measured, by its label in the session (`laptop`, `laptop-2`, `phone-front`). */
  readonly label: string;
  /** The phone's host label when the camera was a remote one (T4.3); null for this device's own. */
  readonly remote: string | null;
  readonly outcome: SyncOutcome;
  /** The camera's lag in the session before this check (a check run again), ms; null if none. */
  readonly previousOffsetMs: number | null;
  /** The lag was written in the session (false: no session was under way). */
  readonly saved: boolean;
}

/**
 * The sync check of the Timer page (docs/PLAN.md, T2.5 and T2.8): how far the camera's frames lag
 * the cube. When a session is under way with the camera recording, a cube connected and no check of
 * this camera in the session's `clock.cameras`, the check is due by itself, once per session and
 * camera, when the cube is where an attempt starts (not once its scramble has begun, nor while a
 * solve is about to start, under way or paused), and the panel shows it; "Sync check" makes it due
 * again whenever one could start by itself (`blocked` says why not, and a start refused says so in
 * `notice`), and "Later" hides the panel, ending a check under way.
 *
 * A check looks for motion inside the framing rectangle: while the rectangle is the whole frame or
 * most of it (`framingWide`), a check that is due first asks for a rectangle around the cube
 * (`waiting`, with "Edit the framing", which opens Camera settings to the editor), and starts only
 * when asked to (`start` once the rectangle is set, or `startAnyway`, which the rest of the session
 * remembers for the camera).
 *
 * A check asks for one face turned and turned back, five times, so that the cube ends as it began,
 * and the timer tracks no attempt meanwhile (`SessionService.suspendForSyncCheck`); it asks to hold
 * still for its first second (since T2.11), waits 20 s from its start for the first turn, then runs
 * until the ten turns are made (`SyncRun`), watching the camera's motion
 * in the framing rectangle, measured by the capture worker, and the cube's moves, and the
 * clapperboard gives the lag. When it ends, the timer stays suspended until the cube has been still
 * for 2 s or the result is dismissed (`SessionService.holdAfterSyncCheck`), so that turns made after
 * it go to no attempt; the attempt that had not started its scramble then begins again with its
 * scramble and number. On success the lag goes into the session's `clock.cameras[label]` (`rttMs`
 * and `driftPpm` 0: the camera is this device's; the pairs the spread keeps), replacing an earlier
 * check's, and the camera's later clips carry it as their `syncResidualMs`
 * (`SessionService.attachClip`). The label is the one the session gives the device (T2.14,
 * `SessionService.cameraLabel`): each camera of a session has a check of its own, a camera switched
 * to that has none is due one, and a camera switched back to finds its own. A check ends as failed
 * when the recording stops or the cube disconnects. Every check that ends writes one line to the
 * console, and its diagnostics can be downloaded (`downloadReport`, sync-report.ts).
 *
 * Since T4.3 a check can measure a remote camera, a phone of the Cameras section
 * (`start({remote})`, from its line under the preview): the same check (hold still, the countdown, ten
 * single turns) on the same cube's turns, the frames' motion measured by the phone inside its own
 * framing rectangle and sent with its times (`RemoteCameraRegistry.watchMotion`: the phone's worker
 * measures, the host places each frame on its clock with the clock sync and runs the clapperboard),
 * so that every camera's lag comes from one code path. Its lag is that of the phone's frames behind
 * the cube on the host clock, once their times are converted: the camera's own latency and the
 * phone's delivery, plus what the clock estimate is off by. It goes into `clock.cameras[label]`
 * beside the clock sync's record (`remote`, kept as it is, or the estimate of the check when there is
 * none), and the phone's later clips take it as their `syncResidualMs`, as a local camera's do. A
 * remote check is never due by itself (two checks back to back at a session's start ask too much: the
 * line under the preview says the phone has none), and asks for the framing on the phone while the
 * phone's rectangle is wide; it ends as failed when the phone leaves, stops recording or cannot
 * measure its frames.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly camera = inject(CameraService);
  private readonly recording = inject(RecordingService);
  private readonly session = inject(SessionService);
  private readonly cube = inject(CubeService);
  private readonly settings = inject(SettingsService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly document = inject(DOCUMENT);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly registry = inject(RemoteCameraRegistry);

  private readonly runSignal = signal<SyncRun | null>(null);
  /** The remote camera of the check shown (under way, waiting or ended); null for this device's. */
  private readonly targetSignal = signal<string | null>(null);
  private readonly resultSignal = signal<SyncCheckResult | null>(null);
  private readonly visibleSignal = signal(false);
  private readonly waitingSignal = signal(false);
  private readonly noticeSignal = signal<string | null>(null);

  /**
   * The camera's label in the session (`laptop`, `laptop-2`, `phone-front`…: the one the session
   * gives the device, T2.14); null while it is not on.
   */
  readonly label = computed(() => {
    const identity = this.camera.identity();
    return this.camera.status() === 'on' && identity !== null
      ? this.session.cameraLabel(identity)
      : null;
  });
  /** The camera's clock sync in the current session, from an earlier check; null if none. */
  readonly stored = computed<CameraClock | null>(() => {
    const label = this.label();
    const session = this.session.session();
    if (label === null || session === null) {
      return null;
    }
    return session.clock.cameras[label] ?? null;
  });
  /** The check under way, or the last one; null before the first. */
  readonly run = this.runSignal.asReadonly();
  /**
   * The remote camera (its id in the Cameras section) that the check shown measures (T4.3); null for
   * this device's own camera.
   */
  readonly target = this.targetSignal.asReadonly();
  /** That remote camera, while it is listed; null for this device's own, or when it is gone. */
  readonly targetCamera = computed<RemoteCameraEntry | null>(() => {
    const id = this.targetSignal();
    return id === null ? null : this.registry.find(id);
  });
  /** The remote cameras of the session under way that have a label (T4.3), for their lines. */
  readonly remotes = computed(() => {
    const session = this.session.session()?.id ?? null;
    return this.registry
      .cameras()
      .filter((camera) => camera.label !== null && camera.session === session);
  });
  /** How the last check ended; null while one runs or waits, and before the first. */
  readonly result = this.resultSignal.asReadonly();
  /** Whether the panel shows (a check under way, waiting for the framing, or just ended). */
  readonly visible = this.visibleSignal.asReadonly();
  /**
   * A check is due but waits to be started: while the framing rectangle is wide, the panel asks for
   * one around the cube first (T2.8).
   */
  readonly waiting = this.waitingSignal.asReadonly();
  /**
   * The framing rectangle of the check's camera is the whole frame or most of it (`isWideFraming`): a
   * check there sees a turn in too few of its pixels. For a remote camera (T4.3), the phone's, as it
   * reports it.
   */
  readonly framingWide = computed(() => {
    if (this.targetSignal() === null) {
      return isWideFraming(this.camera.framing(), this.camera.frameSize());
    }
    const remote = this.targetCamera();
    return isWideFraming(remote?.framing ?? null, remote?.frame ?? null);
  });
  /** Why the last request to start a check was refused, in plain words; null otherwise. */
  readonly notice = this.noticeSignal.asReadonly();
  /** Why a check of this device's camera cannot start now; null when it can. */
  readonly blocked = computed<SyncBlock | null>(() => {
    if (this.runSignal()?.state() === 'running') {
      return 'running';
    }
    if (this.recording.status() !== 'recording' || this.label() === null) {
      return 'not-recording';
    }
    return this.attemptBlock();
  });

  /** The session and camera labels the check was due by itself for: once each. */
  private readonly prompted = new Set<string>();
  /** The session and camera labels whose checks were started anyway, the framing wide. */
  private readonly insisted = new Set<string>();
  /** Where the check under way, or the last one, ran: for its diagnostics. */
  private context: SyncReportContext | null = null;

  constructor() {
    // At the start of a session with the camera recording, and for a camera the session has no
    // check of, the check is due by itself.
    effect(() => {
      const session = this.session.session();
      const label = this.label();
      const stored = this.stored();
      const blocked = this.blocked();
      untracked(() => {
        if (session === null || label === null || stored !== null || blocked !== null) {
          return;
        }
        const key = `${session.id} ${label}`;
        if (!this.prompted.has(key)) {
          this.prompted.add(key);
          this.start();
        }
      });
    });
    // A check of this device's camera ends when the recording stops (the camera off or switched,
    // storage full); the cube's disconnection ends any check (`SyncRun`), and a remote camera's ends
    // when the phone leaves or cannot measure (its watch's error).
    effect(() => {
      const recording = this.recording.status() === 'recording';
      untracked(() => {
        const run = this.runSignal();
        if (!recording && run?.state() === 'running' && this.targetSignal() === null) {
          run.interrupt('recording stopped');
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.runSignal()?.cancel();
    });
  }

  /**
   * Why a check of the remote camera `id` (T4.3) cannot start now; null when it can: the phone
   * connected to the session under way with a camera, its clock sync answered, recording, and the
   * attempt where a check can start.
   */
  remoteBlocked(id: string): SyncBlock | null {
    if (this.runSignal()?.state() === 'running') {
      return 'running';
    }
    const camera = this.registry.find(id);
    if (
      camera?.state !== 'connected' ||
      camera.label === null ||
      camera.session !== this.session.session()?.id
    ) {
      return 'remote-gone';
    }
    if (!camera.synced) {
      return 'remote-syncing';
    }
    if (!camera.recording) {
      return 'remote-not-recording';
    }
    return this.attemptBlock();
  }

  /**
   * The lag the session has for the camera labelled `label` from a check, its clock entry: null when
   * it has none (a remote camera's entry before its check holds its clock sync alone).
   */
  checkOf(label: string): CameraClock | null {
    const clock = this.session.session()?.clock.cameras[label];
    return clock === undefined || clock.clapperboardSamples === 0 ? null : clock;
  }

  /**
   * Starts a check and shows the panel; the timer tracks no attempt until the check ends and the cube
   * is still. The camera is this device's own, or the remote camera `remote` (T4.3: a phone of the
   * Cameras section, by its id). While its framing rectangle is wide, the panel asks for a tighter
   * one first, and the check waits (unless `anyway`, or it was started anyway before for this camera
   * in this session). When a check cannot start now (`blocked`, `remoteBlocked`, or the timer refuses
   * to suspend its attempts), `notice` says why.
   */
  start(options: { readonly anyway?: boolean; readonly remote?: string | null } = {}): void {
    this.noticeSignal.set(null);
    const remote = options.remote ?? null;
    const camera = remote === null ? null : this.registry.find(remote);
    const label = remote === null ? this.label() : (camera?.label ?? null);
    const blocked = remote === null ? this.blocked() : this.remoteBlocked(remote);
    if (blocked !== null || label === null) {
      this.noticeSignal.set(`The sync check cannot start now: ${blockedWords(blocked)}`);
      return;
    }
    this.targetSignal.set(remote);
    const key = `${this.session.session()?.id ?? ''} ${label}`;
    if (options.anyway === true) {
      this.insisted.add(key);
    }
    if (this.framingWide() && !this.insisted.has(key)) {
      this.resultSignal.set(null);
      this.waitingSignal.set(true);
      this.visibleSignal.set(true);
      return;
    }
    if (!this.session.suspendForSyncCheck()) {
      this.noticeSignal.set(
        'The sync check cannot start now: the timer is about to start or timing a solve.',
      );
      return;
    }
    const previousOffsetMs =
      remote === null ? (this.stored()?.offsetMs ?? null) : (this.checkOf(label)?.offsetMs ?? null);
    const identity = remote === null ? this.camera.identity() : null;
    const rect = remote === null ? this.camera.framing() : (camera?.framing ?? null);
    this.context =
      camera === null
        ? {
            label,
            deviceLabel: this.camera.label(),
            frameSize: this.camera.frameSize(),
            framing: rect,
            app: APP_BUILD,
            userAgent: this.globals.navigator?.userAgent ?? null,
          }
        : {
            label,
            deviceLabel: camera.deviceLabel,
            frameSize: camera.frame,
            framing: rect,
            app: APP_BUILD,
            userAgent: this.globals.navigator?.userAgent ?? null,
            remote: { peer: camera.name, clock: this.registry.clockRecord(camera.id) },
          };
    this.waitingSignal.set(false);
    this.resultSignal.set(null);
    this.visibleSignal.set(true);
    this.runSignal.set(
      new SyncRun({
        watch: (region, onSample, onError, onMeter) =>
          remote === null
            ? this.recording.watchMotion(region, onSample, onError, onMeter)
            : this.registry.watchMotion(remote, onSample, onError, onMeter),
        unwatched:
          remote === null
            ? undefined
            : "the phone's frames could not be measured (it is not connected)",
        rect,
        events$: this.cube.events$,
        now: () => hostNow(this.globals),
        setTimeout: (callback, ms) => this.setTimer(callback, ms),
        clearTimeout: (handle) => {
          this.clearTimer(handle);
        },
        onEnd: (outcome, run) => {
          if (outcome === null) {
            // Cancelled ("Later"): nothing to wait for.
            this.session.resumeAfterSyncCheck();
          } else {
            this.session.holdAfterSyncCheck();
            // The camera's label in the session now: New session may have come during the check.
            const now =
              remote !== null
                ? (this.registry.find(remote)?.label ?? label)
                : identity === null
                  ? label
                  : this.session.cameraLabel(identity);
            this.finish(now, previousOffsetMs, outcome, run, camera);
          }
        },
      }),
    );
  }

  /**
   * Start, Retry, Check again: a check of the camera the panel shows (this device's, or the remote
   * camera of the last check, T4.3).
   */
  again(options: { readonly anyway?: boolean } = {}): void {
    this.start({ ...options, remote: this.targetSignal() });
  }

  /** "Start anyway": the check of the panel's camera starts although its framing is wide. */
  startAnyway(): void {
    this.again({ anyway: true });
  }

  /** "Edit the framing": Camera settings open to the framing rectangle's editor. */
  editFraming(): void {
    this.camera.setFramingEditing(true);
  }

  /**
   * "Later" (or "Close"): hides the panel, ending a check under way without a result, or dismissing
   * the one that ended, which lets the timer go on (`SessionService.resumeAfterSyncCheck`).
   */
  later(): void {
    const run = this.runSignal();
    if (run?.state() === 'running') {
      run.cancel();
    } else {
      this.session.resumeAfterSyncCheck();
    }
    this.waitingSignal.set(false);
    this.noticeSignal.set(null);
    this.visibleSignal.set(false);
  }

  /**
   * The diagnostics of the last check that ended (`SyncReport`): where it ran, the frames' motion,
   * the moves, what the detection saw around each turn; null before the first.
   */
  report(run: SyncRun | null = this.runSignal()): SyncReport | null {
    const outcome = run?.outcome() ?? null;
    if (run === null || outcome === null || this.context === null) {
      return null;
    }
    return syncReport(run.data(), outcome, this.context, hostNow(this.globals));
  }

  /** "Download check data": the last check's diagnostics as a JSON file. */
  downloadReport(): void {
    const report = this.report();
    if (report === null) {
      return;
    }
    try {
      const fileName = syncReportFileName(report.createdMs);
      downloadJson(this.globals, this.document, fileName, report);
      this.diagnostics.record('files.downloaded', {
        what: 'sync-check',
        files: 1,
        names: fileName,
      });
    } catch (error: unknown) {
      this.noticeSignal.set(`The check's data could not be saved: ${errorMessage(error)}`);
    }
  }

  /**
   * Keeps a check's lag in the session, says how it went, and writes its line to the console. A
   * remote camera's lag goes beside its clock sync's record (`remote`: the one there, or the
   * estimate of the check when there is none), whose round trip and drift the entry repeats.
   */
  private finish(
    label: string,
    previousOffsetMs: number | null,
    outcome: SyncOutcome,
    run: SyncRun,
    camera: RemoteCameraEntry | null,
  ): void {
    let saved = false;
    const clock = camera === null ? null : this.registry.clockRecord(camera.id);
    if (outcome.ok) {
      const kept = this.session.session()?.clock.cameras[label];
      const record = camera === null ? null : (kept?.remote ?? clock);
      saved = this.session.putCameraClock(label, {
        offsetMs: outcome.offsetMs,
        rttMs: record?.rttMs ?? 0,
        driftPpm: record?.driftPpm ?? 0,
        clapperboardResidualMs: outcome.clapperboardResidualMs,
        clapperboardSamples: outcome.clapperboardSamples,
        samples: outcome.samples,
        ...(record === null ? {} : { remote: record }),
      });
    }
    this.resultSignal.set({
      label,
      remote: camera?.name ?? null,
      outcome,
      previousOffsetMs,
      saved,
    });
    const report = this.report(run);
    if (report !== null) {
      console.info(syncSummaryLine(report));
      const { result } = report;
      const remote =
        camera === null
          ? {}
          : {
              remote: true,
              peer: camera.name,
              clockConverged: clock?.converged ?? null,
              clockOffsetMs: clock === null ? null : Math.round(clock.offsetMs * 10) / 10,
              clockRttMs: clock === null ? null : Math.round(clock.rttMs * 10) / 10,
              clockSamples: clock?.samples ?? null,
            };
      this.diagnostics.record('sync.check', {
        outcome: result.ok ? 'ok' : 'failed',
        reason: result.reason,
        message: result.message,
        camera: label,
        offsetMs: result.offsetMs,
        spreadMs: result.spreadMs,
        previousOffsetMs,
        matched: result.matched,
        of: result.matched + result.unmatched,
        kept: result.kept,
        moves: result.moves,
        frames: result.frames,
        durationMs: Math.round(result.durationMs),
        frameIntervalMs: result.frameIntervalMs,
        wide: report.framing.wide,
        costMs: result.cost?.medianMs ?? null,
        saved,
        ...remote,
      });
    }
  }

  /**
   * Why no check can start now, whatever the camera: no cube to turn, the session not read yet, a
   * solve about to start or under way, a scramble begun; null when one can.
   */
  private attemptBlock(): SyncBlock | null {
    if (this.cube.status() !== 'connected') {
      return 'no-cube';
    }
    if (!this.session.ready()) {
      return 'loading';
    }
    if (SOLVING.has(this.session.phase())) {
      return 'solving';
    }
    const attempt = this.session.attempt();
    return attempt?.state === 'scrambling' && attempt.events.scrambleStart !== null
      ? 'scrambling'
      : null;
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

/** Why a check cannot start, as the end of a sentence. */
function blockedWords(blocked: SyncBlock | null): string {
  switch (blocked) {
    case 'running':
      return 'a check is under way.';
    case 'no-cube':
      return 'no cube is connected.';
    case 'loading':
      return 'the session is still being read.';
    case 'scrambling':
      return "the scramble has begun; it can after the solve, or before the scramble's first turn.";
    case 'solving':
      return 'a solve is about to start or under way; it can after the solve.';
    case 'remote-gone':
      return 'the phone is not connected to this session.';
    case 'remote-syncing':
      return "the phone's clock sync has had no answer yet.";
    case 'remote-not-recording':
      return 'the phone is not recording.';
    case 'not-recording':
    case null:
      return 'the camera is not recording (it records while a session is under way).';
  }
}
