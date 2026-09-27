import * as storage from '@cubetrace/storage';
import { describe, expect, it } from 'vitest';

import {
  ATTEMPTS_FOLDER,
  CAMERA_LABEL,
  SESSIONS_FOLDER,
  attemptFolder,
  attemptPath,
  clipFiles,
  isTemporaryOf,
  temporaryName,
} from './clip-files';

describe('clipFiles', () => {
  it('names the MP4 and the frames file after the camera and the segment', () => {
    expect(clipFiles('laptop', 'solve')).toEqual({
      file: 'laptop.solve.mp4',
      framesFile: 'laptop.solve.frames.json',
    });
    expect(clipFiles('phone-2', 'scramble')).toEqual({
      file: 'phone-2.scramble.mp4',
      framesFile: 'phone-2.scramble.frames.json',
    });
  });

  it('refuses a label that is not a camera label, and another segment', () => {
    for (const label of ['', 'Laptop', 'laptop.1', 'phone-', '-phone', 'office laptop', '../x']) {
      expect(CAMERA_LABEL.test(label), label).toBe(false);
      expect(() => clipFiles(label, 'solve'), label).toThrow(RangeError);
    }
    expect(() => clipFiles('laptop', 'inspection' as 'solve')).toThrow(
      '"inspection" is not a segment (scramble or solve).',
    );
  });
});

describe('the folders and temporary files of a clip', () => {
  it('are in the folder of the attempt', () => {
    expect(attemptPath('3f1c', 7)).toEqual(['sessions', '3f1c', 'attempts', '0007']);
    expect(() => attemptPath('3f1c', 0)).toThrow(RangeError);
  });

  it("are the session store's", () => {
    expect(SESSIONS_FOLDER).toBe(storage.SESSIONS_FOLDER);
    expect(ATTEMPTS_FOLDER).toBe(storage.ATTEMPTS_FOLDER);
    for (const index of [1, 17, 9999, 12_345]) {
      expect(attemptFolder(index)).toBe(storage.attemptFolder(index));
    }
    for (const index of [0, -1, 1.5, Number.NaN]) {
      expect(() => attemptFolder(index)).toThrow(RangeError);
      expect(() => storage.attemptFolder(index)).toThrow(RangeError);
    }
    const name = 'laptop.solve.mp4';
    for (let draw = 0; draw < 50; draw += 1) {
      const ours = temporaryName(name);
      expect(ours).toMatch(/^laptop\.solve\.mp4\.[0-9a-z]{8}\.tmp$/);
      expect(storage.isTemporaryOf(ours, name)).toBe(true);
      expect(isTemporaryOf(storage.temporaryName(name), name)).toBe(true);
    }
    for (const other of [name, 'laptop.solve.mp4.tmp', 'laptop.solve.frames.json.k3v9x0qa.tmp']) {
      expect(isTemporaryOf(other, name)).toBe(storage.isTemporaryOf(other, name));
      expect(isTemporaryOf(other, name)).toBe(false);
    }
  });
});
