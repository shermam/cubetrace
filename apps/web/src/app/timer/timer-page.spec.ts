import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MemorySessionStore } from '@cubetrace/core';
import type { MockInstance } from 'vitest';

import { CameraService } from '../camera/camera-service';
import { ConnectDialogService } from '../connect/connect-dialog-service';
import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeLocalStorage, FakeMediaQuery, settle } from '../device/fake-browser';
import { CURRENT_SESSION_KEY, SCRAMBLE_SOURCE, SessionService } from '../session/session-service';
import { SESSION_STORAGE } from '../session/session-storage';
import { SESSION_A, testAttempt, testSession } from '../session/session-testing';
import { SettingsService } from '../settings/settings-service';
import { TWISTY_LOADER } from './scramble-view';
import { TimerPage } from './timer-page';

describe('TimerPage', () => {
  let autoStartDemo: MockInstance<CubeService['autoStartDemo']>;

  function setup(
    query: Record<string, string> = {},
    store = new MemorySessionStore(),
    localStorage = new FakeLocalStorage(),
    globals: BrowserGlobals = {},
  ): void {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(query) } },
        },
        {
          provide: BROWSER_GLOBALS,
          useValue: { navigator: {}, localStorage, ...globals },
        },
        { provide: SESSION_STORAGE, useValue: { store, kind: 'opfs' } },
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

  /** The page once the deferred parts that a change brings have come. */
  async function update(fixture: ComponentFixture<TimerPage>): Promise<void> {
    for (let i = 0; i < 2; i++) {
      await settle();
      await fixture.whenStable();
    }
  }

  it('lays out the scramble, the time and the preview, the breakdown and the solves, the Cube section and Camera settings', async () => {
    setup();
    const fixture = await render();

    // The navigation says where this is: the heading is for screen readers only.
    expect(query(fixture, 'h1')?.textContent).toBe('Timer');
    expect(query(fixture, 'h1')?.classList).toContain('visually-hidden');
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
    // The camera's preview (beside the time) and settings (after the Cube section), chunks of their
    // own, come right after the page; the camera stays off, so the preview shows nothing.
    await fixture.whenStable();
    const preview = query(fixture, '.live section.clock + app-camera-preview');
    expect(preview).not.toBeNull();
    expect(preview?.classList).not.toContain('shown');
    const camera = query(fixture, '[data-testid="camera-section"]');
    expect(camera?.tagName).toBe('DETAILS');
    expect(camera?.hasAttribute('open')).toBe(false);
    expect(camera?.querySelector('summary h2')?.textContent).toBe('Camera settings');
    expect(camera?.querySelector('summary')?.textContent).toContain('Off');
    expect(cube?.nextElementSibling?.tagName).toBe('APP-CAMERA-PANEL');
    expect(autoStartDemo).not.toHaveBeenCalled();
  });

  it("on a phone, pins the scramble, over the camera's picture while the camera is on; T2.7's layout with the setting off or on a wide window", async () => {
    const wide = new FakeMediaQuery(false);
    const asked: string[] = [];
    setup({}, new MemorySessionStore(), new FakeLocalStorage(), {
      matchMedia: (media) => {
        asked.push(media);
        return wide;
      },
    });
    const settings = TestBed.inject(SettingsService);
    const camera = TestBed.inject(CameraService);
    const fixture = await render();
    await update(fixture);
    const layout = (): string | null | undefined =>
      query(fixture, '[data-testid="timer-layout"]')?.getAttribute('data-layout');
    const stage = (): string[] =>
      Array.from(query(fixture, '[data-testid="timer-stage"]')?.children ?? [], (child) =>
        [child.tagName.toLowerCase(), ...Array.from(child.classList)].join('.'),
      );
    const previews = (): number =>
      (fixture.nativeElement as HTMLElement).querySelectorAll('app-camera-preview').length;
    const scrambleView = (): HTMLElement | null => query(fixture, 'app-scramble-view');
    expect(asked).toEqual(['(min-width: 60rem)']);

    // The camera off: the scramble's card alone in the pinned part, the preview's place under the
    // time (where it shows nothing).
    expect(layout()).toBe('pinned');
    expect(stage()).toEqual(['section.scramble']);
    expect(query(fixture, '.live section.clock + app-camera-preview')).not.toBeNull();
    expect(scrambleView()?.classList).not.toContain('over-picture');
    expect(query(fixture, '[data-testid="scramble-picture"]')).not.toBeNull();

    // The camera on: its picture in the pinned part, the scramble over it without its own picture,
    // nothing beside the time, and the sync check under the time.
    await camera.start();
    await update(fixture);
    expect(settings.cameraOn()).toBe(true);
    expect(layout()).toBe('overlay');
    expect(stage()).toEqual(['section.scramble', 'app-camera-preview.shown.overlay']);
    expect(previews()).toBe(1);
    expect(query(fixture, '.live-row app-camera-preview')).toBeNull();
    expect(query(fixture, '.live > .live-row + app-sync-check')).not.toBeNull();
    expect(scrambleView()?.classList).toContain('over-picture');
    expect(query(fixture, '[data-testid="scramble-picture"]')).toBeNull();
    expect(query(fixture, '[data-testid="scramble"]')?.textContent).toBe("R U2 F'");

    // Scramble over the picture off: T2.7's column, the preview under the time with its sync check.
    settings.setScrambleOverPicture(false);
    await update(fixture);
    expect(layout()).toBe('stacked');
    expect(stage()).toEqual(['section.scramble']);
    expect(previews()).toBe(1);
    expect(query(fixture, '.live section.clock + app-camera-preview')?.className).toBe('shown');
    expect(query(fixture, '.live > app-sync-check')).toBeNull();
    expect(scrambleView()?.classList).not.toContain('over-picture');

    // On again, then a wide window: T2.7's columns, whatever the setting.
    settings.setScrambleOverPicture(true);
    await update(fixture);
    expect(layout()).toBe('overlay');
    wide.set(true);
    await update(fixture);
    expect(layout()).toBe('columns');
    expect(stage()).toEqual(['section.scramble']);
    expect(query(fixture, '.live section.clock + app-camera-preview')?.className).toBe('shown');
    expect(previews()).toBe(1);

    // A phone again, the camera off: the scramble pinned alone.
    wide.set(false);
    camera.stop();
    await update(fixture);
    expect(layout()).toBe('pinned');
    expect(stage()).toEqual(['section.scramble']);
    expect(previews()).toBe(1);
    fixture.destroy();
  });

  it('lists the last 12 solves of the session, with "See all" to its page', async () => {
    const store = new MemorySessionStore();
    await store.createSession(testSession(SESSION_A));
    for (let index = 1; index <= 15; index++) {
      await store.saveAttempt(testAttempt(index, 10_000 + index * 100));
    }
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
    setup({}, store, localStorage);
    const fixture = await render();
    await TestBed.inject(SessionService).whenReady();
    await fixture.whenStable();

    const rows = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="solve-row"]'),
      (row) => Number(row.getAttribute('data-index')),
    );
    expect(rows).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(query(fixture, '[data-testid="stat-count"]')?.textContent.trim()).toBe('15');
    const footer = query(fixture, '[data-testid="solve-list-footer"]');
    expect(footer?.textContent.replace(/\s+/g, ' ').trim()).toBe(
      '15 solves in this session · See all',
    );
    expect(footer?.querySelector('a')?.getAttribute('href')).toBe(`/sessions/${SESSION_A}`);
  });

  it('starts the demo that ?demo, ?speed and ?misscramble ask for, once the stored session is read', async () => {
    setup({ demo: '4', speed: '20', misscramble: '5' });
    TestBed.createComponent(TimerPage);
    expect(autoStartDemo).not.toHaveBeenCalled();

    await TestBed.inject(SessionService).whenReady();
    await settle();
    expect(autoStartDemo).toHaveBeenCalledWith({
      demo: '4',
      speed: '20',
      misscramble: '5',
      gyro: null,
    });
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
