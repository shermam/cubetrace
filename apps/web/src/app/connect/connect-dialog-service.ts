import { Injectable, computed, signal } from '@angular/core';

/**
 * Why the connect dialog is open (docs/PLAN.md, T1.12). Connecting takes one click and no dialog;
 * the dialog opens only for:
 * - `prompt`: the driver asks for the cube's MAC address;
 * - `support`: a connect button was clicked in a browser without Web Bluetooth;
 * - `error`: the "Details" of a failed connection;
 * - `details`: the connected cube's details, from the header pill.
 *
 * Once a cube connects, a dialog opened for any reason but `details` closes by itself.
 */
export type ConnectDialogReason = 'prompt' | 'support' | 'error' | 'details';

/**
 * Whether the connect dialog is open, and why. The dialog lives once in the app shell; the status
 * pill, the connect buttons and the MAC prompt open it through this service. It stays in the
 * initial bundle with the pill's placeholder, so it imports no cube code.
 */
@Injectable({ providedIn: 'root' })
export class ConnectDialogService {
  private readonly reasonSignal = signal<ConnectDialogReason | null>(null);
  private connectRequested = false;

  /** Why the dialog is open; null while it is closed. */
  readonly reason = this.reasonSignal.asReadonly();
  readonly isOpen = computed(() => this.reasonSignal() !== null);

  open(reason: ConnectDialogReason): void {
    this.reasonSignal.set(reason);
  }

  close(): void {
    this.reasonSignal.set(null);
  }

  /**
   * A click on the header pill's placeholder, shown until the pill's code has loaded: the pill
   * acts on it as soon as it is there ({@link takeConnectRequest}), within the click's user
   * activation, which Chrome keeps for a few seconds.
   */
  requestConnect(): void {
    this.connectRequested = true;
  }

  /** Whether the placeholder was clicked since the last call; the request is consumed. */
  takeConnectRequest(): boolean {
    const requested = this.connectRequested;
    this.connectRequested = false;
    return requested;
  }
}
