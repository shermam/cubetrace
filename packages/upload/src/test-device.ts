/// <reference types="node" />
// A device for the queue's tests: an in-memory origin private file system with the session store
// over it (both @cubetrace/storage's, as the browser has them), sessions of a real cube recorded into
// it with their clips' files, the fakes of the functions, the bucket and the PUTs, and a queue over
// them. Not exported by the package.
import {
  AttemptMachine,
  createSession,
  parseMoves,
  type AttemptRecord,
  type GyroSummary,
  type SessionRecord,
  type VideoClip,
  type VideoSegment,
} from '@cubetrace/core';
import { FakeDirectoryHandle, OpfsSessionStore } from '@cubetrace/storage';

import { OpfsUploadSource } from './opfs-source';
import type { AttemptRef, UploadPolicy } from './ports';
import { UploadQueue } from './queue';
import { FakeBucket, FakeUploadCloud, FakeUploadEnvironment, FakeUploadHttp } from './testing';

export const A = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
export const B = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';
export const DEMO = '0d0d0d0d-0000-4000-8000-000000000001';

export const UID = 'ada-uid';

/** A session of a real cube (or the demo's simulated one), created at `createdMs`. */
export function session(id: string, createdMs: number, simulated = false): SessionRecord {
  return createSession({
    host: { label: 'office-mbp', userAgent: 'test', platform: 'macOS', isPhone: false },
    cube: simulated
      ? { model: 'Fake cube', hardware: 'simulated', firmware: 'simulated', gyro: false }
      : { model: 'GAN 12 ui FreePlay', hardware: 'GAN Gen2', firmware: '2.3.1', gyro: true },
    settings: { inspection15s: false, autoAdvance: true },
    appVersion: '0.3.0',
    commit: 'abc1234',
    nowMs: createdMs,
    id,
  });
}

/** A clip of the laptop's camera of `bytes`. */
export function clip(segment: VideoSegment, bytes: number): VideoClip {
  return {
    camera: 'laptop',
    segment,
    file: `laptop.${segment}.mp4`,
    bytes,
    codec: 'avc1.640028',
    audio: 'mp4a.40.2',
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 300,
    firstFrameHostMs: 1_790_000_001_000,
    framesFile: `laptop.${segment}.frames.json`,
    syncResidualMs: null,
    truncatedStart: false,
  };
}

/** Attempt `index` of `sessionId` on `R U F`, shown at `shownMs`, solved, with `clips`. */
export function attempt(
  sessionId: string,
  index: number,
  clips: readonly VideoClip[] = [],
  shownMs = 1_790_000_000_000 + index * 60_000,
): AttemptRecord {
  const machine = new AttemptMachine({
    session: sessionId,
    index,
    scramble: 'R U F',
    scrambleShownMs: shownMs,
  });
  let t = shownMs + 1000;
  for (const m of parseMoves("R U F F' U' R'")) {
    machine.onMove({ m, cubeMs: t - shownMs, hostMs: t });
    t += 500;
  }
  return { ...machine.toRecord(), video: [...clips] };
}

/** The frames file of a clip, as many bytes as `bytes`. */
export const FRAMES_BYTES = 120;

/** The gyro file of an attempt that has one (`record` plants it), summed up (T3.7). */
export const GYRO: GyroSummary = {
  file: 'gyro.json',
  samples: 200,
  fromHostMs: 1_790_000_000_000,
  toHostMs: 1_790_000_004_000,
  rateHz: 49.8,
  truncatedStart: false,
};

/** The gyro file's bytes on the device. */
export const GYRO_BYTES = 9_000;

export interface Device {
  readonly root: FakeDirectoryHandle;
  readonly store: OpfsSessionStore;
  readonly source: OpfsUploadSource;
  readonly env: FakeUploadEnvironment;
  readonly bucket: FakeBucket;
  readonly cloud: FakeUploadCloud;
  readonly http: FakeUploadHttp;
  /** Attempts (`<session>/<index>`) whose clips are still to come. */
  readonly awaiting: Set<string>;
  /** The record changes the device made when it deleted clips. */
  readonly removed: string[];
}

/** A device with nothing on it yet, its fakes sharing one clock. */
export function device(options: { lock?: boolean; root?: FakeDirectoryHandle } = {}): Device {
  const root = options.root ?? new FakeDirectoryHandle();
  const store = new OpfsSessionStore(root);
  const env = new FakeUploadEnvironment(1_790_000_000_000, options.lock ?? false);
  const bucket = new FakeBucket();
  const now = (): number => env.now();
  const awaiting = new Set<string>();
  const removed: string[] = [];
  const source = new OpfsUploadSource({
    root,
    store,
    settled: (sessionId, index) => !awaiting.has(`${sessionId}/${String(index)}`),
    markClipsGone: async (ref: AttemptRef, files) => {
      const { attempts } = await store.exportSession(ref.session);
      const record = attempts.find(
        (a) => a.index === ref.index && a.events.scrambleShown === ref.scrambleShown,
      );
      if (record === undefined) {
        return false;
      }
      await store.saveAttempt({
        ...record,
        video: record.video.map((c) => (files.includes(c.file) ? { ...c, local: false } : c)),
      });
      removed.push(`${ref.session}/${String(ref.index)} ${files.join(',')}`);
      return true;
    },
  });
  return {
    root,
    store,
    source,
    env,
    bucket,
    cloud: new FakeUploadCloud(bucket, now),
    http: new FakeUploadHttp(bucket, now),
    awaiting,
    removed,
  };
}

/** Records `record` and its attempts on the device, with their clips' files. */
export async function record(
  d: Device,
  sessionRecord: SessionRecord,
  attempts: readonly AttemptRecord[],
): Promise<void> {
  const sessions = await d.store.listSessions();
  if (!sessions.some((s) => s.id === sessionRecord.id)) {
    await d.store.createSession(sessionRecord);
  }
  await d.store.saveSession({
    ...sessionRecord,
    summary: { attempts: attempts.length, solved: attempts.length, dnf: 0 },
  });
  for (const a of attempts) {
    await d.store.saveAttempt(a);
    const folder = `sessions/${a.session}/attempts/${String(a.index).padStart(4, '0')}`;
    for (const c of a.video) {
      await d.root.plant(`${folder}/${c.file}`, 'v'.repeat(c.bytes));
      await d.root.plant(`${folder}/${c.framesFile}`, 'f'.repeat(FRAMES_BYTES));
    }
    if (a.gyro !== null) {
      await d.root.plant(`${folder}/${a.gyro.file}`, 'g'.repeat(GYRO_BYTES));
    }
  }
}

export const KEEP: UploadPolicy = { wifiOnly: false, keepLocalCopies: true };

/** A queue of the device's account. */
export function queueOf(d: Device, policy: UploadPolicy = KEEP): UploadQueue {
  return new UploadQueue({
    uid: UID,
    source: d.source,
    cloud: d.cloud,
    http: d.http,
    env: d.env,
    policy,
  });
}

/** Lets every promise that can settle settle (the fake file system's and the queue's). */
export async function flush(): Promise<void> {
  for (let k = 0; k < 40; k++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** The text of a file of the fake file system; null when it is not there. */
export function fileText(d: Device, path: string): string | null {
  return d.root.files().get(path)?.text ?? null;
}
