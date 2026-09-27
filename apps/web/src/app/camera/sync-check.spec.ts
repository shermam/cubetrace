import { TestBed } from '@angular/core/testing';

import { SYNC_GRACE_MS } from '../session/session-service';
import { SYNC_TICK_MS } from './sync-run';
import { SyncCheck } from './sync-check';
import { settle } from '../device/fake-browser';
import { turn } from '../session/session-harness';
import {
  AROUND_THE_CUBE,
  STILL,
  clapperboard,
  film,
  recording,
  rig,
  update,
  type Rig,
} from './sync-testing';

describe('SyncCheck', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function render(r: Rig) {
    const fixture = TestBed.createComponent(SyncCheck);
    const element = fixture.nativeElement as HTMLElement;
    const refresh = async (): Promise<void> => {
      await update(r);
      await fixture.whenStable();
    };
    return { element, refresh };
  }

  function text(element: HTMLElement, testId: string): string | undefined {
    return element
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent.replace(/\s+/g, ' ')
      .trim();
  }

  function button(element: HTMLElement, testId: string): HTMLButtonElement | null {
    return element.querySelector<HTMLButtonElement>(`button[data-testid="${testId}"]`);
  }

  function state(element: HTMLElement): string | null | undefined {
    return element.querySelector('[data-testid="sync-check"]')?.getAttribute('data-state');
  }

  it('asks for one face turned and turned back five times, counts the turns out of ten, then says why the check failed, with Retry and its data', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    await refresh();
    // No camera: nothing.
    expect(element.textContent.trim()).toBe('');

    const { fake, capture } = await recording(r);
    await refresh();
    const panel = element.querySelector('[data-testid="sync-check"]');
    expect(state(element)).toBe('running');
    expect(panel?.textContent).toContain('Turn one face, pause, turn it back; repeat five times.');
    expect(panel?.textContent).toContain(
      'The timer waits meanwhile: the attempt begins again, with its scramble, once the check ends and the cube is solved and still.',
    );
    expect(text(element, 'sync-count')).toBe('20 s for the first turn');

    const { turns, energy } = clapperboard(r.s.perf.hostMs, [40, 42, 41]);
    await film(r, capture, fake, 1300, energy, turns);
    await refresh();
    expect(text(element, 'sync-count')).toBe('Turn 1 of 10 · 1 seen by the camera');
    const count = element.querySelector('[data-testid="sync-count"]');
    expect(Number(count?.getAttribute('data-frames'))).toBeGreaterThan(35);
    expect(count?.getAttribute('data-moves')).toBe('1');
    expect(count?.getAttribute('data-matched')).toBe('1');
    await film(r, capture, fake, 2600, energy, turns);
    await refresh();
    expect(text(element, 'sync-progress')).toBe('Turn 3 of 10');

    // Three turns, then nothing: it waits for the others, whatever the time, until Later.
    await film(r, capture, fake, 20_000, STILL);
    await refresh();
    expect(state(element)).toBe('running');
    button(element, 'sync-later')?.click();
    await refresh();
    expect(element.querySelector('[data-testid="sync-check"]')).toBeNull();

    // A check without a turn fails after its 20 s.
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    button(element, 'sync-start')?.click();
    await refresh();
    await film(r, capture, fake, 20_000 + SYNC_TICK_MS, STILL);
    await refresh();
    expect(state(element)).toBe('failed');
    expect(text(element, 'sync-failure')).toBe('Sync check failed: the cube did not move.');
    expect(element.querySelector('[data-testid="sync-failure"]')?.getAttribute('data-reason')).toBe(
      'no-moves',
    );
    expect(button(element, 'sync-later')?.textContent.trim()).toBe('Later');
    expect(button(element, 'sync-download')?.textContent.trim()).toBe('Download check data');
    expect(element.textContent).toContain('attach it to an issue');

    button(element, 'sync-retry')?.click();
    await refresh();
    expect(state(element)).toBe('running');
    expect(capture.watches).toHaveLength(3);
  });

  it('says the lag, and the one before on a second check; Close leaves one line to run it again', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    const { fake, capture } = await recording(r);
    const first = clapperboard(r.s.perf.hostMs, [44, 50, 47, 52, 49, 44, 50, 47, 52, 49]);
    await film(r, capture, fake, 14_000, first.energy, first.turns);
    await refresh();

    expect(text(element, 'sync-result')).toBe('Camera lags the cube by 49 ms (±8).');
    expect(button(element, 'sync-later')?.textContent.trim()).toBe('Close');
    expect(button(element, 'sync-download')?.classList.contains('link')).toBe(true);
    button(element, 'sync-later')?.click();
    await refresh();
    expect(element.querySelector('[data-testid="sync-check"]')).toBeNull();
    expect(text(element, 'sync-line')).toBe('Sync: camera lags the cube by 49 ms (±8). Sync check');

    button(element, 'sync-start')?.click();
    await refresh();
    const second = clapperboard(r.s.perf.hostMs, [30, 31, 32, 31, 30, 30, 31, 32, 31, 30]);
    await film(r, capture, fake, 14_000, second.energy, second.turns);
    await refresh();
    expect(text(element, 'sync-result')).toBe('Camera lags the cube by 31 ms (±2); was 49 ms.');
  });

  it('with the whole frame to watch, asks for a framing rectangle around the cube first, which the settings open to', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    await recording(r, { framed: false });
    await refresh();

    expect(state(element)).toBe('framing');
    expect(text(element, 'sync-framing')).toBe(
      'Draw the framing rectangle around the cube first (Camera settings → Framing → Edit): the check looks for motion inside it.',
    );
    button(element, 'sync-edit-framing')?.click();
    await refresh();
    expect(r.camera.framingEditing()).toBe(true);

    // A rectangle around the cube: the hint goes, and Start starts the check.
    r.camera.setFraming(AROUND_THE_CUBE);
    await refresh();
    expect(state(element)).toBe('ready');
    expect(element.querySelector('[data-testid="sync-framing"]')).toBeNull();
    button(element, 'sync-go')?.click();
    await refresh();
    expect(state(element)).toBe('running');
  });

  it('"Start anyway" runs the check on the whole frame', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    const { capture } = await recording(r, { framed: false });
    await refresh();

    button(element, 'sync-anyway')?.click();
    await refresh();
    expect(state(element)).toBe('running');
    expect(capture.watches[0].rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('"Later" hides the panel; "Sync check" says beside it why it cannot start now', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    const { fake, capture } = await recording(r);
    await refresh();

    button(element, 'sync-later')?.click();
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    await refresh();
    expect(element.querySelector('[data-testid="sync-check"]')).toBeNull();
    expect(text(element, 'sync-line')).toBe(
      'Sync: this camera has no check in this session. Sync check',
    );
    const start = button(element, 'sync-start');
    expect(start?.disabled).toBe(false);
    expect(element.querySelector('[data-testid="sync-why"]')).toBeNull();

    // The scramble begun: after the solve.
    turn(r.s, fake, 'R');
    await refresh();
    expect(start?.disabled).toBe(true);
    expect(start?.title).toBe("Before the scramble's first turn, or after the solve.");
    expect(text(element, 'sync-why')).toBe("Before the scramble's first turn, or after the solve.");
    // Undone and skipped: the next attempt's scramble has not begun.
    turn(r.s, fake, "R'");
    r.s.service.skip();
    await settle();
    await refresh();
    expect(r.s.service.attempt()?.events.scrambleStart).toBeNull();
    expect(start?.disabled).toBe(false);

    // The cube disconnected: no turn to see.
    await r.s.cube.disconnect();
    await refresh();
    expect(start?.disabled).toBe(true);
    expect(start?.title).toBe('Once a cube is connected.');
    expect(text(element, 'sync-why')).toBe('Once a cube is connected.');
  });
});
