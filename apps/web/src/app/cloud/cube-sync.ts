import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { cloudCube, parseCloudCube } from '@cubetrace/core';

import type { AccountBackend, CloudListing } from '../auth/account-backend';
import { AuthService, type CloudAccount } from '../auth/auth-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SettingsService, type CubeMac } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { cubeChanges, cubeKey, mergeCubes, type CloudCubeEntry } from './cube-merge';

/**
 * The `localStorage` key of what the cube sync keeps on this device, by account: when this device
 * last merged its list with the account's, and what it knows the server holds.
 */
export const CUBE_SYNC_KEY = 'cubetrace.cubeSync';

/** What the cube sync keeps on this device for an account. */
interface AccountState {
  /**
   * When this device last merged its list with the account's as the server had it: host clock, ms;
   * null before the first.
   */
  mergedMs: number | null;
  /** The account's cubes as this device knows the server holds them: document name → updatedMs. */
  known: Record<string, number>;
}

/**
 * The cubes' MAC addresses synced per account (docs/PLAN.md T3.4, issue #21; docs/DATA-MODEL.md
 * §10): while an account is signed in, Settings' cube list is mirrored in
 * `users/{uid}/cubes/{name}`, one document per cube. At each sign-in, and at each start signed in,
 * the two lists are merged (`mergeCubes`: their union, the copy changed last winning, deletions on
 * either side carried to the other); from then on, every change of the list writes or deletes its
 * documents. Nothing waits for the server: Firestore applies the writes to its cache at once, and
 * offline they wait there, across reloads. What goes wrong is shown while it stands (`error`) and
 * said once in the console, never thrown. Signed out it does nothing, and the list is this device's
 * as before.
 */
@Injectable({ providedIn: 'root' })
export class CubeSyncService {
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly diagnostics = inject(DiagnosticsService);

  private readonly mergingSignal = signal(false);
  private readonly offlineSignal = signal(false);
  private readonly lastMergeSignal = signal<number | null>(null);
  /**
   * What went wrong and still stands, by what it is about (`read`, `write <name>`, …), oldest
   * first.
   */
  private readonly problems = signal<ReadonlyMap<string, string>>(new Map());
  /** The writes sent and not confirmed yet, counted by account. */
  private readonly waiting = signal<ReadonlyMap<string, number>>(new Map());

  /** An account is signed in: the list is synced with it. */
  readonly active = computed(() => this.auth.cloud() !== null);
  /** A merge is under way. */
  readonly merging = this.mergingSignal.asReadonly();
  /**
   * This page load's merge read this device's copy of the account's list: the server was out of
   * reach.
   */
  readonly offline = this.offlineSignal.asReadonly();
  /**
   * When this device last merged its list with the account's as the server had it (host clock, kept
   * across page loads); null before the first, and without an account.
   */
  readonly lastMerge = this.lastMergeSignal.asReadonly();
  /**
   * What went wrong last and still stands (the list could not be read, a write was refused, a
   * document or a name is left alone); null when nothing does. A merge starts afresh, and a cube's
   * write that the server confirms clears its refusal.
   */
  readonly error = computed(() => [...this.problems().values()].at(-1) ?? null);
  /**
   * The writes of this page load to the account signed in that the server has not confirmed yet:
   * offline, they wait.
   */
  readonly unconfirmed = computed(() => {
    const uid = this.auth.cloud()?.uid;
    return uid === undefined ? 0 : (this.waiting().get(uid) ?? 0);
  });

  /** The account merged in this page load: from then on, each change of the list goes to it. */
  private merged: string | null = null;
  /** The account whose merge is under way. */
  private mergingUid: string | null = null;
  /**
   * The writes sent and not confirmed yet, by account, then by document name: the `updatedMs`
   * written, or null for a deletion. With what the server is known to hold, what it will hold. They
   * stay across a sign-out: Firestore keeps an account's writes until it is signed in again.
   */
  private readonly sent = new Map<string, Map<string, number | null>>();
  /** The names (by `cubeKey`) left alone: the account's documents of them could not be read. */
  private skipped = new Set<string>();
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
      this.settings.cubeMacs();
      untracked(() => {
        this.onChange();
      });
    });
  }

  /** Resolves once the merge under way, if any, is done: its writes sent, not confirmed. */
  whenIdle(): Promise<void> {
    return this.work;
  }

  private onAccount(account: CloudAccount | null): void {
    if (account === null) {
      this.merged = null;
      this.skipped = new Set();
      this.lastMergeSignal.set(null);
      this.offlineSignal.set(false);
      this.problems.set(new Map());
      return;
    }
    this.lastMergeSignal.set(this.state(account.uid).mergedMs);
    if (this.merged !== account.uid && this.mergingUid !== account.uid) {
      this.merged = null;
      this.work = this.merge(account);
    }
  }

  /**
   * The list changed (the user, the connect dialog, a merge): its documents follow, once merged.
   */
  private onChange(): void {
    const account = this.auth.cloud();
    if (account !== null && this.merged === account.uid) {
      this.reconcile(account);
    }
  }

  /**
   * Reads the account's list, merges it with Settings' (`mergeCubes`), then writes what the account
   * lacks. When the list cannot be read, the account's list is left alone until the next start.
   */
  private async merge(account: CloudAccount): Promise<void> {
    this.mergingUid = account.uid;
    this.mergingSignal.set(true);
    this.problems.set(new Map());
    try {
      let listing: CloudListing;
      try {
        listing = await account.backend.listCubes(account.uid);
      } catch (error: unknown) {
        this.say('read', `The cubes of your account could not be read: ${reason(error)}`);
        return;
      }
      if (this.auth.cloud()?.uid !== account.uid) {
        return;
      }
      const cloud: CloudCubeEntry[] = [];
      const unreadable: string[] = [];
      for (const { id, data, pending } of listing.documents) {
        try {
          const cube = parseCloudCube(data);
          if (cube.name !== id) {
            throw new Error(`its name is "${cube.name}"`);
          }
          cloud.push({ cube, pending });
        } catch (error: unknown) {
          unreadable.push(id);
          const why = reason(error);
          this.say(`unreadable ${id}`, `The cube ${id} of your account is left as it is: ${why}`);
        }
      }
      const merge = mergeCubes({
        local: this.settings.cubeMacs(),
        cloud,
        unreadable,
        known: new Map(Object.entries(this.state(account.uid).known)),
        fromServer: !listing.fromCache,
      });
      const now = hostNow(this.globals);
      this.editState(account.uid, (kept) => {
        kept.known = Object.fromEntries(merge.known);
        if (!listing.fromCache) {
          kept.mergedMs = now;
        }
      });
      this.skipped = new Set(unreadable.map(cubeKey));
      this.merged = account.uid;
      this.offlineSignal.set(listing.fromCache);
      if (!listing.fromCache) {
        this.lastMergeSignal.set(now);
      }
      if (JSON.stringify(merge.local) !== JSON.stringify(this.settings.cubeMacs())) {
        this.settings.setCubeMacs(merge.local);
      }
      // Counts only: never a name's address (docs/DIAGNOSTICS.md).
      this.diagnostics.record('cubes.synced', {
        count: merge.local.length,
        cloud: cloud.length,
        unreadable: unreadable.length,
        fromServer: !listing.fromCache,
      });
      this.reconcile(account);
    } finally {
      if (this.mergingUid === account.uid) {
        this.mergingUid = null;
      }
      this.mergingSignal.set(this.mergingUid !== null);
    }
  }

  /**
   * Writes the entries of Settings' list that the server does not hold in their version, and
   * deletes the documents of the entries gone (`cubeChanges`), but those already on their way.
   */
  private reconcile(account: CloudAccount): void {
    const known = new Map(Object.entries(this.state(account.uid).known));
    for (const [name, written] of this.sentOf(account.uid)) {
      if (written === null) {
        known.delete(name);
      } else {
        known.set(name, written);
      }
    }
    const changes = cubeChanges(this.settings.cubeMacs(), known, this.skipped);
    // A name that cannot name a document stands as a problem while the list has it.
    const unsyncable = new Set(changes.unsyncable.map((entry) => `name ${entry.name}`));
    for (const key of this.problems().keys()) {
      if (key.startsWith('name ') && !unsyncable.has(key)) {
        this.clear(key);
      }
    }
    for (const entry of changes.unsyncable) {
      this.say(
        `name ${entry.name}`,
        `The cube ${entry.name} stays on this device: its name cannot name a document`,
      );
    }
    for (const entry of changes.writes) {
      this.write(account, entry);
    }
    for (const name of changes.deletes) {
      this.remove(account, name);
    }
  }

  private write(account: CloudAccount, entry: CubeMac): void {
    const cube = cloudCube({
      name: entry.name,
      mac: entry.mac,
      updatedMs: entry.updatedMs,
      device: this.settings.hostLabel(),
    });
    this.send(
      account,
      entry.name,
      entry.updatedMs,
      'could not be saved to your account',
      (backend) => backend.saveCube(account.uid, cube),
    );
  }

  private remove(account: CloudAccount, name: string): void {
    this.send(account, name, null, 'could not be removed from your account', (backend) =>
      backend.deleteCube(account.uid, name),
    );
  }

  /**
   * Sends a write (`written`, its `updatedMs`) or a deletion (null) of the document `name`, without
   * waiting for it: the server's confirmation updates what it is known to hold, and clears an
   * earlier refusal of that cube; a refusal is said.
   */
  private send(
    account: CloudAccount,
    name: string,
    written: number | null,
    failure: string,
    call: (backend: AccountBackend) => Promise<void>,
  ): void {
    const sent = this.sentOf(account.uid);
    sent.set(name, written);
    this.count(account.uid, 1);
    let promise: Promise<void>;
    try {
      promise = call(account.backend);
    } catch (error: unknown) {
      promise = Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    const settled = (): void => {
      this.count(account.uid, -1);
      if (sent.get(name) === written) {
        sent.delete(name);
      }
    };
    // The page shows what goes wrong with the account signed in, not with one signed out since.
    const current = (): boolean => this.auth.cloud()?.uid === account.uid;
    void promise.then(
      () => {
        settled();
        this.editState(account.uid, (kept) => {
          if (written === null) {
            Reflect.deleteProperty(kept.known, name);
          } else {
            kept.known[name] = written;
          }
        });
        if (current()) {
          this.clear(`write ${name}`);
        }
      },
      (error: unknown) => {
        settled();
        if (current()) {
          this.say(`write ${name}`, `The cube ${name} ${failure}: ${reason(error)}`);
        }
      },
    );
  }

  /** The writes of the account `uid` on their way. */
  private sentOf(uid: string): Map<string, number | null> {
    let sent = this.sent.get(uid);
    if (sent === undefined) {
      sent = new Map();
      this.sent.set(uid, sent);
    }
    return sent;
  }

  /** Counts `change` more writes of the account `uid` waiting for the server. */
  private count(uid: string, change: number): void {
    this.waiting.update((waiting) => new Map(waiting).set(uid, (waiting.get(uid) ?? 0) + change));
  }

  /**
   * Shows `message` as the last thing that went wrong, until it is cleared, and says it in the
   * console once per page load.
   */
  private say(key: string, message: string): void {
    this.problems.update((problems) => {
      const next = new Map(problems);
      next.delete(key);
      return next.set(key, `${message}.`);
    });
    if (!this.said.has(key)) {
      this.said.add(key);
      console.warn(`cubetrace: cloud: ${message}.`);
      this.diagnostics.record('error.app', { where: 'cubes', message: `${message}.` });
    }
  }

  /** What `key` was about is no longer wrong. */
  private clear(key: string): void {
    if (this.problems().has(key)) {
      this.problems.update((problems) => {
        const next = new Map(problems);
        next.delete(key);
        return next;
      });
    }
  }

  private state(uid: string): AccountState {
    return this.readState()[uid] ?? { mergedMs: null, known: {} };
  }

  /** Reads what the sync keeps, changes the account's part and writes it back at once. */
  private editState(uid: string, edit: (state: AccountState) => void): void {
    const state = this.readState();
    const account = (state[uid] ??= { mergedMs: null, known: {} });
    edit(account);
    try {
      this.globals.localStorage?.setItem(CUBE_SYNC_KEY, JSON.stringify(state));
    } catch {
      // Storage blocked: the next merge starts from what the server holds, which loses nothing but
      // the deletions made meanwhile on either side.
    }
  }

  private readState(): Record<string, AccountState> {
    try {
      const parsed: unknown = JSON.parse(this.globals.localStorage?.getItem(CUBE_SYNC_KEY) ?? '{}');
      return isKept(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

function isKept(value: unknown): value is Record<string, AccountState> {
  const isMap = (item: unknown): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item);
  return (
    isMap(value) &&
    Object.values(value).every((account: unknown) => {
      if (!isMap(account)) {
        return false;
      }
      const mergedMs = account['mergedMs'];
      const known = account['known'];
      return (
        (mergedMs === null || typeof mergedMs === 'number') &&
        isMap(known) &&
        Object.values(known).every((updatedMs) => typeof updatedMs === 'number')
      );
    })
  );
}

/** Why `error` happened, without its final period. */
function reason(error: unknown): string {
  return errorMessage(error).replace(/\.$/, '');
}
