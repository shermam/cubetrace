import { Component, computed, inject } from '@angular/core';

import { CubeService } from '../cube/cube-service';
import { ConnectActions } from './connect-actions';
import { ConnectDialogService } from './connect-dialog-service';

/**
 * The header's cube status (docs/PLAN.md, T1.6a and T1.12), with a coloured dot. Without a cube
 * it is an action, "Connect cube" (or "Reconnect"): a click opens Chrome's device picker at once,
 * and a failure turns the dot red and puts the reason in the title. "Connecting…" gives up on a
 * click. Connected, "<model> · <battery>%" opens the dialog with the cube's details.
 */
@Component({
  selector: 'app-cube-status-pill',
  template: `
    <button
      type="button"
      class="cube-pill"
      data-testid="cube-status"
      [attr.data-status]="cube.status()"
      [attr.data-error]="failed() ? '' : null"
      [attr.aria-haspopup]="opensDialog() ? 'dialog' : null"
      [title]="title()"
      (click)="onClick()"
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
  private readonly actions = inject(ConnectActions);
  private readonly dialogs = inject(ConnectDialogService);

  protected readonly label = computed(() => {
    switch (this.cube.status()) {
      case 'disconnected':
        return this.cube.canReconnect() ? 'Reconnect' : 'Connect cube';
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
        return 'Connecting a cube: click to cancel';
      case 'connected':
        return 'Cube connected: details and Disconnect';
    }
  });

  /** The last attempt to connect failed; the title says why. */
  protected readonly failed = computed(
    () => this.cube.status() === 'disconnected' && this.cube.lastError() !== null,
  );

  protected readonly opensDialog = computed(
    () => this.cube.status() === 'connected' || !this.cube.support.available,
  );

  constructor() {
    // The placeholder was clicked while this component was loading: act on that click now.
    if (this.dialogs.takeConnectRequest() && this.cube.status() === 'disconnected') {
      this.actions.connect();
    }
  }

  protected onClick(): void {
    switch (this.cube.status()) {
      case 'disconnected':
        this.actions.connect();
        break;
      case 'connecting':
        this.actions.cancel();
        break;
      case 'connected':
        this.dialogs.open('details');
        break;
    }
  }
}
