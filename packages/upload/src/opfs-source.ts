// The device's side of the queue in the browser (UploadSource): the sessions through the session
// store, the clips' files and uploads.json in the origin private file system, and the deletion of an
// uploaded clip, whose record the app updates first (`markClipsGone`: SessionService, so that the
// timer's own copy of the record says so too).
import type { SessionStore } from '@cubetrace/core';
import {
  ATTEMPTS_FOLDER,
  SESSIONS_FOLDER,
  attemptFolder,
  isNotFound,
  isTemporaryOf,
  writeTextFile,
  type OpfsDirectoryHandle,
  type OpfsFileHandle,
} from '@cubetrace/storage';

import type { AttemptRef, UploadSource } from './ports';
import { UPLOADS_FILE } from './state';

export interface OpfsUploadSourceOptions {
  /** The root of the origin private file system (`navigator.storage.getDirectory()`), or its promise. */
  readonly root: OpfsDirectoryHandle | Promise<OpfsDirectoryHandle>;
  /** The session store over that root: the app's own, so that its operations stay in one queue. */
  readonly store: SessionStore;
  /**
   * Sets `local: false` on the clips `files` of the attempt `ref` in its record and saves it;
   * resolves to false when the attempt is not there any more (the app: SessionService).
   */
  readonly markClipsGone: (ref: AttemptRef, files: readonly string[]) => Promise<boolean>;
  /** Whether the attempt's record is final: no clip of it is still to come (the app: RecordWatch). */
  readonly settled?: (sessionId: string, index: number) => boolean;
}

/** {@link UploadSource} over the origin private file system and the session store. */
export class OpfsUploadSource implements UploadSource {
  readonly #root: Promise<OpfsDirectoryHandle>;
  readonly #store: SessionStore;
  readonly #markClipsGone: OpfsUploadSourceOptions['markClipsGone'];
  readonly #settled: (sessionId: string, index: number) => boolean;

  constructor(options: OpfsUploadSourceOptions) {
    this.#root = Promise.resolve(options.root);
    this.#root.catch(() => undefined);
    this.#store = options.store;
    this.#markClipsGone = options.markClipsGone;
    this.#settled = options.settled ?? (() => true);
  }

  listSessions(): ReturnType<UploadSource['listSessions']> {
    return this.#store.listSessions();
  }

  async loadSession(sessionId: string): ReturnType<UploadSource['loadSession']> {
    try {
      return await this.#store.exportSession(sessionId);
    } catch (error: unknown) {
      // The store's own words for a session it does not have.
      if (error instanceof Error && error.message === `No session ${sessionId}.`) {
        return null;
      }
      throw error;
    }
  }

  async fileSize(sessionId: string, index: number, name: string): Promise<number | null> {
    const file = await this.#file(sessionId, index, name);
    return file === null ? null : (await file.getFile()).size;
  }

  async readFile(sessionId: string, index: number, name: string): Promise<Blob> {
    const handle = await this.#file(sessionId, index, name);
    if (handle === null) {
      throw new DOMException(`No file ${name} in attempt ${String(index)}.`, 'NotFoundError');
    }
    const file = await handle.getFile();
    // In the browser it is a File: XMLHttpRequest sends it from the disk, without a copy in memory.
    return file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
  }

  async removeClips(ref: AttemptRef, files: readonly string[]): Promise<boolean> {
    if (!(await this.#markClipsGone(ref, files))) {
      return false;
    }
    const dir = await this.#attemptDir(ref.session, ref.index);
    for (const name of files) {
      try {
        await dir?.removeEntry(name);
      } catch (error: unknown) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
    return true;
  }

  settled(sessionId: string, index: number): boolean {
    return this.#settled(sessionId, index);
  }

  /** uploads.json's text; null when there is none. Temporary files of writes cut short are removed. */
  async readState(): Promise<string | null> {
    const root = await this.#root;
    let found: OpfsFileHandle | null = null;
    for await (const entry of root.values()) {
      if (entry.kind !== 'file') {
        continue;
      }
      if (entry.name === UPLOADS_FILE) {
        found = entry;
      } else if (isTemporaryOf(entry.name, UPLOADS_FILE)) {
        await root.removeEntry(entry.name).catch(() => undefined);
      }
    }
    if (found === null) {
      return null;
    }
    const text = await (await found.getFile()).text();
    return text === '' ? null : text;
  }

  async writeState(text: string): Promise<void> {
    await writeTextFile(await this.#root, UPLOADS_FILE, text);
  }

  /** The folder of attempt `index` of the session; null when it is not there. */
  async #attemptDir(sessionId: string, index: number): Promise<OpfsDirectoryHandle | null> {
    let dir = await this.#root;
    try {
      for (const name of [SESSIONS_FOLDER, sessionId, ATTEMPTS_FOLDER, attemptFolder(index)]) {
        dir = await dir.getDirectoryHandle(name);
      }
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
    return dir;
  }

  async #file(sessionId: string, index: number, name: string): Promise<OpfsFileHandle | null> {
    const dir = await this.#attemptDir(sessionId, index);
    if (dir === null) {
      return null;
    }
    try {
      return await dir.getFileHandle(name);
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
}
