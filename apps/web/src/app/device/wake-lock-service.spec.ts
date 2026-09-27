import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from './browser-globals';
import { FakeWakeLock, settle } from './fake-browser';
import { WakeLockService } from './wake-lock-service';

describe('WakeLockService', () => {
  let wakeLock: FakeWakeLock;
  let visibility: DocumentVisibilityState;

  function create(navigator: Partial<Navigator>): WakeLockService {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: { navigator } }],
    });
    return TestBed.inject(WakeLockService);
  }

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    wakeLock = new FakeWakeLock();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    // Back to jsdom's own getter, on Document.prototype.
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('is unsupported without navigator.wakeLock, and request() does nothing', async () => {
    const service = create({});

    await service.request();

    expect(service.status()).toBe('unsupported');
    expect(service.wanted()).toBe(false);
  });

  it('holds the lock from request() to release()', async () => {
    const service = create({ wakeLock });
    expect(service.status()).toBe('inactive');

    await service.request();
    expect(service.status()).toBe('active');
    expect(service.wanted()).toBe(true);
    expect(wakeLock.held()).toBe(1);

    await service.release();
    expect(service.status()).toBe('inactive');
    expect(service.wanted()).toBe(false);
    expect(wakeLock.held()).toBe(0);
  });

  it('asks again when the page is visible again after the browser released the lock', async () => {
    const service = create({ wakeLock });
    await service.request();

    // What Chrome does when the page is hidden (another app, the screen off).
    setVisibility('hidden');
    await wakeLock.sentinels[0].release();
    expect(service.status()).toBe('inactive');

    setVisibility('visible');
    await settle();
    expect(service.status()).toBe('active');
    expect(wakeLock.sentinels).toHaveLength(2);
    expect(wakeLock.held()).toBe(1);
  });

  it('does not ask again after release()', async () => {
    const service = create({ wakeLock });
    await service.request();
    await service.release();

    setVisibility('hidden');
    setVisibility('visible');
    await settle();

    expect(service.status()).toBe('inactive');
    expect(wakeLock.sentinels).toHaveLength(1);
  });

  it('waits for the page to be visible before asking', async () => {
    const service = create({ wakeLock });
    visibility = 'hidden';

    await service.request();
    expect(wakeLock.sentinels).toHaveLength(0);
    expect(service.status()).toBe('inactive');

    setVisibility('visible');
    await settle();
    expect(service.status()).toBe('active');
  });

  it('reports a refusal, and asks again when the page is visible again', async () => {
    const service = create({ wakeLock });
    wakeLock.refuseWith = new DOMException(
      'Wake Lock permission request denied',
      'NotAllowedError',
    );

    await service.request();
    expect(service.status()).toBe('error');
    expect(service.error()).toContain('Wake Lock permission request denied');

    wakeLock.refuseWith = null;
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(service.status()).toBe('active');
    expect(service.error()).toBeNull();
  });

  it('lets go of a lock granted after release() was called', async () => {
    const service = create({ wakeLock });

    const requested = service.request();
    await service.release();
    await requested;

    expect(service.status()).toBe('inactive');
    expect(wakeLock.held()).toBe(0);
  });
});
