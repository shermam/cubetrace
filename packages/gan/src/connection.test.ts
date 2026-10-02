// The GAN connection against a hand-built driver (driver.ts types): no Web Bluetooth anywhere.
import { Subject, type Subscription } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOLVED, applyMove, applyMoves, parseMoves, type Facelets } from '@cubetrace/core';

import {
  GanEventMapper,
  driverTimeToHost,
  normalizeMac,
  openGanConnection,
  type GanConnectionDeps,
} from './connection';
import {
  loadGanDriver,
  type ConnectGanDriver,
  type GanDriverCommand,
  type GanDriverConnection,
  type GanDriverEvent,
  type GanDriverObserver,
  type GanDriverSubscribable,
} from './driver';
import type { CubeConnection, CubeEvent, MacProvider } from './types';

// ---- A hand-built driver ----

const ORIGIN = 1_700_000_000_000;
const toHostMs = (driverMs: number): number => ORIGIN + driverMs;
const SCRAMBLED: Facelets = applyMoves(SOLVED, parseMoves("R U2 F' L D2 B"));

type DriverMove = Extract<GanDriverEvent, { type: 'MOVE' }>;

/** A driver MOVE event, the newest of its message unless `localTimestamp` says otherwise. */
function move(token: string, fields: Partial<DriverMove> = {}): DriverMove {
  const timestamp = fields.timestamp ?? 1000;
  return {
    type: 'MOVE',
    timestamp,
    serial: 1,
    face: 'URFDLB'.indexOf(token.charAt(0)),
    direction: token.endsWith("'") ? 1 : 0,
    move: token,
    localTimestamp: timestamp,
    cubeTimestamp: 5000,
    ...fields,
  };
}

function facelets(f: string, timestamp = 900): GanDriverEvent {
  return { type: 'FACELETS', timestamp, serial: 0, facelets: f };
}

/**
 * The fork's events$: a native Observable, cold, subscribed with `{ signal }`, returning nothing.
 * Counts its subscriptions (the wrapper must subscribe exactly once).
 */
function nativeObservable(
  subject: Subject<GanDriverEvent>,
): GanDriverSubscribable<GanDriverEvent> & {
  subscriptions: number;
} {
  const observable = {
    subscriptions: 0,
    subscribe(
      observer: GanDriverObserver<GanDriverEvent>,
      options?: { signal?: AbortSignal },
    ): undefined {
      observable.subscriptions += 1;
      const subscription = subject.subscribe(observer);
      options?.signal?.addEventListener('abort', () => {
        subscription.unsubscribe();
      });
      return undefined;
    },
  };
  return observable;
}

interface FakeDriverOptions {
  /** What the cube answers to REQUEST_FACELETS, in turn; nothing once the list is used up. */
  answers?: string[];
  /** The MAC that the driver reads from the advertisements (null: the browser cannot). */
  autoMac?: string | null;
  /** Upstream's driver: events$ is an RxJS Subject and the connection has disconnect(). */
  upstream?: boolean;
  /** The device's Bluetooth name; `null` when it has none. */
  name?: string | null;
}

function fakeDriver(opts: FakeDriverOptions = {}) {
  const subject = new Subject<GanDriverEvent>();
  const answers = [...(opts.answers ?? [SCRAMBLED])];
  const commands: GanDriverCommand['type'][] = [];
  const macs: string[] = [];
  const gatt = { connected: true, disconnect: vi.fn() };
  const device = {
    id: 'device-1',
    name: opts.name === undefined ? 'GAN12ui_1a2b' : opts.name,
    gatt,
  };
  const native = nativeObservable(subject);
  const upstreamDisconnect = vi.fn(() => Promise.resolve());
  let upstreamSubscription: Subscription | undefined;
  const upstreamEvents: GanDriverSubscribable<GanDriverEvent> = {
    subscribe(observer) {
      upstreamSubscription = subject.subscribe(observer);
      return upstreamSubscription;
    },
  };
  const send = vi.fn((command: GanDriverCommand) => {
    commands.push(command.type);
    if (command.type === 'REQUEST_FACELETS') {
      const answer = answers.shift();
      if (answer !== undefined) {
        queueMicrotask(() => {
          subject.next(facelets(answer));
        });
      }
    }
    return Promise.resolve();
  });
  const connection: GanDriverConnection = {
    deviceName: device.name ?? 'GAN-XXXX',
    deviceMAC: '',
    events$: opts.upstream === true ? upstreamEvents : native,
    sendCubeCommand: send,
    ...(opts.upstream === true ? { disconnect: upstreamDisconnect } : {}),
  };
  // Like the fork's connectGanCube: provider(device, false) || advertisements || provider(device, true).
  const connect: ConnectGanDriver = async (provider) => {
    const mac =
      (provider && (await provider(device, false))) ||
      opts.autoMac ||
      (provider && (await provider(device, true)));
    if (!mac) {
      throw new Error('Unable to determine cube MAC address, connection is not possible!');
    }
    macs.push(mac);
    return connection;
  };
  return {
    subject,
    commands,
    macs,
    gatt,
    native,
    send,
    connect,
    upstreamDisconnect,
    upstreamSubscription: () => upstreamSubscription,
  };
}

const MAC = 'AB:12:CD:34:EF:56';
const typedMac: MacProvider = () => Promise.resolve(MAC);

function open(
  driver: ReturnType<typeof fakeDriver>,
  macProvider: MacProvider = typedMac,
  deps: Partial<GanConnectionDeps> = {},
): Promise<CubeConnection> {
  return openGanConnection({ macProvider }, { connect: driver.connect, toHostMs, ...deps });
}

function record(conn: CubeConnection): { events: CubeEvent[]; completed: () => boolean } {
  const events: CubeEvent[] = [];
  let completed = false;
  conn.events$.subscribe({
    next: (e) => events.push(e),
    complete: () => {
      completed = true;
    },
  });
  return { events, completed: () => completed };
}

/** Lets queued promise callbacks run (the requests that follow the first facelets report). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- Tests ----

describe('GanEventMapper', () => {
  it('maps the newest move of a message: host time from localTimestamp, packetLast', () => {
    const mapper = new GanEventMapper(toHostMs);
    expect(
      mapper.map(
        move("R'", { serial: 7, localTimestamp: 500, timestamp: 500, cubeTimestamp: 12345 }),
      ),
    ).toEqual({
      type: 'move',
      m: { face: 'R', turns: 3 },
      cubeMs: 12345,
      hostMs: ORIGIN + 500,
      serial: 7,
      packetLast: true,
    });
  });

  it('maps a message of three moves (Gen2): one host time, only the newest is packetLast', () => {
    const mapper = new GanEventMapper(toHostMs);
    const message = [
      move('U', { serial: 5, localTimestamp: null, cubeTimestamp: 7000 }),
      move("D'", { serial: 6, localTimestamp: null, cubeTimestamp: 7040 }),
      move('F', { serial: 7, localTimestamp: 1000, cubeTimestamp: 7120 }),
    ];
    const events = message.map((e) => mapper.map(e));
    expect(events).toEqual([
      {
        type: 'move',
        m: { face: 'U', turns: 1 },
        cubeMs: 7000,
        hostMs: ORIGIN + 1000,
        serial: 5,
        packetLast: false,
      },
      {
        type: 'move',
        m: { face: 'D', turns: 3 },
        cubeMs: 7040,
        hostMs: ORIGIN + 1000,
        serial: 6,
        packetLast: false,
      },
      {
        type: 'move',
        m: { face: 'F', turns: 1 },
        cubeMs: 7120,
        hostMs: ORIGIN + 1000,
        serial: 7,
        packetLast: true,
      },
    ]);
  });

  it('keeps the cube clock where it was for a recovered move without a cube timestamp', () => {
    const mapper = new GanEventMapper(toHostMs);
    expect(mapper.map(move('U', { cubeTimestamp: null, localTimestamp: null }))).toMatchObject({
      cubeMs: 0,
      packetLast: false,
    });
    expect(mapper.map(move('U', { cubeTimestamp: 900 }))).toMatchObject({ cubeMs: 900 });
    expect(mapper.map(move('U', { cubeTimestamp: null, localTimestamp: null }))).toMatchObject({
      cubeMs: 900,
    });
  });

  it('drops a move that is not a face turn, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mapper = new GanEventMapper(toHostMs);
    expect(mapper.map(move("'", { face: 9 }))).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('maps facelets, validated; drops an invalid report with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mapper = new GanEventMapper(toHostMs);
    expect(mapper.map(facelets(SCRAMBLED, 1234))).toEqual({
      type: 'facelets',
      facelets: SCRAMBLED,
      hostMs: ORIGIN + 1234,
    });
    for (const bad of ['', SOLVED.slice(1), 'R' + SOLVED.slice(1), SOLVED.toLowerCase()]) {
      expect(mapper.map(facelets(bad))).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('maps gyro, battery, hardware and disconnect, with everything the driver decodes (T3.7)', () => {
    const mapper = new GanEventMapper(toHostMs, 'GAN12ui_1a2b');
    // A Gen2 cube's gyro packet carries its angular velocity, 4-bit signed integers per axis.
    expect(
      mapper.map({
        type: 'GYRO',
        timestamp: 10,
        quaternion: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
        velocity: { x: 0, y: -7, z: 1 },
      }),
    ).toEqual({ type: 'gyro', q: [0.1, 0.2, 0.3, 0.9], v: [0, -7, 1], hostMs: ORIGIN + 10 });
    // A cube that gives none: no velocity field.
    expect(
      mapper.map({ type: 'GYRO', timestamp: 11, quaternion: { x: 0, y: 0, z: 0, w: 1 } }),
    ).toEqual({ type: 'gyro', q: [0, 0, 0, 1], hostMs: ORIGIN + 11 });
    expect(mapper.map({ type: 'BATTERY', timestamp: 10, batteryLevel: 87 })).toEqual({
      type: 'battery',
      level: 87,
      hostMs: ORIGIN + 10,
    });
    expect(
      mapper.map({
        type: 'HARDWARE',
        timestamp: 10,
        hardwareName: 'GAN12ui\u0000',
        hardwareVersion: '1.2',
        softwareVersion: '2.4',
        gyroSupported: false,
      }),
    ).toEqual({
      type: 'hardware',
      model: 'GAN12ui',
      hardware: '1.2',
      firmware: '2.4',
      gyro: false,
    });
    expect(mapper.map({ type: 'HARDWARE', timestamp: 10, gyroSupported: true })).toEqual({
      type: 'hardware',
      model: 'GAN12ui_1a2b',
      hardware: '',
      firmware: '',
      gyro: true,
    });
    // A Gen4 cube's hardware message says its production date; blank, it is as if unsaid.
    const dated = mapper.map({ type: 'HARDWARE', timestamp: 10, productDate: '2025-03-14' });
    expect(dated).toMatchObject({ type: 'hardware', productDate: '2025-03-14' });
    const blank = mapper.map({ type: 'HARDWARE', timestamp: 10, productDate: ' \u0000' });
    expect(blank !== null && 'productDate' in blank).toBe(false);
    expect(mapper.map({ type: 'DISCONNECT', timestamp: 10 })).toEqual({
      type: 'disconnected',
      reason: 'The cube closed the connection.',
    });
    expect(
      mapper.map({ type: 'SOMETHING_NEW', timestamp: 10 } as unknown as GanDriverEvent),
    ).toBeNull();
  });
});

describe('openGanConnection', () => {
  it('asks for the facelets, then hardware and battery, and resolves with the first facelets', async () => {
    const driver = fakeDriver();
    const conn = await open(driver);
    expect(conn.kind).toBe('gan');
    expect(conn.facelets).toBe(SCRAMBLED);
    await settle();
    expect(driver.commands).toEqual(['REQUEST_FACELETS', 'REQUEST_HARDWARE', 'REQUEST_BATTERY']);
    expect(driver.native.subscriptions).toBe(1);
  });

  it('gives the MAC provider the device, and the driver the MAC normalized', async () => {
    const driver = fakeDriver();
    const provider = vi.fn<MacProvider>(() => Promise.resolve(' ab-12-cd-34-ef-56 '));
    await open(driver, provider);
    expect(provider).toHaveBeenCalledExactlyOnceWith(
      { name: 'GAN12ui_1a2b', id: 'device-1' },
      false,
    );
    expect(driver.macs).toEqual([MAC]);
  });

  it('gives the MAC provider no name when the device has none', async () => {
    const driver = fakeDriver({ name: null });
    const provider = vi.fn<MacProvider>(() => Promise.resolve(MAC));
    await open(driver, provider);
    expect(provider).toHaveBeenCalledExactlyOnceWith({ name: undefined, id: 'device-1' }, false);
  });

  it('lets the driver read the MAC when the provider returns null, and asks again as a fallback', async () => {
    const automatic = fakeDriver({ autoMac: '11:22:33:44:55:66' });
    const provider = vi.fn<MacProvider>(() => Promise.resolve(null));
    await open(automatic, provider);
    expect(provider).toHaveBeenCalledOnce();
    expect(automatic.macs).toEqual(['11:22:33:44:55:66']);

    const manual = fakeDriver({ autoMac: null });
    const typed = vi.fn<MacProvider>((_, isFallback) =>
      Promise.resolve(isFallback ? 'AB12CD34EF56' : ''),
    );
    await open(manual, typed);
    expect(typed.mock.calls.map(([, isFallback]) => isFallback)).toEqual([false, true]);
    expect(manual.macs).toEqual([MAC]);
  });

  it('rejects an answer of the MAC provider that is not a MAC address', async () => {
    const driver = fakeDriver();
    await expect(open(driver, () => Promise.resolve('AB:12:CD'))).rejects.toThrow(
      /"AB:12:CD" is not a MAC address/,
    );
  });

  it('drops an invalid facelets report and resolves with the next valid one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const driver = fakeDriver({ answers: ['garbage', SCRAMBLED] });
    const opening = open(driver);
    await vi.advanceTimersByTimeAsync(1500); // the request is repeated
    const conn = await opening;
    expect(conn.facelets).toBe(SCRAMBLED);
    expect(warn).toHaveBeenCalledOnce();
    expect(driver.commands.filter((c) => c === 'REQUEST_FACELETS')).toHaveLength(2);
  });

  it('forwards live events in order and tracks the state with moves and facelets reports', async () => {
    const driver = fakeDriver();
    const conn = await open(driver);
    const { events } = record(conn);
    driver.subject.next(
      move('R', { serial: 1, timestamp: 2000, localTimestamp: null, cubeTimestamp: 8000 }),
    );
    driver.subject.next(
      move("U'", { serial: 2, timestamp: 2000, localTimestamp: 2000, cubeTimestamp: 8100 }),
    );
    driver.subject.next({ type: 'GYRO', timestamp: 2001, quaternion: { x: 0, y: 0, z: 0, w: 1 } });
    expect(conn.facelets).toBe(applyMoves(SCRAMBLED, parseMoves("R U'")));
    driver.subject.next(facelets(SOLVED, 2100));
    expect(conn.facelets).toBe(SOLVED);
    driver.subject.next(move('F', { serial: 3, timestamp: 2200, cubeTimestamp: 8300 }));
    expect(conn.facelets).toBe(applyMove(SOLVED, { face: 'F', turns: 1 }));
    expect(events).toEqual([
      {
        type: 'move',
        m: { face: 'R', turns: 1 },
        cubeMs: 8000,
        hostMs: ORIGIN + 2000,
        serial: 1,
        packetLast: false,
      },
      {
        type: 'move',
        m: { face: 'U', turns: 3 },
        cubeMs: 8100,
        hostMs: ORIGIN + 2000,
        serial: 2,
        packetLast: true,
      },
      { type: 'gyro', q: [0, 0, 0, 1], hostMs: ORIGIN + 2001 },
      { type: 'facelets', facelets: SOLVED, hostMs: ORIGIN + 2100 },
      {
        type: 'move',
        m: { face: 'F', turns: 1 },
        cubeMs: 8300,
        hostMs: ORIGIN + 2200,
        serial: 3,
        packetLast: true,
      },
    ]);
  });

  it('ignores moves before the first facelets report (so does the driver)', async () => {
    const driver = fakeDriver({ answers: [] });
    vi.useFakeTimers();
    const opening = open(driver);
    await vi.advanceTimersByTimeAsync(0);
    driver.subject.next(move('R'));
    driver.subject.next(facelets(SCRAMBLED));
    const conn = await opening;
    expect(conn.facelets).toBe(SCRAMBLED);
  });

  it('replays hardware and battery to subscribers that come later', async () => {
    const driver = fakeDriver();
    const conn = await open(driver);
    driver.subject.next({
      type: 'HARDWARE',
      timestamp: 1,
      hardwareName: 'GAN12uiF',
      hardwareVersion: '1.0',
      softwareVersion: '2.1',
      gyroSupported: false,
    });
    driver.subject.next({ type: 'BATTERY', timestamp: 2, batteryLevel: 64 });
    driver.subject.next(move('R'));
    const { events } = record(conn);
    expect(events).toEqual([
      { type: 'hardware', model: 'GAN12uiF', hardware: '1.0', firmware: '2.1', gyro: false },
      { type: 'battery', level: 64, hostMs: ORIGIN + 2 },
    ]);
  });

  it('times out when the cube never reports its state, after asking twice, and closes the link', async () => {
    vi.useFakeTimers();
    const driver = fakeDriver({ answers: [] });
    const opening = open(driver);
    const failed = expect(opening).rejects.toThrow(
      /did not report its state within 5 s.*MAC address/,
    );
    await vi.advanceTimersByTimeAsync(1499);
    expect(driver.commands.filter((c) => c === 'REQUEST_FACELETS')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(driver.commands.filter((c) => c === 'REQUEST_FACELETS')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3500);
    await failed;
    expect(driver.gatt.disconnect).toHaveBeenCalledOnce();
    expect(driver.subject.observed).toBe(false);
  });

  it('fails when the driver stream ends before the first facelets report', async () => {
    const driver = fakeDriver({ answers: [] });
    const opening = open(driver);
    await vi.waitFor(() => {
      expect(driver.subject.observed).toBe(true);
    });
    driver.subject.complete();
    await expect(opening).rejects.toThrow(/disconnected before reporting its state/);
  });

  it('fails when a request cannot be written', async () => {
    const driver = fakeDriver();
    driver.send.mockRejectedValueOnce(new Error('GATT Server is disconnected.'));
    await expect(open(driver)).rejects.toThrow(/Could not ask the cube for its state: GATT Server/);
  });

  it('sends one command at a time', async () => {
    const driver = fakeDriver();
    const conn = await open(driver);
    await settle();
    const pending: (() => void)[] = [];
    driver.send.mockImplementation((command) => {
      driver.commands.push(command.type);
      return new Promise<void>((resolve) => pending.push(resolve));
    });
    driver.commands.length = 0;
    const first = conn.requestFacelets();
    const second = conn.requestBattery();
    await Promise.resolve();
    await Promise.resolve();
    expect(driver.commands).toEqual(['REQUEST_FACELETS']);
    pending[0]();
    await first;
    await Promise.resolve();
    expect(driver.commands).toEqual(['REQUEST_FACELETS', 'REQUEST_BATTERY']);
    pending[1]();
    await second;
  });
});

describe('resetToSolved', () => {
  const NOW = ORIGIN + 5000;
  const OTHER: Facelets = applyMoves(SOLVED, parseMoves('F2 D'));

  /** A connection whose cube answered SCRAMBLED on connecting and answers `then` afterwards. */
  async function connected(...then: string[]) {
    const driver = fakeDriver({ answers: [SCRAMBLED, ...then] });
    const conn = await open(driver, typedMac, { now: () => NOW });
    await settle(); // The hardware and battery requests.
    driver.commands.length = 0;
    return { driver, conn, ...record(conn) };
  }

  /** Writes wait until the test lets them finish, in order. */
  function holdWrites(driver: ReturnType<typeof fakeDriver>): (() => void)[] {
    const pending: (() => void)[] = [];
    driver.send.mockImplementation((command) => {
      driver.commands.push(command.type);
      return new Promise<void>((resolve) => pending.push(resolve));
    });
    return pending;
  }

  it("writes REQUEST_RESET, then emits the solved state (reset), then asks for the cube's, whose answer follows", async () => {
    const { driver, conn, events } = await connected(SOLVED);

    await conn.resetToSolved();
    await settle(); // The cube's answer.
    expect(driver.commands).toEqual(['REQUEST_RESET', 'REQUEST_FACELETS']);
    expect(conn.facelets).toBe(SOLVED);
    expect(events).toEqual([
      { type: 'facelets', facelets: SOLVED, hostMs: NOW, reset: true },
      { type: 'facelets', facelets: SOLVED, hostMs: ORIGIN + 900 },
    ]);

    // Moves go on from the solved state.
    driver.subject.next(move('R', { serial: 9, timestamp: 6000, cubeTimestamp: 9000 }));
    expect(conn.facelets).toBe(applyMove(SOLVED, { face: 'R', turns: 1 }));
  });

  it('emits the solved state only once REQUEST_RESET is written, and asks for the state after it', async () => {
    const { driver, conn, events } = await connected(SOLVED);
    const pending = holdWrites(driver);

    const resetting = conn.resetToSolved();
    await settle();
    expect(driver.commands).toEqual(['REQUEST_RESET']);
    expect(events).toEqual([]);
    expect(conn.facelets).toBe(SCRAMBLED);

    pending[0]();
    await settle();
    expect(events).toEqual([{ type: 'facelets', facelets: SOLVED, hostMs: NOW, reset: true }]);
    expect(conn.facelets).toBe(SOLVED);
    expect(driver.commands).toEqual(['REQUEST_RESET', 'REQUEST_FACELETS']);

    pending[1]();
    await resetting;
  });

  it("adopts the cube's own state when its answer disagrees", async () => {
    const { conn, events } = await connected(OTHER);

    await conn.resetToSolved();
    await settle();
    expect(events.map((e) => (e.type === 'facelets' ? [e.facelets, e.reset] : e.type))).toEqual([
      [SOLVED, true],
      [OTHER, undefined],
    ]);
    expect(conn.facelets).toBe(OTHER);
  });

  it('rejects once disconnected, and emits nothing', async () => {
    const { driver, conn, events } = await connected();
    await conn.disconnect();

    await expect(conn.resetToSolved()).rejects.toThrow('The cube is disconnected.');
    expect(driver.commands).toEqual([]);
    expect(events).toEqual([{ type: 'disconnected', reason: 'Disconnected on request.' }]);
  });

  it('rejects when the link closes while the reset is written, and emits no solved state', async () => {
    const { driver, conn, events } = await connected();
    const pending = holdWrites(driver);

    const resetting = conn.resetToSolved();
    await settle();
    driver.subject.complete(); // The GATT server disconnected.
    pending[0]();

    await expect(resetting).rejects.toThrow('The cube is disconnected.');
    expect(events).toEqual([
      { type: 'disconnected', reason: 'The Bluetooth connection was closed.' },
    ]);
    expect(conn.facelets).toBe(SCRAMBLED);
  });
});

describe('the end of a GAN connection', () => {
  it('emits disconnected and completes when the driver stream completes (the fork, on GATT disconnection)', async () => {
    const driver = fakeDriver();
    const conn = await open(driver);
    const { events, completed } = record(conn);
    driver.subject.complete();
    expect(events).toEqual([
      { type: 'disconnected', reason: 'The Bluetooth connection was closed.' },
    ]);
    expect(completed()).toBe(true);
    await expect(conn.requestBattery()).rejects.toThrow(/disconnected/);
  });

  it('emits disconnected with the reason when the driver stream fails', async () => {
    const driver = fakeDriver();
    const conn = await open(driver);
    const { events } = record(conn);
    driver.subject.error(new Error('decryption failed'));
    expect(events).toEqual([
      { type: 'disconnected', reason: 'The cube driver failed: decryption failed' },
    ]);
  });

  it("emits disconnected on the driver's DISCONNECT event (upstream's driver)", async () => {
    const driver = fakeDriver({ upstream: true });
    const conn = await open(driver);
    const { events, completed } = record(conn);
    driver.subject.next({ type: 'DISCONNECT', timestamp: 3000 });
    expect(events).toEqual([{ type: 'disconnected', reason: 'The cube closed the connection.' }]);
    expect(completed()).toBe(true);
    expect(driver.upstreamSubscription()?.closed).toBe(true);
    expect(driver.upstreamDisconnect).toHaveBeenCalledOnce();
  });

  it('disconnect(): emits disconnected, stops listening, closes the GATT link, once', async () => {
    const driver = fakeDriver();
    const conn = await open(driver);
    const { events, completed } = record(conn);
    await conn.disconnect();
    driver.subject.next(move('R'));
    await conn.disconnect();
    expect(events).toEqual([{ type: 'disconnected', reason: 'Disconnected on request.' }]);
    expect(completed()).toBe(true);
    expect(driver.subject.observed).toBe(false);
    expect(driver.gatt.disconnect).toHaveBeenCalledOnce();
    await expect(conn.requestFacelets()).rejects.toThrow(/disconnected/);
    const late = record(conn);
    expect(late.events).toEqual([{ type: 'disconnected', reason: 'Disconnected on request.' }]);
  });
});

describe('helpers', () => {
  it('normalizeMac accepts six hex bytes or twelve hex digits', () => {
    expect(normalizeMac('ab:12:cd:34:ef:56')).toBe(MAC);
    expect(normalizeMac('AB-12-CD-34-EF-56')).toBe(MAC);
    expect(normalizeMac('ab 12 cd 34 ef 56')).toBe(MAC);
    expect(normalizeMac('ab12cd34ef56')).toBe(MAC);
    for (const bad of [
      '',
      'AB:12:CD:34:EF',
      'AB:12:CD:34:EF:56:78',
      'GG:12:CD:34:EF:56',
      'AB.12.CD.34.EF.56',
    ]) {
      expect(normalizeMac(bad)).toBeNull();
    }
  });

  it("driverTimeToHost is the identity outside a window (the driver's clock is Date.now() there)", () => {
    expect(driverTimeToHost()(1234)).toBe(1234);
  });

  it('the installed driver loads (no Bluetooth is touched on import) and exports connectGanCube', async () => {
    await expect(loadGanDriver()).resolves.toBeTypeOf('function');
  });
});
