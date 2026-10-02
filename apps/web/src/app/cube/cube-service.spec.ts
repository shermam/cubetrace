import { TestBed } from '@angular/core/testing';
import { SOLVED, applyMoves, formatMove, parseMove, parseMoves } from '@cubetrace/core';
import { FAKE_CUBE_HARDWARE, FakeCube, type CubeEvent } from '@cubetrace/gan';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FakeDocument,
  FakeFetch,
  FakeLocalStorage,
  FakePerformance,
  FakeTimers,
} from '../device/fake-browser';
import { SettingsService } from '../settings/settings-service';
import { CubeService, GAN_DRIVER_LOADER, MOVE_HISTORY, type GanDriverLoader } from './cube-service';
import {
  DEMO_FILE,
  FakeGanConnector,
  asGanCube,
  bluetoothNavigator,
  demoSolve,
} from './cube-testing';
import { DEMO_MISSCRAMBLE_PAUSE_MS, DEMO_SOLVES_URL, parseDemoSolves } from './demo';

const TIMEOUT_MESSAGE =
  'The cube did not report its state within 5 s of connecting. If its MAC address was typed, ' +
  'check it: with a wrong address, nothing the cube sends can be decrypted.';
const NO_MAC_MESSAGE = 'Unable to determine cube MAC address, connection is not possible!';

const IDLE_REASON = "Disconnected after 5 minutes without a turn, to save the cube's battery.";

describe('CubeService', () => {
  let connector: FakeGanConnector;
  let fetch: FakeFetch;
  /** The host clock, the tab's visibility and the timers on that clock. */
  let perf: FakePerformance;
  let page: FakeDocument;
  let timers: FakeTimers;

  /** The service in Chrome (Web Bluetooth, without the flag unless `navigator` says otherwise). */
  function setup(
    navigator: Partial<Navigator> = bluetoothNavigator(false),
    loadDriver?: GanDriverLoader,
  ): {
    cube: CubeService;
    settings: SettingsService;
  } {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator,
            localStorage: new FakeLocalStorage(),
            fetch: fetch.fetch,
            performance: perf,
            document: page,
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
          },
        },
        ...connector.providers,
        ...(loadDriver === undefined ? [] : [{ provide: GAN_DRIVER_LOADER, useValue: loadDriver }]),
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
    perf = new FakePerformance();
    page = new FakeDocument();
    timers = new FakeTimers(perf);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { cube } = setup();
    const fake = new FakeCube();
    await connectGan(cube, fake);
    fake.turn(parseMove('R'));

    await fake.disconnect('The Bluetooth connection was closed.');
    expect(cube.status()).toBe('disconnected');
    // The cube's own reason first, then what the app knows (see "disconnect diagnostics").
    expect(cube.disconnectReason()).toBe(
      'The Bluetooth connection was closed. It happened after less than 1 s without a turn.',
    );
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

      // F2 as a real cube sends it: two quarter turns.
      expect(movesOf(cube)).toEqual(['F', 'F', "D'", 'D', 'F', 'F']);
      expect(states[2]).toBe(solve.scrambledFacelets);
      expect(cube.solved()).toBe(true);
      const cubeMs = cube.moves().map((e) => e.cubeMs);
      // The scramble 100 ms apart (F2's second quarter turn 60 ms after its first), then the
      // solution's own gaps (90 and 5 ms) on the cube clock.
      expect(cubeMs.slice(0, 3).map((ms) => ms - cubeMs[0])).toEqual([0, 60, 100]);
      expect(cubeMs.slice(3).map((ms) => ms - cubeMs[3])).toEqual([0, 90, 95]);
    });

    it('gives the demo cube a gyroscope when asked (?gyro=1, T3.7), and not otherwise', async () => {
      vi.useFakeTimers();
      const { cube } = setup();
      const [, solve] = parseDemoSolves(DEMO_FILE);
      const gyros: number[] = [];
      cube.events$.subscribe((e) => {
        if (e.type === 'gyro') {
          gyros.push(e.hostMs);
        }
      });
      cube.connectDemo(solve, 10);
      expect(cube.hardware()?.gyro).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(gyros).toEqual([]);

      cube.connectDemo(solve, 10, null, true);
      expect(cube.hardware()?.gyro).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(gyros.length).toBeGreaterThanOrEqual(20);
      // Reconnect keeps it; the demo's address turns it on.
      const before = gyros.length;
      await cube.disconnect();
      await vi.advanceTimersByTimeAsync(100);
      expect(gyros.length).toBe(before);
      await cube.reconnect();
      expect(cube.hardware()?.gyro).toBe(true);
      await cube.disconnect();
      await cube.startDemo({ demo: '2', speed: '20', gyro: '1' });
      expect(cube.hardware()?.gyro).toBe(true);
      await cube.disconnect();
      await cube.startDemo({ demo: '2', speed: '20', gyro: '0' });
      expect(cube.hardware()?.gyro).toBe(false);
      await cube.disconnect();
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

    it("starts the solution after the page has rendered the scramble's end", async () => {
      // Real timers: fake ones give a zero-delay timer set during a timer's callback 1 ms more than
      // one set right after it, which is not the order a browser keeps.
      const { cube } = setup();
      const [solve] = parseDemoSolves(DEMO_FILE);
      const order: string[] = [];
      let moves = 0;
      const replayed = new Promise<void>((resolve) => {
        cube.events$.subscribe((event) => {
          if (event.type !== 'move') {
            return;
          }
          moves++;
          const move = formatMove(event.m);
          order.push(move);
          // As Angular does when a move changes a signal: a render on a zero-delay timer, and work
          // that the render schedules in turn (a frame).
          setTimeout(() => {
            order.push(`render ${move}`);
            setTimeout(() => order.push(`frame ${move}`), 0);
          }, 0);
          if (moves === 4) {
            resolve();
          }
        });
      });

      cube.connectDemo(solve, 20);
      await replayed;
      // Demo solve 0 is R U, then U' R': the scramble's last move, its render and the frame that
      // follows, and only then the solution's first move.
      const at = ['U', 'render U', 'frame U', "U'"].map((entry) => order.indexOf(entry));
      expect(
        at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1])),
        order.join(' '),
      ).toBe(true);
    });

    it('a mis-scramble: a wrong turn after scramble move k, undone after a pause', async () => {
      vi.useFakeTimers();
      const { cube } = setup();
      const [solve] = parseDemoSolves({
        solves: [
          demoSolve("R U F D'", [
            ['D', 0],
            ["F'", 120],
            ["U'", 300],
            ["R'", 450],
          ]),
        ],
      });

      cube.connectDemo(solve, 10, 2);
      // At speed 10 the scramble moves are 10 ms apart; after move 2 (U) comes the wrong turn, R.
      await vi.advanceTimersByTimeAsync(20);
      expect(movesOf(cube)).toEqual(['R', 'U', 'R']);
      // It stays for the pause, divided by the speed, before the cube undoes it (the fake clock
      // runs the inverse's zero-delay timer, set by the pause's timer, 1 ms later).
      await vi.advanceTimersByTimeAsync(DEMO_MISSCRAMBLE_PAUSE_MS / 10 - 1);
      expect(movesOf(cube)).toEqual(['R', 'U', 'R']);
      await vi.advanceTimersByTimeAsync(2);
      expect(movesOf(cube)).toEqual(['R', 'U', 'R', "R'"]);

      await vi.runAllTimersAsync();
      expect(movesOf(cube)).toEqual(['R', 'U', 'R', "R'", 'F', "D'", 'D', "F'", "U'", "R'"]);
      expect(cube.solved()).toBe(true);
      expect(cube.lastError()).toBeNull();
    });

    it("passes the address's ?misscramble on, unless the scramble has no move after it", async () => {
      vi.useFakeTimers();
      const { cube } = setup();

      await cube.startDemo({ demo: '0', speed: '20', misscramble: '1' });
      await vi.runAllTimersAsync();
      // Demo solve 0 is R U, solved by U' R'; after R and before U, the wrong turn is F.
      expect(movesOf(cube)).toEqual(['R', 'F', "F'", 'U', "U'", "R'"]);
      expect(cube.solved()).toBe(true);

      // Demo solve 2's scramble has a single move: nothing after it, so no wrong turn.
      await cube.startDemo({ demo: '2', speed: '20', misscramble: '1' });
      await vi.runAllTimersAsync();
      expect(movesOf(cube)).toEqual(['L', "L'"]);
    });

    it('reconnect() replays the mis-scramble; a disconnection stops it in its pause', async () => {
      vi.useFakeTimers();
      const { cube } = setup();
      const [solve] = parseDemoSolves(DEMO_FILE);

      cube.connectDemo(solve, 20, 1);
      await vi.advanceTimersByTimeAsync(5);
      expect(movesOf(cube)).toEqual(['R', 'F']);
      await cube.disconnect();
      await vi.runAllTimersAsync();
      expect(movesOf(cube)).toEqual(['R', 'F']);
      expect(cube.lastError()).toBeNull();

      await cube.reconnect();
      await vi.runAllTimersAsync();
      expect(movesOf(cube)).toEqual(['R', 'F', "F'", 'U', "U'", "R'"]);
      expect(cube.solved()).toBe(true);
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

  describe('Mark as solved', () => {
    it("sets the cube's state to solved for every listener, with the reset flag", async () => {
      const { cube } = setup();
      const fake = new FakeCube({ start: applyMoves(SOLVED, parseMoves('R U')) });
      await connectGan(cube, fake);
      const events: CubeEvent[] = [];
      cube.events$.subscribe((e) => events.push(e));
      expect(cube.solved()).toBe(false);

      await cube.resetToSolved();
      expect(fake.facelets).toBe(SOLVED);
      expect(cube.facelets()).toBe(SOLVED);
      expect(cube.solved()).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'facelets', facelets: SOLVED, reset: true });

      // The moves after it start from the solved state.
      fake.turn(parseMove('F'));
      expect(cube.facelets()).toBe(applyMoves(SOLVED, parseMoves('F')));
    });

    it('does nothing while no cube is connected', async () => {
      const { cube } = setup();
      await cube.resetToSolved();
      const fake = new FakeCube({ start: applyMoves(SOLVED, parseMoves('R')) });
      const reset = vi.spyOn(fake, 'resetToSolved');
      await connectGan(cube, fake);
      await cube.disconnect();

      await cube.resetToSolved();
      expect(reset).not.toHaveBeenCalled();
      expect(cube.solved()).toBe(false);
    });

    it("stops the demo cube's replay there: the demo cube stays connected and solved", async () => {
      vi.useFakeTimers();
      const { cube } = setup();
      const [solve] = parseDemoSolves(DEMO_FILE); // R U, then U' R'.
      cube.connectDemo(solve, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(movesOf(cube)).toEqual(['R']);

      await cube.resetToSolved();
      await vi.runAllTimersAsync();
      expect(movesOf(cube)).toEqual(['R']);
      expect(cube.status()).toBe('connected');
      expect(cube.solved()).toBe(true);
      expect(cube.lastError()).toBeNull();
    });
  });

  describe('the idle disconnection', () => {
    it('disconnects a real cube after 5 minutes without a turn, and says why', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const { cube } = setup();
      await connectGan(cube, new FakeCube());

      timers.advance(5 * 60_000 - 1);
      expect(cube.status()).toBe('connected');
      timers.advance(1);
      expect(cube.status()).toBe('disconnected');
      expect(cube.disconnectReason()).toBe(IDLE_REASON);
      expect(cube.canReconnect()).toBe(true);
      expect(timers.pending).toBe(0);
      // The app's own reason: nothing to diagnose.
      expect(info).not.toHaveBeenCalled();
    });

    it('starts over with every turn, and with Mark as solved', async () => {
      const { cube } = setup();
      const fake = new FakeCube();
      await connectGan(cube, fake);

      timers.advance(4 * 60_000);
      fake.turn(parseMove('R'));
      timers.advance(4 * 60_000);
      await cube.resetToSolved();
      timers.advance(4 * 60_000);
      fake.turn(parseMove('U'));
      timers.advance(5 * 60_000 - 1);
      expect(cube.status()).toBe('connected');
      timers.advance(1);
      expect(cube.disconnectReason()).toBe(IDLE_REASON);
    });

    it('follows the setting: 1 minute, never with 0, and a change while connected counts from then', async () => {
      const { cube, settings } = setup();
      settings.setIdleDisconnectMinutes(1);
      TestBed.tick();
      await connectGan(cube, new FakeCube());
      timers.advance(60_000);
      expect(cube.disconnectReason()).toBe(
        "Disconnected after 1 minute without a turn, to save the cube's battery.",
      );

      settings.setIdleDisconnectMinutes(0);
      TestBed.tick();
      await connectGan(cube, new FakeCube());
      expect(timers.pending).toBe(0);
      timers.advance(24 * 60 * 60_000);
      expect(cube.status()).toBe('connected');

      settings.setIdleDisconnectMinutes(2);
      TestBed.tick();
      timers.advance(2 * 60_000 - 1);
      expect(cube.status()).toBe('connected');
      timers.advance(1);
      expect(cube.disconnectReason()).toBe(
        "Disconnected after 2 minutes without a turn, to save the cube's battery.",
      );
    });

    it('leaves the demo cube alone (it has no battery), and stops once the cube is gone', async () => {
      const { cube } = setup();
      await cube.startDemo({ demo: '0', speed: '20' });
      expect(cube.kind()).toBe('fake');
      expect(timers.pending).toBe(0);
      await cube.disconnect();

      await connectGan(cube, new FakeCube());
      expect(timers.pending).toBe(1);
      await cube.disconnect();
      expect(timers.pending).toBe(0);
      expect(cube.disconnectReason()).toBe('Disconnected on request.');
    });
  });

  describe('disconnect diagnostics', () => {
    it('adds how long the cube went without a turn and that the tab was hidden, and logs the facts', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const { cube, settings } = setup();
      settings.setIdleDisconnectMinutes(0);
      const fake = new FakeCube();
      await connectGan(cube, fake);
      perf.advance(30_000);
      fake.turn(parseMove('R'));
      perf.advance(60_000);
      page.setVisibility('hidden');
      perf.advance(5 * 60_000 + 12_000);

      await fake.disconnect('The Bluetooth connection was closed.');
      expect(cube.disconnectReason()).toBe(
        'The Bluetooth connection was closed. It happened after 6 min 12 s without a turn, while ' +
          'this tab was in the background. GAN cubes go to sleep after a few minutes without turns.',
      );
      expect(info).toHaveBeenCalledExactlyOnceWith(
        'cubetrace: the cube disconnected {"reason":"The Bluetooth connection was closed.",' +
          '"idleMs":372000,"visibilityState":"hidden","hiddenMs":312000,"connectedMs":402000,' +
          '"battery":100,"model":"Fake cube"}',
      );
    });

    it('in view and after a short while: the time only, counted from the connection without a turn', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const { cube } = setup();
      const fake = new FakeCube();
      await connectGan(cube, fake);
      perf.advance(42_500);

      await fake.disconnect('The cube driver failed: decryption failed');
      expect(cube.disconnectReason()).toBe(
        'The cube driver failed: decryption failed. It happened after 42 s without a turn.',
      );
      expect(info.mock.calls[0]?.[0]).toContain('"idleMs":42500,"visibilityState":"visible"');
      expect(info.mock.calls[0]?.[0]).toContain('"hiddenMs":null,"connectedMs":42500');
    });

    it('keeps the reason of a disconnection on request as it is, and logs nothing', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const { cube } = setup();
      await connectGan(cube, new FakeCube());
      perf.advance(10 * 60_000);

      await cube.disconnect();
      expect(cube.disconnectReason()).toBe('Disconnected on request.');
      expect(info).not.toHaveBeenCalled();
    });
  });

  describe('the tab', () => {
    it('back in view, asks a connected cube once for its state, and adopts it', async () => {
      const { cube } = setup();
      const fake = new FakeCube();
      await connectGan(cube, fake);
      const request = vi.spyOn(fake, 'requestFacelets');

      page.setVisibility('hidden');
      expect(request).not.toHaveBeenCalled();
      page.setVisibility('visible');
      expect(request).toHaveBeenCalledOnce();
    });

    it('does not connect by itself: a cube that went away while the tab was hidden waits for Reconnect', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const { cube } = setup();
      const fake = new FakeCube();
      await connectGan(cube, fake);
      page.setVisibility('hidden');
      await fake.disconnect('The Bluetooth connection was closed.');

      page.setVisibility('visible');
      expect(connector.calls).toHaveLength(1);
      expect(cube.status()).toBe('disconnected');
      expect(cube.canReconnect()).toBe(true);
      expect(cube.disconnectReason()).toContain('while this tab was in the background');
    });
  });

  describe('the GAN driver', () => {
    it('starts loading when the service is created; a click then goes straight to the picker', () => {
      const { cube } = setup();
      expect(connector.driverLoads).toBe(1);

      // Nothing is awaited before connectGanCube (Chrome's picker), which awaits the same load.
      void cube.connect();
      expect(connector.calls).toHaveLength(1);
      expect(connector.driverLoads).toBe(1);
    });

    it('is not loaded in a browser without Web Bluetooth', () => {
      setup({});
      expect(connector.driverLoads).toBe(0);
    });

    it('a failed preload shows nothing: connecting goes on as usual', async () => {
      const load = vi.fn(() =>
        Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
      );
      const { cube } = setup(bluetoothNavigator(false), load);
      expect(load).toHaveBeenCalledOnce();

      await connectGan(cube, new FakeCube());
      expect(cube.lastError()).toBeNull();
      expect(cube.status()).toBe('connected');
    });
  });
});
