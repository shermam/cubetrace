import { TestBed } from '@angular/core/testing';

import { SYNC_TICK_MS } from './sync-run';
import { SyncCheck } from './sync-check';
import { clapperboard, film, recording, rig, update, type Rig } from './sync-testing';

describe('SyncCheck', () => {
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

  it('asks for five turns with a countdown and counts, then says why the check failed, with Retry', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    await refresh();
    // No camera: nothing.
    expect(element.textContent.trim()).toBe('');

    const { fake, capture } = await recording(r);
    await refresh();
    const panel = element.querySelector('[data-testid="sync-check"]');
    expect(panel?.getAttribute('data-state')).toBe('running');
    expect(panel?.textContent).toContain(
      'Make five single turns with a pause of about a second between them.',
    );
    expect(text(element, 'sync-count')).toBe('20 s 0 turns, 0 motion onsets');

    const { turns, energy } = clapperboard(r.s.perf.hostMs, [40, 40, 40, 40, 40]);
    await film(r, capture, fake, 1300, energy, turns.slice(0, 1));
    await refresh();
    expect(text(element, 'sync-count')).toBe('19 s 1 turn, 1 motion onset');
    const count = element.querySelector('[data-testid="sync-count"]');
    expect(Number(count?.getAttribute('data-frames'))).toBeGreaterThan(35);
    expect(count?.getAttribute('data-moves')).toBe('1');
    expect(count?.getAttribute('data-onsets')).toBe('1');

    // One turn only: after 20 s, too few.
    await film(r, capture, fake, 18_700 + SYNC_TICK_MS, () => 1);
    await refresh();
    expect(panel?.getAttribute('data-state')).toBe('failed');
    expect(text(element, 'sync-failure')).toBe(
      'Sync check failed: fewer than 4 matches (1 of 1 single turn matched a motion).',
    );
    expect(element.querySelector('[data-testid="sync-failure"]')?.getAttribute('data-reason')).toBe(
      'few-matches',
    );
    expect(button(element, 'sync-later')?.textContent.trim()).toBe('Later');

    button(element, 'sync-retry')?.click();
    await refresh();
    expect(element.querySelector('[data-testid="sync-check"]')?.getAttribute('data-state')).toBe(
      'running',
    );
    expect(capture.watches).toHaveLength(2);
  });

  it('says the lag, and the one before on a second check; Close leaves one line to run it again', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    const { fake, capture } = await recording(r);
    const first = clapperboard(r.s.perf.hostMs, [44, 50, 47, 52, 49]);
    await film(r, capture, fake, 8000, first.energy, first.turns);
    await refresh();

    expect(text(element, 'sync-result')).toBe('Camera lags the cube by 49 ms (±8).');
    expect(button(element, 'sync-later')?.textContent.trim()).toBe('Close');
    button(element, 'sync-later')?.click();
    await refresh();
    expect(element.querySelector('[data-testid="sync-check"]')).toBeNull();
    expect(text(element, 'sync-line')).toBe('Sync: camera lags the cube by 49 ms (±8). Sync check');

    button(element, 'sync-start')?.click();
    await refresh();
    const second = clapperboard(r.s.perf.hostMs, [30, 31, 32, 31, 30]);
    await film(r, capture, fake, 8000, second.energy, second.turns);
    await refresh();
    expect(text(element, 'sync-result')).toBe('Camera lags the cube by 31 ms (±2); was 49 ms.');
  });

  it('"Later" hides the panel; "Sync check" waits for the end of a solve', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    await recording(r);
    await refresh();

    button(element, 'sync-later')?.click();
    await refresh();
    expect(element.querySelector('[data-testid="sync-check"]')).toBeNull();
    expect(text(element, 'sync-line')).toBe(
      'Sync: this camera has no check in this session. Sync check',
    );
    const start = button(element, 'sync-start');
    expect(start?.disabled).toBe(false);

    // The cube disconnected: no turn to see.
    await r.s.cube.disconnect();
    await refresh();
    expect(start?.disabled).toBe(true);
    expect(start?.title).toBe('Once a cube is connected.');
  });
});
