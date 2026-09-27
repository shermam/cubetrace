// An in-memory origin private file system, for tests in Node (docs/PLAN.md, T1.6b): directories and
// files with the part of the File System API that OpfsSessionStore uses, and the errors Chrome
// rejects with (NotFoundError, TypeMismatchError, InvalidModificationError, TypeError for a bad
// name). The real one is exercised by the end-to-end tests in Chromium.
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

/** An async iterator over a copy of `items`, as a directory handle's `values()` returns. */
function iterate<T>(items: readonly T[]): AsyncIterableIterator<T> {
  let next = 0;
  return {
    next: () =>
      Promise.resolve(
        next < items.length
          ? { done: false, value: items[next++] }
          : { done: true, value: undefined },
      ),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** A file: its text, replaced as a whole when a writable stream closes. */
export class FakeFileHandle implements OpfsFileHandle {
  readonly kind = 'file';
  #text = '';
  /** Writable streams opened and not yet closed or aborted. */
  #open = 0;
  /** While set, every `write()` of a stream on this file rejects with it (a full disk, say). */
  failWritesWith: Error | null = null;

  constructor(readonly name: string) {}

  /** The file's content (for tests). */
  get text(): string {
    return this.#text;
  }

  /** Streams opened on this file and not closed yet (for tests). */
  get openWritables(): number {
    return this.#open;
  }

  getFile(): Promise<{ readonly name: string; readonly size: number; text(): Promise<string> }> {
    const text = this.#text;
    return Promise.resolve({
      name: this.name,
      size: new TextEncoder().encode(text).length,
      text: () => Promise.resolve(text),
    });
  }

  /**
   * A stream that starts empty (Chrome's default, `keepExistingData: false`), appends what is
   * written and replaces the file's content on `close()`; `abort()` leaves the file as it was.
   */
  createWritable(): Promise<OpfsWritable> {
    let written = '';
    let state: 'open' | 'closed' = 'open';
    this.#open++;
    const finish = (): void => {
      if (state === 'closed') {
        throw new TypeError('The stream is closed.');
      }
      state = 'closed';
      this.#open--;
    };
    const commit = (): void => {
      this.#text = written;
    };
    return Promise.resolve({
      write: (data: string) =>
        settle(() => {
          if (state === 'closed') {
            throw new TypeError('The stream is closed.');
          }
          if (this.failWritesWith !== null) {
            throw this.failWritesWith;
          }
          written += data;
        }),
      close: () =>
        settle(() => {
          finish();
          commit();
        }),
      abort: () =>
        settle(() => {
          if (state === 'open') {
            finish();
          }
        }),
    });
  }
}

/** A directory of files and directories, kept in memory. */
export class FakeDirectoryHandle implements OpfsDirectoryHandle {
  readonly kind = 'directory';
  readonly #entries = new Map<string, FakeDirectoryHandle | FakeFileHandle>();

  /** The root of an origin private file system has an empty name. */
  constructor(readonly name = '') {}

  getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeDirectoryHandle> {
    return settle(() => {
      checkName(name);
      const entry = this.#entries.get(name);
      if (entry === undefined) {
        if (options.create !== true) {
          throw domError('NotFoundError', `No directory "${name}" in "${this.name}".`);
        }
        const created = new FakeDirectoryHandle(name);
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
    return settle(() => {
      checkName(name);
      const entry = this.#entries.get(name);
      if (entry === undefined) {
        if (options.create !== true) {
          throw domError('NotFoundError', `No file "${name}" in "${this.name}".`);
        }
        const created = new FakeFileHandle(name);
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
    return settle(() => {
      checkName(name);
      const entry = this.#entries.get(name);
      if (entry === undefined) {
        throw domError('NotFoundError', `No entry "${name}" in "${this.name}".`);
      }
      if (entry.kind === 'directory' && entry.#entries.size > 0 && options.recursive !== true) {
        throw domError('InvalidModificationError', `The directory "${name}" is not empty.`);
      }
      this.#entries.delete(name);
    });
  }

  /** The entries, in the order they were made (Chrome's order is unspecified too). */
  values(): AsyncIterableIterator<FakeDirectoryHandle | FakeFileHandle> {
    return iterate([...this.#entries.values()]);
  }

  keys(): AsyncIterableIterator<string> {
    return iterate([...this.#entries.keys()]);
  }

  entries(): AsyncIterableIterator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    return iterate([...this.#entries.entries()]);
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
}
