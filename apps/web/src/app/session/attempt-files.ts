import { InjectionToken, inject } from '@angular/core';
import {
  ATTEMPTS_FOLDER,
  SESSIONS_FOLDER,
  attemptFolder,
  isNotFound,
  writeAttemptFile,
  type FileContent,
  type OpfsDirectoryHandle,
} from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';

/**
 * The files of an attempt's folder (docs/DATA-MODEL.md §5) besides its record: its clips' MP4s and
 * frames files (T2.4), which the capture pipeline writes into the origin private file system, its
 * gyro file (T3.7), which the session service writes through `write`, and a remote camera's clips
 * (T4.2), which the host writes through `write` as they come from the phone.
 */
export interface AttemptFiles {
  /**
   * The file `name` of the folder of attempt `index` of session `sessionId`; rejects when it is
   * missing (a `NotFoundError`), or where the browser has no origin private file system.
   */
  read(sessionId: string, index: number, name: string): Promise<Blob>;
  /**
   * Writes `content` (text, or bytes in parts: a remote camera's MP4) as the whole file `name` of the
   * folder of attempt `index` of session `sessionId`, in one step, as the records are written
   * (@cubetrace/storage's `writeAttemptFile`); rejects when the session's folder is missing, or where
   * the browser has no origin private file system.
   */
  write(sessionId: string, index: number, name: string, content: FileContent): Promise<void>;
  /**
   * The names of the files in each attempt's folder of session `sessionId`, by the attempt's index:
   * what this device holds of them (T4.2a: a clip's MP4 the upload queue deleted by policy is gone
   * from its folder, and its record does not say so); empty when the session has no attempts;
   * rejects where the browser has no origin private file system. Absent from the stand-ins of tests
   * that know nothing of the folders.
   */
  list?(sessionId: string): Promise<ReadonlyMap<number, ReadonlySet<string>>>;
}

/** The attempts' files in `navigator.storage.getDirectory()`; the unit tests give a fake. */
export const ATTEMPT_FILES = new InjectionToken<AttemptFiles>('ATTEMPT_FILES', {
  providedIn: 'root',
  factory: () => {
    const navigator = inject(BROWSER_GLOBALS).navigator;
    const root = (): Promise<OpfsDirectoryHandle> => {
      const storage = navigator?.storage;
      if (typeof storage?.getDirectory !== 'function') {
        throw new Error('this browser has no origin private file system.');
      }
      return storage.getDirectory();
    };
    return {
      async read(sessionId: string, index: number, name: string): Promise<Blob> {
        let dir = await root();
        for (const folder of [SESSIONS_FOLDER, sessionId, ATTEMPTS_FOLDER, attemptFolder(index)]) {
          dir = await dir.getDirectoryHandle(folder);
        }
        return (await dir.getFileHandle(name)).getFile() as Promise<Blob>;
      },
      async write(
        sessionId: string,
        index: number,
        name: string,
        content: FileContent,
      ): Promise<void> {
        await writeAttemptFile(await root(), sessionId, index, name, content);
      },
      async list(sessionId: string): Promise<ReadonlyMap<number, ReadonlySet<string>>> {
        let dir = await root();
        try {
          for (const folder of [SESSIONS_FOLDER, sessionId, ATTEMPTS_FOLDER]) {
            dir = await dir.getDirectoryHandle(folder);
          }
        } catch (error: unknown) {
          if (isNotFound(error)) {
            return new Map();
          }
          throw error;
        }
        const found = new Map<number, ReadonlySet<string>>();
        for await (const entry of dir.values()) {
          if (entry.kind !== 'directory' || !/^\d+$/.test(entry.name)) {
            continue;
          }
          const names = new Set<string>();
          for await (const file of entry.values()) {
            if (file.kind === 'file') {
              names.add(file.name);
            }
          }
          found.set(Number(entry.name), names);
        }
        return found;
      },
    };
  },
});
