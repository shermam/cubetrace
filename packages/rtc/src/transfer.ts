// The file transfer over the data channel (docs/RTC.md, docs/PLAN.md T4.0): a camera device sends
// each clip's MP4 and frames file to the host in chunks of 64 KB (16 KB on a channel that takes
// small messages), paced by the channel's own flow control: a chunk goes only while the bytes queued
// on the channel are under the low threshold (256 KB), so that at most the threshold and one chunk
// are in flight, and the channel never stalls on a message too large. The receiver appends the
// chunks in order into a file it keeps across connections, acknowledges its progress, and checks the
// whole file's length and CRC-32 at the end. A file begun again after a reconnection goes on from
// the bytes the receiver already holds (`file-begin` → `file-resume`); a file whose checksum does not
// match is dropped and asked for again from the start, which the sender does twice at most before it
// gives the file up. Plain TypeScript: no browser API; the app gives the files as Blobs of the origin
// private file system (`blobSource`).
import type { VideoSegment } from '@cubetrace/core';

import { Crc32 } from './crc32';
import type { MessageLink } from './link';
import type { FileAbort, FileAck, FileBegin, FileKind, FileResume } from './protocol';

/** The bytes of a chunk, and of a chunk on a channel whose messages are small. */
export const CHUNK_BYTES = 64 * 1024;
export const SMALL_CHUNK_BYTES = 16 * 1024;

/** The channel's low threshold while a file is sent: the sender waits above it. */
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

/** The receiver acknowledges its progress every this many bytes, and at the end. */
export const ACK_EVERY_BYTES = 1024 * 1024;

/** How many times a receiver may refuse a file's checksum before the sender gives it up. */
export const MAX_CHECKSUM_RETRIES = 2;

/** A file to send: its description and its bytes by range. */
export interface FileSource {
  readonly name: string;
  readonly bytes: number;
  readonly kind: FileKind;
  /** The attempt and the segment the file belongs to; null for a file of neither. */
  readonly attempt: number | null;
  readonly segment: VideoSegment | null;
  /** The bytes from `start` up to `end` (excluded). */
  slice(start: number, end: number): Promise<Uint8Array>;
}

/** What a file is, as `file-begin` says it. */
export type FileDescription = Omit<FileBegin, 'type' | 'id'>;

/** A {@link FileSource} over a Blob (a File of the origin private file system). */
export function blobSource(blob: Blob, description: Omit<FileDescription, 'bytes'>): FileSource {
  return {
    ...description,
    bytes: blob.size,
    slice: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

/** A {@link FileSource} over bytes in memory, for the tests. */
export function bytesSource(
  bytes: Uint8Array,
  description: Omit<FileDescription, 'bytes'>,
): FileSource {
  return {
    ...description,
    bytes: bytes.length,
    slice: (start, end) => Promise.resolve(bytes.subarray(start, end)),
  };
}

/** How far a send is: the bytes sent into the channel, and those the receiver acknowledged. */
export interface SendProgress {
  readonly sent: number;
  readonly acked: number;
  readonly bytes: number;
}

/** What a send that succeeded says. */
export interface SendResult {
  readonly name: string;
  readonly bytes: number;
  /** The offset the receiver asked to start from: 0 for a fresh file, more after a reconnection. */
  readonly resumedFrom: number;
  /** How many times the receiver refused the checksum and the file was sent again. */
  readonly retries: number;
  readonly crc32: number;
}

/** Why a send ended without the receiver's `done`. */
export type TransferFailure = 'closed' | 'aborted' | 'checksum';

/** What a send throws when it ends without the receiver's `done`. */
export class TransferError extends Error {
  override readonly name = 'TransferError';

  constructor(
    readonly reason: TransferFailure,
    readonly file: string,
    message: string,
  ) {
    super(message);
  }
}

/** How a {@link FileSender} paces itself; the defaults are the constants above. */
export interface FileSenderOptions {
  chunkBytes?: number;
  threshold?: number;
  maxChecksumRetries?: number;
}

/**
 * Sends files over a link, one at a time (a second `send` waits for the first), paced by the
 * channel's buffered amount (the file comment). A send resolves once the receiver acknowledged the
 * whole file, and rejects with a {@link TransferError} when the link closes meanwhile (the file is
 * kept on the sender: send it again over the next link, and the receiver continues where it was),
 * when either side aborted it, or when the receiver refused its checksum too many times.
 */
export class FileSender {
  readonly #link: MessageLink;
  readonly #chunkBytes: number;
  readonly #threshold: number;
  readonly #maxRetries: number;
  #nextId = 1;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(link: MessageLink, options: FileSenderOptions = {}) {
    this.#link = link;
    const max = link.transport.maxMessageSize;
    this.#chunkBytes =
      options.chunkBytes ??
      (max !== null && max < CHUNK_BYTES + 64 ? SMALL_CHUNK_BYTES : CHUNK_BYTES);
    this.#threshold = options.threshold ?? BUFFERED_AMOUNT_LOW_THRESHOLD;
    this.#maxRetries = options.maxChecksumRetries ?? MAX_CHECKSUM_RETRIES;
    link.transport.bufferedAmountLowThreshold = this.#threshold;
  }

  /** The bytes of each chunk this sender uses. */
  get chunkBytes(): number {
    return this.#chunkBytes;
  }

  /** Sends `file`, after the sends before it; `progress` is told after each chunk and each ack. */
  send(file: FileSource, progress?: (progress: SendProgress) => void): Promise<SendResult> {
    const run = this.#queue.then(() => this.#send(file, progress ?? (() => undefined)));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #send(file: FileSource, progress: (progress: SendProgress) => void): Promise<SendResult> {
    const link = this.#link;
    const id = this.#nextId++;
    const fail = (reason: TransferFailure, message: string): TransferError =>
      new TransferError(reason, file.name, message);
    let acked = 0;
    let sent = 0;
    const report = (): void => {
      progress({ sent, acked, bytes: file.bytes });
    };
    const offAck = link.on('file-ack', (ack) => {
      if (ack.id === id && !ack.done) {
        acked = Math.max(acked, ack.offset);
        report();
      }
    });
    // What ends the wait for the receiver's answers: the link closing.
    let closed: ((error: TransferError) => void) | null = null;
    const whenClosed = new Promise<never>((_, reject) => {
      closed = reject;
    });
    const offState = link.transport.onStateChange((state, reason) => {
      if (state !== 'open') {
        closed?.(
          fail(
            'closed',
            `The connection closed while ${file.name} was being sent: ${reason ?? state}.`,
          ),
        );
      }
    });
    try {
      if (!link.open) {
        throw fail('closed', `The connection is ${link.state}: ${file.name} was not sent.`);
      }
      const answer = (): Promise<FileResume | FileAck | FileAbort> =>
        Promise.race([
          link.next('file-resume', (m) => m.id === id),
          link.next('file-ack', (m) => m.id === id && m.done),
          link.next('file-abort', (m) => m.id === id),
          whenClosed,
        ]);
      link.send({
        type: 'file-begin',
        id,
        name: file.name,
        bytes: file.bytes,
        kind: file.kind,
        attempt: file.attempt,
        segment: file.segment,
      });
      let first = await answer();
      if (first.type === 'file-abort') {
        throw fail('aborted', `The receiver refused ${file.name}: ${first.reason}.`);
      }
      if (first.type === 'file-ack') {
        // The receiver had the whole file already.
        return {
          name: file.name,
          bytes: file.bytes,
          resumedFrom: file.bytes,
          retries: 0,
          crc32: 0,
        };
      }
      const resumedFrom = Math.min(first.offset, file.bytes);
      let retries = 0;
      let offset = resumedFrom;
      for (;;) {
        const crc = new Crc32();
        // The checksum covers the whole file: the bytes the receiver holds are read again for it.
        for (let at = 0; at < offset; at += this.#chunkBytes) {
          crc.update(await file.slice(at, Math.min(at + this.#chunkBytes, offset)));
        }
        sent = offset;
        acked = Math.max(acked, offset);
        report();
        while (offset < file.bytes) {
          await this.#roomToSend(whenClosed);
          const end = Math.min(offset + this.#chunkBytes, file.bytes);
          const bytes = await file.slice(offset, end);
          crc.update(bytes);
          if (link.state !== 'open') {
            throw fail('closed', `The connection closed while ${file.name} was being sent.`);
          }
          link.send({ type: 'file-chunk', id, offset, bytes });
          offset = end;
          sent = end;
          report();
        }
        link.send({ type: 'file-done', id, crc32: crc.value });
        const outcome = await answer();
        if (outcome.type === 'file-ack') {
          acked = file.bytes;
          report();
          return { name: file.name, bytes: file.bytes, resumedFrom, retries, crc32: crc.value };
        }
        if (outcome.type === 'file-abort') {
          throw fail('aborted', `The receiver refused ${file.name}: ${outcome.reason}.`);
        }
        // The receiver asks again: its checksum did not match (or it lost bytes). From its offset.
        retries++;
        if (retries > this.#maxRetries) {
          link.trySend({
            type: 'file-abort',
            id,
            reason: `the checksum did not match ${String(retries)} times`,
          });
          throw fail(
            'checksum',
            `${file.name} was refused ${String(retries)} times: its checksum did not match.`,
          );
        }
        offset = Math.min(outcome.offset, file.bytes);
        first = outcome;
      }
    } finally {
      offAck();
      offState();
      closed = null;
    }
  }

  /** Waits until the channel's queue is at the threshold or under it. */
  #roomToSend(whenClosed: Promise<never>): Promise<void> {
    const transport = this.#link.transport;
    if (transport.bufferedAmount <= this.#threshold) {
      return Promise.resolve();
    }
    return Promise.race([
      new Promise<void>((resolve) => {
        const off = transport.onBufferedAmountLow(() => {
          off();
          resolve();
        });
      }),
      whenClosed,
    ]);
  }
}

/** A file as the receiver assembles it, in a store that outlives the connection. */
export interface IncomingFile {
  /** The bytes held so far, from the start of the file without a gap. */
  readonly received: number;
  /** The CRC-32 of those bytes. */
  readonly crc32: number;
  /** Appends the next bytes. */
  append(bytes: Uint8Array): Promise<void> | void;
  /** The file is complete and checked: keep it. */
  finish(): Promise<void> | void;
  /** Drops what is held. */
  discard(): Promise<void> | void;
}

/**
 * Where the receiver puts the files: a store that gives, for a file begun, what it already holds of
 * it (after a reconnection) or a new empty file. The app's keeps them in the origin private file
 * system; {@link MemoryIncomingFiles} in memory.
 */
export interface IncomingFiles {
  open(file: FileDescription): Promise<IncomingFile> | IncomingFile;
}

/** A file the receiver completed. */
export interface ReceivedFile extends FileDescription {
  readonly crc32: number;
  /** The offset the sender was asked to start from this time. */
  readonly resumedFrom: number;
}

/** How a {@link FileReceiver} answers; the default is the constant above. */
export interface FileReceiverOptions {
  ackEveryBytes?: number;
}

interface Incoming {
  description: FileDescription;
  file: IncomingFile;
  resumedFrom: number;
  lastAck: number;
  /** The appends and checks of this file, one after the other. */
  work: Promise<void>;
}

/**
 * Receives files over a link into a store (the file comment): answers each `file-begin` with the
 * offset it wants, appends the chunks, acknowledges every {@link ACK_EVERY_BYTES}, and at
 * `file-done` checks the length and the checksum: `file-ack` with `done` when they match (and the
 * store's `finish`), `file-resume` from 0 when they do not (the store's `discard`); the sender
 * decides when to give up (`file-abort`), and a chunk that does not fit (a gap, more bytes than
 * announced) ends the file with a `file-abort` of the receiver's.
 */
export class FileReceiver {
  readonly #link: MessageLink;
  readonly #files: IncomingFiles;
  readonly #ackEvery: number;
  readonly #incoming = new Map<number, Incoming>();
  readonly #receivedHandlers = new Set<(file: ReceivedFile) => void>();
  readonly #failedHandlers = new Set<(name: string, reason: string) => void>();
  readonly #progressHandlers = new Set<(file: FileDescription, received: number) => void>();
  readonly #off: (() => void)[] = [];

  constructor(link: MessageLink, files: IncomingFiles, options: FileReceiverOptions = {}) {
    this.#link = link;
    this.#files = files;
    this.#ackEvery = options.ackEveryBytes ?? ACK_EVERY_BYTES;
    this.#off.push(
      link.on('file-begin', (begin) => {
        this.#begin(begin);
      }),
      link.on('file-chunk', (chunk) => {
        this.#enqueue(chunk.id, (incoming) => this.#append(incoming, chunk.offset, chunk.bytes));
      }),
      link.on('file-done', (done) => {
        this.#enqueue(done.id, (incoming) => this.#finish(done.id, incoming, done.crc32));
      }),
      link.on('file-abort', (abort) => {
        this.#enqueue(abort.id, async (incoming) => {
          this.#incoming.delete(abort.id);
          await incoming.file.discard();
          this.#failed(incoming.description.name, `the sender gave it up: ${abort.reason}`);
        });
      }),
    );
  }

  /** Calls `next` with each file completed and kept. */
  onReceived(next: (file: ReceivedFile) => void): () => void {
    this.#receivedHandlers.add(next);
    return () => {
      this.#receivedHandlers.delete(next);
    };
  }

  /** Calls `next` with each file given up, and why. */
  onFailed(next: (name: string, reason: string) => void): () => void {
    this.#failedHandlers.add(next);
    return () => {
      this.#failedHandlers.delete(next);
    };
  }

  /** Calls `next` with the bytes held of a file after each chunk. */
  onProgress(next: (file: FileDescription, received: number) => void): () => void {
    this.#progressHandlers.add(next);
    return () => {
      this.#progressHandlers.delete(next);
    };
  }

  /** The files under way on this link: their names. */
  get pending(): string[] {
    return [...this.#incoming.values()].map((incoming) => incoming.description.name);
  }

  /** Stops listening to the link; the store keeps what it holds, for the next link. */
  detach(): void {
    for (const off of this.#off) {
      off();
    }
    this.#incoming.clear();
  }

  #begin(begin: FileBegin): void {
    const { id } = begin;
    const description: FileDescription = {
      name: begin.name,
      bytes: begin.bytes,
      kind: begin.kind,
      attempt: begin.attempt,
      segment: begin.segment,
    };
    void (async () => {
      let file: IncomingFile;
      try {
        file = await this.#files.open(description);
      } catch (error: unknown) {
        const reason = `cannot store it: ${error instanceof Error ? error.message : String(error)}`;
        this.#link.trySend({ type: 'file-abort', id, reason });
        this.#failed(description.name, reason);
        return;
      }
      const resumedFrom = Math.min(file.received, description.bytes);
      this.#incoming.set(id, {
        description,
        file,
        resumedFrom,
        lastAck: resumedFrom,
        work: Promise.resolve(),
      });
      this.#link.trySend({ type: 'file-resume', id, offset: resumedFrom });
    })();
  }

  /** Runs `step` on the file `id` after the steps before it; a step that throws ends the file. */
  #enqueue(id: number, step: (incoming: Incoming) => Promise<void>): void {
    const incoming = this.#incoming.get(id);
    if (incoming === undefined) {
      return;
    }
    incoming.work = incoming.work.then(
      () => step(incoming),
      () => undefined,
    );
    incoming.work = incoming.work.catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.#incoming.delete(id);
      this.#link.trySend({ type: 'file-abort', id, reason });
      this.#failed(incoming.description.name, reason);
    });
  }

  async #append(incoming: Incoming, offset: number, bytes: Uint8Array): Promise<void> {
    const have = incoming.file.received;
    if (offset > have) {
      throw new Error(
        `a gap: ${String(offset - have)} bytes missing before the chunk at ${String(offset)}`,
      );
    }
    // Bytes already held (a chunk sent twice) are skipped.
    const fresh = offset + bytes.length > have ? bytes.subarray(have - offset) : null;
    if (fresh === null || fresh.length === 0) {
      return;
    }
    if (have + fresh.length > incoming.description.bytes) {
      throw new Error(`more bytes than announced (${String(incoming.description.bytes)})`);
    }
    await incoming.file.append(fresh);
    const received = incoming.file.received;
    for (const handler of [...this.#progressHandlers]) {
      handler(incoming.description, received);
    }
    if (received - incoming.lastAck >= this.#ackEvery && received < incoming.description.bytes) {
      incoming.lastAck = received;
      this.#link.trySend({
        type: 'file-ack',
        id: this.#idOf(incoming),
        offset: received,
        done: false,
      });
    }
  }

  async #finish(id: number, incoming: Incoming, crc32: number): Promise<void> {
    const { description, file } = incoming;
    const complete = file.received === description.bytes && file.crc32 === crc32;
    if (complete) {
      await file.finish();
      this.#incoming.delete(id);
      this.#link.trySend({ type: 'file-ack', id, offset: description.bytes, done: true });
      const received: ReceivedFile = { ...description, crc32, resumedFrom: incoming.resumedFrom };
      for (const handler of [...this.#receivedHandlers]) {
        handler(received);
      }
      return;
    }
    // The bytes do not add up to the file: dropped, and asked for again from the start, into a
    // fresh file of the store; the sender counts the refusals and gives up after a few.
    await file.discard();
    const fresh = await this.#files.open(description);
    incoming.file = fresh;
    incoming.resumedFrom = 0;
    incoming.lastAck = 0;
    this.#link.trySend({ type: 'file-resume', id, offset: fresh.received });
  }

  #idOf(incoming: Incoming): number {
    for (const [id, entry] of this.#incoming) {
      if (entry === incoming) {
        return id;
      }
    }
    return 0;
  }

  #failed(name: string, reason: string): void {
    for (const handler of [...this.#failedHandlers]) {
      handler(name, reason);
    }
  }
}

/** A file held in memory by {@link MemoryIncomingFiles}. */
class MemoryFile implements IncomingFile {
  readonly chunks: Uint8Array[] = [];
  received = 0;
  finished = false;
  readonly #crc = new Crc32();

  get crc32(): number {
    return this.#crc.value;
  }

  append(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice());
    this.received += bytes.length;
    this.#crc.update(bytes);
  }

  finish(): void {
    this.finished = true;
  }

  discard(): void {
    this.chunks.length = 0;
    this.received = 0;
    this.#crc.reset();
  }

  /** The bytes held, in one array. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.received);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/**
 * The receiver's files in memory, by name (the tests' store, and a model for the app's): a file
 * begun again gets what is held of it when the sizes agree; a file finished stays until `take`.
 */
export class MemoryIncomingFiles implements IncomingFiles {
  readonly #files = new Map<string, { bytes: number; file: MemoryFile }>();
  /** Set: `open` fails with it (the store has no room). */
  openError: Error | null = null;
  /** How many times a file was opened. */
  opens = 0;

  open(description: FileDescription): IncomingFile {
    this.opens++;
    if (this.openError !== null) {
      throw this.openError;
    }
    const held = this.#files.get(description.name);
    if (held !== undefined && !held.file.finished && held.bytes === description.bytes) {
      return held.file;
    }
    const file = new MemoryFile();
    this.#files.set(description.name, { bytes: description.bytes, file });
    return file;
  }

  /** The bytes held of `name` so far (finished or not); null when nothing is. */
  held(name: string): Uint8Array | null {
    const entry = this.#files.get(name);
    return entry === undefined ? null : entry.file.bytes();
  }

  /** Whether `name` was completed and kept. */
  finished(name: string): boolean {
    return this.#files.get(name)?.file.finished ?? false;
  }

  /** The bytes of the completed file `name`, taken out of the store; null when it is not complete. */
  take(name: string): Uint8Array | null {
    const entry = this.#files.get(name);
    if (entry === undefined || !entry.file.finished) {
      return null;
    }
    this.#files.delete(name);
    return entry.file.bytes();
  }
}
