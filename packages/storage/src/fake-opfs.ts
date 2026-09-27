// An in-memory origin private file system, for tests in Node (docs/PLAN.md, T1.6b and T1.11):
// directories and files with the part of the File System API that OpfsSessionStore uses, and the
// errors Chromium 141 rejects with (NotFoundError, TypeMismatchError, InvalidModificationError,
// NoModificationAllowedError for an entry locked by an open writable stream, TypeError for a bad
// name). A test can also fill the disk (`failWritesWith`), play a Chrome without `move()`, and make
// the page go away in the middle of the store's work (`interruptAfter`). The real one is exercised
// by the end-to-end tests in Chromium.
import type { OpfsDirectoryHandle, OpfsFileHandle, OpfsWritable } from './opfs';

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

/** Chrome refuses these names with a TypeError. */
function checkName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new TypeError(`Name is not allowed: "${name}".`);
  }
}

/** A promise of `f()`'s result that rejects with what `f` throws, like an async function's. */
function settle<T>(f: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(f());
  });
}

/** Options of a fake file system, given to its root. */
export interface FakeOpfsOptions {
  /**
   * Whether file handles have `move()`, as in Chrome 111 and later (the default); false plays an
   * older Chrome.
   */
  readonly move?: boolean;
}

/**
 * What the handles of one file system share: its options, the full disk and the interruption (see
 * `FakeDirectoryHandle.interruptAfter`).
 */
class FakeSystem {
  readonly move: boolean;
  failWritesWith: Error | null = null;
  /** The operations that may still start before the interruption; null when none is planned. */
  #left: number | null = null;
  #interrupted = false;
  /** How to drop each writable stream that is open, as the end of its page drops it. */
  readonly #streams = new Set<() => void>();

  constructor(options: FakeOpfsOptions) {
    this.move = options.move ?? true;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  interruptAfter(operations: number): void {
    if (!Number.isSafeInteger(operations) || operations < 0) {
      throw new RangeError(`A number of operations is a whole number, got ${String(operations)}.`);
    }
    this.#left = operations;
    this.#interrupted = false;
  }

  resume(): void {
    for (const drop of this.#streams) {
      drop();
    }
    this.#left = null;
    this.#interrupted = false;
  }

  /** Registers an open stream: `drop` closes it without keeping what was written. */
  opened(drop: () => void): void {
    this.#streams.add(drop);
  }

  /** The stream that `drop` belongs to is closed. */
  closed(drop: () => void): void {
    this.#streams.delete(drop);
  }

  /**
   * One operation: `f` runs now and the promise settles with its result (or rejects with what it
   * throws), like an async function's. Once the interruption has come, nothing runs and the promise
   * never settles.
   */
  run<T>(f: () => T): Promise<T> {
    if (this.#left === 0) {
      this.#interrupted = true;
    }
    if (this.#interrupted) {
      return new Promise<T>(() => undefined);
    }
    if (this.#left !== null) {
      this.#left--;
    }
    return settle(f);
  }
}

/** An async iterator over a copy of `items`, as a directory handle's `values()` returns. */
function iterate<T>(system: FakeSystem, items: readonly T[]): AsyncIterableIterator<T> {
  let next = 0;
  return {
    next: () =>
      system.run<IteratorResult<T>>(() =>
        next < items.length
          ? { done: false, value: items[next++] }
          : { done: true, value: undefined },
      ),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** What a file needs from the directory that holds it. */
interface FakeFolder {
  readonly system: FakeSystem;
  /**
   * Makes `file` the folder's entry `newName`, as `FileSystemFileHandle.move` does; throws what
   * Chrome rejects with.
   */
  rename(file: FakeFileHandle, newName: string): void;
}

/** A file: its text, replaced as a whole when a writable stream closes. Made by its directory. */
export class FakeFileHandle implements OpfsFileHandle {
  readonly kind = 'file';
  /** Renames it within its directory (`OpfsFileHandle.move`); missing with `{ move: false }`. */
  readonly move?: (newName: string) => Promise<void>;
  #name: string;
  #text = '';
  /** Writable streams opened and not closed or aborted yet: while there is one, it is locked. */
  #open = 0;
  readonly #system: FakeSystem;

  constructor(name: string, folder: FakeFolder) {
    this.#name = name;
    this.#system = folder.system;
    if (folder.system.move) {
      this.move = (newName: string) =>
        this.#system.run(() => {
          folder.rename(this, newName);
          this.#name = newName;
        });
    }
  }

  /** Its name, which `move` changes, as Chrome's handles do. */
  get name(): string {
    return this.#name;
  }

  /** The file's content (for tests). */
  get text(): string {
    return this.#text;
  }

  /** Streams opened on this file and not closed yet (for tests). */
  get openWritables(): number {
    return this.#open;
  }

  getFile(): Promise<{ readonly name: string; readonly size: number; text(): Promise<string> }> {
    return this.#system.run(() => {
      const text = this.#text;
      return {
        name: this.#name,
        size: new TextEncoder().encode(text).length,
        text: () => this.#system.run(() => text),
      };
    });
  }

  /**
   * A stream that starts empty (Chrome's default, `keepExistingData: false`), appends what is
   * written and replaces the file's content on `close()`; `abort()` leaves the file as it was.
   */
  createWritable(): Promise<OpfsWritable> {
    const system = this.#system;
    return system.run(() => {
      let written = '';
      let state: 'open' | 'closed' = 'open';
      this.#open++;
      const drop = (): void => {
        state = 'closed';
        this.#open--;
        system.closed(drop);
      };
      system.opened(drop);
      const finish = (): void => {
        if (state === 'closed') {
          throw new TypeError('The stream is closed.');
        }
        drop();
      };
      return {
        write: (data: string) =>
          system.run(() => {
            if (state === 'closed') {
              throw new TypeError('The stream is closed.');
            }
            if (system.failWritesWith !== null) {
              throw system.failWritesWith;
            }
            written += data;
          }),
        close: () =>
          system.run(() => {
            finish();
            this.#text = written;
          }),
        abort: () =>
          system.run(() => {
            if (state === 'open') {
              finish();
            }
          }),
      };
    });
  }
}

/** A directory of files and directories, kept in memory. */
export class FakeDirectoryHandle implements OpfsDirectoryHandle {
  readonly kind = 'directory';
  readonly #entries = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  /** Shared by every handle of the file system: a directory made in another takes its system. */
  #system: FakeSystem;

  /** The root of a new file system; its name is empty, as the origin private file system's is. */
  constructor(
    readonly name = '',
    options: FakeOpfsOptions = {},
  ) {
    this.#system = new FakeSystem(options);
  }

  /**
   * Plays the page going away (a reload, a closed tab) after `operations` more operations on this
   * file system, by any of its handles, streams and iterators: those run, and from the next one on
   * nothing runs and no promise settles, as if the page had gone at that moment. What was done
   * stays: a file that was created is there, a stream that was not closed has changed nothing.
   */
  interruptAfter(operations: number): void {
    this.#system.interruptAfter(operations);
  }

  /** Whether the interruption has come: an operation was cut off. */
  get interrupted(): boolean {
    return this.#system.interrupted;
  }

  /**
   * A new page on the same files: operations run again, while those that were cut off never settle,
   * and the streams that the old page left open are gone without their content, their locks
   * released, as Chrome drops them with their page.
   */
  resume(): void {
    this.#system.resume();
  }

  /** While set, every `write()` of a stream in this file system rejects with it (a full disk). */
  get failWritesWith(): Error | null {
    return this.#system.failWritesWith;
  }

  set failWritesWith(error: Error | null) {
    this.#system.failWritesWith = error;
  }

  getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeDirectoryHandle> {
    return this.#system.run(() => {
      checkName(name);
      const entry = this.#entries.get(name);
      if (entry === undefined) {
        if (options.create !== true) {
          throw domError('NotFoundError', `No directory "${name}" in "${this.name}".`);
        }
        const created = new FakeDirectoryHandle(name);
        created.#system = this.#system;
        this.#entries.set(name, created);
        return created;
      }
      if (entry.kind !== 'directory') {
        throw domError('TypeMismatchError', `"${name}" is a file, not a directory.`);
      }
      return entry;
    });
  }

  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    return this.#system.run(() => {
      checkName(name);
      const entry = this.#entries.get(name);
      if (entry === undefined) {
        if (options.create !== true) {
          throw domError('NotFoundError', `No file "${name}" in "${this.name}".`);
        }
        const created = new FakeFileHandle(name, {
          system: this.#system,
          rename: (file, newName) => {
            this.#rename(file, newName);
          },
        });
        this.#entries.set(name, created);
        return created;
      }
      if (entry.kind !== 'file') {
        throw domError('TypeMismatchError', `"${name}" is a directory, not a file.`);
      }
      return entry;
    });
  }

  removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    return this.#system.run(() => {
      checkName(name);
      const entry = this.#entries.get(name);
      if (entry === undefined) {
        throw domError('NotFoundError', `No entry "${name}" in "${this.name}".`);
      }
      if (entry.kind === 'directory' && entry.#entries.size > 0 && options.recursive !== true) {
        throw domError('InvalidModificationError', `The directory "${name}" is not empty.`);
      }
      if (locked(entry)) {
        throw domError('NoModificationAllowedError', `"${name}" is locked by a writable stream.`);
      }
      this.#entries.delete(name);
    });
  }

  /** The entries, in the order they were made (Chrome's order is unspecified too). */
  values(): AsyncIterableIterator<FakeDirectoryHandle | FakeFileHandle> {
    return iterate(this.#system, [...this.#entries.values()]);
  }

  keys(): AsyncIterableIterator<string> {
    return iterate(this.#system, [...this.#entries.keys()]);
  }

  entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    return iterate(this.#system, [...this.#entries.entries()]);
  }

  /**
   * Makes the file at `path` below this directory hold `text`, making the folders on the way (for
   * tests: files that the store did not write, such as an empty `session.json`).
   */
  async plant(path: string, text: string): Promise<void> {
    const [name, ...rest] = path.split('/');
    if (rest.length > 0) {
      await (await this.getDirectoryHandle(name, { create: true })).plant(rest.join('/'), text);
      return;
    }
    const writable = await (await this.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  }

  /** Every file below this directory, by its path from here (`sessions/<id>/session.json`). */
  files(): Map<string, FakeFileHandle> {
    const files = new Map<string, FakeFileHandle>();
    for (const [name, entry] of this.#entries) {
      if (entry.kind === 'file') {
        files.set(name, entry);
      } else {
        for (const [path, file] of entry.files()) {
          files.set(`${name}/${path}`, file);
        }
      }
    }
    return files;
  }

  /** Every directory below this one, by its path from here (for tests). */
  directories(): string[] {
    const paths: string[] = [];
    for (const [name, entry] of this.#entries) {
      if (entry.kind === 'directory') {
        paths.push(name, ...entry.directories().map((path) => `${name}/${path}`));
      }
    }
    return paths;
  }

  /** `FileSystemFileHandle.move(newName)` of `file`, one of this directory's files. */
  #rename(file: FakeFileHandle, newName: string): void {
    checkName(newName);
    if (this.#entries.get(file.name) !== file) {
      throw domError('NotFoundError', `No file "${file.name}" in "${this.name}".`);
    }
    if (locked(file)) {
      throw domError(
        'NoModificationAllowedError',
        `"${file.name}" is locked by a writable stream.`,
      );
    }
    if (newName === file.name) {
      return;
    }
    const existing = this.#entries.get(newName);
    if (existing?.kind === 'directory') {
      throw domError('InvalidModificationError', `"${newName}" is a directory.`);
    }
    if (existing !== undefined && locked(existing)) {
      throw domError('NoModificationAllowedError', `"${newName}" is locked by a writable stream.`);
    }
    this.#entries.delete(newName);
    this.#entries.delete(file.name);
    this.#entries.set(newName, file);
  }
}

/**
 * Whether `entry`, or a file below it, has a writable stream open: Chrome then refuses to move or
 * remove it.
 */
function locked(entry: FakeDirectoryHandle | FakeFileHandle): boolean {
  return entry.kind === 'file'
    ? entry.openWritables > 0
    : [...entry.files().values()].some((file) => file.openWritables > 0);
}
