import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isSolved, type Facelets } from '@cubetrace/core';
import {
  FakeCube,
  checkBluetoothSupport,
  connectGanCube,
  loadGanDriver,
  normalizeMac,
  type BluetoothSupport,
  type CubeConnection,
  type CubeEvent,
  type CubeHardwareEvent,
  type CubeMoveEvent,
  type MacProvider,
} from '@cubetrace/gan';
import { BehaviorSubject, EMPTY, switchMap, type Observable, type Subscription } from 'rxjs';

import { BROWSER_GLOBALS, hostNow } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SettingsService, macAddressProblem } from '../settings/settings-service';
import { errorMessage } from '../shared/error-message';
import { connectFailureKind, describeConnectError } from './connect-error';
import {
  DISCONNECTED_ON_REQUEST,
  describeDisconnect,
  idleDisconnectReason,
} from './disconnect-reason';
import {
  ANY_DEMO,
  DemoSolves,
  chooseDemo,
  demoParts,
  parseDemoGyro,
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

/** Loads the GAN driver's code: @cubetrace/gan's `loadGanDriver`. */
export type GanDriverLoader = () => Promise<unknown>;

/** The GAN driver loader the service preloads with; the unit tests provide a fake one. */
export const GAN_DRIVER_LOADER = new InjectionToken<GanDriverLoader>('GAN_DRIVER_LOADER', {
  providedIn: 'root',
  factory: () => loadGanDriver,
});

/** What "Mark as solved" does, next to the button (the Timer page's Cube section, the dialog). */
export const MARK_AS_SOLVED_HINT =
  "Sets the cube's own state to solved; use it when the app or the cube got out of sync, with " +
  'the cube actually solved in your hands.';

/** How many of the latest moves `CubeService.moves` keeps. */
export const MOVE_HISTORY = 200;

/**
 * How a GAN cube's MAC address came, for the diagnostics (`cube.connected`, docs/DIAGNOSTICS.md):
 * `stored`, from Settings' list (typed here before, or synced from the account); `driver`, read by
 * Chrome from the advertisement (the flag); `typed`, in the connect dialog; `none`, the demo cube.
 */
export type MacSource = 'stored' | 'driver' | 'typed' | 'none';

/** The driver could not read the cube's MAC address and asks the user for it. */
export interface MacPrompt {
  /** The cube's Bluetooth name, when it has one; a remembered address is stored under it. */
  readonly deviceName: string | null;
}

/** The raw facts of a disconnection (`CubeService.facts`). */
interface DisconnectFacts {
  readonly reason: string;
  readonly idleMs: number;
  readonly visibilityState: DocumentVisibilityState | null;
  readonly hiddenMs: number | null;
  readonly connectedMs: number;
  readonly battery: number | null;
  readonly model: string | null;
}

/** What `reconnect()` repeats: the last connection that was established. */
type Source =
  | { readonly kind: 'gan' }
  | {
      readonly kind: 'demo';
      readonly solve: DemoSolve;
      readonly speed: number;
      readonly misscramble: number | null;
      /** The demo cube reports a gyroscope (T3.7). */
      readonly gyro: boolean;
    };

/**
 * The app's one cube connection (docs/PLAN.md, T1.6a): a GAN cube through `connectGanCube`, or
 * the fake cube replaying a demo solve. It holds what the connect dialog, the status pill and the
 * live cube panel show as signals, and forwards the connection's events (`events$`) to the
 * timer. The cube state and the event stream come from @cubetrace/gan and @cubetrace/core:
 * `facelets` is the connection's own state after each event, `solved` is core's `isSolved`.
 * There is no automatic reconnection: Web Bluetooth needs a click, so `reconnect()` is an action.
 *
 * Since T1.14: "Mark as solved" (`resetToSolved()`); a real cube is disconnected after the
 * minutes without a turn that Settings gives (`idleDisconnectMinutes`), to save its battery; a
 * disconnection the app did not ask for gets a reason that says how long the cube had not been
 * turned and whether the tab was in the background, and one line in the console with the raw
 * facts; back in view, a connected cube is asked for its state, so that turns missed while the
 * tab was hidden are caught up; and the GAN driver's code starts loading as soon as the service
 * exists, so that a click on Connect does not wait for it.
 */
@Injectable({ providedIn: 'root' })
export class CubeService {
  private readonly settings = inject(SettingsService);
  private readonly demoSolves = inject(DemoSolves);
  private readonly connectGan = inject(GAN_CONNECTOR);
  private readonly loadDriver = inject(GAN_DRIVER_LOADER);
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly diagnostics = inject(DiagnosticsService);

  /** What this browser can do for a GAN cube, for the connect dialog. */
  readonly support: BluetoothSupport = checkBluetoothSupport(this.globals.navigator);

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
  /**
   * Why the last connection ended, such as "Disconnected on request."; null while connected. When
   * the app did not ask for it, the connection's own reason is followed by what the app knows (see
   * `describeDisconnect`).
   */
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
  /** How the current attempt's MAC address came, for `cube.connected`. */
  private macSource: MacSource = 'none';
  /** Host ms when the current attempt to connect began, for `cube.connected`. */
  private beganAt = 0;
  /** The connection whose `cube.connected` was recorded (its hardware event came). */
  private announced: CubeConnection | null = null;
  /** A typed address to store once the cube it was typed for has connected. */
  private macToRemember: { name: string; mac: string } | null = null;
  /** The demo cube while it replays its solve; "Mark as solved" stops the replay. */
  private replaying: FakeCube | null = null;
  /** The reason of the disconnection that the app asked for, until the connection ends. */
  private closing: { readonly connection: CubeConnection; readonly reason: string } | null = null;
  /** Host ms when the current connection was made, and when its cube last turned. */
  private connectedAt = 0;
  private lastTurnAt: number | null = null;
  /** The countdown to the idle disconnection (a `setTimeout` handle). */
  private idleTimer: number | null = null;
  /** Host ms when the tab was hidden; null while it is visible. */
  private hiddenSince: number | null = null;

  /**
   * The events of the current connection, and of each later one: subscribe once and follow the
   * cube across reconnections. A new connection's stream starts with its `hardware` and `battery`
   * events; each one ends with `disconnected`.
   */
  readonly events$: Observable<CubeEvent> = this.connection$.pipe(
    switchMap((connection) => connection?.events$ ?? EMPTY),
  );

  constructor() {
    if (this.support.available) {
      // The driver's chunk downloads now rather than on the click on Connect: Chrome opens its
      // device picker only within a few seconds of the click, and a slow network could take them.
      // connectGanCube awaits this same load (loadGanDriver keeps it); a failed one is tried again
      // there, so the failure here is dropped.
      void this.loadDriver().catch(() => undefined);
    }
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      this.clearIdleTimer();
    });
    const page = this.globals.document;
    if (page !== undefined) {
      if (page.visibilityState === 'hidden') {
        this.hiddenSince = this.now();
      }
      const onVisibilityChange = (): void => {
        this.onVisibilityChange(page.visibilityState);
      };
      page.addEventListener('visibilitychange', onVisibilityChange);
      destroyRef.onDestroy(() => {
        page.removeEventListener('visibilitychange', onVisibilityChange);
      });
    }
    // A new idle setting applies at once, counted from now: 0 stops the countdown.
    effect(() => {
      this.settings.idleDisconnectMinutes();
      untracked(() => {
        this.armIdleTimer();
      });
    });
  }

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
        const context = { mac: this.macGiven, cancelled: this.macCancelled };
        // Why it failed, as a kind (never the message: it may name the address).
        this.diagnostics.record('cube.failed', {
          reason: connectFailureKind(error, context),
          mac: this.macSource,
          ms: Math.round(this.now() - this.beganAt),
        });
        this.fail(describeConnectError(error, context));
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
   * With `gyro`, it reports a gyroscope, turning while it replays (T3.7).
   */
  connectDemo(
    solve: DemoSolve,
    speed: number,
    misscramble: number | null = null,
    gyro = false,
  ): void {
    const cube = new FakeCube({ speed, gyro });
    this.begin('fake');
    this.demoSignal.set(solve);
    this.demoSpeedSignal.set(speed);
    this.attach(cube, { kind: 'demo', solve, speed, misscramble, gyro });
    this.replaying = cube;
    void this.replay(cube, demoParts(solve, misscramble), speed);
  }

  /**
   * Downloads the demo solves (once) and connects the demo cube with the one `request` asks for
   * (`?demo=<index>&speed=<n>`, `&misscramble=<k>` for a wrong turn after scramble move k, and
   * `&gyro=1` for a gyroscope, T3.7): a random one, and the speed from Settings, where it asks for
   * nothing valid. Never rejects: a failure sets `lastError`.
   */
  async startDemo(request: DemoRequest = ANY_DEMO): Promise<void> {
    const generation = this.begin('fake');
    let solves: readonly DemoSolve[];
    try {
      solves = await this.demoSolves.load();
    } catch (error: unknown) {
      if (generation === this.generation) {
        this.diagnostics.record('cube.failed', { reason: 'demo', mac: 'none', ms: 0 });
        this.fail(`The demo solves could not be loaded: ${errorMessage(error)}`);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    const { index, speed } = chooseDemo(request, solves.length, this.settings.demoSpeed());
    this.connectDemo(
      solves[index],
      speed,
      parseDemoMisscramble(request.misscramble ?? null),
      parseDemoGyro(request.gyro ?? null),
    );
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
      this.connectDemo(source.solve, source.speed, source.misscramble, source.gyro);
      return Promise.resolve();
    }
    return this.connect();
  }

  /**
   * Closes the connection, or gives up connecting. `disconnectReason` becomes `reason`, by default
   * that it was on request (the idle disconnection gives its own).
   */
  async disconnect(reason: string = DISCONNECTED_ON_REQUEST): Promise<void> {
    this.generation++;
    this.dismissMacPrompt();
    const connection = this.connection;
    if (connection !== null) {
      this.closing = { connection, reason };
      await connection.disconnect(); // Emits `disconnected`, handled in onEvent.
    } else if (this.statusSignal() === 'connecting') {
      this.statusSignal.set('disconnected');
      this.kindSignal.set(null);
      this.disconnectReasonSignal.set('Connecting was cancelled.');
    }
  }

  /**
   * "Mark as solved": tells the cube that it is solved, for when the cube's own state and the app's
   * went apart (turns made while it was asleep or disconnected), with the cube solved in the
   * solver's hands. The connection's `facelets` event, flagged `reset`, brings every listener to
   * the solved state: this service's `facelets`, and the timer, which drops its attempt under way
   * without a record and begins it again (SessionService). A GAN cube then reports its state,
   * which confirms the reset or, if it disagrees, is adopted like any report. The demo cube's
   * replay stops there, as a solver's hands would. It counts as activity for the idle
   * disconnection. Does nothing while no cube is connected.
   */
  async resetToSolved(): Promise<void> {
    const connection = this.connection;
    if (connection === null || this.statusSignal() !== 'connected') {
      return;
    }
    const replaying = this.replaying;
    if (replaying === connection) {
      this.replaying = null;
      replaying.stop();
    }
    this.armIdleTimer();
    this.diagnostics.record('cube.reset', { kind: connection.kind });
    try {
      await connection.resetToSolved();
    } catch (error: unknown) {
      console.warn(`The cube's state could not be reset: ${errorMessage(error)}`);
      this.diagnostics.record('error.app', {
        where: 'cube',
        message: `The cube's state could not be reset: ${errorMessage(error)}`,
      });
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
    this.macSource = 'typed';
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
      this.macSource = this.macGiven === null ? 'driver' : 'stored';
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
    this.macSource = 'none';
    this.beganAt = this.now();
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
    this.closing = null;
    this.connectedAt = this.now();
    this.lastTurnAt = null;
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
    this.armIdleTimer();
  }

  private detach(): void {
    this.connection = null;
    this.replaying = null;
    this.clearIdleTimer();
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  /**
   * Plays the demo's parts on `cube` one after the other, until the last one or until the replay
   * ends (the cube replaced, disconnected or marked as solved). Each part after the first starts on
   * a timer of `pauseMs / speed` (0 included) set once the previous part has ended, so its schedule
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
        if (this.replaying !== cube) {
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
        this.lastTurnAt = this.now();
        this.armIdleTimer();
        break;
      case 'facelets':
        this.faceletsSignal.set(event.facelets);
        break;
      case 'battery':
        this.batterySignal.set(event.level);
        break;
      case 'hardware':
        this.hardwareSignal.set(event);
        if (this.announced !== connection) {
          this.announced = connection;
          this.diagnostics.record('cube.connected', {
            kind: connection.kind,
            model: event.model,
            hardware: event.hardware,
            firmware: event.firmware,
            gyro: event.gyro,
            productDate: event.productDate ?? null,
            mac: this.macSource,
            ms: Math.round(this.now() - this.beganAt),
            battery: this.batterySignal(),
          });
        }
        break;
      case 'gyro':
        break;
      case 'disconnected': {
        const requested = this.closing?.connection === connection ? this.closing.reason : null;
        this.closing = null;
        const facts = this.facts(requested ?? event.reason ?? 'The cube disconnected.');
        const reason = requested ?? this.diagnose(facts);
        this.diagnostics.record('cube.disconnected', {
          ...facts,
          kind: connection.kind,
          requested: requested !== null,
          moves: this.moveCountSignal(),
        });
        this.detach();
        this.statusSignal.set('disconnected');
        this.kindSignal.set(null);
        this.hardwareSignal.set(null);
        this.batterySignal.set(null);
        this.demoSignal.set(null);
        this.demoSpeedSignal.set(null);
        this.disconnectReasonSignal.set(reason);
        break;
      }
    }
  }

  /**
   * The raw facts of a disconnection, for the console and the diagnostics (`cube.disconnected`):
   * `reason`, the connection's own reason (or the app's, when it asked for it), the ms since the
   * last turn (or since connecting), the page's visibility and, if hidden, for how long, the
   * connection's duration, the last battery level and the model.
   */
  private facts(reason: string): DisconnectFacts {
    const now = this.now();
    const visibilityState = this.globals.document?.visibilityState ?? null;
    return {
      reason,
      idleMs: Math.round(now - (this.lastTurnAt ?? this.connectedAt)),
      visibilityState,
      hiddenMs: this.hiddenSince === null ? null : Math.round(now - this.hiddenSince),
      connectedMs: Math.round(now - this.connectedAt),
      battery: this.batterySignal(),
      model: this.hardwareSignal()?.model ?? null,
    };
  }

  /**
   * The reason shown for a disconnection that the app did not ask for (`describeDisconnect`), and
   * one line in the console with the raw facts, for the owner to paste into an issue.
   */
  private diagnose(facts: DisconnectFacts): string {
    console.info(`cubetrace: the cube disconnected ${JSON.stringify(facts)}`);
    return describeDisconnect({
      reason: facts.reason,
      idleMs: facts.idleMs,
      hidden: facts.visibilityState === 'hidden',
    });
  }

  /**
   * (Re)starts the countdown to the idle disconnection: `idleDisconnectMinutes` from now, while a
   * GAN cube is connected and the setting is not 0 (the demo cube has no battery to save). When it
   * runs out, the cube is disconnected with a reason that says why.
   */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    const connection = this.connection;
    const minutes = this.settings.idleDisconnectMinutes();
    if (
      connection?.kind !== 'gan' ||
      this.statusSignal() !== 'connected' ||
      minutes === 0 ||
      this.globals.setTimeout === undefined
    ) {
      return;
    }
    this.idleTimer = this.globals.setTimeout(() => {
      this.idleTimer = null;
      if (this.connection === connection) {
        void this.disconnect(idleDisconnectReason(minutes));
      }
    }, minutes * 60_000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      this.globals.clearTimeout?.(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * The tab was hidden, or shown again. Back in view with a cube connected, the cube is asked for
   * its state once: turns made while the tab was hidden may have gone unseen, and a report that
   * differs is adopted (the timer resyncs to it). Nothing connects by itself: Web Bluetooth needs a
   * click, so a disconnected cube waits for Reconnect.
   */
  private onVisibilityChange(state: DocumentVisibilityState): void {
    if (state === 'hidden') {
      this.hiddenSince ??= this.now();
      return;
    }
    this.hiddenSince = null;
    const connection = this.connection;
    if (connection !== null && this.statusSignal() === 'connected') {
      void connection.requestFacelets().catch((error: unknown) => {
        console.warn(`The cube could not be asked for its state: ${errorMessage(error)}`);
      });
    }
  }

  private now(): number {
    return hostNow(this.globals);
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
