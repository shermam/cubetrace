import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeStorageManager, settle } from '../device/fake-browser';
import { StorageMeter } from './storage-meter';

describe('StorageMeter', () => {
  async function render(navigator: Partial<Navigator>): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: { navigator } }],
    });
    const fixture = TestBed.createComponent(StorageMeter);
    await settle();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  function text(element: HTMLElement, testId: string): string | undefined {
    return element
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent.replace(/\s+/g, ' ')
      .trim();
  }

  it('says how much of the quota is used, read when it is shown', async () => {
    const element = await render({
      storage: new FakeStorageManager({ usage: 2_150_000_000, quota: 10_740_000_000 }),
    });

    expect(text(element, 'storage-meter-text')).toBe('2.1 GB of 10.7 GB (20%)');
    expect(element.querySelector('meter')?.value).toBeCloseTo(20.02, 1);
    expect(element.querySelector('[data-testid="storage-meter"]')?.getAttribute('data-level')).toBe(
      'ok',
    );
    expect(element.querySelector('[data-testid="storage-warning"]')).toBeNull();
  });

  it('warns from 80%, and says from 95% that the camera stopped recording', async () => {
    const storage = new FakeStorageManager({ usage: 8_049_000, quota: 10_000_000 });
    let element = await render({ storage });
    expect(text(element, 'storage-warning')).toBe(
      'Storage is 80% full: export or delete sessions.',
    );

    TestBed.resetTestingModule();
    storage.usage = 9_600_000;
    element = await render({ storage });
    expect(text(element, 'storage-warning')).toBe(
      'Storage is 96% full: the camera stopped recording (the timer goes on). Export or delete sessions to record again.',
    );
    expect(element.querySelector('[data-testid="storage-meter"]')?.getAttribute('data-level')).toBe(
      'full',
    );
  });

  it('says it is unknown where the browser cannot tell', async () => {
    const element = await render({});
    expect(text(element, 'storage-meter-text')).toBe('unknown in this browser');
  });
});
