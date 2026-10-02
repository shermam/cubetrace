import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { UploadIndicator } from './upload-indicator';
import { UploadService } from './upload-service';
import { FakeUploads, queueView } from './upload-testing';

describe('UploadIndicator', () => {
  let uploads: FakeUploads;

  async function render() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: UploadService, useValue: uploads }],
    });
    const fixture = TestBed.createComponent(UploadIndicator);
    await fixture.whenStable();
    return fixture;
  }

  function link(element: HTMLElement): HTMLAnchorElement | null {
    return element.querySelector<HTMLAnchorElement>('[data-testid="upload-indicator"]');
  }

  beforeEach(() => {
    uploads = new FakeUploads();
  });

  it('shows nothing while there is nothing to upload, and nothing without a queue', async () => {
    const fixture = await render();
    const element = fixture.nativeElement as HTMLElement;
    expect(link(element)).toBeNull();
    uploads.viewSignal.set(null);
    await fixture.whenStable();
    expect(link(element)).toBeNull();
  });

  it('shows an arrow with the attempts to upload, which opens the queue on the Sessions page', async () => {
    uploads.viewSignal.set(
      queueView({
        counts: { waiting: 1, pending: 1, uploading: 1, done: 3, failed: 0 },
        bytesLeft: 7_500_000,
      }),
    );
    const fixture = await render();
    const shown = link(fixture.nativeElement as HTMLElement);
    expect(shown?.getAttribute('data-state')).toBe('uploading');
    expect(shown?.textContent.replace(/\s+/g, '')).toBe('↑3');
    expect(shown?.getAttribute('title')).toBe('Uploading: 3 attempts to upload, 7.5 MB.');
    expect(shown?.getAttribute('aria-label')).toBe('Uploading: 3 attempts to upload, 7.5 MB.');
    expect(shown?.getAttribute('href')).toBe('/sessions#uploads');
  });

  it('says when the uploads are paused, and when some failed', async () => {
    uploads.viewSignal.set(
      queueView({
        pause: { reason: 'not-wifi' },
        counts: { waiting: 0, pending: 2, uploading: 0, done: 0, failed: 0 },
        bytesLeft: 1_000,
      }),
    );
    const fixture = await render();
    const element = fixture.nativeElement as HTMLElement;
    expect(link(element)?.getAttribute('data-state')).toBe('paused');
    expect(link(element)?.getAttribute('title')).toBe(
      'Waiting for Wi-Fi (Settings → Uploads → Wi-Fi only). 2 attempts to upload, 1.0 kB.',
    );
    uploads.viewSignal.set(
      queueView({ counts: { waiting: 0, pending: 0, uploading: 0, done: 5, failed: 1 } }),
    );
    await fixture.whenStable();
    expect(link(element)?.getAttribute('data-state')).toBe('failed');
    expect(link(element)?.textContent.replace(/\s+/g, '')).toBe('↑1');
    expect(link(element)?.getAttribute('title')).toBe(
      '1 attempt could not be uploaded: see Sessions.',
    );
  });
});
