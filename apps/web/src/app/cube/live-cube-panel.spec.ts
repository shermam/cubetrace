import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { SOLVED, applyMoves, parseMove, parseMoves } from '@cubetrace/core';
import { FakeCube } from '@cubetrace/gan';

import { ConnectDialogService } from '../connect/connect-dialog-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { CubeService, MARK_AS_SOLVED_HINT } from './cube-service';
import { FakeGanConnector, asGanCube, bluetoothNavigator } from './cube-testing';
import { LiveCubePanel } from './live-cube-panel';

describe('LiveCubePanel', () => {
  let connector: FakeGanConnector;
  let fixture: ComponentFixture<LiveCubePanel>;

  async function render(): Promise<void> {
    connector = new FakeGanConnector();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: { navigator: bluetoothNavigator(true), localStorage: new FakeLocalStorage() },
        },
        ...connector.providers,
      ],
    });
    fixture = TestBed.createComponent(LiveCubePanel);
    await fixture.whenStable();
  }

  async function connect(fake: FakeCube): Promise<void> {
    const connecting = TestBed.inject(CubeService).connect();
    connector.last.resolve(asGanCube(fake));
    await connecting;
    await fixture.whenStable();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function element(testId: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`);
  }

  function logRows(): string[][] {
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr');
    return Array.from(rows, (row) =>
      Array.from(row.querySelectorAll('td'), (cell) => cell.textContent.trim()),
    );
  }

  it('offers to connect a cube while none is connected: one click connects, without a dialog', async () => {
    await render();

    expect(element('live-cube-status')?.textContent).toContain('No cube connected.');
    expect(element('cube-net')).toBeNull();
    expect(element('cube-solved')).toBeNull();
    expect(logRows()).toEqual([['No moves yet.']]);
    expect(element('open-connect')?.textContent.trim()).toBe('Connect a cube');
    expect(element('try-demo')).not.toBeNull();

    element('open-connect')?.click();
    await fixture.whenStable();
    expect(connector.calls).toHaveLength(1);
    expect(element('live-cube-status')?.textContent.trim()).toBe('Connecting…');
    expect(element('open-connect')?.textContent.trim()).toBe('Connecting…');
    expect(TestBed.inject(ConnectDialogService).isOpen()).toBe(false);

    connector.last.resolve(asGanCube(new FakeCube()));
    await settle();
    await fixture.whenStable();
    expect(element('cube-solved')?.textContent.trim()).toBe('Solved');
    expect(element('open-connect')).toBeNull();
    expect(TestBed.inject(ConnectDialogService).isOpen()).toBe(false);
  });

  it("shows the cube's state, whether it is solved, and its moves newest first", async () => {
    await render();
    const fake = new FakeCube();
    await connect(fake);
    expect(element('cube-solved')?.textContent.trim()).toBe('Solved');
    expect(element('open-connect')).toBeNull();

    fake.turn(parseMove('R'));
    fake.turn(parseMove('U2'));
    await fixture.whenStable();

    expect(element('cube-solved')?.textContent.trim()).toBe('Not solved');
    expect(element('cube-net')?.getAttribute('data-facelets')).toBe(fake.facelets);
    const rows = logRows();
    expect(rows.map((cells) => cells.slice(0, 2))).toEqual([
      ['2', 'U2'],
      ['1', 'R'],
    ]);
    // Gap and host gap are unknown for the first move; each move of the fake cube ends a packet.
    expect(rows[1].slice(3)).toEqual(['–', '–', '■']);
    expect(rows[0][5]).toBe('■');
    expect(element('move-log')?.getAttribute('data-move-count')).toBe('2');
  });

  it('keeps the last state on screen after the cube disconnects', async () => {
    await render();
    const fake = new FakeCube();
    await connect(fake);
    fake.turn(parseMove('F'));
    await fake.disconnect('The Bluetooth connection was closed.');
    await fixture.whenStable();

    expect(element('live-cube-status')?.textContent).toContain('Disconnected');
    expect(element('cube-net')?.getAttribute('data-facelets')).toBe(fake.facelets);
    expect(logRows()).toHaveLength(1);
    expect(element('open-connect')?.textContent.trim()).toBe('Reconnect');
  });

  it('"Mark as solved": enabled while a cube is connected; it sets the state to solved', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await render();
    const reset = (): HTMLButtonElement | null =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '[data-testid="reset-state"]',
      );
    expect(reset()?.disabled).toBe(true);
    expect(reset()?.textContent.trim()).toBe('Mark as solved');
    const hint = reset()?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hint)?.textContent.trim()).toBe(MARK_AS_SOLVED_HINT);

    const fake = new FakeCube({ start: applyMoves(SOLVED, parseMoves("R U'")) });
    await connect(fake);
    expect(element('cube-solved')?.textContent.trim()).toBe('Not solved');
    expect(reset()?.disabled).toBe(false);

    reset()?.click();
    await settle();
    await fixture.whenStable();
    expect(element('cube-solved')?.textContent.trim()).toBe('Solved');
    expect(element('cube-net')?.getAttribute('data-facelets')).toBe(SOLVED);
    expect(fake.facelets).toBe(SOLVED);

    await fake.disconnect('The Bluetooth connection was closed.');
    await fixture.whenStable();
    expect(reset()?.disabled).toBe(true);
  });
});
