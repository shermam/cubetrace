import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { isSolved, type Facelets } from '@cubetrace/core';
import {
  FakeCube,
  checkBluetoothSupport,
  connectGanCube,
  normalizeMac,
  type BluetoothSupport,
  type CubeConnection,
  type CubeEvent,
  type CubeHardwareEvent,
  type CubeMoveEvent,
  type MacProvider,
} from '@cubetrace/gan';
import { BehaviorSubject, EMPTY, switchMap, type Observable, type Subscription } from 'rxjs';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { SettingsService, macAddressProblem } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { describeConnectError } from './connect-error';
import {
  ANY_DEMO,
  DemoSolves,
  chooseDemo,
  demoParts,
  parseDemoMisscramble,
  type DemoPart,
  type DemoRequest,
  type DemoSolve,
} from './demo';

/** `connecting`: from the click on Connect (or a demo starting) until the cube's first state. */
export type CubeStatus = 'disconnected' | 'connecting' | 'connected';

/** Connects a GAN cube over Web Bluetooth: @cubetrace/gan's `connectGanCube`. */
export type GanConnector = (opts: { macProvider: MacProvider }) => Promise<CubeConnection>;

/** The GAN connector the service uses; the unit tests provide a fake one. */
export const GAN_CONNECTOR = new InjectionToken<GanConnector>('GAN_CONNECTOR', {
  providedIn: 'root',
  factory: () => connectGanCube,
});

/** How many of the latest moves `CubeService.moves` keeps. */
export const MOVE_HISTORY = 200;

/** The driver could not read the cube's MAC address and asks the user for it. */
export interface MacPrompt {
  /** The cube's Bluetooth name, when it has one; a remembered address is stored under it. */
  readonly deviceName: string | null;
}

/** What `reconnect()` repeats: the last connection that was established. */
type Source =
  | { readonly kind: 'gan' }
  | {
      readonly kind: 'demo';
      readonly solve: DemoSolve;
      readonly speed: number;
      readonly misscramble: number | null;
    };

/**
 * The app's one cube connection (docs/PLAN.md, T1.6a): a GAN cube through `connectGanCube`, or
 * the fake cube replaying a demo solve. It holds what the connect dialog, the status pill and the
 * live cube panel show as signals, and forwards the connection's events (`events$`) to the
 * timer. The cube state and the event stream come from @cubetrace/gan and @cubetrace/core:
 * `facelets` is the connection's own state after each event, `solved` is core's `isSolved`.
 * There is no automatic reconnection: Web Bluetooth needs a click, so `reconnect()` is an action.
 */
@Injectable({ providedIn: 'root' })
export class CubeService {
  private readonly settings = inject(SettingsService);
  private readonly demoSolves = inject(DemoSolves);
  private readonly connectGan = inject(GAN_CONNECTOR);

  /** What this browser can do for a GAN cube, for the connect dialog. */
  readonly support: BluetoothSupport = checkBluetoothSupport(inject(BROWSER_GLOBALS).navigator);

  private readonly statusSignal = signal<CubeStatus>('disconnected');
  private readonly kindSignal = signal<CubeConnection['kind'] | null>(null);
  private readonly hardwareSignal = signal<CubeHardwareEvent | null>(null);
  private readonly batterySignal = signal<number | null>(null);
  private readonly faceletsSignal = signal<Facelets | null>(null);
  private readonly movesSignal = signal<readonly CubeMoveEvent[]>([]);
  private readonly moveCountSignal = signal(0);
  private readonly lastErrorSignal = signal<string | null>(null);
  private readonly disconnectReasonSignal = signal<string | null>(null);
  private readonly macPromptSignal = signal<MacPrompt | null>(null);
  private readonly demoSignal = signal<DemoSolve | null>(null);
  private readonly demoSpeedSignal = signal<number | null>(null);
  private readonly sourceSignal = signal<Source | null>(null);

  readonly status = this.statusSignal.asReadonly();
  /** `gan` or `fake` while connecting or connected; null otherwise. */
  readonly kind = this.kindSignal.asReadonly();
  /** Model, hardware and firmware versions, gyroscope: what the cube says it is. */
  readonly hardware = this.hardwareSignal.asReadonly();
  /** Battery level in percent, once the cube has reported it. */
  readonly battery = this.batterySignal.asReadonly();
  /**
   * The cube's state, updated on every move and facelets event; null before the first
   * connection. After a disconnection it keeps the last state until the next connection.
   */
  readonly facelets = this.faceletsSignal.asReadonly();
  readonly solved = computed(() => {
    const facelets = this.faceletsSignal();
    return facelets !== null && isSolved(facelets);
  });
  /** The last {@link MOVE_HISTORY} moves of the current (or last) connection, oldest first. */
  readonly moves = this.movesSignal.asReadonly();
  /** How many moves the current (or last) connection has reported. */
  readonly moveCount = this.moveCountSignal.asReadonly();
  /** Why the last attempt to connect failed, in plain words; null after a success. */
  readonly lastError = this.lastErrorSignal.asReadonly();
  /** Why the last connection ended, such as "Disconnected on request."; null while connected. */
  readonly disconnectReason = this.disconnectReasonSignal.asReadonly();
  /** Set while the driver waits for the user to type the cube's MAC address. */
  readonly macPrompt = this.macPromptSignal.asReadonly();
  /** The demo solve being replayed, when the cube is the demo cube (T1.6b takes its scramble). */
  readonly demo = this.demoSignal.asReadonly();
  /** The demo's replay speed, when the cube is the demo cube. */
  readonly demoSpeed = this.demoSpeedSignal.asReadonly();
  /** The last established connection was a real cube, so "Reconnect" makes sense. */
  readonly canReconnect = computed(
    () => this.statusSignal() === 'disconnected' && this.sourceSignal()?.kind === 'gan',
  );

  private connection: CubeConnection | null = null;
  private subscription: Subscription | null = null;
  private readonly connection$ = new BehaviorSubject<CubeConnection | null>(null);
  /** Incremented by every connect and disconnect: a slower, older attempt then knows it lost. */
  private generation = 0;
  private answerMacPrompt: ((mac: string | null) => void) | null = null;
  /** The MAC address given to the driver during the current attempt, for error messages. */
  private macGiven: string | null = null;
  private macCancelled = false;
  /** A typed address to store once the cube it was typed for has connected. */
  private macToRemember: { name: string; mac: string } | null = null;

  /**
   * The events of the current connection, and of each later one: subscribe once and follow the
   * cube across reconnections. A new connection's stream starts with its `hardware` and `battery`
   * events; each one ends with `disconnected`.
   */
  readonly events$: Observable<CubeEvent> = this.connection$.pipe(
    switchMap((connection) => connection?.events$ ?? EMPTY),
  );

  /**
   * Connects a GAN cube: Chrome's device picker, then the MAC address (a stored one first; else
   * the driver reads it or asks through `macPrompt`), then the cube's state. Never rejects:
   * a failure sets `lastError`.
   */
  async connect(): Promise<void> {
    const generation = this.begin('gan');
    if (!this.support.available) {
      this.fail(this.support.hint);
      return;
    }
    let connection: CubeConnection;
    try {
      connection = await this.connectGan({
        macProvider: (device, isFallback) => this.provideMac(generation, device, isFallback),
      });
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.fail(
          describeConnectError(error, { mac: this.macGiven, cancelled: this.macCancelled }),
        );
      }
      return;
    }
    if (generation !== this.generation) {
      // Given up (disconnect() or another connection) while the cube was connecting.
      void connection.disconnect();
      return;
    }
    const remember = this.macToRemember;
    this.macToRemember = null;
    if (remember !== null) {
      this.settings.saveCubeMac(remember.name, remember.mac);
    }
    this.attach(connection, { kind: 'gan' });
  }

  /**
   * Connects the demo cube (a `FakeCube` at `speed`): it starts solved, turns the scramble at one
   * move per 100 ms, then the solution on its recorded timings, every gap divided by `speed`. With
   * `misscramble` k, it makes one wrong turn after scramble move k and undoes it (`demoParts`).
   */
  connectDemo(solve: DemoSolve, speed: number, misscramble: number | null = null): void {
    const cube = new FakeCube({ speed });
    this.begin('fake');
    this.demoSignal.set(solve);
    this.demoSpeedSignal.set(speed);
    this.attach(cube, { kind: 'demo', solve, speed, misscramble });
    void this.replay(cube, demoParts(solve, misscramble), speed);
  }

  /**
   * Downloads the demo solves (once) and connects the demo cube with the one `request` asks for
   * (`?demo=<index>&speed=<n>`, and `&misscramble=<k>` for a wrong turn after scramble move k): a
   * random one, and the speed from Settings, where it asks for nothing valid. Never rejects: a
   * failure sets `lastError`.
   */
  async startDemo(request: DemoRequest = ANY_DEMO): Promise<void> {
    const generation = this.begin('fake');
    let solves: readonly DemoSolve[];
    try {
      solves = await this.demoSolves.load();
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.fail(`The demo solves could not be loaded: ${errorMessage(error)}`);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    const { index, speed } = chooseDemo(request, solves.length, this.settings.demoSpeed());
    this.connectDemo(solves[index], speed, parseDemoMisscramble(request.misscramble ?? null));
  }

  /** Starts the demo that the page's address asks for, unless a cube is (being) connected. */
  autoStartDemo(request: DemoRequest): void {
    if (this.statusSignal() === 'disconnected') {
      void this.startDemo(request);
    }
  }

  /** Connects the last cube again: the device picker for a real cube, the same demo replayed. */
  reconnect(): Promise<void> {
    const source = this.sourceSignal();
    if (source?.kind === 'demo') {
      this.connectDemo(source.solve, source.speed, source.misscramble);
      return Promise.resolve();
    }
    return this.connect();
  }

  /** Closes the connection, or gives up connecting; `disconnectReason` says it was on request. */
  async disconnect(): Promise<void> {
    this.generation++;
    this.dismissMacPrompt();
    const connection = this.connection;
    if (connection !== null) {
      await connection.disconnect(); // Emits `disconnected`, handled in onEvent.
    } else if (this.statusSignal() === 'connecting') {
      this.statusSignal.set('disconnected');
      this.kindSignal.set(null);
      this.disconnectReasonSignal.set('Connecting was cancelled.');
    }
  }

  /**
   * Answers the MAC prompt with `text`; with `remember`, the address is stored for this cube once
   * it connects. Returns why `text` was refused (the prompt stays open), or null.
   */
  answerMac(text: string, remember: boolean): string | null {
    const answer = this.answerMacPrompt;
    const prompt = this.macPromptSignal();
    if (answer === null || prompt === null) {
      return 'No cube is waiting for a MAC address.';
    }
    const mac = normalizeMac(text);
    if (mac === null) {
      return macAddressProblem(text);
    }
    this.macGiven = mac;
    this.macToRemember =
      remember && prompt.deviceName !== null ? { name: prompt.deviceName, mac } : null;
    this.answerMacPrompt = null;
    this.macPromptSignal.set(null);
    answer(mac);
    return null;
  }

  /** Closes the MAC prompt without an address: connecting fails. */
  cancelMacPrompt(): void {
    if (this.answerMacPrompt !== null) {
      this.macCancelled = true;
      this.dismissMacPrompt();
    }
  }

  /**
   * The MAC provider given to the driver: first (`isFallback` false) the address stored for this
   * cube's name, or null to let the driver read it; on the fallback call, the user's answer.
   */
  private provideMac(
    generation: number,
    device: { name?: string; id: string },
    isFallback: boolean,
  ): Promise<string | null> {
    if (generation !== this.generation) {
      return Promise.resolve(null);
    }
    const name = device.name?.trim() ?? '';
    const deviceName = name === '' ? null : name;
    if (!isFallback) {
      this.macGiven = this.settings.macFor(deviceName);
      return Promise.resolve(this.macGiven);
    }
    this.dismissMacPrompt();
    return new Promise((resolve) => {
      this.answerMacPrompt = resolve;
      this.macPromptSignal.set({ deviceName });
    });
  }

  /**
   * Starts an attempt to connect a cube of `kind`: closes the current connection (its
   * `disconnected` still reaches `events$`), clears the last attempt's state and sets
   * `connecting`. Returns the attempt's generation.
   */
  private begin(kind: CubeConnection['kind']): number {
    const current = this.connection;
    if (current !== null) {
      this.detach();
      void current.disconnect();
    }
    this.dismissMacPrompt();
    this.generation++;
    this.macGiven = null;
    this.macCancelled = false;
    this.macToRemember = null;
    this.demoSignal.set(null);
    this.demoSpeedSignal.set(null);
    this.lastErrorSignal.set(null);
    this.disconnectReasonSignal.set(null);
    this.hardwareSignal.set(null);
    this.batterySignal.set(null);
    this.kindSignal.set(kind);
    this.statusSignal.set('connecting');
    return this.generation;
  }

  private attach(connection: CubeConnection, source: Source): void {
    this.connection = connection;
    this.sourceSignal.set(source);
    this.kindSignal.set(connection.kind);
    this.faceletsSignal.set(connection.facelets);
    this.movesSignal.set([]);
    this.moveCountSignal.set(0);
    this.statusSignal.set('connected');
    // A connection's stream replays its hardware and battery events to a new subscriber.
    this.subscription = connection.events$.subscribe((event) => {
      this.onEvent(connection, event);
    });
    this.connection$.next(connection);
  }

  private detach(): void {
    this.connection = null;
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  /**
   * Plays the demo's parts on `cube` one after the other, until the last one or until the cube is
   * no longer the connection (replaced or disconnected). Each part after the first starts on a
   * timer of `pauseMs / speed` (0 included) set once the previous part has ended, so its schedule
   * counts from after the page has taken that part's last move in (`demoParts`). Never rejects: a
   * failure sets `lastError` while the cube is still connected.
   */
  private async replay(cube: FakeCube, parts: readonly DemoPart[], speed: number): Promise<void> {
    try {
      for (const [i, part] of parts.entries()) {
        if (i > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, part.pauseMs / speed);
          });
        }
        if (this.connection !== cube) {
          return;
        }
        await cube.play(part.moves);
      }
    } catch (error: unknown) {
      if (this.connection === cube) {
        this.lastErrorSignal.set(`The demo stopped: ${errorMessage(error)}`);
      }
    }
  }

  private onEvent(connection: CubeConnection, event: CubeEvent): void {
    if (connection !== this.connection) {
      return;
    }
    switch (event.type) {
      case 'move':
        // The connection applies each move to its state before emitting it.
        this.faceletsSignal.set(connection.facelets);
        this.moveCountSignal.update((count) => count + 1);
        this.movesSignal.update((moves) => [...moves, event].slice(-MOVE_HISTORY));
        break;
      case 'facelets':
        this.faceletsSignal.set(event.facelets);
        break;
      case 'battery':
        this.batterySignal.set(event.level);
        break;
      case 'hardware':
        this.hardwareSignal.set(event);
        break;
      case 'gyro':
        break;
      case 'disconnected':
        this.detach();
        this.statusSignal.set('disconnected');
        this.kindSignal.set(null);
        this.hardwareSignal.set(null);
        this.batterySignal.set(null);
        this.demoSignal.set(null);
        this.demoSpeedSignal.set(null);
        this.disconnectReasonSignal.set(event.reason ?? 'The cube disconnected.');
        break;
    }
  }

  private fail(message: string): void {
    this.dismissMacPrompt();
    this.statusSignal.set('disconnected');
    this.kindSignal.set(null);
    this.lastErrorSignal.set(message);
  }

  /** Closes the MAC prompt, if open, answering the driver with no address. */
  private dismissMacPrompt(): void {
    const answer = this.answerMacPrompt;
    this.answerMacPrompt = null;
    this.macPromptSignal.set(null);
    answer?.(null);
  }
}
