import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { ScrambleMoveState } from '@cubetrace/core';

import { SessionService, type AttemptView } from '../session/session-service';
import { errorMessage } from '../shared/error-message';

/**
 * Loads cubing.js's `<twisty-player>` element (`cubing/twisty` defines it when imported). A dynamic
 * import, so that it is a lazy chunk of its own and nothing of it is in the initial bundle; the unit
 * tests give a loader that does nothing.
 */
export const TWISTY_LOADER = new InjectionToken<() => Promise<unknown>>('TWISTY_LOADER', {
  providedIn: 'root',
  factory: () => () => import('cubing/twisty'),
});

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
 * picture (cubing.js's `<twisty-player>`, 2D, the scramble as its setup), the progress through it
 * and, when the cube leaves its path, the moves that undo the detour, greyed as they are made.
 * While the attempt is scrambling, each move is outlined as the cube makes it (T1.13, see
 * {@link scrambleTokens}): green once made, yellow while a half turn is half made, red where the
 * cube left the scramble; all green once the scramble is complete, until the solve starts.
 */
@Component({
  selector: 'app-scramble-view',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="head">
      <h2>{{ forAttempt() ? 'Scramble' : 'Next scramble' }}</h2>
      @if (progress(); as progress) {
        <p class="progress" data-testid="scramble-progress">
          {{ progress.matched }} / {{ progress.total }}
        </p>
      }
    </div>
    @if (session.scramble(); as scramble) {
      <!-- One element per move; the spaces between them keep the text the scramble's own. -->
      <p class="moves" data-testid="scramble">
        @for (token of tokens(); track $index) {
          @if (!$first) {
            &ngsp;
          }
          <span class="move" [attr.data-state]="token.state">{{ token.move }}</span>
        }
      </p>
      @if (pictureError() === null) {
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
      display: grid;
      gap: var(--space-2);
    }

    .head {
      display: flex;
      gap: var(--space-3);
      align-items: baseline;
      justify-content: space-between;
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

    .picture {
      width: min(100%, 12rem);
      height: 9rem;
    }

    .muted {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger);
    }

    .undo {
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
