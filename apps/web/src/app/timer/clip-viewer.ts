import {
  CUSTOM_ELEMENTS_SCHEMA,
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
import {
  type AttemptRecord,
  type GyroTrack,
  MIRRORS,
  type Mirror,
  type Quat,
  VIEWER_DEFAULT,
  type VideoClip,
  type ViewerChoice,
  clipHostMs,
  clipSeconds,
  gyroTrack,
  isMirror,
  orientationAt,
  parseGyro,
  referenceAt,
  shownOrientation,
  viewerChoice,
} from '@cubetrace/core';
import { attemptFolder } from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SettingsService } from '../settings/settings-service';
import { downloadBlob, downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';
import { formatBytes } from '../shared/format-bytes';
import { ClipCube, type Orbit, cubePlayerOf } from './clip-cube';
import { ClipViewing } from './clip-viewing';
import { TWISTY_LOADER } from './twisty-loader';

/** A move as the viewer lists it: its time into the clip. */
export interface ClipMove {
  readonly m: string;
  /** From the clip's first frame, in seconds: where the video shows it (the camera's lag applied). */
  readonly seconds: number;
  readonly hostMs: number;
}

/**
 * The moves of `record` in the segment of `clip`, timed from the clip's first frame, where the
 * picture shows them (`clipSeconds`: the camera's lag later than their host times).
 */
export function clipMoves(record: AttemptRecord, clip: VideoClip): ClipMove[] {
  return record.moves
    .filter((move) => move.phase === clip.segment)
    .map((move) => ({
      m: move.m,
      seconds: clipSeconds(clip, move.hostMs),
      hostMs: move.hostMs,
    }));
}

/**
 * The move shown at `seconds` into the clip: the last one made at or before the host time the
 * picture shows then ({@link clipHostMs}); −1 before the first.
 */
export function moveAt(moves: readonly ClipMove[], clip: VideoClip, seconds: number): number {
  const hostMs = clipHostMs(clip, seconds);
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

/** How the viewer stands with the attempt's gyroscope file. */
export type OrientationState = 'none' | 'reading' | 'ready' | 'failed';

/**
 * cubing.js's catch-up animation takes 500 ms over the tempo scale: 5 makes a turn complete in
 * about 100 ms, within the frames that follow the move in the picture.
 */
export const CUBE_TEMPO_SCALE = 5;

/**
 * The player's camera distance (T3.10): cubing.js's default, 6, shows the 3x3x3 (a cube of side 1)
 * at under half the canvas's height; 5 shows it a fifth larger, and its space diagonal (0.87 from the
 * centre) still fits the camera's 20° of vertical field (0.88 at 5), so that no tilt clips a corner.
 */
export const CUBE_CAMERA_DISTANCE = 5;

/** The step of the view's presets, in degrees: a quarter turn around or over the cube. */
export const VIEW_STEP = 90;

/** How the mirrors read in the viewer's select. */
export const MIRROR_TEXT: Readonly<Record<Mirror, string>> = {
  none: 'none',
  'left-right': 'left–right',
  'up-down': 'up–down',
  'front-back': 'front–back',
  all: 'all',
};

/** The line of help under the viewer's controls (docs/PLAN.md T3.10). */
export const VIEW_HELP =
  'Pause where the cube is square to the camera and press Re-zero; if tilts go the other way, ' +
  'choose a mirror; turn the view for a camera behind or beside the cube.';

/**
 * The 3D cube's canvas is as wide as the video and about half as tall: its aspect ratio is twice the
 * clip's (`--cube-aspect`), within 1 and 4; this is a 16:9 clip's, used without a clip.
 */
export const CUBE_ASPECT_DEFAULT = 3.556;

/**
 * The clips of an attempt (docs/PLAN.md, T2.4), in a modal dialog the solve list's clip badge opens:
 * the video of one (the solve's first), read from the origin private file system behind an object
 * URL that goes when it closes, next to the attempt's moves of that segment by their time into the
 * clip, the one the video shows highlighted (a click on a move goes to it); a button per clip, which
 * names its camera's label too when the attempt has several cameras' clips (T4.2: a phone paired as
 * a camera); "Download" gives the clips' MP4s and frames files, the attempt's gyro file when it has
 * one (T3.7) and the attempt's record, attempt.json. A clip deleted from the
 * device once uploaded (`local` false, T3.3) says it is in the cloud in place of its video, and its
 * MP4 is not among the files downloaded.
 *
 * Under the video, a 3D cube follows it (T3.8, T3.10): cubing.js's `<twisty-player>`, which turns
 * with the segment's moves as the picture passes them (the next move animated, the state rebuilt
 * after a seek or when several moves passed in one frame, `ClipCube`) from the segment's starting
 * state (the scramble as the setup alg for the solve, solved for the scramble, whose moves include a
 * mis-scramble's corrections), and tilts as the real cube did when the attempt has a gyro file
 * (`gyro.json`, docs/DATA-MODEL.md §11): the samples around the host time the picture shows, slerped,
 * relative to the sample at the clip's first frame by default, so that the cube starts upright and
 * then moves as the hands moved it ("Re-zero" takes the sample at the current time as the reference;
 * "Raw" shows the samples as they are, their yaw arbitrary), carried into cubing.js's frame (core's
 * `orientation.ts`). The camera's lag (`syncResidualMs`) is applied to the moves and the samples
 * alike: the picture at `t` shows the world `lag` earlier. Without a gyro file (an older attempt, a
 * cube without a gyroscope) the cube still turns, and a line says the orientation is not recorded;
 * a file that cannot be read is said in that line. The viewer follows the video frame by frame while
 * it plays and on every seek, and nothing runs once the dialog closes.
 *
 * The cube is seen straight on by default (T3.10, issue #55): the player's camera level with it and
 * in front (latitude 0, longitude 0, where cubing.js looks from above and to the right), so that an
 * upright cube is drawn upright and a tilt to the right shows to the right. Under the cube, the view
 * is changed by presets (Turn ◀ ▶, 90° of longitude; Tilt ▲ ▼, 90° of latitude, within ±90°; Behind,
 * longitude 180°; Reset view) or by dragging the cube with the mouse or a finger (cubing.js's own
 * drag input, whose orbit the viewer reads back), and a mirror (none, left–right, up–down,
 * front–back, all) reflects the orientation shown, for a camera behind or beside the cube, or a cube
 * whose gyroscope's axes differ. The view and the mirror are kept per camera label (the clip's
 * `camera`) in Settings and, signed in, in the account (`users/{uid}.viewer`, ViewerSyncService), so
 * that the next clip of that camera opens as it was left; "Re-zero" and "Raw" are per clip, not kept.
 */
@Component({
  selector: 'app-clip-viewer',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
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
            [attr.data-camera]="clip.camera"
            [attr.aria-pressed]="clip.file === selected()?.file"
            (click)="choose(clip)"
          >
            {{ clip.segment === 'solve' ? 'Solve' : 'Scramble' }}
            @if (severalCameras()) {
              <span data-testid="clip-segment-camera">· {{ clip.camera }}</span>
            }
            @if (clip.truncatedStart) {
              <span class="late" data-testid="clip-segment-late">· late</span>
            }
            @if (clip.local === false) {
              <span class="muted" data-testid="clip-segment-cloud">· in the cloud</span>
            }
          </button>
        }
      </div>
      <div class="body">
        <div class="player">
          @if (selected()?.local === false) {
            <p class="cloud" data-testid="clip-cloud">
              In the cloud: this clip was deleted from this device once its upload was confirmed
              (Settings → Uploads). Its frame times and the attempt's record are still here.
            </p>
          } @else if (url(); as url) {
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
              (pause)="onTime(video)"
              (seeked)="onSeeked(video)"
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
          @if (cubeShown()) {
            <div class="cube" data-testid="clip-cube" [style.--cube-aspect]="cubeAspect()">
              @if (pictureError(); as error) {
                <p class="error" data-testid="clip-cube-error">No 3D cube: {{ error }}</p>
              } @else {
                <twisty-player
                  #cube
                  data-testid="clip-cube-player"
                  puzzle="3x3x3"
                  visualization="3D"
                  background="none"
                  control-panel="none"
                  hint-facelets="none"
                  experimental-drag-input="auto"
                  camera-latitude="0"
                  camera-longitude="0"
                  camera-latitude-limit="90"
                  [attr.camera-distance]="cameraDistance"
                  [attr.tempo-scale]="tempoScale"
                  title="Drag the cube to turn the view"
                  aria-hidden="true"
                ></twisty-player>
                <div class="view-controls" role="group" aria-label="View">
                  <button
                    type="button"
                    data-testid="clip-turn-left"
                    title="See the cube from 90° further to the left"
                    (click)="turn(-viewStep)"
                  >
                    Turn ◀
                  </button>
                  <button
                    type="button"
                    data-testid="clip-turn-right"
                    title="See the cube from 90° further to the right"
                    (click)="turn(viewStep)"
                  >
                    Turn ▶
                  </button>
                  <button
                    type="button"
                    data-testid="clip-tilt-up"
                    title="See the cube from 90° higher"
                    (click)="tilt(viewStep)"
                  >
                    Tilt ▲
                  </button>
                  <button
                    type="button"
                    data-testid="clip-tilt-down"
                    title="See the cube from 90° lower"
                    (click)="tilt(-viewStep)"
                  >
                    Tilt ▼
                  </button>
                  <button
                    type="button"
                    data-testid="clip-behind"
                    title="See the cube from behind"
                    (click)="behind()"
                  >
                    Behind
                  </button>
                  <button
                    type="button"
                    data-testid="clip-reset-view"
                    title="See the cube from the front, level"
                    (click)="resetView()"
                  >
                    Reset view
                  </button>
                  <label>
                    Mirror:
                    <select
                      #mirrorBox
                      data-testid="clip-mirror"
                      title="Reflect the orientation shown"
                      (change)="setMirror(mirrorBox.value)"
                    >
                      @for (option of mirrors; track option) {
                        <option [value]="option" [selected]="option === mirror()">
                          {{ mirrorText[option] }}
                        </option>
                      }
                    </select>
                  </label>
                </div>
              }
              <p
                class="orientation"
                [class.error]="orientationState() === 'failed'"
                data-testid="clip-orientation"
              >
                {{ orientationText() }}
              </p>
              @if (orientationState() === 'ready') {
                <div class="orientation-controls">
                  <button
                    type="button"
                    data-testid="clip-rezero"
                    title="Take the orientation at this moment as upright"
                    [disabled]="raw()"
                    (click)="rezero()"
                  >
                    Re-zero
                  </button>
                  <label>
                    <input
                      #rawBox
                      type="checkbox"
                      data-testid="clip-raw"
                      [checked]="raw()"
                      (change)="setRaw(rawBox.checked)"
                    />
                    Raw
                  </label>
                </div>
              }
              @if (!pictureError()) {
                <p class="help" data-testid="clip-view-help">{{ viewHelp }}</p>
              }
            </div>
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
        <span class="muted">{{ downloadText() }}</span>
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

    /* On a laptop the player's column (the video, the 3D cube under it and its controls) and the
       moves beside it; on a phone they stack: the video, the cube, the moves. */
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
      max-height: 45vh;
      border-radius: var(--radius);
      background: #000;
    }

    .cube {
      display: grid;
      gap: var(--space-2);
      align-content: start;
    }

    /* As wide as the video and about half as tall: twice the clip's aspect ratio (--cube-aspect) on
       a laptop, 2:1 on a phone; the player's own size (384 × 256 px) is overridden. A finger on it
       drags the cube rather than scrolling the dialog. */
    twisty-player {
      width: 100%;
      max-height: 30vh;
      aspect-ratio: 2 / 1;
      height: auto;
      touch-action: none;

      @media (min-width: 40rem) {
        aspect-ratio: var(--cube-aspect, 3.556);
      }
    }

    .orientation,
    .orientation-controls,
    .view-controls,
    .help {
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .view-controls,
    .orientation-controls {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;

      label {
        display: inline-flex;
        gap: var(--space-1);
        align-items: center;
      }

      button,
      select {
        font-size: 0.8125rem;
      }
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

    .cloud {
      padding: var(--space-4);
      border: 1px dashed var(--line);
      border-radius: var(--radius);
      color: var(--text-muted);
    }
  `,
})
export class ClipViewer {
  /** The attempt, with its clips (`video`). */
  readonly attempt = input.required<AttemptRecord>();
  /** Closed with the dialog (the Close button, Esc). */
  protected readonly viewing = inject(ClipViewing);
  protected readonly tempoScale = CUBE_TEMPO_SCALE;
  protected readonly cameraDistance = CUBE_CAMERA_DISTANCE;
  protected readonly viewStep = VIEW_STEP;
  protected readonly viewHelp = VIEW_HELP;
  protected readonly mirrors = MIRRORS;
  protected readonly mirrorText = MIRROR_TEXT;

  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly document = inject(DOCUMENT);
  private readonly files = inject(ATTEMPT_FILES);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly cubeElement = viewChild<ElementRef<HTMLElement>>('cube');

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
  /** The attempt has clips of several cameras (T4.2): each button names its camera. */
  protected readonly severalCameras = computed(
    () => new Set(this.attempt().video.map((clip) => clip.camera)).size > 1,
  );
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
  /** The 3D cube is shown with a clip on this device (not with one in the cloud, T3.3). */
  protected readonly cubeShown = computed(() => {
    const clip = this.selected();
    return clip !== null && clip.local !== false;
  });
  /** The 3D cube's aspect ratio: twice the clip's, so that it is half as tall as the video. */
  protected readonly cubeAspect = computed(() => {
    const clip = this.selected();
    return clip === null || clip.width <= 0 || clip.height <= 0
      ? CUBE_ASPECT_DEFAULT
      : Math.round(Math.min(4, Math.max(1, (2 * clip.width) / clip.height)) * 1000) / 1000;
  });
  /** The camera whose clip is shown: the view and the mirror are kept per camera label (T3.10). */
  private readonly camera = computed(() => this.selected()?.camera ?? null);
  /**
   * The choice for the clip's camera: as kept on this device (and merged with the account's), else
   * the defaults, the cube seen straight on from the front without a mirror.
   */
  protected readonly choice = computed<ViewerChoice>(() => {
    const camera = this.camera();
    return (camera === null ? null : this.settings.viewerChoiceFor(camera)) ?? VIEWER_DEFAULT;
  });
  protected readonly mirror = computed(() => this.choice().mirror);
  /** `cubing/twisty` could not load: no 3D cube. */
  protected readonly pictureError = signal<string | null>(null);
  /** `cubing/twisty` has defined `<twisty-player>`. */
  private readonly playerReady = signal(false);
  /** The attempt's gyro samples, once read (T3.8). */
  private readonly track = signal<GyroTrack | null>(null);
  protected readonly orientationState = signal<OrientationState>('none');
  private readonly orientationError = signal<string | null>(null);
  /** The sample the cube is shown upright at; null without a track. */
  private readonly reference = signal<Quat | null>(null);
  /** Where in the clip the reference was taken, in seconds. */
  private readonly zeroedAt = signal(0);
  /** "Raw": the samples as recorded, without the reference. */
  protected readonly raw = signal(false);
  /** The line under the cube: where its orientation comes from. */
  protected readonly orientationText = computed(() => {
    switch (this.orientationState()) {
      case 'none':
        return 'Orientation not recorded: the attempt has no gyroscope file. The cube turns with the moves, upright.';
      case 'reading':
        return 'Reading the orientation…';
      case 'failed':
        return this.orientationError() ?? 'The orientation could not be read.';
      case 'ready': {
        const track = this.track();
        const clip = this.selected();
        const from =
          track !== null && clip !== null && track.truncatedStart && track.hostMs.length > 0
            ? ` Not recorded before ${clipSeconds(clip, track.hostMs[0]).toFixed(2)} s.`
            : '';
        return this.raw()
          ? `Orientation from the gyroscope, as recorded (its yaw is arbitrary).${from}`
          : `Orientation from the gyroscope, zeroed at ${this.zeroedAt().toFixed(2)} s.${from}`;
      }
    }
  });
  protected readonly downloading = signal(false);
  protected readonly downloadError = signal<string | null>(null);
  /**
   * What Download gives: the clips still on this device (T3.3), their frame times, the gyroscope
   * file when the attempt has one (T3.7) and the record.
   */
  protected readonly downloadText = computed(() => {
    const { video, gyro } = this.attempt();
    const rest = gyro === null ? ' and attempt.json' : ', the gyroscope and attempt.json';
    const here = video.filter((clip) => clip.local !== false).length;
    if (here === video.length) {
      return video.length === 1
        ? `the clip, its frame times${rest}`
        : `both clips, their frame times${rest}`;
    }
    return here === 0
      ? `the frame times${rest} (the clips are in the cloud)`
      : `the clip on this device, the frame times${rest}`;
  });
  /** Incremented by every clip read: a slower, older read then knows it lost. */
  private reads = 0;
  /** The same for the gyro file. */
  private gyroReads = 0;
  private stopFollowing: (() => void) | null = null;
  /** The 3D cube, on the player element it was made for. */
  private cube: ClipCube | null = null;
  private cubeOn: HTMLElement | null = null;
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
    // The 3D cube's element (the scramble view's chunk); the moves list is the record without it.
    inject(TWISTY_LOADER)().then(
      () => {
        this.playerReady.set(true);
      },
      (error: unknown) => {
        this.pictureError.set(errorMessage(error));
      },
    );
    // The chosen clip's MP4, read from the file system, behind an object URL.
    effect(() => {
      const clip = this.selected();
      const session = this.attempt().session;
      const index = this.attempt().index;
      untracked(() => {
        void this.read(clip, session, index);
      });
    });
    // The attempt's gyro file, once per attempt shown (T3.8).
    effect(() => {
      const record = this.attempt();
      untracked(() => {
        void this.readGyro(record);
      });
    });
    // The 3D cube on its element, loaded with the clip's segment; a new element gets a new cube.
    effect(() => {
      const element = this.cubeElement()?.nativeElement ?? null;
      const ready = this.playerReady();
      const clip = this.selected();
      const moves = this.moves();
      const scramble = this.attempt().scramble;
      untracked(() => {
        if (element === null || !ready || clip === null) {
          this.cube?.dispose();
          this.cube = null;
          this.cubeOn = null;
          return;
        }
        if (this.cubeOn !== element) {
          this.cube?.dispose();
          const player = cubePlayerOf(element);
          this.cube = player === null ? null : new ClipCube(player);
          this.cubeOn = element;
          // The user dragged the cube: the view is kept for the clip's camera (T3.10).
          this.cube?.onDrag((orbit) => {
            this.onDrag(orbit);
          });
        }
        if (this.cube !== null) {
          this.cube.load(
            clip.segment === 'solve' ? scramble : '',
            moves.map((move) => move.m),
          );
          this.cube.show(moveAt(moves, clip, this.time()), true);
          this.cube.orient(this.orientationAt(this.time()));
          this.cube.view(orbitOf(this.choice()));
        }
      });
    });
    // The view and the mirror kept for the clip's camera, as they change (T3.10): a preset, a drag's
    // orbit saved, the mirror, or a merge with the account's. The cube is asked for the view only
    // when it is not there already (a drag's orbit, saved rounded, moves nothing).
    effect(() => {
      const choice = this.choice();
      this.cubeElement();
      this.playerReady();
      untracked(() => {
        if (this.cube !== null) {
          this.cube.view(orbitOf(choice));
          this.reorient();
        }
      });
    });
    // The reference: the sample at the clip's first frame, for each clip and track.
    effect(() => {
      const track = this.track();
      const clip = this.selected();
      untracked(() => {
        this.reference.set(
          track === null || clip === null ? null : referenceAt(track, clipHostMs(clip, 0)),
        );
        this.zeroedAt.set(0);
        this.reorient();
      });
    });
    // The attempt whose clips are viewed (T3.9, `clips.viewed`), once per attempt shown.
    let viewed: string | null = null;
    effect(() => {
      const record = this.attempt();
      untracked(() => {
        const key = `${record.session}/${String(record.index)}`;
        if (viewed === key) {
          return;
        }
        viewed = key;
        this.diagnostics.record(
          'clips.viewed',
          {
            clips: record.video.length,
            local: record.video.filter((clip) => clip.local !== false).length,
            gyro: record.gyro !== null,
          },
          { session: record.session, attempt: record.index },
        );
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
      this.gyroReads++;
      this.stopFollowing?.();
      this.cube?.dispose();
      this.cube = null;
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
    this.sync(video.currentTime, true);
  }

  /** `timeupdate` and `pause`: the time moved on, or stopped. */
  protected onTime(video: HTMLVideoElement): void {
    this.sync(video.currentTime, false);
  }

  /** `seeked`: the time jumped; the cube's state is rebuilt rather than animated. */
  protected onSeeked(video: HTMLVideoElement): void {
    this.sync(video.currentTime, true);
  }

  /**
   * While it plays, the time follows every frame shown (`requestVideoFrameCallback`, where the
   * browser has it; else every animation frame), until it pauses or ends.
   */
  protected follow(video: HTMLVideoElement): void {
    this.stopFollowing?.();
    // A frame of this video, while it is the one shown and plays: its time, and the next frame.
    const frame = (seconds: number, next: () => void): void => {
      if (this.video()?.nativeElement !== video) {
        return;
      }
      this.sync(seconds, false);
      if (!video.paused && !video.ended) {
        next();
      }
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      let handle = 0;
      const next = (): void => {
        handle = video.requestVideoFrameCallback((_now, metadata) => {
          frame(metadata.mediaTime, next);
        });
      };
      next();
      this.stopFollowing = () => {
        video.cancelVideoFrameCallback(handle);
      };
      return;
    }
    const request = this.globals.requestAnimationFrame;
    if (request === undefined) {
      return;
    }
    let handle = 0;
    const next = (): void => {
      handle = request(() => {
        frame(video.currentTime, next);
      });
    };
    next();
    this.stopFollowing = () => {
      this.globals.cancelAnimationFrame?.(handle);
    };
  }

  protected seek(seconds: number): void {
    const video = this.video()?.nativeElement;
    if (video !== undefined) {
      video.currentTime = Math.max(0, seconds);
    }
  }

  /** "Re-zero": the orientation at this moment of the clip becomes upright. */
  protected rezero(): void {
    const track = this.track();
    const clip = this.selected();
    if (track === null || clip === null) {
      return;
    }
    const seconds = this.time();
    this.reference.set(referenceAt(track, clipHostMs(clip, seconds)));
    this.zeroedAt.set(seconds);
    this.reorient();
  }

  /** "Raw": the samples as recorded, or relative to the reference. */
  protected setRaw(raw: boolean): void {
    this.raw.set(raw);
    this.reorient();
  }

  /** "Turn ◀ / ▶": the view `degrees` further around the cube (to the right when positive). */
  protected turn(degrees: number): void {
    const from = this.viewFrom();
    this.applyView(from.latitude, from.longitude + degrees);
  }

  /** "Tilt ▲ / ▼": the view `degrees` higher over the cube (lower when negative), within ±90°. */
  protected tilt(degrees: number): void {
    const from = this.viewFrom();
    this.applyView(from.latitude + degrees, from.longitude);
  }

  /** "Behind": the view from behind the cube, at the same height. */
  protected behind(): void {
    this.applyView(this.viewFrom().latitude, 180);
  }

  /** "Reset view": the view from the front, level with the cube. */
  protected resetView(): void {
    this.applyView(0, 0);
  }

  /** "Mirror": the reflection of the orientation shown, kept for the clip's camera. */
  protected setMirror(value: string): void {
    const camera = this.camera();
    if (!isMirror(value) || camera === null) {
      return;
    }
    const current = this.choice();
    this.settings.setViewerChoice(camera, viewerChoice(current.latitude, current.longitude, value));
    this.reorient();
  }

  /**
   * Where the view is now, or is on its way to: the player's camera as it last reported it (a drag
   * included) or as last asked, else the choice.
   */
  private viewFrom(): Orbit {
    return this.cube?.target ?? orbitOf(this.choice());
  }

  /** Points the player's camera and keeps the view for the clip's camera. */
  private applyView(latitude: number, longitude: number): void {
    const camera = this.camera();
    const next = viewerChoice(latitude, longitude, this.choice().mirror);
    if (camera !== null) {
      this.settings.setViewerChoice(camera, next);
    }
    this.cube?.view(orbitOf(next));
  }

  /** The user dragged the cube to `orbit`: kept for the clip's camera, to a tenth of a degree. */
  private onDrag(orbit: Orbit): void {
    const camera = this.camera();
    if (camera !== null) {
      this.settings.setViewerChoice(
        camera,
        viewerChoice(orbit.latitude, orbit.longitude, this.choice().mirror),
      );
    }
  }

  /** Downloads both clips' MP4s and frames files, the gyro file when there is one, and attempt.json. */
  protected async download(): Promise<void> {
    const record = this.attempt();
    this.downloading.set(true);
    this.downloadError.set(null);
    try {
      // A clip deleted once uploaded (T3.3) has its frames file here, not its MP4; the gyro file
      // (T3.7) stays on the device with the frames files.
      const names = [
        ...record.video.flatMap((clip) =>
          clip.local === false ? [clip.framesFile] : [clip.file, clip.framesFile],
        ),
        ...(record.gyro === null ? [] : [record.gyro.file]),
      ];
      const blobs = await Promise.all(
        names.map((name) => this.files.read(record.session, record.index, name)),
      );
      for (const [at, blob] of blobs.entries()) {
        downloadBlob(this.globals, this.document, attemptFileName(record, names[at]), blob);
      }
      downloadJson(this.globals, this.document, attemptFileName(record, 'attempt.json'), record);
      this.diagnostics.record(
        'files.downloaded',
        { what: 'clips', files: names.length + 1, names: [...names, 'attempt.json'] },
        { session: record.session, attempt: record.index },
      );
    } catch (error: unknown) {
      this.downloadError.set(`The files could not be downloaded: ${errorMessage(error)}`);
    } finally {
      this.downloading.set(false);
    }
  }

  /**
   * The video is at `seconds`: the move shown, the cube's state (animated to the next move as the
   * time passes it, rebuilt after a `seek`) and its orientation then.
   */
  private sync(seconds: number, seek: boolean): void {
    this.time.set(seconds);
    const clip = this.selected();
    if (this.cube === null || clip === null) {
      return;
    }
    this.cube.show(moveAt(this.moves(), clip, seconds), seek);
    this.cube.orient(this.orientationAt(seconds));
  }

  /** The cube's orientation at the current time, after a change of reference. */
  private reorient(): void {
    this.cube?.orient(this.orientationAt(this.time()));
  }

  /**
   * The orientation to show at `seconds` into the clip, in cubing.js's frame: the gyro sample at the
   * host time the picture shows then, relative to the reference unless raw, in the camera's mirror;
   * null without a track, or before a truncated file's first sample.
   */
  private orientationAt(seconds: number): Quat | null {
    const track = this.track();
    const clip = this.selected();
    if (track === null || clip === null) {
      return null;
    }
    const q = orientationAt(track, clipHostMs(clip, seconds));
    return q === null
      ? null
      : shownOrientation(q, this.raw() ? null : this.reference(), this.mirror());
  }

  private async read(clip: VideoClip | null, session: string, index: number): Promise<void> {
    const read = ++this.reads;
    // The previous clip's video goes with its URL: nothing follows it any more.
    this.stopFollowing?.();
    this.stopFollowing = null;
    this.setUrl(null);
    this.readError.set(null);
    this.loaded.set(false);
    this.time.set(0);
    if (clip === null || clip.local === false) {
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

  /** The attempt's gyro file (T3.8), parsed into its track; a failure is one line under the cube. */
  private async readGyro(record: AttemptRecord): Promise<void> {
    const read = ++this.gyroReads;
    this.track.set(null);
    this.orientationError.set(null);
    if (record.gyro === null) {
      this.orientationState.set('none');
      return;
    }
    this.orientationState.set('reading');
    try {
      const blob = await this.files.read(record.session, record.index, record.gyro.file);
      const text = await blob.text();
      if (read !== this.gyroReads) {
        return;
      }
      this.track.set(gyroTrack(parseGyro(JSON.parse(text))));
      this.orientationState.set('ready');
    } catch (error: unknown) {
      if (read === this.gyroReads) {
        this.orientationError.set(`The orientation could not be read: ${errorMessage(error)}`);
        this.orientationState.set('failed');
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

/** The orbit of a choice: its angles. */
function orbitOf(choice: ViewerChoice): Orbit {
  return { latitude: choice.latitude, longitude: choice.longitude };
}
