import { CUSTOM_ELEMENTS_SCHEMA, Component, computed, inject, input, signal } from '@angular/core';
import type { ScrambleMoveState } from '@cubetrace/core';

import { SessionService, type AttemptView } from '../session/session-service';
import { errorMessage } from '../shared/error-message';
import { TWISTY_LOADER } from './twisty-loader';

export { TWISTY_LOADER } from './twisty-loader';

/**
 * How a move of the scramble on screen looks: how far the cube has made it (`done`; `partial`, a
 * half turn made halfway; `pending`), or `wrong`, the move where the cube left the scramble.
 */
export type ScrambleTokenState = ScrambleMoveState | 'wrong';

/** A move of the scramble on screen, as written in the scramble, and its state. */
export interface ScrambleToken {
  readonly move: string;
  readonly state: ScrambleTokenState;
}

/**
 * The moves of `scramble` as the scramble view marks them (T1.13), for `attempt`, the attempt under
 * way: while it is scrambling, how far the cube has made each (`ScrambleProgress.moves`), and the
 * move at `matched` `wrong` while the cube is off the scramble's path; while it is armed, all `done`
 * (the scramble is complete: the next turn starts the solve); otherwise, while solving and for the
 * next scramble, all `pending`, which is the plain look.
 */
export function scrambleTokens(scramble: string, attempt: AttemptView | null): ScrambleToken[] {
  const marked = (state: (i: number) => ScrambleTokenState): ScrambleToken[] =>
    scramble.split(' ').map((move, i) => ({ move, state: state(i) }));
  if (attempt?.scramble !== scramble) {
    return marked(() => 'pending');
  }
  switch (attempt.state) {
    case 'scrambling': {
      const { moves, matched, diverged } = attempt.progress;
      return marked((i) => (diverged && i === matched ? 'wrong' : (moves.at(i) ?? 'pending')));
    }
    case 'armed':
      return marked(() => 'done');
    default:
      return marked(() => 'pending');
  }
}

/**
 * The scramble at the top of the timer (docs/PLAN.md, T1.6b): its moves in large monospace, its
 * picture beside them (cubing.js's `<twisty-player>`, 2D, the scramble as its setup; smaller on a
 * phone, T2.7), the progress through it
 * and, when the cube leaves its path, the moves that undo the detour, greyed as they are made.
 * While the attempt is scrambling, each move is outlined as the cube makes it (T1.13, see
 * {@link scrambleTokens}): green once made, yellow while a half turn is half made, red where the
 * cube left the scramble; all green once the scramble is complete, until the solve starts. Over the
 * camera's picture (`overPicture`, on a phone, T2.13) it has no picture of its own, and its heading
 * is light, for the dark strip that the Timer page lays it on.
 */
@Component({
  selector: 'app-scramble-view',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  host: { '[class.over-picture]': 'overPicture()' },
  template: `
    <!-- The picture first: it floats at the top right, the heading and the moves beside it and
         then under it (T2.7), so that the scramble takes little height. -->
    @if (session.scramble(); as scramble) {
      @if (pictureError() === null && !overPicture()) {
        <twisty-player
          class="picture"
          data-testid="scramble-picture"
          puzzle="3x3x3"
          visualization="2D"
          background="none"
          control-panel="none"
          aria-hidden="true"
          [attr.experimental-setup-alg]="scramble"
        ></twisty-player>
      }
    }
    <div class="head">
      <h2>{{ forAttempt() ? 'Scramble' : 'Next scramble' }}</h2>
      @if (progress(); as progress) {
        <p class="progress" data-testid="scramble-progress">
          {{ progress.matched }} / {{ progress.total }}
        </p>
      }
    </div>
    @if (session.scramble()) {
      <!-- One element per move, with a plain space between two (&ngsp; is a space that Angular
           keeps), so that the text is the scramble itself. -->
      <p class="moves" data-testid="scramble">
        @for (token of tokens(); track $index) {
          @if (!$first) {
            &ngsp;
          }
          <span class="move" [attr.data-state]="token.state">{{ token.move }}</span>
        }
      </p>
    } @else if (session.scrambleError(); as message) {
      <p class="error" role="alert">No scramble: {{ message }}</p>
    } @else {
      <p class="muted">Generating a scramble…</p>
    }
    @if (undo(); as undo) {
      <div class="undo" role="status" data-testid="undo">
        <p>Off the scramble. Undo:</p>
        <ol>
          @for (move of undo.moves; track $index) {
            <li [class.done]="$index < undo.done">{{ move }}</li>
          }
        </ol>
      </div>
    }
  `,
  styles: `
    :host {
      display: flow-root;
      container-type: inline-size;
    }

    .head {
      display: flex;
      gap: var(--space-3);
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: var(--space-2);
    }

    h2,
    p {
      margin: 0;
    }

    h2 {
      color: var(--text-muted);
      font-size: 0.875rem;
      font-weight: 600;
    }

    .progress {
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }

    .moves {
      font-family: var(--font-mono);
      font-size: clamp(1.125rem, 4.5vw, 1.625rem);
      line-height: 1.6;
      word-spacing: 0.1em;
    }

    /* Every move is the same box in every state, its outline drawn inside it (an inset shadow), so
       a change of state moves nothing. */
    .move {
      display: inline-block;
      padding: 0 0.2em;
      border-radius: 0.3em;
      line-height: 1.3;
      box-shadow: inset 0 0 0 2px var(--move-outline, transparent);

      &[data-state='done'] {
        --move-outline: var(--ok);
        color: var(--ok);
      }

      &[data-state='partial'] {
        --move-outline: var(--warn);
      }

      &[data-state='wrong'] {
        --move-outline: var(--danger);
        color: var(--danger);
      }
    }

    /* Beside the heading and the first lines of the moves, which go on under it. */
    .picture {
      float: right;
      width: 7rem;
      height: 5.25rem;
      margin-left: var(--space-3);
    }

    @container (min-width: 32rem) {
      .picture {
        width: 12rem;
        height: 9rem;
      }
    }

    /* A phone's lines closer together: the time and the camera's preview come under the moves. */
    @container (max-width: 31.99rem) {
      .moves {
        line-height: 1.45;
      }
    }

    /* Over the camera's picture, on a dark strip (T2.13): the heading light, its line tight, and the
       undo guidance tinted rather than opaque, so that the picture still shows through it. */
    :host(.over-picture) {
      .head {
        margin-bottom: var(--space-1);
        line-height: 1.25;
      }

      h2,
      .muted {
        color: rgb(255 255 255 / 80%);
      }

      .undo {
        background: color-mix(in srgb, var(--warn) 30%, transparent);
      }
    }

    .muted {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger);
    }

    .undo {
      clear: both;
      margin-top: var(--space-2);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius);
      background: color-mix(in srgb, var(--warn) 18%, var(--surface));

      ol {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        margin: var(--space-1) 0 0;
        padding: 0;
        font-family: var(--font-mono);
        font-size: 1.5rem;
        list-style: none;
      }

      .done {
        color: var(--text-muted);
        text-decoration: line-through;
      }
    }
  `,
})
export class ScrambleView {
  /** On the camera's picture (the Timer page on a phone, T2.13): no picture of the cube. */
  readonly overPicture = input(false);
  protected readonly session = inject(SessionService);
  protected readonly pictureError = signal<string | null>(null);

  /** The scramble on screen is the current attempt's (else it is the next one's). */
  protected readonly forAttempt = computed(() => {
    const state = this.session.attempt()?.state;
    return state === 'scrambling' || state === 'armed' || state === 'solving';
  });

  /** Scramble moves reached so far, while scrambling. */
  protected readonly progress = computed(() => {
    const attempt = this.session.attempt();
    return attempt?.state === 'scrambling' ? attempt.progress : null;
  });

  /** The scramble's moves with their states (see {@link scrambleTokens}). */
  protected readonly tokens = computed(() => {
    const scramble = this.session.scramble();
    return scramble === null ? [] : scrambleTokens(scramble, this.session.attempt());
  });

  protected readonly undo = computed(() => {
    const undo = this.session.attempt()?.undo;
    return undo !== undefined && undo.moves.length > 0 ? undo : null;
  });

  constructor() {
    inject(TWISTY_LOADER)().catch((error: unknown) => {
      // The text is enough to scramble; the picture is a help.
      this.pictureError.set(errorMessage(error));
    });
  }
}
