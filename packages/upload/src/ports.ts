// What the queue works through (docs/ARCHITECTURE.md, "Uploads"): the device's sessions and files,
// the cloud (the index and the two functions), the PUT, and the rest of the device (its clock, its
// storage, its network). The app gives the browser's; the tests give fakes (testing.ts).
import type { AttemptRecord, CloudUpload, SessionRecord } from '@cubetrace/core';

import type { ConfirmRequest, ConfirmResult, SignRequest, SignedFile } from './api';
import type { ConnectionInfo } from './network';

/** An attempt as the queue names it to the device: its session, its index and its scramble's time. */
export interface AttemptRef {
  readonly session: string;
  readonly index: number;
  /** `events.scrambleShown`, which tells it from an attempt begun again with the same index. */
  readonly scrambleShown: number;
}

/** The device's sessions and their files: the session store and the origin private file system. */
export interface UploadSource {
  /** Every session, newest first (`SessionStore.listSessions`). */
  listSessions(): Promise<SessionRecord[]>;
  /** A session with its attempts (`SessionStore.exportSession`); null when it is not there. */
  loadSession(
    sessionId: string,
  ): Promise<{ session: SessionRecord; attempts: AttemptRecord[] } | null>;
  /** The size of the file `name` of attempt `index`'s folder; null when it is not there. */
  fileSize(sessionId: string, index: number, name: string): Promise<number | null>;
  /** The file `name` of attempt `index`'s folder, to send as it is. */
  readFile(sessionId: string, index: number, name: string): Promise<Blob>;
  /**
   * Deletes the clips' MP4s `files` of the attempt `ref` from the device, once its record says that
   * they are not there any more (`video[].local` false); false, deleting nothing, when the attempt
   * is gone.
   */
  removeClips(ref: AttemptRef, files: readonly string[]): Promise<boolean>;
  /**
   * Whether attempt `index` of the session is final: no clip of it is still to come from the
   * recording (T2.4), which saves each clip a second after its segment and adds it to the record.
   */
  settled(sessionId: string, index: number): boolean;
  /** uploads.json's text; null when there is none. */
  readState(): Promise<string | null>;
  /** Replaces uploads.json, in one step. */
  writeState(text: string): Promise<void>;
}

/** The session index and the upload's functions, through the account signed in. */
export interface UploadCloud {
  /**
   * Resolves once the session index's writes made so far are on the server (Firestore's
   * `waitForPendingWrites`): `signUpload` finds only an attempt whose document is there.
   */
  whenIndexed(): Promise<void>;
  signUpload(request: SignRequest): Promise<SignedFile[]>;
  confirmUpload(request: ConfirmRequest): Promise<ConfirmResult>;
  /** The `upload` of each attempt of the session in the index, by index; empty without one. */
  uploadsOf(sessionId: string): Promise<ReadonlyMap<number, CloudUpload>>;
}

/** A PUT's answer: the response's status (0 when none came, a network error) and its text. */
export interface PutResponse {
  readonly status: number;
  readonly body: string;
}

/** A PUT to a signed URL. */
export interface PutRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob;
  /** Called with the bytes sent so far. */
  readonly progress: (sent: number) => void;
  readonly signal: AbortSignal;
}

/** The PUT of a file to its signed URL: `XMLHttpRequest` in the browser, for its progress (xhr.ts). */
export interface UploadHttp {
  /**
   * Resolves with the response, a network error included (status 0); rejects with an `AbortError`
   * once `signal` aborts.
   */
  put(request: PutRequest): Promise<PutResponse>;
}

/** The origin's storage, as `navigator.storage.estimate()` gives it. */
export interface StorageEstimate {
  readonly usage: number;
  readonly quota: number;
}

/** What else the queue needs of the device. */
export interface UploadEnvironment {
  /** The host clock, ms since 1970 (docs/DATA-MODEL.md §1), which the server's times compare with. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A number in [0, 1), Math.random's: the jitter of the retries. */
  random(): number;
  /** The origin's storage; null when the browser does not say. */
  storage(): Promise<StorageEstimate | null>;
  /** The network now. */
  network(): ConnectionInfo;
  /** Calls `listener` when the network changes; returns what stops it. */
  watchNetwork(listener: () => void): () => void;
  /**
   * Waits until this page holds the upload lock (Web Locks: one tab of the app uploads at a time),
   * and resolves with what releases it; rejects once `signal` aborts. Absent: no lock.
   */
  lock?(signal: AbortSignal): Promise<() => void>;
}

/** The settings the queue follows (Settings → Uploads). */
export interface UploadPolicy {
  /** Upload only on Wi-Fi, as far as the browser says the network's type (network.ts). */
  readonly wifiOnly: boolean;
  /** Keep a clip on the device once it is uploaded; off, an attempt's clips go once all its files are. */
  readonly keepLocalCopies: boolean;
}
