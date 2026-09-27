// The OPFS store's own behaviour, over the in-memory file system of fake-opfs.ts: the file layout of
// docs/DATA-MODEL.md §5, the JSON it writes, the order of its operations and what it does with
// files it did not write. The semantics it shares with MemorySessionStore are in
// session-store-contract.test.ts.
import { describe, expect, it } from 'vitest';

import { FakeDirectoryHandle, FakeFileHandle } from './fake-opfs';
import { opfsAvailable } from './opfs';
import { OpfsSessionStore, attemptFolder } from './opfs-session-store';
import { A, B, attempt, session } from './test-records';

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

/** Writes `text` to the file at `path` below `root`, making the folders on the way. */
async function plant(root: FakeDirectoryHandle, path: string, text: string): Promise<void> {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
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

  it('keeps the old content when a write fails, and closes the stream', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    const sessionFile = file(root, `sessions/${A}/session.json`);
    const before = sessionFile.text;
    sessionFile.failWritesWith = new DOMException('The disk is full.', 'QuotaExceededError');

    await expect(store.saveSession({ ...session(A, 1000), notes: 'lost' })).rejects.toThrow(
      'The disk is full.',
    );
    expect(sessionFile.text).toBe(before);
    expect(sessionFile.openWritables).toBe(0);
  });

  it('ignores folders and files that are not records, and starts a session over a leftover folder', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await plant(root, 'sessions/notes.txt', 'not a session');
    await plant(root, `sessions/${B}/attempts/0001/attempt.json`, JSON.stringify(attempt(B, 1)));
    await plant(root, `sessions/${A}/attempts/0002/clip.mp4`, 'video without attempt.json');
    await plant(root, `sessions/${A}/attempts/thumbs/x.json`, '{}');

    expect((await store.listSessions()).map((s) => s.id)).toEqual([A]);
    expect(await store.loadAttempts(A)).toEqual([]);
    // B's folder has no session.json: B is not a session, and a new B starts empty.
    await store.createSession(session(B, 2000));
    expect(await store.loadAttempts(B)).toEqual([]);
  });

  it('rejects, naming the file, a record that is not JSON or not the one its path names', async () => {
    const { root, store } = setup();
    await store.createSession(session(A, 1000));
    await store.saveAttempt(attempt(A, 1));

    await plant(root, `sessions/${A}/attempts/0002/attempt.json`, JSON.stringify(attempt(A, 3)));
    await expect(store.loadAttempts(A)).rejects.toThrow(
      `sessions/${A}/attempts/0002/attempt.json is not the attempt.json of attempt 2 of session ${A}.`,
    );

    await plant(root, `sessions/${B}/session.json`, '{"schema": 1, "id": "');
    await expect(store.listSessions()).rejects.toThrow(`sessions/${B}/session.json is not JSON`);
    await plant(root, `sessions/${B}/session.json`, JSON.stringify(session(A, 1000)));
    await expect(store.listSessions()).rejects.toThrow(
      `sessions/${B}/session.json is not the session.json of session ${B}.`,
    );
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
});
