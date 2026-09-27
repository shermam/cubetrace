import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FakeCube } from '@cubetrace/gan';

import { CubeService, GAN_CONNECTOR } from '../cube/cube-service';
import { FakeGanConnector, asGanCube, bluetoothNavigator } from '../cube/cube-testing';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage } from '../device/fake-browser';
import { ConnectDialogService } from './connect-dialog-service';
import { CubeStatusPill } from './cube-status-pill';

describe('CubeStatusPill', () => {
  let connector: FakeGanConnector;
  let fixture: ComponentFixture<CubeStatusPill>;

  function pill(): HTMLButtonElement {
    const element = (fixture.nativeElement as HTMLElement).querySelector('button');
    if (element === null) {
      throw new Error('No pill.');
    }
    return element;
  }

  beforeEach(async () => {
    connector = new FakeGanConnector();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: { navigator: bluetoothNavigator(true), localStorage: new FakeLocalStorage() },
        },
        { provide: GAN_CONNECTOR, useValue: connector.connect },
      ],
    });
    fixture = TestBed.createComponent(CubeStatusPill);
    await fixture.whenStable();
  });

  it('says "No cube", "Connecting…", then the model and the battery', async () => {
    const cube = TestBed.inject(CubeService);
    expect(pill().textContent.trim()).toBe('No cube');
    expect(pill().dataset['status']).toBe('disconnected');

    const connecting = cube.connect();
    await fixture.whenStable();
    expect(pill().textContent.trim()).toBe('Connecting…');
    expect(pill().dataset['status']).toBe('connecting');

    connector.last.resolve(asGanCube(new FakeCube()));
    await connecting;
    await fixture.whenStable();
    expect(pill().textContent.trim()).toBe('Fake cube · 100%');
    expect(pill().dataset['status']).toBe('connected');

    await cube.disconnect();
    await fixture.whenStable();
    expect(pill().textContent.trim()).toBe('No cube');
    expect(pill().title).toBe('Disconnected on request.');
  });

  it('opens the connect dialog', () => {
    pill().click();

    expect(TestBed.inject(ConnectDialogService).isOpen()).toBe(true);
  });
});
