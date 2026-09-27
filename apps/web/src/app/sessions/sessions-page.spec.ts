import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MemorySessionStore, type SessionStore } from '@cubetrace/core';
import { FakeDirectoryHandle, OpfsSessionStore } from '@cubetrace/storage';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, FakeStorageManager, settle } from '../device/fake-browser';
import { CURRENT_SESSION_KEY } from '../session/session-service';
import { SESSION_STORAGE } from '../session/session-storage';
import { SESSION_A, SESSION_B, testAttempt, testSession } from '../session/session-testing';
import { SessionsPage } from './sessions-page';

describe('SessionsPage', () => {
  let store: SessionStore;
  let blobs: Blob[];
  let fixture: ComponentFixture<SessionsPage>;
  let storage: FakeStorageManager;

  async function render(): Promise<HTMLElement> {
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_B);
    blobs = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: { storage },
            localStorage,
            URL: {
              createObjectURL: (blob: Blob) => {
                blobs.push(blob);
                return 'blob:session';
              },
              revokeObjectURL: () => undefined,
            },
          },
        },
        { provide: SESSION_STORAGE, useValue: { store, kind: 'opfs' } },
      ],
    });
    fixture = TestBed.createComponent(SessionsPage);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  function rows(element: HTMLElement, testId = 'session-row'): HTMLElement[] {
    return Array.from(element.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
  }

  function text(element: HTMLElement, testId: string): string | undefined {
    return element.querySelector(`[data-testid="${testId}"]`)?.textContent.trim();
  }

  /** Session A with attempt 1 in the fake OPFS, where a test plants files the store cannot read. */
  async function opfsWithSessionA(): Promise<FakeDirectoryHandle> {
    const root = new FakeDirectoryHandle();
    const opfs = new OpfsSessionStore(root);
    await opfs.createSession(testSession(SESSION_A, 1_790_000_000_000));
    await opfs.saveAttempt(testAttempt(1, 10_000));
    store = opfs;
    return root;
  }

  function button(row: HTMLElement, name: string): HTMLButtonElement | undefined {
    return Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === name);
  }

  beforeEach(async () => {
    storage = new FakeStorageManager({ usage: 1_500_000_000, quota: 10_000_000_000 });
    store = new MemorySessionStore();
    await store.createSession(testSession(SESSION_A, 1_790_000_000_000));
    await store.saveAttempt(testAttempt(1, 10_000));
    await store.createSession({
      ...testSession(SESSION_B, 1_790_000_100_000),
      host: { label: 'ThinkPhone', userAgent: 'test', platform: 'Android', isPhone: true },
    });
    await store.saveAttempt(testAttempt(1, 10_000, { session: SESSION_B }));
    await store.saveAttempt(testAttempt(2, 12_000, { session: SESSION_B }));
  });

  it('lists the sessions newest first: host, cube, attempts and mean', async () => {
    const element = await render();
    const [newest, oldest] = rows(element);

    expect(rows(element)).toHaveLength(2);
    expect(newest.getAttribute('data-session')).toBe(SESSION_B);
    expect(newest.textContent).toContain('ThinkPhone · Fake cube');
    expect(newest.querySelector('[data-testid="session-attempts"]')?.textContent).toBe(
      '2 attempts',
    );
    expect(newest.textContent).toContain('mean 11.00');
    expect(newest.querySelector('.current')?.textContent).toBe('current');
    expect(oldest.querySelector('[data-testid="session-attempts"]')?.textContent).toBe('1 attempt');
    expect(oldest.querySelector('.current')).toBeNull();
    // Each date opens the session's page.
    expect(newest.querySelector('[data-testid="session-link"]')?.getAttribute('href')).toBe(
      `/sessions/${SESSION_B}`,
    );
    expect(oldest.querySelector('[data-testid="session-link"]')?.getAttribute('href')).toBe(
      `/sessions/${SESSION_A}`,
    );
  });

  it("says how many clips each session's attempts have and their size, and how full storage is", async () => {
    const clip = (segment: 'scramble' | 'solve', bytes: number) => ({
      camera: 'laptop',
      segment,
      file: `laptop.${segment}.mp4`,
      bytes,
      codec: 'vp09.00.40.08',
      audio: null,
      width: 1920,
      height: 1080,
      crop: null,
      fpsNominal: 30,
      frames: 90,
      firstFrameHostMs: 1_790_000_000_000,
      framesFile: `laptop.${segment}.frames.json`,
      syncResidualMs: null,
    });
    await store.saveAttempt({
      ...testAttempt(2, 12_000, { session: SESSION_B }),
      video: [clip('scramble', 1_200_000), clip('solve', 4_100_000)],
    });
    const element = await render();
    const [newest, oldest] = rows(element);

    expect(newest.querySelector('[data-testid="session-clips"]')?.textContent).toBe(
      '2 clips, 5.3 MB',
    );
    expect(newest.querySelector('[data-testid="session-clips"]')?.getAttribute('data-bytes')).toBe(
      '5300000',
    );
    expect(oldest.querySelector('[data-testid="session-clips"]')).toBeNull();
    expect(text(element, 'storage-meter-text')).toBe('1.5 GB of 10.0 GB (15%)');
    expect(element.querySelector('[data-testid="storage-warning"]')).toBeNull();
    expect(text(element, 'sessions-clips-note')).toContain(
      'The clips of an attempt are downloaded from its clip badge',
    );
  });

  it('warns when storage is 80% full', async () => {
    storage.usage = 8_300_000_000;
    const element = await render();

    expect(text(element, 'storage-warning')).toBe(
      'Storage is 83% full: export or delete sessions.',
    );
  });

  it('exports a session as one JSON file of {session, attempts}', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const element = await render();

    button(rows(element)[1], 'Export')?.click();
    await settle();
    await fixture.whenStable();

    expect(click).toHaveBeenCalledTimes(1);
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe(`cubetrace-session-${SESSION_A}.json`);
    expect(link.href).toBe('blob:session');
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('application/json');
    expect(JSON.parse(await blobs[0].text())).toEqual(await store.exportSession(SESSION_A));
    expect(element.querySelector('[data-testid="sessions-notice"]')?.textContent).toBe(
      `Exported cubetrace-session-${SESSION_A}.json.`,
    );
    click.mockRestore();
  });

  it('deletes a session after a confirmation', async () => {
    const element = await render();
    const oldest = rows(element)[1];

    button(oldest, 'Delete…')?.click();
    await fixture.whenStable();
    expect(oldest.textContent).toContain('Delete this session and its 1 attempt?');
    button(oldest, 'Cancel')?.click();
    await fixture.whenStable();
    expect(button(oldest, 'Export')).toBeDefined();

    button(oldest, 'Delete…')?.click();
    await fixture.whenStable();
    button(oldest, 'Delete')?.click();
    await settle();
    await fixture.whenStable();
    expect(rows(element).map((row) => row.getAttribute('data-session'))).toEqual([SESSION_B]);
    expect((await store.listSessions()).map((s) => s.id)).toEqual([SESSION_B]);
  });

  it('says when there is no session yet', async () => {
    store = new MemorySessionStore();
    const element = await render();
    expect(element.querySelector('[data-testid="no-sessions"]')?.textContent).toContain(
      'No sessions yet',
    );
  });

  it('lists a session whose session.json cannot be read apart, naming the file, and deletes it', async () => {
    const root = await opfsWithSessionA();
    // Session B, the current one, was cut short: its session.json is empty (issue #12).
    await root.plant(`sessions/${SESSION_B}/session.json`, '');
    const element = await render();

    expect(rows(element).map((row) => row.getAttribute('data-session'))).toEqual([SESSION_A]);
    const [broken] = rows(element, 'unreadable-row');
    expect(rows(element, 'unreadable-row')).toHaveLength(1);
    expect(broken.getAttribute('data-session')).toBe(SESSION_B);
    expect(text(broken, 'unreadable-reason')).toBe(`sessions/${SESSION_B}/session.json is empty.`);
    expect(text(element, 'sessions-error')).toBeUndefined();

    button(broken, 'Delete…')?.click();
    await fixture.whenStable();
    expect(broken.textContent).toContain("Delete this session's folder, with everything in it?");
    button(broken, 'Delete')?.click();
    await settle();
    await fixture.whenStable();

    expect(rows(element, 'unreadable-row')).toEqual([]);
    expect(rows(element).map((row) => row.getAttribute('data-session'))).toEqual([SESSION_A]);
    expect(root.directories()).not.toContain(`sessions/${SESSION_B}`);
    expect(text(element, 'sessions-notice')).toBe(`Deleted the unreadable session ${SESSION_B}.`);
  });

  it('names an unreadable attempt.json in its session’s row, and leaves it out of the count, the mean and the export', async () => {
    const root = await opfsWithSessionA();
    await root.plant(`sessions/${SESSION_A}/attempts/0002/attempt.json`, '');
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const element = await render();
    const [row] = rows(element);

    expect(text(row, 'session-attempts')).toBe('1 attempt');
    expect(row.textContent).toContain('mean 10.00');
    expect(text(row, 'session-left-out')).toBe(
      `Left out: sessions/${SESSION_A}/attempts/0002/attempt.json is empty.`,
    );
    button(row, 'Export')?.click();
    await settle();
    await fixture.whenStable();
    const exported = JSON.parse(await blobs[0].text()) as { attempts: { index: number }[] };
    expect(exported.attempts.map((a) => a.index)).toEqual([1]);
    click.mockRestore();
  });

  it('says so when the sessions cannot be listed, and only then', async () => {
    const memory = new MemorySessionStore();
    memory.listSessions = () => Promise.reject(new Error('Storage is blocked.'));
    store = memory;
    const element = await render();

    expect(text(element, 'sessions-error')).toBe(
      'The sessions could not be read: Storage is blocked.',
    );
    expect(rows(element)).toEqual([]);
    expect(text(element, 'no-sessions')).toBeUndefined();
  });

  it('says in its row when a session cannot be exported or deleted', async () => {
    store.exportSession = () => Promise.reject(new Error('The file is locked.'));
    store.deleteSession = () => Promise.reject(new Error('The folder is locked.'));
    const element = await render();
    const oldest = rows(element)[1];

    button(oldest, 'Export')?.click();
    await settle();
    await fixture.whenStable();
    expect(text(oldest, 'row-error')).toBe(
      'The session could not be exported: The file is locked.',
    );
    expect(text(rows(element)[0], 'row-error')).toBeUndefined();

    button(oldest, 'Delete…')?.click();
    await fixture.whenStable();
    button(oldest, 'Delete')?.click();
    await settle();
    await fixture.whenStable();
    const [, still] = rows(element);
    expect(still.getAttribute('data-session')).toBe(SESSION_A);
    expect(text(still, 'row-error')).toBe(
      'The session could not be deleted: The folder is locked.',
    );
    expect(text(element, 'sessions-error')).toBeUndefined();
  });
});
