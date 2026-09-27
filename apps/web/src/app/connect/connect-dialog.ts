import {
  Component,
  type ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { normalizeMac } from '@cubetrace/gan';

import { CubeService, MARK_AS_SOLVED_HINT } from '../cube/cube-service';
import { ConnectActions } from './connect-actions';
import { ConnectDialogService } from './connect-dialog-service';
import { FlagSteps } from './flag-steps';

/**
 * The connect dialog (docs/PLAN.md, T1.6a and T1.12), a native modal `<dialog>`. Connecting a cube
 * takes no dialog (see `ConnectActions`); this one opens only when it is needed
 * (`ConnectDialogReason`): the MAC prompt when the driver asks, with the flag that makes it
 * unnecessary folded under it; what this browser lacks; the details of a failure; the connected
 * cube's details and Disconnect. Its content follows `CubeService`'s state: while connecting, a
 * spinner; disconnected, the error or the last connection's end, the support hint, the flag's
 * steps, Connect cube and Demo cube. It closes by itself once a cube connects, unless it was opened
 * for the details, and once the MAC prompt that opened it is answered; Cancel on the prompt closes
 * it too. The connected cube's details also offer "Mark as solved" (T1.14).
 */
@Component({
  selector: 'app-connect-dialog',
  imports: [FlagSteps],
  templateUrl: './connect-dialog.html',
  styleUrl: './connect-dialog.scss',
})
export class ConnectDialog {
  protected readonly cube = inject(CubeService);
  protected readonly dialogs = inject(ConnectDialogService);
  private readonly actions = inject(ConnectActions);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly macInput = viewChild<ElementRef<HTMLInputElement>>('macInput');

  protected readonly support = this.cube.support;
  protected readonly markAsSolvedHint = MARK_AS_SOLVED_HINT;
  /** The flag's chrome://flags address, where this browser needs it to read MAC addresses. */
  protected readonly flagUrl = this.support.flagUrl ?? null;
  protected readonly macText = signal('');
  protected readonly macError = signal<string | null>(null);
  protected readonly remember = signal(true);
  /** The address as it will be sent, once the text is one. */
  protected readonly macPreview = computed(() => normalizeMac(this.macText()));
  protected readonly batteryText = computed(() => {
    const level = this.cube.battery();
    return level === null ? '…' : `${String(level)}%`;
  });
  protected readonly gyroText = computed(() => {
    const hardware = this.cube.hardware();
    return hardware === null ? '…' : hardware.gyro ? 'Yes' : 'No';
  });

  constructor() {
    // The native dialog follows the service: showModal() makes it modal, traps the focus and
    // closes it on Esc (see onClosed).
    afterRenderEffect(() => {
      const dialog = this.dialog().nativeElement;
      if (this.dialogs.isOpen()) {
        if (!dialog.open) {
          dialog.showModal();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
    // The driver's MAC prompt opens the dialog if it was closed, with an empty field. An open
    // dialog keeps its reason: one opened for the details stays after the cube connects.
    effect(() => {
      if (this.cube.macPrompt() !== null) {
        untracked(() => {
          this.macText.set('');
          this.macError.set(null);
          this.remember.set(true);
          if (!this.dialogs.isOpen()) {
            this.dialogs.open('prompt');
          }
        });
      }
    });
    // Connected: back to the page, unless the dialog was opened for the cube's details.
    effect(() => {
      const reason = this.dialogs.reason();
      if (reason !== null && reason !== 'details' && this.cube.status() === 'connected') {
        untracked(() => {
          this.dialogs.close();
        });
      }
    });
    afterRenderEffect(() => {
      this.macInput()?.nativeElement.focus();
    });
  }

  /** The dialog closed: Esc, the close button, Cancel on the MAC prompt, or the service. */
  protected onClosed(): void {
    this.dialogs.close();
    // Nobody is left to answer the prompt: the connection fails, saying no address was given.
    this.cube.cancelMacPrompt();
  }

  protected close(): void {
    this.dialogs.close();
  }

  protected connectCube(): void {
    this.actions.connect();
  }

  /** The demo cube, with the address's `?demo=`, `?speed=` and `?misscramble=`, if any. */
  protected demoCube(): void {
    this.actions.demo();
  }

  protected disconnect(): void {
    void this.cube.disconnect();
  }

  protected markAsSolved(): void {
    void this.cube.resetToSolved();
  }

  protected onMacInput(text: string): void {
    this.macText.set(text);
    this.macError.set(null);
  }

  protected submitMac(event: Event): void {
    event.preventDefault();
    const problem = this.cube.answerMac(this.macText(), this.remember());
    this.macError.set(problem);
    // Answered: back to the page, whose connect button and pill follow the connection from here.
    if (problem === null && this.dialogs.reason() === 'prompt') {
      this.dialogs.close();
    }
  }

  /** No address: connecting fails, and the failure is shown where Connect was clicked. */
  protected cancelMac(): void {
    this.cube.cancelMacPrompt();
    this.dialogs.close();
  }
}
