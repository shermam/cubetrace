import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { cameraLabel } from '@cubetrace/capture';
import type { CameraClock } from '@cubetrace/core';

import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { SessionService, type TimerPhase } from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { CameraService } from './camera-service';
import { RecordingService } from './recording-service';
import { SyncRun, type SyncOutcome } from './sync-run';

/** The timer's phases in which no check starts: a solve is about to start, under way or paused. */
const SOLVING: ReadonlySet<TimerPhase> = new Set<TimerPhase>(['armed', 'solving', 'paused']);

/**
 * Why a check cannot start now: no recording to measure, no cube to turn, a solve about to start or
 * under way, or a check running.
 */
export type SyncBlock = 'not-recording' | 'no-cube' | 'solving' | 'running';

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
 * The sync check of the Timer page (docs/PLAN.md, T2.5): how far the camera's frames lag the cube.
 * When a session is under way with the camera recording, a cube connected and no check of this
 * camera in the session's `clock.cameras`, the check starts by itself, once per session and camera
 * (not while a solve is about to start, under way or paused), and the panel shows it; "Sync check"
 * starts one again whenever one could start by itself (`blocked` says why not), and "Later" hides
 * the panel, ending a check under way. A check (`SyncRun`) watches up to 20 s of the camera's
 * motion in the framing rectangle, measured by the capture worker, and the cube's moves, and the
 * clapperboard gives the lag. On success the lag goes into the session's
 * `clock.cameras[label]` (`rttMs` and `driftPpm` 0: the camera is this device's; the matched pairs
 * kept), replacing an earlier check's, and the camera's later clips carry it as their
 * `syncResidualMs` (`SessionService.attachClip`). A check ends as failed when the recording stops.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly camera = inject(CameraService);
  private readonly recording = inject(RecordingService);
  private readonly session = inject(SessionService);
  private readonly cube = inject(CubeService);
  private readonly settings = inject(SettingsService);
  private readonly globals = inject(BROWSER_GLOBALS);

  private readonly runSignal = signal<SyncRun | null>(null);
  private readonly resultSignal = signal<SyncCheckResult | null>(null);
  private readonly visibleSignal = signal(false);

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
  /** How the last check ended; null while one runs, and before the first. */
  readonly result = this.resultSignal.asReadonly();
  /** Whether the panel shows (a check under way or just ended). */
  readonly visible = this.visibleSignal.asReadonly();
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
    return SOLVING.has(this.session.phase()) ? 'solving' : null;
  });

  /** The session and camera labels the check started by itself for: once each. */
  private readonly prompted = new Set<string>();

  constructor() {
    // At the start of a session with the camera recording, and for a camera the session has no
    // check of, the check starts by itself.
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
    // A check ends when the recording stops (the camera off or switched, storage full).
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

  /** Starts a check and shows the panel, unless one cannot start now (`blocked`). */
  start(): void {
    const label = this.label();
    if (this.blocked() !== null || label === null) {
      return;
    }
    const previousOffsetMs = this.stored()?.offsetMs ?? null;
    const run = new SyncRun({
      watch: (rect, onSample, onError) => this.recording.watchMotion(rect, onSample, onError),
      rect: this.camera.framing(),
      events$: this.cube.events$,
      now: () => hostNow(this.globals),
      setTimeout: (callback, ms) => this.setTimer(callback, ms),
      clearTimeout: (handle) => {
        this.clearTimer(handle);
      },
    });
    this.runSignal.set(run);
    this.resultSignal.set(null);
    this.visibleSignal.set(true);
    void run.done.then((outcome) => {
      if (outcome !== null && this.runSignal() === run) {
        this.finish(label, previousOffsetMs, outcome);
      }
    });
  }

  /** "Later": hides the panel, and ends a check under way without a result. */
  later(): void {
    this.runSignal()?.cancel();
    this.visibleSignal.set(false);
  }

  /** Keeps a check's lag in the session, and says how it went. */
  private finish(label: string, previousOffsetMs: number | null, outcome: SyncOutcome): void {
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
