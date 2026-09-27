import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { FakeCube, MAC_FLAG_URL } from '@cubetrace/gan';

import { CubeService, GAN_CONNECTOR } from '../cube/cube-service';
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
import { ConnectDialogService } from './connect-dialog-service';

describe('ConnectDialog', () => {
  let connector: FakeGanConnector;
  let clipboard: FakeClipboard;
  let fixture: ComponentFixture<ConnectDialog>;
  let cube: CubeService;
  let dialogs: ConnectDialogService;

  async function render(navigator: Partial<Navigator>): Promise<void> {
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
        { provide: GAN_CONNECTOR, useValue: connector.connect },
      ],
    });
    fixture = TestBed.createComponent(ConnectDialog);
    cube = TestBed.inject(CubeService);
    dialogs = TestBed.inject(ConnectDialogService);
    dialogs.open();
    await stable();
  }

  async function stable(): Promise<void> {
    await settle();
    await fixture.whenStable();
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
    await render({});
    expect(dialog().open).toBe(true);

    dialogs.close();
    await stable();
    expect(dialog().open).toBe(false);

    dialogs.open();
    await stable();
    expect(dialog().open).toBe(true);
    dialog().close(); // What Esc does to a modal dialog.
    await stable();
    expect(dialogs.isOpen()).toBe(false);
  });

  it('without Web Bluetooth: the hint, Connect cube disabled, Demo cube enabled', async () => {
    await render({});

    expect(text('bluetooth-hint')).toContain('This browser cannot connect to a Bluetooth cube.');
    expect(byTestId('flag-steps')).toBeNull();
    expect(button('Connect cube').disabled).toBe(true);
    expect(button('Demo cube').disabled).toBe(false);
  });

  it('with Bluetooth but not the flag: the flag, a copy button and the three steps', async () => {
    await render(bluetoothNavigator(false));

    expect(button('Connect cube').disabled).toBe(false);
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
    await render(bluetoothNavigator(true));

    expect(text('bluetooth-hint')).toContain('read automatically');
    expect(byTestId('flag-steps')).toBeNull();
  });

  it('connecting shows a spinner, then the connected cube and Disconnect', async () => {
    await render(bluetoothNavigator(true));

    button('Connect cube').click();
    await stable();
    expect(text('connect-state')).toBe('Connecting…');
    expect(dialog().querySelector('.spinner')).not.toBeNull();

    connector.last.resolve(asGanCube(new FakeCube()));
    await stable();
    expect(text('connect-state')).toBe('Connected.');
    const details = Array.from(dialog().querySelectorAll('dd'), (dd) => dd.textContent.trim());
    expect(details).toEqual(['Fake cube', 'simulated', 'simulated', '100%', 'No']);

    button('Disconnect').click();
    await stable();
    expect(cube.status()).toBe('disconnected');
    expect(text('connect-state')).toBe('Last connection: Disconnected on request.');
    expect(button('Reconnect').disabled).toBe(false);
  });

  it('gives up connecting on Cancel, and closes a cube that connects later', async () => {
    await render(bluetoothNavigator(true));
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

  it('asks for the MAC address when the driver needs it, validated, and remembers it', async () => {
    await render(bluetoothNavigator(false));
    button('Connect cube').click();
    await stable();
    dialogs.close();
    await stable();

    // The driver's fallback call opens the dialog again, on the prompt.
    const answer = connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
    await stable();
    expect(dialog().open).toBe(true);
    expect(text('mac-device')).toBe('GAN12ui_AB12');
    expect(document.activeElement).toBe(byTestId('mac-input'));

    type('mac-input', 'AB:12:CD');
    button('Connect').click();
    await stable();
    expect(text('mac-error')).toContain('"AB:12:CD" is not a MAC address');

    type('mac-input', 'ab12cd34ef56');
    await stable();
    expect(byTestId('mac-error')).toBeNull();
    expect(dialog().textContent).toContain('Connects with AB:12:CD:34:EF:56.');
    button('Connect').click();
    expect(await answer).toBe('AB:12:CD:34:EF:56');

    connector.last.resolve(asGanCube(new FakeCube()));
    await stable();
    expect(TestBed.inject(SettingsService).macFor('GAN12ui_AB12')).toBe('AB:12:CD:34:EF:56');
  });

  it('cancelling the prompt, or closing the dialog, fails the connection in plain words', async () => {
    await render(bluetoothNavigator(false));
    button('Connect cube').click();
    await stable();
    const answer = connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
    await stable();

    button('Cancel').click();
    expect(await answer).toBeNull();
    connector.last.reject(
      new Error('Unable to determine cube MAC address, connection is not possible!'),
    );
    await stable();
    expect(text('connect-error')).toBe(
      "Not connected: the cube's MAC address is needed to talk to it, and none was given.",
    );

    button('Connect cube').click();
    await stable();
    const second = connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
    await stable();
    dialog().close();
    expect(await second).toBeNull();
  });

  it("Demo cube plays the address's ?demo at its ?speed", async () => {
    await render({});
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
});
