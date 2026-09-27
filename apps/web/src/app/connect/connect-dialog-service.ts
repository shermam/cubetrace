import { Injectable, signal } from '@angular/core';

/**
 * Whether the connect dialog is open. The dialog lives once in the app shell; the status pill,
 * the timer page and the MAC prompt open it through this service.
 */
@Injectable({ providedIn: 'root' })
export class ConnectDialogService {
  private readonly openSignal = signal(false);

  readonly isOpen = this.openSignal.asReadonly();

  open(): void {
    this.openSignal.set(true);
  }

  close(): void {
    this.openSignal.set(false);
  }
}
