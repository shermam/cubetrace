import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MemorySessionStore } from '@cubetrace/core';
import type { MockInstance } from 'vitest';

import { ConnectDialogService } from '../connect/connect-dialog-service';
import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { SCRAMBLE_SOURCE, SessionService } from '../session/session-service';
import { SESSION_STORAGE } from '../session/session-storage';
import { TWISTY_LOADER } from './scramble-view';
import { TimerPage } from './timer-page';

describe('TimerPage', () => {
  let autoStartDemo: MockInstance<CubeService['autoStartDemo']>;

  function setup(query: Record<string, string> = {}): void {
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
        { provide: SESSION_STORAGE, useValue: { store: new MemorySessionStore(), kind: 'opfs' } },
        { provide: SCRAMBLE_SOURCE, useValue: () => Promise.resolve("R U2 F'") },
        { provide: TWISTY_LOADER, useValue: () => Promise.resolve() },
      ],
    });
    autoStartDemo = vi
      .spyOn(TestBed.inject(CubeService), 'autoStartDemo')
      .mockImplementation(() => undefined);
  }

  async function render(): Promise<ComponentFixture<TimerPage>> {
    const fixture = TestBed.createComponent(TimerPage);
    await fixture.whenStable();
    return fixture;
  }

  function query(fixture: ComponentFixture<TimerPage>, selector: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(selector);
  }

  it('lays out the scramble, the time, the breakdown and the solves, and the Cube section', async () => {
    setup();
    const fixture = await render();

    expect(query(fixture, 'h1')?.textContent).toBe('Timer');
    expect(query(fixture, '[data-testid="scramble"]')?.textContent).toBe("R U2 F'");
    expect(query(fixture, 'twisty-player')?.getAttribute('experimental-setup-alg')).toBe("R U2 F'");
    expect(query(fixture, '[data-testid="timer"]')?.textContent.trim()).toBe('0.00');
    expect(query(fixture, '[data-testid="timer-status"]')?.textContent.trim()).toBe(
      'Connect a cube to start.',
    );
    expect(query(fixture, 'app-breakdown-chart')).not.toBeNull();
    expect(query(fixture, 'app-solve-list')).not.toBeNull();
    const cube = query(fixture, '[data-testid="cube-section"]');
    expect(cube?.tagName).toBe('DETAILS');
    expect(cube?.hasAttribute('open')).toBe(false);
    expect(cube?.querySelector('summary')?.textContent).toContain('No cube');
    expect(cube?.querySelector('app-live-cube-panel')).not.toBeNull();
    expect(autoStartDemo).not.toHaveBeenCalled();
  });

  it('starts the demo that ?demo, ?speed and ?misscramble ask for, once the stored session is read', async () => {
    setup({ demo: '4', speed: '20', misscramble: '5' });
    TestBed.createComponent(TimerPage);
    expect(autoStartDemo).not.toHaveBeenCalled();

    await TestBed.inject(SessionService).whenReady();
    await settle();
    expect(autoStartDemo).toHaveBeenCalledWith({ demo: '4', speed: '20', misscramble: '5' });
  });

  it('answers Esc, Delete and N, but not while typing, with a modifier or with the dialog open', async () => {
    setup();
    const fixture = await render();
    const session = TestBed.inject(SessionService);
    const dnf = vi.spyOn(session, 'dnf').mockImplementation(() => undefined);
    const deleteLast = vi.spyOn(session, 'deleteLast').mockImplementation(() => undefined);
    const advance = vi.spyOn(session, 'advance').mockImplementation(() => undefined);
    const press = (
      key: string,
      init: KeyboardEventInit = {},
      target: EventTarget = document.body,
    ) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };

    expect(press('Escape').defaultPrevented).toBe(true);
    press('Delete');
    press('n');
    press('N');
    expect(dnf).toHaveBeenCalledTimes(1);
    expect(deleteLast).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(2);

    const input = document.createElement('input');
    document.body.append(input);
    press('n', {}, input);
    press('Escape', { ctrlKey: true });
    press('x');
    TestBed.inject(ConnectDialogService).open('details');
    press('Escape');
    input.remove();
    expect(dnf).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });
});
