import { ATTEMPT_SCHEMA, FRAMES_SCHEMA, type FramesJson, type VideoClip } from '@cubetrace/core';
import { FakeDirectoryHandle, type FakeFileHandle, type FakeOpfsOptions } from '@cubetrace/storage';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { deleteClip, deleteClipIf, writeClip, type ClipDetails } from './clip-writer';

// The clip writer over the in-memory file system of @cubetrace/storage: the files of
// docs/DATA-MODEL.md §5, each written whole under a temporary name and moved into place, the
// `video[]` entry it returns (validated against attempt.schema.json's clip), and what a page that
// goes away in the middle of a write leaves.

const SESSION = '3f1c2b7e-8a4d-4f2e-9b1a-0c5d6e7f8a9b';
const FOLDER = `sessions/${SESSION}/attempts/0007`;

const FRAMES: FramesJson = {
  schema: 2,
  camera: 'laptop',
  segment: 'solve',
  t0HostMs: 1_790_524_522_772.81,
  dtMs: [0, 33.4, 33.2, 33.5, 33, 33.1],
  keyframes: [0],
  arrival: { offsetMs: 1_790_516_343_598.5, residualP95Ms: 0.35 },
};

const DETAILS: ClipDetails = {
  codec: 'vp09.00.40.08',
  audio: 'opus',
  width: 1920,
  height: 1080,
  fpsNominal: 30,
};

/** Stands for an MP4: `size` bytes counting up from `seed`. */
function mp4Bytes(size = 7_000, seed = 0): ArrayBuffer {
  return Uint8Array.from({ length: size }, (_, index) => (index + seed) % 251).buffer;
}

/** Whether `bytes` are those of `buffer` (quicker than a deep equality on thousands of bytes). */
function same(bytes: Uint8Array | undefined, buffer: ArrayBuffer): boolean {
  const expected = new Uint8Array(buffer);
  return bytes?.length === expected.length && bytes.every((byte, at) => byte === expected[at]);
}

/** A file system with the session's folder (made by `createSession`, T1.6b). */
async function withSession(options: FakeOpfsOptions = {}): Promise<FakeDirectoryHandle> {
  const root = new FakeDirectoryHandle('', options);
  await root.plant(`sessions/${SESSION}/session.json`, '{}');
  return root;
}

function file(root: FakeDirectoryHandle, path: string): FakeFileHandle | undefined {
  return root.files().get(path);
}

function temporaryFiles(root: FakeDirectoryHandle): string[] {
  return [...root.files().keys()].filter((path) => path.endsWith('.tmp'));
}

function write(
  root: FakeDirectoryHandle,
  mp4 = mp4Bytes(),
  frames: FramesJson = FRAMES,
  index = 7,
): Promise<VideoClip> {
  return writeClip(root, SESSION, index, frames.camera, frames.segment, mp4, frames, DETAILS);
}

/** Lets every pending promise of the fake settle: it never waits for a timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function clipValidator(): ValidateFunction {
  const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
  ajv.addSchema(ATTEMPT_SCHEMA);
  const validate = ajv.getSchema(`${String(ATTEMPT_SCHEMA['$id'])}#/$defs/clip`);
  if (validate === undefined) {
    throw new Error('attempt.schema.json has no clip definition.');
  }
  return validate;
}

describe('writeClip', () => {
  it.each([
    ['through an access handle, as in the capture worker', { syncAccessHandle: true }],
    ['through a writable stream where there is no access handle', { syncAccessHandle: false }],
  ])(
    'writes the MP4 and its frames.json into the attempt folder %s',
    async (_how, options: FakeOpfsOptions) => {
      const root = await withSession(options);
      const mp4 = mp4Bytes();

      const clip = await write(root, mp4);

      expect([...root.files().keys()].sort()).toEqual([
        `${FOLDER}/laptop.solve.frames.json`,
        `${FOLDER}/laptop.solve.mp4`,
        `sessions/${SESSION}/session.json`,
      ]);
      expect(same(file(root, `${FOLDER}/laptop.solve.mp4`)?.bytes, mp4)).toBe(true);
      expect(JSON.parse(file(root, `${FOLDER}/laptop.solve.frames.json`)?.text ?? '')).toEqual(
        FRAMES,
      );
      expect(file(root, `${FOLDER}/laptop.solve.frames.json`)?.text).toBe(
        `${JSON.stringify(FRAMES)}\n`,
      );
      expect([...root.files().values()].every((f) => !f.locked && !f.openAccessHandle)).toBe(true);
      expect(clip).toEqual({
        camera: 'laptop',
        segment: 'solve',
        file: 'laptop.solve.mp4',
        bytes: 7_000,
        codec: 'vp09.00.40.08',
        audio: 'opus',
        width: 1920,
        height: 1080,
        crop: null,
        fpsNominal: 30,
        frames: 6,
        firstFrameHostMs: 1_790_524_522_772.81,
        framesFile: 'laptop.solve.frames.json',
        syncResidualMs: null,
      });
    },
  );

  it('returns a video[] entry valid against attempt.schema.json, and writes a frames.json valid against its schema', async () => {
    const root = await withSession({ syncAccessHandle: true });
    const validate = clipValidator();
    const validateFrames = new Ajv2020({ allowUnionTypes: true }).compile(FRAMES_SCHEMA);
    const frames: FramesJson = { ...FRAMES, camera: 'phone-front', segment: 'scramble' };

    const clip = await write(root, mp4Bytes(), frames);

    expect(validate(clip), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({ ...clip, crop: { x: 480, y: 120, w: 960, h: 840 }, syncResidualMs: 41.5 }),
    ).toBe(true);
    const written: unknown = JSON.parse(
      file(root, `${FOLDER}/phone-front.scramble.frames.json`)?.text ?? '',
    );
    expect(validateFrames(written), JSON.stringify(validateFrames.errors)).toBe(true);
    expect(clip.file).toBe('phone-front.scramble.mp4');
  });

  it('pads the attempt folder to four digits and makes it, next to the attempt.json already there', async () => {
    const root = await withSession({ syncAccessHandle: true });
    await root.plant(`sessions/${SESSION}/attempts/0012/attempt.json`, '{"index":12}');

    await write(root, mp4Bytes(), FRAMES, 12);
    await write(root, mp4Bytes(), FRAMES, 1);

    expect([...root.files().keys()].sort()).toEqual([
      `sessions/${SESSION}/attempts/0001/laptop.solve.frames.json`,
      `sessions/${SESSION}/attempts/0001/laptop.solve.mp4`,
      `sessions/${SESSION}/attempts/0012/attempt.json`,
      `sessions/${SESSION}/attempts/0012/laptop.solve.frames.json`,
      `sessions/${SESSION}/attempts/0012/laptop.solve.mp4`,
      `sessions/${SESSION}/session.json`,
    ]);
    expect(file(root, `sessions/${SESSION}/attempts/0012/attempt.json`)?.text).toBe('{"index":12}');
  });

  it('replaces a clip saved again as a whole, a shorter MP4 included, and removes what writes cut short left', async () => {
    const root = await withSession({ syncAccessHandle: true });
    await write(root, mp4Bytes(9_000, 1));
    await root.plant(`${FOLDER}/laptop.solve.mp4.k3v9x0qa.tmp`, 'cut short');
    await root.plant(`${FOLDER}/laptop.solve.frames.json.00000000.tmp`, '');
    await root.plant(`${FOLDER}/laptop.scramble.mp4.k3v9x0qa.tmp`, 'another clip');
    const shorter = mp4Bytes(100, 2);

    const clip = await write(root, shorter, { ...FRAMES, dtMs: [0, 33.3] });

    expect(same(file(root, `${FOLDER}/laptop.solve.mp4`)?.bytes, shorter)).toBe(true);
    expect(clip).toMatchObject({ bytes: 100, frames: 2 });
    // The temporary files of this clip are gone; another clip's is not this write's business.
    expect(temporaryFiles(root)).toEqual([`${FOLDER}/laptop.scramble.mp4.k3v9x0qa.tmp`]);
  });

  it('refuses names that cannot be a clip, frames of another clip, an empty MP4, a frame rate of 0', async () => {
    const root = await withSession();
    const mp4 = mp4Bytes(10);
    const attempt = (
      overrides: Partial<{
        sessionId: string;
        index: number;
        camera: string;
        segment: 'scramble' | 'solve';
        mp4: ArrayBuffer;
        frames: FramesJson;
        details: ClipDetails;
      }>,
    ) => {
      const args = {
        sessionId: SESSION,
        index: 1,
        ...FRAMES,
        mp4,
        frames: FRAMES,
        details: DETAILS,
        ...overrides,
      };
      return writeClip(
        root,
        args.sessionId,
        args.index,
        args.camera,
        args.segment,
        args.mp4,
        args.frames,
        args.details,
      );
    };

    await expect(attempt({ camera: 'Laptop' })).rejects.toThrow(RangeError);
    await expect(attempt({ camera: 'laptop.1' })).rejects.toThrow(
      '"laptop.1" is not a camera label',
    );
    await expect(attempt({ segment: 'inspection' as 'solve' })).rejects.toThrow(
      '"inspection" is not a segment',
    );
    await expect(attempt({ index: 0 })).rejects.toThrow(
      "An attempt's index is a positive integer, got 0.",
    );
    await expect(attempt({ sessionId: '..' })).rejects.toThrow(
      '".." cannot name a session folder.',
    );
    await expect(attempt({ sessionId: 'a/b' })).rejects.toThrow(RangeError);
    await expect(attempt({ segment: 'scramble' })).rejects.toThrow(
      'The frames are those of laptop.solve, not of laptop.scramble.',
    );
    await expect(attempt({ mp4: new ArrayBuffer(0) })).rejects.toThrow('The MP4 is empty.');
    await expect(attempt({ details: { ...DETAILS, fpsNominal: 0 } })).rejects.toThrow(
      'The nominal frame rate must be positive, got 0.',
    );
    expect([...root.files().keys()]).toEqual([`sessions/${SESSION}/session.json`]);
  });

  it('refuses a session whose folder is missing, and makes none', async () => {
    const root = new FakeDirectoryHandle();
    await expect(write(root)).rejects.toThrow(`No session ${SESSION}: its folder is missing.`);
    await root.plant('sessions/other/session.json', '{}');
    await expect(write(root)).rejects.toThrow(`No session ${SESSION}: its folder is missing.`);
    expect(root.directories()).toEqual(['sessions', 'sessions/other']);
  });

  it('keeps the previous clip when a write fails (a full disk), and leaves no temporary file', async () => {
    const root = await withSession({ syncAccessHandle: true });
    const first = mp4Bytes(500, 3);
    await write(root, first);
    const full = new DOMException('The disk is full.', 'QuotaExceededError');
    root.failWritesWith = full;

    await expect(write(root, mp4Bytes(600, 4), { ...FRAMES, dtMs: [0] })).rejects.toBe(full);

    expect(same(file(root, `${FOLDER}/laptop.solve.mp4`)?.bytes, first)).toBe(true);
    expect(JSON.parse(file(root, `${FOLDER}/laptop.solve.frames.json`)?.text ?? '')).toEqual(
      FRAMES,
    );
    expect(temporaryFiles(root)).toEqual([]);
    expect([...root.files().values()].some((f) => f.locked)).toBe(false);
  });

  it('writes in place where file handles have no move() (Chrome before 111)', async () => {
    const root = await withSession({ move: false, syncAccessHandle: true });
    const mp4 = mp4Bytes();

    await write(root, mp4);

    expect(same(file(root, `${FOLDER}/laptop.solve.mp4`)?.bytes, mp4)).toBe(true);
    expect(file(root, `${FOLDER}/laptop.solve.frames.json`)?.text).toBe(
      `${JSON.stringify(FRAMES)}\n`,
    );
    expect(temporaryFiles(root)).toEqual([]);
  });
});

describe('writeClip, when the page goes away in the middle of a write', () => {
  it.each([
    ['through an access handle', { syncAccessHandle: true }],
    ['through a writable stream', { syncAccessHandle: false }],
  ])(
    '%s: cut off at any point, it leaves no half file and never an MP4 without its frames; the next write completes',
    async (_how, options: FakeOpfsOptions) => {
      const old = mp4Bytes(400, 5);
      const oldFrames: FramesJson = { ...FRAMES, dtMs: [0, 33.3, 33.4] };
      const mp4 = mp4Bytes(500, 6);
      const oldJson = `${JSON.stringify(oldFrames)}\n`;
      const newJson = `${JSON.stringify(FRAMES)}\n`;
      let cuts = 0;
      for (const before of [false, true]) {
        for (let operations = 0; ; operations++) {
          const root = await withSession(options);
          if (before) {
            await write(root, old, oldFrames);
          }
          root.interruptAfter(operations);
          void write(root, mp4);
          await flush();
          const cut = root.interrupted;
          root.resume();

          const video = file(root, `${FOLDER}/laptop.solve.mp4`)?.bytes;
          const frames = file(root, `${FOLDER}/laptop.solve.frames.json`)?.text;
          // Each file is absent, or whole: its previous content or the new one.
          expect([undefined, ...(before ? [oldJson] : []), newJson]).toContainEqual(frames);
          const videoIs = (bytes: ArrayBuffer): boolean => same(video, bytes);
          expect(video === undefined || videoIs(mp4) || (before && videoIs(old))).toBe(true);
          // The frames file moves into place first: a new MP4 never comes without its frames.
          if (video !== undefined && videoIs(mp4)) {
            expect(frames).toBe(newJson);
          }
          if (!before) {
            expect(video === undefined || frames !== undefined).toBe(true);
          }
          if (!cut) {
            expect(videoIs(mp4)).toBe(true);
            expect(frames).toBe(newJson);
            expect(temporaryFiles(root)).toEqual([]);
            break;
          }
          cuts++;
          // The next page writes the clip again: whole, and without the leftovers.
          await write(root, mp4);
          expect(same(file(root, `${FOLDER}/laptop.solve.mp4`)?.bytes, mp4)).toBe(true);
          expect(file(root, `${FOLDER}/laptop.solve.frames.json`)?.text).toBe(newJson);
          expect(temporaryFiles(root)).toEqual([]);
        }
      }
      // Every point of both writes was tried.
      expect(cuts).toBeGreaterThan(20);
    },
  );
});

describe('deleteClip', () => {
  it('removes the MP4, its frames.json and their temporary files, and leaves the rest of the folder', async () => {
    const root = await withSession({ syncAccessHandle: true });
    await root.plant(`${FOLDER}/attempt.json`, '{}');
    await write(root);
    await write(root, mp4Bytes(), { ...FRAMES, segment: 'scramble' });
    await root.plant(`${FOLDER}/laptop.solve.mp4.k3v9x0qa.tmp`, 'cut short');
    await root.plant(`${FOLDER}/laptop.solve.frames.json.abcdefgh.tmp`, 'cut short');

    await deleteClip(root, SESSION, 7, 'laptop', 'solve');

    expect([...root.files().keys()].sort()).toEqual([
      `${FOLDER}/attempt.json`,
      `${FOLDER}/laptop.scramble.frames.json`,
      `${FOLDER}/laptop.scramble.mp4`,
      `sessions/${SESSION}/session.json`,
    ]);
  });

  it('is done when there is nothing to remove: the clip, the attempt or the session gone', async () => {
    const root = await withSession();
    await deleteClip(root, SESSION, 7, 'laptop', 'solve');
    await deleteClip(root, 'gone', 1, 'laptop', 'solve');
    await deleteClip(new FakeDirectoryHandle(), SESSION, 1, 'laptop', 'solve');
    expect([...root.files().keys()]).toEqual([`sessions/${SESSION}/session.json`]);
    await expect(deleteClip(root, SESSION, 7, 'laptop', 'inspection' as 'solve')).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects when a file is being written (Chrome refuses to remove it)', async () => {
    const root = await withSession({ syncAccessHandle: true });
    await write(root);
    const mp4 = file(root, `${FOLDER}/laptop.solve.mp4`);
    const access = await mp4?.createSyncAccessHandle?.();

    await expect(deleteClip(root, SESSION, 7, 'laptop', 'solve')).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    });
    access?.close();
    await deleteClip(root, SESSION, 7, 'laptop', 'solve');
    expect([...root.files().keys()]).toEqual([`sessions/${SESSION}/session.json`]);
  });
});

describe('deleteClipIf', () => {
  it('removes the clip while its frames file says the first frame asked for, and only then', async () => {
    const root = await withSession({ syncAccessHandle: true });
    await root.plant(`${FOLDER}/attempt.json`, '{}');
    await write(root);

    // A newer clip of the same name (the next attempt with this index) stays.
    expect(await deleteClipIf(root, SESSION, 7, 'laptop', 'solve', FRAMES.t0HostMs + 1)).toBe(
      false,
    );
    expect(file(root, `${FOLDER}/laptop.solve.mp4`)).toBeDefined();

    expect(await deleteClipIf(root, SESSION, 7, 'laptop', 'solve', FRAMES.t0HostMs)).toBe(true);
    expect([...root.files().keys()].sort()).toEqual([
      `${FOLDER}/attempt.json`,
      `sessions/${SESSION}/session.json`,
    ]);
  });

  it('removes nothing when the frames file is missing or unreadable, or the folder is gone', async () => {
    const root = await withSession();
    expect(await deleteClipIf(root, SESSION, 7, 'laptop', 'solve', FRAMES.t0HostMs)).toBe(false);
    expect(await deleteClipIf(root, 'gone', 7, 'laptop', 'solve', FRAMES.t0HostMs)).toBe(false);
    await root.plant(`${FOLDER}/laptop.solve.frames.json`, 'not JSON');
    await root.plant(`${FOLDER}/laptop.solve.mp4`, 'an MP4');
    expect(await deleteClipIf(root, SESSION, 7, 'laptop', 'solve', FRAMES.t0HostMs)).toBe(false);
    expect(file(root, `${FOLDER}/laptop.solve.mp4`)).toBeDefined();
    await expect(
      deleteClipIf(root, SESSION, 7, 'Laptop', 'solve', FRAMES.t0HostMs),
    ).rejects.toThrow(RangeError);
  });
});
