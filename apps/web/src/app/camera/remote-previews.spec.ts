import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakePerformance, FakeTimers } from '../device/fake-browser';
import { FakePreviewTrack, rtcTimers } from '../rtc/rtc-testing';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { SettingsService } from '../settings/settings-service';
import {
  RemoteCameraRegistry,
  type RemoteCameraEntry,
  type RemoteCameraSource,
} from './remote-camera-registry';
import { RemotePreviews } from './remote-previews';
import type { RemoteReport } from './remote-status';

// The live pictures of the remote cameras on the Timer page (docs/PLAN.md T4.3, issue #60; T5.1):
// as tiles over the host's preview, its thumbnail while its track does not flow, its live picture
// once it does, a tap that swaps a phone's picture with the main one; or as cells as large as the
// host's own, each with the phone's status line under it.

/** What a phone reports, in its `state`. */
const REPORT: RemoteReport = {
  recording: true,
  framing: { x: 108, y: 384, w: 540, h: 960 },
  fps: 29.9,
  sharpness: 41.2,
  battery: { level: 0.83, charging: true },
  thermal: 'ok',
  pressure: 'nominal',
  pressureSource: 'thermals',
  pendingClips: 0,
};

/** A stream of tracks, as the browser's `MediaStream` makes one (jsdom has none). */
class TrackStream {
  constructor(readonly tracks: unknown[]) {}
}

function camera(id: string, changes: Partial<RemoteCameraEntry> = {}): RemoteCameraEntry {
  return {
    id,
    name: 'ThinkPhone',
    label: `phone-rear${id === 'a' ? '' : `-${id}`}`,
    session: 'session',
    state: 'connected',
    // Connected when the test's clock starts (FakePerformance's origin).
    sinceMs: 1_790_000_000_000,
    synced: true,
    converged: true,
    recording: true,
    framing: { x: 108, y: 384, w: 540, h: 960 },
    frame: { width: 1080, height: 1920 },
    deviceLabel: 'camera 0, facing back',
    preview: null,
    thumbnail: null,
    report: null,
    reportMs: null,
    ...changes,
  };
}

describe('RemotePreviews', () => {
  const cameras = signal<readonly RemoteCameraEntry[]>([]);
  let perf: FakePerformance;
  let timers: FakeTimers;

  beforeEach(() => {
    perf = new FakePerformance();
    timers = new FakeTimers(perf);
  });

  async function render(local: MediaStream | null, layout: 'equal' | 'tiles' = 'tiles') {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: { MediaStream: TrackStream } },
        { provide: RTC_TIMERS, useValue: rtcTimers(perf, timers) },
      ],
    });
    const source: RemoteCameraSource = {
      cameras,
      watchMotion: () => null,
      clockRecord: () => null,
    };
    TestBed.inject(RemoteCameraRegistry).provide(source);
    const fixture = TestBed.createComponent(RemotePreviews);
    fixture.componentRef.setInput('local', local);
    fixture.componentRef.setInput('layout', layout);
    const element = fixture.nativeElement as HTMLElement;
    const refresh = async (): Promise<void> => {
      fixture.detectChanges();
      await fixture.whenStable();
    };
    await refresh();
    return { element, refresh };
  }

  function tiles(element: HTMLElement): string[] {
    return [...element.querySelectorAll('[data-testid="remote-preview-tile"]')].map(
      (tile) => tile.getAttribute('data-label') ?? '',
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    cameras.set([]);
  });

  it('shows a tile per phone: its thumbnail while its track does not flow, its live picture once it does, its framing over it', async () => {
    const flowing = new FakePreviewTrack();
    cameras.set([
      camera('a', { preview: flowing.track, thumbnail: 'blob:a' }),
      camera('2'),
      camera('3', { label: null }),
    ]);
    const { element, refresh } = await render({} as MediaStream);
    // Phones with a camera only; no main picture: this device's preview is under them.
    expect(tiles(element)).toEqual(['phone-rear', 'phone-rear-2']);
    expect(element.querySelector('[data-testid="remote-preview-main"]')).toBeNull();
    const [first, second] = [...element.querySelectorAll('app-remote-picture')];
    expect(first.getAttribute('data-live')).toBe('false');
    expect(
      first.querySelector('[data-testid="remote-picture-thumbnail"]')?.getAttribute('src'),
    ).toBe('blob:a');
    expect(second.querySelector('[data-testid="remote-picture-none"]')?.textContent).toBe(
      'no picture yet',
    );
    // Its framing rectangle, in percent of its upright frames.
    const framing = first.querySelector<HTMLElement>('.framing');
    expect(framing?.style.left).toBe('10%');
    expect(framing?.style.width).toBe('50%');

    // Frames come: the live picture, the thumbnail gone; they stop: the thumbnail again.
    flowing.flow(true);
    await refresh();
    expect(first.getAttribute('data-live')).toBe('true');
    expect(first.querySelector('[data-testid="remote-picture-thumbnail"]')).toBeNull();
    const video = first.querySelector<HTMLVideoElement>('[data-testid="remote-picture-video"]');
    expect((video?.srcObject as unknown as TrackStream).tracks).toEqual([flowing.track]);
    expect(video?.muted).toBe(true);
    flowing.flow(false);
    await refresh();
    expect(first.getAttribute('data-live')).toBe('false');
    expect(first.querySelector('[data-testid="remote-picture-thumbnail"]')).not.toBeNull();
  });

  it("swaps a phone's picture with the main one at a tap, and back", async () => {
    cameras.set([camera('a'), camera('2')]);
    const local = new TrackStream([]) as unknown as MediaStream;
    const { element, refresh } = await render(local);
    element.querySelector<HTMLButtonElement>('[data-label="phone-rear-2"]')?.click();
    await refresh();
    const main = element.querySelector('[data-testid="remote-preview-main"]');
    expect(main?.getAttribute('data-label')).toBe('phone-rear-2');
    // This device's picture in a tile, the other phone's beside it.
    expect(tiles(element)).toEqual(['phone-rear']);
    const own = element.querySelector<HTMLButtonElement>('[data-testid="remote-preview-local"]');
    expect(own?.querySelector('video')?.srcObject).toBe(local);
    own?.click();
    await refresh();
    expect(element.querySelector('[data-testid="remote-preview-main"]')).toBeNull();
    expect(tiles(element)).toEqual(['phone-rear', 'phone-rear-2']);
  });

  it("says in a tile's caption, in short, what is wrong with the phone (T5.1)", async () => {
    cameras.set([
      camera('a', {
        report: { ...REPORT, sharpness: 9.5, battery: { level: 0.15, charging: false } },
        reportMs: 1_790_000_000_000,
      }),
      camera('2', { report: REPORT, reportMs: 1_790_000_000_000 }),
    ]);
    const { element } = await render({} as MediaStream);
    const captions = [...element.querySelectorAll('[data-testid="remote-caption"]')].map(
      (caption) => caption.textContent.replace(/\s+/g, ' ').trim(),
    );
    expect(captions).toEqual(['phone-rear · soft · 15%', 'phone-rear-2']);
    const soft = element.querySelector('[data-testid="remote-caption-sharpness"]');
    expect(soft?.getAttribute('data-tone')).toBe('warn');
  });

  it("makes the first phone's picture the main one without a camera of this device's", async () => {
    cameras.set([camera('a'), camera('2')]);
    const { element, refresh } = await render(null);
    expect(
      element.querySelector('[data-testid="remote-preview-main"]')?.getAttribute('data-label'),
    ).toBe('phone-rear');
    expect(tiles(element)).toEqual(['phone-rear-2']);
    expect(element.querySelector('[data-testid="remote-preview-local"]')).toBeNull();
    // The phone that was the main picture goes: the next one is.
    cameras.set([camera('2')]);
    await refresh();
    expect(
      element.querySelector('[data-testid="remote-preview-main"]')?.getAttribute('data-label'),
    ).toBe('phone-rear-2');
    expect(tiles(element)).toEqual([]);
  });

  describe('as large as the host’s own picture (T5.1)', () => {
    function cells(element: HTMLElement): HTMLElement[] {
      return [...element.querySelectorAll<HTMLElement>('[data-testid="remote-preview-cell"]')];
    }

    function line(cell: HTMLElement | undefined): string {
      return (
        cell
          ?.querySelector('[data-testid="remote-status"]')
          ?.textContent.replace(/\s+/g, ' ')
          .trim() ?? ''
      );
    }

    it('gives each phone a cell: its picture with the framing drawn as on the host’s, its label, and its status line', async () => {
      const flowing = new FakePreviewTrack();
      cameras.set([
        camera('a', { preview: flowing.track, report: REPORT, reportMs: perf.hostMs }),
        camera('2', { converged: false, framing: null }),
        camera('3', { label: null }),
      ]);
      const { element, refresh } = await render(null, 'equal');
      // No tiles, no main picture, nothing to tap: the cells are CameraPreview's grid's.
      expect(element.classList).toContain('equal');
      expect(tiles(element)).toEqual([]);
      expect(element.querySelector('[data-testid="remote-preview-main"]')).toBeNull();
      const [first, second] = cells(element);
      expect(cells(element).map((cell) => cell.getAttribute('data-label'))).toEqual([
        'phone-rear',
        'phone-rear-2',
      ]);
      const picture = first.querySelector('app-remote-picture');
      expect(picture?.classList).toContain('full');
      expect(first.querySelector('[data-testid="remote-picture-framing"]')).not.toBeNull();
      expect(first.querySelector('.caption')?.textContent.trim()).toBe('phone-rear');
      flowing.flow(true);
      await refresh();
      expect(picture?.getAttribute('data-live')).toBe('true');

      expect(line(first)).toBe(
        '29.9 fps · sharpness 41 · recording · battery 83%, charging · pressure nominal',
      );
      const parts = [...first.querySelectorAll('[data-testid^="remote-status-"]')].map((part) => [
        part.getAttribute('data-key'),
        part.getAttribute('data-tone'),
      ]);
      expect(parts).toEqual([
        ['fps', 'plain'],
        ['sharpness', 'ok'],
        ['recording', 'plain'],
        ['battery', 'plain'],
        ['pressure', 'plain'],
      ]);
      // The recording in the host's style: the red dot.
      expect(first.querySelector('[data-key="recording"] .dot')).not.toBeNull();
      // No report yet, the clock not converged.
      expect(line(second)).toBe('no report yet · clock syncing…');
      // Its rectangle the whole frame: drawn around it, as the host's own is.
      const whole = second.querySelector<HTMLElement>('[data-testid="remote-picture-framing"]');
      expect([
        whole?.style.left,
        whole?.style.top,
        whole?.style.width,
        whole?.style.height,
      ]).toEqual(['0%', '0%', '100%', '100%']);
    });

    it('follows the reports: a soft picture, a hot phone, an unplugged one, the threshold of Settings', async () => {
      cameras.set([camera('a', { report: REPORT, reportMs: perf.hostMs })]);
      const { element, refresh } = await render(null, 'equal');
      const tone = (key: string): string | null | undefined =>
        cells(element)[0]
          .querySelector(`[data-testid="remote-status-${key}"]`)
          ?.getAttribute('data-tone');
      cameras.set([
        camera('a', {
          report: {
            ...REPORT,
            sharpness: 12,
            thermal: 'throttled',
            pressure: 'serious',
            battery: { level: 0.08, charging: false },
          },
          reportMs: perf.hostMs,
        }),
      ]);
      await refresh();
      expect(line(cells(element)[0])).toBe(
        '29.9 fps · sharpness 12 · recording · battery 8% · hot: the frame rate dropped · pressure serious',
      );
      expect([tone('sharpness'), tone('battery'), tone('thermal'), tone('pressure')]).toEqual([
        'warn',
        'bad',
        'warn',
        'bad',
      ]);
      // Settings' threshold lowered: 12 is good.
      TestBed.inject(SettingsService).setSharpnessThreshold(10);
      await refresh();
      expect(tone('sharpness')).toBe('ok');
    });

    it('says in red when the reports stop for 10 s, within a second, and when the phone reconnects', async () => {
      cameras.set([camera('a', { report: REPORT, reportMs: perf.hostMs })]);
      const { element, refresh } = await render(null, 'equal');
      const stale = (): string | undefined =>
        cells(element)[0].querySelector('[data-testid="remote-status-stale"]')?.textContent.trim();
      timers.advance(9_000);
      await refresh();
      expect(stale()).toBeUndefined();
      timers.advance(1_000);
      await refresh();
      expect(stale()).toBe('no report for 10 s');
      timers.advance(5_000);
      await refresh();
      expect(stale()).toBe('no report for 15 s');
      // The connection dropped: it says so, and not the reports.
      cameras.set([
        camera('a', { report: REPORT, reportMs: perf.hostMs - 15_000, state: 'reconnecting' }),
      ]);
      await refresh();
      expect(stale()).toBeUndefined();
      expect(line(cells(element)[0])).toMatch(/ · reconnecting…$/);
      // The phones go: the clock stops.
      cameras.set([]);
      await refresh();
      expect(timers.pending).toBe(0);
    });
  });
});
