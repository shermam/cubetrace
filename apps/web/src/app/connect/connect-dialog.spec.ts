import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SOLVED, applyMoves, parseMoves } from '@cubetrace/core';
import { FakeCube, MAC_FLAG_URL } from '@cubetrace/gan';

import { CubeService, MARK_AS_SOLVED_HINT } from '../cube/cube-service';
import { DEMO_FILE, FakeGanConnector, asGanCube, bluetoothNavigator } from '../cube/cube-testing';
import { DEMO_SOLVES_URL } from '../cube/demo';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FakeClipboard,
  FakeFetch,
  FakeLocalStorage,
  polyfillDialog,
  settle,
} from '../device/fake-browser';
import { SettingsService } from '../settings/settings-service';
import { ConnectDialog } from './connect-dialog';
import { type ConnectDialogReason, ConnectDialogService } from './connect-dialog-service';

describe('ConnectDialog', () => {
  let connector: FakeGanConnector;
  let clipboard: FakeClipboard;
  let fixture: ComponentFixture<ConnectDialog>;
  let cube: CubeService;
  let dialogs: ConnectDialogService;

  /** The dialog, opened for `reason` unless it is null. */
  async function render(
    navigator: Partial<Navigator>,
    reason: ConnectDialogReason | null,
  ): Promise<void> {
    connector = new FakeGanConnector();
    const fetch = new FakeFetch({ [DEMO_SOLVES_URL]: DEMO_FILE });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: { ...navigator, clipboard },
            localStorage: new FakeLocalStorage(),
            fetch: fetch.fetch,
          },
        },
        ...connector.providers,
      ],
    });
    fixture = TestBed.createComponent(ConnectDialog);
    cube = TestBed.inject(CubeService);
    dialogs = TestBed.inject(ConnectDialogService);
    if (reason !== null) {
      dialogs.open(reason);
    }
    await stable();
  }

  async function stable(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  /** A connection that fails as a cancelled device picker does; `lastError` then says so. */
  async function failToConnect(): Promise<void> {
    const connecting = cube.connect();
    connector.last.reject(
      new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'),
    );
    await connecting;
  }

  function dialog(): HTMLDialogElement {
    const element = (fixture.nativeElement as HTMLElement).querySelector('dialog');
    if (element === null) {
      throw new Error('No <dialog>.');
    }
    return element;
  }

  function byTestId(testId: string): HTMLElement | null {
    return dialog().querySelector(`[data-testid="${testId}"]`);
  }

  function text(testId: string): string | undefined {
    return byTestId(testId)?.textContent.replace(/\s+/g, ' ').trim();
  }

  function button(name: string): HTMLButtonElement {
    const found = Array.from(dialog().querySelectorAll('button')).find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === name,
    );
    if (found === undefined) {
      throw new Error(`No button "${name}".`);
    }
    return found;
  }

  function type(testId: string, value: string): void {
    const input = byTestId(testId);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`No input ${testId}.`);
    }
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  beforeAll(() => {
    polyfillDialog();
  });

  beforeEach(() => {
    clipboard = new FakeClipboard();
  });

  it('opens and closes with the service, and Esc (the native close) tells the service', async () => {
    await render({}, 'support');
    expect(dialog().open).toBe(true);
    expect(dialog().dataset['reason']).toBe('support');

    dialogs.close();
    await stable();
    expect(dialog().open).toBe(false);

    dialogs.open('details');
    await stable();
    expect(dialog().open).toBe(true);
    dialog().close(); // What Esc does to a modal dialog.
    await stable();
    expect(dialogs.isOpen()).toBe(false);
    expect(dialogs.reason()).toBeNull();
  });

  it('without Web Bluetooth: the hint, Connect cube disabled, Demo cube enabled', async () => {
    await render({}, 'support');

    expect(text('bluetooth-hint')).toContain('This browser cannot connect to a Bluetooth cube.');
    expect(byTestId('flag-steps')).toBeNull();
    expect(button('Connect cube').disabled).toBe(true);
    expect(button('Demo cube').disabled).toBe(false);
  });

  it("an error's details, with Bluetooth but not the flag: the error, the flag, a copy button and the three steps", async () => {
    await render(bluetoothNavigator(false), null);
    await failToConnect();
    dialogs.open('error');
    await stable();

    expect(text('connect-error')).toBe(
      "No cube was chosen: pick the cube in Chrome's list of devices to connect it.",
    );
    expect(text('bluetooth-hint')).toContain('cannot read the cube');
    expect(button('Connect cube').disabled).toBe(false);
    expect(button('Demo cube').disabled).toBe(false);
    expect(text('flag-url')).toBe(MAC_FLAG_URL);
    const steps = Array.from(dialog().querySelectorAll('ol li'), (li) => li.textContent.trim());
    expect(steps).toEqual([
      'Paste it in Chrome’s address bar and press Enter.',
      'Set the highlighted flag, enable-web-bluetooth-new-permissions-backend, to Enabled.',
      'Relaunch Chrome.',
    ]);

    button('Copy the flag address').click();
    await stable();
    expect(clipboard.texts).toEqual([MAC_FLAG_URL]);
    expect(text('copy-notice')).toBe('Copied. Paste it in the address bar.');

    clipboard.refuseWith = new DOMException('Write permission denied.', 'NotAllowedError');
    button('Copy the flag address').click();
    await stable();
    expect(text('copy-notice')).toBe(
      'Copying failed (Write permission denied.): select the address and copy it.',
    );
  });

  it('with the flag on: no steps, since Chrome reads the address', async () => {
    await render(bluetoothNavigator(true), null);
    await failToConnect();
    dialogs.open('error');
    await stable();

    expect(text('bluetooth-hint')).toContain('read automatically');
    expect(byTestId('flag-steps')).toBeNull();
  });

  it('connecting from the dialog shows a spinner; a dialog opened for an error closes once connected', async () => {
    await render(bluetoothNavigator(true), null);
    await failToConnect();
    dialogs.open('error');
    await stable();

    button('Connect cube').click();
    await stable();
    expect(connector.calls).toHaveLength(2);
    expect(text('connect-state')).toBe('Connecting…');
    expect(dialog().querySelector('.spinner')).not.toBeNull();

    connector.last.resolve(asGanCube(new FakeCube()));
    await stable();
    expect(cube.status()).toBe('connected');
    expect(dialogs.isOpen()).toBe(false);
    expect(dialog().open).toBe(false);
  });

  it('opened for the details, it stays when a cube connects: the cube, then Disconnect', async () => {
    await render(bluetoothNavigator(true), 'details');

    button('Connect cube').click();
    await stable();
    connector.last.resolve(asGanCube(new FakeCube()));
    await stable();
    expect(dialog().open).toBe(true);
    expect(text('connect-state')).toBe('Connected.');
    const details = Array.from(dialog().querySelectorAll('dd'), (dd) => dd.textContent.trim());
    expect(details).toEqual(['Fake cube', 'simulated', 'simulated', '100%', 'No']);

    button('Disconnect').click();
    await stable();
    expect(cube.status()).toBe('disconnected');
    expect(text('connect-state')).toBe('Last connection: Disconnected on request.');
    expect(button('Reconnect').disabled).toBe(false);
    expect(dialog().open).toBe(true);
  });

  it("the cube's details offer Mark as solved, which sets its state to solved", async () => {
    await render(bluetoothNavigator(true), 'details');
    button('Connect cube').click();
    await stable();
    const fake = new FakeCube({ start: applyMoves(SOLVED, parseMoves('D2 B')) });
    connector.last.resolve(asGanCube(fake));
    await stable();
    expect(cube.solved()).toBe(false);
    const reset = button('Mark as solved');
    expect(reset.dataset['testid']).toBe('reset-state');
    const hint = reset.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hint)?.textContent.trim()).toBe(MARK_AS_SOLVED_HINT);

    reset.click();
    await stable();
    expect(cube.solved()).toBe(true);
    expect(fake.facelets).toBe(SOLVED);
    expect(dialog().open).toBe(true);
    expect(text('connect-state')).toBe('Connected.');
  });

  it('gives up connecting on Cancel, and closes a cube that connects later', async () => {
    await render(bluetoothNavigator(true), 'details');
    button('Connect cube').click();
    await stable();

    button('Cancel').click();
    await stable();
    expect(cube.status()).toBe('disconnected');
    expect(text('connect-state')).toBe('Last connection: Connecting was cancelled.');

    const late = new FakeCube();
    connector.last.resolve(asGanCube(late));
    await stable();
    expect(cube.status()).toBe('disconnected');
    await expect(late.play([])).rejects.toThrow('disconnected');
  });

  it('the MAC prompt opens the dialog, with the flag steps folded under it; answering closes it, and the address is remembered', async () => {
    await render(bluetoothNavigator(false), null);
    const connecting = cube.connect();
    await stable();
    expect(dialog().open).toBe(false);

    // The driver's fallback call opens the dialog, on the prompt.
    const answer = connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
    await stable();
    expect(dialog().open).toBe(true);
    expect(dialogs.reason()).toBe('prompt');
    expect(text('mac-device')).toBe('GAN12ui_AB12');
    expect(document.activeElement).toBe(byTestId('mac-input'));
    const folded = byTestId('flag-details');
    expect(folded).toBeInstanceOf(HTMLDetailsElement);
    expect((folded as HTMLDetailsElement).open).toBe(false);
    expect(folded?.querySelector('summary')?.textContent.trim()).toBe(
      'Let Chrome read the address by itself',
    );
    expect(folded?.querySelector('[data-testid="flag-url"]')?.textContent).toBe(MAC_FLAG_URL);
    expect(folded?.querySelectorAll('ol li')).toHaveLength(3);

    type('mac-input', 'AB:12:CD');
    button('Connect').click();
    await stable();
    expect(text('mac-error')).toContain('"AB:12:CD" is not a MAC address');
    expect(dialog().open).toBe(true);

    type('mac-input', 'ab12cd34ef56');
    await stable();
    expect(byTestId('mac-error')).toBeNull();
    expect(dialog().textContent).toContain('Connects with AB:12:CD:34:EF:56.');
    button('Connect').click();
    expect(await answer).toBe('AB:12:CD:34:EF:56');
    await stable();
    expect(dialog().open).toBe(false);

    connector.last.resolve(asGanCube(new FakeCube()));
    await connecting;
    await stable();
    expect(cube.status()).toBe('connected');
    expect(dialog().open).toBe(false);
    expect(TestBed.inject(SettingsService).macFor('GAN12ui_AB12')).toBe('AB:12:CD:34:EF:56');
  });

  it('Cancel on the prompt, or Esc, closes the dialog and fails the connection in plain words', async () => {
    await render(bluetoothNavigator(false), null);
    void cube.connect();
    const answer = connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
    await stable();

    button('Cancel').click();
    expect(await answer).toBeNull();
    await stable();
    expect(dialog().open).toBe(false);
    connector.last.reject(
      new Error('Unable to determine cube MAC address, connection is not possible!'),
    );
    await stable();
    expect(cube.lastError()).toBe(
      "Not connected: the cube's MAC address is needed to talk to it, and none was given.",
    );
    expect(dialog().open).toBe(false);

    void cube.connect();
    const second = connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
    await stable();
    expect(dialog().open).toBe(true);
    dialog().close();
    expect(await second).toBeNull();
  });

  it('a prompt that comes while the dialog shows the details keeps it open once connected', async () => {
    await render(bluetoothNavigator(false), 'details');
    button('Connect cube').click();
    const answer = connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
    await stable();
    expect(dialogs.reason()).toBe('details');
    type('mac-input', 'AB:12:CD:34:EF:56');
    button('Connect').click();
    expect(await answer).toBe('AB:12:CD:34:EF:56');
    await stable();
    expect(text('connect-state')).toBe('Connecting…');

    connector.last.resolve(asGanCube(new FakeCube()));
    await stable();
    expect(dialog().open).toBe(true);
    expect(text('connect-state')).toBe('Connected.');
  });

  it("Demo cube plays the address's ?demo at its ?speed", async () => {
    await render({}, 'details');
    await TestBed.inject(Router).navigateByUrl('/?demo=1&speed=20');

    button('Demo cube').click();
    await stable();
    await stable();

    expect(cube.demo()?.index).toBe(1);
    expect(cube.demoSpeed()).toBe(20);
    expect(text('connect-state')).toBe('Connected to the demo cube.');
    expect(dialog().textContent).toContain('It replays demo solve 1 at 20× speed');
    await cube.disconnect();
  });

  it('opened because this browser cannot connect, it closes once the demo cube is connected', async () => {
    await render({}, 'support');

    button('Demo cube').click();
    await stable();
    await stable();

    expect(cube.status()).toBe('connected');
    expect(cube.kind()).toBe('fake');
    expect(dialog().open).toBe(false);
    await cube.disconnect();
  });

  it("Demo cube passes the address's ?misscramble on", async () => {
    await render({}, 'support');
    await TestBed.inject(Router).navigateByUrl('/?demo=0&speed=20&misscramble=1');
    const startDemo = vi.spyOn(cube, 'startDemo');

    button('Demo cube').click();
    await stable();

    expect(startDemo).toHaveBeenCalledWith({
      demo: '0',
      speed: '20',
      misscramble: '1',
      gyro: null,
    });
    await cube.disconnect();
  });
});
