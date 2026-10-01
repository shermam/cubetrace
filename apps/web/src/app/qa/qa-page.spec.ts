import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MemorySessionStore } from '@cubetrace/core';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import {
  attemptDocument,
  attemptWithClips,
  realSession,
  sessionDocument,
} from '../cloud/cloud-testing';
import { SESSION_INDEX_KEY, SessionIndexService } from '../cloud/session-index';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, FakePerformance, settle } from '../device/fake-browser';
import { SESSION_STORAGE } from '../session/session-storage';
import { SESSION_A, SESSION_B, testAttempt } from '../session/session-testing';
import { SettingsService } from '../settings/settings-service';
import { localDay } from './qa-summary';
import { QaPage } from './qa-page';

describe('QaPage', () => {
  let backend: FakeAccountBackend;
  let storage: FakeLocalStorage;
  let clock: FakePerformance;
  let fixture: ComponentFixture<QaPage>;

  async function update(): Promise<void> {
    for (let k = 0; k < 3; k++) {
      await settle();
      await fixture.whenStable();
      await TestBed.inject(SessionIndexService).whenIdle();
    }
  }

  async function render(): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: BROWSER_GLOBALS, useValue: { localStorage: storage, performance: clock } },
        { provide: SESSION_STORAGE, useValue: { store: new MemorySessionStore(), kind: 'opfs' } },
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
      ],
    });
    TestBed.inject(SettingsService).setHostLabel('office-mbp');
    fixture = TestBed.createComponent(QaPage);
    await update();
    return fixture.nativeElement as HTMLElement;
  }

  function text(element: Element, testId: string): string | undefined {
    return element
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent.replace(/\s+/g, ' ')
      .trim();
  }

  function cells(row: Element): string[] {
    return Array.from(row.querySelectorAll('th, td'), (cell) =>
      cell.textContent.replace(/\s+/g, ' ').trim(),
    );
  }

  beforeEach(async () => {
    backend = new FakeAccountBackend();
    storage = new FakeLocalStorage();
    clock = new FakePerformance(new Date(2026, 9, 1, 18, 0, 0).getTime());
    // The laptop's session of today, and the phone's of yesterday, in the index.
    const today = new Date(2026, 9, 1, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 8, 30, 21, 0, 0).getTime();
    const laptop = realSession(SESSION_A, today, 'office-mbp');
    const phone = realSession(SESSION_B, yesterday, 'ThinkPhone');
    const shownAt = (attempt: ReturnType<typeof attemptWithClips>, ms: number) => ({
      ...attempt,
      events: { ...attempt.events, scrambleShown: ms },
    });
    await backend.saveSessionIndex(sessionDocument(laptop, ADA.uid), [
      attemptDocument(shownAt(attemptWithClips(1), today + 60_000), laptop, ADA.uid),
      attemptDocument(shownAt(attemptWithClips(2), today + 120_000), laptop, ADA.uid, today),
    ]);
    await backend.saveSessionIndex(sessionDocument(phone, ADA.uid), [
      attemptDocument(
        shownAt(testAttempt(1, 9_000, { session: SESSION_B }), yesterday + 60_000),
        phone,
        ADA.uid,
      ),
    ]);
  });

  it('asks to sign in, signed out, and reads nothing', async () => {
    const element = await render();
    expect(text(element, 'qa-signed-out')).toBe(
      'The QA view reads your cloud index: sign in (Settings → Account) to see it.',
    );
    expect(element.querySelector('[data-testid="qa-table"]')).toBeNull();
    expect(backend.loads).toBe(0);
  });

  it('lists the attempts of the cloud index by day and device, with their counts and bytes, and the total', async () => {
    backend.user = ADA;
    storage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    const element = await render();

    const rows = Array.from(element.querySelectorAll('[data-testid="qa-row"]'));
    expect(
      rows.map((row) => [row.getAttribute('data-day'), row.getAttribute('data-device')]),
    ).toEqual([
      [localDay(new Date(2026, 9, 1).getTime()), 'office-mbp'],
      [localDay(new Date(2026, 8, 30).getTime()), 'ThinkPhone'],
    ]);
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
    expect(cells(rows[0])).toEqual([
      day.format(new Date(2026, 9, 1)),
      'office-mbp',
      '2',
      '4',
      '10.6 MB',
      '5.3 MB',
      '5.3 MB',
    ]);
    expect(cells(rows[1])).toEqual([
      day.format(new Date(2026, 8, 30)),
      'ThinkPhone',
      '1',
      '0',
      '0 B',
      '0 B',
      '5.0 kB',
    ]);
    const total = element.querySelector('[data-testid="qa-total"]');
    expect(total === null ? [] : cells(total)).toEqual([
      'Total',
      '3',
      '4',
      '10.6 MB',
      '5.3 MB',
      '5.3 MB',
    ]);
    const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
    expect(text(element, 'qa-read')).toBe(
      `Read from your cloud index at ${time.format(clock.hostMs)} (2 sessions).`,
    );
    expect(text(element, 'qa-sync')).toBe(
      'This device (office-mbp) has not synced with your cloud index yet; nothing of this page waits to be sent.',
    );
    expect(backend.reads).toEqual([
      `sessions ${ADA.uid} 50`,
      `attempts ${SESSION_A} ${ADA.uid}`,
      `attempts ${SESSION_B} ${ADA.uid}`,
    ]);
  });

  it("says when this device last synced, what waits to be sent, and that it reads this device's copy offline", async () => {
    backend.user = ADA;
    storage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    const synced = clock.hostMs - 3_600_000;
    storage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify({ [ADA.uid]: { sessions: [], lastSyncMs: synced } }),
    );
    backend.online = false;
    const element = await render();
    // A write of this device while offline (an attempt saved as the page is open).
    void backend.saveAttemptIndex(
      attemptDocument(attemptWithClips(3), realSession(SESSION_A, synced, 'office-mbp'), ADA.uid),
    );
    element.querySelector<HTMLButtonElement>('[data-testid="qa-refresh"]')?.click();
    await update();

    const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
    expect(text(element, 'qa-sync')).toBe(
      `This device (office-mbp) last synced at ${time.format(synced)}; nothing of this page waits to be sent.`,
    );
    expect(text(element, 'qa-read')).toBe(
      `Offline: read from this device's copy of your cloud index at ${time.format(clock.hostMs)} (2 sessions); 1 of its attempts holds changes of this device not sent yet.`,
    );
  });

  it('says so when the index cannot be read', async () => {
    backend.user = ADA;
    storage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    backend.readError = new Error('Missing or insufficient permissions.');
    const element = await render();
    expect(text(element, 'qa-error')).toBe(
      'Your cloud index could not be read: Missing or insufficient permissions.',
    );
    expect(element.querySelector('[data-testid="qa-table"]')).toBeNull();
  });
});
