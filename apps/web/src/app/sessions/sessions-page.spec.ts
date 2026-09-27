import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MemorySessionStore } from '@cubetrace/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { CURRENT_SESSION_KEY } from '../session/session-service';
import { SESSION_STORAGE } from '../session/session-storage';
import { SESSION_A, SESSION_B, testAttempt, testSession } from '../session/session-testing';
import { SessionsPage } from './sessions-page';

describe('SessionsPage', () => {
  let store: MemorySessionStore;
  let blobs: Blob[];
  let fixture: ComponentFixture<SessionsPage>;

  async function render(): Promise<HTMLElement> {
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_B);
    blobs = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: {},
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

  function rows(element: HTMLElement): HTMLElement[] {
    return Array.from(element.querySelectorAll<HTMLElement>('[data-testid="session-row"]'));
  }

  function button(row: HTMLElement, name: string): HTMLButtonElement | undefined {
    return Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === name);
  }

  beforeEach(async () => {
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
});
