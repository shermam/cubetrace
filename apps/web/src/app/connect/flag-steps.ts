import { Component, computed, inject, input, signal } from '@angular/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { errorMessage } from '../shared/error-message';

/**
 * How to turn on the Chrome flag that lets Chrome read a cube's MAC address
 * (`BluetoothSupport.flagUrl`): the flag's address with a Copy button, since chrome:// addresses
 * cannot be links, and the three steps. The connect dialog shows it under the MAC prompt, folded,
 * and with the details of a failure.
 */
@Component({
  selector: 'app-flag-steps',
  template: `
    <p class="flag-url">
      <code data-testid="flag-url">{{ url() }}</code>
      <button type="button" aria-label="Copy the flag address" (click)="copy()">Copy</button>
    </p>
    @if (notice(); as notice) {
      <p class="note" role="status" data-testid="copy-notice">{{ notice }}</p>
    }
    <ol>
      <li>Paste it in Chrome’s address bar and press Enter.</li>
      <li>Set the highlighted flag, {{ name() }}, to Enabled.</li>
      <li>Relaunch Chrome.</li>
    </ol>
  `,
  styles: `
    :host {
      display: block;
    }

    .flag-url {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;

      code {
        min-width: 0;
        overflow-wrap: anywhere;
      }
    }

    .note {
      color: var(--text-muted);
      font-size: 0.875rem;
    }
  `,
})
export class FlagSteps {
  private readonly navigator = inject(BROWSER_GLOBALS).navigator;

  /** The flag's chrome://flags address. */
  readonly url = input.required<string>();
  /** The flag's name, the part of its address after `#`. */
  protected readonly name = computed(() => this.url().split('#')[1] ?? '');
  protected readonly notice = signal<string | null>(null);

  protected copy(): void {
    const clipboard = this.navigator?.clipboard;
    if (clipboard === undefined) {
      this.notice.set('Copying is not available here: select the address and copy it.');
      return;
    }
    clipboard.writeText(this.url()).then(
      () => {
        this.notice.set('Copied. Paste it in the address bar.');
      },
      (error: unknown) => {
        this.notice.set(`Copying failed (${errorMessage(error)}): select the address and copy it.`);
      },
    );
  }
}
