import {
  Component,
  DOCUMENT,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AttemptRecord, SessionRecord } from '@cubetrace/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { StorageService } from '../device/storage-service';
import { SessionService } from '../session/session-service';
import { sessionStats } from '../session/session-stats';
import { downloadJson } from '../shared/download';
import { errorMessage } from '../shared/error-message';
import { formatBytes } from '../shared/format-bytes';
import { ClipViewer } from '../timer/clip-viewer';
import { ClipViewing } from '../timer/clip-viewing';
import { SolveList } from '../timer/solve-list';
import { exportFileName } from './session-export';

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The session the page shows, with its attempts. */
interface Shown {
  readonly session: SessionRecord;
  readonly attempts: readonly AttemptRecord[];
  /** The session the timer is recording: it changes as the attempts come. */
  readonly current: boolean;
}

/** "laptop (FaceTime HD Camera), phone-front": the cameras of `session`; "none" without one. */
export function camerasText(session: SessionRecord): string {
  const cameras = session.cameras.map((camera) =>
    camera.deviceLabel === '' || camera.deviceLabel === camera.label
      ? camera.label
      : `${camera.label} (${camera.deviceLabel})`,
  );
  return cameras.length === 0 ? 'none' : cameras.join(', ');
}

/** "30 clips, 120.3 MB": the clips of `attempts` and their MP4s' bytes; "none" without one. */
export function clipsText(attempts: readonly AttemptRecord[]): string {
  const clips = attempts.flatMap((attempt) => attempt.video);
  const bytes = clips.reduce((sum, clip) => sum + clip.bytes, 0);
  return clips.length === 0
    ? 'none'
    : `${String(clips.length)} ${clips.length === 1 ? 'clip' : 'clips'}, ${formatBytes(bytes)}`;
}

/**
 * `/sessions/<id>` (docs/PLAN.md, T2.7): one session, from the Sessions page (a row's date) or the
 * Timer's "See all". Its date, device, cube and cameras, its statistics (attempts, DNFs, mean, best,
 * ao5, ao12 and ao100), the storage its clips take, and every attempt, newest first, whose clip
 * badge opens the clip viewer (with Download) on that attempt's files, in this session's folder;
 * Export and Delete as on the Sessions page (after a deletion, back to it). The session the timer is
 * recording is shown from `SessionService`'s signals, so the page follows its attempts as they come;
 * another one is read once from the store.
 */
@Component({
  selector: 'app-session-page',
  imports: [ClipViewer, RouterLink, SolveList],
  template: `
    <p class="back"><a routerLink="/sessions">Sessions</a></p>
    <h1>Session</h1>
    @if (shown(); as shown) {
      <p class="when">
        <span data-testid="session-date">{{ when(shown.session.createdMs) }}</span>
        @if (shown.current) {
          <span class="current" data-testid="session-current">current</span>
        }
      </p>
      <dl class="facts">
        <div>
          <dt>Device</dt>
          <dd data-testid="session-device">{{ shown.session.host.label }}</dd>
        </div>
        <div>
          <dt>Cube</dt>
          <dd data-testid="session-cube">{{ shown.session.cube.model }}</dd>
        </div>
        <div>
          <dt>Camera</dt>
          <dd data-testid="session-cameras">{{ cameras() }}</dd>
        </div>
        <div>
          <dt>Clips</dt>
          <dd data-testid="session-clip-bytes">{{ clips() }}</dd>
        </div>
      </dl>
      @if (stats(); as stats) {
        <dl class="stats" data-testid="session-page-stats">
          <div>
            <dt>Attempts</dt>
            <dd data-testid="stat-count">{{ stats.count }}</dd>
          </div>
          <div>
            <dt>DNF</dt>
            <dd data-testid="stat-dnf">{{ stats.dnf }}</dd>
          </div>
          <div>
            <dt>Mean</dt>
            <dd data-testid="stat-mean">{{ stats.mean }}</dd>
          </div>
          <div>
            <dt>Best</dt>
            <dd data-testid="stat-best">{{ stats.best }}</dd>
          </div>
          <div>
            <dt>ao5</dt>
            <dd data-testid="stat-ao5">{{ stats.ao5 }}</dd>
          </div>
          <div>
            <dt>ao12</dt>
            <dd data-testid="stat-ao12">{{ stats.ao12 }}</dd>
          </div>
          <div>
            <dt>ao100</dt>
            <dd data-testid="stat-ao100">{{ stats.ao100 }}</dd>
          </div>
        </dl>
      }
      @if (confirming()) {
        <div class="actions" role="group" aria-label="Confirm the deletion">
          <p>Delete this session, its {{ attemptCount(shown.attempts.length) }} and its clips?</p>
          <button type="button" class="danger" (click)="remove()">Delete</button>
          <button type="button" (click)="confirming.set(false)">Cancel</button>
        </div>
      } @else {
        <div class="actions">
          <button type="button" (click)="download()">Export</button>
          <button type="button" (click)="confirming.set(true)">Delete…</button>
          <span class="muted">Export saves the records as one JSON file, without the video.</span>
        </div>
      }
      @if (failure(); as failure) {
        <p class="error" role="alert" data-testid="session-page-error">{{ failure }}</p>
      }
      @if (notice(); as notice) {
        <p class="muted" role="status" data-testid="session-page-notice">{{ notice }}</p>
      }
      <section class="attempts" aria-label="Attempts">
        <app-solve-list [attempts]="shown.attempts" [showStats]="false" />
      </section>
    } @else if (loadError(); as error) {
      <p class="error" role="alert" data-testid="session-error">{{ error }}</p>
    } @else {
      <p class="muted">Reading the session…</p>
    }
    @if (viewed(); as attempt) {
      @defer (on immediate) {
        <app-clip-viewer [attempt]="attempt" />
      }
    }
  `,
  styles: `
    p,
    dl,
    dd {
      margin: 0;
    }

    .back {
      margin-bottom: var(--space-2);
      font-size: 0.875rem;

      a::before {
        content: '‹ ';
      }
    }

    h1 {
      margin-bottom: var(--space-2);
    }

    .muted {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger);
    }

    .when {
      font-weight: 600;
    }

    .current {
      margin-left: var(--space-2);
      padding: 0 var(--space-2);
      border-radius: 999px;
      background: var(--accent);
      color: var(--on-accent);
      font-size: 0.75rem;
      font-weight: 400;
    }

    .facts,
    .stats {
      display: grid;
      gap: var(--space-2) var(--space-4);
      margin: var(--space-3) 0;

      dt {
        color: var(--text-muted);
        font-size: 0.75rem;
      }
    }

    .facts {
      grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));

      dd {
        overflow-wrap: anywhere;
      }
    }

    .stats {
      grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
      text-align: center;

      dd {
        font-family: var(--font-mono);
        font-variant-numeric: tabular-nums;
      }
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
      margin: var(--space-3) 0;

      .muted {
        font-size: 0.875rem;
      }
    }

    .danger {
      border-color: transparent;
      background: var(--danger);
      color: var(--on-accent);
    }

    .attempts {
      margin-top: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }
  `,
})
export class SessionPage {
  private readonly sessions = inject(SessionService);
  private readonly storage = inject(StorageService);
  private readonly router = inject(Router);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly document = inject(DOCUMENT);
  private readonly viewing = inject(ClipViewing);

  /** The session's id, from the address. */
  protected readonly id = signal('');
  /** The session as read from the store, when it is not the current one. */
  private readonly loaded = signal<{
    session: SessionRecord;
    attempts: readonly AttemptRecord[];
  } | null>(null);
  /** Why the session could not be read (it is gone, or unreadable). */
  protected readonly loadError = signal<string | null>(null);
  protected readonly confirming = signal(false);
  /** An export or a deletion that failed, and why. */
  protected readonly failure = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  private readonly currentId = computed(() => this.sessions.session()?.id ?? null);

  protected readonly shown = computed((): Shown | null => {
    const id = this.id();
    const current = this.sessions.session();
    if (current?.id === id) {
      return { session: current, attempts: this.sessions.attempts(), current: true };
    }
    const loaded = this.loaded();
    return loaded?.session.id === id ? { ...loaded, current: false } : null;
  });
  protected readonly stats = computed(() => {
    const shown = this.shown();
    return shown === null ? null : sessionStats(shown.attempts);
  });
  protected readonly cameras = computed(() => {
    const shown = this.shown();
    return shown === null ? '' : camerasText(shown.session);
  });
  protected readonly clips = computed(() => {
    const shown = this.shown();
    return shown === null ? '' : clipsText(shown.attempts);
  });
  /** The attempt whose clips the viewer shows; null while it is closed. */
  protected readonly viewed = computed(() => {
    const index = this.viewing.index();
    const shown = this.shown();
    return index === null || shown === null
      ? null
      : (shown.attempts.find((attempt) => attempt.index === index) ?? null);
  });
  /** Incremented by every read: a slower, older read then knows it lost. */
  private reads = 0;
  /** Set once the session is being deleted: it is not read again meanwhile. */
  private deleting = false;

  constructor() {
    const params = inject(ActivatedRoute).paramMap.subscribe((map) => {
      this.id.set(map.get('id') ?? '');
    });
    inject(DestroyRef).onDestroy(() => {
      params.unsubscribe();
      this.viewing.close();
    });
    // A session other than the current one is read from the store, once the stored current
    // session is known (and again if the current one becomes another).
    effect(() => {
      const id = this.id();
      const ready = this.sessions.ready();
      const current = this.currentId();
      if (ready && id !== '' && current !== id && !this.deleting) {
        untracked(() => {
          void this.load(id);
        });
      }
    });
  }

  protected when(ms: number): string {
    return WHEN.format(ms);
  }

  protected attemptCount(count: number): string {
    return `${String(count)} ${count === 1 ? 'attempt' : 'attempts'}`;
  }

  protected async download(): Promise<void> {
    const id = this.id();
    this.failure.set(null);
    try {
      const exported = await this.sessions.exportSession(id);
      const fileName = exportFileName(id);
      downloadJson(this.globals, this.document, fileName, exported);
      this.notice.set(`Exported ${fileName}.`);
    } catch (error: unknown) {
      this.failure.set(`The session could not be exported: ${errorMessage(error)}`);
    }
  }

  /** Deletes the session with its attempts and clips, then goes back to the Sessions page. */
  protected async remove(): Promise<void> {
    const id = this.id();
    this.confirming.set(false);
    this.failure.set(null);
    this.deleting = true;
    try {
      await this.sessions.deleteSession(id);
    } catch (error: unknown) {
      this.deleting = false;
      this.failure.set(`The session could not be deleted: ${errorMessage(error)}`);
      return;
    }
    // The meter goes down with it, and a camera stopped by full storage records again.
    void this.storage.refresh();
    await this.router.navigate(['/sessions']);
  }

  private async load(id: string): Promise<void> {
    const read = ++this.reads;
    this.loadError.set(null);
    try {
      const { session, attempts } = await this.sessions.exportSession(id);
      if (read === this.reads) {
        this.loaded.set({ session, attempts });
      }
    } catch (error: unknown) {
      if (read === this.reads) {
        this.loaded.set(null);
        this.loadError.set(`This session could not be read: ${errorMessage(error)}`);
      }
    }
  }
}
