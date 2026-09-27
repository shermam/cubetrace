// The OPFS store's own behaviour, over the in-memory file system of fake-opfs.ts: the file layout of
// docs/DATA-MODEL.md §5, the JSON it writes, the order of its operations, what a page that goes
// away in the middle of a write leaves, and what it does with files it did not write or cannot
// read. The semantics it shares with MemorySessionStore are in session-store-contract.test.ts.
import { describe, expect, it } from 'vitest';

import { FakeDirectoryHandle, FakeFileHandle } from './fake-opfs';
import { opfsAvailable } from './opfs';
import { OpfsSessionStore, attemptFolder, describeProblem } from './opfs-session-store';
import { A, B, C, attempt, session } from './test-records';

function setup(): { root: FakeDirectoryHandle; store: OpfsSessionStore } {
  const root = new FakeDirectoryHandle();
  return { root, store: new OpfsSessionStore(root) };
}

/** The file at `path` in `root`; fails the test if it is missing. */
function file(root: FakeDirectoryHandle, path: string): FakeFileHandle {
  const found = root.files().get(path);
  if (found === undefined) {
    throw new Error(`No file ${path}.`);
  }
  return found;
}

/** The paths of the temporary files below `root`. */
function temporaryFiles(root: FakeDirectoryHandle): string[] {
  return [...root.files().keys()].filter((path) => path.endsWith('.tmp'));
}

/** Lets every pending promise of the fake settle: it never waits for a timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('attemptFolder', () => {
  it('pads the 1-based index to four digits', () => {
    expect([1, 17, 999, 9999, 12345].map(attemptFolder)).toEqual([
      '0001',
      '0017',
      '0999',
      '9999',
      '12345',
    ]);
  });

  it('refuses anything but a positive integer', () => {
    for (const index of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => attemptFolder(index)).toThrow(RangeError);
    }
  });
});

describe('opfsAvailable', () => {
  it('needs navigator.storage.getDirectory', () => {
    expect(opfsAvailable(undefined)).toBe(false);
    expect(opfsAvailable({})).toBe(false);
    expect(opfsAvailable({ storage: {} })).toBe(false);
    expect(opfsAvailable({ storage: { getDirectory: 'no' } })).toBe(false);
    const root = new FakeDirectoryHandle();
    expect(opfsAvailable({ storage: { getDirectory: () => Promise.resolve(root) } })).toBe(true);
  });
});

describe('OpfsSessionStore', () => {
  it('writes the files of docs/DATA-MODEL.md §5', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await store.saveAttempt(attempt(A, 1));
    await store.saveAttempt(attempt(A, 17));
    await store.createSession(session(B, 2000));

    expect([...root.files().keys()].sort()).toEqual([
      `sessions/${A}/attempts/0001/attempt.json`,
      `sessions/${A}/attempts/0017/attempt.json`,
      `sessions/${A}/session.json`,
      `sessions/${B}/session.json`,
    ]);
  });

  it('writes indented JSON that parses back to the record, numbers exact', async () => {
    const { root, store } = setup();
    const s = { ...session(A, 1730640000123.456), notes: 'naïve “quotes” ✓' };
    const a = attempt(A, 1);
    await store.createSession(s);
    await store.saveAttempt(a);

    const sessionText = file(root, `sessions/${A}/session.json`).text;
    expect(sessionText).toBe(`${JSON.stringify(s, null, 2)}\n`);
    expect(JSON.parse(sessionText)).toEqual(s);
    expect(JSON.parse(file(root, `sessions/${A}/attempts/0001/attempt.json`).text)).toEqual(a);
    expect(a.moves[0].hostMs).toBe(50.25);
    expect(await store.exportSession(A)).toEqual({ session: s, attempts: [a] });
  });

  it('replaces a file as a whole when a record is saved again', async () => {
    const { root, store } = setup();
    await store.createSession({ ...session(A, 1000), notes: 'a long note that is written first' });
    await store.saveSession(session(A, 1000));
    expect(JSON.parse(file(root, `sessions/${A}/session.json`).text)).toEqual(session(A, 1000));
  });

  it('removes the session folder on deleteSession and the attempt folder on deleteAttempt', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await store.createSession(session(B, 2000));
    await store.saveAttempt(attempt(A, 1));
    await store.saveAttempt(attempt(A, 2));

    await store.deleteAttempt(A, 2);
    expect(root.directories()).not.toContain(`sessions/${A}/attempts/0002`);
    expect(root.directories()).toContain(`sessions/${A}/attempts/0001`);

    await store.deleteSession(A);
    expect(root.directories().filter((path) => path.includes(A))).toEqual([]);
    expect([...root.files().keys()]).toEqual([`sessions/${B}/session.json`]);
  });

  it('runs the operations in the order they were called', async () => {
    const { root, store } = setup();
    const first = { ...session(A, 1000), notes: 'first' };
    const second = { ...session(A, 1000), notes: 'second' };
    // Not awaited one by one: each waits for the one before.
    const done = Promise.all([
      store.createSession(session(A, 1000)),
      store.saveAttempt(attempt(A, 1)),
      store.saveSession(first),
      store.saveSession(second),
      store.saveAttempt(attempt(A, 2)),
    ]);
    const listed = store.listSessions();
    await done;
    expect((await listed)[0].notes).toBe('second');
    expect(JSON.parse(file(root, `sessions/${A}/session.json`).text)).toEqual(second);
    expect((await store.loadAttempts(A)).map((a) => a.index)).toEqual([1, 2]);
  });

  it('goes on after an operation that failed', async () => {
    const { store } = setup();
    const failed = store.saveSession(session(A, 1000));
    const created = store.createSession(session(A, 1000));
    await expect(failed).rejects.toThrow(/No session/);
    await created;
    expect(await store.listSessions()).toEqual([session(A, 1000)]);
  });

  it('rejects a bad attempt index or session id when called, without touching the files', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await expect(store.saveAttempt({ ...attempt(A, 1), index: 1.5 })).rejects.toThrow(RangeError);
    await expect(store.createSession({ ...session(A, 1000), id: '../x' })).rejects.toThrow(
      /cannot name a session folder/,
    );
    await expect(store.loadAttempts('..')).rejects.toThrow(/No session/);
    await store.deleteSession('a/b');
    expect([...root.files().keys()]).toEqual([`sessions/${A}/session.json`]);
  });

  it('keeps the old content when a write fails, closes the stream and removes the temporary file', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    const before = file(root, `sessions/${A}/session.json`).text;
    root.failWritesWith = new DOMException('The disk is full.', 'QuotaExceededError');

    await expect(store.saveSession({ ...session(A, 1000), notes: 'lost' })).rejects.toThrow(
      'The disk is full.',
    );
    // The fake refuses to remove a file whose stream is open: the stream was closed first.
    expect([...root.files().keys()]).toEqual([`sessions/${A}/session.json`]);
    expect(file(root, `sessions/${A}/session.json`).text).toBe(before);
    expect(file(root, `sessions/${A}/session.json`).openWritables).toBe(0);
  });

  it('removes the temporary file when it cannot be moved into place', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    // A folder where attempt 1's file goes: Chrome refuses the move.
    await root.plant(`sessions/${A}/attempts/0001/attempt.json/clip.mp4`, 'video');

    await expect(store.saveAttempt(attempt(A, 1))).rejects.toMatchObject({
      name: 'InvalidModificationError',
    });
    expect(temporaryFiles(root)).toEqual([]);
  });

  it('writes in place where file handles have no move() (Chrome before 111)', async () => {
    const root = new FakeDirectoryHandle('', { move: false });
    const store = new OpfsSessionStore(root);
    const noted = { ...session(A, 1000), notes: 'saved again' };
    await store.createSession(session(A, 1000));
    await store.saveSession(noted);
    await store.saveAttempt(attempt(A, 1));

    expect([...root.files().keys()].sort()).toEqual([
      `sessions/${A}/attempts/0001/attempt.json`,
      `sessions/${A}/session.json`,
    ]);
    expect(await store.exportSession(A)).toEqual({ session: noted, attempts: [attempt(A, 1)] });
  });

  it('ignores folders and files that are not records, and starts a session over a leftover folder', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await root.plant('sessions/notes.txt', 'not a session');
    await root.plant(`sessions/${B}/attempts/0001/attempt.json`, JSON.stringify(attempt(B, 1)));
    await root.plant(`sessions/${A}/attempts/0002/clip.mp4`, 'video without attempt.json');
    await root.plant(`sessions/${A}/attempts/thumbs/x.json`, '{}');

    expect((await store.listSessions()).map((s) => s.id)).toEqual([A]);
    expect(await store.loadAttempts(A)).toEqual([]);
    // B's folder has no session.json: B is not a session, and a new B starts empty.
    await store.createSession(session(B, 2000));
    expect(await store.loadAttempts(B)).toEqual([]);
    expect(await store.listProblems()).toEqual([]);
  });

  it('ignores the temporary files that writes cut short leave, and removes them', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await store.saveAttempt(attempt(A, 1));
    await root.plant(`sessions/${A}/session.json.k3v9x0qa.tmp`, '{"schema": 1, "id": "');
    await root.plant(`sessions/${A}/attempts/0001/attempt.json.00000000.tmp`, '');
    // Complete, but never moved into place: attempt 2 and session B were not saved.
    await root.plant(
      `sessions/${A}/attempts/0002/attempt.json.zz9zz9zz.tmp`,
      JSON.stringify(attempt(A, 2)),
    );
    await root.plant(`sessions/${B}/session.json.a0b1c2d3.tmp`, JSON.stringify(session(B, 2000)));
    // Not a temporary file of a record: left alone.
    await root.plant(`sessions/${A}/attempts/0001/notes.tmp`, 'kept');

    expect(await store.listSessions()).toEqual([session(A, 1000)]);
    expect(await store.loadAttempts(A)).toEqual([attempt(A, 1)]);
    expect(await store.listProblems()).toEqual([]);
    expect([...root.files().keys()].sort()).toEqual([
      `sessions/${A}/attempts/0001/attempt.json`,
      `sessions/${A}/attempts/0001/notes.tmp`,
      `sessions/${A}/session.json`,
    ]);
  });

  it('sets aside a session.json that is empty, not JSON or not its folder’s session, and lists the others', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await store.saveAttempt(attempt(A, 1));
    await root.plant(`sessions/${B}/session.json`, '');
    await root.plant(`sessions/${C}/session.json`, '{"schema": 1, "id": "');
    await root.plant('sessions/x/session.json', JSON.stringify(session(A, 1000)));
    await root.plant('sessions/y/session.json/z', '{}');

    expect(await store.listSessions()).toEqual([session(A, 1000)]);
    const problems = await store.listProblems();
    expect(problems).toEqual([
      {
        sessionId: C,
        kind: 'session',
        path: `sessions/${C}/session.json`,
        reason: expect.stringMatching(/^not JSON \(.+\)$/) as unknown,
      },
      { sessionId: B, kind: 'session', path: `sessions/${B}/session.json`, reason: 'empty' },
      {
        sessionId: 'x',
        kind: 'session',
        path: 'sessions/x/session.json',
        reason: 'not the session.json of session x',
      },
      { sessionId: 'y', kind: 'session', path: 'sessions/y/session.json', reason: 'not a file' },
    ]);
    expect(describeProblem(problems[1])).toBe(`sessions/${B}/session.json is empty.`);
    // The readable session is untouched.
    expect(await store.exportSession(A)).toEqual({
      session: session(A, 1000),
      attempts: [attempt(A, 1)],
    });
  });

  it('rejects the operations on a session whose session.json is unreadable, naming the file; deleteSession removes it', async () => {
    const { root, store } = setup();
    await root.plant(`sessions/${B}/session.json`, '');
    await root.plant(`sessions/${B}/attempts/0001/attempt.json`, JSON.stringify(attempt(B, 1)));
    const unreadable = `sessions/${B}/session.json is empty.`;

    await expect(store.exportSession(B)).rejects.toThrow(unreadable);
    await expect(store.loadAttempts(B)).rejects.toThrow(unreadable);
    await expect(store.saveSession(session(B, 2000))).rejects.toThrow(unreadable);
    await expect(store.saveAttempt(attempt(B, 2))).rejects.toThrow(unreadable);
    await expect(store.deleteAttempt(B, 1)).rejects.toThrow(unreadable);
    await expect(store.createSession(session(B, 2000))).rejects.toThrow(/exists already/);
    expect(await store.listSessions()).toEqual([]);
    expect((await store.listProblems()).map((p) => p.path)).toEqual([`sessions/${B}/session.json`]);

    await store.deleteSession(B);
    expect(root.directories()).toEqual(['sessions']);
    expect(await store.listProblems()).toEqual([]);
    expect(await store.listSessions()).toEqual([]);
  });

  it('leaves an unreadable attempt.json out of loadAttempts and exportSession, and reports it', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await store.saveAttempt(attempt(A, 1));
    await root.plant(`sessions/${A}/attempts/0002/attempt.json`, '');
    await root.plant(`sessions/${A}/attempts/0003/attempt.json`, JSON.stringify(attempt(A, 4)));
    await store.saveAttempt(attempt(A, 5));

    expect((await store.loadAttempts(A)).map((a) => a.index)).toEqual([1, 5]);
    expect(await store.listProblems()).toEqual([
      {
        sessionId: A,
        kind: 'attempt',
        path: `sessions/${A}/attempts/0002/attempt.json`,
        reason: 'empty',
      },
      {
        sessionId: A,
        kind: 'attempt',
        path: `sessions/${A}/attempts/0003/attempt.json`,
        reason: `not the attempt.json of attempt 3 of session ${A}`,
      },
    ]);
    expect(await store.exportSession(A)).toEqual({
      session: session(A, 1000),
      attempts: [attempt(A, 1), attempt(A, 5)],
    });

    // Saved again, attempt 2 is readable: the next read of the attempts no longer reports it.
    await store.saveAttempt(attempt(A, 2));
    expect((await store.loadAttempts(A)).map((a) => a.index)).toEqual([1, 2, 5]);
    expect((await store.listProblems()).map((p) => p.path)).toEqual([
      `sessions/${A}/attempts/0003/attempt.json`,
    ]);
    // A deleted attempt takes its problem with it.
    await store.deleteAttempt(A, 3);
    expect(await store.listProblems()).toEqual([]);
  });

  it('reads the records of schema version 1 as version 2, and leaves their files as they are', async () => {
    const { root, store } = setup();
    // As cubetrace 0.1 wrote them: schema 1, and an attempt without its clock fit.
    const oldSession = JSON.stringify({ ...session(A, 1000), schema: 1 }, null, 2);
    const oldAttempt = { ...attempt(A, 1), schema: 1, clock: undefined };
    await root.plant(`sessions/${A}/session.json`, oldSession);
    await root.plant(`sessions/${A}/attempts/0001/attempt.json`, JSON.stringify(oldAttempt));

    const upgraded = { ...attempt(A, 1), clock: null };
    expect(await store.listSessions()).toEqual([session(A, 1000)]);
    expect(await store.exportSession(A)).toEqual({
      session: session(A, 1000),
      attempts: [upgraded],
    });
    expect(await store.listProblems()).toEqual([]);
    expect(file(root, `sessions/${A}/session.json`).text).toBe(oldSession);

    // What the app saves next is version 2, next to the version 1 attempt.
    const saved = { ...session(A, 1000), summary: { attempts: 2, solved: 2, dnf: 0 } };
    await store.saveAttempt(attempt(A, 2));
    await store.saveSession(saved);
    const schemaOf = (path: string): unknown =>
      Reflect.get(JSON.parse(file(root, path).text), 'schema');
    expect(schemaOf(`sessions/${A}/session.json`)).toBe(2);
    expect(schemaOf(`sessions/${A}/attempts/0001/attempt.json`)).toBe(1);
    expect(schemaOf(`sessions/${A}/attempts/0002/attempt.json`)).toBe(2);
    expect(await store.exportSession(A)).toEqual({
      session: saved,
      attempts: [upgraded, attempt(A, 2)],
    });
  });

  it('sets aside a record that breaks the schema of its version, naming the field', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    const broken = attempt(A, 1);
    broken.moves[0].m = 'M';
    await root.plant(`sessions/${A}/attempts/0001/attempt.json`, JSON.stringify(broken));
    await root.plant(
      `sessions/${B}/session.json`,
      JSON.stringify({ ...session(B, 2000), summary: undefined }),
    );
    await root.plant(
      `sessions/${C}/session.json`,
      JSON.stringify({ ...session(C, 3000), schema: 3 }),
    );

    expect(await store.listSessions()).toEqual([session(A, 1000)]);
    expect(await store.loadAttempts(A)).toEqual([]);
    // Sorted by path: C, A and B's ids begin with 0, 3 and 9.
    expect((await store.listProblems()).map(describeProblem)).toEqual([
      `sessions/${C}/session.json is not a valid session.json (schema must be 1 or 2, got 3).`,
      `sessions/${A}/attempts/0001/attempt.json is not a valid attempt.json (moves[0].m must be a face turn such as R, U' or F2, got "M").`,
      `sessions/${B}/session.json is not a valid session.json (summary is missing).`,
    ]);
  });

  it('lists the problems that the latest reads found', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await root.plant(`sessions/${A}/attempts/0001/attempt.json`, '');
    await root.plant(`sessions/${B}/session.json`, '');
    expect(await store.listProblems()).toEqual([]);

    await store.loadAttempts(A);
    expect((await store.listProblems()).map((p) => p.sessionId)).toEqual([A]);
    // A listing replaces the sessions' problems, and keeps those of the attempts of the sessions
    // it lists.
    await store.listSessions();
    expect((await store.listProblems()).map((p) => p.sessionId)).toEqual([A, B]);
    await root.plant(`sessions/${B}/session.json`, JSON.stringify(session(B, 2000)));
    await store.listSessions();
    expect((await store.listProblems()).map((p) => p.sessionId)).toEqual([A]);
    // A session that is gone takes the problems of its attempts with it.
    await store.deleteSession(A);
    expect(await store.listProblems()).toEqual([]);
  });

  it('takes the root as a promise, and rejects every operation if it fails', async () => {
    const root = new FakeDirectoryHandle();
    const later = new OpfsSessionStore(Promise.resolve(root));
    await later.createSession(session(A, 1000));
    expect([...root.files().keys()]).toEqual([`sessions/${A}/session.json`]);

    const refused = new OpfsSessionStore(
      Promise.reject(new DOMException('Storage is blocked.', 'SecurityError')),
    );
    await expect(refused.listSessions()).rejects.toThrow('Storage is blocked.');
    await expect(refused.createSession(session(A, 1000))).rejects.toThrow('Storage is blocked.');
  });
});

describe('OpfsSessionStore, when the page goes away in the middle of a write', () => {
  const noted = { ...session(A, 1000), notes: 'saved again' };

  interface Case {
    /** The files before the write, made by an earlier page. */
    readonly before: (store: OpfsSessionStore) => Promise<void>;
    readonly write: (store: OpfsSessionStore) => Promise<void>;
    /** How the next page reads what the write changes. */
    readonly read: (store: OpfsSessionStore) => Promise<unknown>;
    readonly old: unknown;
    readonly new: unknown;
  }

  const cases: [string, Case][] = [
    [
      'createSession',
      {
        before: () => Promise.resolve(),
        write: (store) => store.createSession(session(A, 1000)),
        read: (store) => store.listSessions(),
        old: [],
        new: [session(A, 1000)],
      },
    ],
    [
      'saveSession',
      {
        before: (store) => store.createSession(session(A, 1000)),
        write: (store) => store.saveSession(noted),
        read: (store) => store.listSessions(),
        old: [session(A, 1000)],
        new: [noted],
      },
    ],
    [
      'saveAttempt of a new attempt',
      {
        before: (store) => store.createSession(session(A, 1000)),
        write: (store) => store.saveAttempt(attempt(A, 1)),
        read: (store) => store.loadAttempts(A),
        old: [],
        new: [attempt(A, 1)],
      },
    ],
    [
      'saveAttempt of an attempt saved before',
      {
        before: async (store) => {
          await store.createSession(session(A, 1000));
          await store.saveAttempt(attempt(A, 1));
        },
        write: (store) => store.saveAttempt(attempt(A, 1, true)),
        read: (store) => store.loadAttempts(A),
        old: [attempt(A, 1)],
        new: [attempt(A, 1, true)],
      },
    ],
  ];

  it.each(cases)(
    '%s: cut off at any point, the next page reads the previous record; completed, the new one',
    async (_name, c) => {
      let cuts = 0;
      for (let operations = 0; ; operations++) {
        const root = new FakeDirectoryHandle();
        await c.before(new OpfsSessionStore(root));
        root.interruptAfter(operations);
        // The page that writes: its operation never settles once the interruption has come.
        void c.write(new OpfsSessionStore(root));
        await flush();
        const cut = root.interrupted;
        root.resume();

        // The next page.
        const store = new OpfsSessionStore(root);
        expect(await c.read(store)).toEqual(cut ? c.old : c.new);
        expect(await store.listProblems()).toEqual([]);
        expect(temporaryFiles(root)).toEqual([]);
        if (!cut) {
          break;
        }
        cuts++;
      }
      // Every point of the write was tried, the stream's close() that never completes among them.
      expect(cuts).toBeGreaterThan(5);
    },
  );

  it('written in place (no move()), a write cut off can leave an empty file, which the reads set aside (issue #12)', async () => {
    const reasons: string[] = [];
    for (let operations = 0; ; operations++) {
      const root = new FakeDirectoryHandle('', { move: false });
      root.interruptAfter(operations);
      void new OpfsSessionStore(root).createSession(session(A, 1000));
      await flush();
      const cut = root.interrupted;
      root.resume();

      const store = new OpfsSessionStore(root);
      expect(await store.listSessions()).toEqual(cut ? [] : [session(A, 1000)]);
      reasons.push(...(await store.listProblems()).map((problem) => problem.reason));
      if (!cut) {
        break;
      }
    }
    expect(reasons).toContain('empty');
  });
});

describe('the OPFS fake', () => {
  it('rejects as Chrome does', async () => {
    const root = new FakeDirectoryHandle();
    await expect(root.getDirectoryHandle('missing')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    await expect(root.getFileHandle('missing')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(root.removeEntry('missing')).rejects.toMatchObject({ name: 'NotFoundError' });
    const dir = await root.getDirectoryHandle('dir', { create: true });
    await dir.getFileHandle('file', { create: true });
    await expect(root.getFileHandle('dir')).rejects.toMatchObject({ name: 'TypeMismatchError' });
    await expect(dir.getDirectoryHandle('file')).rejects.toMatchObject({
      name: 'TypeMismatchError',
    });
    await expect(root.removeEntry('dir')).rejects.toMatchObject({
      name: 'InvalidModificationError',
    });
    await expect(root.getDirectoryHandle('a/b', { create: true })).rejects.toThrow(TypeError);
    await root.removeEntry('dir', { recursive: true });
    const names: string[] = [];
    for await (const name of root.keys()) {
      names.push(name);
    }
    expect(names).toEqual([]);
  });

  it('replaces the content on close and keeps it on abort', async () => {
    const handle = await new FakeDirectoryHandle().getFileHandle('f', { create: true });
    const first = await handle.createWritable();
    await first.write('one');
    await first.write(' two');
    expect(handle.text).toBe('');
    await first.close();
    expect(await (await handle.getFile()).text()).toBe('one two');
    const second = await handle.createWritable();
    await second.write('three');
    await second.abort();
    expect(handle.text).toBe('one two');
    await expect(second.write('four')).rejects.toThrow(TypeError);
  });

  it('keeps bytes as they are written, and text as UTF-8', async () => {
    const handle = await new FakeDirectoryHandle().getFileHandle('f', { create: true });
    const writable = await handle.createWritable();
    await writable.write('é ');
    await writable.write(new Uint8Array([0, 255, 7]));
    await writable.write(new Uint8Array([1, 2, 3, 4]).subarray(1, 3));
    await writable.write(new Uint16Array([0x4241]).buffer);
    await writable.close();

    expect([...handle.bytes]).toEqual([0xc3, 0xa9, 0x20, 0, 255, 7, 2, 3, 0x41, 0x42]);
    const read = await handle.getFile();
    expect(read.size).toBe(10);
    expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([...handle.bytes]);
  });

  it('has access handles only where asked (a worker), which write in place and lock the file', async () => {
    const window = await new FakeDirectoryHandle().getFileHandle('f', { create: true });
    expect(window.createSyncAccessHandle).toBeUndefined();

    const dir = new FakeDirectoryHandle('', { syncAccessHandle: true });
    await dir.plant('f', 'old content');
    const handle = await dir.getFileHandle('f');
    const access = await handle.createSyncAccessHandle?.();
    if (access === undefined) {
      throw new Error('No access handle.');
    }
    access.truncate(3);
    expect(access.write(new TextEncoder().encode('ABC'), { at: 2 })).toBe(3);
    // In place: what was written is there before close() or flush().
    expect(handle.text).toBe('olABC');
    expect(access.getSize()).toBe(5);
    expect(handle.locked).toBe(true);
    await expect(handle.createWritable()).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    });
    await expect(handle.createSyncAccessHandle?.()).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    });
    await expect(dir.removeEntry('f')).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    });
    access.flush();
    access.close();
    expect(handle.locked).toBe(false);
    expect(() => access.write(new Uint8Array(1))).toThrow('The access handle is closed.');
    await dir.removeEntry('f');
  });

  it('cuts off an access handle with the page: what it wrote stays, its lock goes', async () => {
    const dir = new FakeDirectoryHandle('', { syncAccessHandle: true });
    const handle = await dir.getFileHandle('f', { create: true });
    const access = await handle.createSyncAccessHandle?.();
    if (access === undefined) {
      throw new Error('No access handle.');
    }
    dir.interruptAfter(1);
    access.write(new TextEncoder().encode('kept'));
    // From here on nothing happens, as if no code ran any more.
    expect(access.write(new TextEncoder().encode(' lost'), { at: 4 })).toBe(0);
    access.close();
    expect(dir.interrupted).toBe(true);
    expect(handle.openAccessHandle).toBe(true);

    dir.resume();
    expect(handle.text).toBe('kept');
    expect(handle.openAccessHandle).toBe(false);
  });

  it('moves a file over another in one step, and the handle takes the new name', async () => {
    const dir = new FakeDirectoryHandle();
    await dir.plant('record', 'old');
    const temporary = await dir.getFileHandle('record.x.tmp', { create: true });
    const writable = await temporary.createWritable();
    await writable.write('new');
    const move = (name: string): Promise<void> =>
      temporary.move?.(name) ?? Promise.reject(new Error('No move().'));

    // Locked while its stream is open, as in Chrome.
    await expect(move('record')).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await expect(dir.removeEntry('record.x.tmp')).rejects.toMatchObject({
      name: 'NoModificationAllowedError',
    });
    await writable.close();
    await move('record');
    expect(temporary.name).toBe('record');
    expect([...dir.files()].map(([path, f]) => [path, f.text])).toEqual([['record', 'new']]);

    await dir.plant('folder/inside', '');
    await expect(move('folder')).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await expect(move('a/b')).rejects.toThrow(TypeError);
    await dir.removeEntry('record');
    await expect(move('other')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(
      (await new FakeDirectoryHandle('', { move: false }).getFileHandle('f', { create: true }))
        .move,
    ).toBeUndefined();
  });

  it('cuts the page off after a number of operations, and resume() starts a new page', async () => {
    const root = new FakeDirectoryHandle();
    const handle = await root.getFileHandle('f', { create: true });
    const writable = await handle.createWritable();
    await writable.write('lost');
    root.interruptAfter(1);
    await root.getDirectoryHandle('made', { create: true });
    let settled = false;
    void writable.close().finally(() => {
      settled = true;
    });
    void root.getDirectoryHandle('never', { create: true });
    await flush();

    expect(root.interrupted).toBe(true);
    expect(settled).toBe(false);
    expect(root.directories()).toEqual(['made']);
    expect(handle.text).toBe('');
    expect(handle.openWritables).toBe(1);

    root.resume();
    expect(root.interrupted).toBe(false);
    // The old page's stream is gone, with its lock and without its content.
    expect(handle.openWritables).toBe(0);
    await root.removeEntry('f');
    expect(settled).toBe(false);
    expect(() => {
      root.interruptAfter(-1);
    }).toThrow(RangeError);
  });
});
