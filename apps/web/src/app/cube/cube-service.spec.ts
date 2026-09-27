import { TestBed } from '@angular/core/testing';
import { SOLVED, applyMoves, formatMove, parseMove, parseMoves } from '@cubetrace/core';
import { FAKE_CUBE_HARDWARE, FakeCube, type CubeEvent } from '@cubetrace/gan';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeFetch, FakeLocalStorage } from '../device/fake-browser';
import { SettingsService } from '../settings/settings-service';
import { CubeService, GAN_CONNECTOR, MOVE_HISTORY } from './cube-service';
import { DEMO_FILE, FakeGanConnector, asGanCube, bluetoothNavigator } from './cube-testing';
import { DEMO_SOLVES_URL, parseDemoSolves } from './demo';

const TIMEOUT_MESSAGE =
  'The cube did not report its state within 5 s of connecting. If its MAC address was typed, ' +
  'check it: with a wrong address, nothing the cube sends can be decrypted.';
const NO_MAC_MESSAGE = 'Unable to determine cube MAC address, connection is not possible!';

describe('CubeService', () => {
  let connector: FakeGanConnector;
  let fetch: FakeFetch;

  function setup(navigator: Partial<Navigator> = bluetoothNavigator(false)): {
    cube: CubeService;
    settings: SettingsService;
  } {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: { navigator, localStorage: new FakeLocalStorage(), fetch: fetch.fetch },
        },
        { provide: GAN_CONNECTOR, useValue: connector.connect },
      ],
    });
    return { cube: TestBed.inject(CubeService), settings: TestBed.inject(SettingsService) };
  }

  /** Connects `fake`, presented as a GAN cube, through the fake connector. */
  async function connectGan(cube: CubeService, fake: FakeCube): Promise<void> {
    const connecting = cube.connect();
    connector.last.resolve(asGanCube(fake));
    await connecting;
  }

  function movesOf(cube: CubeService): string[] {
    return cube.moves().map((e) => formatMove(e.m));
  }

  beforeEach(() => {
    connector = new FakeGanConnector();
    fetch = new FakeFetch({ [DEMO_SOLVES_URL]: DEMO_FILE });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts disconnected, with nothing known about a cube', () => {
    const { cube } = setup();

    expect(cube.status()).toBe('disconnected');
    expect(cube.kind()).toBeNull();
    expect(cube.hardware()).toBeNull();
    expect(cube.battery()).toBeNull();
    expect(cube.facelets()).toBeNull();
    expect(cube.solved()).toBe(false);
    expect(cube.moves()).toEqual([]);
    expect(cube.lastError()).toBeNull();
    expect(cube.support).toMatchObject({ available: true, canReadMacAutomatically: false });
  });

  it('connects a cube: status, kind, hardware, battery and facelets', async () => {
    const { cube } = setup();
    const start = applyMoves(SOLVED, parseMoves('R U'));

    const connecting = cube.connect();
    expect(cube.status()).toBe('connecting');
    expect(cube.kind()).toBe('gan');
    connector.last.resolve(asGanCube(new FakeCube({ start })));
    await connecting;

    expect(cube.status()).toBe('connected');
    expect(cube.kind()).toBe('gan');
    expect(cube.hardware()).toEqual(FAKE_CUBE_HARDWARE);
    expect(cube.battery()).toBe(100);
    expect(cube.facelets()).toBe(start);
    expect(cube.solved()).toBe(false);
    expect(cube.lastError()).toBeNull();
  });

  it('logs the moves in order, with the state after each one', async () => {
    const { cube } = setup();
    const fake = new FakeCube();
    await connectGan(cube, fake);
    expect(cube.solved()).toBe(true);

    fake.turn(parseMove('R'));
    fake.turn(parseMove("U'"));
    expect(movesOf(cube)).toEqual(['R', "U'"]);
    expect(cube.moveCount()).toBe(2);
    expect(cube.facelets()).toBe(applyMoves(SOLVED, parseMoves("R U'")));
    expect(cube.solved()).toBe(false);

    fake.turn(parseMove('U'));
    fake.turn(parseMove("R'"));
    expect(cube.solved()).toBe(true);
    expect(cube.moves().map((e) => e.serial)).toEqual([1, 2, 3, 4]);
  });

  it(`keeps the last ${String(MOVE_HISTORY)} moves and counts them all`, async () => {
    const { cube } = setup();
    const fake = new FakeCube();
    await connectGan(cube, fake);

    for (let i = 0; i < 250; i++) {
      fake.turn(parseMove(i % 2 === 0 ? 'R' : 'U'));
    }
    expect(cube.moves()).toHaveLength(MOVE_HISTORY);
    expect(cube.moveCount()).toBe(250);
    expect(cube.moves()[0].serial).toBe(51);
  });

  it('adopts the facelets the cube reports', async () => {
    const { cube } = setup();
    const fake = new FakeCube();
    await connectGan(cube, fake);
    fake.turn(parseMove('F'));

    await fake.requestFacelets();
    expect(cube.facelets()).toBe(applyMoves(SOLVED, parseMoves('F')));
  });

  it('goes back to disconnected with the reason when the cube goes away', async () => {
    const { cube } = setup();
    const fake = new FakeCube();
    await connectGan(cube, fake);
    fake.turn(parseMove('R'));

    await fake.disconnect('The Bluetooth connection was closed.');
    expect(cube.status()).toBe('disconnected');
    expect(cube.disconnectReason()).toBe('The Bluetooth connection was closed.');
    expect(cube.kind()).toBeNull();
    expect(cube.hardware()).toBeNull();
    expect(cube.battery()).toBeNull();
    // The last state and moves stay on screen; "Reconnect" is offered.
    expect(cube.facelets()).toBe(applyMoves(SOLVED, parseMoves('R')));
    expect(movesOf(cube)).toEqual(['R']);
    expect(cube.canReconnect()).toBe(true);
  });

  it('disconnect() closes the connection, on request', async () => {
    const { cube } = setup();
    const fake = new FakeCube();
    await connectGan(cube, fake);

    await cube.disconnect();
    expect(cube.status()).toBe('disconnected');
    expect(cube.disconnectReason()).toBe('Disconnected on request.');
    expect(() => {
      fake.turn(parseMove('R'));
    }).toThrow('disconnected');
  });

  it('closes a cube that connects after disconnect() gave up on it', async () => {
    const { cube } = setup();
    const connecting = cube.connect();
    await cube.disconnect();
    expect(cube.status()).toBe('disconnected');
    expect(cube.disconnectReason()).toBe('Connecting was cancelled.');

    const late = new FakeCube();
    connector.last.resolve(asGanCube(late));
    await connecting;
    expect(cube.status()).toBe('disconnected');
    await expect(late.play([])).rejects.toThrow('disconnected');
  });

  it('events$ follows the connection, from one cube to the next', async () => {
    const { cube } = setup();
    const events: CubeEvent[] = [];
    cube.events$.subscribe((e) => events.push(e));

    const first = new FakeCube();
    await connectGan(cube, first);
    first.turn(parseMove('R'));
    const second = new FakeCube();
    await connectGan(cube, second);
    second.turn(parseMove('U'));

    expect(events.map((e) => (e.type === 'move' ? formatMove(e.m) : e.type))).toEqual([
      'hardware',
      'battery',
      'R',
      'disconnected',
      'hardware',
      'battery',
      'U',
    ]);
    expect(cube.moveCount()).toBe(1);
  });

  it('reports a failed connection in plain words', async () => {
    const { cube } = setup();

    const connecting = cube.connect();
    connector.last.reject(new Error(TIMEOUT_MESSAGE));
    await connecting;

    expect(cube.status()).toBe('disconnected');
    expect(cube.kind()).toBeNull();
    expect(cube.lastError()).toBe('The cube did not send its state: is it on and nearby?');
  });

  it('does not try without Web Bluetooth, and says why', async () => {
    const { cube } = setup({});

    await cube.connect();
    expect(connector.calls).toHaveLength(0);
    expect(cube.lastError()).toContain('This browser cannot connect to a Bluetooth cube.');
  });

  describe('the MAC provider', () => {
    const device = { name: 'GAN12ui_AB12', id: 'device-1' };

    it('answers with the stored address first, and names it if the cube stays silent', async () => {
      const { cube, settings } = setup();
      settings.saveCubeMac('GAN12ui_AB12', 'ab12cd34ef56');

      const connecting = cube.connect();
      expect(await connector.last.macProvider(device, false)).toBe('AB:12:CD:34:EF:56');
      expect(cube.macPrompt()).toBeNull();
      connector.last.reject(new Error(TIMEOUT_MESSAGE));
      await connecting;

      expect(cube.lastError()).toContain(
        "check its MAC address: AB:12:CD:34:EF:56 may not be this cube's",
      );
    });

    it('lets the driver read the address when none is stored, then asks the user', async () => {
      const { cube, settings } = setup();

      const connecting = cube.connect();
      const provider = connector.last.macProvider;
      expect(await provider(device, false)).toBeNull();
      const answer = provider(device, true);
      expect(cube.macPrompt()).toEqual({ deviceName: 'GAN12ui_AB12' });

      expect(cube.answerMac('AB:12:CD', true)).toContain('"AB:12:CD" is not a MAC address');
      expect(cube.macPrompt()).not.toBeNull();
      expect(cube.answerMac(' ab-12-cd-34-ef-56 ', true)).toBeNull();
      expect(await answer).toBe('AB:12:CD:34:EF:56');
      expect(cube.macPrompt()).toBeNull();

      // Remembered once the cube has connected, not before (a typo would be stored otherwise).
      expect(settings.macFor('GAN12ui_AB12')).toBeNull();
      connector.last.resolve(asGanCube(new FakeCube()));
      await connecting;
      expect(settings.macFor('GAN12ui_AB12')).toBe('AB:12:CD:34:EF:56');
    });

    it('does not remember an address when asked not to', async () => {
      const { cube, settings } = setup();

      const connecting = cube.connect();
      const answer = connector.last.macProvider(device, true);
      cube.answerMac('AB:12:CD:34:EF:56', false);
      await answer;
      connector.last.resolve(asGanCube(new FakeCube()));
      await connecting;

      expect(settings.cubeMacs()).toEqual([]);
    });

    it('fails the connection when the prompt is cancelled', async () => {
      const { cube } = setup();

      const connecting = cube.connect();
      const answer = connector.last.macProvider(device, true);
      cube.cancelMacPrompt();
      expect(await answer).toBeNull();
      expect(cube.macPrompt()).toBeNull();
      connector.last.reject(new Error(NO_MAC_MESSAGE));
      await connecting;

      expect(cube.lastError()).toBe(
        "Not connected: the cube's MAC address is needed to talk to it, and none was given.",
      );
    });

    it('answers nothing to a connection given up meanwhile', async () => {
      const { cube } = setup();

      void cube.connect();
      const provider = connector.last.macProvider;
      const answer = provider(device, true);
      await cube.disconnect();

      expect(await answer).toBeNull();
      expect(await provider(device, true)).toBeNull();
      expect(cube.macPrompt()).toBeNull();
      expect(cube.answerMac('AB:12:CD:34:EF:56', true)).toBe(
        'No cube is waiting for a MAC address.',
      );
    });
  });

  describe('demo mode', () => {
    it('replays the scramble 100 ms apart, then the solution, and ends solved', async () => {
      vi.useFakeTimers();
      const { cube } = setup();
      const [, solve] = parseDemoSolves(DEMO_FILE);
      const states: string[] = [];
      cube.events$.subscribe((e) => {
        if (e.type === 'move') {
          states.push(cube.facelets() ?? '');
        }
      });

      cube.connectDemo(solve, 10);
      expect(cube.status()).toBe('connected');
      expect(cube.kind()).toBe('fake');
      expect(cube.demo()).toBe(solve);
      expect(cube.demoSpeed()).toBe(10);
      expect(cube.hardware()?.model).toBe('Fake cube');
      expect(cube.battery()).toBe(100);
      await vi.runAllTimersAsync();

      expect(movesOf(cube)).toEqual(['F2', "D'", 'D', 'F', 'F']);
      expect(states[1]).toBe(solve.scrambledFacelets);
      expect(cube.solved()).toBe(true);
      const cubeMs = cube.moves().map((e) => e.cubeMs);
      // The scramble 100 ms apart, then the solution's own gaps (90 and 5 ms) on the cube clock.
      expect(cubeMs[1] - cubeMs[0]).toBe(100);
      expect(cubeMs.slice(2).map((ms) => ms - cubeMs[2])).toEqual([0, 90, 95]);
    });

    it('downloads the demo solves and plays the one the address asks for', async () => {
      const { cube } = setup();

      const starting = cube.startDemo({ demo: '2', speed: '20' });
      expect(cube.status()).toBe('connecting');
      expect(cube.kind()).toBe('fake');
      await starting;

      expect(cube.status()).toBe('connected');
      expect(cube.demo()?.index).toBe(2);
      expect(cube.demo()?.scramble).toBe('L');
      expect(cube.demoSpeed()).toBe(20);
      expect(fetch.requests).toEqual([DEMO_SOLVES_URL]);
    });

    it('falls back to a random solve and the speed from Settings', async () => {
      const { cube, settings } = setup();
      settings.setDemoSpeed(4);

      await cube.startDemo({ demo: 'seven', speed: '0' });
      expect(cube.demo()?.index).toBeGreaterThanOrEqual(0);
      expect(cube.demo()?.index).toBeLessThan(3);
      expect(cube.demoSpeed()).toBe(4);
    });

    it('reports demo solves that cannot be downloaded', async () => {
      const { cube } = setup();
      fetch.failWith = new TypeError('Failed to fetch');

      await cube.startDemo();
      expect(cube.status()).toBe('disconnected');
      expect(cube.lastError()).toBe('The demo solves could not be loaded: Failed to fetch');
    });

    it('starts the demo of the address only when no cube is connected', async () => {
      const { cube } = setup();
      await connectGan(cube, new FakeCube());

      cube.autoStartDemo({ demo: '0', speed: '20' });
      expect(cube.kind()).toBe('gan');
      expect(fetch.requests).toEqual([]);
    });

    it('replaces a connected cube, and reconnect() replays the same solve', async () => {
      vi.useFakeTimers();
      const { cube } = setup();
      const real = new FakeCube();
      await connectGan(cube, real);
      const [solve] = parseDemoSolves(DEMO_FILE);

      cube.connectDemo(solve, 5);
      await expect(real.play([])).rejects.toThrow('disconnected');
      await cube.disconnect();
      expect(cube.demo()).toBeNull();
      expect(cube.canReconnect()).toBe(false);

      await cube.reconnect();
      expect(cube.demo()).toBe(solve);
      expect(cube.demoSpeed()).toBe(5);
      await vi.runAllTimersAsync();
      expect(cube.solved()).toBe(true);
    });
  });
});
