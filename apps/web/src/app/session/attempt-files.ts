import { InjectionToken, inject } from '@angular/core';
import { ATTEMPTS_FOLDER, SESSIONS_FOLDER, attemptFolder } from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';

/**
 * The files of an attempt's folder (docs/DATA-MODEL.md §5) besides its record: its clips' MP4s and
 * frames files (T2.4), which the capture pipeline writes into the origin private file system.
 */
export interface AttemptFiles {
  /**
   * The file `name` of the folder of attempt `index` of session `sessionId`; rejects when it is
   * missing (a `NotFoundError`), or where the browser has no origin private file system.
   */
  read(sessionId: string, index: number, name: string): Promise<Blob>;
}

/** The attempts' files in `navigator.storage.getDirectory()`; the unit tests give a fake. */
export const ATTEMPT_FILES = new InjectionToken<AttemptFiles>('ATTEMPT_FILES', {
  providedIn: 'root',
  factory: () => {
    const navigator = inject(BROWSER_GLOBALS).navigator;
    return {
      async read(sessionId: string, index: number, name: string): Promise<Blob> {
        const storage = navigator?.storage;
        if (typeof storage?.getDirectory !== 'function') {
          throw new Error('this browser has no origin private file system.');
        }
        let dir = await storage.getDirectory();
        for (const folder of [SESSIONS_FOLDER, sessionId, ATTEMPTS_FOLDER, attemptFolder(index)]) {
          dir = await dir.getDirectoryHandle(folder);
        }
        return (await dir.getFileHandle(name)).getFile();
      },
    };
  },
});
