import { type Page, test } from '@playwright/test';

// A record of everything the Timer page renders, for the states the demo cube passes through within
// a frame at speed 20: the armed attempt (the solution's first move comes as soon as the scramble's
// last one has been taken in), a mis-scramble's undo guidance (its inverse comes after a pause of
// 50 ms) and a half turn of the scramble made halfway (its second quarter turn comes 3 ms after the
// first). Polling the page could miss them. The app renders each of them at least once, because
// the demo cube sets the timer of the move that ends them only after the move that starts them
// (src/app/cube/demo.ts, `demoParts`), and a MutationObserver sees every render.

/**
 * What the Timer page shows at one moment (src/app/timer/timer-clock.ts, scramble-view.ts and
 * solve-list.ts).
 */
export interface TimerView {
  /** The status line's `data-phase`: `loading`, `scrambling`, `armed`, `solving`, … */
  readonly phase: string | null;
  readonly status: string;
  /** The time's `data-kind`: `idle`, `ready`, `inspection`, `running`, `solved`, `dnf`, … */
  readonly kind: string | null;
  readonly time: string;
  /** "Attempt 2". */
  readonly attempt: string;
  /** The scramble's progress, "5 / 21", while an attempt is scrambling. */
  readonly progress: string | null;
  /** The undo guidance's moves, while it is shown. */
  readonly undo: readonly string[] | null;
  /** The scramble on screen, as text. */
  readonly scramble: string;
  /** The mark of each of its moves (`data-state`): `done`, `partial`, `wrong` or `pending`. */
  readonly marks: readonly string[];
  /** The solve list, newest first: "<index> <status>" per row. */
  readonly rows: readonly string[];
}

const KEY = '__cubetraceTimerViews';

/**
 * Records every state the Timer page renders from now on, on every page load (call it before
 * `page.goto`); {@link timerViews} reads the record of the current load.
 */
export async function recordTimerViews(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const views: unknown[] = [];
    Reflect.set(window, key, views);
    const byTestId = (testId: string): Element | null =>
      document.querySelector(`[data-testid="${testId}"]`);
    const text = (element: Element | null): string => element?.textContent.trim() ?? '';
    let last = '';
    new MutationObserver(() => {
      const status = byTestId('timer-status');
      const timer = byTestId('timer');
      const progress = byTestId('scramble-progress');
      const undo = byTestId('undo');
      const scramble = byTestId('scramble');
      const view = {
        phase: status?.getAttribute('data-phase') ?? null,
        status: text(status),
        kind: timer?.getAttribute('data-kind') ?? null,
        time: text(timer),
        attempt: text(byTestId('attempt-index')),
        progress: progress === null ? null : text(progress),
        undo: undo === null ? null : Array.from(undo.querySelectorAll('li'), (li) => text(li)),
        scramble: text(scramble),
        marks:
          scramble === null
            ? []
            : Array.from(
                scramble.querySelectorAll('.move'),
                (move) => move.getAttribute('data-state') ?? '',
              ),
        rows: Array.from(
          document.querySelectorAll('[data-testid="solve-row"]'),
          (row) =>
            `${row.getAttribute('data-index') ?? ''} ${row.getAttribute('data-status') ?? ''}`,
        ),
      };
      const json = JSON.stringify(view);
      if (json !== last) {
        last = json;
        views.push(view);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }, KEY);
}

/**
 * The views recorded since the page last loaded, oldest first; also attached to the test's report
 * (`timer-views`), to see what the page went through when a flow fails.
 */
export async function timerViews(page: Page): Promise<TimerView[]> {
  const views = (await page.evaluate((key) => Reflect.get(window, key) as unknown, KEY)) as
    TimerView[] | undefined;
  if (views === undefined) {
    throw new Error('No views: call recordTimerViews(page) before loading the page.');
  }
  await test.info().attach('timer-views', {
    body: JSON.stringify(views, null, 1),
    contentType: 'application/json',
  });
  return views;
}

/**
 * The index of the first view after view `after` that `is` accepts; fails the test, naming `what`,
 * when there is none.
 */
export function viewAfter(
  views: readonly TimerView[],
  after: number,
  what: string,
  is: (view: TimerView) => boolean,
): number {
  const index = views.findIndex((view, i) => i > after && is(view));
  if (index < 0) {
    throw new Error(
      `The Timer page never showed ${what} after view ${String(after)} of ` +
        `${String(views.length)} (see the timer-views attachment).`,
    );
  }
  return index;
}
