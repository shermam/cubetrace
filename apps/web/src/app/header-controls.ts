import { Component } from '@angular/core';

import { AccountControl } from './auth/account-control';
import { CubeStatusPill } from './connect/cube-status-pill';

/**
 * The header's controls that load right after the first render (app.html's `@defer` block): the
 * cube's status pill and the account's control. One component, so that the shell's deferred block
 * imports one chunk and the initial bundle stays as it was.
 */
@Component({
  selector: 'app-header-controls',
  imports: [AccountControl, CubeStatusPill],
  template: `
    <app-cube-status-pill />
    <app-account-control />
  `,
  // The two are items of the header's status row, as if they were the shell's own.
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class HeaderControls {}
