import { TestBed } from '@angular/core/testing';

import { SYNC_GRACE_MS, SYNC_SETTLE_MS } from '../session/session-service';
import { SYNC_TICK_MS } from './sync-run';
import { SyncCheck } from './sync-check';
import { FAKE_FACETIME, FAKE_WEBCAM, settle } from '../device/fake-browser';
import { ready, turn } from '../session/session-harness';
import { statsOf } from './recording-testing';
import { RemoteCameraRegistry } from './remote-camera-registry';
import {
  AROUND_THE_CUBE,
  FakeRemoteSource,
  STILL,
  clapperboard,
  film,
  filmTo,
  recording,
  remotePhone,
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

  it('asks for one face flicked and flicked back five times, the cube still, counts the turns out of ten, then says why the check failed, with Retry and its data', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    await refresh();
    // No camera: nothing.
    expect(element.textContent.trim()).toBe('');

    const { fake, capture } = await recording(r);
    await refresh();
    const panel = element.querySelector('[data-testid="sync-check"]');
    const words = panel?.textContent.replace(/\s+/g, ' ');
    expect(state(element)).toBe('running');
    expect(words).toContain(
      'Hold the cube still inside the rectangle. With one finger, flick one face; keep your other hand and the cube still; after a second, flick it back. Five times.',
    );
    expect(words).toContain(
      'The timer waits meanwhile: the attempt begins again, with its scramble, once the check ends and the cube is solved and still.',
    );
    // Its first second: hold still.
    expect(text(element, 'sync-count')).toBe('Hold still… wait a second before the first turn');
    expect(text(element, 'sync-hold')).toBe('Hold still…');

    const { turns, energy } = clapperboard(r.s.perf.hostMs, [40, 42, 41]);
    await film(r, capture, fake, 1100, energy, turns);
    await refresh();
    expect(text(element, 'sync-count')).toBe('19 s for the first turn');
    await film(r, capture, fake, 200, energy, turns);
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
    // Two lags far off, which the spread leaves out: the other eight's median is 49, their spread 8.
    const first = clapperboard(r.s.perf.hostMs, [45, 10, 47, 48, 49, 95, 49, 50, 51, 53]);
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

  it("says the check of the camera that is on: another camera of the session has none, the first one's lag comes back (T2.14)", async () => {
    const r = rig([FAKE_WEBCAM, FAKE_FACETIME]);
    const { element, refresh } = render(r);
    const { fake, capture } = await recording(r);
    const first = clapperboard(r.s.perf.hostMs, [45, 10, 47, 48, 49, 95, 49, 50, 51, 53]);
    await film(r, capture, fake, 14_000, first.energy, first.turns);
    await refresh();
    button(element, 'sync-later')?.click();
    await film(r, capture, fake, SYNC_SETTLE_MS + SYNC_GRACE_MS + SYNC_TICK_MS, STILL);
    await refresh();
    const lag = 'Sync: camera lags the cube by 49 ms (±8). Sync check';
    expect(text(element, 'sync-line')).toBe(lag);

    // The FaceTime camera, `laptop-2` in the session: no check of it yet, and one is due.
    await r.camera.select('facetime');
    await refresh();
    r.starter.last.emitStats(statsOf(5));
    await refresh();
    expect(state(element)).toBe('framing');
    button(element, 'sync-later')?.click();
    await refresh();
    expect(text(element, 'sync-line')).toBe(
      'Sync: this camera has no check in this session. Sync check',
    );

    // The first camera again: its own check.
    await r.camera.select('fake-webcam');
    await refresh();
    r.starter.last.emitStats(statsOf(5));
    await refresh();
    expect(element.querySelector('[data-testid="sync-check"]')).toBeNull();
    expect(text(element, 'sync-line')).toBe(lag);
  });

  it('counts no turn made in its first second, while it asks to hold still', async () => {
    const r = rig();
    const { element, refresh } = render(r);
    const { fake, capture } = await recording(r);
    await refresh();

    // A turn half a second in: the panel still asks to hold still, and counts nothing.
    await film(r, capture, fake, 600, STILL, [r.s.perf.hostMs + 500]);
    await refresh();
    expect(text(element, 'sync-count')).toBe('Hold still… wait a second before the first turn');
    const count = element.querySelector('[data-testid="sync-count"]');
    expect(count?.getAttribute('data-moves')).toBe('0');
    // The second over, it waits for the first turn, as if none had been made.
    await film(r, capture, fake, 700, STILL);
    await refresh();
    expect(text(element, 'sync-count')).toBe('19 s for the first turn');
    expect(count?.getAttribute('data-moves')).toBe('0');
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

  it("shows a line for each phone, whose Sync check measures the phone's camera: the panel names it, asks for the framing on the phone, and says its lag (T4.3)", async () => {
    const r = rig();
    const { element, refresh } = render(r);
    const fake = await ready(r.s);
    const source = new FakeRemoteSource();
    source.cameras.set([remotePhone(r.s.service.session()?.id ?? '', { framing: null })]);
    TestBed.inject(RemoteCameraRegistry).provide(source);
    await refresh();
    // This device's camera is off: its line is not there; the phone's is.
    expect(text(element, 'sync-line')).toBeUndefined();
    expect(text(element, 'sync-remote-line')).toBe(
      'Sync: phone-rear has no check in this session. Sync check',
    );
    expect(button(element, 'sync-remote-start')?.disabled).toBe(false);

    button(element, 'sync-remote-start')?.click();
    await refresh();
    expect(state(element)).toBe('framing');
    expect(text(element, 'sync-heading')).toBe('Sync check · phone-rear');
    expect(text(element, 'sync-framing')).toBe(
      'Draw the framing rectangle around the cube on the phone first (its Camera page → Camera settings → Edit the framing): the check looks for motion inside it.',
    );
    // The framing is the phone's to edit: no "Edit the framing" here.
    expect(button(element, 'sync-edit-framing')).toBeNull();
    button(element, 'sync-anyway')?.click();
    await refresh();
    expect(state(element)).toBe('running');
    expect(element.textContent).toContain("Hold the cube still inside the phone's rectangle.");

    const lags = [95, 60, 97, 98, 99, 145, 99, 100, 101, 103];
    const { turns, energy } = clapperboard(r.s.perf.hostMs, lags);
    await filmTo(r, source.sink, fake, 2000, energy, turns, true);
    await refresh();
    expect(text(element, 'sync-progress')).toBe('Turn 1 of 10');
    expect(text(element, 'sync-count')).toContain("1 seen by the phone's camera");
    await filmTo(r, source.sink, fake, 12_000, energy, turns, true);
    await refresh();
    expect(state(element)).toBe('passed');
    expect(text(element, 'sync-result')).toBe('phone-rear lags the cube by 99 ms (±8).');

    button(element, 'sync-later')?.click();
    await refresh();
    expect(text(element, 'sync-remote-line')).toBe(
      'Sync: phone-rear lags the cube by 99 ms (±8). Sync check',
    );
    // The phone stops recording: its check cannot start, and the line says why.
    source.change({ recording: false });
    await refresh();
    expect(button(element, 'sync-remote-start')?.disabled).toBe(true);
    expect(text(element, 'sync-remote-why')).toBe('Once the phone records.');
  });
});
