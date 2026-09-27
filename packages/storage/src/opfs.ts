// The part of the File System API that the session store and the clip writer (packages/capture)
// use, as structural types: the browser's origin private file system
// (`navigator.storage.getDirectory()`) satisfies them, and so does the in-memory fake of
// fake-opfs.ts, which the tests run them against in Node.

/** The part of `FileSystemWritableFileStream` the store and the clip writer use. */
export interface OpfsWritable {
  /** Text is written as UTF-8. */
  write(data: string | BufferSource): Promise<void>;
  /**
   * Replaces the file's content with what was written (Chrome writes to a swap file until then).
   */
  close(): Promise<void>;
  /** Discards what was written; the file keeps its previous content. */
  abort(reason?: unknown): Promise<void>;
}

/**
 * The part of `FileSystemSyncAccessHandle` the clip writer uses: a file's bytes read and written in
 * place, synchronously (Chrome 108 and later), in dedicated workers only. Chrome writes straight
 * into the file (no swap file, unlike a writable stream), and the handle locks the file until
 * `close()`.
 */
export interface OpfsSyncAccessHandle {
  /** Writes `data` at byte `at` (default 0) and returns the number of bytes written. */
  write(data: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  /** Persists what was written. */
  flush(): void;
  close(): void;
}

/** The part of `FileSystemFileHandle` the store and the clip writer use. */
export interface OpfsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<OpfsWritable>;
  /**
   * An access handle on the file (`FileSystemSyncAccessHandle`), where Chrome has one: in dedicated
   * workers, not on the window. Rejects with `NoModificationAllowedError` while a writable stream
   * or another access handle is open on the file.
   */
  createSyncAccessHandle?(): Promise<OpfsSyncAccessHandle>;
  /**
   * Renames the file within its directory, replacing a file that has the new name in one step, and
   * the handle takes the new name (Chrome 111 and later; missing before). Chrome rejects with
   * `NoModificationAllowedError` while a writable stream on the file is open, with
   * `InvalidModificationError` if the new name is a directory's, and with `NotFoundError` if the
   * file is gone.
   */
  move?(newName: string): Promise<void>;
}

/** The part of `FileSystemDirectoryHandle` the store uses. */
export interface OpfsDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  /** Rejects with a `NotFoundError` if it is missing and `create` is not set. */
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  /** Rejects with a `NotFoundError` if it is missing and `create` is not set. */
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  /** Rejects with a `NotFoundError` if it is missing. */
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<OpfsDirectoryHandle | OpfsFileHandle>;
}

/** A navigator whose storage has an origin private file system. */
export interface OpfsNavigator {
  readonly storage: { getDirectory(): Promise<OpfsDirectoryHandle> };
}

/**
 * Whether `navigator` offers the origin private file system (`navigator.storage.getDirectory`).
 * Chrome has it on every platform the app supports; where it is missing, the app keeps sessions in
 * memory and says so.
 */
export function opfsAvailable(navigator: unknown): navigator is OpfsNavigator {
  const storage = member(navigator, 'storage');
  return typeof member(storage, 'getDirectory') === 'function';
}

/** Whether `error` is the `NotFoundError` DOMException the File System API rejects with. */
export function isNotFound(error: unknown): boolean {
  return member(error, 'name') === 'NotFoundError';
}

function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (Reflect.get(value, key) as unknown) : null;
}
