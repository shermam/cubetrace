import { describe, expect, it } from 'vitest';

import {
  ACK_EVERY_BYTES,
  BUFFERED_AMOUNT_LOW_THRESHOLD,
  CHUNK_BYTES,
  FakeTimers,
  FileReceiver,
  FileSender,
  MAX_CHECKSUM_RETRIES,
  MemoryIncomingFiles,
  MemoryTransport,
  MessageLink,
  SMALL_CHUNK_BYTES,
  TransferError,
  blobSource,
  bytesSource,
  crc32,
  decode,
  type FileSource,
  type MemoryLinkOptions,
  type ReceivedFile,
  type WireFrame,
} from './index';

/** A seeded pseudo-random generator (mulberry32), so that the losses are the same every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `bytes` bytes of a pattern that a misplaced chunk would break. */
function pattern(bytes: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  let x = seed >>> 0;
  for (let k = 0; k < bytes; k++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[k] = x >>> 24;
  }
  return out;
}

/** Whether two byte arrays hold the same bytes (vitest's equality is slow on 40 million of them). */
function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (a === null || a === undefined || a.length !== b.length) {
    return false;
  }
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

/** A clip's MP4 as a source, from `bytes`. */
function clip(bytes: Uint8Array, name = 'phone-rear.solve.mp4'): FileSource {
  return bytesSource(bytes, { name, kind: 'mp4', attempt: 17, segment: 'solve' });
}

/** The two ends of a connection, with the sender on `a` and the receiver on `b`. */
function connection(
  files: MemoryIncomingFiles,
  options: MemoryLinkOptions & { sender?: ConstructorParameters<typeof FileSender>[1] } = {},
): {
  a: MemoryTransport;
  b: MemoryTransport;
  sender: FileSender;
  receiver: FileReceiver;
  received: ReceivedFile[];
  failed: string[];
} {
  const { sender: senderOptions, ...link } = options;
  const [a, b] = MemoryTransport.pair(link);
  const sender = new FileSender(new MessageLink(a), senderOptions);
  const receiver = new FileReceiver(new MessageLink(b), files);
  const received: ReceivedFile[] = [];
  const failed: string[] = [];
  receiver.onReceived((file) => received.push(file));
  receiver.onFailed((name, reason) => failed.push(`${name}: ${reason}`));
  return { a, b, sender, receiver, received, failed };
}

describe('the file transfer', () => {
  it('moves a 40 MB clip over a 200 ms link with 1% loss in the time the pacing allows, acknowledged and checked', async () => {
    const timers = new FakeTimers();
    const bytes = pattern(40 * 1024 * 1024);
    const files = new MemoryIncomingFiles();
    // 20 MB/s on the wire, as a home Wi-Fi gives, a 200 ms delay each way, 1% of frames lost once.
    const bytesPerSecond = 20_000_000;
    const { a, sender, received } = connection(files, {
      delayMs: 200,
      loss: 0.01,
      retransmitMs: 600,
      bytesPerSecond,
      timers,
      random: random(2026),
    });
    const progress: number[] = [];
    const t0 = timers.now();
    const result = await timers.run(sender.send(clip(bytes), (p) => progress.push(p.acked)));
    const elapsedMs = timers.now() - t0;
    const transmitMs = (bytes.length / bytesPerSecond) * 1000;
    // What the pacing allows: the bytes at the wire's rate, the begin/resume round trip and the
    // last chunk's and the final ack's delay, plus each loss's retransmission (the channel waits
    // for the lost frame, and the sender for the acks behind it).
    const allowedMs = transmitMs + 4 * 200 + a.stats.retransmitted * 600;
    console.log(
      `Transfer of 40 MB over 200 ms with 1% loss: ${(elapsedMs / 1000).toFixed(2)} s (${(bytes.length / 1e6 / (elapsedMs / 1000)).toFixed(1)} MB/s; the wire alone ${(transmitMs / 1000).toFixed(2)} s), ${String(a.stats.frames)} frames, ${String(a.stats.retransmitted)} retransmitted, at most ${String(a.stats.maxBuffered)} bytes queued, allowed ${(allowedMs / 1000).toFixed(2)} s.`,
    );
    expect(elapsedMs).toBeLessThan(allowedMs);
    expect(elapsedMs).toBeGreaterThan(transmitMs);
    expect(a.stats.retransmitted).toBeGreaterThan(0);
    // The pacing: never more than the threshold and one chunk queued.
    expect(a.stats.maxBuffered).toBeLessThanOrEqual(BUFFERED_AMOUNT_LOW_THRESHOLD + CHUNK_BYTES);
    expect(a.stats.maxBuffered).toBeGreaterThan(BUFFERED_AMOUNT_LOW_THRESHOLD);
    expect(a.stats.frames).toBe(Math.ceil(bytes.length / CHUNK_BYTES) + 2);
    expect(result).toEqual({
      name: 'phone-rear.solve.mp4',
      bytes: bytes.length,
      resumedFrom: 0,
      retries: 0,
      crc32: crc32(bytes),
    });
    expect(received).toEqual([
      {
        name: 'phone-rear.solve.mp4',
        bytes: bytes.length,
        kind: 'mp4',
        attempt: 17,
        segment: 'solve',
        crc32: crc32(bytes),
        resumedFrom: 0,
      },
    ]);
    expect(files.finished('phone-rear.solve.mp4')).toBe(true);
    const got = files.take('phone-rear.solve.mp4');
    expect(got?.length).toBe(bytes.length);
    expect(sameBytes(got, bytes)).toBe(true);
    expect(files.take('phone-rear.solve.mp4')).toBeNull();
    // Progress came every megabyte, and the whole file at the end.
    expect(progress.at(-1)).toBe(bytes.length);
    const acks = [...new Set(progress)].filter((p) => p > 0 && p < bytes.length);
    expect(acks).toHaveLength(39);
    expect(acks.every((p) => p % ACK_EVERY_BYTES === 0)).toBe(true);
    expect(CHUNK_BYTES).toBe(65_536);
    expect(BUFFERED_AMOUNT_LOW_THRESHOLD).toBe(262_144);
  });

  it('resumes after the connection is cut in the middle: the receiver says what it holds, the sender goes on from there', async () => {
    const timers = new FakeTimers();
    const bytes = pattern(12 * 1024 * 1024, 7);
    const files = new MemoryIncomingFiles();
    const first = connection(files, { delayMs: 50, bytesPerSecond: 50_000_000, timers });
    let cutAt = -1;
    first.receiver.onProgress((_, held) => {
      if (held >= 5 * 1024 * 1024 && cutAt < 0) {
        cutAt = held;
        first.b.close('the Wi-Fi dropped');
      }
    });
    const failure = await timers.run(
      first.sender.send(clip(bytes)).catch((error: unknown) => error),
    );
    expect(failure).toBeInstanceOf(TransferError);
    expect((failure as TransferError).reason).toBe('closed');
    expect((failure as TransferError).file).toBe('phone-rear.solve.mp4');
    expect(first.received).toEqual([]);
    const held = files.held('phone-rear.solve.mp4');
    expect(held?.length).toBe(cutAt);
    expect(cutAt).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(cutAt).toBeLessThan(bytes.length);
    expect(files.finished('phone-rear.solve.mp4')).toBe(false);

    // A new connection, the same store on the receiver: the file goes on from the bytes held.
    const second = connection(files, { delayMs: 50, bytesPerSecond: 50_000_000, timers });
    const result = await timers.run(second.sender.send(clip(bytes)));
    expect(result.resumedFrom).toBe(cutAt);
    expect(result.retries).toBe(0);
    expect(second.a.stats.bytes).toBeLessThan(bytes.length - cutAt + 20 * CHUNK_BYTES);
    expect(second.a.stats.frames).toBe(Math.ceil((bytes.length - cutAt) / CHUNK_BYTES) + 2);
    expect(second.received.map((file) => [file.name, file.resumedFrom])).toEqual([
      ['phone-rear.solve.mp4', cutAt],
    ]);
    const got = files.take('phone-rear.solve.mp4');
    expect(sameBytes(got, bytes)).toBe(true);
    // The receiver kept the first bytes and the sender re-read them for the checksum: it matched.
    expect(result.crc32).toBe(crc32(bytes));
  });

  it('refuses a corrupted chunk by the checksum, asks for the file again, and gives up after two more tries', async () => {
    const timers = new FakeTimers();
    const bytes = pattern(300 * 1024, 3);
    const files = new MemoryIncomingFiles();
    const { a, sender, received, failed } = connection(files, { delayMs: 10, timers });
    // The 3rd chunk of the first pass has one bit flipped on its way; the later passes are clean.
    let chunks = 0;
    a.transform = (frame: WireFrame) => {
      if (typeof frame === 'string') {
        return frame;
      }
      chunks++;
      if (chunks === 3) {
        const copy = frame.slice();
        copy[copy.length - 1] ^= 0x01;
        return copy;
      }
      return frame;
    };
    const result = await timers.run(sender.send(clip(bytes)));
    expect(result.retries).toBe(1);
    expect(result.resumedFrom).toBe(0);
    expect(received).toHaveLength(1);
    expect(failed).toEqual([]);
    expect(sameBytes(files.take('phone-rear.solve.mp4'), bytes)).toBe(true);
    // The file went twice, and the first pass was dropped by the receiver.
    expect(chunks).toBe(2 * Math.ceil(bytes.length / CHUNK_BYTES));
    expect(files.opens).toBe(2);

    // Every pass corrupted: after the retries, the sender aborts and the receiver drops the file.
    const always = connection(files, { delayMs: 10, timers });
    always.a.transform = (frame) => {
      if (typeof frame === 'string') {
        return frame;
      }
      const copy = frame.slice();
      copy[copy.length - 1] ^= 0x80;
      return copy;
    };
    const error = await timers.run(
      always.sender.send(clip(bytes, 'phone-rear.scramble.mp4')).catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(TransferError);
    expect((error as TransferError).reason).toBe('checksum');
    expect((error as TransferError).message).toBe(
      'phone-rear.scramble.mp4 was refused 3 times: its checksum did not match.',
    );
    expect(always.received).toEqual([]);
    // The receiver, told of the abort once it arrives, drops the file and reports the failure once.
    expect(always.failed).toEqual([]);
    await timers.run(timers.wait(100));
    expect(always.failed).toEqual([
      'phone-rear.scramble.mp4: the sender gave it up: the checksum did not match 3 times',
    ]);
    expect(files.held('phone-rear.scramble.mp4')?.length).toBe(0);
    expect(MAX_CHECKSUM_RETRIES).toBe(2);
  });

  it('refuses a file that comes short of its length', async () => {
    const timers = new FakeTimers();
    const bytes = pattern(200 * 1024, 5);
    const files = new MemoryIncomingFiles();
    const { a, sender, failed } = connection(files, { timers });
    // The second chunk of every pass is dropped on its way: the file is never whole.
    let chunks = 0;
    a.transform = (frame) =>
      typeof frame === 'string' ? frame : ++chunks % 4 === 2 ? null : frame;
    const error = await timers.run(sender.send(clip(bytes)).catch((e: unknown) => e));
    expect(error).toBeInstanceOf(TransferError);
    // The receiver saw a gap (the chunk after the dropped one) and aborted.
    expect((error as TransferError).reason).toBe('aborted');
    expect((error as TransferError).message).toBe(
      'The receiver refused phone-rear.solve.mp4: a gap: 65536 bytes missing before the chunk at 131072.',
    );
    expect(failed).toEqual([
      'phone-rear.solve.mp4: a gap: 65536 bytes missing before the chunk at 131072',
    ]);
  });

  it('uses 16 KB chunks on a channel whose messages are small, and sends an empty file', async () => {
    const timers = new FakeTimers();
    const files = new MemoryIncomingFiles();
    const bytes = pattern(100_000, 9);
    const { a, sender, received } = connection(files, { timers, maxMessageSize: 32_768 });
    expect(sender.chunkBytes).toBe(SMALL_CHUNK_BYTES);
    await timers.run(sender.send(clip(bytes)));
    expect(a.stats.frames).toBe(Math.ceil(bytes.length / SMALL_CHUNK_BYTES) + 2);
    expect(received).toHaveLength(1);
    const empty = bytesSource(new Uint8Array(0), {
      name: 'empty.frames.json',
      kind: 'frames',
      attempt: null,
      segment: null,
    });
    const result = await timers.run(sender.send(empty));
    expect(result).toEqual({
      name: 'empty.frames.json',
      bytes: 0,
      resumedFrom: 0,
      retries: 0,
      crc32: 0,
    });
    expect(files.take('empty.frames.json')).toEqual(new Uint8Array(0));
    // A channel of large messages, or of unknown size, takes 64 KB chunks.
    expect(
      new FileSender(new MessageLink(MemoryTransport.pair({ maxMessageSize: 262_144 })[0]))
        .chunkBytes,
    ).toBe(CHUNK_BYTES);
    expect(new FileSender(new MessageLink(MemoryTransport.pair()[0])).chunkBytes).toBe(CHUNK_BYTES);
  });

  it('sends files one after the other, the frames file first as the camera device will send it', async () => {
    const timers = new FakeTimers();
    const files = new MemoryIncomingFiles();
    const { sender, received } = connection(files, { delayMs: 20, timers });
    const frames = bytesSource(new TextEncoder().encode('{"schema": 2}'), {
      name: 'phone-rear.solve.frames.json',
      kind: 'frames',
      attempt: 17,
      segment: 'solve',
    });
    const mp4 = pattern(150_000, 11);
    const results = await timers.run(Promise.all([sender.send(frames), sender.send(clip(mp4))]));
    expect(results.map((r) => r.name)).toEqual([
      'phone-rear.solve.frames.json',
      'phone-rear.solve.mp4',
    ]);
    expect(received.map((file) => file.name)).toEqual([
      'phone-rear.solve.frames.json',
      'phone-rear.solve.mp4',
    ]);
    expect(
      new TextDecoder().decode(files.take('phone-rear.solve.frames.json') ?? new Uint8Array()),
    ).toBe('{"schema": 2}');
    expect(sameBytes(files.take('phone-rear.solve.mp4'), mp4)).toBe(true);
  });

  it('reads a Blob as the origin private file system gives one', async () => {
    const timers = new FakeTimers();
    const files = new MemoryIncomingFiles();
    const { sender } = connection(files, { timers });
    const bytes = pattern(70_000, 13);
    const source = blobSource(new Blob([bytes]), {
      name: 'laptop.solve.mp4',
      kind: 'mp4',
      attempt: 1,
      segment: 'solve',
    });
    expect(source.bytes).toBe(70_000);
    expect(await source.slice(10, 20)).toEqual(bytes.slice(10, 20));
    await timers.run(sender.send(source));
    expect(sameBytes(files.take('laptop.solve.mp4'), bytes)).toBe(true);
  });

  it('fails a send at once over a closed connection, and when the receiver cannot store the file', async () => {
    const timers = new FakeTimers();
    const files = new MemoryIncomingFiles();
    const { a, sender } = connection(files, { timers });
    a.close('gone');
    await expect(sender.send(clip(pattern(10)))).rejects.toThrow(
      'The connection is closed: phone-rear.solve.mp4 was not sent.',
    );
    const store = new MemoryIncomingFiles();
    store.openError = new Error('no room');
    const refused = connection(store, { timers });
    const error = await timers.run(refused.sender.send(clip(pattern(10))).catch((e: unknown) => e));
    expect(error).toBeInstanceOf(TransferError);
    expect((error as TransferError).reason).toBe('aborted');
    expect((error as TransferError).message).toBe(
      'The receiver refused phone-rear.solve.mp4: cannot store it: no room.',
    );
    expect(refused.failed).toEqual(['phone-rear.solve.mp4: cannot store it: no room']);
  });

  it('acknowledges a file the receiver already holds whole without sending it again', async () => {
    const timers = new FakeTimers();
    const files = new MemoryIncomingFiles();
    const bytes = pattern(100_000, 17);
    const first = connection(files, { timers });
    await timers.run(first.sender.send(clip(bytes)));
    // Not taken out of the store yet when the phone sends it again after a reconnection: the
    // receiver opens a fresh file (the held one is finished), so the file goes again, as it should.
    const second = connection(files, { timers });
    const again = await timers.run(second.sender.send(clip(bytes)));
    expect(again.resumedFrom).toBe(0);
    expect(second.received).toHaveLength(1);
  });

  it('begins a file with its description, and sends no chunk before the receiver answers', async () => {
    const timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ timers });
    const frames: WireFrame[] = [];
    b.onFrame((frame) => frames.push(frame));
    const sender = new FileSender(new MessageLink(a));
    const sending = sender.send(clip(pattern(10)));
    for (let k = 0; k < 5; k++) {
      await Promise.resolve();
    }
    timers.advance(1);
    expect(frames.map((frame) => decode(frame).type)).toEqual(['file-begin']);
    expect(decode(frames[0])).toMatchObject({
      id: 1,
      name: 'phone-rear.solve.mp4',
      bytes: 10,
      kind: 'mp4',
      attempt: 17,
      segment: 'solve',
    });
    timers.advance(10_000);
    expect(frames).toHaveLength(1);
    a.close();
    await expect(sending).rejects.toThrow(TransferError);
  });
});
