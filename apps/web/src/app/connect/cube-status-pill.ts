import { Component, computed, inject } from '@angular/core';

import { CubeService } from '../cube/cube-service';
import { ConnectDialogService } from './connect-dialog-service';

/**
 * The header's cube status (docs/PLAN.md, T1.6a): "No cube", "Connecting…" or
 * "<model> · <battery>%", with a coloured dot. A click opens the connect dialog.
 */
@Component({
  selector: 'app-cube-status-pill',
  template: `
    <button
      type="button"
      class="cube-pill"
      aria-haspopup="dialog"
      data-testid="cube-status"
      [attr.data-status]="cube.status()"
      [title]="title()"
      (click)="dialogs.open()"
    >
      <span class="dot" aria-hidden="true"></span><span class="label">{{ label() }}</span>
    </button>
  `,
  // The pill's look is global (.cube-pill in styles.scss), shared with its placeholder.
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
  `,
})
export class CubeStatusPill {
  protected readonly cube = inject(CubeService);
  protected readonly dialogs = inject(ConnectDialogService);

  protected readonly label = computed(() => {
    switch (this.cube.status()) {
      case 'disconnected':
        return 'No cube';
      case 'connecting':
        return 'Connecting…';
      case 'connected': {
        const model = this.cube.hardware()?.model ?? '';
        const battery = this.cube.battery();
        const name = model === '' ? 'Cube' : model;
        return battery === null ? name : `${name} · ${String(battery)}%`;
      }
    }
  });

  protected readonly title = computed(() => {
    switch (this.cube.status()) {
      case 'disconnected':
        return this.cube.lastError() ?? this.cube.disconnectReason() ?? 'Connect a cube';
      case 'connecting':
        return 'Connecting a cube';
      case 'connected':
        return 'Cube connected: details and Disconnect';
    }
  });
}
