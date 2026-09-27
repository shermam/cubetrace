import {
  Component,
  DOCUMENT,
  DestroyRef,
  type ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { AttemptRecord, VideoClip } from '@cubetrace/core';
import { attemptFolder } from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { downloadBlob, downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';
import { formatBytes } from '../shared/format-bytes';
import { ClipViewing } from './clip-viewing';

/** A move as the viewer lists it: its time into the clip. */
export interface ClipMove {
  readonly m: string;
  /** From the clip's first frame, in seconds: where the video shows it. */
  readonly seconds: number;
  readonly hostMs: number;
}

/** The moves of `record` in the segment of `clip`, timed from the clip's first frame. */
export function clipMoves(record: AttemptRecord, clip: VideoClip): ClipMove[] {
  return record.moves
    .filter((move) => move.phase === clip.segment)
    .map((move) => ({
      m: move.m,
      seconds: (move.hostMs - clip.firstFrameHostMs) / 1000,
      hostMs: move.hostMs,
    }));
}

/**
 * The move shown at `seconds` into the clip: the last one made at or before the host time
 * `firstFrameHostMs + seconds × 1000`; −1 before the first.
 */
export function moveAt(moves: readonly ClipMove[], clip: VideoClip, seconds: number): number {
  const hostMs = clip.firstFrameHostMs + seconds * 1000;
  let at = -1;
  for (const [index, move] of moves.entries()) {
    if (move.hostMs > hostMs) {
      break;
    }
    at = index;
  }
  return at;
}

/** The name a downloaded file of an attempt gets: `cubetrace-session-<id>-attempt-0001-<name>`. */
export function attemptFileName(record: AttemptRecord, name: string): string {
  return `cubetrace-session-${record.session}-attempt-${attemptFolder(record.index)}-${name}`;
}

/**
 * The clips of an attempt (docs/PLAN.md, T2.4), in a modal dialog the solve list's clip badge opens:
 * the video of one (the solve's first), read from the origin private file system behind an object
 * URL that goes when it closes, next to the attempt's moves of that segment by their time into the
 * clip, the one the video shows highlighted (a click on a move goes to it); "Download" gives both
 * clips' MP4s and frames files and the attempt's record, attempt.json.
 */
@Component({
  selector: 'app-clip-viewer',
  template: `
    <dialog
      #dialog
      aria-labelledby="clip-viewer-title"
      data-testid="clip-viewer"
      (close)="viewing.close()"
    >
      <div class="head">
        <h2 id="clip-viewer-title">Attempt {{ attempt().index }}</h2>
        <button type="button" class="close" aria-label="Close" title="Close" (click)="close()">
          ×
        </button>
      </div>
      <div class="segments" role="group" aria-label="Clip">
        @for (clip of attempt().video; track clip.file) {
          <button
            type="button"
            data-testid="clip-segment"
            [attr.data-segment]="clip.segment"
            [attr.aria-pressed]="clip.file === selected()?.file"
            (click)="choose(clip)"
          >
            {{ clip.segment === 'solve' ? 'Solve' : 'Scramble' }}
            @if (clip.truncatedStart) {
              <span class="late" data-testid="clip-segment-late">· late</span>
            }
          </button>
        }
      </div>
      <div class="body">
        <div class="player">
          @if (url(); as url) {
            <video
              #video
              data-testid="clip-video"
              [attr.data-state]="loaded() ? 'loaded' : 'loading'"
              [src]="url"
              controls
              muted
              playsinline
              (loadedmetadata)="onLoaded(video)"
              (timeupdate)="onTime(video)"
              (seeked)="onTime(video)"
              (play)="follow(video)"
            ></video>
          } @else if (readError(); as error) {
            <p class="error" role="alert" data-testid="clip-error">{{ error }}</p>
          } @else {
            <p class="muted">Reading the clip…</p>
          }
          @if (facts(); as facts) {
            <p class="muted" data-testid="clip-facts">{{ facts }}</p>
          }
        </div>
        <ol class="moves" #list data-testid="clip-moves" aria-label="The moves, by their time">
          @for (move of moves(); track $index) {
            <li [class.current]="$index === current()" data-testid="clip-move">
              <button
                type="button"
                [attr.aria-label]="move.m + ' at ' + move.seconds.toFixed(2) + ' s'"
                [attr.aria-current]="$index === current() ? 'true' : null"
                (click)="seek(move.seconds)"
              >
                <span class="t">{{ move.seconds.toFixed(2) }} s</span>
                <span class="m">{{ move.m }}</span>
              </button>
            </li>
          } @empty {
            <li class="muted">No move in this clip's segment.</li>
          }
        </ol>
      </div>
      <div class="actions">
        <button
          type="button"
          data-testid="clip-download"
          [disabled]="downloading()"
          (click)="download()"
        >
          Download
        </button>
        <span class="muted">both clips, their frame times and attempt.json</span>
      </div>
      @if (downloadError(); as error) {
        <p class="error" role="alert" data-testid="clip-download-error">{{ error }}</p>
      }
    </dialog>
  `,
  styles: `
    dialog {
      width: min(56rem, calc(100vw - 2 * var(--gutter)));
      max-height: calc(100dvh - 2 * var(--gutter));
      padding: var(--space-4) var(--space-5) var(--space-5);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);

      &::backdrop {
        background: rgb(0 0 0 / 60%);
      }
    }

    p {
      margin: 0;
    }

    .head {
      display: flex;
      gap: var(--space-3);
      align-items: center;
      justify-content: space-between;

      h2 {
        margin: 0;
      }
    }

    .close {
      padding: 0 var(--space-2);
      border-color: transparent;
      background: transparent;
      font-size: 1.5rem;
      line-height: 1.25;
    }

    .segments,
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      margin: var(--space-3) 0;
    }

    .segments button[aria-pressed='true'] {
      border-color: var(--accent);
      color: var(--accent);
    }

    .body {
      display: grid;
      gap: var(--space-3);

      @media (min-width: 40rem) {
        grid-template-columns: minmax(0, 3fr) minmax(9rem, 1fr);
      }
    }

    .player {
      display: grid;
      gap: var(--space-2);
      align-content: start;
    }

    video {
      width: 100%;
      max-height: 60vh;
      border-radius: var(--radius);
      background: #000;
    }

    .moves {
      max-height: 60vh;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
      font-family: var(--font-mono);
      font-size: 0.8125rem;

      button {
        display: flex;
        gap: var(--space-2);
        width: 100%;
        padding: 0 var(--space-2);
        border: 0;
        border-radius: 0.25rem;
        background: transparent;
        color: inherit;
        text-align: start;
      }

      .current button {
        background: var(--accent);
        color: var(--on-accent);
      }
    }

    .t {
      min-width: 5.5ch;
      color: var(--text-muted);
      text-align: end;
    }

    .current .t {
      color: inherit;
    }

    .muted {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger);
    }

    .late {
      color: var(--warn);
    }
  `,
})
export class ClipViewer {
  /** The attempt, with its clips (`video`). */
  readonly attempt = input.required<AttemptRecord>();
  /** Closed with the dialog (the Close button, Esc). */
  protected readonly viewing = inject(ClipViewing);

  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly document = inject(DOCUMENT);
  private readonly files = inject(ATTEMPT_FILES);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  /** The clip chosen; the solve's until another is. */
  private readonly chosen = signal<string | null>(null);
  protected readonly selected = computed(() => {
    const video = this.attempt().video;
    const chosen = this.chosen();
    return (
      video.find((clip) => clip.file === chosen) ??
      video.find((clip) => clip.segment === 'solve') ??
      video.at(0) ??
      null
    );
  });
  /** The chosen clip's MP4 behind an object URL. */
  protected readonly url = signal<string | null>(null);
  protected readonly readError = signal<string | null>(null);
  protected readonly loaded = signal(false);
  /** Where the video is, in seconds. */
  private readonly time = signal(0);
  protected readonly moves = computed(() => {
    const clip = this.selected();
    return clip === null ? [] : clipMoves(this.attempt(), clip);
  });
  protected readonly current = computed(() => {
    const clip = this.selected();
    return clip === null ? -1 : moveAt(this.moves(), clip, this.time());
  });
  protected readonly facts = computed(() => {
    const clip = this.selected();
    if (clip === null) {
      return null;
    }
    const audio = clip.audio === null ? 'no audio' : clip.audio;
    const late = clip.truncatedStart
      ? ' It begins later than asked: its start was older than the 90 s kept in memory.'
      : '';
    return (
      `${clip.file}: ${String(clip.width)}×${String(clip.height)}, ${String(clip.frames)} frames, ` +
      `${formatBytes(clip.bytes)}, ${clip.codec}, ${audio}.${late}`
    );
  });
  protected readonly downloading = signal(false);
  protected readonly downloadError = signal<string | null>(null);
  /** Incremented by every clip read: a slower, older read then knows it lost. */
  private reads = 0;
  private stopFollowing: (() => void) | null = null;
  /** The dialog was opened once: once it closes, it stays closed. */
  private shown = false;

  constructor() {
    // Modal as soon as it is on the page: the focus goes into it, and Esc closes it.
    afterRenderEffect(() => {
      const dialog = this.dialog().nativeElement;
      if (!dialog.open && !this.shown) {
        this.shown = true;
        dialog.showModal();
      }
    });
    // The chosen clip's MP4, read from the file system, behind an object URL.
    effect(() => {
      const clip = this.selected();
      const session = this.attempt().session;
      const index = this.attempt().index;
      untracked(() => {
        void this.read(clip, session, index);
      });
    });
    // The move shown stays in sight in the list.
    effect(() => {
      const current = this.current();
      const list = this.list()?.nativeElement;
      if (current < 0 || list === undefined) {
        return;
      }
      const item = list.children.item(current);
      if (item !== null && typeof item.scrollIntoView === 'function') {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.reads++;
      this.stopFollowing?.();
      this.setUrl(null);
    });
  }

  protected choose(clip: VideoClip): void {
    this.chosen.set(clip.file);
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected onLoaded(video: HTMLVideoElement): void {
    this.loaded.set(true);
    this.onTime(video);
  }

  protected onTime(video: HTMLVideoElement): void {
    this.time.set(video.currentTime);
  }

  /** While it plays, the time follows every frame shown (where the browser says so). */
  protected follow(video: HTMLVideoElement): void {
    this.stopFollowing?.();
    if (typeof video.requestVideoFrameCallback !== 'function') {
      return;
    }
    let handle = 0;
    const next = (): void => {
      handle = video.requestVideoFrameCallback((_now, metadata) => {
        this.time.set(metadata.mediaTime);
        if (!video.paused && !video.ended) {
          next();
        }
      });
    };
    next();
    this.stopFollowing = () => {
      video.cancelVideoFrameCallback(handle);
    };
  }

  protected seek(seconds: number): void {
    const video = this.video()?.nativeElement;
    if (video !== undefined) {
      video.currentTime = Math.max(0, seconds);
    }
  }

  /** Downloads both clips' MP4s and frames files, and attempt.json. */
  protected async download(): Promise<void> {
    const record = this.attempt();
    this.downloading.set(true);
    this.downloadError.set(null);
    try {
      const names = record.video.flatMap((clip) => [clip.file, clip.framesFile]);
      const blobs = await Promise.all(
        names.map((name) => this.files.read(record.session, record.index, name)),
      );
      for (const [at, blob] of blobs.entries()) {
        downloadBlob(this.globals, this.document, attemptFileName(record, names[at]), blob);
      }
      downloadJson(this.globals, this.document, attemptFileName(record, 'attempt.json'), record);
    } catch (error: unknown) {
      this.downloadError.set(`The files could not be downloaded: ${errorMessage(error)}`);
    } finally {
      this.downloading.set(false);
    }
  }

  private async read(clip: VideoClip | null, session: string, index: number): Promise<void> {
    const read = ++this.reads;
    this.setUrl(null);
    this.readError.set(null);
    this.loaded.set(false);
    this.time.set(0);
    if (clip === null) {
      return;
    }
    try {
      const blob = await this.files.read(session, index, clip.file);
      if (read !== this.reads) {
        return;
      }
      const urls = this.globals.URL;
      if (urls === undefined) {
        throw new Error('this browser cannot show files (no URL.createObjectURL).');
      }
      this.setUrl(urls.createObjectURL(blob));
    } catch (error: unknown) {
      if (read === this.reads) {
        this.readError.set(`The clip could not be read: ${errorMessage(error)}`);
      }
    }
  }

  /** Shows `url`, letting go of the previous one. */
  private setUrl(url: string | null): void {
    const previous = this.url();
    if (previous !== null) {
      this.globals.URL?.revokeObjectURL(previous);
    }
    this.url.set(url);
  }
}
