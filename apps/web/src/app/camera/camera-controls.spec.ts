import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  controlValuesOf,
  controlsOf,
  type CameraControls as Controls,
  type ControlDrift,
  type ControlName,
  type ControlValue,
  type ControlValues,
} from '@cubetrace/capture';

import { FAKE_PHONE_REAR } from '../device/fake-browser';
import { toSlider } from './camera-format';
import { CameraControls } from './camera-controls';
import type { ControlsSource } from './controls-source';

/** A source the test drives: its signals set by hand, its calls recorded. */
class FakeSource implements ControlsSource {
  readonly controls = signal<Controls | null>(
    controlsOf(FAKE_PHONE_REAR.capabilities, FAKE_PHONE_REAR.settings),
  );
  readonly values = signal<ControlValues>(controlValuesOf(FAKE_PHONE_REAR.settings));
  readonly applied = signal<ControlValues>({});
  readonly drift = signal<readonly ControlDrift[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly calls: string[] = [];

  set(name: ControlName, value: ControlValue): Promise<void> {
    this.calls.push(`set ${name} ${String(value)}`);
    return Promise.resolve();
  }

  reset(): Promise<void> {
    this.calls.push('reset');
    return Promise.resolve();
  }

  adjusting(active: boolean): void {
    this.calls.push(`adjusting ${String(active)}`);
  }
}

describe('CameraControls over a ControlsSource (T5.2)', () => {
  let source: FakeSource;
  let fixture: ComponentFixture<CameraControls>;

  async function render(): Promise<void> {
    source = new FakeSource();
    fixture = TestBed.createComponent(CameraControls);
    fixture.componentRef.setInput('source', source);
    await update();
  }

  async function update(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function element(testId: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`);
  }

  function all(testId: string): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(`[data-testid="${testId}"]`),
      (node) => node.textContent.trim(),
    );
  }

  it("shows the source's controls and values, and sends what is changed to it", async () => {
    await render();
    const legends = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('legend'),
      (legend) => legend.textContent.trim(),
    );
    expect(legends).toEqual(['Exposure', 'Focus', 'White balance', 'Zoom']);
    const focus = element('control-focusMode') as HTMLSelectElement | null;
    expect(focus?.value).toBe('continuous');

    focus?.dispatchEvent(new Event('change'));
    if (focus !== null) {
      focus.value = 'manual';
      focus.dispatchEvent(new Event('change'));
    }
    element('control-torch')?.click();
    // A slider: held, moved, let go: the watchdog waits meanwhile, the value goes on release.
    const zoom = element('control-zoom') as HTMLInputElement | null;
    zoom?.dispatchEvent(new Event('pointerdown'));
    if (zoom !== null) {
      zoom.value = '500';
    }
    zoom?.dispatchEvent(new Event('input'));
    zoom?.dispatchEvent(new Event('change'));
    zoom?.dispatchEvent(new Event('pointerup'));
    element('camera-reset')?.click();
    await update();
    expect(source.calls).toEqual([
      'set focusMode continuous',
      'set focusMode manual',
      'set torch true',
      'adjusting true',
      'adjusting true',
      'adjusting false',
      'set zoom 4.5',
      'adjusting false',
      'reset',
    ]);

    // The source's values are what the panel shows.
    source.values.set({ ...source.values(), focusMode: 'manual', focusDistance: 0.35 });
    await update();
    expect((element('control-focusMode') as HTMLSelectElement | null)?.value).toBe('manual');
    expect(element('control-focusDistance-value')?.textContent.trim()).toBe('0.35');
  });

  it('shows what was applied, with what the camera reports beside a value it renders otherwise (T5.2a)', async () => {
    await render();
    // The Moto g60: a manual exposure it calls none, a focus distance of 0.12 m that it reads as 8.33.
    source.applied.set({
      exposureMode: 'manual',
      exposureTime: 100,
      focusMode: 'manual',
      focusDistance: 0.12,
      whiteBalanceMode: 'continuous',
    });
    source.values.set({
      ...source.values(),
      exposureMode: 'none',
      exposureTime: 100,
      focusMode: 'manual',
      focusDistance: 1 / 0.12,
    });
    await update();
    expect((element('control-exposureMode') as HTMLSelectElement | null)?.value).toBe('manual');
    expect(element('control-exposureTime-reported')).toBeNull();
    expect(element('control-focusDistance-value')?.textContent.trim()).toBe('0.12');
    expect(all('control-focusDistance-reported')).toEqual(['the camera reports 8.33']);
    // The slider stays at the distance chosen, not at the camera's 8.33 (past the end of its range).
    const range = source.controls()?.focusDistance;
    expect((element('control-focusDistance') as HTMLInputElement | null)?.value).toBe(
      range === null || range === undefined ? '' : String(toSlider(0.12, range, false)),
    );

    // The camera's rounding of it: nothing beside it.
    source.values.set({ ...source.values(), focusDistance: 0.121 });
    await update();
    expect(element('control-focusDistance-reported')).toBeNull();

    // A mode the camera changed in kind (a drift, said in red): the group as the camera has it.
    source.values.set({ ...source.values(), focusMode: 'continuous', focusDistance: 0.6 });
    await update();
    expect((element('control-focusMode') as HTMLSelectElement | null)?.value).toBe('continuous');
    expect(element('control-focusDistance-value')?.textContent.trim()).toBe('0.60');
    expect(element('control-focusDistance-reported')).toBeNull();
  });

  it('disables the controls while a change is in flight, says why one did not take, and what the camera changed by itself', async () => {
    await render();
    source.busy.set(true);
    await update();
    expect((element('control-focusMode') as HTMLSelectElement | null)?.disabled).toBe(true);
    expect((element('camera-reset') as HTMLButtonElement | null)?.disabled).toBe(true);
    source.busy.set(false);
    source.error.set('The phone did not answer.');
    source.drift.set([{ name: 'focusMode', expected: 'continuous', actual: 'manual' }]);
    await update();
    expect((element('control-focusMode') as HTMLSelectElement | null)?.disabled).toBe(false);
    expect(all('camera-controls-error')).toEqual(['The phone did not answer.']);
    expect(all('camera-controls-drift')).toEqual(['The camera set the focus to manual by itself.']);
    // No controls at all: the panel says so, and nothing else.
    source.controls.set(controlsOf({}, {}));
    await update();
    expect(element('camera-no-controls')).not.toBeNull();
    expect(all('camera-controls-drift')).toEqual([]);
  });
});
