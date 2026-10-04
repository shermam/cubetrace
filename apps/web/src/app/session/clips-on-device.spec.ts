import { MemorySessionStore, type AttemptRecord, type VideoClip } from '@cubetrace/core';
import { describe, expect, it } from 'vitest';

import { clipsOnDevice, withClipsOnDevice, withoutLocal } from './clips-on-device';
import { SESSION_A, testAttempt, testSession } from './session-testing';

/** A clip of the laptop's camera for `segment`. */
function clip(segment: 'scramble' | 'solve', local?: false): VideoClip {
  return {
    camera: 'laptop',
    segment,
    file: `laptop.${segment}.mp4`,
    bytes: segment === 'solve' ? 2000 : 1000,
    codec: 'avc1.640028',
    audio: null,
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 30,
    firstFrameHostMs: 1_000,
    framesFile: `laptop.${segment}.frames.json`,
    syncResidualMs: null,
    truncatedStart: false,
    ...(local === undefined ? {} : { local }),
  };
}

function withClips(index: number, clips: VideoClip[]): AttemptRecord {
  return { ...testAttempt(index, 10_000), video: clips };
}

/** Attempt 1's folder holds its scramble clip, its solve clip deleted; attempt 2's is not listed. */
const FOLDERS: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [
    1,
    new Set([
      'attempt.json',
      'laptop.scramble.mp4',
      'laptop.scramble.frames.json',
      'laptop.solve.frames.json',
    ]),
  ],
]);

describe('the clips on this device (T4.2a)', () => {
  it('saves an attempt as the dataset holds it, without local, and reads where its clips are from its folder', async () => {
    const raw = new MemorySessionStore();
    await raw.createSession(testSession());
    const store = clipsOnDevice(raw, { list: () => Promise.resolve(FOLDERS) });
    // The timer's copy says the solve clip is gone; what is written does not.
    await store.saveAttempt(withClips(1, [clip('scramble'), clip('solve', false)]));
    const [written] = await raw.loadAttempts(SESSION_A);
    expect(written.video.map((c) => c.local)).toEqual([undefined, undefined]);
    // Read through it, the clips say where they are, from the folder; another record of no clips
    // or of a folder not listed stays as written.
    await raw.saveAttempt(withClips(2, [clip('solve', false)]));
    await raw.saveAttempt(withClips(3, []));
    const read = await store.loadAttempts(SESSION_A);
    expect(read.map((a) => a.video.map((c) => c.local))).toEqual([[undefined, false], [false], []]);
    const exported = await store.exportSession(SESSION_A);
    expect(exported.attempts).toEqual(read);
    expect(exported.session).toEqual((await raw.exportSession(SESSION_A)).session);
  });

  it('leaves the records as written without a listing, or when the listing fails', async () => {
    const raw = new MemorySessionStore();
    await raw.createSession(testSession());
    // As a build before T4.2a wrote it: the solve clip said gone.
    await raw.saveAttempt(withClips(1, [clip('scramble'), clip('solve', false)]));
    const as = await raw.loadAttempts(SESSION_A);
    expect(await clipsOnDevice(raw, {}).loadAttempts(SESSION_A)).toEqual(as);
    const failing = clipsOnDevice(raw, { list: () => Promise.reject(new Error('no OPFS')) });
    expect(await failing.loadAttempts(SESSION_A)).toEqual(as);
    expect((await failing.exportSession(SESSION_A)).attempts).toEqual(as);
  });

  it('marks a clip gone only from its folder, and strips local only where there is one', () => {
    const attempt = withClips(1, [clip('scramble', false), clip('solve')]);
    expect(withClipsOnDevice(attempt, FOLDERS.get(1)).video.map((c) => [c.file, c.local])).toEqual([
      ['laptop.scramble.mp4', undefined],
      ['laptop.solve.mp4', false],
    ]);
    expect(withClipsOnDevice(attempt, undefined)).toBe(attempt);
    expect(withoutLocal(attempt).video.map((c) => 'local' in c)).toEqual([false, false]);
    const plain = withClips(2, [clip('solve')]);
    expect(withoutLocal(plain)).toBe(plain);
  });
});
