import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FakeCube } from '@cubetrace/gan';

import { CubeService } from '../cube/cube-service';
import { FakeGanConnector, asGanCube, bluetoothNavigator } from '../cube/cube-testing';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { ConnectDialogService } from './connect-dialog-service';
import { CubeStatusPill } from './cube-status-pill';

describe('CubeStatusPill', () => {
  let connector: FakeGanConnector;
  let fixture: ComponentFixture<CubeStatusPill>;
  let cube: CubeService;
  let dialogs: ConnectDialogService;

  function configure(navigator: Partial<Navigator>): void {
    connector = new FakeGanConnector();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: { navigator, localStorage: new FakeLocalStorage() },
        },
        ...connector.providers,
      ],
    });
    cube = TestBed.inject(CubeService);
    dialogs = TestBed.inject(ConnectDialogService);
  }

  async function render(navigator: Partial<Navigator> = bluetoothNavigator(true)): Promise<void> {
    configure(navigator);
    fixture = TestBed.createComponent(CubeStatusPill);
    await fixture.whenStable();
  }

  function pill(): HTMLButtonElement {
    const element = (fixture.nativeElement as HTMLElement).querySelector('button');
    if (element === null) {
      throw new Error('No pill.');
    }
    return element;
  }

  async function click(): Promise<void> {
    pill().click();
    await settle();
    await fixture.whenStable();
  }

  it('"Connect cube" is one click to Chrome\'s picker; no dialog, then the model and the battery', async () => {
    await render();
    expect(pill().textContent.trim()).toBe('Connect cube');
    expect(pill().dataset['status']).toBe('disconnected');
    expect(pill().hasAttribute('aria-haspopup')).toBe(false);

    await click();
    expect(connector.calls).toHaveLength(1);
    expect(pill().textContent.trim()).toBe('Connecting…');
    expect(pill().dataset['status']).toBe('connecting');
    expect(pill().title).toBe('Connecting a cube: click to cancel');
    expect(dialogs.isOpen()).toBe(false);

    connector.last.resolve(asGanCube(new FakeCube()));
    await settle();
    await fixture.whenStable();
    expect(pill().textContent.trim()).toBe('Fake cube · 100%');
    expect(pill().dataset['status']).toBe('connected');
    expect(dialogs.isOpen()).toBe(false);
  });

  it('connected, it opens the dialog with the details', async () => {
    await render();
    const connecting = cube.connect();
    connector.last.resolve(asGanCube(new FakeCube()));
    await connecting;
    await fixture.whenStable();
    expect(pill().getAttribute('aria-haspopup')).toBe('dialog');

    await click();
    expect(dialogs.reason()).toBe('details');
    expect(connector.calls).toHaveLength(1);
  });

  it('says "Reconnect" once a cube has disconnected, with the reason in its title', async () => {
    await render();
    const connecting = cube.connect();
    connector.last.resolve(asGanCube(new FakeCube()));
    await connecting;
    await cube.disconnect();
    await fixture.whenStable();
    expect(pill().textContent.trim()).toBe('Reconnect');
    expect(pill().title).toBe('Disconnected on request.');

    await click();
    expect(connector.calls).toHaveLength(2);
    expect(cube.status()).toBe('connecting');
  });

  it('gives up connecting when clicked while connecting', async () => {
    await render();
    await click();
    await click();

    expect(cube.status()).toBe('disconnected');
    expect(pill().textContent.trim()).toBe('Connect cube');
    expect(pill().title).toBe('Connecting was cancelled.');
    expect(dialogs.isOpen()).toBe(false);
  });

  it('a failure turns the dot red and puts the reason in the title; no dialog opens', async () => {
    await render();
    await click();
    connector.last.reject(
      new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'),
    );
    await settle();
    await fixture.whenStable();

    expect(pill().textContent.trim()).toBe('Connect cube');
    expect(pill().hasAttribute('data-error')).toBe(true);
    expect(pill().title).toBe(
      "No cube was chosen: pick the cube in Chrome's list of devices to connect it.",
    );
    expect(dialogs.isOpen()).toBe(false);

    // The next click tries again, and the dot is no longer red.
    await click();
    expect(connector.calls).toHaveLength(2);
    expect(pill().hasAttribute('data-error')).toBe(false);
  });

  it('without Web Bluetooth, a click opens the dialog, which says so', async () => {
    await render({});
    expect(pill().textContent.trim()).toBe('Connect cube');
    expect(pill().getAttribute('aria-haspopup')).toBe('dialog');

    await click();
    expect(dialogs.reason()).toBe('support');
    expect(connector.calls).toHaveLength(0);
    expect(cube.status()).toBe('disconnected');
  });

  it('acts on a click on its placeholder, made while its code was loading', async () => {
    configure(bluetoothNavigator(true));
    dialogs.requestConnect();
    fixture = TestBed.createComponent(CubeStatusPill);
    await fixture.whenStable();

    expect(connector.calls).toHaveLength(1);
    expect(pill().textContent.trim()).toBe('Connecting…');
    expect(dialogs.takeConnectRequest()).toBe(false);
  });

  it('drops a placeholder click when a cube is already connecting', async () => {
    configure(bluetoothNavigator(true));
    void cube.connect();
    dialogs.requestConnect();
    fixture = TestBed.createComponent(CubeStatusPill);
    await fixture.whenStable();

    expect(connector.calls).toHaveLength(1);
    expect(cube.status()).toBe('connecting');
  });
});
