import { Component, computed, inject, input } from '@angular/core';

import { AccountPhoto, accountName } from './account-photo';
import { AuthService } from './auth-service';

/** Where the control is: the header (compact, with a menu) or Settings → Account (all of it). */
export type AccountControlPlace = 'header' | 'settings';

/**
 * The account's control (docs/PLAN.md, T3.0): Sign in, or the account signed in (its photo, else its
 * initial, and its name or email) with Sign out. In the header it is a pill, whose label shows from
 * the width where the header fits one row, and whose menu (a popover) holds the account and Sign out;
 * in Settings → Account it shows the account, the button, and what went wrong, if anything.
 */
@Component({
  selector: 'app-account-control',
  imports: [AccountPhoto],
  templateUrl: './account-control.html',
  styleUrl: './account-control.scss',
  host: { '[attr.data-place]': 'place()' },
})
export class AccountControl {
  readonly place = input<AccountControlPlace>('header');

  protected readonly auth = inject(AuthService);
  protected readonly loading = computed(() => this.auth.status() === 'loading');
  protected readonly name = accountName;

  protected signIn(): void {
    void this.auth.signIn();
  }

  protected signOut(): void {
    void this.auth.signOut();
  }
}
