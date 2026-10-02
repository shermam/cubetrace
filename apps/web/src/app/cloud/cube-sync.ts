import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { cloudCube, parseCloudCube } from '@cubetrace/core';

import type { AccountBackend, CloudListing } from '../auth/account-backend';
import { AuthService, type CloudAccount } from '../auth/auth-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
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
 * offline they wait there, across reloads. What goes wrong is said once (the console and `error`),
 * never thrown. Signed out it does nothing, and the list is this device's as before.
 */
@Injectable({ providedIn: 'root' })
export class CubeSyncService {
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private readonly globals = inject(BROWSER_GLOBALS);

  private readonly mergingSignal = signal(false);
  private readonly offlineSignal = signal(false);
  private readonly lastMergeSignal = signal<number | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  private readonly unconfirmedSignal = signal(0);

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
  /** What went wrong last in this page load (a read, a write refused); null when nothing did. */
  readonly error = this.errorSignal.asReadonly();
  /** The writes of this page load that the server has not confirmed yet: offline, they wait. */
  readonly unconfirmed = this.unconfirmedSignal.asReadonly();

  /** The account merged in this page load: from then on, each change of the list goes to it. */
  private merged: string | null = null;
  /** The account whose merge is under way. */
  private mergingUid: string | null = null;
  /**
   * The writes sent and not confirmed yet, by document name: the `updatedMs` written, or null for a
   * deletion. With what the server is known to hold, what it will hold.
   */
  private sent = new Map<string, number | null>();
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
      this.sent = new Map();
      this.skipped = new Set();
      this.lastMergeSignal.set(null);
      this.offlineSignal.set(false);
      this.errorSignal.set(null);
      return;
    }
    this.lastMergeSignal.set(this.state(account.uid).mergedMs);
    if (this.merged !== account.uid && this.mergingUid !== account.uid) {
      this.merged = null;
      this.sent = new Map();
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
    this.errorSignal.set(null);
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
    for (const [name, written] of this.sent) {
      if (written === null) {
        known.delete(name);
      } else {
        known.set(name, written);
      }
    }
    const changes = cubeChanges(this.settings.cubeMacs(), known, this.skipped);
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
   * waiting for it: the server's confirmation updates what it is known to hold; a refusal is said.
   */
  private send(
    account: CloudAccount,
    name: string,
    written: number | null,
    failure: string,
    call: (backend: AccountBackend) => Promise<void>,
  ): void {
    const sent = this.sent;
    sent.set(name, written);
    this.unconfirmedSignal.update((count) => count + 1);
    let promise: Promise<void>;
    try {
      promise = call(account.backend);
    } catch (error: unknown) {
      promise = Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    const settled = (): void => {
      this.unconfirmedSignal.update((count) => count - 1);
      if (sent.get(name) === written) {
        sent.delete(name);
      }
    };
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
      },
      (error: unknown) => {
        settled();
        this.say(`write ${name}`, `The cube ${name} ${failure}: ${reason(error)}`);
      },
    );
  }

  /** Shows `message` as the last thing that went wrong, and says it in the console once. */
  private say(key: string, message: string): void {
    this.errorSignal.set(`${message}.`);
    if (!this.said.has(key)) {
      this.said.add(key);
      console.warn(`cubetrace: cloud: ${message}.`);
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
