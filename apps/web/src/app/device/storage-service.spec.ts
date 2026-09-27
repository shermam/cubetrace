import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from './browser-globals';
import { FakeStorageManager } from './fake-browser';
import { StorageService } from './storage-service';

describe('StorageService', () => {
  function create(navigator: Partial<Navigator>): StorageService {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: { navigator } }],
    });
    return TestBed.inject(StorageService);
  }

  it('is unsupported without navigator.storage', async () => {
    const service = create({});

    await service.refresh();
    expect(service.persistence()).toBe('unsupported');
    expect(await service.persist()).toBe(false);
    expect(service.usage()).toBeNull();
  });

  it('reads the persistence status and the usage', async () => {
    const service = create({
      storage: new FakeStorageManager({ usage: 1_234_567, quota: 2_000_000_000 }),
    });
    expect(service.persistence()).toBe('unknown');

    await service.refresh();
    expect(service.persistence()).toBe('best-effort');
    expect(service.usage()).toEqual({ usage: 1_234_567, quota: 2_000_000_000 });
  });

  it('reports persistent storage when the browser grants it', async () => {
    const storage = new FakeStorageManager({ grant: true });
    const service = create({ storage });

    expect(await service.persist()).toBe(true);
    expect(storage.persistCalls).toBe(1);
    expect(service.persistence()).toBe('persistent');
    expect(service.refused()).toBe(false);
  });

  it('reports a refusal when the browser says no', async () => {
    const service = create({ storage: new FakeStorageManager({ grant: false }) });

    expect(await service.persist()).toBe(false);
    expect(service.persistence()).toBe('best-effort');
    expect(service.refused()).toBe(true);
  });
});
