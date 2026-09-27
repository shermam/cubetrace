import { TestBed } from '@angular/core/testing';
import { MemorySessionStore } from '@cubetrace/core';
import { FakeDirectoryHandle, OpfsSessionStore } from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { SESSION_STORAGE } from './session-storage';
import { testSession } from './session-testing';

describe('SESSION_STORAGE', () => {
  function storageWith(navigator: unknown) {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: { navigator } }],
    });
    return TestBed.inject(SESSION_STORAGE);
  }

  it('keeps sessions in the origin private file system when the browser has one', async () => {
    const root = new FakeDirectoryHandle();
    const storage = storageWith({ storage: { getDirectory: () => Promise.resolve(root) } });

    expect(storage.kind).toBe('opfs');
    expect(storage.store).toBeInstanceOf(OpfsSessionStore);
    await storage.store.createSession(testSession());
    expect([...root.files().keys()]).toEqual([`sessions/${testSession().id}/session.json`]);
  });

  it('keeps them in memory otherwise', () => {
    const storage = storageWith({});
    expect(storage.kind).toBe('memory');
    expect(storage.store).toBeInstanceOf(MemorySessionStore);
  });
});
