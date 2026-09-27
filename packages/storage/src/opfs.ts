// The part of the File System API that the session store uses, as structural types: the browser's
// origin private file system (`navigator.storage.getDirectory()`) satisfies them, and so does the
// in-memory fake of fake-opfs.ts, which the tests run the store against in Node.

/** The part of `FileSystemWritableFileStream` the store uses. */
export interface OpfsWritable {
  write(data: string): Promise<void>;
  /** Replaces the file's content with what was written (Chrome writes to a swap file until then). */
  close(): Promise<void>;
  /** Discards what was written; the file keeps its previous content. */
  abort(reason?: unknown): Promise<void>;
}

/** The part of `FileSystemFileHandle` the store uses. */
export interface OpfsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<OpfsWritable>;
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
