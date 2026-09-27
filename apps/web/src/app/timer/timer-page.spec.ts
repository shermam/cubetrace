import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { coreVersion } from '@cubetrace/core';
import type { MockInstance } from 'vitest';

import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage } from '../device/fake-browser';
import { TimerPage } from './timer-page';

describe('TimerPage', () => {
  function setup(query: Record<string, string>): MockInstance<CubeService['autoStartDemo']> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
        },
        {
          provide: BROWSER_GLOBALS,
          useValue: { navigator: {}, localStorage: new FakeLocalStorage() },
        },
      ],
    });
    return vi
      .spyOn(TestBed.inject(CubeService), 'autoStartDemo')
      .mockImplementation(() => undefined);
  }

  it('shows the version string of @cubetrace/core and the live cube panel', async () => {
    const autoStartDemo = setup({});
    const fixture = TestBed.createComponent(TimerPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toBe('Timer');
    expect(element.querySelector('[data-testid="core-version"]')?.textContent).toBe(coreVersion());
    expect(element.querySelector('app-live-cube-panel')).not.toBeNull();
    expect(autoStartDemo).not.toHaveBeenCalled();
  });

  it('starts the demo that ?demo and ?speed ask for', () => {
    const autoStartDemo = setup({ demo: '4', speed: '20' });
    TestBed.createComponent(TimerPage);

    expect(autoStartDemo).toHaveBeenCalledWith({ demo: '4', speed: '20' });
  });
});
