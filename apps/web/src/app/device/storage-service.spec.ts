import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from './browser-globals';
import { FakeStorageManager } from './fake-browser';
import { STORAGE_STOP_PERCENT, STORAGE_WARN_PERCENT, StorageService } from './storage-service';

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

  it('says the share of the quota in use, warns from 80% and is full from 95%', async () => {
    const storage = new FakeStorageManager({ usage: 0, quota: 10_000 });
    const service = create({ storage });
    expect(service.percent()).toBeNull();
    expect(service.level()).toBe('ok');
    expect([STORAGE_WARN_PERCENT, STORAGE_STOP_PERCENT]).toEqual([80, 95]);

    const levels: [number, number, string][] = [];
    for (const usage of [0, 7_999, 8_000, 9_499, 9_500, 12_000]) {
      storage.usage = usage;
      await service.refresh();
      levels.push([usage, Math.round((service.percent() ?? -1) * 100) / 100, service.level()]);
    }
    expect(levels).toEqual([
      [0, 0, 'ok'],
      [7_999, 79.99, 'ok'],
      [8_000, 80, 'warn'],
      [9_499, 94.99, 'warn'],
      [9_500, 95, 'full'],
      [12_000, 100, 'full'],
    ]);

    storage.quota = 0;
    await service.refresh();
    expect(service.percent()).toBeNull();
    expect(service.level()).toBe('ok');
  });
});
