import { InjectionToken, inject } from '@angular/core';
import { attemptPath } from '@cubetrace/capture';
import type { VideoSegment } from '@cubetrace/core';
import type { CutClip, FileKind } from '@cubetrace/rtc';
import {
  SESSIONS_FOLDER,
  isNotFound,
  writeTextFile,
  type OpfsDirectoryHandle,
} from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';

/**
 * The folder at the root of the origin private file system where a camera device stages the clips
 * it cuts for a host (docs/PLAN.md T4.2): `camera-clips/sessions/<sessionId>/attempts/<index>/`, the
 * capture's own layout (`SaveClipParams.staging`), apart from the device's own sessions.
 */
export const STAGING_FOLDER = 'camera-clips';

/** The staged clips' index, in {@link STAGING_FOLDER}. */
export const STAGING_INDEX = 'index.json';

/** A staged clip older than this is deleted when the Camera page opens, ms (a day). */
export const STAGED_MAX_AGE_MS = 24 * 3_600_000;

/** A file of a staged clip, as `cut-done` lists it. */
export interface StagedFile {
  readonly name: string;
  readonly bytes: number;
  readonly kind: FileKind;
}

/**
 * A clip the camera device cut for a host and keeps until the host says what became of it
 * (`clip-ack`): the attempt it belongs to, the segment, the label the host gives the camera (its
 * files' first name), the window asked for, what the capture said of it, and its files, the frames
 * file first.
 */
export interface StagedClip {
  readonly session: string;
  readonly attempt: number;
  /** The attempt's `scrambleShown` on the host clock, which tells it from one begun again. */
  readonly scrambleShown: number;
  readonly segment: VideoSegment;
  readonly camera: string;
  /** When it was staged, on this device's clock. */
  readonly stagedMs: number;
  /** The window asked for, in the clock the cut was in: the device's own, as the host converted it. */
  readonly fromRemoteMs: number;
  readonly toRemoteMs: number;
  readonly clip: CutClip;
  readonly files: readonly StagedFile[];
}

/** The staged clips (docs/PLAN.md T4.2): their files and a small index, kept across reloads. */
export interface ClipStaging {
  /** The staged clips, the oldest first. */
  list(): Promise<StagedClip[]>;
  /** Adds a clip whose files the capture staged; one of the same attempt and segment is replaced. */
  add(clip: StagedClip): Promise<void>;
  /** Deletes a staged clip: its entry and its files. */
  remove(clip: StagedClip): Promise<void>;
  /** A staged file, to send: of attempt `attempt` of session `session`, named `name`. */
  read(session: string, attempt: number, name: string): Promise<Blob>;
  /** Replaces a staged file's content, in one step. */
  write(session: string, attempt: number, name: string, text: string): Promise<void>;
  /**
   * Deletes the clips staged before `beforeMs` and, when `keepSession` is given, those of every
   * other session, with their files, and the folders of sessions no clip is left of (but
   * `keepSession`'s, whose clip may be being staged now); resolves to how many clips went.
   */
  prune(beforeMs: number, keepSession: string | null): Promise<number>;
}

/** The version of the index's own format. */
const INDEX_SCHEMA = 1;

/** Whether two clips are of the same attempt and segment. */
export function sameSlot(
  p: Pick<StagedClip, 'session' | 'attempt' | 'segment'>,
  q: Pick<StagedClip, 'session' | 'attempt' | 'segment'>,
): boolean {
  return p.session === q.session && p.attempt === q.attempt && p.segment === q.segment;
}

/**
 * The staged clips in the origin private file system: the files where the capture wrote them
 * ({@link STAGING_FOLDER}), and `index.json` beside them, written whole in one step as the records
 * are; an entry that is not well formed is left out. One operation at a time.
 */
export class OpfsClipStaging implements ClipStaging {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: () => Promise<OpfsDirectoryHandle>) {}

  list(): Promise<StagedClip[]> {
    return this.#serially(() => this.#read());
  }

  add(clip: StagedClip): Promise<void> {
    return this.#serially(async () => {
      const clips = (await this.#read()).filter((known) => !sameSlot(known, clip));
      await this.#write([...clips, clip]);
    });
  }

  remove(clip: StagedClip): Promise<void> {
    return this.#serially(async () => {
      const clips = await this.#read();
      await this.#write(
        clips.filter((known) => !(sameSlot(known, clip) && known.stagedMs === clip.stagedMs)),
      );
      await this.#removeFiles(clip);
    });
  }

  read(session: string, attempt: number, name: string): Promise<Blob> {
    return this.#serially(async () => {
      const dir = await this.#attemptDir(session, attempt, false);
      if (dir === null) {
        throw new DOMException(`${name} is not staged.`, 'NotFoundError');
      }
      const file = await (await dir.getFileHandle(name)).getFile();
      // The browser's is a File, sent as it is; a test's file system gives its bytes.
      return file instanceof Blob ? file : new Blob([await file.arrayBuffer()]);
    });
  }

  write(session: string, attempt: number, name: string, text: string): Promise<void> {
    return this.#serially(async () => {
      const dir = await this.#attemptDir(session, attempt, true);
      if (dir !== null) {
        await writeTextFile(dir, name, text);
      }
    });
  }

  prune(beforeMs: number, keepSession: string | null): Promise<number> {
    return this.#serially(async () => {
      const clips = await this.#read();
      const kept = clips.filter(
        (clip) =>
          clip.stagedMs >= beforeMs && (keepSession === null || clip.session === keepSession),
      );
      const gone = clips.filter((clip) => !kept.includes(clip));
      if (gone.length > 0) {
        await this.#write(kept);
      }
      for (const clip of gone) {
        await this.#removeFiles(clip);
      }
      // The folders of sessions no clip is left of: clips staged by a page that went before its
      // index was written, and the folders the files above leave empty.
      const sessions = await this.#folder(SESSIONS_FOLDER, false);
      if (sessions !== null) {
        const referenced = new Set(kept.map((clip) => clip.session));
        const names: string[] = [];
        for await (const entry of sessions.values()) {
          if (
            entry.kind === 'directory' &&
            !referenced.has(entry.name) &&
            entry.name !== keepSession
          ) {
            names.push(entry.name);
          }
        }
        for (const name of names) {
          await sessions.removeEntry(name, { recursive: true }).catch(() => undefined);
        }
      }
      return gone.length;
    });
  }

  async #read(): Promise<StagedClip[]> {
    const folder = await this.#staging();
    let text: string;
    try {
      text = await (await (await folder.getFileHandle(STAGING_INDEX)).getFile()).text();
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const clips: unknown =
      typeof json === 'object' && json !== null ? Reflect.get(json, 'clips') : null;
    return Array.isArray(clips) ? (clips as unknown[]).filter(isStagedClip) : [];
  }

  async #write(clips: readonly StagedClip[]): Promise<void> {
    await writeTextFile(
      await this.#staging(),
      STAGING_INDEX,
      `${JSON.stringify({ schema: INDEX_SCHEMA, clips })}\n`,
    );
  }

  async #removeFiles(clip: StagedClip): Promise<void> {
    const dir = await this.#attemptDir(clip.session, clip.attempt, false);
    for (const file of clip.files) {
      await dir?.removeEntry(file.name).catch(() => undefined);
    }
  }

  #staging(): Promise<OpfsDirectoryHandle> {
    return this.root().then((root) => root.getDirectoryHandle(STAGING_FOLDER, { create: true }));
  }

  async #folder(name: string, create: boolean): Promise<OpfsDirectoryHandle | null> {
    try {
      return await (await this.#staging()).getDirectoryHandle(name, { create });
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /** The folder of a staged clip's attempt (`attemptPath`, under the staging folder). */
  async #attemptDir(
    session: string,
    attempt: number,
    create: boolean,
  ): Promise<OpfsDirectoryHandle | null> {
    let dir = await this.#staging();
    try {
      for (const name of attemptPath(session, attempt)) {
        dir = await dir.getDirectoryHandle(name, { create });
      }
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
    return dir;
  }

  #serially<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** Whether `value` is a staged clip as the index writes one. */
function isStagedClip(value: unknown): value is StagedClip {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const field = (key: string): unknown => Reflect.get(value, key);
  const files = field('files');
  const clip = field('clip');
  return (
    typeof field('session') === 'string' &&
    typeof field('attempt') === 'number' &&
    typeof field('scrambleShown') === 'number' &&
    (field('segment') === 'scramble' || field('segment') === 'solve') &&
    typeof field('camera') === 'string' &&
    typeof field('stagedMs') === 'number' &&
    typeof field('fromRemoteMs') === 'number' &&
    typeof field('toRemoteMs') === 'number' &&
    typeof clip === 'object' &&
    clip !== null &&
    Array.isArray(files) &&
    (files as unknown[]).every(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        typeof Reflect.get(file, 'name') === 'string' &&
        typeof Reflect.get(file, 'bytes') === 'number' &&
        (Reflect.get(file, 'kind') === 'mp4' || Reflect.get(file, 'kind') === 'frames'),
    )
  );
}

/** The staged clips in `navigator.storage.getDirectory()`; the unit tests give one over a fake. */
export const CLIP_STAGING = new InjectionToken<ClipStaging>('CLIP_STAGING', {
  providedIn: 'root',
  factory: () => {
    const navigator = inject(BROWSER_GLOBALS).navigator;
    return new OpfsClipStaging(() => {
      const storage = navigator?.storage;
      if (typeof storage?.getDirectory !== 'function') {
        return Promise.reject(new Error('this browser has no origin private file system.'));
      }
      return storage.getDirectory();
    });
  },
});
