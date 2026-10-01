import { Component, computed, input, signal } from '@angular/core';

import type { AccountUser } from './account-backend';

/** What names an account: its name, else its email address. */
export function accountName(user: AccountUser): string {
  return user.displayName ?? user.email ?? 'Signed in';
}

/**
 * The account's photo, round; its initial where it has none, or where the photo does not load
 * (offline). Its size is the host's, set by the control that shows it.
 */
@Component({
  selector: 'app-account-photo',
  template: `
    @if (photo(); as url) {
      <img [src]="url" alt="" referrerpolicy="no-referrer" (error)="failed.set(true)" />
    } @else {
      <span aria-hidden="true">{{ initial() }}</span>
    }
  `,
  styles: `
    :host {
      display: grid;
      flex: none;
      overflow: hidden;
      border-radius: 50%;
      background: var(--accent);
      color: var(--on-accent);
      font-weight: 700;
      place-items: center;
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
})
export class AccountPhoto {
  // Not `input.required`: its runtime would be the only part of it in the initial bundle.
  readonly user = input<AccountUser | null>(null);
  /** The photo did not load. */
  protected readonly failed = signal(false);
  protected readonly photo = computed(() =>
    this.failed() ? null : (this.user()?.photoURL ?? null),
  );
  protected readonly initial = computed(() => {
    const user = this.user();
    return (user === null ? '' : accountName(user)).trim().charAt(0).toUpperCase() || '?';
  });
}
