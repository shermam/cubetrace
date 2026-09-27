// The session store of the browser (docs/PLAN.md, T1.6b): sessions and their attempts as the JSON
// files of docs/DATA-MODEL.md §5 in the origin private file system,
//
//   sessions/<sessionId>/session.json
//   sessions/<sessionId>/attempts/<index>/attempt.json      (index zero-padded to 4 digits)
//
// with the semantics that SessionStore documents and MemorySessionStore implements.
import type { AttemptRecord, SessionRecord, SessionStore } from '@cubetrace/core';

import type { OpfsDirectoryHandle } from './opfs';
import { isNotFound } from './opfs';

/** The folder of every session, at the root of the file system. */
export const SESSIONS_FOLDER = 'sessions';
export const SESSION_FILE = 'session.json';
/** The folder of a session's attempts, inside the session's folder. */
export const ATTEMPTS_FOLDER = 'attempts';
export const ATTEMPT_FILE = 'attempt.json';

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
 * never lands before an earlier one. A file is replaced as a whole: Chrome writes to a swap file and
 * swaps it in on `close()`. A file that does not hold the record its path names (a `session.json`
 * whose `id` is not its folder's, say) makes the reads that meet it reject, naming the file.
 */
export class OpfsSessionStore implements SessionStore {
  readonly #root: Promise<OpfsDirectoryHandle>;
  /** The end of the last operation queued. */
  #queue: Promise<unknown> = Promise.resolve();

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

  listSessions(): Promise<SessionRecord[]> {
    return this.#enqueue(() => async () => {
      const sessions = await this.#sessionsFolder();
      const records: SessionRecord[] = [];
      if (sessions === null) {
        return records;
      }
      for await (const entry of sessions.values()) {
        if (entry.kind !== 'directory') {
          continue;
        }
        const path = `${SESSIONS_FOLDER}/${entry.name}/${SESSION_FILE}`;
        const json = await readText(entry, SESSION_FILE);
        if (json !== undefined) {
          records.push(sessionRecord(json, path, entry.name));
        }
      }
      return records.sort((p, q) => q.createdMs - p.createdMs || p.id.localeCompare(q.id));
    });
  }

  loadAttempts(sessionId: string): Promise<AttemptRecord[]> {
    return this.#enqueue(() => async () => {
      const { dir } = await this.#session(sessionId);
      return attemptsIn(dir, sessionId);
    });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.#enqueue(() => async () => {
      const folder = sessionFolder(sessionId);
      const sessions = folder === null ? null : await this.#sessionsFolder();
      if (folder !== null && sessions !== null) {
        await removeIn(sessions, folder);
      }
    });
  }

  deleteAttempt(sessionId: string, index: number): Promise<void> {
    return this.#enqueue(() => async () => {
      const { dir } = await this.#session(sessionId);
      const attempts = await folderIn(dir, ATTEMPTS_FOLDER);
      if (attempts !== null && Number.isSafeInteger(index) && index >= 1) {
        await removeIn(attempts, attemptFolder(index));
      }
    });
  }

  exportSession(sessionId: string): Promise<{ session: SessionRecord; attempts: AttemptRecord[] }> {
    return this.#enqueue(() => async () => {
      const { dir, session } = await this.#session(sessionId);
      return { session, attempts: await attemptsIn(dir, sessionId) };
    });
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

  /** A session's folder and record; rejects with "No session" if it has no session.json. */
  async #session(id: string): Promise<{ dir: OpfsDirectoryHandle; session: SessionRecord }> {
    const folder = sessionFolder(id);
    const sessions = folder === null ? null : await this.#sessionsFolder();
    const dir = folder === null || sessions === null ? null : await folderIn(sessions, folder);
    const json = dir === null ? undefined : await readText(dir, SESSION_FILE);
    if (dir === null || json === undefined) {
      throw new Error(`No session ${id}.`);
    }
    return { dir, session: sessionRecord(json, `${SESSIONS_FOLDER}/${id}/${SESSION_FILE}`, id) };
  }
}

/** A session's attempts, sorted by index: the `attempt.json` of every numbered folder. */
async function attemptsIn(dir: OpfsDirectoryHandle, sessionId: string): Promise<AttemptRecord[]> {
  const attempts = await folderIn(dir, ATTEMPTS_FOLDER);
  const records: AttemptRecord[] = [];
  if (attempts === null) {
    return records;
  }
  for await (const entry of attempts.values()) {
    if (entry.kind !== 'directory' || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const json = await readText(entry, ATTEMPT_FILE);
    if (json !== undefined) {
      const path = `${SESSIONS_FOLDER}/${sessionId}/${ATTEMPTS_FOLDER}/${entry.name}/${ATTEMPT_FILE}`;
      records.push(attemptRecord(json, path, sessionId, Number(entry.name)));
    }
  }
  return records.sort((p, q) => p.index - q.index);
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

/** The text of the file `name` in `dir`, or undefined if it is missing. */
async function readText(dir: OpfsDirectoryHandle, name: string): Promise<string | undefined> {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Writes `text` as the whole content of the file `name` in `dir`, made if missing. */
async function writeFile(dir: OpfsDirectoryHandle, name: string, text: string): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(text);
  } catch (error: unknown) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
  await writable.close();
}

/** `text` parsed as JSON; throws naming `path` if it is not JSON. */
function parse(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not JSON: ${reason}`, { cause: error });
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (Reflect.get(value, key) as unknown) : null;
}

/** The record in the session.json at `path`, checked to be session `id`'s. */
function sessionRecord(text: string, path: string, id: string): SessionRecord {
  const value = parse(text, path);
  if (!isSessionOf(value, id)) {
    throw new Error(`${path} is not the session.json of session ${id}.`);
  }
  return value;
}

function isSessionOf(value: unknown, id: string): value is SessionRecord {
  return (
    field(value, 'schema') === 1 &&
    field(value, 'id') === id &&
    typeof field(value, 'createdMs') === 'number'
  );
}

/** The record in the attempt.json at `path`, checked to be attempt `index` of `sessionId`. */
function attemptRecord(
  text: string,
  path: string,
  sessionId: string,
  index: number,
): AttemptRecord {
  const value = parse(text, path);
  if (!isAttemptOf(value, sessionId, index)) {
    throw new Error(
      `${path} is not the attempt.json of attempt ${String(index)} of session ${sessionId}.`,
    );
  }
  return value;
}

function isAttemptOf(value: unknown, sessionId: string, index: number): value is AttemptRecord {
  return (
    field(value, 'schema') === 1 &&
    field(value, 'session') === sessionId &&
    field(value, 'index') === index
  );
}
