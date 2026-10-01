import { HttpsError } from 'firebase-functions/https';
import { describe, expect, it } from 'vitest';

import {
  MAX_FILES_PER_CALL,
  attemptFolder,
  contentTypeOf,
  objectKey,
  parseConfirmRequest,
  parseSignRequest,
} from './files.js';

const sessionId = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const MAX = 512_000_000;

/** A request of `signUpload` for attempt 1 with these files. */
function sign(files: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { sessionId, attemptIndex: 1, files, ...extra };
}

function refusal(run: () => unknown): HttpsError {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpsError) {
      return error;
    }
    throw error;
  }
  throw new Error('Nothing was refused.');
}

describe('the files of the dataset', () => {
  it.each([
    ['attempt.json', 'application/json'],
    ['session.json', 'application/json'],
    ['laptop.solve.mp4', 'video/mp4'],
    ['laptop.scramble.mp4', 'video/mp4'],
    ['phone-front.solve.frames.json', 'application/json'],
    ['phone-2.scramble.frames.json', 'application/json'],
  ])('takes %s as %s', (path, type) => {
    expect(contentTypeOf(path)).toBe(type);
  });

  it.each([
    'frames.json',
    'laptop.mp4',
    'laptop.warmup.mp4',
    'laptop.solve.webm',
    'Laptop.solve.mp4',
    'phone_front.solve.mp4',
    '-laptop.solve.mp4',
    'laptop-.solve.mp4',
    'laptop.solve.mp4.tmp',
    'attempt.json.1a2b.tmp',
    '../attempt.json',
    'attempts/0001/attempt.json',
    '0001/laptop.solve.mp4',
    'uploads.json',
    '',
    `${'a'.repeat(120)}.solve.mp4`,
  ])('refuses %j', (path) => {
    expect(contentTypeOf(path)).toBeNull();
  });

  it("puts an attempt's files in its folder, and the session's file in the session's", () => {
    const ref = { sessionId, attemptIndex: 17 };
    expect(objectKey('alice', ref, 'laptop.solve.mp4')).toBe(
      `users/alice/sessions/${sessionId}/attempts/0017/laptop.solve.mp4`,
    );
    expect(objectKey('alice', ref, 'attempt.json')).toBe(
      `users/alice/sessions/${sessionId}/attempts/0017/attempt.json`,
    );
    expect(objectKey('alice', ref, 'session.json')).toBe(
      `users/alice/sessions/${sessionId}/session.json`,
    );
  });

  it('names attempt folders as the session store does', () => {
    expect([1, 17, 999, 9999, 12345].map(attemptFolder)).toEqual([
      '0001',
      '0017',
      '0999',
      '9999',
      '12345',
    ]);
  });
});

describe('parseSignRequest', () => {
  it("reads an attempt's files", () => {
    const files = [
      { path: 'attempt.json', bytes: 18_220, contentType: 'application/json' },
      { path: 'laptop.solve.mp4', bytes: 23_734_012, contentType: 'video/mp4' },
      { path: 'laptop.solve.frames.json', bytes: 41_003, contentType: 'application/json' },
      { path: 'session.json', bytes: 4_100, contentType: 'application/json' },
    ];
    expect(parseSignRequest(sign(files), MAX)).toEqual({ sessionId, attemptIndex: 1, files });
  });

  it('keeps only what it reads of each file', () => {
    const request = parseSignRequest(
      sign([{ path: 'attempt.json', bytes: 10, contentType: 'application/json', extra: true }]),
      MAX,
    );
    expect(request.files).toEqual([
      { path: 'attempt.json', bytes: 10, contentType: 'application/json' },
    ]);
  });

  it.each([
    ['nothing', undefined],
    ['a list', []],
    ['text', 'attempt.json'],
    ['no session', { attemptIndex: 1, files: [] }],
    ['a session id in capitals', sign([], { sessionId: sessionId.toUpperCase() })],
    ['a session id that is a path', sign([], { sessionId: `${sessionId}/../x` })],
    ['an attempt index of 0', sign([], { attemptIndex: 0 })],
    ['an attempt index of 1.5', sign([], { attemptIndex: 1.5 })],
    ['an attempt index in text', sign([], { attemptIndex: '1' })],
  ])('refuses %s', (_, data) => {
    const file = { path: 'attempt.json', bytes: 1, contentType: 'application/json' };
    const withFile =
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? { ...data, files: [file] }
        : data;
    expect(refusal(() => parseSignRequest(withFile, MAX)).code).toBe('invalid-argument');
  });

  it.each([
    ['no files', []],
    ['files that are not a list', { path: 'attempt.json' }],
    ['a file that is not an object', ['attempt.json']],
    [
      'a file the dataset does not have',
      [{ path: 'notes.txt', bytes: 1, contentType: 'application/json' }],
    ],
    ['an empty file', [{ path: 'attempt.json', bytes: 0, contentType: 'application/json' }]],
    ['a size in text', [{ path: 'attempt.json', bytes: '10', contentType: 'application/json' }]],
    ['a fractional size', [{ path: 'attempt.json', bytes: 1.5, contentType: 'application/json' }]],
    [
      'a file over the ceiling',
      [{ path: 'laptop.solve.mp4', bytes: MAX + 1, contentType: 'video/mp4' }],
    ],
    ['a clip as JSON', [{ path: 'laptop.solve.mp4', bytes: 10, contentType: 'application/json' }]],
    ['JSON as a clip', [{ path: 'attempt.json', bytes: 10, contentType: 'video/mp4' }]],
    ['JSON as text', [{ path: 'attempt.json', bytes: 10, contentType: 'text/plain' }]],
    ['a file without a type', [{ path: 'attempt.json', bytes: 10 }]],
    [
      'a file named twice',
      [
        { path: 'attempt.json', bytes: 10, contentType: 'application/json' },
        { path: 'attempt.json', bytes: 11, contentType: 'application/json' },
      ],
    ],
    [
      'too many files',
      Array.from({ length: MAX_FILES_PER_CALL + 1 }, (_, i) => ({
        path: `camera-${String(i)}.solve.mp4`,
        bytes: 10,
        contentType: 'video/mp4',
      })),
    ],
  ])('refuses %s', (_, files) => {
    const error = refusal(() => parseSignRequest({ sessionId, attemptIndex: 1, files }, MAX));
    expect(error.code).toBe('invalid-argument');
    expect(error.message).toMatch(/files/);
  });

  it('takes a file of exactly the ceiling, and the most files a call may have', () => {
    const files = Array.from({ length: MAX_FILES_PER_CALL }, (_, i) => ({
      path: `camera-${String(i)}.solve.mp4`,
      bytes: MAX,
      contentType: 'video/mp4',
    }));
    expect(parseSignRequest(sign(files), MAX).files).toHaveLength(MAX_FILES_PER_CALL);
  });
});

describe('parseConfirmRequest', () => {
  it('reads the paths of the files to confirm', () => {
    expect(
      parseConfirmRequest({
        sessionId,
        attemptIndex: 3,
        files: [{ path: 'attempt.json' }, { path: 'laptop.solve.mp4', bytes: 12 }],
      }),
    ).toEqual({ sessionId, attemptIndex: 3, paths: ['attempt.json', 'laptop.solve.mp4'] });
  });

  it.each([
    ['no files', []],
    ['a path the dataset does not have', [{ path: 'x.txt' }]],
    ['a bare name', ['attempt.json']],
    ['a file named twice', [{ path: 'attempt.json' }, { path: 'attempt.json' }]],
  ])('refuses %s', (_, files) => {
    const error = refusal(() => parseConfirmRequest({ sessionId, attemptIndex: 1, files }));
    expect(error.code).toBe('invalid-argument');
  });
});
