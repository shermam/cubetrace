import { DestroyRef, Injectable, inject } from '@angular/core';
import { clipFiles } from '@cubetrace/capture';
import {
  parseFrames,
  remoteFrames,
  type FramesJson,
  type RemoteClockFit,
  type RemoteClockRecord,
  type VideoClip,
  type VideoSegment,
} from '@cubetrace/core';
import {
  Crc32,
  FileReceiver,
  type CutClip,
  type CutDone,
  type CutFailed,
  type FileDescription,
  type IncomingFile,
  type MessageLink,
} from '@cubetrace/rtc';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { e2eRemote } from '../rtc/e2e-remote';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { ClipsInFlight } from '../session/clips-in-flight';
import {
  SessionService,
  type AttemptMilestone,
  type AttemptRef,
  type ClipAttachment,
} from '../session/session-service';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { clipWindow } from './clip-windows';
import { clockEstimate, type ClockEstimate } from './remote-estimate';

/** How long after an attempt's end the host waits for its remote clips (docs/PLAN.md T4.2). */
export const REMOTE_CLIP_WAIT_MS = 120_000;

/**
 * How long a cut or a frames file waits for the clock sync's first answer when the camera has none
 * yet (a phone paired again with a new code: its fit starts empty), in ms.
 */
export const SYNC_WAIT_MS = 10_000;

/** A remote camera as the cuts see it: RemoteCamerasService gives one per connection. */
export interface CutCamera {
  /** The camera's id in the Cameras list, kept across its reconnections. */
  readonly id: string;
  /** Its label in the session now; null before the phone has a camera. */
  label(): string | null;
  /** The phone's host label, for the events. */
  peer(): string;
  /** The fit of the phone's clock, kept across its reconnections. */
  readonly fit: RemoteClockFit;
  /** Calls `next` after each answer to a ping, until the returned function is called. */
  onSample(next: () => void): () => void;
  /**
   * Puts `record`, the estimate a first cut relied on, in the session's
   * `clock.cameras[label].remote` when there is none there yet (a later convergence overwrites it).
   */
  recordClock(record: RemoteClockRecord): void;
}

/**
 * Where a remote clip is: `asked` (its cut is sent, or waits for the camera's connection),
 * `coming` (the phone cut it and sends its files), `stored` (its files are in the attempt's folder
 * and the clip in the attempt's record), `missing` (given up: the wait is over, the phone could not
 * cut it, or it left; it is still taken if it comes), `refused` (the host does not take it: its
 * attempt is gone, or its frames file could not be read).
 */
export type RemoteClipState = 'asked' | 'coming' | 'stored' | 'missing' | 'refused';

/** A clip of an attempt from a remote camera, as the host follows it. */
interface RemoteClip {
  readonly ref: AttemptRef;
  readonly label: string;
  readonly segment: VideoSegment;
  /**
   * The window asked for, on the host clock, and the milestone that decided it; null for a clip the
   * phone offered without a cut of this page (one of an attempt from before the page was loaded
   * again).
   */
  readonly window: {
    readonly fromMs: number;
    readonly toMs: number;
    readonly reason: string;
  } | null;
  /** When it was asked for, host clock. */
  readonly askedMs: number;
  /**
   * The window as first sent in the phone's clock, widened by the estimate's margin on each side:
   * sent again as it was, so that it is one cut.
   */
  sent: {
    readonly fromRemoteMs: number;
    readonly toRemoteMs: number;
    readonly marginMs: number;
  } | null;
  state: RemoteClipState;
  /** It holds its attempt back from the upload queue (`ClipsInFlight`). */
  held: boolean;
  /** The phone answered its cut (`cut-done` or `cut-failed`). */
  answered: boolean;
  /** When its attempt ended, host clock; null before. */
  endMs: number | null;
  /** When it was given up, host clock: it comes late from then on. */
  missedMs: number | null;
  /** The phone's host label, for the events. */
  peer: string;
  /** What the phone's capture said of it (`cut-done`). */
  details: CutClip | null;
  /** When the phone last offered it (`cut-done`): its transfer's start. */
  offeredMs: number | null;
  /** Its frames file as the attempt's folder has it, with the times converted. */
  frames: FramesJson | null;
  framesBytes: number;
  /** The bytes the host held already when a file of it was begun again (a resumed transfer). */
  resumedBytes: number;
  /** Why the host does not take it (`refused`). */
  refusal: string | null;
}

/** A camera listed, and its connection while it has one. */
interface Present {
  readonly camera: CutCamera;
  link: MessageLink | null;
  offs: (() => void)[];
}

/**
 * The remote cameras' clips (docs/PLAN.md T4.2, docs/RTC.md §3 and §9): the host asks every phone
 * listed in the Cameras section for each attempt's clips as it asks its own camera
 * (`SessionService.milestones$`, `clipWindow`: the scramble's once it is done, the solve's once the
 * attempt ended), with the window in the phone's clock through the clock estimate (`clockEstimate`:
 * the fit's, converged or not, widened by its margin on each side) and the label the session
 * gives the phone's camera (`cut`), and holds the attempt back from the upload queue meanwhile
 * (`ClipsInFlight`, one entry per clip expected). Nothing waits for the fit to converge: on a busy
 * Wi-Fi it may never (the first real pairing); the records say what each cut and clip relied on. A phone that is reconnecting gets its cuts when it
 * is back. The phone cuts, stages and sends each clip: `cut-done` with what its capture said of it,
 * then its frames file and its MP4 (`FileReceiver`, into memory: a transfer cut in the middle goes on
 * from the bytes held over the next connection). The host writes the frames file into the attempt's
 * folder with its times on the host clock (`remoteFrames`: the phone's first frame time kept as
 * `t0RemoteMs`, the fit beside it), then the MP4, adds the clip to the attempt's record
 * (`SessionService.attachClip`) and says so (`clip-ack`), after which the phone deletes its copy. The
 * wait has a limit, {@link REMOTE_CLIP_WAIT_MS} after the attempt's end: then the attempt goes to the
 * upload queue without the clip, and the session's notes say which camera's clip is missing; a clip
 * that comes later is still attached, and uploaded as an addition. A clip the phone could not cut,
 * or of a phone that left, is given up at once. Settings' "Record remote cameras" off, nothing is
 * asked for. The events: `remote.cut`, `remote.clip`, `remote.clip.late`, `remote.clip.missing`
 * (docs/DIAGNOSTICS.md).
 */
@Injectable({ providedIn: 'root' })
export class RemoteCutsService {
  private readonly session = inject(SessionService);
  private readonly settings = inject(SettingsService);
  private readonly inFlight = inject(ClipsInFlight);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly files = inject(ATTEMPT_FILES);
  private readonly timers = inject(RTC_TIMERS);
  /** The wait after an attempt's end; shorter in the end-to-end suite (`E2eRemote.clipWaitMs`). */
  private readonly waitMs = e2eRemote(inject(BROWSER_GLOBALS)).clipWaitMs ?? REMOTE_CLIP_WAIT_MS;

  /** The cameras listed, by id. */
  private readonly present = new Map<string, Present>();
  /** The clips asked for or offered, by attempt, label and segment ({@link clipKey}). */
  private readonly clips = new Map<string, RemoteClip>();
  /** The clip each camera offered last for an attempt's segment, which its files belong to. */
  private readonly offers = new Map<string, RemoteClip>();
  /** The files of the clips as they come, by clip and kind: they outlive a connection. */
  private readonly partials = new Map<string, PartialFile>();
  /** The end of the wait of each attempt with clips to come, by {@link attemptKey}. */
  private readonly deadlines = new Map<string, unknown>();
  /** The operations under way, for the tests to wait on. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor() {
    const subscription = this.session.milestones$.subscribe((milestone) => {
      this.onMilestone(milestone);
    });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      for (const timer of this.deadlines.values()) {
        this.timers.clearTimeout(timer);
      }
      this.deadlines.clear();
    });
  }

  /**
   * A remote camera's connection is open, the hellos exchanged and its entry in the session: its
   * offers and files are taken from now on, and the cuts it has not answered go to it now (as they
   * were first sent: a phone takes a cut once). Returns what stops listening to this connection; the
   * camera stays listed until {@link gone}.
   */
  connected(camera: CutCamera, link: MessageLink): () => void {
    this.stop(this.present.get(camera.id));
    const receiver = new FileReceiver(link, {
      open: (description) => this.open(camera, description),
    });
    const present: Present = {
      camera,
      link,
      offs: [
        link.on('cut-done', (message) => {
          this.offered(camera, link, message);
        }),
        link.on('cut-failed', (message) => {
          this.cutFailed(camera, message);
        }),
        receiver.onFailed((name, reason) => {
          console.warn(
            `cubetrace: remote clips: ${name} from ${camera.peer()} was not received: ${reason}`,
          );
        }),
        () => {
          receiver.detach();
        },
      ],
    };
    this.present.set(camera.id, present);
    const label = camera.label();
    for (const clip of this.clips.values()) {
      if (clip.label === label && clip.state === 'asked') {
        this.send(clip, camera, link);
      }
    }
    return () => {
      if (this.present.get(camera.id) === present) {
        this.stop(present);
        present.link = null;
      }
    };
  }

  /**
   * A remote camera is no longer listed (it left, the host removed it, it was away five minutes, the
   * session ended): its clips still to come are given up now, unless another entry of the same
   * device (a phone paired again) is listed, or `giveUp` is false (the page goes: the phone keeps
   * them, and offers them to the page that pairs it next).
   */
  gone(id: string, reason: string, giveUp = true): void {
    const present = this.present.get(id);
    if (present === undefined) {
      return;
    }
    this.stop(present);
    this.present.delete(id);
    const label = present.camera.label();
    if (
      !giveUp ||
      label === null ||
      [...this.present.values()].some((p) => p.camera.label() === label)
    ) {
      return;
    }
    for (const clip of [...this.clips.values()]) {
      if (clip.label === label && (clip.state === 'asked' || clip.state === 'coming')) {
        this.giveUp(clip, `the phone left (${reason})`, 'left');
      }
    }
  }

  /** The state of a remote clip, for the tests; null when the host knows of none. */
  stateOf(ref: AttemptRef, label: string, segment: VideoSegment): RemoteClipState | null {
    return this.clips.get(clipKey(ref, label, segment))?.state ?? null;
  }

  /** Resolves once the operations under way have settled, for the tests. */
  async whenIdle(): Promise<void> {
    let last: Promise<unknown> | null = null;
    while (last !== this.pending) {
      last = this.pending;
      await last;
    }
  }

  // ---- The cuts ----

  private onMilestone(milestone: AttemptMilestone): void {
    switch (milestone.type) {
      case 'armed':
      case 'ended': {
        const window = clipWindow(milestone);
        if (window !== null && this.settings.recordRemoteCameras()) {
          this.ask(milestone.attempt, window.segment, {
            fromMs: window.startMs,
            toMs: window.endMs,
            reason: milestone.type,
          });
        }
        if (milestone.type === 'ended') {
          this.ended(milestone.attempt, milestone.endMs);
        }
        break;
      }
      case 'dropped':
        this.dropped(milestone.attempt);
        break;
    }
  }

  /** Asks every camera listed, once per label, for the clip of `segment` of the attempt `ref`. */
  private ask(ref: AttemptRef, segment: VideoSegment, window: RemoteClip['window']): void {
    const byLabel = new Map<string, Present>();
    for (const present of this.present.values()) {
      const label = present.camera.label();
      const known = label === null ? undefined : byLabel.get(label);
      if (
        label !== null &&
        (known === undefined || (known.link === null && present.link !== null))
      ) {
        byLabel.set(label, present);
      }
    }
    for (const [label, present] of byLabel) {
      const key = clipKey(ref, label, segment);
      if (this.clips.has(key)) {
        continue;
      }
      const clip = newClip(ref, label, segment, window, 'asked', this.timers.now());
      clip.peer = present.camera.peer();
      this.clips.set(key, clip);
      clip.held = true;
      this.inFlight.begin(ref.session, ref.index);
      if (present.link !== null) {
        this.send(clip, present.camera, present.link);
      }
    }
  }

  /**
   * Sends the cut of `clip` over `link`, its window in the phone's clock through the fit (once it has
   * an answer), and the same window again when it is sent again.
   */
  private send(clip: RemoteClip, camera: CutCamera, link: MessageLink): void {
    const window = clip.window;
    if (window === null) {
      return;
    }
    this.track(
      this.synced(camera).then((synced) => {
        const estimate = synced ? clockEstimate(camera.fit) : null;
        if (estimate === null || clip.state !== 'asked' || !link.open) {
          return;
        }
        const first = clip.sent === null;
        // Widened by the estimate's margin on each side, so that the phone's clip covers the
        // host's window whatever the estimate's error; the host trims nothing.
        const sent = (clip.sent ??= {
          fromRemoteMs: estimate.toRemoteMs(window.fromMs - estimate.marginMs),
          toRemoteMs: estimate.toRemoteMs(window.toMs + estimate.marginMs),
          marginMs: estimate.marginMs,
        });
        const delivered = link.trySend({
          type: 'cut',
          attempt: clip.ref.index,
          scrambleShown: clip.ref.scrambleShown,
          segment: clip.segment,
          fromRemoteMs: sent.fromRemoteMs,
          toRemoteMs: sent.toRemoteMs,
          reason: window.reason,
          camera: clip.label,
        });
        if (delivered && first) {
          // The record says which numbers the cuts relied on until the fit converges.
          camera.recordClock({ ...estimate.params, converged: estimate.converged });
          this.diagnostics.record(
            'remote.cut',
            {
              outcome: 'sent',
              camera: clip.label,
              peer: camera.peer(),
              segment: clip.segment,
              reason: window.reason,
              windowMs: Math.round(window.toMs - window.fromMs),
              marginMs: Math.round(sent.marginMs),
              waitedMs: Math.round(this.timers.now() - clip.askedMs),
              offsetMs: round1(estimate.params.offsetMs),
              rttMs: round1(estimate.params.rttMs),
              samples: estimate.params.samples,
              converged: estimate.converged,
            },
            scopeOf(clip),
          );
        }
      }),
    );
  }

  /** The attempt ended: its clips are waited for until {@link REMOTE_CLIP_WAIT_MS} after the end. */
  private ended(ref: AttemptRef, endMs: number): void {
    const clips = this.clipsOf(ref);
    for (const clip of clips) {
      clip.endMs = endMs;
    }
    if (!clips.some((clip) => clip.held)) {
      return;
    }
    const key = attemptKey(ref);
    const previous = this.deadlines.get(key);
    if (previous !== undefined) {
      this.timers.clearTimeout(previous);
    }
    const delay = Math.max(0, endMs + this.waitMs - this.timers.now());
    this.deadlines.set(
      key,
      this.timers.setTimeout(() => {
        this.deadlines.delete(key);
        for (const clip of this.clipsOf(ref)) {
          if (clip.state === 'asked' || clip.state === 'coming') {
            this.giveUp(
              clip,
              `no clip within ${String(Math.round(this.waitMs / 1000))} s of the attempt's end`,
              'wait',
            );
          }
        }
      }, delay),
    );
  }

  /** The attempt went without a record (a skip, Mark as solved): nothing of it is taken. */
  private dropped(ref: AttemptRef): void {
    const key = attemptKey(ref);
    const timer = this.deadlines.get(key);
    if (timer !== undefined) {
      this.timers.clearTimeout(timer);
      this.deadlines.delete(key);
    }
    for (const clip of this.clipsOf(ref)) {
      if (clip.state !== 'stored' && clip.state !== 'refused') {
        clip.state = 'refused';
        clip.refusal = 'the attempt is gone';
        this.release(clip);
        this.forget(clip);
      }
    }
  }

  // ---- The phone's answers ----

  /**
   * The phone offers a clip (`cut-done`): one this page asked for, or one of an attempt of the
   * session from before the page was loaded again, taken as an addition when its attempt is there.
   * A clip stored already, or refused, is answered at once (the word was lost with a connection).
   */
  private offered(camera: CutCamera, link: MessageLink, message: CutDone): void {
    const session = this.session.session();
    const label = camera.label();
    const ref: AttemptRef = {
      session: session?.id ?? '',
      index: message.attempt,
      scrambleShown: message.scrambleShown,
    };
    const answer = (stored: boolean, reason: string): void => {
      link.trySend({
        type: 'clip-ack',
        attempt: message.attempt,
        scrambleShown: message.scrambleShown,
        segment: message.segment,
        stored,
        reason,
      });
    };
    if (session === null || label === null) {
      answer(false, 'the session is over');
      return;
    }
    const key = clipKey(ref, label, message.segment);
    let clip = this.clips.get(key);
    if (clip === undefined) {
      if (!this.session.hasAttempt(ref)) {
        answer(false, 'the attempt is gone');
        return;
      }
      clip = newClip(ref, label, message.segment, null, 'coming', this.timers.now());
      this.clips.set(key, clip);
    }
    this.offers.set(offerKey(label, message.attempt, message.segment), clip);
    if (clip.state === 'stored') {
      answer(true, '');
      return;
    }
    if (clip.state === 'refused') {
      answer(false, clip.refusal ?? 'the host does not take it');
      return;
    }
    const first = !clip.answered;
    clip.answered = true;
    clip.details = message.clip;
    clip.peer = camera.peer();
    clip.offeredMs = this.timers.now();
    if (clip.state === 'asked') {
      clip.state = 'coming';
    }
    if (first && clip.window !== null) {
      this.diagnostics.record(
        'remote.cut',
        {
          outcome: 'done',
          camera: label,
          peer: clip.peer,
          segment: clip.segment,
          marginMs: clip.sent === null ? null : Math.round(clip.sent.marginMs),
          delayMs: Math.round(this.timers.now() - clip.window.toMs),
          files: message.files.length,
          bytes: message.files.reduce((sum, file) => sum + file.bytes, 0),
          truncatedStart: message.clip.truncatedStart,
          lateMs: message.clip.lateMs,
        },
        scopeOf(clip),
      );
    }
  }

  /** The phone could not cut a clip (`cut-failed`): it is given up at once. */
  private cutFailed(camera: CutCamera, message: CutFailed): void {
    const session = this.session.session();
    const label = camera.label();
    if (session === null || label === null) {
      return;
    }
    const ref: AttemptRef = {
      session: session.id,
      index: message.attempt,
      scrambleShown: message.scrambleShown,
    };
    const clip = this.clips.get(clipKey(ref, label, message.segment));
    if (clip === undefined || clip.answered) {
      return;
    }
    clip.answered = true;
    this.diagnostics.record(
      'remote.cut',
      {
        outcome: 'failed',
        camera: label,
        peer: camera.peer(),
        segment: clip.segment,
        reason: message.reason,
        delayMs: clip.window === null ? null : Math.round(this.timers.now() - clip.window.toMs),
      },
      scopeOf(clip),
    );
    this.giveUp(clip, `the phone could not cut it: ${message.reason}`, 'cut-failed');
  }

  // ---- The files ----

  /**
   * Where a file of `camera` goes as it comes: the clip it last offered for the file's segment, in
   * memory until it is complete; a file begun again gets the bytes held of it. A file of no clip
   * offered, or of a clip the host does not take, is refused (`file-abort`).
   */
  private open(camera: CutCamera, description: FileDescription): IncomingFile {
    const label = camera.label();
    if (description.attempt === null || description.segment === null || label === null) {
      throw new Error('it belongs to no clip');
    }
    const clip = this.offers.get(offerKey(label, description.attempt, description.segment));
    if (clip === undefined) {
      throw new Error(
        `no clip of attempt ${String(description.attempt)}'s ${description.segment} was offered`,
      );
    }
    if (clip.state === 'stored' || clip.state === 'refused') {
      throw new Error(
        clip.state === 'stored'
          ? 'the host has the clip already'
          : `the host does not take it: ${clip.refusal ?? ''}`,
      );
    }
    const key = `${clipKey(clip.ref, clip.label, clip.segment)}/${description.kind}`;
    const held = this.partials.get(key);
    if (held !== undefined && held.bytes === description.bytes && !held.done) {
      clip.resumedBytes += held.received;
      return held;
    }
    const kind = description.kind;
    const file = new PartialFile(description.bytes, (complete) =>
      kind === 'frames'
        ? this.framesCame(camera, clip, complete)
        : this.mp4Came(camera, clip, complete),
    );
    this.partials.set(key, file);
    return file;
  }

  /**
   * A clip's frames file is complete and checked: its times on the host clock through the fit
   * (`remoteFrames`), written into the attempt's folder. A file that is not a frames file of the
   * clip refuses the clip; a fit without an answer yet throws (the phone sends the file again over
   * the next connection).
   */
  private async framesCame(camera: CutCamera, clip: RemoteClip, file: PartialFile): Promise<void> {
    if (clip.state === 'stored' || clip.state === 'refused') {
      return;
    }
    let phone: FramesJson;
    try {
      phone = parseFrames(JSON.parse(new TextDecoder().decode(file.joined())));
      if (phone.segment !== clip.segment) {
        throw new Error(`it is a ${phone.segment} clip's`);
      }
    } catch (error: unknown) {
      this.refuse(camera, clip, `its frames file could not be read: ${errorMessage(error)}`);
      return;
    }
    const estimate: ClockEstimate | null = (await this.synced(camera))
      ? clockEstimate(camera.fit)
      : null;
    if (estimate === null) {
      throw new Error('the clock sync has had no answer yet');
    }
    if (!this.session.hasAttempt(clip.ref)) {
      this.refuse(camera, clip, 'the attempt is gone');
      return;
    }
    let frames: FramesJson;
    try {
      // The estimate now, converged or not; the file says which it was.
      frames = remoteFrames(phone, clip.label, estimate, this.timers.now());
    } catch (error: unknown) {
      this.refuse(camera, clip, `its frames file could not be read: ${errorMessage(error)}`);
      return;
    }
    // The session's folder exists once its creation is written.
    await this.session.whenSaved();
    await this.files.write(
      clip.ref.session,
      clip.ref.index,
      clipFiles(clip.label, clip.segment).framesFile,
      `${JSON.stringify(frames)}\n`,
    );
    clip.frames = frames;
    clip.framesBytes = file.bytes;
  }

  /**
   * A clip's MP4 is complete and checked: written into the attempt's folder after its frames file,
   * the clip added to the attempt's record, the phone told.
   */
  private async mp4Came(camera: CutCamera, clip: RemoteClip, file: PartialFile): Promise<void> {
    if (clip.state === 'stored' || clip.state === 'refused') {
      return;
    }
    const frames = clip.frames;
    const details = clip.details;
    if (frames === null || details === null) {
      // The phone sends the frames file first, after its offer: both go again with the next offer.
      throw new Error('its frames file has not come');
    }
    if (!this.session.hasAttempt(clip.ref)) {
      this.refuse(camera, clip, 'the attempt is gone');
      return;
    }
    const names = clipFiles(clip.label, clip.segment);
    await this.session.whenSaved();
    await this.files.write(clip.ref.session, clip.ref.index, names.file, file.parts());
    const entry: VideoClip = {
      camera: clip.label,
      segment: clip.segment,
      file: names.file,
      bytes: file.bytes,
      codec: details.codec,
      audio: details.audio,
      width: details.width,
      height: details.height,
      crop: details.crop,
      fpsNominal: details.fpsNominal,
      frames: frames.dtMs.length,
      firstFrameHostMs: frames.t0HostMs,
      framesFile: names.framesFile,
      syncResidualMs: null,
      truncatedStart: details.truncatedStart,
    };
    let attached: ClipAttachment;
    try {
      attached = await this.session.attachClip(clip.ref, entry);
    } catch (error: unknown) {
      throw new Error(`its record could not be saved (${errorMessage(error)})`, { cause: error });
    }
    if (attached === 'gone') {
      this.refuse(camera, clip, 'the attempt is gone');
      return;
    }
    this.stored(camera, clip, frames, file.bytes, attached);
  }

  /** The clip is in its attempt's record: the phone told, the wait ended, the facts recorded. */
  private stored(
    camera: CutCamera,
    clip: RemoteClip,
    frames: FramesJson,
    mp4Bytes: number,
    attached: ClipAttachment,
  ): void {
    const now = this.timers.now();
    const late = clip.missedMs !== null;
    clip.state = 'stored';
    this.release(clip);
    this.ack(camera, clip, true, '');
    this.forget(clip);
    const scope = scopeOf(clip);
    const bytes = clip.framesBytes + mp4Bytes;
    const transferMs = clip.offeredMs === null ? null : Math.round(now - clip.offeredMs);
    this.diagnostics.record(
      'remote.clip',
      {
        camera: clip.label,
        peer: clip.peer,
        segment: clip.segment,
        bytes,
        mp4Bytes,
        transferMs,
        bytesPerSecond:
          transferMs === null || transferMs <= 0 ? null : Math.round((bytes * 1000) / transferMs),
        resumedBytes: clip.resumedBytes,
        late,
        kept: attached === 'kept',
        converged: frames.remote?.converged ?? null,
        offsetMs:
          frames.t0RemoteMs === undefined ? null : round1(frames.t0RemoteMs - frames.t0HostMs),
        truncatedStart: clip.details?.truncatedStart ?? false,
      },
      scope,
    );
    const what = `${clip.segment} of attempt ${String(clip.ref.index)} from ${clip.label}`;
    if (late) {
      const afterEndMs = clip.endMs === null ? null : Math.round(now - clip.endMs);
      this.diagnostics.record(
        'remote.clip.late',
        {
          camera: clip.label,
          peer: clip.peer,
          segment: clip.segment,
          afterEndMs,
          afterMissedMs: Math.round(now - (clip.missedMs ?? now)),
        },
        scope,
      );
      this.note(
        clip.ref.session,
        afterEndMs === null
          ? `remote clip late: ${what}: attached after it was given up`
          : `remote clip late: ${what}: attached ${(afterEndMs / 1000).toFixed(0)} s after the attempt ended`,
      );
    }
    const details = clip.details;
    if (details?.truncatedStart === true) {
      this.note(
        clip.ref.session,
        `clip truncated: ${what} starts ${(details.lateMs / 1000).toFixed(1)} s late (the phone's buffer held ${details.bufferSeconds.toFixed(1)} s)`,
      );
    }
  }

  // ---- Giving up ----

  /**
   * A clip expected will not come in time: the attempt goes to the upload queue without it, and the
   * session's notes say whose clip is missing. It is still taken if it comes.
   */
  private giveUp(clip: RemoteClip, message: string, reason: string): void {
    if (clip.state !== 'asked' && clip.state !== 'coming') {
      return;
    }
    const now = this.timers.now();
    clip.state = 'missing';
    clip.missedMs = now;
    this.release(clip);
    this.missing(clip, message, reason);
  }

  /** The host does not take the clip: the phone told to delete it; missing if it was expected. */
  private refuse(camera: CutCamera, clip: RemoteClip, why: string): void {
    const expected = clip.state === 'asked' || clip.state === 'coming' || clip.state === 'missing';
    const noted = clip.state === 'missing';
    clip.state = 'refused';
    clip.refusal = why;
    this.release(clip);
    this.ack(camera, clip, false, why);
    this.forget(clip);
    if (expected && !noted && why !== 'the attempt is gone') {
      this.missing(clip, why, 'refused');
    }
  }

  private missing(clip: RemoteClip, message: string, reason: string): void {
    this.note(
      clip.ref.session,
      `remote clip missing: ${clip.segment} of attempt ${String(clip.ref.index)} from ${clip.label}: ${message}`,
    );
    this.diagnostics.record(
      'remote.clip.missing',
      {
        camera: clip.label,
        peer: clip.peer,
        segment: clip.segment,
        reason,
        message,
        afterEndMs: clip.endMs === null ? null : Math.round(this.timers.now() - clip.endMs),
      },
      scopeOf(clip),
    );
  }

  // ---- Helpers ----

  /** Tells the camera what became of a clip, over its connection if it has one now. */
  private ack(camera: CutCamera, clip: RemoteClip, stored: boolean, reason: string): void {
    this.present.get(camera.id)?.link?.trySend({
      type: 'clip-ack',
      attempt: clip.ref.index,
      scrambleShown: clip.ref.scrambleShown,
      segment: clip.segment,
      stored,
      reason,
    });
  }

  /** Resolves true once the camera's fit has an answer (at once when it has), false after a while. */
  private synced(camera: CutCamera): Promise<boolean> {
    if (camera.fit.samples > 0) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let off: (() => void) | null = null;
      const timer = this.timers.setTimeout(() => {
        off?.();
        resolve(camera.fit.samples > 0);
      }, SYNC_WAIT_MS);
      off = camera.onSample(() => {
        off?.();
        this.timers.clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** The clip no longer holds its attempt back from the upload queue. */
  private release(clip: RemoteClip): void {
    if (clip.held) {
      clip.held = false;
      this.inFlight.end(clip.ref.session, clip.ref.index);
    }
  }

  /** Lets go of the bytes held of the clip's files. */
  private forget(clip: RemoteClip): void {
    const key = clipKey(clip.ref, clip.label, clip.segment);
    this.partials.delete(`${key}/frames`);
    this.partials.delete(`${key}/mp4`);
  }

  private clipsOf(ref: AttemptRef): RemoteClip[] {
    return [...this.clips.values()].filter(
      (clip) =>
        clip.ref.session === ref.session &&
        clip.ref.index === ref.index &&
        clip.ref.scrambleShown === ref.scrambleShown,
    );
  }

  private stop(present: Present | undefined): void {
    for (const off of present?.offs ?? []) {
      off();
    }
    if (present !== undefined) {
      present.offs = [];
    }
  }

  /** Writes a line into a session's notes, and into the console as `cubetrace: …`. */
  private note(sessionId: string, line: string): void {
    console.warn(`cubetrace: ${line}`);
    this.session.addNote(sessionId, line).catch(() => undefined);
  }

  private track(task: Promise<unknown>): void {
    this.pending = Promise.allSettled([this.pending, task]);
  }
}

/**
 * A file of a remote clip as it comes, in memory (`IncomingFile` of @cubetrace/rtc): its chunks as
 * they came, their count and checksum; `finish` hands it on, and lets the bytes go once that is
 * done; a file whose hand-on failed keeps them, for the next time it is sent.
 */
class PartialFile implements IncomingFile {
  readonly #parts: Uint8Array<ArrayBuffer>[] = [];
  readonly #crc = new Crc32();
  #received = 0;
  /** Handed on: its bytes are gone. */
  done = false;

  constructor(
    readonly bytes: number,
    private readonly handOn: (file: PartialFile) => Promise<void>,
  ) {}

  get received(): number {
    return this.#received;
  }

  get crc32(): number {
    return this.#crc.value;
  }

  append(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.#parts.push(copy);
    this.#received += copy.length;
    this.#crc.update(copy);
  }

  async finish(): Promise<void> {
    await this.handOn(this);
    this.done = true;
    this.#parts.length = 0;
  }

  discard(): void {
    this.#parts.length = 0;
    this.#received = 0;
    this.#crc.reset();
  }

  /** The bytes, in the parts they came in. */
  parts(): readonly Uint8Array<ArrayBuffer>[] {
    return this.#parts;
  }

  /** The bytes in one array. */
  joined(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.#received);
    let at = 0;
    for (const part of this.#parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

function newClip(
  ref: AttemptRef,
  label: string,
  segment: VideoSegment,
  window: RemoteClip['window'],
  state: RemoteClipState,
  nowMs: number,
): RemoteClip {
  return {
    ref,
    label,
    segment,
    window,
    askedMs: nowMs,
    sent: null,
    state,
    held: false,
    answered: false,
    endMs: null,
    missedMs: null,
    peer: '',
    details: null,
    offeredMs: null,
    frames: null,
    framesBytes: 0,
    resumedBytes: 0,
    refusal: null,
  };
}

/** A clip's key: its attempt (its index and when its scramble was shown), the camera and the segment. */
function clipKey(ref: AttemptRef, label: string, segment: VideoSegment): string {
  return `${attemptKey(ref)}/${label}/${segment}`;
}

function attemptKey(ref: AttemptRef): string {
  return `${ref.session}/${String(ref.index)}/${String(ref.scrambleShown)}`;
}

/** The key of a camera's latest offer for an attempt's segment, which its files belong to. */
function offerKey(label: string, index: number, segment: VideoSegment): string {
  return `${label}/${String(index)}/${segment}`;
}

function scopeOf(clip: RemoteClip): { session: string; attempt: number } {
  return { session: clip.ref.session, attempt: clip.ref.index };
}

/** `ms` to a tenth. */
function round1(ms: number): number {
  return Math.round(ms * 10) / 10;
}
