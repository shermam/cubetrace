import { Component, computed, inject } from '@angular/core';

import { SettingsService } from '../settings/settings-service';
import { sharpnessBar, sharpnessText } from './camera-format';
import { CameraService } from './camera-service';

/**
 * The sharpness meter (docs/PLAN.md, T2.1): the variance of the Laplacian of the framing rectangle,
 * measured on the preview twice a second by `CameraService`, on a logarithmic bar against the
 * threshold of Settings, with the value and the verdict (good from the threshold up, soft under it).
 * Camera settings show it on the Timer page, and the Camera page of a phone that films for a host
 * (T4.1).
 */
@Component({
  selector: 'app-sharpness-meter',
  template: `
    <div
      class="sharpness"
      data-testid="camera-sharpness"
      [attr.data-samples]="camera.sharpnessSamples()"
      [attr.data-good]="camera.sharpnessGood()"
    >
      <span id="camera-sharpness-label">Sharpness</span>
      <meter
        aria-labelledby="camera-sharpness-label"
        min="0"
        max="1"
        low="0"
        optimum="1"
        [high]="thresholdBar()"
        [value]="bar()"
      ></meter>
      <span class="value" data-testid="camera-sharpness-value">{{ value() }}</span>
      <span
        class="verdict"
        data-testid="camera-sharpness-verdict"
        [class.good]="camera.sharpnessGood()"
        >{{ verdict() }}</span
      >
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .sharpness {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-3);
      align-items: center;
    }

    meter {
      width: 8rem;
    }

    .value {
      min-width: 3ch;
      font-family: var(--font-mono);
    }

    .verdict {
      color: var(--warn);
      font-weight: 600;

      &.good {
        color: var(--ok);
      }
    }
  `,
})
export class SharpnessMeter {
  protected readonly camera = inject(CameraService);
  private readonly prefs = inject(SettingsService);

  protected readonly value = computed(() => {
    const value = this.camera.sharpness();
    return value === null ? '–' : sharpnessText(value);
  });
  protected readonly bar = computed(() =>
    sharpnessBar(this.camera.sharpness() ?? 0, this.prefs.sharpnessThreshold()),
  );
  protected readonly thresholdBar = computed(() =>
    sharpnessBar(this.prefs.sharpnessThreshold(), this.prefs.sharpnessThreshold()),
  );
  protected readonly verdict = computed(() => {
    if (this.camera.sharpness() === null) {
      return '';
    }
    return this.camera.sharpnessGood() ? 'good' : 'soft';
  });
}
