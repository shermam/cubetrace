import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  type ViewerChoices,
  changedViewerChoices,
  mergeViewerChoices,
  parseViewerChoices,
} from '@cubetrace/core';

import { AuthService, type CloudAccount } from '../auth/auth-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SettingsService } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';

/**
 * A write waits this long after the last change of the choices, so that a drag of the 3D cube,
 * which changes the view many times a second, is one write.
 */
export const VIEWER_WRITE_DELAY_MS = 1000;

/**
 * The clip viewer's choice per camera synced with the account (docs/PLAN.md T3.10,
 * docs/DATA-MODEL.md §10): while an account is signed in, Settings' choices (the view of the 3D cube
 * and the mirror, by camera label) are mirrored in `users/{uid}.viewer`. At each sign-in, and at each
 * start signed in, the account's record is read once and the two are merged (`mergeViewerChoices`:
 * the device's for the cameras it has set, the account's for the others), the account then written
 * what it lacks; from then on, every change of the choices is written a second after the last one
 * (`changedViewerChoices` against what the account is known to hold), one camera or several in one
 * merge. Nothing waits for the server: Firestore applies the writes to its cache at once, and offline
 * they wait there, across reloads; a write lost with the page (closed within the second) is made up
 * by the next start's merge. What goes wrong is shown while it stands (`error`) and said once in the
 * console, never thrown. Signed out it does nothing, and the choices are this device's as before.
 */
@Injectable({ providedIn: 'root' })
export class ViewerSyncService {
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly diagnostics = inject(DiagnosticsService);

  private readonly mergingSignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);

  /** An account is signed in: the choices are synced with it. */
  readonly active = computed(() => this.auth.cloud() !== null);
  /** The merge with the account's record is under way. */
  readonly merging = this.mergingSignal.asReadonly();
  /**
   * What went wrong last and still stands (the record could not be read, a write was refused); null
   * when nothing does. A merge starts afresh, and a write the server confirms clears a refusal.
   */
  readonly error = this.errorSignal.asReadonly();

  /** The account merged in this page load: from then on, each change of the choices goes to it. */
  private merged: string | null = null;
  /** The account whose merge is under way. */
  private mergingUid: string | null = null;
  /** The account's choices as this device knows the server holds them, by camera label. */
  private known: ViewerChoices = {};
  /** The choices sent and not confirmed yet, by camera label: with `known`, what the server will hold. */
  private sent: ViewerChoices = {};
  /** The write waiting for the delay to pass. */
  private timer: number | null = null;
  /** The writes on their way. */
  private readonly inFlight = new Set<Promise<void>>();
  /** What this page load has said, so that each thing is said once. */
  private readonly said = new Set<string>();
  private work: Promise<void> = Promise.resolve();

  constructor() {
    effect(() => {
      const account = this.auth.cloud();
      untracked(() => {
        this.onAccount(account);
      });
    });
    effect(() => {
      this.settings.viewerChoices();
      untracked(() => {
        this.onChange();
      });
    });
  }

  /** Resolves once the merge under way, if any, and the writes sent so far are settled. */
  async whenIdle(): Promise<void> {
    await this.work;
    await Promise.all(this.inFlight);
  }

  /** Writes what waits for the delay now. */
  flush(): void {
    const account = this.auth.cloud();
    if (this.timer !== null && account !== null) {
      this.clearTimer();
      this.send(account);
    }
  }

  private onAccount(account: CloudAccount | null): void {
    if (account === null) {
      this.merged = null;
      this.known = {};
      this.sent = {};
      this.clearTimer();
      this.errorSignal.set(null);
      return;
    }
    if (this.merged !== account.uid && this.mergingUid !== account.uid) {
      this.merged = null;
      this.work = this.merge(account);
    }
  }

  /** The choices changed (the viewer, a merge): the account follows, once merged, after the delay. */
  private onChange(): void {
    const account = this.auth.cloud();
    if (account !== null && this.merged === account.uid) {
      this.schedule(account);
    }
  }

  /**
   * Reads the account's record, merges its choices with Settings' (`mergeViewerChoices`), then
   * writes what the account lacks. When the record cannot be read, the account's choices are left
   * alone until the next start, and the device's stay as they are.
   */
  private async merge(account: CloudAccount): Promise<void> {
    this.mergingUid = account.uid;
    this.mergingSignal.set(true);
    this.errorSignal.set(null);
    try {
      let viewer: unknown;
      try {
        const document = await account.backend.getUser(account.uid);
        viewer = member(document?.data, 'viewer');
      } catch (error: unknown) {
        this.say(
          'read',
          `The clip viewer's choices of your account could not be read: ${reason(error)}`,
        );
        return;
      }
      if (this.auth.cloud()?.uid !== account.uid) {
        return;
      }
      const cloud = parseViewerChoices(viewer);
      const merged = mergeViewerChoices(this.settings.viewerChoices(), cloud);
      this.known = cloud;
      this.sent = {};
      this.merged = account.uid;
      this.settings.setViewerChoices(merged);
      this.schedule(account);
    } finally {
      if (this.mergingUid === account.uid) {
        this.mergingUid = null;
      }
      this.mergingSignal.set(this.mergingUid !== null);
    }
  }

  /** Sends the changes once the delay has passed since the last one. */
  private schedule(account: CloudAccount): void {
    this.clearTimer();
    const setTimer =
      this.globals.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      this.send(account);
    }, VIEWER_WRITE_DELAY_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      const clear = this.globals.clearTimeout ?? ((handle: number) => clearTimeout(handle));
      clear(this.timer);
      this.timer = null;
    }
  }

  /**
   * Writes the choices that the server is not known, or about, to hold (`changedViewerChoices`),
   * in one merge, without waiting for it: the server's confirmation updates what it is known to
   * hold and clears an earlier refusal; a refusal is said.
   */
  private send(account: CloudAccount): void {
    if (this.auth.cloud()?.uid !== account.uid || this.merged !== account.uid) {
      return;
    }
    const changed = changedViewerChoices(
      { ...this.known, ...this.sent },
      this.settings.viewerChoices(),
    );
    if (Object.keys(changed).length === 0) {
      return;
    }
    this.sent = { ...this.sent, ...changed };
    let promise: Promise<void>;
    try {
      promise = account.backend.saveViewer(account.uid, changed);
    } catch (error: unknown) {
      promise = Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    // The page shows what goes wrong with the account signed in, not with one signed out since.
    const current = (): boolean => this.auth.cloud()?.uid === account.uid;
    const settled = (): void => {
      const sent: Record<string, ViewerChoices[string]> = { ...this.sent };
      for (const [label, choice] of Object.entries(changed)) {
        if (sent[label] === choice) {
          Reflect.deleteProperty(sent, label);
        }
      }
      this.sent = sent;
    };
    const flight = promise.then(
      () => {
        settled();
        this.known = { ...this.known, ...changed };
        if (current()) {
          this.clear();
        }
      },
      (error: unknown) => {
        settled();
        if (current()) {
          this.say(
            'write',
            `The clip viewer's choices could not be saved to your account: ${reason(error)}`,
          );
        }
      },
    );
    this.inFlight.add(flight);
    void flight.finally(() => {
      this.inFlight.delete(flight);
    });
  }

  /** Shows `message` as what went wrong, and says it in the console once per page load. */
  private say(key: string, message: string): void {
    this.errorSignal.set(`${message}.`);
    if (!this.said.has(key)) {
      this.said.add(key);
      console.warn(`cubetrace: cloud: ${message}.`);
      this.diagnostics.record('error.app', { where: 'viewer', message: `${message}.` });
    }
  }

  /** What went wrong is no longer wrong (the console keeps what it said). */
  private clear(): void {
    this.errorSignal.set(null);
  }
}

/** `value[key]` of an object; null for anything else. */
function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (Reflect.get(value, key) as unknown) : null;
}

/** Why `error` happened, without its final period. */
function reason(error: unknown): string {
  return errorMessage(error).replace(/\.$/, '');
}
