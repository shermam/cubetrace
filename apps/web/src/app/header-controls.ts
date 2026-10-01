import { Component, computed, inject } from '@angular/core';

import { AccountControl } from './auth/account-control';
import { AuthService } from './auth/auth-service';
import { CubeStatusPill } from './connect/cube-status-pill';
import { UploadIndicator } from './upload/upload-indicator';

/**
 * The header's controls that load right after the first render (app.html's `@defer` block): the
 * cube's status pill and the account's control. One component, so that the shell's deferred block
 * imports one chunk and the initial bundle stays as it was. With an account signed in, the uploads'
 * indicator comes between them (T3.3), from a deferred block of its own: it starts the upload queue,
 * and a device signed out never loads it.
 */
@Component({
  selector: 'app-header-controls',
  imports: [AccountControl, CubeStatusPill, UploadIndicator],
  template: `
    <app-cube-status-pill />
    @if (signedIn()) {
      @defer (on immediate) {
        <app-upload-indicator />
      }
    }
    <app-account-control />
  `,
  // The two are items of the header's status row, as if they were the shell's own.
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class HeaderControls {
  private readonly auth = inject(AuthService);

  protected readonly signedIn = computed(() => this.auth.cloud() !== null);
}
