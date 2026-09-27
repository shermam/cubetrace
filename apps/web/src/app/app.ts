import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { APP_BUILD } from '../environments/version';
import { BrowserSupportService } from './device/browser-support-service';
import { WAKE_LOCK_TEXT, WakeLockService } from './device/wake-lock-service';

/**
 * The shell: the header (brand, navigation, wake lock status), a banner when the browser
 * lacks APIs the app needs, the routed page, and the footer with this build's version.
 */
@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly wakeLock = inject(WakeLockService);

  protected readonly links = [
    { path: '/', label: 'Timer', exact: true },
    { path: '/sessions', label: 'Sessions', exact: false },
    { path: '/settings', label: 'Settings', exact: false },
    { path: '/probe', label: 'Probe', exact: false },
  ] as const;
  protected readonly build = APP_BUILD;
  protected readonly wakeLockStatus = this.wakeLock.status;
  protected readonly wakeLockText = computed(() => WAKE_LOCK_TEXT[this.wakeLock.status()]);
  protected readonly missingApis = listOf(
    inject(BrowserSupportService).missing.map((api) => `${api.name} (${api.usedFor})`),
  );
  protected readonly bannerDismissed = signal(false);
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}
