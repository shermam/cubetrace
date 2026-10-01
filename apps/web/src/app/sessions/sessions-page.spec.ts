import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MemorySessionStore, type SessionStore } from '@cubetrace/core';
import { FakeDirectoryHandle, OpfsSessionStore } from '@cubetrace/storage';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import {
  attemptDocument,
  attemptWithClips,
  realSession,
  sessionDocument,
} from '../cloud/cloud-testing';
import { SessionIndexService } from '../cloud/session-index';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, FakeStorageManager, settle } from '../device/fake-browser';
import { CURRENT_SESSION_KEY, SessionService } from '../session/session-service';
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
      truncatedStart: false,
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

  describe('signed in (T3.1)', () => {
    const PHONE = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
    const DEMO = '0d0d0d0d-0000-4000-8000-000000000001';
    let backend: FakeAccountBackend;

    /** The page on a device whose account is remembered, the cloud's index in `backend`. */
    async function renderSignedIn(): Promise<HTMLElement> {
      const localStorage = new FakeLocalStorage();
      localStorage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
      localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          { provide: BROWSER_GLOBALS, useValue: { navigator: { storage }, localStorage } },
          { provide: SESSION_STORAGE, useValue: { store, kind: 'opfs' } },
          { provide: ACCOUNT_LOADER, useValue: backend.loader },
        ],
      });
      fixture = TestBed.createComponent(SessionsPage);
      const index = TestBed.inject(SessionIndexService);
      for (let k = 0; k < 4; k++) {
        await fixture.whenStable();
        await settle();
        await index.whenIdle();
      }
      await fixture.whenStable();
      return fixture.nativeElement as HTMLElement;
    }

    function place(row: HTMLElement): string | undefined {
      return text(row, 'session-place');
    }

    beforeEach(async () => {
      backend = new FakeAccountBackend();
      backend.user = ADA;
      store = new MemorySessionStore();
      // This device: the laptop's session (a real cube) and a demo session.
      await store.createSession(realSession(SESSION_A, 1_790_000_000_000));
      await store.saveAttempt(attemptWithClips(1, 10_000));
      await store.createSession(testSession(DEMO, 1_790_000_050_000));
      await store.saveAttempt(testAttempt(1, 9_000, { session: DEMO }));
      // The phone's session, in the cloud only.
      const phone = realSession(PHONE, 1_790_000_100_000, 'ThinkPhone');
      await backend.saveSessionIndex(
        sessionDocument({ ...phone, summary: { attempts: 2, solved: 2, dnf: 0 } }, ADA.uid),
        [
          attemptDocument(attemptWithClips(1, 12_000, PHONE), phone, ADA.uid),
          attemptDocument(attemptWithClips(2, 13_000, PHONE), phone, ADA.uid),
        ],
      );
    });

    it("lists this device's sessions and the cloud's, merged by id, each with its badge", async () => {
      const element = await renderSignedIn();
      const [phone, demo, laptop] = rows(element);

      expect(rows(element).map((row) => row.getAttribute('data-session'))).toEqual([
        PHONE,
        DEMO,
        SESSION_A,
      ]);
      expect(place(phone)).toBe('cloud');
      expect(phone.querySelector('.place')?.getAttribute('title')).toBe(
        'In your cloud index, recorded on ThinkPhone: its clips and moves are on that device.',
      );
      expect(phone.textContent).toContain('ThinkPhone · GAN 12 ui FreePlay');
      expect(text(phone, 'session-attempts')).toBe('2 attempts');
      expect(phone.textContent).toContain('recorded on another device');
      // A session of the cloud alone opens its read-only page, and has nothing to export or delete.
      expect(phone.querySelector('[data-testid="session-link"]')?.getAttribute('href')).toBe(
        `/sessions/${PHONE}`,
      );
      expect(phone.querySelectorAll('button')).toHaveLength(0);

      expect(place(demo)).toBe('this device');
      expect(demo.querySelector('.place')?.getAttribute('title')).toBe(
        'A demo session (the fake cube): it stays on this device.',
      );
      expect(text(demo, 'session-cloud-problem')).toBeUndefined();
      // The laptop's session, written by the catch-up as the account started.
      expect(place(laptop)).toBe('both');
      expect(laptop.querySelector('.current')?.textContent).toBe('current');
      expect(button(laptop, 'Export')).toBeDefined();
      expect(backend.sessionDocument(SESSION_A)?.owner).toBe(ADA.uid);
      expect(backend.sessionDocument(DEMO)).toBeUndefined();

      expect(element.querySelector('[data-testid="qa-link"]')?.getAttribute('href')).toBe('/qa');
      expect(text(element, 'cloud-error')).toBeUndefined();
    });

    it('filters the sessions by device, from the host labels seen', async () => {
      const element = await renderSignedIn();
      const select = element.querySelector<HTMLSelectElement>('[data-testid="device-filter"]');
      expect(Array.from(select?.options ?? []).map((option) => option.textContent.trim())).toEqual([
        'All devices',
        'Linux laptop',
        'ThinkPhone',
      ]);

      if (select !== null) {
        select.value = 'ThinkPhone';
        select.dispatchEvent(new Event('change'));
      }
      await fixture.whenStable();
      expect(rows(element).map((row) => row.getAttribute('data-session'))).toEqual([PHONE]);

      if (select !== null) {
        select.value = 'Linux laptop';
        select.dispatchEvent(new Event('change'));
      }
      await fixture.whenStable();
      expect(rows(element).map((row) => row.getAttribute('data-session'))).toEqual([
        DEMO,
        SESSION_A,
      ]);
    });

    it('says why a session of this device is not in the cloud, and that deleting it keeps its index', async () => {
      backend.indexError = Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      });
      const element = await renderSignedIn();
      const laptop = rows(element).find((row) => row.getAttribute('data-session') === SESSION_A);

      expect(laptop === undefined ? undefined : place(laptop)).toBe('this device');
      expect(laptop === undefined ? undefined : text(laptop, 'session-cloud-problem')).toBe(
        'Not in the cloud: the session could not be indexed: Missing or insufficient permissions.',
      );
      // The session's notes say it too, so that the next page loads know.
      expect((await store.exportSession(SESSION_A)).session.notes).toBe(
        'cloud: the session could not be indexed: Missing or insufficient permissions.',
      );

      const other = rows(element).find((row) => row.getAttribute('data-session') === DEMO);
      if (other !== undefined) {
        button(other, 'Delete…')?.click();
      }
      await fixture.whenStable();
      expect(other?.textContent).toContain('Delete this session and its 1 attempt?');
    });

    it("says that deleting a session in both keeps its index, and that the cloud's sessions could not be read", async () => {
      backend.readError = new Error('Failed to get documents because the client is offline.');
      const element = await renderSignedIn();
      expect(text(element, 'cloud-error')).toBe(
        "Your cloud's sessions could not be read: Failed to get documents because the client is offline.",
      );
      // This device's sessions are listed all the same; the laptop's was written to the index.
      const laptop = rows(element).find((row) => row.getAttribute('data-session') === SESSION_A);
      expect(laptop === undefined ? undefined : place(laptop)).toBe('both');
      if (laptop !== undefined) {
        button(laptop, 'Delete…')?.click();
      }
      await fixture.whenStable();
      expect(laptop?.textContent).toContain(
        'Delete this session and its 1 attempt from this device? Its index in the cloud stays.',
      );
    });

    it('updates the current session’s row as the timer changes it', async () => {
      await store.saveAttempt(testAttempt(1, 10_000));
      const element = await renderSignedIn();
      const laptop = (): HTMLElement =>
        rows(element).find((row) => row.getAttribute('data-session') === SESSION_A) ??
        document.createElement('li');
      expect(text(laptop(), 'session-attempts')).toBe('1 attempt');
      expect(text(laptop(), 'session-clips')).toBeUndefined();

      // A clip saved while the page is open (the recording of the last solve).
      await TestBed.inject(SessionService).attachClip(
        { session: SESSION_A, index: 1, scrambleShown: 0 },
        attemptWithClips(1).video[1],
      );
      await fixture.whenStable();
      expect(text(laptop(), 'session-clips')).toBe('1 clip, 4.1 MB');
      expect(place(laptop())).toBe('both');
    });
  });

  it('shows no badge, no device filter and no QA view signed out', async () => {
    const element = await render();
    expect(rows(element)).toHaveLength(2);
    expect(element.querySelector('[data-testid="session-place"]')).toBeNull();
    expect(element.querySelector('[data-testid="device-filter"]')).toBeNull();
    expect(element.querySelector('[data-testid="qa-link"]')).toBeNull();
    expect(element.querySelector('[data-testid="sessions-cloud"]')).toBeNull();
  });
});
