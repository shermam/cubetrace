import { Component, computed, input, signal } from '@angular/core';
import {
  hasControls,
  type CameraControls as Controls,
  type ControlDrift,
  type ControlName,
  type ControlRange,
  type ControlValues,
  type MeteringMode,
} from '@cubetrace/capture';

import {
  exposureText,
  focusText,
  fromSlider,
  isoText,
  logarithmic,
  modeLabel,
  temperatureText,
  toSlider,
  zoomText,
} from './camera-format';
import { driftSentence, type ControlsSource } from './controls-source';

/** A control's slider, as shown. */
interface SliderView {
  readonly name: ControlName;
  readonly label: string;
  readonly range: ControlRange;
  readonly log: boolean;
  readonly position: number;
  readonly text: string;
}

/** Exposure, focus or white balance: a mode and the values it holds in manual. */
interface GroupView {
  readonly title: string;
  readonly mode: {
    readonly name: ControlName;
    readonly modes: readonly MeteringMode[];
    readonly current: MeteringMode | null;
  } | null;
  readonly sliders: readonly SliderView[];
}

const FORMATS: Partial<Record<ControlName, (value: number) => string>> = {
  exposureTime: exposureText,
  iso: isoText,
  focusDistance: focusText,
  colorTemperature: temperatureText,
  zoom: zoomText,
};

/**
 * A camera's manual controls, each shown only when the camera has it (docs/PLAN.md, T2.1):
 * exposure (Auto or Manual, with the exposure time and the ISO), focus (with the distance), white
 * balance (with the colour temperature), zoom, the torch, and "Reset to auto". In automatic mode a
 * slider shows what the camera chose (the exposure time tells whether fast turns will blur), and
 * moving it switches its group to manual. A slider applies its value when it is let go. Since T5.2 a
 * view over a `ControlsSource` (`source`): this device's open camera (`CameraService.controlsSource`,
 * Camera settings and the phone's own Camera page), or a phone's over the connection (the Cameras
 * section's `RemoteControlsSource`); a change in flight disables the controls (for a phone, until its
 * answer, 3 s at most), a control the camera changed by itself is said in red, and why a change did
 * not take. A slider held or moved tells the source (`adjusting`), whose watchdog then waits.
 */
@Component({
  selector: 'app-camera-controls',
  template: `
    @if (none()) {
      <p class="muted" data-testid="camera-no-controls">
        This camera has no manual controls: exposure, focus and white balance are automatic. Light
        (a lamp on the cube) is what makes its frames sharp.
      </p>
    } @else {
      @for (drift of source().drift(); track drift.name) {
        <p class="drift" role="status" data-testid="camera-controls-drift">
          {{ sentence(drift) }}
        </p>
      }
      @if (source().error(); as error) {
        <p class="error" role="alert" data-testid="camera-controls-error">{{ error }}</p>
      }
      @for (group of groups(); track group.title) {
        <fieldset [attr.data-testid]="'camera-group-' + group.title">
          <legend>{{ group.title }}</legend>
          @if (group.mode; as mode) {
            <label class="row">
              <span class="name">Mode</span>
              <select
                #modeSelect
                [attr.data-testid]="'control-' + mode.name"
                [disabled]="source().busy()"
                (change)="setMode(mode.name, modeSelect.value)"
              >
                @for (option of mode.modes; track option) {
                  <option [value]="option" [selected]="option === mode.current">
                    {{ label(option) }}
                  </option>
                }
              </select>
            </label>
          }
          @for (slider of group.sliders; track slider.name) {
            <label class="row">
              <span class="name">{{ slider.label }}</span>
              <input
                #range
                type="range"
                min="0"
                max="1000"
                step="1"
                [attr.data-testid]="'control-' + slider.name"
                [value]="slider.position"
                [disabled]="source().busy()"
                (pointerdown)="hold(true)"
                (pointerup)="hold(false)"
                (pointercancel)="hold(false)"
                (input)="preview(slider, range.value)"
                (change)="apply(slider, range.value)"
              />
              <output [attr.data-testid]="'control-' + slider.name + '-value'">{{
                shown(slider)
              }}</output>
            </label>
          }
        </fieldset>
      }
      @if (torch() !== null) {
        <label class="switch">
          <input
            #torchBox
            type="checkbox"
            data-testid="control-torch"
            [checked]="torch()"
            [disabled]="source().busy()"
            (change)="setTorch(torchBox.checked)"
          />
          Torch
        </label>
      }
      <div class="reset">
        <button
          type="button"
          data-testid="camera-reset"
          [disabled]="source().busy()"
          (click)="reset()"
        >
          Reset to auto
        </button>
        <p class="muted">Reopens the camera with every control automatic, and forgets them.</p>
      </div>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-3);
    }

    fieldset {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: var(--space-2) var(--space-3) var(--space-3);
      border: 1px solid var(--line);
      border-radius: var(--radius);
    }

    legend {
      padding: 0 var(--space-1);
      font-weight: 600;
    }

    .row {
      display: grid;
      grid-template-columns: 6.5rem minmax(0, 1fr);
      gap: var(--space-1) var(--space-3);
      align-items: center;
    }

    output {
      grid-column: 2;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 0.8125rem;
    }

    .switch {
      display: inline-flex;
      gap: var(--space-2);
      align-items: center;
    }

    .muted,
    .reset p {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.875rem;
    }

    .drift,
    .error {
      margin: 0;
      color: var(--danger);
      font-size: 0.875rem;
    }

    .reset {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;

      p {
        flex: 1 1 14rem;
        font-size: 0.75rem;
      }
    }
  `,
})
export class CameraControls {
  /** The camera whose controls these are: this device's, or a phone's (T5.2). */
  readonly source = input.required<ControlsSource>();
  /** Values shown while a slider is moved, before it is let go. */
  private readonly moving = signal<Partial<Record<ControlName, number>>>({});

  protected readonly none = computed(() => {
    const controls = this.source().controls();
    return controls === null || !hasControls(controls);
  });
  protected readonly groups = computed(() =>
    controlGroups(this.source().controls(), this.source().values()),
  );
  /** Whether the torch is on; null when the camera has none. */
  protected readonly torch = computed(() =>
    this.source().controls()?.torch === true ? this.source().values().torch === true : null,
  );

  protected label(mode: MeteringMode): string {
    return modeLabel(mode);
  }

  protected sentence(drift: ControlDrift): string {
    return driftSentence(drift);
  }

  protected shown(slider: SliderView): string {
    const moving = this.moving()[slider.name];
    return moving === undefined ? slider.text : (FORMATS[slider.name] ?? String)(moving);
  }

  protected setTorch(on: boolean): void {
    void this.source().set('torch', on);
  }

  protected setMode(name: ControlName, mode: string): void {
    void this.source().set(name, mode as MeteringMode);
  }

  protected reset(): void {
    void this.source().reset();
  }

  /** A slider held (true) or let go (false): the source's watchdog waits meanwhile (T5.2). */
  protected hold(active: boolean): void {
    this.source().adjusting(active);
  }

  protected preview(slider: SliderView, position: string): void {
    this.source().adjusting(true);
    const value = fromSlider(Number(position), slider.range, slider.log);
    this.moving.update((moving) => ({ ...moving, [slider.name]: value }));
  }

  protected apply(slider: SliderView, position: string): void {
    const source = this.source();
    source.adjusting(false);
    const value = fromSlider(Number(position), slider.range, slider.log);
    void source.set(slider.name, value).finally(() => {
      this.moving.update((moving) => ({ ...moving, [slider.name]: undefined }));
    });
  }
}

/** The groups of controls the camera has, with their current values. */
export function controlGroups(controls: Controls | null, values: ControlValues): GroupView[] {
  if (controls === null) {
    return [];
  }
  const groups: GroupView[] = [];
  const add = (
    title: string,
    modeName: ControlName,
    modes: readonly MeteringMode[],
    sliders: readonly (readonly [ControlName, string, ControlRange | null])[],
  ): void => {
    const current = (values[modeName] as MeteringMode | undefined) ?? null;
    const views = sliders.flatMap(([name, label, range]) =>
      range === null ? [] : [slider(name, label, range, values[name])],
    );
    if (modes.length > 0 || views.length > 0) {
      groups.push({
        title,
        mode:
          modes.length > 0 ? { name: modeName, modes: withCurrent(modes, current), current } : null,
        sliders: views,
      });
    }
  };
  add('Exposure', 'exposureMode', controls.exposureModes, [
    ['exposureTime', 'Time', controls.exposureTime],
    ['iso', 'ISO', controls.iso],
  ]);
  add('Focus', 'focusMode', controls.focusModes, [
    ['focusDistance', 'Distance', controls.focusDistance],
  ]);
  add('White balance', 'whiteBalanceMode', controls.whiteBalanceModes, [
    ['colorTemperature', 'Temperature', controls.colorTemperature],
  ]);
  if (controls.zoom !== null) {
    groups.push({
      title: 'Zoom',
      mode: null,
      sliders: [slider('zoom', 'Zoom', controls.zoom, values.zoom)],
    });
  }
  return groups;
}

function slider(name: ControlName, label: string, range: ControlRange, value: unknown): SliderView {
  const current = typeof value === 'number' ? value : range.min;
  const log = logarithmic(range, name);
  return {
    name,
    label,
    range,
    log,
    position: toSlider(current, range, log),
    text: (FORMATS[name] ?? String)(current),
  };
}

/** `modes`, plus the current one when the camera reports a mode it does not list. */
function withCurrent(
  modes: readonly MeteringMode[],
  current: MeteringMode | null,
): readonly MeteringMode[] {
  return current === null || modes.includes(current) ? modes : [...modes, current];
}
