// A harness for unit tests that drive the timer through a real SessionService: the fake cube as a
// GAN cube on a fake clock, fixed scrambles, fake animation frames and an in-memory store. Nothing in
// the app imports this file, so it is not in the bundle.
import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  MemorySessionStore,
  SOLVED,
  formatMoves,
  inverseSequence,
  parseMoves,
  type SessionStore,
} from '@cubetrace/core';
import { FakeCube, type CubeConnection, type CubeEvent } from '@cubetrace/gan';
import { Subject, merge } from 'rxjs';

import { CubeService, GAN_CONNECTOR } from '../cube/cube-service';
import { DEMO_FILE, FakeGanConnector, asGanCube, bluetoothNavigator } from '../cube/cube-testing';
import { DEMO_SOLVES_URL } from '../cube/demo';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FakeAnimationFrames,
  FakeFetch,
  FakeLocalStorage,
  FakePerformance,
  FakeStorageManager,
  FakeWakeLock,
  settle,
} from '../device/fake-browser';
import { SettingsService } from '../settings/settings-service';
import { SCRAMBLE_SOURCE, SessionService } from './session-service';
import { SESSION_STORAGE } from './session-storage';

export const SCRAMBLES = ['R U F', "L2 D B'", "U' R2 F", 'B D L'];

export interface Setup {
  service: SessionService;
  cube: CubeService;
  settings: SettingsService;
  store: SessionStore;
  perf: FakePerformance;
  frames: FakeAnimationFrames;
  wakeLock: FakeWakeLock;
  storage: FakeStorageManager;
  localStorage: FakeLocalStorage;
  connector: FakeGanConnector;
  /** Scrambles handed out so far. */
  made: string[];
}

export function setup(
  opts: {
    store?: SessionStore;
    localStorage?: FakeLocalStorage;
    scrambles?: string[];
    /** The navigator's Web Bluetooth; default Chrome with the flag on (`bluetoothNavigator(true)`). */
    navigator?: Partial<Navigator>;
    /** More providers, such as a stand-in for the scramble picture's loader. */
    providers?: Provider[];
  } = {},
): Setup {
  const perf = new FakePerformance();
  const frames = new FakeAnimationFrames();
  const wakeLock = new FakeWakeLock();
  const storage = new FakeStorageManager({ grant: true });
  const localStorage = opts.localStorage ?? new FakeLocalStorage();
  const store = opts.store ?? new MemorySessionStore();
  const connector = new FakeGanConnector();
  const scrambles = [...(opts.scrambles ?? SCRAMBLES)];
  const made: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      {
        provide: BROWSER_GLOBALS,
        useValue: {
          navigator: { ...(opts.navigator ?? bluetoothNavigator(true)), wakeLock, storage },
          localStorage,
          performance: perf,
          requestAnimationFrame: frames.request,
          cancelAnimationFrame: frames.cancel,
          fetch: new FakeFetch({ [DEMO_SOLVES_URL]: DEMO_FILE }).fetch,
        },
      },
      { provide: GAN_CONNECTOR, useValue: connector.connect },
      { provide: SESSION_STORAGE, useValue: { store, kind: 'memory' } },
      ...(opts.providers ?? []),
      {
        provide: SCRAMBLE_SOURCE,
        useValue: () => {
          const scramble = scrambles.shift();
          if (scramble === undefined) {
            return Promise.reject(new Error('No scramble left.'));
          }
          made.push(scramble);
          return Promise.resolve(scramble);
        },
      },
    ],
  });
  return {
    service: TestBed.inject(SessionService),
    cube: TestBed.inject(CubeService),
    settings: TestBed.inject(SettingsService),
    store,
    perf,
    frames,
    wakeLock,
    storage,
    localStorage,
    connector,
    made,
  };
}

/** Connects `connection` as a GAN cube through the fake connector. */
export async function connect(s: Setup, connection: CubeConnection): Promise<void> {
  const connecting = s.cube.connect();
  s.connector.last.resolve(connection);
  await connecting;
}

/** A fake cube on the test's clock, connected, with the service ready and a scramble made. */
export async function ready(s: Setup, start = SOLVED): Promise<FakeCube> {
  await s.service.whenReady();
  s.service.prepare();
  await settle();
  const fake = new FakeCube({ start, now: () => s.perf.hostMs });
  await connect(s, asGanCube(fake));
  return fake;
}

/** Turns `moves` on the fake cube, `gapMs` apart on the host clock. */
export function turn(s: Setup, fake: FakeCube, moves: string, gapMs = 100): void {
  for (const m of parseMoves(moves)) {
    s.perf.advance(gapMs);
    fake.turn(m);
  }
}

export function inverse(moves: string): string {
  return formatMoves(inverseSequence(parseMoves(moves)));
}

/** A fake cube whose connection can also emit events the test writes (facelets, gyro). */
export function scripted(fake: FakeCube): {
  connection: CubeConnection;
  emit: (event: CubeEvent) => void;
} {
  const extra = new Subject<CubeEvent>();
  return {
    connection: {
      kind: 'gan',
      events$: merge(fake.events$, extra),
      get facelets() {
        return fake.facelets;
      },
      requestFacelets: () => fake.requestFacelets(),
      requestBattery: () => fake.requestBattery(),
      disconnect: () => fake.disconnect(),
    },
    emit: (event) => {
      extra.next(event);
    },
  };
}
