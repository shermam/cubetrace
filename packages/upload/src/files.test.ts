import { recordJson } from '@cubetrace/storage';
import { describe, expect, it } from 'vitest';

import {
  attemptText,
  attemptUploadFiles,
  datasetAttempt,
  kindOf,
  sessionText,
  textHash,
  utf8Bytes,
} from './files';
import { A, GYRO, attempt, clip, session } from './test-device';

describe('the files of an attempt', () => {
  it('are attempt.json, then each clip and its frames file, then the gyro file when there is one (T3.7)', () => {
    const files = attemptUploadFiles(attempt(A, 1, [clip('scramble', 10), clip('solve', 20)]));
    expect(files.map((file) => [file.path, file.kind])).toEqual([
      ['attempt.json', 'attempt'],
      ['laptop.scramble.mp4', 'clip'],
      ['laptop.scramble.frames.json', 'frames'],
      ['laptop.solve.mp4', 'clip'],
      ['laptop.solve.frames.json', 'frames'],
    ]);
    expect(files.map((file) => kindOf(file.path))).toEqual(files.map((file) => file.kind));
    expect(kindOf('session.json')).toBe('session');
    const withGyro = attemptUploadFiles({
      ...attempt(A, 1, [clip('scramble', 10), clip('solve', 20)]),
      gyro: GYRO,
    });
    expect(withGyro.map((file) => [file.path, file.kind, file.clip])).toEqual([
      ...files.map((file) => [file.path, file.kind, file.clip]),
      ['gyro.json', 'gyro', null],
    ]);
    expect(kindOf('gyro.json')).toBe('gyro');
  });

  it("upload attempt.json without the clips' local, as the store writes it", () => {
    const record = attempt(A, 1, [clip('scramble', 10), clip('solve', 20)]);
    const gone = { ...record, video: record.video.map((c) => ({ ...c, local: false })) };
    expect(datasetAttempt(gone)).toEqual(record);
    expect(attemptText(gone)).toBe(recordJson(record));
    expect(textHash(attemptText(gone))).toBe(textHash(attemptText(record)));
    expect(sessionText(session(A, 1))).toBe(recordJson(session(A, 1)));
  });

  it('tell a changed text by its hash and count its bytes in UTF-8', () => {
    expect(textHash('a')).not.toBe(textHash('b'));
    expect(textHash('ab')).not.toBe(textHash('ba'));
    expect(textHash('')).toMatch(/^[0-9a-f]{16}$/);
    expect(utf8Bytes('a×b')).toBe(4);
  });
});
