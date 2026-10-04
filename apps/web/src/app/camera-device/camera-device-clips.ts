import { Injectable, inject, signal } from '@angular/core';
import { clipFiles, type SavedClip } from '@cubetrace/capture';
import type { CameraInfo } from '@cubetrace/core';
import {
  FileSender,
  TransferError,
  blobSource,
  type ClipAck,
  type Cut,
  type FileSource,
  type MessageLink,
} from '@cubetrace/rtc';

import { APP_BUILD } from '../../environments/version';
import { CameraService } from '../camera/camera-service';
import { ENCODER_SETTLE_MS } from '../camera/recording-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { e2eRemote } from '../rtc/e2e-remote';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { errorMessage } from '../shared/error-message';
import { CameraDeviceCapture } from './camera-device-capture';
import {
  CLIP_STAGING,
  STAGED_MAX_AGE_MS,
  STAGING_FOLDER,
  sameSlot,
  type StagedClip,
} from './clip-staging';

/** A cut, as the phone keys it: its attempt, when the attempt's scramble was shown, its segment. */
function cutKey(cut: Pick<Cut, 'attempt' | 'scrambleShown' | 'segment'>): string {
  return `${String(cut.attempt)}/${String(cut.scrambleShown)}/${cut.segment}`;
}

/** The frame rate the camera's track reports, for the clip's `fpsNominal`; 30 if it says none. */
function frameRateOf(info: CameraInfo | null): number {
  const rate = info?.settings['frameRate'];
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 30;
}

/**
 * The camera device's clips (docs/PLAN.md T4.2, docs/RTC.md §3 and §9): the host's `cut`s, cut from
 * the capture's buffer once the window's end is in it (its own clock is the window's, the host having
 * converted it), muxed and staged by the capture's clip worker in `camera-clips` (`CLIP_STAGING`,
 * with a small index), named after the label the host gives the camera; then offered to the host
 * (`cut-done`, with what the capture said of the clip) and sent, the frames file first, the MP4
 * after it (`FileSender`: paced, resumed from the bytes the host holds after a reconnection, checked).
 * A clip stays staged until the host says what became of it (`clip-ack`), and is offered again, first
 * thing, over each connection to the same session until then: a reconnection, a page loaded again, a
 * phone paired again with a new code. A cut asked again (the host sends the cuts it has not heard of
 * again over a new connection) is cut once; a cut of an attempt begun again with the same index
 * replaces the older clip. The clips of other sessions go when the phone joins one, and those older
 * than a day when the Camera page opens. A cut the capture cannot save is answered `cut-failed`.
 */
@Injectable({ providedIn: 'root' })
export class CameraDeviceClips {
  private readonly capture = inject(CameraDeviceCapture);
  private readonly camera = inject(CameraService);
  private readonly staging = inject(CLIP_STAGING);
  private readonly timers = inject(RTC_TIMERS);
  private readonly diagnostics = inject(DiagnosticsService);
  /** The end-to-end suite's settings, in a development build (`E2eRemote`). */
  private readonly hooks = e2eRemote(inject(BROWSER_GLOBALS));

  private readonly pendingSignal = signal(0);
  /** The clips staged that the host has not answered for. */
  readonly pending = this.pendingSignal.asReadonly();

  /** The session joined: its clips are the ones offered. */
  private session: string | null = null;
  /** The staged clips of the session joined, the oldest first. */
  private staged: StagedClip[] = [];
  /** The staged clips as read when the session was joined. */
  private loaded: Promise<void> = Promise.resolve();
  private link: MessageLink | null = null;
  private sender: FileSender | null = null;
  /** The clips offered over the current connection: each once. */
  private offered = new Set<StagedClip>();
  /** The clip being sent now, and those the host answered while they were. */
  private sending: StagedClip | null = null;
  private readonly answered = new Set<StagedClip>();
  /** The cuts waiting for their window's end or being saved, by {@link cutKey}. */
  private readonly cutting = new Map<string, unknown>();
  private looping = false;
  /** The end-to-end suite's cut of the connection was made (once per page). */
  private cutOnce = false;
  /** The operations under way, for the tests to wait on. */
  private pendingWork: Promise<unknown> = Promise.resolve();

  /** The Camera page opened: the clips staged more than a day ago go. */
  start(): void {
    this.track(
      this.staging.prune(this.timers.now() - STAGED_MAX_AGE_MS, null).catch((error: unknown) => {
        console.warn(
          `cubetrace: camera device: the staged clips could not be pruned: ${errorMessage(error)}`,
        );
      }),
    );
  }

  /**
   * The phone joins session `sessionId`: the clips staged for other sessions go, and those of this
   * one are offered first over each connection.
   */
  join(sessionId: string): void {
    if (this.session === sessionId) {
      return;
    }
    this.session = sessionId;
    this.staged = [];
    this.pendingSignal.set(0);
    this.loaded = this.staging
      .prune(this.timers.now() - STAGED_MAX_AGE_MS, sessionId)
      .then(() => this.staging.list())
      .then(
        (clips) => {
          if (this.session === sessionId) {
            this.staged = clips.filter((clip) => clip.session === sessionId);
            this.pendingSignal.set(this.staged.length);
          }
        },
        (error: unknown) => {
          console.warn(
            `cubetrace: camera device: the staged clips could not be read: ${errorMessage(error)}`,
          );
        },
      );
    this.track(this.loaded);
  }

  /**
   * A connection with the host is open: its cuts are taken and the staged clips offered, the oldest
   * first. Returns what stops listening to it.
   */
  attach(link: MessageLink): () => void {
    this.link = link;
    this.sender = new FileSender(link);
    this.offered = new Set();
    const offs = [
      link.on('cut', (cut) => {
        this.cut(cut);
      }),
      link.on('clip-ack', (ack) => {
        this.ack(ack);
      }),
    ];
    this.track(this.loaded.then(() => this.kick()));
    return () => {
      for (const off of offs) {
        off();
      }
      if (this.link === link) {
        this.link = null;
        this.sender = null;
      }
    };
  }

  /** Resolves once the operations under way have settled, for the tests. */
  async whenIdle(): Promise<void> {
    let last: Promise<unknown> | null = null;
    while (last !== this.pendingWork) {
      last = this.pendingWork;
      await last;
    }
  }

  // ---- The cuts ----

  /** The host asks for a clip: cut once its window's end is in the buffer, unless it is asked again. */
  private cut(cut: Cut): void {
    const session = this.session;
    if (this.hooks.ignoreCuts === true || session === null) {
      return;
    }
    const key = cutKey(cut);
    const slot = { session, attempt: cut.attempt, segment: cut.segment };
    if (
      this.cutting.has(key) ||
      this.staged.some((clip) => sameSlot(clip, slot) && clip.scrambleShown === cut.scrambleShown)
    ) {
      return;
    }
    // The same attempt and segment of another scramble: the attempt was begun again, and the clip
    // staged for the older one is nobody's (the new one takes its files' names).
    this.staged = this.staged.filter((clip) => !sameSlot(clip, slot));
    this.pendingSignal.set(this.staged.length);
    const delay = Math.max(0, cut.toRemoteMs + ENCODER_SETTLE_MS - this.timers.now());
    this.cutting.set(
      key,
      this.timers.setTimeout(() => {
        this.track(this.save(cut, session, key));
      }, delay),
    );
  }

  /**
   * Saves the clip of `cut` into the staging folder (the capture's clip worker), stages it and offers
   * it; a cut the capture cannot save is answered `cut-failed`.
   */
  private async save(cut: Cut, session: string, key: string): Promise<void> {
    // The end-to-end suite's phone runs its connection's clock ahead of the capture's (RTC_TIMERS).
    const offsetMs = this.hooks.clockOffsetMs ?? 0;
    const info = this.camera.cameraInfo();
    let saved: SavedClip;
    try {
      saved = await this.capture.saveClip({
        startHostMs: cut.fromRemoteMs - offsetMs,
        endHostMs: cut.toRemoteMs - offsetMs,
        sessionId: session,
        index: cut.attempt,
        camera: cut.camera,
        segment: cut.segment,
        fpsNominal: frameRateOf(info),
        app: APP_BUILD,
        staging: STAGING_FOLDER,
      });
    } catch (error: unknown) {
      this.cutting.delete(key);
      const reason = errorMessage(error);
      this.link?.trySend({
        type: 'cut-failed',
        attempt: cut.attempt,
        scrambleShown: cut.scrambleShown,
        segment: cut.segment,
        reason,
      });
      console.warn(
        `cubetrace: camera device: the ${cut.segment} clip of attempt ${String(cut.attempt)} could not be cut: ${reason}`,
      );
      this.diagnostics.record('remote.cut', {
        outcome: 'failed',
        camera: cut.camera,
        segment: cut.segment,
        reason,
        delayMs: Math.round(this.timers.now() - cut.toRemoteMs),
      });
      return;
    }
    const names = clipFiles(cut.camera, cut.segment);
    try {
      if (offsetMs !== 0) {
        await this.shiftFrames(session, cut.attempt, names.framesFile, offsetMs);
      }
      const frames = await this.staging.read(session, cut.attempt, names.framesFile);
      const mp4 = await this.staging.read(session, cut.attempt, names.file);
      const { clip, report } = saved;
      const staged: StagedClip = {
        session,
        attempt: cut.attempt,
        scrambleShown: cut.scrambleShown,
        segment: cut.segment,
        camera: cut.camera,
        stagedMs: this.timers.now(),
        fromRemoteMs: cut.fromRemoteMs,
        toRemoteMs: cut.toRemoteMs,
        clip: {
          codec: clip.codec,
          audio: clip.audio,
          width: clip.width,
          height: clip.height,
          fpsNominal: clip.fpsNominal,
          frames: clip.frames,
          // The framing when the clip was cut, as the host's own clips take theirs.
          crop: info?.crop ?? null,
          truncatedStart: clip.truncatedStart,
          lateMs: report.lateMs,
          bufferSeconds: report.bufferSeconds,
          audioMissing: report.audioMissing,
        },
        files: [
          { name: names.framesFile, bytes: frames.size, kind: 'frames' },
          { name: names.file, bytes: mp4.size, kind: 'mp4' },
        ],
      };
      await this.staging.add(staged);
      if (this.session === session) {
        this.staged = [...this.staged.filter((known) => !sameSlot(known, staged)), staged];
        this.pendingSignal.set(this.staged.length);
      }
    } catch (error: unknown) {
      const reason = `it could not be staged: ${errorMessage(error)}`;
      this.link?.trySend({
        type: 'cut-failed',
        attempt: cut.attempt,
        scrambleShown: cut.scrambleShown,
        segment: cut.segment,
        reason,
      });
      console.warn(
        `cubetrace: camera device: the ${cut.segment} clip of attempt ${String(cut.attempt)}: ${reason}`,
      );
      return;
    } finally {
      this.cutting.delete(key);
    }
    await this.kick();
  }

  /**
   * Moves a staged frames file's first frame time onto the connection's clock, for the end-to-end
   * suite's phone, whose connection's clock runs ahead of its capture's (`E2eRemote.clockOffsetMs`).
   */
  private async shiftFrames(
    session: string,
    attempt: number,
    name: string,
    offsetMs: number,
  ): Promise<void> {
    const text = await (await this.staging.read(session, attempt, name)).text();
    const frames = JSON.parse(text) as { t0HostMs: number };
    frames.t0HostMs = Math.round((frames.t0HostMs + offsetMs) * 100) / 100;
    await this.staging.write(session, attempt, name, `${JSON.stringify(frames)}\n`);
  }

  // ---- The offers and the files ----

  /**
   * Offers the staged clips not offered over the current connection yet, one after the other; a
   * connection that closes meanwhile ends the loop, unless another one is open by then, which the
   * loop goes on with (its clips offered afresh).
   */
  private async kick(): Promise<void> {
    if (this.looping) {
      return;
    }
    this.looping = true;
    try {
      for (;;) {
        const link = this.link;
        const sender = this.sender;
        const clip = this.staged.find((known) => !this.offered.has(known));
        if (link === null || sender === null || !link.open || clip === undefined) {
          return;
        }
        this.offered.add(clip);
        await this.offer(clip, link, sender);
      }
    } finally {
      this.looping = false;
    }
  }

  /**
   * Offers a clip and sends its files; false when the connection closed meanwhile. A file the host
   * refuses (it has the clip, or does not take it, as its `clip-ack` says) ends the clip's files.
   */
  private async offer(clip: StagedClip, link: MessageLink, sender: FileSender): Promise<boolean> {
    this.sending = clip;
    try {
      link.trySend({
        type: 'cut-done',
        attempt: clip.attempt,
        scrambleShown: clip.scrambleShown,
        segment: clip.segment,
        files: clip.files.map((file) => ({ ...file })),
        clip: clip.clip,
      });
      for (const file of clip.files) {
        if (this.answered.has(clip)) {
          break;
        }
        let blob: Blob;
        try {
          blob = await this.staging.read(clip.session, clip.attempt, file.name);
        } catch {
          // Its files are gone: the host's word, when it comes, lets the entry go too.
          break;
        }
        const source = blobSource(blob, {
          name: file.name,
          kind: file.kind,
          attempt: clip.attempt,
          segment: clip.segment,
        });
        try {
          await sender.send(this.forTheSuite(source, link));
        } catch (error: unknown) {
          if (error instanceof TransferError && error.reason === 'closed') {
            return false;
          }
          // Refused, or its checksum failed: the clip waits for the host's word, or the next
          // connection.
          break;
        }
      }
      return true;
    } finally {
      this.sending = null;
      if (this.answered.delete(clip)) {
        await this.forget(clip);
      }
    }
  }

  /** The host says what became of a clip: either way, the phone's copy goes. */
  private ack(ack: ClipAck): void {
    const clip = this.staged.find(
      (known) =>
        known.attempt === ack.attempt &&
        known.scrambleShown === ack.scrambleShown &&
        known.segment === ack.segment,
    );
    if (clip === undefined) {
      return;
    }
    if (!ack.stored) {
      console.warn(
        `cubetrace: camera device: the host does not take the ${clip.segment} clip of attempt ${String(clip.attempt)}: ${ack.reason}`,
      );
    }
    if (this.sending === clip) {
      // Deleted once its file under way is done with.
      this.answered.add(clip);
      return;
    }
    this.track(this.forget(clip));
  }

  /** Deletes a staged clip, its entry and its files. */
  private async forget(clip: StagedClip): Promise<void> {
    this.staged = this.staged.filter((known) => known !== clip);
    this.pendingSignal.set(this.staged.length);
    await this.staging.remove(clip).catch((error: unknown) => {
      console.warn(
        `cubetrace: camera device: a staged clip could not be deleted: ${errorMessage(error)}`,
      );
    });
  }

  /**
   * `source`, or, for the end-to-end suite's cut of the connection (`E2eRemote.closeAfterBytes`,
   * development builds, once per page), `source` whose read of the first chunk past the number
   * closes the connection first: once the chunks before it have left (the channel's queue empty)
   * and had half a second to arrive, so that the host holds them and the next connection resumes
   * from there, as a connection lost in the middle of a file would.
   */
  private forTheSuite(source: FileSource, link: MessageLink): FileSource {
    const after = this.hooks.closeAfterBytes;
    if (after === undefined || this.cutOnce || source.bytes <= after) {
      return source;
    }
    return {
      ...source,
      slice: async (start, end) => {
        if (start >= after && !this.cutOnce) {
          this.cutOnce = true;
          while (link.open && link.transport.bufferedAmount > 0) {
            await this.wait(50);
          }
          await this.wait(500);
          link.close('the end-to-end suite cut the connection in the middle of a file');
        }
        return source.slice(start, end);
      },
    };
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.setTimeout(resolve, ms);
    });
  }

  private track(task: Promise<unknown>): void {
    this.pendingWork = Promise.allSettled([this.pendingWork, task]);
  }
}
