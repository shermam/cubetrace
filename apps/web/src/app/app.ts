import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/** The shell: the top navigation and the routed page. */
@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly links = [
    { path: '/', label: 'Timer', exact: true },
    { path: '/sessions', label: 'Sessions', exact: false },
    { path: '/settings', label: 'Settings', exact: false },
    { path: '/probe', label: 'Probe', exact: false },
  ] as const;
}
