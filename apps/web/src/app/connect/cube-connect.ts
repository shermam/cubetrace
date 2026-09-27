import { Component, inject, input } from '@angular/core';

import { CubeService } from '../cube/cube-service';
import { ConnectActions } from './connect-actions';

/**
 * "Connect a cube" where no cube is connected (docs/PLAN.md, T1.12): on the Timer page and in the
 * live cube panel. One click opens Chrome's device picker (or, in a browser without Web
 * Bluetooth, the dialog that says so); "Try the demo" connects the demo cube. While connecting, the
 * button says so and a Cancel gives up; a failure is written under the buttons, with a Details
 * link to the dialog, and otherwise why the last connection ended (T1.14), such as the idle
 * disconnection. The host shows it only while no cube is connected.
 */
@Component({
  selector: 'app-cube-connect',
  template: `
    <div class="buttons">
      @if (cube.status() === 'connecting') {
        <button type="button" class="primary" disabled [attr.data-testid]="testId()">
          <span class="spinner" aria-hidden="true"></span>Connecting…
        </button>
        <button type="button" data-testid="connect-cancel" (click)="actions.cancel()">
          Cancel
        </button>
      } @else {
        <button
          type="button"
          class="primary"
          [attr.data-testid]="testId()"
          [attr.aria-haspopup]="cube.support.available ? null : 'dialog'"
          (click)="actions.connect()"
        >
          {{ cube.canReconnect() ? 'Reconnect' : 'Connect a cube' }}
        </button>
        <button type="button" data-testid="try-demo" (click)="actions.demo()">Try the demo</button>
      }
    </div>
    @if (cube.status() === 'disconnected') {
      @if (cube.lastError(); as error) {
        <p class="error" role="alert" data-testid="connect-error">
          {{ error }}
          <button
            type="button"
            class="link"
            aria-haspopup="dialog"
            data-testid="connect-details"
            (click)="actions.details()"
          >
            Details
          </button>
        </p>
      } @else if (cube.disconnectReason(); as reason) {
        <p class="reason" data-testid="disconnect-reason">{{ reason }}</p>
      }
    }
  `,
  styles: `
    /* The host places it: start-aligned by default; the Timer page centres it. */
    :host {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
    }

    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }

    .primary {
      display: inline-flex;
      gap: var(--space-2);
      align-items: center;
    }

    .spinner {
      flex: none;
      width: 1em;
      height: 1em;
      border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;

      @media (prefers-reduced-motion: reduce) {
        animation-duration: 4s;
      }
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .error,
    .reason {
      max-width: 36rem;
      margin: 0;
      color: var(--danger);
    }

    .reason {
      color: var(--text-muted);
    }

    .link {
      padding: 0;
      border: 0;
      background: none;
      color: var(--accent);
      text-decoration: underline;
    }
  `,
})
export class CubeConnect {
  protected readonly cube = inject(CubeService);
  protected readonly actions = inject(ConnectActions);

  /** The connect button's `data-testid`. */
  readonly testId = input.required<string>();
}
