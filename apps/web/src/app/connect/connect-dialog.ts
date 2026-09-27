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
import { Router } from '@angular/router';
import { normalizeMac } from '@cubetrace/gan';

import { CubeService } from '../cube/cube-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { errorMessage } from '../shared/error-message';
import { ConnectDialogService } from './connect-dialog-service';

/**
 * The connect dialog (docs/PLAN.md, T1.6a), a native modal `<dialog>`: what this browser can do
 * for a GAN cube and how to enable the rest; Connect cube and Demo cube; the MAC prompt when the
 * driver asks; a spinner while connecting; the connected cube's details and Disconnect; errors
 * in plain words. The state is `CubeService`'s; this component renders it and forwards clicks.
 */
@Component({
  selector: 'app-connect-dialog',
  templateUrl: './connect-dialog.html',
  styleUrl: './connect-dialog.scss',
})
export class ConnectDialog {
  protected readonly cube = inject(CubeService);
  private readonly dialogs = inject(ConnectDialogService);
  private readonly router = inject(Router);
  private readonly navigator = inject(BROWSER_GLOBALS).navigator;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly macInput = viewChild<ElementRef<HTMLInputElement>>('macInput');

  protected readonly support = this.cube.support;
  /** The flag's name, the part of its chrome://flags address after `#`. */
  protected readonly flagName = this.support.flagUrl?.split('#')[1] ?? '';
  protected readonly copyNotice = signal<string | null>(null);
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
    // The driver's MAC prompt opens the dialog if it was closed, with an empty field.
    effect(() => {
      if (this.cube.macPrompt() !== null) {
        untracked(() => {
          this.macText.set('');
          this.macError.set(null);
          this.remember.set(true);
          this.dialogs.open();
        });
      }
    });
    afterRenderEffect(() => {
      this.macInput()?.nativeElement.focus();
    });
  }

  /** The dialog closed: Esc, the close button, or the service. */
  protected onClosed(): void {
    this.dialogs.close();
    this.copyNotice.set(null);
    // Nobody is left to answer the prompt: the connection fails, saying no address was given.
    this.cube.cancelMacPrompt();
  }

  protected close(): void {
    this.dialogs.close();
  }

  protected connectCube(): void {
    void (this.cube.canReconnect() ? this.cube.reconnect() : this.cube.connect());
  }

  /** The demo cube: the solve and speed of the address's `?demo=` and `?speed=`, if any. */
  protected demoCube(): void {
    const query = this.router.routerState.snapshot.root.queryParamMap;
    void this.cube.startDemo({ demo: query.get('demo'), speed: query.get('speed') });
  }

  protected disconnect(): void {
    void this.cube.disconnect();
  }

  protected onMacInput(text: string): void {
    this.macText.set(text);
    this.macError.set(null);
  }

  protected submitMac(event: Event): void {
    event.preventDefault();
    this.macError.set(this.cube.answerMac(this.macText(), this.remember()));
  }

  protected cancelMac(): void {
    this.cube.cancelMacPrompt();
  }

  /** chrome:// addresses cannot be links, so the flag's address is copied for pasting. */
  protected copyFlag(address: string): void {
    const clipboard = this.navigator?.clipboard;
    if (clipboard === undefined) {
      this.copyNotice.set('Copying is not available here: select the address and copy it.');
      return;
    }
    clipboard.writeText(address).then(
      () => {
        this.copyNotice.set('Copied. Paste it in the address bar.');
      },
      (error: unknown) => {
        this.copyNotice.set(
          `Copying failed (${errorMessage(error)}): select the address and copy it.`,
        );
      },
    );
  }
}
