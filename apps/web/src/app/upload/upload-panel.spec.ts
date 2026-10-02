import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SESSION_A } from '../session/session-testing';
import { PANEL_ROWS, UploadPanel } from './upload-panel';
import { UploadService } from './upload-service';
import { FakeUploads, attemptView, queueView } from './upload-testing';
import { uploadTime } from './upload-text';

describe('UploadPanel', () => {
  let uploads: FakeUploads;

  async function render(): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: UploadService, useValue: uploads }],
    });
    const fixture = TestBed.createComponent(UploadPanel);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  function text(element: HTMLElement, testId: string): string | undefined {
    return element
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent.replace(/\s+/g, ' ')
      .trim();
  }

  function rows(element: HTMLElement): HTMLElement[] {
    return Array.from(element.querySelectorAll<HTMLElement>('[data-testid="upload-row"]'));
  }

  beforeEach(() => {
    uploads = new FakeUploads();
  });

  it('says the uploads are up to date, with what was uploaded last and the clips freed', async () => {
    uploads.viewSignal.set(
      queueView({
        counts: { waiting: 0, pending: 0, uploading: 0, done: 4, failed: 0 },
        recent: [attemptView(4, { state: 'done' }), attemptView(3, { state: 'done' })],
        freed: { clips: 2, bytes: 8_200_000 },
      }),
    );
    const element = await render();
    expect(text(element, 'upload-status')).toBe(
      'Up to date: every attempt of this device is uploaded.',
    );
    expect(text(element, 'upload-counts')).toBe('4 done');
    expect(rows(element)).toEqual([]);
    const when = uploadTime(1_790_000_000_000);
    expect(text(element, 'upload-recent')).toBe(
      `Uploaded last: attempt 4 of ${when}, attempt 3 of ${when}`,
    );
    expect(text(element, 'upload-freed')).toBe(
      '2 uploaded clips deleted from this device (8.2 MB): they are in the cloud.',
    );
    expect(element.querySelector('[data-testid="upload-panel"]')?.getAttribute('data-status')).toBe(
      'running',
    );
  });

  it('lists the attempts to upload with their progress and errors, and Retry for a failed one', async () => {
    uploads.viewSignal.set(
      queueView({
        counts: { waiting: 1, pending: 1, uploading: 1, done: 0, failed: 1 },
        bytesLeft: 5_000_000,
        active: [
          attemptView(1, { state: 'uploading', bytes: 4_000_000, sent: 1_000_000 }),
          attemptView(2, { state: 'pending', error: 'the bucket answered 503' }),
          attemptView(3, { state: 'failed', error: 'the bucket refused the upload: 403' }),
          attemptView(4, { state: 'waiting' }),
        ],
      }),
    );
    const element = await render();
    expect(text(element, 'upload-status')).toBe('Uploading: 3 attempts to upload, 5.0 MB.');
    expect(text(element, 'upload-counts')).toBe(
      '1 pending · 1 uploading · 1 waiting for clips · 0 done · 1 failed',
    );
    const listed = rows(element);
    expect(listed.map((row) => row.getAttribute('data-state'))).toEqual([
      'uploading',
      'pending',
      'failed',
      'waiting',
    ]);
    expect(listed.map((row) => text(row, 'upload-state'))).toEqual([
      'uploading 25%',
      'will try again',
      'failed',
      'waiting for its clips',
    ]);
    expect(text(listed[0], 'upload-bytes')).toBe('1.0 MB of 4.0 MB');
    expect(listed[0].querySelector('progress')?.value).toBe(1_000_000);
    expect(listed[0].querySelector('a')?.getAttribute('href')).toBe(`/sessions/${SESSION_A}`);
    expect(text(listed[1], 'upload-error')).toBe('the bucket answered 503');
    expect(listed[1].querySelector('[data-testid="upload-retry"]')).toBeNull();
    expect(text(listed[2], 'upload-error')).toBe('the bucket refused the upload: 403');
    listed[2].querySelector<HTMLButtonElement>('[data-testid="upload-retry"]')?.click();
    expect(uploads.retries).toEqual([`${SESSION_A}/3`]);
    // One failed: no Retry all.
    expect(element.querySelector('[data-testid="upload-retry-all"]')).toBeNull();
  });

  it(`lists the first ${String(PANEL_ROWS)} attempts and counts the others, with Retry all for several failed`, async () => {
    const active = Array.from({ length: PANEL_ROWS + 5 }, (_, k) =>
      attemptView(k + 1, { state: k < 2 ? 'failed' : 'pending' }),
    );
    uploads.viewSignal.set(
      queueView({
        counts: { waiting: 0, pending: PANEL_ROWS + 3, uploading: 0, done: 0, failed: 2 },
        active,
      }),
    );
    const element = await render();
    expect(rows(element)).toHaveLength(PANEL_ROWS);
    expect(text(element, 'upload-more')).toBe('And 5 attempts after them.');
    element.querySelector<HTMLButtonElement>('[data-testid="upload-retry-all"]')?.click();
    expect(uploads.retries).toEqual(['*/*']);
  });

  it('says why nothing uploads: paused by the quota, off, another tab, or the code not loaded', async () => {
    const until = 1_790_035_200_000;
    uploads.viewSignal.set(
      queueView({
        pause: { reason: 'quota', untilMs: until },
        counts: { waiting: 0, pending: 1, uploading: 0, done: 0, failed: 0 },
        bytesLeft: 2_000,
        active: [attemptView(1)],
      }),
    );
    const element = await render();
    expect(text(element, 'upload-status')).toBe(
      `Paused until ${uploadTime(until)}: the day's upload quota is used up. 1 attempt to upload, 2.0 kB.`,
    );
    TestBed.resetTestingModule();

    uploads = new FakeUploads();
    uploads.statusSignal.set('off');
    uploads.viewSignal.set(null);
    expect(text(await render(), 'upload-status')).toBe(
      'Uploads are off (Settings → Uploads): the sessions stay on this device.',
    );
    TestBed.resetTestingModule();

    uploads = new FakeUploads();
    uploads.statusSignal.set('error');
    uploads.viewSignal.set(null);
    uploads.errorSignal.set('The uploads could not be loaded (offline).');
    const failed = await render();
    expect(text(failed, 'upload-status')).toBe('The uploads could not start.');
    expect(text(failed, 'upload-load-error')).toBe('The uploads could not be loaded (offline).');
    expect(text(failed, 'upload-counts')).toBeUndefined();
  });
});
