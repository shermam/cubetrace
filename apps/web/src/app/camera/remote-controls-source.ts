import { computed, signal } from '@angular/core';
import {
  CONTROL_NAMES,
  autoModeOf,
  modeControlOf,
  modesOf,
  type CameraControls,
  type ControlDrift,
  type ControlName,
  type ControlValue,
  type ControlValues,
} from '@cubetrace/capture';
import type { ControlsReport, MessageLink, SetControls, Timers } from '@cubetrace/rtc';

import type { ControlsSource } from './controls-source';

/**
 * How long a change sent to a phone waits for its answer (`controls` or `controls-failed`), ms: a
 * phone applies a control in a few ms, and reopens its camera for Reset to auto in about a second.
 */
export const SET_CONTROLS_TIMEOUT_MS = 3000;

/**
 * How long after the hellos (or a hello with a camera) the host waits for the phone's first
 * `controls`, ms; a phone that sends none by then runs a build without remote controls (0.4.0).
 */
export const CONTROLS_WAIT_MS = 5000;

/** "the phone did not answer": a change without an answer within {@link SET_CONTROLS_TIMEOUT_MS}. */
export const NO_ANSWER_TEXT = 'The phone did not answer.';

/**
 * Where a phone's controls are: `waiting` for its first `controls`, `ready` (they came), `unsupported`
 * (none came within {@link CONTROLS_WAIT_MS}: its build has no remote controls), `no-camera` (its
 * camera is off: its hello has none).
 */
export type RemoteControlsState = 'waiting' | 'ready' | 'unsupported' | 'no-camera';

/** What became of a change sent to the phone, for `remote.controls` (docs/DIAGNOSTICS.md). */
export interface RemoteControlsOutcome {
  /** The controls set, or `reset` (Reset to auto). */
  readonly set: readonly string[];
  readonly outcome: 'ok' | 'failed' | 'no-answer';
  /** The phone's words when it failed; null otherwise. */
  readonly message: string | null;
  /** From the change sent to its answer (or to the wait's end), ms. */
  readonly ms: number;
}

export interface RemoteControlsOptions {
  readonly timers: Timers;
  /** A change's outcome (the event `remote.controls`). */
  readonly onOutcome: (outcome: RemoteControlsOutcome) => void;
  /** The phone's controls came (the drift's words on the Timer page and in the Cameras list). */
  readonly onReport?: (report: ControlsReport) => void;
}

/** A change in flight: what was sent, when, and how its wait ends. */
interface Pending {
  readonly set: readonly string[];
  readonly sentMs: number;
  readonly timer: unknown;
  readonly done: () => void;
}

/**
 * A phone's camera controls on the host (docs/PLAN.md T5.2, docs/RTC.md §11): the `ControlsSource`
 * of the controls panel under the phone in the Cameras section, from the phone's last `controls`
 * message (its controls, its values, what it applied, what its camera changed by itself), and its
 * changes sent as `set-controls`. A change is in flight (`busy`, the panel's controls disabled)
 * until the phone's answer, `controls` (it applied it) or `controls-failed` (`error` says why), or
 * {@link SET_CONTROLS_TIMEOUT_MS} (`error`: "The phone did not answer."); each outcome goes to the
 * diagnostics (`remote.controls`). A phone that sends no `controls` within {@link CONTROLS_WAIT_MS}
 * of the hellos runs a build without remote controls (`state` `unsupported`). The source lives as
 * long as the phone's row, across its reconnections (`attach` per connection).
 */
export class RemoteControlsSource implements ControlsSource {
  private readonly reportSignal = signal<ControlsReport | null>(null);
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private readonly stateSignal = signal<RemoteControlsState>('waiting');

  readonly controls = computed<CameraControls | null>(() => this.reportSignal()?.controls ?? null);
  readonly values = computed<ControlValues>(() => this.reportSignal()?.values ?? {});
  readonly applied = computed<ControlValues>(() => this.reportSignal()?.applied ?? {});
  readonly drift = computed<readonly ControlDrift[]>(() => this.reportSignal()?.drift ?? []);
  readonly busy = this.busySignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();
  /** See {@link RemoteControlsState}. */
  readonly state = this.stateSignal.asReadonly();
  /** The phone's last `controls`, null before the first (and while its camera is off). */
  readonly report = this.reportSignal.asReadonly();

  private link: MessageLink | null = null;
  private offs: (() => void)[] = [];
  private pending: Pending | null = null;
  private waitTimer: unknown = null;

  constructor(private readonly options: RemoteControlsOptions) {}

  /**
   * A connection with the phone, its hellos exchanged: its `controls` and answers are read from
   * `link`, and its first `controls` awaited when its hello has a camera (`hasCamera`). Returns what
   * lets the connection go.
   */
  attach(link: MessageLink, hasCamera: boolean): () => void {
    this.detach();
    this.link = link;
    this.offs.push(
      link.on('controls', (message) => {
        this.received(message);
      }),
      link.on('controls-failed', (message) => {
        this.answered('failed', message.message);
      }),
    );
    this.cameraChanged(hasCamera);
    return () => {
      if (this.link === link) {
        this.detach();
      }
    };
  }

  /** The phone's hello again (its camera changed): the controls awaited when it has one. */
  cameraChanged(hasCamera: boolean): void {
    if (!hasCamera) {
      this.clearWait();
      this.reportSignal.set(null);
      this.stateSignal.set('no-camera');
      return;
    }
    if (this.stateSignal() !== 'ready') {
      this.stateSignal.set('waiting');
      this.clearWait();
      this.waitTimer = this.options.timers.setTimeout(() => {
        this.waitTimer = null;
        if (this.stateSignal() === 'waiting') {
          this.stateSignal.set('unsupported');
        }
      }, CONTROLS_WAIT_MS);
    }
  }

  set(name: ControlName, value: ControlValue): Promise<void> {
    return this.send({ type: 'set-controls', values: { [name]: value } }, [name]);
  }

  reset(): Promise<void> {
    return this.send({ type: 'set-controls', reset: true }, ['reset']);
  }

  /**
   * Reset of the controls the phone's camera changed by itself (the Timer page's line, T5.2): the
   * automatic mode of each drifted group, and a zoom or a torch back to what was applied.
   */
  resetDrift(): Promise<void> {
    const values = driftReset(this.drift(), this.controls());
    const names = Object.keys(values);
    return names.length === 0
      ? Promise.resolve()
      : this.send({ type: 'set-controls', values }, names);
  }

  /** Nothing: the phone's watchdog does not see this device's sliders, which send on release. */
  adjusting(): void {
    // The change goes when the slider is let go; the phone holds its readings while it applies it.
  }

  /** Lets the connection go: a change in flight ends without an answer. */
  detach(): void {
    for (const off of this.offs) {
      off();
    }
    this.offs = [];
    this.link = null;
    this.clearWait();
    if (this.pending !== null) {
      this.answered('no-answer', "The phone's connection ended before it answered.");
    }
  }

  private send(message: SetControls, set: readonly string[]): Promise<void> {
    const link = this.link;
    if (link === null || !link.open) {
      this.errorSignal.set('The phone is not connected.');
      return Promise.resolve();
    }
    if (this.pending !== null) {
      return Promise.resolve(); // One change at a time: the panel waits for the answer.
    }
    return new Promise<void>((resolve) => {
      const timer = this.options.timers.setTimeout(() => {
        if (this.pending?.timer === timer) {
          this.answered('no-answer', NO_ANSWER_TEXT);
        }
      }, SET_CONTROLS_TIMEOUT_MS);
      this.pending = { set, sentMs: this.options.timers.now(), timer, done: resolve };
      this.busySignal.set(true);
      this.errorSignal.set(null);
      link.send(message);
    });
  }

  private received(message: ControlsReport): void {
    this.clearWait();
    this.reportSignal.set(message);
    this.stateSignal.set('ready');
    this.answered('ok', null);
    this.options.onReport?.(message);
  }

  /** The change in flight ended: `ok` (its `controls` came), `failed` or `no-answer`. */
  private answered(outcome: RemoteControlsOutcome['outcome'], message: string | null): void {
    const pending = this.pending;
    if (outcome !== 'ok') {
      this.errorSignal.set(message);
    }
    if (pending === null) {
      return;
    }
    this.pending = null;
    this.options.timers.clearTimeout(pending.timer);
    this.busySignal.set(false);
    if (outcome === 'ok') {
      this.errorSignal.set(null);
    }
    this.options.onOutcome({
      set: pending.set,
      outcome,
      message,
      ms: Math.round(this.options.timers.now() - pending.sentMs),
    });
    pending.done();
  }

  private clearWait(): void {
    if (this.waitTimer !== null) {
      this.options.timers.clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }
}

/**
 * The values that reset `drift` (T5.2, the Reset beside a phone's line): the automatic mode of each
 * drifted control's group (`continuous`, else `single-shot`), and for the zoom and the torch, which
 * have no mode, the value applied; in the order of the controls.
 */
export function driftReset(
  drift: readonly ControlDrift[],
  controls: CameraControls | null,
): ControlValues {
  const values: Partial<Record<ControlName, ControlValue>> = {};
  for (const { name, expected } of drift) {
    const mode = modeControlOf(name);
    if (mode === null) {
      values[name] = expected;
      continue;
    }
    const auto = controls === null ? null : autoModeOf(modesOf(controls, mode));
    if (auto !== null) {
      values[mode] = auto;
    }
  }
  const ordered: Partial<Record<ControlName, ControlValue>> = {};
  for (const name of CONTROL_NAMES) {
    const value = values[name];
    if (value !== undefined) {
      ordered[name] = value;
    }
  }
  return ordered as ControlValues;
}
