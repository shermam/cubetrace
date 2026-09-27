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
  AttemptMachine,
  CubeClockFit,
  createSession,
  formatMove,
  generateScramble,
  isSolved,
  summarize,
  type AttemptEvents,
  type AttemptRecord,
  type AttemptState,
  type CameraInfo,
  type CubeInfo,
  type Facelets,
  type ScrambleProgress,
  type SessionRecord,
  type SessionStore,
  type VideoClip,
} from '@cubetrace/core';
import type { CubeEvent, CubeMoveEvent } from '@cubetrace/gan';
import type { StorageProblem } from '@cubetrace/storage';
import { Subject, type Observable } from 'rxjs';

import { APP_BUILD } from '../../environments/version';
import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { StorageService } from '../device/storage-service';
import { WakeLockService } from '../device/wake-lock-service';
import { SettingsService, hostPlatform } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { PICKUP_THRESHOLD_DEG, rotationDeg, type Quaternion } from './pickup';
import { SESSION_STORAGE } from './session-storage';
import { sessionMean } from './session-stats';
import { timerDisplay } from './timer-display';
import { NO_UNDO, nextUndoGuide, type UndoGuide } from './undo-guide';

/** The `localStorage` key of the current session's id: a reload resumes that session. */
export const CURRENT_SESSION_KEY = 'cubetrace.currentSession';

/**
 * How long an attempt waits, after a cube connects, for the cube to say what it is (its `hardware`
 * event, which session.json records and which tells a different cube from the session's). A GAN
 * cube answers within a second; after this the attempt begins anyway, in the current session, or
 * in a new one that records {@link UNKNOWN_CUBE}.
 */
export const HARDWARE_WAIT_MS = 3000;

/** The cube of a session created before the cube said what it is. */
export const UNKNOWN_CUBE: CubeInfo = {
  model: 'Unknown cube',
  hardware: '',
  firmware: '',
  gyro: false,
};

/** Makes the scrambles: @cubetrace/core's `generateScramble`; the unit tests give fixed ones. */
export type ScrambleSource = () => Promise<string>;

export const SCRAMBLE_SOURCE = new InjectionToken<ScrambleSource>('SCRAMBLE_SOURCE', {
  providedIn: 'root',
  factory: () => generateScramble,
});

/** The current attempt as the timer page shows it: a snapshot of its machine. */
export interface AttemptView {
  /** Its 1-based position in the session. */
  readonly index: number;
  readonly scramble: string;
  readonly state: AttemptState;
  readonly progress: ScrambleProgress;
  readonly events: AttemptEvents;
  /** While scrambling off the scramble's path: the moves that bring the cube back. */
  readonly undo: UndoGuide;
}

/**
 * Where the timer is, for the page's status line: `loading` (reading the stored session),
 * `no-cube`, `connecting`, `solve-first` (a cube is connected but not solved), `scramble-wait`
 * (making a scramble), `cube-info` (waiting for the cube to say what it is, which a new session
 * records), `next` (an attempt ended; auto-advance is off, so the next one waits for Next),
 * the attempt's own `scrambling`, `armed` and `solving`, and `paused` (an attempt is under way
 * and the cube is gone).
 */
export type TimerPhase =
  | 'loading'
  | 'no-cube'
  | 'connecting'
  | 'solve-first'
  | 'scramble-wait'
  | 'cube-info'
  | 'next'
  | 'scrambling'
  | 'armed'
  | 'solving'
  | 'paused';

/** A stored session, for the Sessions page. */
export interface SessionListItem {
  readonly session: SessionRecord;
  readonly attempts: number;
  /** As the solve list writes the mean: a time, `DNF` or `–`. */
  readonly mean: string;
  /** The clips of its attempts (their `video` entries), and their MP4s' bytes (T2.4). */
  readonly clips: number;
  readonly clipBytes: number;
  /** The session the timer is recording. */
  readonly current: boolean;
  /** Its `attempt.json` files that could not be read, left out of `attempts` and `mean`. */
  readonly unreadable: readonly StorageProblem[];
}

/** The stored sessions, for the Sessions page. */
export interface SessionList {
  /** The readable sessions, newest first. */
  readonly sessions: readonly SessionListItem[];
  /** The sessions whose `session.json` could not be read, which can only be deleted. */
  readonly unreadable: readonly StorageProblem[];
}

/**
 * An attempt, as the recording (T2.4) names it: its session, its index, and when its scramble was
 * shown (`events.scrambleShown`), which tells it from an attempt begun again with the same index
 * (after "Mark as solved", or when "Delete last" freed the index).
 */
export interface AttemptRef {
  readonly session: string;
  readonly index: number;
  readonly scrambleShown: number;
}

/**
 * What happens to an attempt, for the recording (T2.4), which saves a clip of its scramble and one
 * of its solve: `armed`, its scramble is done (the time of its first move, or of the scramble's
 * end when no move was seen, and of the scramble's end); `ended`, its record is saved (solved or a
 * DNF: `endMs` is `solveEnd`, or the time of the DNF); `dropped`, it went without a record (a
 * skip, "Mark as solved", a new connection of the demo cube, a new session, its session deleted),
 * with the clips kept for it (`attachClip`), whose files are now nobody's.
 */
export type AttemptMilestone =
  | {
      readonly type: 'armed';
      readonly attempt: AttemptRef;
      readonly scrambleStart: number;
      readonly scrambleDone: number;
    }
  | {
      readonly type: 'ended';
      readonly attempt: AttemptRef;
      readonly record: AttemptRecord;
      readonly endMs: number;
    }
  | {
      readonly type: 'dropped';
      readonly attempt: AttemptRef;
      readonly clips: readonly VideoClip[];
    };

/** What `attachClip` did with a clip: kept for a record to come, saved in one, or nothing. */
export type ClipAttachment = 'kept' | 'saved' | 'gone';

/** An attempt under way or just ended, with what its machine does not expose. */
interface Current {
  readonly machine: AttemptMachine;
  readonly session: string;
  readonly index: number;
  readonly scramble: string;
  /** Clips saved while it was under way, for its record (T2.4). */
  clips: VideoClip[];
}

/** `clips` with `clip`, which replaces the clip of the same camera and segment. */
function withClip(clips: readonly VideoClip[], clip: VideoClip): VideoClip[] {
  const at = clips.findIndex((c) => c.camera === clip.camera && c.segment === clip.segment);
  return at < 0 ? [...clips, clip] : clips.map((c, k) => (k === at ? clip : c));
}

/** Whether `record` is the attempt `ref` names. */
function isAttempt(record: AttemptRecord, ref: AttemptRef): boolean {
  return (
    record.session === ref.session &&
    record.index === ref.index &&
    record.events.scrambleShown === ref.scrambleShown
  );
}

/** `notes` with one more line. */
function withNote(notes: string, line: string): string {
  return notes === '' ? line : `${notes}\n${line}`;
}

/** The states of an attempt under way: not over yet. */
type ActiveState = Extract<AttemptState, 'scrambling' | 'armed' | 'solving'>;

function isActive(state: AttemptState): state is ActiveState {
  return state === 'scrambling' || state === 'armed' || state === 'solving';
}

/** The attempt `current` as the recording names it. */
function refOf(current: Current): AttemptRef {
  return {
    session: current.session,
    index: current.index,
    scrambleShown: current.machine.events.scrambleShown,
  };
}

function sameCube(cube: CubeInfo, hardware: CubeInfo): boolean {
  return (
    cube.model === hardware.model &&
    cube.hardware === hardware.hardware &&
    cube.firmware === hardware.firmware &&
    cube.gyro === hardware.gyro
  );
}

/**
 * The timer's state (docs/PLAN.md, T1.6b): the current session and its attempts, the attempt under
 * way as an `AttemptMachine` fed by `CubeService.events$`, and the session store. Every state
 * transition comes from @cubetrace/core; this service decides when attempts begin and end, keeps
 * the records, and exposes signals for the pages.
 *
 * - An attempt begins when a cube is connected, no attempt is under way, and the cube is solved
 *   (the machine starts from a solved cube; otherwise the page says "Solve the cube first"). Its
 *   scramble is the one on screen: the demo solve's when the demo cube has just connected, else
 *   one generated in advance. Its index follows the last saved attempt's.
 * - Moves go to the machine, whose record keeps the cube clock fit of the attempt's own moves, and
 *   to the session's coarse clock fit, which starts over with every connection (the cube's clock
 *   restarts at 0). A `facelets` report that differs from the machine's state is adopted
 *   (`resync`), so the attempt follows the cube; its record then says `replayOk: false` if moves
 *   of the solve went unseen. The gyroscope marks the pickup: the first reading after the attempt
 *   is armed is the reference, and a rotation of more than 15° from it is the pickup.
 * - When an attempt ends (solved or DNF) its record is saved with the session's summary and
 *   clock fit; with auto-advance the next attempt begins at once with a scramble generated
 *   during the solve. A disconnection pauses the running time and leaves the attempt as it is;
 *   when the cube connects again it continues, after a resync if the cube moved meanwhile. A new
 *   connection of the demo cube replays its solve from the start, so it drops an attempt under
 *   way and begins one with the demo's scramble.
 * - "Mark as solved" (a `facelets` event flagged `reset`, T1.14) drops the attempt under way
 *   (scrambling, armed or solving) without a record and begins it again from the solved state,
 *   with the same scramble and number; an attempt that has ended is untouched. A reset never
 *   produces a record: the solved state it brings is not the end of a solve.
 * - A session is created with its first attempt (or by New session while a cube is connected),
 *   and a new one when a different cube connects (the first attempt of a connection waits for the
 *   cube to say what it is, up to {@link HARDWARE_WAIT_MS}); its id is kept in `localStorage`, so a
 *   reload resumes it. The screen is kept on while a cube is connected and a session is open, and
 *   persistent storage is asked for once, with the first session created.
 * - For the recording (T2.4, `RecordingService`): `milestones$` says when an attempt's scramble is
 *   done, when it ended and when it went without a record; `attachClip` adds a clip to the
 *   attempt's record (saved again, nothing else changed), `putCamera` the camera to the session's
 *   `cameras`, and `addNote` a line to its `notes`.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly cube = inject(CubeService);
  private readonly settings = inject(SettingsService);
  private readonly storage = inject(StorageService);
  private readonly wakeLock = inject(WakeLockService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly sessionStorage = inject(SESSION_STORAGE);
  private readonly store = this.sessionStorage.store;
  private readonly makeScramble = inject(SCRAMBLE_SOURCE);

  private readonly readySignal = signal(false);
  private readonly sessionSignal = signal<SessionRecord | null>(null);
  private readonly attemptsSignal = signal<readonly AttemptRecord[]>([]);
  private readonly attemptSignal = signal<AttemptView | null>(null);
  /** A scramble made in advance, for the next attempt. */
  private readonly reserveSignal = signal<string | null>(null);
  /** A given scramble that the next attempt takes before the reserve: the demo's, or a restart's. */
  private readonly queuedSignal = signal<string | null>(null);
  private readonly lastResultSignal = signal<AttemptRecord | null>(null);
  /** The next attempt begins as soon as it can; false after an attempt when auto-advance is off. */
  private readonly awaitingSignal = signal(true);
  /** The host time of the latest animation frame, while the timer runs. */
  private readonly frameSignal = signal(0);
  private readonly pausedAtSignal = signal<number | null>(null);
  private readonly pendingWritesSignal = signal(0);
  private readonly saveErrorSignal = signal<string | null>(null);
  private readonly scrambleErrorSignal = signal<string | null>(null);
  private readonly noticeSignal = signal<string | null>(null);

  /** `opfs`: sessions are kept in the browser; `memory`: they last until the page closes. */
  readonly storageKind = this.sessionStorage.kind;
  /** The stored session (if any) has been read: attempts can begin. */
  readonly ready = this.readySignal.asReadonly();
  /** The session being recorded; null until the first attempt of a new one. */
  readonly session = this.sessionSignal.asReadonly();
  /** The session's saved attempts, by index. */
  readonly attempts = this.attemptsSignal.asReadonly();
  /** The attempt under way, or the one that just ended; null when there is none. */
  readonly attempt = this.attemptSignal.asReadonly();
  /** The last attempt that ended while the page was open: the timer shows its time. */
  readonly lastResult = this.lastResultSignal.asReadonly();
  /** Why the last save failed; null while saving works. */
  readonly saveError = this.saveErrorSignal.asReadonly();
  /** Why no scramble could be made; null otherwise. */
  readonly scrambleError = this.scrambleErrorSignal.asReadonly();
  /** Something the timer page should say once, such as a session that could not be resumed. */
  readonly notice = this.noticeSignal.asReadonly();
  /** Records are being written to the store. */
  readonly saving = computed(() => this.pendingWritesSignal() > 0);

  /** The index of the attempt under way, or of the next one. */
  readonly index = computed(() => {
    const view = this.attemptSignal();
    return view !== null && isActive(view.state)
      ? view.index
      : (this.attemptsSignal().at(-1)?.index ?? 0) + 1;
  });

  /**
   * The scramble on screen: the attempt's while one is under way, else the one the next attempt
   * will take (null while it is being made).
   */
  readonly scramble = computed(() => {
    const view = this.attemptSignal();
    return view !== null && isActive(view.state)
      ? view.scramble
      : (this.queuedSignal() ?? this.reserveSignal());
  });

  /** See {@link TimerPhase}. */
  readonly phase = computed<TimerPhase>(() => {
    if (!this.readySignal()) {
      return 'loading';
    }
    const view = this.attemptSignal();
    const status = this.cube.status();
    if (view !== null && isActive(view.state)) {
      return status === 'connected' ? view.state : 'paused';
    }
    if (status !== 'connected') {
      return status === 'connecting' ? 'connecting' : 'no-cube';
    }
    if (!this.awaitingSignal()) {
      return 'next';
    }
    if (!this.cube.solved()) {
      return 'solve-first';
    }
    return this.queuedSignal() === null && this.reserveSignal() === null
      ? 'scramble-wait'
      : 'cube-info';
  });

  /** What the big timer shows (see `timerDisplay`). */
  readonly display = computed(() =>
    timerDisplay({
      attempt: this.attemptSignal(),
      lastResult: this.lastResultSignal(),
      nowMs: this.frameSignal(),
      pausedAtMs: this.pausedAtSignal(),
      inspection: this.settings.inspection(),
    }),
  );

  /** A DNF can be marked: an attempt is under way and has begun (a fresh scramble cannot be DNF). */
  readonly canDnf = computed(() => {
    const view = this.attemptSignal();
    return (
      view !== null &&
      isActive(view.state) &&
      (view.state !== 'scrambling' || view.events.scrambleStart !== null)
    );
  });
  /** Skip (or Next): not once the scramble is done and the solve is about to start or running. */
  readonly canSkip = computed(() => this.ready() && !this.solveStarted());
  /** Delete last and New session: when the session has attempts, and not during a solve. */
  readonly canDeleteLast = computed(
    () => this.ready() && this.attemptsSignal().length > 0 && !this.solveStarted(),
  );
  readonly canNewSession = this.canDeleteLast;

  private current: Current | null = null;
  /** The sessions deleted while the page is open: their attempts are gone. */
  private readonly deletedSessions = new Set<string>();
  private readonly milestones = new Subject<AttemptMilestone>();
  /** See {@link AttemptMilestone}; emitted as they happen, in the cube event's own turn. */
  readonly milestones$: Observable<AttemptMilestone> = this.milestones.asObservable();
  private clockFit = new CubeClockFit();
  private undoGuide: UndoGuide = NO_UNDO;
  /** The cube's latest orientation, and the one the pickup is measured from. */
  private lastGyro: Quaternion | null = null;
  private pickupFrom: Quaternion | null = null;
  /** Between a connection's first event and its `disconnected`. */
  private connectionOpen = false;
  /** Set when the connection's cube has not said what it is within {@link HARDWARE_WAIT_MS}. */
  private hardwareWaitOver = false;
  private hardwareTimer: ReturnType<typeof setTimeout> | undefined;
  private generating = false;
  private restoring: Promise<void> | null = null;
  /** The end of the last write queued; never rejects. */
  private writes: Promise<void> = Promise.resolve();
  private persistAsked = false;
  /** This service asked for the wake lock (the Settings switch may hold it too). */
  private wakeLockHeld = false;
  private frameHandle: number | null = null;

  constructor() {
    const subscription = this.cube.events$.subscribe((event) => {
      this.onCubeEvent(event);
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      this.stopTicker();
      clearTimeout(this.hardwareTimer);
    });
    effect(() => {
      const active = this.cube.status() === 'connected' && this.sessionSignal() !== null;
      untracked(() => {
        this.holdWakeLock(active);
      });
    });
    void this.whenReady();
  }

  /** Resolves once the stored session, if any, has been read (it starts on creation). */
  whenReady(): Promise<void> {
    this.restoring ??= this.restore();
    return this.restoring;
  }

  /** Resolves when every record queued so far has been written (or has failed to be). */
  whenSaved(): Promise<void> {
    return this.writes;
  }

  /** Makes the next scramble in advance, so that the page shows one before a cube connects. */
  prepare(): void {
    this.fillReserve();
    this.ensureAttempt();
  }

  /** The Skip button and `N`: Next after an attempt that ended without auto-advance, else Skip. */
  advance(): void {
    if (this.phase() === 'next') {
      this.next();
    } else {
      this.skip();
    }
  }

  /**
   * A new scramble instead of the one on screen: the attempt, if it has not started its solve, is
   * dropped (nothing is recorded) and a new one begins with another scramble, at once when the
   * cube is solved.
   */
  skip(): void {
    if (!this.canSkip()) {
      return;
    }
    const current = this.current;
    if (current !== null && isActive(current.machine.state)) {
      this.dropCurrent();
    } else if (this.queuedSignal() !== null) {
      this.queuedSignal.set(null);
    } else {
      this.reserveSignal.set(null);
    }
    this.awaitingSignal.set(true);
    this.refresh();
    this.fillReserve();
    this.ensureAttempt();
  }

  /** After an attempt that ended without auto-advance: begins the next one. */
  next(): void {
    if (!this.ready() || this.awaitingSignal()) {
      return;
    }
    this.current = null;
    this.awaitingSignal.set(true);
    this.refresh();
    this.fillReserve();
    this.ensureAttempt();
  }

  /**
   * Ends the attempt under way as a DNF, once it has begun (see {@link canDnf}); its record is
   * saved, and the next attempt begins when the cube is solved again.
   */
  dnf(): void {
    const current = this.activeCurrent();
    if (current === null || !this.canDnf()) {
      return;
    }
    const before = current.machine.state;
    current.machine.markDnf(this.now());
    this.afterChange(current, before);
  }

  /**
   * Removes the session's last saved attempt, from the store too. Its number is free again: an
   * attempt that has not started its solve takes it (it begins again, with the same scramble, when
   * the cube is solved), and so does the next attempt otherwise. Not during a solve.
   */
  deleteLast(): void {
    const session = this.sessionSignal();
    const attempts = this.attemptsSignal();
    const last = attempts.at(-1);
    if (!this.canDeleteLast() || session === null || last === undefined) {
      return;
    }
    const remaining = attempts.slice(0, -1);
    const saved: SessionRecord = { ...session, summary: summarize(session, remaining) };
    this.attemptsSignal.set(remaining);
    this.sessionSignal.set(saved);
    if (this.lastResultSignal()?.index === last.index) {
      this.lastResultSignal.set(null);
    }
    const current = this.current;
    if (current?.machine.state === 'scrambling') {
      this.queuedSignal.set(current.scramble);
      this.dropCurrent();
      this.awaitingSignal.set(true);
    } else if (current?.index === last.index) {
      this.current = null;
    }
    this.refresh();
    void this.save(async (store) => {
      await store.deleteAttempt(session.id, last.index);
      await store.saveSession(saved);
    });
    this.ensureAttempt();
  }

  /**
   * Closes the current session: the next attempt goes to a new one, created now if a cube is
   * connected. An attempt that has not started its solve begins again in the new session, with
   * its scramble. Not during a solve, and not while the session has no attempt.
   */
  newSession(): void {
    if (!this.canNewSession()) {
      return;
    }
    const current = this.current;
    if (current?.machine.state === 'scrambling') {
      this.queuedSignal.set(current.scramble);
    }
    this.dropCurrent();
    this.forgetSession();
    const hardware = this.cube.hardware();
    if (this.cube.status() === 'connected' && hardware !== null) {
      this.startSession(hardware);
    }
    this.awaitingSignal.set(true);
    this.refresh();
    this.ensureAttempt();
  }

  /**
   * The stored sessions, newest first, with their attempt counts and means, and the files that the
   * store could not read: a session whose `session.json` is unreadable is listed apart, and an
   * unreadable `attempt.json` is left out of its session's count and mean.
   */
  async listSessions(): Promise<SessionList> {
    await this.whenReady();
    await this.whenSaved();
    const sessions = await this.store.listSessions();
    const attempts = await Promise.all(sessions.map((s) => this.store.loadAttempts(s.id)));
    const problems = (await this.store.listProblems?.()) ?? [];
    const currentId = this.sessionSignal()?.id;
    return {
      sessions: sessions.map((session, k) => {
        const clips = attempts[k].flatMap((attempt) => attempt.video);
        return {
          session,
          attempts: attempts[k].length,
          mean: sessionMean(attempts[k]),
          clips: clips.length,
          clipBytes: clips.reduce((sum, clip) => sum + clip.bytes, 0),
          current: session.id === currentId,
          unreadable: problems.filter((p) => p.kind === 'attempt' && p.sessionId === session.id),
        };
      }),
      unreadable: problems.filter((p) => p.kind === 'session'),
    };
  }

  /** A session with its attempts, as one export file holds them, once pending writes are done. */
  async exportSession(id: string): Promise<{ session: SessionRecord; attempts: AttemptRecord[] }> {
    await this.whenSaved();
    return this.store.exportSession(id);
  }

  /**
   * Deletes a stored session with its attempts. If it is the current one, the timer forgets it
   * (an attempt under way is dropped) and the next attempt starts a new session.
   */
  async deleteSession(id: string): Promise<void> {
    this.deletedSessions.add(id);
    if (this.sessionSignal()?.id === id) {
      const current = this.current;
      if (current !== null && isActive(current.machine.state)) {
        this.queuedSignal.set(current.scramble);
      }
      this.dropCurrent();
      this.forgetSession();
      this.awaitingSignal.set(true);
      this.refresh();
    }
    await this.save((store) => store.deleteSession(id));
  }

  /**
   * Adds `clip` to the attempt `ref` (T2.4), replacing a clip of the same camera and segment: while
   * the attempt is under way it is kept for its record (`kept`); once it has ended, its record is
   * saved again with the clip in `video` and nothing else changed (`saved`), also when the session
   * is no longer the current one. Resolves to `gone`, changing nothing, when the attempt went
   * without a record or was deleted. Rejects when the record could not be saved (the timer says so
   * too, as for any save).
   */
  async attachClip(ref: AttemptRef, clip: VideoClip): Promise<ClipAttachment> {
    const current = this.current;
    if (
      current !== null &&
      isActive(current.machine.state) &&
      current.session === ref.session &&
      current.index === ref.index &&
      current.machine.events.scrambleShown === ref.scrambleShown
    ) {
      current.clips = withClip(current.clips, clip);
      return 'kept';
    }
    if (this.sessionSignal()?.id === ref.session) {
      const record = this.attemptsSignal().find((attempt) => isAttempt(attempt, ref));
      if (record === undefined) {
        return 'gone';
      }
      const updated: AttemptRecord = { ...record, video: withClip(record.video, clip) };
      this.attemptsSignal.update((attempts) => attempts.map((a) => (a === record ? updated : a)));
      if (this.lastResultSignal() === record) {
        this.lastResultSignal.set(updated);
      }
      await this.save((store) => store.saveAttempt(updated));
      return 'saved';
    }
    // The session changed since (New session right after the solve): its record in the store.
    let outcome: ClipAttachment = 'gone';
    await this.save(async (store) => {
      const record = (await store.loadAttempts(ref.session)).find((a) => isAttempt(a, ref));
      if (record !== undefined) {
        await store.saveAttempt({ ...record, video: withClip(record.video, clip) });
        outcome = 'saved';
      }
    });
    return outcome;
  }

  /**
   * Whether the attempt `ref` is still there: under way, or saved in the current session. An
   * attempt of another session counts as there (its record is in the store) unless that session was
   * deleted.
   */
  hasAttempt(ref: AttemptRef): boolean {
    if (this.deletedSessions.has(ref.session)) {
      return false;
    }
    const current = this.current;
    if (
      current !== null &&
      isActive(current.machine.state) &&
      current.session === ref.session &&
      current.index === ref.index &&
      current.machine.events.scrambleShown === ref.scrambleShown
    ) {
      return true;
    }
    if (this.sessionSignal()?.id !== ref.session) {
      return true;
    }
    return this.attemptsSignal().some((attempt) => isAttempt(attempt, ref));
  }

  /**
   * Puts `camera` in the current session's `cameras` (T2.4), replacing the entry with its label, and
   * `audio` in its `audio`, and saves session.json; nothing without a session, or when both are
   * already so.
   */
  putCamera(camera: CameraInfo, audio: boolean): void {
    const session = this.sessionSignal();
    if (session === null) {
      return;
    }
    const at = session.cameras.findIndex((entry) => entry.label === camera.label);
    if (
      at >= 0 &&
      session.audio === audio &&
      JSON.stringify(session.cameras[at]) === JSON.stringify(camera)
    ) {
      return;
    }
    const cameras =
      at < 0
        ? [...session.cameras, camera]
        : session.cameras.map((entry, k) => (k === at ? camera : entry));
    const saved: SessionRecord = { ...session, cameras, audio };
    this.sessionSignal.set(saved);
    void this.save((store) => store.saveSession(saved));
  }

  /**
   * Adds `line` to the `notes` of session `sessionId` and saves its session.json (T2.4: a clip that
   * could not be saved), also when it is no longer the current session. Rejects when it could not be
   * saved.
   */
  async addNote(sessionId: string, line: string): Promise<void> {
    const session = this.sessionSignal();
    if (session?.id === sessionId) {
      const saved: SessionRecord = { ...session, notes: withNote(session.notes, line) };
      this.sessionSignal.set(saved);
      await this.save((store) => store.saveSession(saved));
      return;
    }
    await this.save(async (store) => {
      const stored = (await store.exportSession(sessionId)).session;
      await store.saveSession({ ...stored, notes: withNote(stored.notes, line) });
    });
  }

  /**
   * Resumes the session of the current id, if any, with its readable attempts. A session whose
   * `session.json` is gone or unreadable is not resumed: its id is forgotten, the notice says why
   * (the store's error names the file), and the next attempt starts a new session.
   */
  private async restore(): Promise<void> {
    const id = this.readCurrentId();
    if (id !== null) {
      try {
        const { session, attempts } = await this.store.exportSession(id);
        this.sessionSignal.set(session);
        this.attemptsSignal.set(attempts);
      } catch (error: unknown) {
        this.writeCurrentId(null);
        this.noticeSignal.set(
          `The last session could not be resumed (${errorMessage(error)}); the next attempt starts a new one.`,
        );
      }
    }
    this.readySignal.set(true);
    this.ensureAttempt();
  }

  private onCubeEvent(event: CubeEvent): void {
    if (event.type === 'disconnected') {
      this.connectionOpen = false;
      this.onDisconnected();
      return;
    }
    if (!this.connectionOpen) {
      this.connectionOpen = true;
      this.onConnected();
    }
    switch (event.type) {
      case 'move':
        this.onMove(event);
        break;
      case 'facelets':
        if (event.reset === true) {
          this.onReset();
        } else {
          this.onFacelets(event.facelets, event.hostMs);
        }
        break;
      case 'gyro':
        this.onGyro(event.q, event.hostMs);
        break;
      case 'hardware':
        // A new session records the cube: an attempt may have been waiting for it.
        this.ensureAttempt();
        break;
      case 'battery':
        break;
    }
  }

  /** The first event of a connection (CubeService's state already describes it). */
  private onConnected(): void {
    this.clockFit = new CubeClockFit();
    this.lastGyro = null;
    this.pickupFrom = null;
    this.pausedAtSignal.set(null);
    this.hardwareWaitOver = false;
    clearTimeout(this.hardwareTimer);
    this.hardwareTimer = setTimeout(() => {
      this.hardwareWaitOver = true;
      this.ensureAttempt();
    }, HARDWARE_WAIT_MS);
    const demo = this.cube.demo();
    const current = this.activeCurrent();
    if (demo !== null) {
      // The demo cube starts solved and replays its solve from the start.
      this.dropCurrent();
      this.queuedSignal.set(demo.scramble);
      this.awaitingSignal.set(true);
      this.refresh();
    } else if (current !== null) {
      const facelets = this.cube.facelets();
      if (facelets !== null) {
        this.adopt(current, facelets, this.now());
      }
    }
    this.ensureAttempt();
    this.updateTicker();
  }

  private onDisconnected(): void {
    clearTimeout(this.hardwareTimer);
    if (this.current?.machine.state === 'solving') {
      this.pausedAtSignal.set(this.now());
    }
    this.updateTicker();
  }

  private onMove(event: CubeMoveEvent): void {
    this.clockFit.addSample(event.cubeMs, event.hostMs, event.packetLast);
    const current = this.activeCurrent();
    if (current === null) {
      // The cube may have become solved: the next attempt can begin.
      this.ensureAttempt();
      return;
    }
    const before = current.machine.state;
    current.machine.onMove({
      m: event.m,
      cubeMs: event.cubeMs,
      hostMs: event.hostMs,
      packetLast: event.packetLast,
    });
    this.afterChange(current, before);
  }

  private onFacelets(facelets: Facelets, hostMs: number): void {
    const current = this.activeCurrent();
    if (current === null) {
      this.ensureAttempt();
    } else {
      this.adopt(current, facelets, hostMs);
    }
  }

  /**
   * The cube was told it is solved ("Mark as solved"): an attempt under way is dropped, without a
   * record, and begins again with its scramble from the solved state (CubeService, whose handler
   * runs first, already holds it). The scramble on screen and the attempt's number stay.
   */
  private onReset(): void {
    const current = this.activeCurrent();
    if (current !== null) {
      this.queuedSignal.set(current.scramble);
      this.dropCurrent();
      this.awaitingSignal.set(true);
      this.pausedAtSignal.set(null);
      this.refresh();
    }
    this.ensureAttempt();
  }

  /** Resyncs the attempt to the state the cube reports, if it differs from the machine's. */
  private adopt(current: Current, facelets: Facelets, hostMs: number): void {
    if (current.machine.onFacelets(facelets).consistent) {
      return;
    }
    const before = current.machine.state;
    current.machine.resync(facelets, hostMs);
    this.afterChange(current, before);
  }

  private onGyro(q: Quaternion, hostMs: number): void {
    this.lastGyro = q;
    const current = this.activeCurrent();
    if (current?.machine.state !== 'armed' || current.machine.events.pickup !== null) {
      return;
    }
    if (this.pickupFrom === null) {
      this.pickupFrom = q;
    } else if (rotationDeg(this.pickupFrom, q) > PICKUP_THRESHOLD_DEG) {
      current.machine.onPickup(hostMs);
      this.refresh();
    }
  }

  /** After the machine took an input: the pickup reference, the next scramble, the end. */
  private afterChange(current: Current, before: AttemptState): void {
    const state = current.machine.state;
    if (state === 'armed' && before !== 'armed') {
      this.pickupFrom = this.lastGyro;
    }
    const { scrambleStart, scrambleDone } = current.machine.events;
    if (before === 'scrambling' && scrambleDone !== null) {
      // A resync may have gone past armed at once: the scramble is done all the same.
      this.milestones.next({
        type: 'armed',
        attempt: refOf(current),
        scrambleStart: scrambleStart ?? scrambleDone,
        scrambleDone,
      });
    }
    if (state === 'solving' && before !== 'solving') {
      // Ready by the end of the solve, so that auto-advance shows it at once.
      this.fillReserve();
    }
    if (state === 'solved' || state === 'dnf') {
      this.finish(current);
    } else {
      this.refresh();
    }
  }

  /**
   * Saves the record of an attempt that ended, with the session's summary and clock fit, and the
   * clips saved while it was under way.
   */
  private finish(current: Current): void {
    const session = this.sessionSignal();
    if (session === null) {
      return;
    }
    const record: AttemptRecord = { ...current.machine.toRecord(), video: current.clips };
    const attempts = [
      ...this.attemptsSignal().filter((a) => a.index !== record.index),
      record,
    ].sort((p, q) => p.index - q.index);
    const saved: SessionRecord = {
      ...session,
      summary: summarize(session, attempts),
      clock: { ...session.clock, cube: this.clockFit.params },
    };
    this.attemptsSignal.set(attempts);
    this.sessionSignal.set(saved);
    this.lastResultSignal.set(record);
    this.pausedAtSignal.set(null);
    this.awaitingSignal.set(this.settings.autoAdvance());
    this.refresh();
    void this.save(async (store) => {
      await store.saveAttempt(record);
      await store.saveSession(saved);
    });
    this.milestones.next({
      type: 'ended',
      attempt: refOf(current),
      record,
      endMs: record.events.solveEnd ?? current.machine.dnfMs ?? this.now(),
    });
    this.ensureAttempt();
  }

  /** Begins the next attempt if one is due and everything it needs is there. */
  private ensureAttempt(): void {
    if (!this.readySignal() || !this.awaitingSignal() || this.activeCurrent() !== null) {
      return;
    }
    const facelets = this.cube.facelets();
    if (this.cube.status() !== 'connected' || facelets === null || !isSolved(facelets)) {
      return;
    }
    const queued = this.queuedSignal();
    const scramble = queued ?? this.reserveSignal();
    if (scramble === null) {
      this.fillReserve();
      return;
    }
    // Which cube this is decides the session: wait for it to say (see HARDWARE_WAIT_MS).
    const hardware = this.cube.hardware();
    if (hardware === null && !this.hardwareWaitOver) {
      return;
    }
    let session = this.sessionSignal();
    if (session === null || (hardware !== null && !sameCube(session.cube, hardware))) {
      session = this.startSession(hardware ?? UNKNOWN_CUBE);
    }
    const index = (this.attemptsSignal().at(-1)?.index ?? 0) + 1;
    let machine: AttemptMachine;
    try {
      machine = new AttemptMachine({
        session: session.id,
        index,
        scramble,
        scrambleShownMs: this.now(),
      });
    } catch (error: unknown) {
      this.scrambleErrorSignal.set(
        `the scramble "${scramble}" cannot be used: ${errorMessage(error)}`,
      );
      this.dropScramble(queued !== null);
      this.fillReserve();
      return;
    }
    this.dropScramble(queued !== null);
    this.current = { machine, session: session.id, index, scramble, clips: [] };
    this.awaitingSignal.set(false);
    this.pickupFrom = null;
    this.undoGuide = NO_UNDO;
    this.refresh();
  }

  private dropScramble(queued: boolean): void {
    if (queued) {
      this.queuedSignal.set(null);
    } else {
      this.reserveSignal.set(null);
    }
  }

  private startSession(cube: CubeInfo): SessionRecord {
    const navigator = this.globals.navigator;
    const { platform, mobile } = hostPlatform(navigator);
    const session = createSession({
      host: {
        label: this.settings.hostLabel(),
        userAgent: typeof navigator?.userAgent === 'string' ? navigator.userAgent : '',
        platform,
        isPhone: mobile,
      },
      cube,
      settings: {
        inspection15s: this.settings.inspection(),
        autoAdvance: this.settings.autoAdvance(),
      },
      audio: this.settings.recordAudio(),
      appVersion: APP_BUILD.version,
      commit: APP_BUILD.commit,
      nowMs: this.now(),
    });
    this.sessionSignal.set(session);
    this.attemptsSignal.set([]);
    this.lastResultSignal.set(null);
    this.writeCurrentId(session.id);
    void this.save((store) => store.createSession(session));
    if (!this.persistAsked) {
      this.persistAsked = true;
      void this.storage.persist();
    }
    return session;
  }

  private forgetSession(): void {
    this.sessionSignal.set(null);
    this.attemptsSignal.set([]);
    this.lastResultSignal.set(null);
    this.writeCurrentId(null);
  }

  /** Makes a scramble for the next attempt, unless one is there or on its way. */
  private fillReserve(): void {
    if (this.reserveSignal() !== null || this.generating) {
      return;
    }
    this.generating = true;
    this.makeScramble().then(
      (scramble) => {
        this.generating = false;
        this.scrambleErrorSignal.set(null);
        this.reserveSignal.set(scramble);
        this.ensureAttempt();
      },
      (error: unknown) => {
        this.generating = false;
        this.scrambleErrorSignal.set(errorMessage(error));
      },
    );
  }

  /** Queues a write after the previous ones; a failure is shown, and the next writes still run. */
  private save(write: (store: SessionStore) => Promise<void>): Promise<void> {
    this.pendingWritesSignal.update((count) => count + 1);
    const run = this.writes.then(() => write(this.store));
    this.writes = run.then(
      () => {
        this.pendingWritesSignal.update((count) => count - 1);
        this.saveErrorSignal.set(null);
      },
      (error: unknown) => {
        this.pendingWritesSignal.update((count) => count - 1);
        this.saveErrorSignal.set(errorMessage(error));
      },
    );
    return run;
  }

  /** Publishes the current attempt's state, and runs or stops the timer's frames. */
  private refresh(): void {
    const current = this.current;
    if (current === null) {
      this.undoGuide = NO_UNDO;
      this.attemptSignal.set(null);
    } else {
      const { machine } = current;
      const progress = machine.scrambleProgress;
      const undo =
        machine.state === 'scrambling' && progress.diverged ? progress.undo.map(formatMove) : [];
      this.undoGuide = nextUndoGuide(this.undoGuide, undo);
      this.attemptSignal.set({
        index: current.index,
        scramble: current.scramble,
        state: machine.state,
        progress,
        events: machine.events,
        undo: this.undoGuide,
      });
    }
    this.updateTicker();
  }

  private activeCurrent(): Current | null {
    const current = this.current;
    return current !== null && isActive(current.machine.state) ? current : null;
  }

  /** Forgets the current attempt; one under way goes without a record (`dropped`). */
  private dropCurrent(): void {
    const current = this.current;
    this.current = null;
    if (current !== null && isActive(current.machine.state)) {
      this.milestones.next({ type: 'dropped', attempt: refOf(current), clips: current.clips });
    }
  }

  /** Armed or solving: the scramble is done and the solve is about to start, or running. */
  private solveStarted(): boolean {
    const state = this.attemptSignal()?.state;
    return state === 'armed' || state === 'solving';
  }

  /** The timer runs (one update per animation frame) while solving, and while inspecting. */
  private ticking(): boolean {
    const view = this.attemptSignal();
    return (
      view !== null &&
      this.cube.status() === 'connected' &&
      this.pausedAtSignal() === null &&
      (view.state === 'solving' || (view.state === 'armed' && this.settings.inspection()))
    );
  }

  private updateTicker(): void {
    if (!this.ticking()) {
      this.stopTicker();
      return;
    }
    this.frameSignal.set(this.now());
    if (this.frameHandle === null) {
      this.requestFrame();
    }
  }

  private requestFrame(): void {
    const handle = this.globals.requestAnimationFrame?.(() => {
      this.frameHandle = null;
      if (this.ticking()) {
        this.frameSignal.set(this.now());
        this.requestFrame();
      }
    });
    this.frameHandle = handle ?? null;
  }

  private stopTicker(): void {
    if (this.frameHandle !== null) {
      this.globals.cancelAnimationFrame?.(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private holdWakeLock(active: boolean): void {
    if (active && !this.wakeLockHeld && !this.wakeLock.wanted()) {
      this.wakeLockHeld = true;
      void this.wakeLock.request();
    } else if (!active && this.wakeLockHeld) {
      this.wakeLockHeld = false;
      void this.wakeLock.release();
    }
  }

  private now(): number {
    return hostNow(this.globals);
  }

  private readCurrentId(): string | null {
    try {
      return this.globals.localStorage?.getItem(CURRENT_SESSION_KEY) ?? null;
    } catch {
      return null; // Storage is blocked: the session is not resumed after a reload.
    }
  }

  private writeCurrentId(id: string | null): void {
    try {
      const storage = this.globals.localStorage;
      if (id === null) {
        storage?.removeItem(CURRENT_SESSION_KEY);
      } else {
        storage?.setItem(CURRENT_SESSION_KEY, id);
      }
    } catch {
      // Storage is blocked: the session is not resumed after a reload.
    }
  }
}
