// The session store of the browser (docs/PLAN.md, T1.6b): sessions and their attempts as the JSON
// files of docs/DATA-MODEL.md §5 in the origin private file system,
//
//   sessions/<sessionId>/session.json
//   sessions/<sessionId>/attempts/<index>/attempt.json      (index zero-padded to 4 digits)
//
// with the semantics that SessionStore documents and MemorySessionStore implements. Since T1.11
// (issue #12) a file is written under a temporary name and then moved over its own, so that a page
// that goes away in the middle of a write leaves the previous file, and a file that cannot be read
// is set aside and reported (`listProblems`) instead of failing every read that meets it. Since
// T2.0 the records are read with core's parseSession and parseAttempt: schema versions 1 and 2 are
// read, as version 2, and written as version 2; a version 1 file stays as it is until it is saved.
import type { AttemptRecord, SessionRecord, SessionStore } from '@cubetrace/core';
import { RecordError, parseAttempt, parseSession } from '@cubetrace/core';

import type { OpfsDirectoryHandle, OpfsFileHandle } from './opfs';
import { isNotFound } from './opfs';

/** The folder of every session, at the root of the file system. */
export const SESSIONS_FOLDER = 'sessions';
export const SESSION_FILE = 'session.json';
/** The folder of a session's attempts, inside the session's folder. */
export const ATTEMPTS_FOLDER = 'attempts';
export const ATTEMPT_FILE = 'attempt.json';

/**
 * What follows `<name>.` in the name of a temporary file of `name`: random base-36 digits and
 * `.tmp`, as in `session.json.k3v9x0qa.tmp` (see writeFile).
 */
const TEMPORARY_TAIL = /^[0-9a-z]+\.tmp$/;

/**
 * A file of the store that cannot be read: a `session.json` that is empty, not JSON, or not the
 * record of the session its folder names (the whole session is then left out of `listSessions`),
 * or such an `attempt.json` (that attempt is left out of `loadAttempts` and `exportSession`).
 */
export interface StorageProblem {
  /** The session the file belongs to: the name of its folder. */
  readonly sessionId: string;
  /** `session` for the session's `session.json`, `attempt` for one of its `attempt.json` files. */
  readonly kind: 'session' | 'attempt';
  /**
   * The file's path from the root: `sessions/<id>/session.json` or
   * `sessions/<id>/attempts/0002/attempt.json`.
   */
  readonly path: string;
  /**
   * What is wrong with it, worded to follow "<path> is": `empty`, `not JSON (<the parser's
   * message>)`, `not a valid session.json (<the field and what is wrong with it>)` or the same of
   * an attempt.json (a record that breaks the schema of its version, or of a version other than 1
   * and 2: core's parseSession and parseAttempt), `not the session.json of session <id>`, `not the
   * attempt.json of attempt <index> of session <id>`, or `not a file`.
   */
  readonly reason: string;
}

/** A store that says which of its files it could not read: {@link OpfsSessionStore}. */
export interface ProblemReporter {
  /** The unreadable files that the store's latest reads met (see OpfsSessionStore.listProblems). */
  listProblems(): Promise<StorageProblem[]>;
}

/** A problem as a sentence: `sessions/<id>/session.json is empty.` */
export function describeProblem(problem: StorageProblem): string {
  return `${problem.path} is ${problem.reason}.`;
}

/**
 * The folder of attempt `index` (docs/DATA-MODEL.md §5): 1-based, zero-padded to 4 digits, so that
 * the folders sort by index up to 9999 (`0001`, `0017`; `12345` from ten thousand on). Throws on
 * anything but a positive integer.
 */
export function attemptFolder(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`An attempt's index is a positive integer, got ${String(index)}.`);
  }
  return String(index).padStart(4, '0');
}

/**
 * The folder of session `id`: the id itself, which names the session (a UUID v4, as `createSession`
 * makes it). Null for an id that cannot name a folder (empty, `.`, `..`, or with a slash), which
 * the store treats as a session it does not have.
 */
function sessionFolder(id: string): string | null {
  return id === '' || id === '.' || id === '..' || /[/\\]/.test(id) ? null : id;
}

function sessionPath(sessionId: string): string {
  return `${SESSIONS_FOLDER}/${sessionId}/${SESSION_FILE}`;
}

function attemptPath(sessionId: string, folder: string): string {
  return `${SESSIONS_FOLDER}/${sessionId}/${ATTEMPTS_FOLDER}/${folder}/${ATTEMPT_FILE}`;
}

/** A record as the store writes it: indented JSON with a final newline, readable in a file viewer. */
function toJson(record: SessionRecord | AttemptRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * A {@link SessionStore} over the origin private file system: `navigator.storage.getDirectory()` in
 * the browser, or any directory handle with the same API (the tests use the in-memory fake of
 * fake-opfs.ts). Records are written as indented JSON and read back with `JSON.parse`, so they go in
 * and come out as copies, as the interface requires; a record is serialized when the call is made,
 * so changing it afterwards changes nothing. A session exists while its `session.json` does.
 *
 * Operations run one at a time, in the order they were called, so that a later save of a record
 * never lands before an earlier one. A file is replaced as a whole and in one step: it is written
 * under a temporary name next to it, `<name>.<random>.tmp`, which is then moved over it, so a page
 * that goes away during a write (a reload, a closed tab) leaves the previous file, or none, and at
 * worst a temporary file, which the reads ignore and remove when they see one.
 *
 * A file that does not hold the record its path names (empty, not JSON, not a valid record,
 * another record, or a folder) is unreadable: `listSessions` leaves out a session whose
 * `session.json` is unreadable, and `loadAttempts` and `exportSession` an unreadable
 * `attempt.json`; {@link listProblems} lists them. A failure to read (other than a missing file)
 * still rejects: the store sets aside only what it could read.
 * The operations on one session (`saveSession`, `saveAttempt`, `loadAttempts`, `deleteAttempt`,
 * `exportSession`) reject for a session whose `session.json` is unreadable, naming the file;
 * `deleteSession` removes it like any other.
 */
export class OpfsSessionStore implements SessionStore, ProblemReporter {
  readonly #root: Promise<OpfsDirectoryHandle>;
  /** The end of the last operation queued. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The unreadable files that the latest reads met, by path. */
  readonly #problems = new Map<string, StorageProblem>();

  /**
   * @param root the directory that holds `sessions/`: the origin private file system's root, or a
   *   promise of it (`navigator.storage.getDirectory()`). If the promise rejects, every operation
   *   rejects with its error.
   */
  constructor(root: OpfsDirectoryHandle | Promise<OpfsDirectoryHandle>) {
    this.#root = Promise.resolve(root);
    // Each operation handles it; not an unhandled rejection when nothing asks.
    this.#root.catch(() => undefined);
  }

  createSession(s: SessionRecord): Promise<void> {
    return this.#enqueue(() => {
      const folder = sessionFolder(s.id);
      if (folder === null) {
        throw new Error(`"${s.id}" cannot name a session folder.`);
      }
      const json = toJson(s);
      return async () => {
        const root = await this.#root;
        const sessions = await root.getDirectoryHandle(SESSIONS_FOLDER, { create: true });
        const existing = await folderIn(sessions, folder);
        if (existing !== null) {
          if (await hasFile(existing, SESSION_FILE)) {
            throw new Error(`Session ${s.id} exists already.`);
          }
          // A folder without session.json is not a session (a deletion cut short, say): the new
          // session starts empty, as it would in any store.
          await removeIn(sessions, folder);
        }
        const dir = await sessions.getDirectoryHandle(folder, { create: true });
        await writeFile(dir, SESSION_FILE, json);
      };
    });
  }

  saveSession(s: SessionRecord): Promise<void> {
    return this.#enqueue(() => {
      const json = toJson(s);
      return async () => {
        const { dir } = await this.#session(s.id);
        await writeFile(dir, SESSION_FILE, json);
      };
    });
  }

  saveAttempt(a: AttemptRecord): Promise<void> {
    return this.#enqueue(() => {
      const folder = attemptFolder(a.index);
      const json = toJson(a);
      return async () => {
        const { dir } = await this.#session(a.session);
        const attempts = await dir.getDirectoryHandle(ATTEMPTS_FOLDER, { create: true });
        const attempt = await attempts.getDirectoryHandle(folder, { create: true });
        await writeFile(attempt, ATTEMPT_FILE, json);
      };
    });
  }

  /** The readable sessions, newest first; the unreadable ones go to {@link listProblems}. */
  listSessions(): Promise<SessionRecord[]> {
    return this.#enqueue(() => async () => {
      const sessions = await this.#sessionsFolder();
      const records: SessionRecord[] = [];
      const problems: StorageProblem[] = [];
      if (sessions !== null) {
        for await (const entry of sessions.values()) {
          if (entry.kind !== 'directory') {
            continue;
          }
          const read = await readSession(entry, entry.name);
          if (read === null) {
            continue;
          }
          if ('problem' in read) {
            problems.push({
              sessionId: entry.name,
              kind: 'session',
              path: sessionPath(entry.name),
              reason: read.problem,
            });
          } else {
            records.push(read.record);
          }
        }
      }
      // What this listing found replaces what earlier reads found, but for the attempts of the
      // sessions it listed, which only a read of their attempts sees.
      const listed = new Set(records.map((record) => record.id));
      this.#forgetProblems((p) => p.kind === 'session' || !listed.has(p.sessionId));
      this.#noteProblems(problems);
      return records.sort((p, q) => q.createdMs - p.createdMs || p.id.localeCompare(q.id));
    });
  }

  /** The session's readable attempts; the unreadable ones go to {@link listProblems}. */
  loadAttempts(sessionId: string): Promise<AttemptRecord[]> {
    return this.#enqueue(() => async () => {
      const { dir } = await this.#session(sessionId);
      return this.#attemptsIn(dir, sessionId);
    });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.#enqueue(() => async () => {
      const folder = sessionFolder(sessionId);
      const sessions = folder === null ? null : await this.#sessionsFolder();
      if (folder !== null && sessions !== null) {
        await removeIn(sessions, folder);
        this.#forgetProblems((p) => p.sessionId === sessionId);
      }
    });
  }

  deleteAttempt(sessionId: string, index: number): Promise<void> {
    return this.#enqueue(() => async () => {
      const { dir } = await this.#session(sessionId);
      const attempts = await folderIn(dir, ATTEMPTS_FOLDER);
      if (attempts !== null && Number.isSafeInteger(index) && index >= 1) {
        const folder = attemptFolder(index);
        await removeIn(attempts, folder);
        this.#forgetProblems((p) => p.path === attemptPath(sessionId, folder));
      }
    });
  }

  /** The session with its readable attempts; the unreadable ones go to {@link listProblems}. */
  exportSession(sessionId: string): Promise<{ session: SessionRecord; attempts: AttemptRecord[] }> {
    return this.#enqueue(() => async () => {
      const { dir, session } = await this.#session(sessionId);
      return { session, attempts: await this.#attemptsIn(dir, sessionId) };
    });
  }

  /**
   * The unreadable files that the latest reads met, sorted by path: each unreadable `session.json`
   * found by the last `listSessions()`, and each unreadable `attempt.json` found by the last
   * `loadAttempts()` or `exportSession()` of its session (since that session was last listed). A
   * deleted session or attempt takes its problems with it. Queued like the other operations, so it
   * sees the reads called before it.
   */
  listProblems(): Promise<StorageProblem[]> {
    return this.#enqueue(
      () => () =>
        Promise.resolve(
          [...this.#problems.values()]
            .sort((p, q) => p.path.localeCompare(q.path))
            .map((problem) => ({ ...problem })),
        ),
    );
  }

  /**
   * Queues an operation after the previous ones. `prepare` runs now (it checks the arguments and
   * serializes the records) and returns the operation; what it throws becomes the rejection.
   */
  #enqueue<T>(prepare: () => () => Promise<T>): Promise<T> {
    let operation: () => Promise<T>;
    try {
      operation = prepare();
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** The `sessions` folder, or null before the first session. */
  async #sessionsFolder(): Promise<OpfsDirectoryHandle | null> {
    return folderIn(await this.#root, SESSIONS_FOLDER);
  }

  /**
   * A session's folder and record; rejects with "No session" if it has no session.json, and with
   * the problem (`sessions/<id>/session.json is empty.`) if that is unreadable.
   */
  async #session(id: string): Promise<{ dir: OpfsDirectoryHandle; session: SessionRecord }> {
    const folder = sessionFolder(id);
    const sessions = folder === null ? null : await this.#sessionsFolder();
    const dir = folder === null || sessions === null ? null : await folderIn(sessions, folder);
    const read = dir === null ? null : await readSession(dir, id);
    if (dir === null || read === null) {
      throw new Error(`No session ${id}.`);
    }
    if ('problem' in read) {
      throw new Error(
        describeProblem({
          sessionId: id,
          kind: 'session',
          path: sessionPath(id),
          reason: read.problem,
        }),
      );
    }
    return { dir, session: read.record };
  }

  /**
   * A session's readable attempts, sorted by index: the `attempt.json` of every numbered folder.
   * The unreadable ones replace the problems noted for this session's attempts.
   */
  async #attemptsIn(dir: OpfsDirectoryHandle, sessionId: string): Promise<AttemptRecord[]> {
    const attempts = await folderIn(dir, ATTEMPTS_FOLDER);
    const records: AttemptRecord[] = [];
    const problems: StorageProblem[] = [];
    if (attempts !== null) {
      for await (const entry of attempts.values()) {
        if (entry.kind !== 'directory' || !/^\d+$/.test(entry.name)) {
          continue;
        }
        const read = await readFile(entry, ATTEMPT_FILE);
        if (read === null) {
          continue;
        }
        const parsed =
          'problem' in read ? read : attemptRecord(read.text, sessionId, Number(entry.name));
        if ('problem' in parsed) {
          problems.push({
            sessionId,
            kind: 'attempt',
            path: attemptPath(sessionId, entry.name),
            reason: parsed.problem,
          });
        } else {
          records.push(parsed.record);
        }
      }
    }
    this.#forgetProblems((p) => p.kind === 'attempt' && p.sessionId === sessionId);
    this.#noteProblems(problems);
    return records.sort((p, q) => p.index - q.index);
  }

  #noteProblems(problems: readonly StorageProblem[]): void {
    for (const problem of problems) {
      this.#problems.set(problem.path, problem);
    }
  }

  #forgetProblems(which: (problem: StorageProblem) => boolean): void {
    for (const [path, problem] of this.#problems) {
      if (which(problem)) {
        this.#problems.delete(path);
      }
    }
  }
}

/** The folder `name` in `dir`, or null if it is missing. */
async function folderIn(
  dir: OpfsDirectoryHandle,
  name: string,
): Promise<OpfsDirectoryHandle | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/** Whether the file `name` is in `dir`. */
async function hasFile(dir: OpfsDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

/** Removes `name` from `dir` with everything in it; nothing if it is missing. */
async function removeIn(dir: OpfsDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch (error: unknown) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

/** A fresh temporary name for a write of the file `name`: `<name>.<8 base-36 digits>.tmp`. */
function temporaryName(name: string): string {
  const random = Math.floor(Math.random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0');
  return `${name}.${random}.tmp`;
}

/** Whether `entry` is the name of a temporary file of `name` (see temporaryName). */
function isTemporaryOf(entry: string, name: string): boolean {
  return entry.startsWith(`${name}.`) && TEMPORARY_TAIL.test(entry.slice(name.length + 1));
}

/**
 * Writes `text` as the whole content of the file `name` in `dir`, in one step: to a temporary file
 * next to it, which is closed and then moved over `name` (`FileSystemFileHandle.move`, Chrome 111
 * and later), so that `name` holds its previous content until the move. A page that goes away
 * before the move leaves `name` as it was, and the temporary file, which the reads remove; a write
 * that fails removes it. Where the handle has no `move()`, the file is written in place, as before
 * T1.11: Chrome swaps a stream's content in on `close()`, but a file made for the write stays
 * empty if the page goes away first.
 */
async function writeFile(dir: OpfsDirectoryHandle, name: string, text: string): Promise<void> {
  const temporary = temporaryName(name);
  const file = await dir.getFileHandle(temporary, { create: true });
  if (file.move === undefined) {
    await removeIn(dir, temporary);
    await writeText(await dir.getFileHandle(name, { create: true }), text);
    return;
  }
  try {
    await writeText(file, text);
    await file.move(name);
  } catch (error: unknown) {
    await dir.removeEntry(temporary).catch(() => undefined);
    throw error;
  }
}

/** Replaces the content of `file` with `text` through a writable stream. */
async function writeText(file: OpfsFileHandle, text: string): Promise<void> {
  const writable = await file.createWritable();
  try {
    await writable.write(text);
  } catch (error: unknown) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
  await writable.close();
}

/**
 * The file `name` in `dir`: its text, null if it is missing, or why it cannot be read (empty, or a
 * folder). On the way it removes the temporary files of `name` that it sees in `dir`: the store's
 * operations never overlap, so these are left by writes cut short. A failure to read `dir` or the
 * file (other than its absence) rejects, failing the operation, rather than calling the file
 * unreadable: the store only sets aside what it has read.
 */
async function readFile(
  dir: OpfsDirectoryHandle,
  name: string,
): Promise<{ text: string } | { problem: string } | null> {
  let file: OpfsDirectoryHandle | OpfsFileHandle | null = null;
  const temporary: string[] = [];
  try {
    for await (const entry of dir.values()) {
      if (entry.name === name) {
        file = entry;
      } else if (entry.kind === 'file' && isTemporaryOf(entry.name, name)) {
        temporary.push(entry.name);
      }
    }
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null; // The folder went away meanwhile.
    }
    throw error;
  }
  for (const entry of temporary) {
    // Best effort: it is ignored anyway, and Chrome refuses while another page writes it.
    await dir.removeEntry(entry).catch(() => undefined);
  }
  if (file === null) {
    return null;
  }
  if (file.kind !== 'file') {
    return { problem: 'not a file' };
  }
  let text: string;
  try {
    text = await (await file.getFile()).text();
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  return text === '' ? { problem: 'empty' } : { text };
}

/**
 * The session.json in the folder `dir` of session `id`: its record, why it is unreadable, or null
 * if it is missing.
 */
async function readSession(
  dir: OpfsDirectoryHandle,
  id: string,
): Promise<{ record: SessionRecord } | { problem: string } | null> {
  const read = await readFile(dir, SESSION_FILE);
  return read === null || 'problem' in read ? read : sessionRecord(read.text, id);
}

/** `text` parsed as JSON, or why it is not JSON. */
function parse(text: string): { value: unknown } | { problem: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error: unknown) {
    return { problem: `not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * The record in `value` as `read` makes it (core's parseSession or parseAttempt), or why it is not
 * one: `not a valid session.json (summary.attempts is missing)`.
 */
function record<T>(
  value: unknown,
  read: (json: unknown) => T,
): { record: T } | { problem: string } {
  try {
    return { record: read(value) };
  } catch (error: unknown) {
    if (error instanceof RecordError) {
      return { problem: `not a valid ${error.file} (${error.detail})` };
    }
    throw error;
  }
}

/**
 * The record in the text of a session.json, of schema version 1 or 2, as version 2, checked to be
 * session `id`'s; or why it is not.
 */
function sessionRecord(text: string, id: string): { record: SessionRecord } | { problem: string } {
  const parsed = parse(text);
  if ('problem' in parsed) {
    return parsed;
  }
  const read = record(parsed.value, parseSession);
  if ('problem' in read || read.record.id === id) {
    return read;
  }
  return { problem: `not the session.json of session ${id}` };
}

/**
 * The record in the text of an attempt.json, of schema version 1 or 2, as version 2, checked to be
 * attempt `index` of `sessionId`; or why it is not.
 */
function attemptRecord(
  text: string,
  sessionId: string,
  index: number,
): { record: AttemptRecord } | { problem: string } {
  const parsed = parse(text);
  if ('problem' in parsed) {
    return parsed;
  }
  const read = record(parsed.value, parseAttempt);
  if ('problem' in read || (read.record.session === sessionId && read.record.index === index)) {
    return read;
  }
  return { problem: `not the attempt.json of attempt ${String(index)} of session ${sessionId}` };
}
