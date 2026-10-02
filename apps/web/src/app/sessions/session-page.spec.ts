import { type ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  Router,
  convertToParamMap,
  provideRouter,
  type ParamMap,
} from '@angular/router';
import {
  MemorySessionStore,
  type AttemptRecord,
  type SessionStore,
  type VideoClip,
} from '@cubetrace/core';
import { BehaviorSubject } from 'rxjs';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import {
  attemptDocument,
  attemptWithClips,
  realSession,
  sessionDocument,
} from '../cloud/cloud-testing';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FakeLocalStorage,
  FakeStorageManager,
  polyfillDialog,
  settle,
} from '../device/fake-browser';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { inverse, ready, setup, turn } from '../session/session-harness';
import { CURRENT_SESSION_KEY } from '../session/session-service';
import { SESSION_STORAGE } from '../session/session-storage';
import { SESSION_A, SESSION_B, testAttempt, testSession } from '../session/session-testing';
import { ClipViewing } from '../timer/clip-viewing';
import { TWISTY_LOADER } from '../timer/scramble-view';
import { UploadService } from '../upload/upload-service';
import { FakeUploads, attemptView } from '../upload/upload-testing';
import { SessionPage, camerasText, clipsText } from './session-page';

function clip(segment: 'scramble' | 'solve', bytes: number): VideoClip {
  return {
    camera: 'laptop',
    segment,
    file: `laptop.${segment}.mp4`,
    bytes,
    codec: 'vp09.00.40.08',
    audio: 'opus',
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 90,
    firstFrameHostMs: 1_790_000_000_000,
    framesFile: `laptop.${segment}.frames.json`,
    syncResidualMs: null,
    truncatedStart: false,
  };
}

/** 15 attempts of session A, 10 s and a second more each, the 7th a DNF; the 15th with its clips. */
function fifteen(): AttemptRecord[] {
  return Array.from({ length: 15 }, (_, k) => {
    const attempt = testAttempt(k + 1, k === 6 ? null : 10_000 + k * 1000);
    return k === 14
      ? { ...attempt, video: [clip('scramble', 1_200_000), clip('solve', 4_100_000)] }
      : attempt;
  });
}

describe('SessionPage', () => {
  let store: SessionStore;
  let params: BehaviorSubject<ParamMap>;
  let fixture: ComponentFixture<SessionPage>;
  let reads: string[];

  /** The providers of the page, besides the timer's (the harness) or a store's. */
  function pageProviders(id: string) {
    params = new BehaviorSubject(convertToParamMap({ id }));
    reads = [];
    return [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: params } },
      // The clip viewer's 3D cube (T3.8) would load cubing.js: not in jsdom.
      { provide: TWISTY_LOADER, useValue: () => Promise.resolve() },
      {
        provide: ATTEMPT_FILES,
        useValue: {
          read: (sessionId: string, index: number, name: string) => {
            reads.push(`${sessionId}/${String(index)}/${name}`);
            return Promise.resolve(new Blob([name], { type: 'video/mp4' }));
          },
        },
      },
    ];
  }

  /**
   * The page of session `id`, over `store`; `current` is the session the timer resumes. With
   * `backend`, an account is signed in (remembered), whose index the backend has.
   */
  async function render(
    id: string,
    current: string | null = null,
    backend: FakeAccountBackend | null = null,
    uploads: FakeUploads | null = null,
  ): Promise<HTMLElement> {
    const localStorage = new FakeLocalStorage();
    if (current !== null) {
      localStorage.setItem(CURRENT_SESSION_KEY, current);
    }
    if (backend !== null) {
      localStorage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    }
    TestBed.configureTestingModule({
      providers: [
        ...pageProviders(id),
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: { storage: new FakeStorageManager({}) },
            localStorage,
            URL: { createObjectURL: () => 'blob:session', revokeObjectURL: () => undefined },
          },
        },
        { provide: SESSION_STORAGE, useValue: { store, kind: 'opfs' } },
        ...(backend === null ? [] : [{ provide: ACCOUNT_LOADER, useValue: backend.loader }]),
        ...(uploads === null ? [] : [{ provide: UploadService, useValue: uploads }]),
      ],
    });
    fixture = TestBed.createComponent(SessionPage);
    await update();
    await update();
    return fixture.nativeElement as HTMLElement;
  }

  async function update(): Promise<void> {
    await settle();
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
  }

  function text(element: HTMLElement, testId: string): string | undefined {
    return element
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent.replace(/\s+/g, ' ')
      .trim();
  }

  function rows(element: HTMLElement): string[] {
    return Array.from(element.querySelectorAll('[data-testid="solve-row"]'), (row) =>
      String(row.getAttribute('data-index')),
    );
  }

  function button(element: HTMLElement, name: string): HTMLButtonElement | undefined {
    return Array.from(element.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === name,
    );
  }

  beforeEach(async () => {
    polyfillDialog();
    store = new MemorySessionStore();
    await store.createSession({
      ...testSession(SESSION_A, 1_790_000_000_000),
      cameras: [
        {
          label: 'laptop',
          local: true,
          facing: 'unknown',
          deviceLabel: 'FaceTime HD Camera',
          settings: {},
          capabilities: {},
          constraints: {},
          crop: null,
          mode: 'full',
          microphone: null,
        },
      ],
    });
    for (const attempt of fifteen()) {
      await store.saveAttempt(attempt);
    }
    await store.createSession(testSession(SESSION_B, 1_790_000_100_000));
    await store.saveAttempt(testAttempt(1, 9_000, { session: SESSION_B }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a stored session: date, device, cube, camera, statistics, clips and every attempt', async () => {
    const element = await render(SESSION_A, SESSION_B);

    expect(element.querySelector('h1')?.textContent).toBe('Session');
    expect(text(element, 'session-date')).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        1_790_000_000_000,
      ),
    );
    expect(element.querySelector('[data-testid="session-current"]')).toBeNull();
    expect(text(element, 'session-device')).toBe('Linux laptop');
    expect(text(element, 'session-cube')).toBe('Fake cube');
    expect(text(element, 'session-cameras')).toBe('laptop (FaceTime HD Camera)');
    expect(text(element, 'session-clip-bytes')).toBe('2 clips, 5.3 MB');
    // 10 … 24 s, the 7th (16 s) a DNF. The last five, 20 … 24 s: 22.00. The last twelve, 13 … 24 s
    // with the DNF for 16 s: the DNF (the worst) and 13 s (the best) dropped, 19.30.
    expect(
      ['count', 'dnf', 'mean', 'best', 'ao5', 'ao12', 'ao100'].map((stat) =>
        text(element, `stat-${stat}`),
      ),
    ).toEqual(['15', '1', 'DNF', '10.00', '22.00', '19.30', '–']);
    // Every attempt, newest first, without the list's own statistics and footer.
    expect(rows(element)).toEqual(Array.from({ length: 15 }, (_, k) => String(15 - k)));
    expect(element.querySelector('[data-testid="session-stats"]')).toBeNull();
    expect(element.querySelector('[data-testid="solve-list-footer"]')).toBeNull();
  });

  it("opens the clip viewer on an attempt's clips, read from this session's folder", async () => {
    const element = await render(SESSION_A, SESSION_B);
    element.querySelector<HTMLButtonElement>('[data-testid="clip-badge"]')?.click();
    await update();

    expect(TestBed.inject(ClipViewing).index()).toBe(15);
    const viewer = element.querySelector('[data-testid="clip-viewer"]');
    expect(viewer?.querySelector('h2')?.textContent).toBe('Attempt 15');
    expect(reads).toEqual([`${SESSION_A}/15/laptop.solve.mp4`]);

    fixture.destroy();
    expect(TestBed.inject(ClipViewing).index()).toBeNull();
  });

  it('follows the current session as its attempts come', async () => {
    const s = setup({ providers: pageProviders('') });
    const fake = await ready(s);
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'), 300);
    await s.service.whenSaved();
    const id = s.service.session()?.id ?? '';
    params.next(convertToParamMap({ id }));
    fixture = TestBed.createComponent(SessionPage);
    await update();
    const element = fixture.nativeElement as HTMLElement;

    expect(text(element, 'session-current')).toBe('current');
    expect(rows(element)).toEqual(['1']);
    expect(text(element, 'stat-count')).toBe('1');
    expect(text(element, 'session-cameras')).toBe('none');
    expect(text(element, 'session-clip-bytes')).toBe('none');

    turn(s, fake, "L2 D B'");
    turn(s, fake, inverse("L2 D B'"), 300);
    await update();
    expect(rows(element)).toEqual(['2', '1']);
    expect(text(element, 'stat-count')).toBe('2');
  });

  it('exports the session, and deletes it after a confirmation, then goes back to Sessions', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const element = await render(SESSION_A, SESSION_B);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    button(element, 'Export')?.click();
    await update();
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
      `cubetrace-session-${SESSION_A}.json`,
    );
    expect(text(element, 'session-page-notice')).toBe(
      `Exported cubetrace-session-${SESSION_A}.json.`,
    );

    button(element, 'Delete…')?.click();
    await update();
    expect(element.textContent).toContain('Delete this session, its 15 attempts and its clips?');
    button(element, 'Cancel')?.click();
    await update();
    expect(navigate).not.toHaveBeenCalled();
    button(element, 'Delete…')?.click();
    await update();
    button(element, 'Delete')?.click();
    await update();
    expect((await store.listSessions()).map((session) => session.id)).toEqual([SESSION_B]);
    expect(navigate).toHaveBeenCalledWith(['/sessions']);
  });

  it("says each attempt's upload, as this device's queue has it (T3.3)", async () => {
    const uploads = new FakeUploads();
    uploads.attempts.set(`${SESSION_A}/15`, attemptView(15, { state: 'done' }));
    uploads.attempts.set(
      `${SESSION_A}/14`,
      attemptView(14, { state: 'uploading', bytes: 10, sent: 4 }),
    );
    uploads.attempts.set(`${SESSION_A}/13`, attemptView(13, { state: 'failed' }));
    const element = await render(SESSION_A, SESSION_B, null, uploads);
    const badges = Array.from(element.querySelectorAll('[data-testid="solve-row"]'))
      .slice(0, 4)
      .map((row) => row.querySelector('[data-testid="upload-badge"]')?.textContent.trim() ?? null);
    expect(badges).toEqual(['uploaded', 'uploading 40%', 'upload failed', null]);

    // Without a queue (signed out, uploads off), the rows say nothing of it.
    TestBed.resetTestingModule();
    const none = await render(SESSION_A, SESSION_B, null, new FakeUploads());
    expect(none.querySelector('[data-testid="upload-badge"]')).toBeNull();
  });

  it('says so when the session is not there', async () => {
    const element = await render('4b0f3c2a-0000-4000-8000-000000000000');
    expect(text(element, 'session-error')).toMatch(/^This session could not be read: /);
    expect(element.querySelector('[data-testid="session-date"]')).toBeNull();
  });

  describe('signed in, a session of the cloud alone (T3.1)', () => {
    const PHONE = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
    let backend: FakeAccountBackend;

    beforeEach(async () => {
      backend = new FakeAccountBackend();
      backend.user = ADA;
      const phone = {
        ...realSession(PHONE, 1_790_000_200_000, 'ThinkPhone'),
        summary: { attempts: 2, solved: 1, dnf: 1 },
      };
      await backend.saveSessionIndex(sessionDocument(phone, ADA.uid), [
        attemptDocument(attemptWithClips(1, 12_000, PHONE), phone, ADA.uid),
        attemptDocument(attemptWithClips(2, null, PHONE), phone, ADA.uid),
      ]);
    });

    it('shows it read-only: its facts and attempts from the index, no clip to play, nothing to export or delete', async () => {
      const element = await render(PHONE, SESSION_B, backend);

      expect(text(element, 'session-place')).toBe('cloud');
      expect(text(element, 'session-cloud-note')).toBe(
        'Recorded on ThinkPhone: this session is in your cloud index, not on this device. Its ' +
          'clips and its moves stay on the device that recorded it, so no clip plays here and ' +
          'nothing can be exported.',
      );
      expect(text(element, 'session-device')).toBe('ThinkPhone');
      expect(text(element, 'session-cube')).toBe('GAN 12 ui FreePlay');
      expect(text(element, 'session-cameras')).toBe('laptop (FaceTime HD Camera)');
      expect(text(element, 'session-clip-bytes')).toBe('4 clips, 10.6 MB');
      expect(['count', 'dnf', 'mean', 'best'].map((stat) => text(element, `stat-${stat}`))).toEqual(
        ['2', '1', 'DNF', '12.00'],
      );
      expect(rows(element)).toEqual(['2', '1']);
      expect(button(element, 'Export')).toBeUndefined();
      expect(button(element, 'Delete…')).toBeUndefined();
      // The clip badges say where the clips are, and open nothing.
      const badge = element.querySelector<HTMLElement>('[data-testid="clip-badge"]');
      expect(badge?.tagName).toBe('SPAN');
      expect(badge?.getAttribute('title')).toBe('The clips are on the device that recorded them.');
      badge?.click();
      await update();
      expect(TestBed.inject(ClipViewing).index()).toBeNull();
      expect(reads).toEqual([]);
      expect(backend.reads).toEqual([`session ${PHONE}`, `attempts ${PHONE} ${ADA.uid}`]);
      expect(text(element, 'session-error')).toBeUndefined();
    });

    it("says each attempt's upload as its document has it", async () => {
      backend.serverSetsUpload(PHONE, 1, {
        state: 'done',
        files: { 'attempt.json': { bytes: 5_000, doneMs: 1_790_000_300_000 } },
      });
      const element = await render(PHONE, SESSION_B, backend);
      expect(
        Array.from(
          element.querySelectorAll('[data-testid="upload-badge"]'),
          (badge) => `${badge.textContent.trim()} ${String(badge.getAttribute('data-state'))}`,
        ),
      ).toEqual(['to upload pending', 'uploaded done']);
    });

    it('shows a session of this device from this device, signed in too', async () => {
      const element = await render(SESSION_A, SESSION_B, backend);
      expect(text(element, 'session-place')).toBeUndefined();
      expect(text(element, 'session-cloud-note')).toBeUndefined();
      expect(button(element, 'Export')).toBeDefined();
      expect(element.querySelector('[data-testid="clip-badge"]')?.tagName).toBe('BUTTON');
      expect(backend.reads.filter((read) => read.startsWith('session '))).toEqual([]);
    });

    it('says why when the session is neither here nor in the cloud', async () => {
      const element = await render('4b0f3c2a-0000-4000-8000-000000000000', null, backend);
      expect(text(element, 'session-error')).toMatch(/^This session could not be read: /);

      backend.readError = Object.assign(new Error('The client is offline.'), {
        code: 'unavailable',
      });
      TestBed.resetTestingModule();
      const offline = await render(PHONE, null, backend);
      expect(text(offline, 'session-error')).toMatch(
        /^This session could not be read: .*\. Nor from the cloud: The client is offline\.$/,
      );
    });
  });

  it('writes the cameras and the clips of a session', () => {
    const session = testSession();
    expect(camerasText(session)).toBe('none');
    const camera = {
      label: 'phone-front',
      local: true as const,
      facing: 'user' as const,
      deviceLabel: 'camera 1, facing front',
      settings: {},
      capabilities: {},
      constraints: {},
      crop: null,
      mode: 'full' as const,
      microphone: null,
    };
    expect(
      camerasText({
        ...session,
        cameras: [camera, { ...camera, label: 'laptop', deviceLabel: '' }],
      }),
    ).toBe('phone-front (camera 1, facing front), laptop');
    expect(clipsText([])).toBe('none');
    expect(clipsText([{ ...testAttempt(1, 10_000), video: [clip('solve', 999)] }])).toBe(
      '1 clip, 999 B',
    );
    // Clips deleted from the device once uploaded (T3.3).
    expect(
      clipsText([
        {
          ...testAttempt(1, 10_000),
          video: [clip('scramble', 1_000), { ...clip('solve', 999), local: false }],
        },
        { ...testAttempt(2, 10_000), video: [{ ...clip('solve', 5_000), local: false }] },
      ]),
    ).toBe('3 clips, 1.0 kB, 2 in the cloud');
    expect(
      clipsText([{ ...testAttempt(1, 10_000), video: [{ ...clip('solve', 999), local: false }] }]),
    ).toBe('1 clip in the cloud');
  });
});
