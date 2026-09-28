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
import { cameraLabel, isWideFraming } from '@cubetrace/capture';
import type { CameraClock } from '@cubetrace/core';

import { APP_BUILD } from '../../environments/version';
import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { SessionService, type TimerPhase } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';
import { CameraService } from './camera-service';
import { RecordingService } from './recording-service';
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
 * it), a solve about to start or under way, or a check running.
 */
export type SyncBlock =
  'not-recording' | 'no-cube' | 'loading' | 'scrambling' | 'solving' | 'running';

/** A check that ended, as the panel says it. */
export interface SyncCheckResult {
  /** The camera it measured, by its label in the session (`laptop`, `phone-front`). */
  readonly label: string;
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
 * (`SessionService.attachClip`). A check ends as failed when the recording stops or the cube
 * disconnects. Every check that ends writes one line to the console, and its diagnostics can be
 * downloaded (`downloadReport`, sync-report.ts).
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

  private readonly runSignal = signal<SyncRun | null>(null);
  private readonly resultSignal = signal<SyncCheckResult | null>(null);
  private readonly visibleSignal = signal(false);
  private readonly waitingSignal = signal(false);
  private readonly noticeSignal = signal<string | null>(null);

  /** The camera's label in the session (`laptop`, `phone-front`…); null while it is not on. */
  readonly label = computed(() =>
    this.camera.status() === 'on'
      ? cameraLabel(this.settings.hostLabel(), this.camera.facing())
      : null,
  );
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
   * The framing rectangle is the whole frame or most of it (`isWideFraming`): a check there sees a
   * turn in too few of its pixels.
   */
  readonly framingWide = computed(() =>
    isWideFraming(this.camera.framing(), this.camera.frameSize()),
  );
  /** Why the last request to start a check was refused, in plain words; null otherwise. */
  readonly notice = this.noticeSignal.asReadonly();
  /** Why a check cannot start now; null when it can. */
  readonly blocked = computed<SyncBlock | null>(() => {
    if (this.runSignal()?.state() === 'running') {
      return 'running';
    }
    if (this.recording.status() !== 'recording' || this.label() === null) {
      return 'not-recording';
    }
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
    // A check ends when the recording stops (the camera off or switched, storage full); the cube's
    // disconnection ends it too (`SyncRun`).
    effect(() => {
      const recording = this.recording.status() === 'recording';
      untracked(() => {
        const run = this.runSignal();
        if (!recording && run?.state() === 'running') {
          run.interrupt('recording stopped');
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.runSignal()?.cancel();
    });
  }

  /**
   * Starts a check and shows the panel; the timer tracks no attempt until the check ends and the cube
   * is still. While the framing rectangle is wide, the panel asks for a tighter one first, and the
   * check waits (unless `anyway`, or it was started anyway before for this camera in this session).
   * When a check cannot start now (`blocked`, or the timer refuses to suspend its attempts), `notice`
   * says why.
   */
  start(options: { readonly anyway?: boolean } = {}): void {
    this.noticeSignal.set(null);
    const label = this.label();
    const blocked = this.blocked();
    if (blocked !== null || label === null) {
      this.noticeSignal.set(`The sync check cannot start now: ${blockedWords(blocked)}`);
      return;
    }
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
    const previousOffsetMs = this.stored()?.offsetMs ?? null;
    const rect = this.camera.framing();
    this.context = {
      label,
      deviceLabel: this.camera.label(),
      frameSize: this.camera.frameSize(),
      framing: rect,
      app: APP_BUILD,
      userAgent: this.globals.navigator?.userAgent ?? null,
    };
    this.waitingSignal.set(false);
    this.resultSignal.set(null);
    this.visibleSignal.set(true);
    this.runSignal.set(
      new SyncRun({
        watch: (region, onSample, onError, onMeter) =>
          this.recording.watchMotion(region, onSample, onError, onMeter),
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
            this.finish(label, previousOffsetMs, outcome, run);
          }
        },
      }),
    );
  }

  /** "Start anyway": the check starts although the framing rectangle is wide. */
  startAnyway(): void {
    this.start({ anyway: true });
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
      downloadJson(this.globals, this.document, syncReportFileName(report.createdMs), report);
    } catch (error: unknown) {
      this.noticeSignal.set(`The check's data could not be saved: ${errorMessage(error)}`);
    }
  }

  /** Keeps a check's lag in the session, says how it went, and writes its line to the console. */
  private finish(
    label: string,
    previousOffsetMs: number | null,
    outcome: SyncOutcome,
    run: SyncRun,
  ): void {
    let saved = false;
    if (outcome.ok) {
      saved = this.session.putCameraClock(label, {
        offsetMs: outcome.offsetMs,
        rttMs: 0,
        driftPpm: 0,
        clapperboardResidualMs: outcome.clapperboardResidualMs,
        clapperboardSamples: outcome.clapperboardSamples,
        samples: outcome.samples,
      });
    }
    this.resultSignal.set({ label, outcome, previousOffsetMs, saved });
    const report = this.report(run);
    if (report !== null) {
      console.info(syncSummaryLine(report));
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
    case 'not-recording':
    case null:
      return 'the camera is not recording (it records while a session is under way).';
  }
}
