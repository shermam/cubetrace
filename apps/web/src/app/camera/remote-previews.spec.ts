import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakePreviewTrack } from '../rtc/rtc-testing';
import {
  RemoteCameraRegistry,
  type RemoteCameraEntry,
  type RemoteCameraSource,
} from './remote-camera-registry';
import { RemotePreviews } from './remote-previews';

// The live pictures of the remote cameras over the host's preview (docs/PLAN.md T4.3, issue #60):
// a tile per phone, its thumbnail while its track does not flow, its live picture once it does, and
// a tap that swaps a phone's picture with the main one.

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
    synced: true,
    converged: true,
    recording: true,
    framing: { x: 108, y: 384, w: 540, h: 960 },
    frame: { width: 1080, height: 1920 },
    deviceLabel: 'camera 0, facing back',
    preview: null,
    thumbnail: null,
    ...changes,
  };
}

describe('RemotePreviews', () => {
  const cameras = signal<readonly RemoteCameraEntry[]>([]);

  async function render(local: MediaStream | null) {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: { MediaStream: TrackStream } }],
    });
    const source: RemoteCameraSource = {
      cameras,
      watchMotion: () => null,
      clockRecord: () => null,
    };
    TestBed.inject(RemoteCameraRegistry).provide(source);
    const fixture = TestBed.createComponent(RemotePreviews);
    fixture.componentRef.setInput('local', local);
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
});
