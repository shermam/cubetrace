import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  attemptDocumentId,
  attemptFiles,
  cloudAttempt,
  cloudAttemptFields,
  cloudSession,
  isSimulated,
  parseCloudAttempt,
  parseCloudSession,
  pendingUpload,
  type AttemptRecord,
  type CloudAttempt,
  type CloudAttemptFields,
  type CloudSession,
  type CloudUpload,
  type SessionRecord,
  type SessionStore,
} from '@cubetrace/core';
import { recordJson, type ProblemReporter } from '@cubetrace/storage';

import type { AccountBackend, CloudDocument, CloudListing } from '../auth/account-backend';
import { AuthService, type CloudAccount } from '../auth/auth-service';
import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { SESSION_STORAGE } from '../session/session-storage';
import { errorMessage } from '../shared/error-message';

/**
 * The `localStorage` key of what the index keeps on this device, by account: the sessions of this
 * device that are in the account's index, and when the server last confirmed a write.
 */
export const SESSION_INDEX_KEY = 'cubetrace.sessionIndex';

/**
 * The most documents one catch-up writes (a session with all its attempts, in one batch, counts
 * them all): the rest waits for the next page load signed in.
 */
export const CATCH_UP_DOCUMENTS = 300;

/** What the index keeps on this device for an account. */
interface AccountState {
  /**
   * The sessions of this device whose documents, and their attempts', are all written for the
   * account (sent, or waiting in Firestore's cache): the catch-up passes them by. A session leaves it
   * when it changes while the account is not signed in on this device.
   */
  sessions: string[];
  /** When the server last confirmed a write of the index from this device: host clock, ms. */
  lastSyncMs: number | null;
}

/** Adds a line to a session's notes (`SessionService.addNote`). */
export type NoteWriter = (sessionId: string, line: string) => Promise<void>;

/** A document of the index as read, with whether it holds writes the server has not confirmed. */
export interface CloudEntry<T> {
  readonly id: string;
  readonly document: T;
  readonly pending: boolean;
}

/** A document of the index that could not be read, and why (a document of another version). */
export interface CloudProblem {
  readonly id: string;
  readonly reason: string;
}

/** What a query of the index found. */
export interface CloudRead<T> {
  readonly entries: readonly CloudEntry<T>[];
  readonly unreadable: readonly CloudProblem[];
  /** From this device's cache: the server was out of reach. */
  readonly fromCache: boolean;
}

/** The session store as `SessionService` uses it: the OPFS one also lists what it could not read. */
export type TrackedStore = SessionStore & Partial<ProblemReporter>;

/**
 * The session index in Firestore (docs/PLAN.md T3.1, docs/DATA-MODEL.md §10): while an account is
 * signed in, every session saved through the store that `track` returns goes to `sessions/{id}` and
 * every attempt to `sessions/{id}/attempts/{index}`, with the account as their owner, through
 * Firestore's persistent cache: the saves never wait for them, and offline they wait in the cache,
 * across reloads. An attempt's document is created with its `upload`, all pending; its later writes
 * (a clip attached, the catch-up) leave `upload` out, since from then on the upload's functions
 * (T3.2) keep it and the rules refuse the app's changes to it. Demo sessions (a simulated cube)
 * never go. A session saved while no account is signed in, created then or changed, is written
 * whole by the catch-up that runs when an account signs in, or starts signed in: the sessions of
 * this device that are not in its index (`SESSION_INDEX_KEY` says which are), the oldest first, a
 * session and its attempts in one batch, at most {@link CATCH_UP_DOCUMENTS} documents at a time. A
 * write that the server refuses is said once per session and page load: in `failures`, in the
 * console, and in the session's notes (`cloud: …`); none is thrown. Deleting a session deletes this
 * device's copy only: its documents stay, as the uploads will. It also reads the index for the
 * Sessions page, a session's page and the QA view.
 */
@Injectable({ providedIn: 'root' })
export class SessionIndexService {
  private readonly auth = inject(AuthService);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly files = inject(ATTEMPT_FILES);
  /** The store itself, for the catch-up's reads: they need no tracking. */
  private readonly store = inject(SESSION_STORAGE).store;

  private readonly failuresSignal = signal<ReadonlyMap<string, string>>(new Map());
  /** The writes of this page load that the server has not confirmed, by session. */
  private readonly waitingSignal = signal<ReadonlyMap<string, number>>(new Map());
  private readonly lastSyncSignal = signal<number | null>(null);
  private readonly writtenSignal = signal<ReadonlySet<string>>(new Set());
  private readonly catchingUpSignal = signal(false);

  /**
   * Why the documents of a session could not be written to the index, by session id: the first
   * refusal of each session in this page load.
   */
  readonly failures = this.failuresSignal.asReadonly();
  /** The writes of this page load that the server has not confirmed yet: offline, they wait. */
  readonly unconfirmed = computed(() =>
    [...this.waitingSignal().values()].reduce((sum, count) => sum + count, 0),
  );
  /** The sessions with writes of this page load that the server has not confirmed yet. */
  readonly waiting = computed(() => new Set(this.waitingSignal().keys()));
  /**
   * When the server last confirmed a write of the index from this device for the account signed in
   * (host clock, kept across page loads); null before the first, and without an account.
   */
  readonly lastSync = this.lastSyncSignal.asReadonly();
  /** The sessions whose documents this page load wrote for the account signed in (sent or waiting). */
  readonly written = this.writtenSignal.asReadonly();
  /** A catch-up is under way. */
  readonly catchingUp = this.catchingUpSignal.asReadonly();

  /** The latest record of each session that went through the tracked store: an attempt's device. */
  private readonly sessions = new Map<string, SessionRecord>();
  /**
   * The index's operations, one after the other, so that the documents of a session are written in
   * the order of its saves, after the catch-up; never rejects.
   */
  private queue: Promise<void> = Promise.resolve();
  /** The sessions whose refusal this page load has said. */
  private readonly reported = new Set<string>();
  /**
   * The attempts' documents that exist in the account's index as far as this page load knows
   * (`<session>/<index>`): written with their `upload`, or found by the catch-up. The next writes of
   * these leave `upload` alone.
   */
  private readonly created = new Set<string>();
  /** The account whose catch-up this page load has run: once per account and page load. */
  private caughtUp: string | null = null;
  private note: NoteWriter = () => Promise.resolve();

  constructor() {
    effect(() => {
      const account = this.auth.cloud();
      untracked(() => {
        this.onAccount(account);
      });
    });
  }

  /**
   * `store` with the index's writes after its own: what it saves goes to the index while an account
   * is signed in (not awaited: the store's promises settle with its own writes). `note` adds the line
   * of a refusal to the session's notes.
   */
  track(store: TrackedStore, note: NoteWriter): TrackedStore {
    this.note = note;
    const tracked: TrackedStore = {
      createSession: async (session) => {
        await store.createSession(session);
        this.sessionSaved(session, true);
      },
      saveSession: async (session) => {
        await store.saveSession(session);
        this.sessionSaved(session, false);
      },
      saveAttempt: async (attempt) => {
        await store.saveAttempt(attempt);
        this.attemptSaved(attempt);
      },
      deleteAttempt: async (sessionId, index) => {
        await store.deleteAttempt(sessionId, index);
        this.attemptDeleted(sessionId, index);
      },
      deleteSession: async (sessionId) => {
        await store.deleteSession(sessionId);
        this.sessionDeleted(sessionId);
      },
      listSessions: () => store.listSessions(),
      loadAttempts: (sessionId) => store.loadAttempts(sessionId),
      exportSession: async (sessionId) => {
        const exported = await store.exportSession(sessionId);
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, exported.session);
        }
        return exported;
      },
    };
    const listProblems = store.listProblems?.bind(store);
    if (listProblems !== undefined) {
      tracked.listProblems = listProblems;
    }
    return tracked;
  }

  /** Resolves once the index's operations queued so far are done (their writes sent, not confirmed). */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  /**
   * The newest `limit` sessions of the account's index, newest first, with the documents that could
   * not be read apart; null without an account. Rejects when the query fails.
   */
  async cloudSessions(limit: number): Promise<CloudRead<CloudSession> | null> {
    const account = this.auth.cloud();
    if (account === null) {
      return null;
    }
    return readAll(await account.backend.listSessions(account.uid, limit), parseCloudSession);
  }

  /**
   * Session `sessionId` of the account's index; null without an account, or when the index has no
   * such session of the account. Rejects when the read fails (or an unreadable document, naming why).
   */
  async cloudSession(sessionId: string): Promise<CloudEntry<CloudSession> | null> {
    const account = this.auth.cloud();
    if (account === null) {
      return null;
    }
    let found: CloudDocument | null;
    try {
      found = await account.backend.getSession(sessionId);
    } catch (error: unknown) {
      // The rules refuse to read a document that is not there, as one of another account.
      if (codeOf(error) === 'permission-denied') {
        return null;
      }
      throw error;
    }
    return found === null
      ? null
      : { id: found.id, document: parseCloudSession(found.data), pending: found.pending };
  }

  /** The attempts of session `sessionId` in the account's index, by index; null without an account. */
  async cloudAttempts(sessionId: string): Promise<CloudRead<CloudAttempt> | null> {
    const account = this.auth.cloud();
    if (account === null) {
      return null;
    }
    return readAll(await account.backend.listAttempts(account.uid, sessionId), parseCloudAttempt);
  }

  private onAccount(account: CloudAccount | null): void {
    if (account === null) {
      this.caughtUp = null;
      this.writtenSignal.set(new Set());
      this.lastSyncSignal.set(null);
      return;
    }
    this.lastSyncSignal.set(this.state(account.uid).lastSyncMs);
    if (this.caughtUp !== account.uid) {
      this.caughtUp = account.uid;
      this.writtenSignal.set(new Set());
      this.created.clear();
      this.enqueue(() => this.catchUp(account));
    }
  }

  private sessionSaved(session: SessionRecord, created: boolean): void {
    this.sessions.set(session.id, session);
    if (isSimulated(session)) {
      return;
    }
    this.enqueue(() => {
      const account = this.auth.cloud();
      if (account === null) {
        this.changedSignedOut(session.id);
        return;
      }
      this.send(account, session.id, 'the session could not be indexed', (backend) =>
        backend.saveSessionIndex(cloudSession(session, account.uid)),
      );
      this.markWritten(session.id);
      if (created) {
        // Created signed in: everything it will hold goes to the index as it comes.
        this.keepIndexed(account.uid, session.id);
      }
    });
  }

  private attemptSaved(attempt: AttemptRecord): void {
    this.enqueue(async () => {
      const session = await this.sessionOf(attempt.session);
      if (session === null || isSimulated(session)) {
        return;
      }
      if (this.auth.cloud() === null) {
        this.changedSignedOut(session.id);
        return;
      }
      // Its document is created with its upload, all pending; written again (a clip attached), it
      // leaves the upload to the functions.
      const key = attemptKey(session.id, attempt.index);
      const upload = this.created.has(key) ? null : await this.upload(attempt);
      const account = this.auth.cloud();
      if (account === null) {
        this.changedSignedOut(session.id);
        return;
      }
      const owner = account.uid;
      const document: CloudAttempt | CloudAttemptFields =
        upload === null
          ? cloudAttemptFields({ attempt, session, owner })
          : cloudAttempt({ attempt, session, owner, upload });
      this.created.add(key);
      const what = `attempt ${String(attempt.index)} could not be indexed`;
      if (this.isIndexed(account.uid, session.id)) {
        this.send(account, session.id, what, (backend) => backend.saveAttemptIndex(document));
      } else {
        // Its session may not be in the index yet (created before the sign-in): both in one batch,
        // since the rules take an attempt only under its owner's session.
        this.send(account, session.id, what, (backend) =>
          backend.saveSessionIndex(cloudSession(session, account.uid), [document]),
        );
        this.markWritten(session.id);
      }
    });
  }

  private attemptDeleted(sessionId: string, index: number): void {
    this.enqueue(async () => {
      const session = await this.sessionOf(sessionId);
      if (session === null || isSimulated(session)) {
        return;
      }
      const account = this.auth.cloud();
      this.created.delete(attemptKey(sessionId, index));
      if (account === null) {
        this.changedSignedOut(sessionId);
      } else if (this.isIndexed(account.uid, sessionId)) {
        // A session not in the index yet has no attempt there to delete (the rules refuse to delete a
        // document that is not there).
        this.send(
          account,
          sessionId,
          `attempt ${String(index)} could not be deleted from the index`,
          (backend) => backend.deleteAttemptIndex(sessionId, index),
        );
      }
    });
  }

  private sessionDeleted(sessionId: string): void {
    this.sessions.delete(sessionId);
    // This device's copy is gone; the index keeps its documents (and T3.3's uploads its files).
    this.editState((state) => {
      for (const account of Object.values(state)) {
        account.sessions = account.sessions.filter((id) => id !== sessionId);
      }
    });
  }

  /**
   * Writes the sessions of this device that are not in the account's index, the oldest first, each
   * with its attempts in one batch, until {@link CATCH_UP_DOCUMENTS} documents are written. It first
   * asks the index which of a session's attempts are there already (the server, or offline the
   * cache): those are written without their `upload`, which the functions may have changed; the
   * others are created with theirs. A session whose attempts cannot be asked for waits for the next
   * catch-up.
   */
  private async catchUp(account: CloudAccount): Promise<void> {
    this.catchingUpSignal.set(true);
    try {
      const due = (await this.store.listSessions())
        .filter((session) => !isSimulated(session) && !this.isIndexed(account.uid, session.id))
        .reverse();
      let written = 0;
      for (const listed of due) {
        const attempts = await this.store.loadAttempts(listed.id);
        if (written > 0 && written + 1 + attempts.length > CATCH_UP_DOCUMENTS) {
          break;
        }
        const session = this.sessions.get(listed.id) ?? listed;
        this.sessions.set(session.id, session);
        let there: ReadonlySet<string>;
        try {
          there = new Set(
            (await account.backend.listAttempts(account.uid, session.id)).documents.map(
              (document) => document.id,
            ),
          );
        } catch (error: unknown) {
          console.warn(
            `cubetrace: cloud: the attempts of session ${session.id} in the index could not be read; it waits for the next catch-up: ${errorMessage(error)}`,
          );
          continue;
        }
        const owner = account.uid;
        const documents: (CloudAttempt | CloudAttemptFields)[] = [];
        for (const attempt of attempts) {
          documents.push(
            there.has(attemptDocumentId(attempt.index))
              ? cloudAttemptFields({ attempt, session, owner })
              : cloudAttempt({ attempt, session, owner, upload: await this.upload(attempt) }),
          );
        }
        if (this.auth.cloud()?.uid !== account.uid) {
          return;
        }
        for (const attempt of attempts) {
          this.created.add(attemptKey(session.id, attempt.index));
        }
        this.send(account, session.id, 'the session could not be indexed', (backend) =>
          backend.saveSessionIndex(cloudSession(session, account.uid), documents),
        );
        this.markWritten(session.id);
        this.keepIndexed(account.uid, session.id);
        written += 1 + attempts.length;
      }
    } catch (error: unknown) {
      console.warn(
        `cubetrace: cloud: the sessions of this device could not be listed for the index: ${errorMessage(error)}`,
      );
    } finally {
      this.catchingUpSignal.set(false);
    }
  }

  /**
   * `attempt`'s upload as the index first writes it: every file of its folder pending, with its size
   * on this device (attempt.json as the store writes it, a clip's MP4 from its record, a frames file
   * from the file system; one that cannot be read is left out). The upload queue (T3.3) fills it.
   */
  private async upload(attempt: AttemptRecord): Promise<CloudUpload> {
    const bytes: Record<string, number> = {};
    for (const file of attemptFiles(attempt)) {
      const size =
        file === 'attempt.json'
          ? new TextEncoder().encode(recordJson(attempt)).byteLength
          : (attempt.video.find((clip) => clip.file === file)?.bytes ??
            (await this.fileSize(attempt, file)));
      if (size !== null && size > 0) {
        bytes[file] = size;
      }
    }
    return pendingUpload(bytes);
  }

  private async fileSize(attempt: AttemptRecord, name: string): Promise<number | null> {
    try {
      return (await this.files.read(attempt.session, attempt.index, name)).size;
    } catch {
      return null;
    }
  }

  /** The session's latest record: the one saved last, else the store's; null when it is gone. */
  private async sessionOf(sessionId: string): Promise<SessionRecord | null> {
    const known = this.sessions.get(sessionId);
    if (known !== undefined) {
      return known;
    }
    try {
      const { session } = await this.store.exportSession(sessionId);
      this.sessions.set(sessionId, session);
      return session;
    } catch {
      return null;
    }
  }

  /**
   * Sends a write of the index, without waiting for it: the server's confirmation sets `lastSync`,
   * and a refusal is said (`failed`), `what` (`attempt 3 could not be indexed`) with the reason.
   */
  private send(
    account: CloudAccount,
    sessionId: string,
    what: string,
    write: (backend: AccountBackend) => Promise<void>,
  ): void {
    this.wait(sessionId, 1);
    let sent: Promise<void>;
    try {
      sent = write(account.backend);
    } catch (error: unknown) {
      sent = Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
    void sent.then(
      () => {
        this.wait(sessionId, -1);
        this.confirmed(account.uid);
      },
      (error: unknown) => {
        this.wait(sessionId, -1);
        this.failed(account.uid, sessionId, `${what}: ${errorMessage(error).replace(/\.$/, '')}.`);
      },
    );
  }

  private wait(sessionId: string, change: 1 | -1): void {
    this.waitingSignal.update((waiting) => {
      const next = new Map(waiting);
      const count = (next.get(sessionId) ?? 0) + change;
      if (count > 0) {
        next.set(sessionId, count);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }

  private confirmed(uid: string): void {
    const now = hostNow(this.globals);
    this.editState((state) => {
      (state[uid] ??= { sessions: [], lastSyncMs: null }).lastSyncMs = now;
    });
    if (this.auth.cloud()?.uid === uid) {
      this.lastSyncSignal.set(now);
    }
  }

  /**
   * A write of session `sessionId` was refused: the session is not all in the index, so its next
   * writes carry its own document and the next catch-up writes it whole; and it is said once per
   * session and page load, with why.
   */
  private failed(uid: string, sessionId: string, message: string): void {
    // What of the session's attempts is in the index is not known any more.
    for (const key of [...this.created]) {
      if (key.startsWith(`${sessionId}/`)) {
        this.created.delete(key);
      }
    }
    if (this.writtenSignal().has(sessionId)) {
      this.writtenSignal.update((written) => {
        const next = new Set(written);
        next.delete(sessionId);
        return next;
      });
    }
    this.editState((state) => {
      const account = state[uid] as AccountState | undefined;
      if (account !== undefined) {
        account.sessions = account.sessions.filter((id) => id !== sessionId);
      }
    });
    if (this.reported.has(sessionId)) {
      return;
    }
    this.reported.add(sessionId);
    this.failuresSignal.update((failures) => new Map(failures).set(sessionId, message));
    console.warn(`cubetrace: cloud: ${message}`);
    const line = `cloud: ${message}`;
    if (this.sessions.get(sessionId)?.notes.split('\n').includes(line) !== true) {
      void this.note(sessionId, line).catch(() => undefined);
    }
  }

  /** Whether all of session `sessionId` is in the account's index (or on its way there). */
  private isIndexed(uid: string, sessionId: string): boolean {
    return this.writtenSignal().has(sessionId) || this.state(uid).sessions.includes(sessionId);
  }

  private markWritten(sessionId: string): void {
    if (!this.writtenSignal().has(sessionId)) {
      this.writtenSignal.update((written) => new Set(written).add(sessionId));
    }
  }

  private keepIndexed(uid: string, sessionId: string): void {
    this.editState((state) => {
      const account = (state[uid] ??= { sessions: [], lastSyncMs: null });
      if (!account.sessions.includes(sessionId)) {
        account.sessions.push(sessionId);
      }
    });
  }

  /**
   * A session changed while no account is signed in on this device (or before the remembered one
   * has loaded): no account's index has all of it now, so the next catch-up writes it whole.
   */
  private changedSignedOut(sessionId: string): void {
    this.editState((state) => {
      for (const account of Object.values(state)) {
        account.sessions = account.sessions.filter((id) => id !== sessionId);
      }
    });
  }

  private enqueue(operation: () => void | Promise<void>): void {
    this.queue = this.queue.then(operation).catch((error: unknown) => {
      console.warn(`cubetrace: cloud: ${errorMessage(error)}`);
    });
  }

  private state(uid: string): AccountState {
    return this.readState()[uid] ?? { sessions: [], lastSyncMs: null };
  }

  /**
   * Reads what the index keeps, changes it and writes it back, at once (other tabs write it too);
   * nothing is written when nothing changed, so that a device never signed in keeps nothing.
   */
  private editState(edit: (state: Record<string, AccountState>) => void): void {
    const state = this.readState();
    const before = JSON.stringify(state);
    edit(state);
    const after = JSON.stringify(state);
    if (after === before) {
      return;
    }
    try {
      this.globals.localStorage?.setItem(SESSION_INDEX_KEY, after);
    } catch {
      // Storage blocked: the next catch-up writes these sessions again, which changes nothing.
    }
  }

  private readState(): Record<string, AccountState> {
    try {
      const parsed: unknown = JSON.parse(
        this.globals.localStorage?.getItem(SESSION_INDEX_KEY) ?? '{}',
      );
      return isKept(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

/** An attempt's document, as `created` names it. */
function attemptKey(sessionId: string, index: number): string {
  return `${sessionId}/${String(index)}`;
}

function isKept(value: unknown): value is Record<string, AccountState> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (account: unknown) =>
        typeof account === 'object' &&
        account !== null &&
        Array.isArray(Reflect.get(account, 'sessions')) &&
        (Reflect.get(account, 'lastSyncMs') === null ||
          typeof Reflect.get(account, 'lastSyncMs') === 'number'),
    )
  );
}

/** The documents of `listing` read with `parse`, those it refuses apart with why. */
function readAll<T>(listing: CloudListing, parse: (json: unknown) => T): CloudRead<T> {
  const entries: CloudEntry<T>[] = [];
  const unreadable: CloudProblem[] = [];
  for (const { id, data, pending } of listing.documents) {
    try {
      entries.push({ id, document: parse(data), pending });
    } catch (error: unknown) {
      unreadable.push({ id, reason: errorMessage(error) });
    }
  }
  return { entries, unreadable, fromCache: listing.fromCache };
}

/** A Firebase error's code (`permission-denied`), if it has one. */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}
